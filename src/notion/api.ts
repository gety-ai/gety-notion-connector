import {
	type BlockNode,
	isRecord,
	type NotionBlock,
	type NotionPage,
} from './types.ts';

const DEFAULT_BASE_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';
const PAGE_SIZE = 100;
const MAX_RETRIES = 5;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;
/** Notion allows ~3 requests/second on average; stay just under it. */
const DEFAULT_REQUEST_INTERVAL_MS = 350;
/** Safety bound for pathological block nesting. */
const MAX_BLOCK_DEPTH = 32;

export type FetchLike = (
	input: string,
	init: RequestInit,
) => Promise<Response>;

export interface NotionClientOptions {
	baseUrl?: string;
	fetchFn?: FetchLike;
	/** Minimum delay between requests; 0 disables proactive throttling. */
	requestIntervalMs?: number;
}

export class NotionApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(`Notion API error ${status} (${code}): ${message}`);
		this.name = 'NotionApiError';
		this.status = status;
		this.code = code;
	}
}

/** True when the API reports the object is gone or inaccessible. */
export function isObjectNotFound(error: unknown): boolean {
	return error instanceof NotionApiError && error.status === 404;
}

export class NotionClient {
	#token: string;
	#signal: AbortSignal;
	#baseUrl: string;
	#fetchFn: FetchLike;
	#requestIntervalMs: number;
	#nextRequestAt = 0;

	constructor(
		token: string,
		signal: AbortSignal,
		options: NotionClientOptions = {},
	) {
		this.#token = token;
		this.#signal = signal;
		this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		this.#fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
		this.#requestIntervalMs = Math.max(
			0,
			options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS,
		);
	}

	/** Yields every page shared with the integration, one search batch at a time. */
	async *searchPages(): AsyncGenerator<NotionPage[], void, unknown> {
		let cursor: string | undefined;
		while (true) {
			const body: Record<string, unknown> = {
				filter: { property: 'object', value: 'page' },
				// Ascending: timestamps never decrease, so a page edited while
				// we paginate can only move toward the end of the cursor stream
				// and is still enumerated (descending could skip it, and a
				// skipped page would be wrongly diff-deleted).
				sort: { direction: 'ascending', timestamp: 'last_edited_time' },
				page_size: PAGE_SIZE,
			};
			if (cursor != null) {
				body.start_cursor = cursor;
			}
			const response = await this.#request('POST', '/search', body);
			const results = Array.isArray(response.results) ? response.results : [];
			yield results.filter((item): item is NotionPage =>
				isRecord(item) && item.object === 'page' && typeof item.id === 'string'
			);
			if (response.has_more !== true) {
				return;
			}
			cursor = requireCursor(response.next_cursor, 'search');
		}
	}

	/** Fetches the full block tree of a page (without descending into child pages). */
	async fetchBlockTree(pageId: string): Promise<BlockNode[]> {
		return await this.#fetchDescendants(pageId, new Set([pageId]), 0);
	}

	async #fetchDescendants(
		parentId: string,
		visited: Set<string>,
		depth: number,
	): Promise<BlockNode[]> {
		if (depth >= MAX_BLOCK_DEPTH) {
			return [];
		}
		const nodes: BlockNode[] = [];
		for (const block of await this.#fetchAllChildren(parentId)) {
			const node: BlockNode = { block, children: [] };
			const childSource = childFetchId(block);
			if (childSource != null && !visited.has(childSource)) {
				visited.add(childSource);
				node.children = await this.#fetchDescendants(
					childSource,
					visited,
					depth + 1,
				);
			}
			nodes.push(node);
		}
		return nodes;
	}

	async #fetchAllChildren(blockId: string): Promise<NotionBlock[]> {
		const blocks: NotionBlock[] = [];
		let cursor: string | undefined;
		while (true) {
			const query = new URLSearchParams({ page_size: String(PAGE_SIZE) });
			if (cursor != null) {
				query.set('start_cursor', cursor);
			}
			const response = await this.#request(
				'GET',
				`/blocks/${encodeURIComponent(blockId)}/children?${query}`,
			);
			const results = Array.isArray(response.results) ? response.results : [];
			for (const item of results) {
				if (
					isRecord(item) && typeof item.id === 'string' &&
					typeof item.type === 'string'
				) {
					blocks.push(item as unknown as NotionBlock);
				}
			}
			if (response.has_more !== true) {
				return blocks;
			}
			cursor = requireCursor(response.next_cursor, 'block children');
		}
	}

	async #request(
		method: string,
		path: string,
		body?: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		for (let attempt = 0;; attempt += 1) {
			this.#signal.throwIfAborted();
			await this.#waitForRequestSlot();
			const response = await this.#fetchFn(`${this.#baseUrl}${path}`, {
				method,
				headers: {
					'Authorization': `Bearer ${this.#token}`,
					'Notion-Version': NOTION_VERSION,
					'Content-Type': 'application/json',
				},
				body: body == null ? undefined : JSON.stringify(body),
				signal: this.#signal,
			});
			this.#nextRequestAt = Date.now() + this.#requestIntervalMs;
			if (isRetryable(response.status) && attempt < MAX_RETRIES) {
				await response.body?.cancel();
				await sleep(retryDelayMs(response, attempt), this.#signal);
				continue;
			}
			const payload = await response.json().catch(() => null) as unknown;
			const record = isRecord(payload) ? payload : {};
			if (!response.ok) {
				const code = typeof record.code === 'string' ? record.code : 'unknown';
				const message = typeof record.message === 'string'
					? record.message
					: response.statusText;
				throw new NotionApiError(response.status, code, message);
			}
			return record;
		}
	}

	async #waitForRequestSlot(): Promise<void> {
		const waitMs = this.#nextRequestAt - Date.now();
		if (waitMs > 0) {
			await sleep(waitMs, this.#signal);
		}
	}
}

/**
 * A missing cursor alongside `has_more` would silently truncate the
 * enumeration — and a truncated enumeration would diff-delete every
 * not-yet-listed document. Failing the poll is strictly safer.
 */
function requireCursor(cursor: unknown, context: string): string {
	if (typeof cursor !== 'string' || cursor.length === 0) {
		throw new Error(
			`Notion ${context} response set has_more without a next_cursor.`,
		);
	}
	return cursor;
}

function isRetryable(status: number): boolean {
	return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(response: Response, attempt: number): number {
	const header = response.headers.get('retry-after');
	if (header != null) {
		const retryAfter = Number(header);
		if (Number.isFinite(retryAfter) && retryAfter >= 0) {
			return Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
		}
	}
	return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * Which block id, if any, should be fetched to obtain this block's children.
 * Child pages/databases are separate documents and are never descended into;
 * duplicated synced blocks read their children from the original block.
 */
function childFetchId(block: NotionBlock): string | null {
	if (
		block.type === 'child_page' || block.type === 'child_database' ||
		block.type === 'unsupported'
	) {
		return null;
	}
	if (block.type === 'synced_block') {
		const payload = block.synced_block;
		if (isRecord(payload) && isRecord(payload.synced_from)) {
			const original = payload.synced_from.block_id;
			if (typeof original === 'string') {
				return original;
			}
		}
	}
	return block.has_children === true ? block.id : null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error('Poll aborted'));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
