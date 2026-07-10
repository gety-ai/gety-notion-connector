import {
	Connector,
	del,
	type DocUpdate,
	type PollResult,
	upsert,
	type WireDoc,
} from '@gety-ai/connector-sdk';
import type { ManifestConfig } from './gen/manifest.d.ts';
import { isObjectNotFound, NotionClient } from './notion/api.ts';
import { blocksToMarkdown } from './notion/markdown.ts';
import { propertiesToMarkdown } from './notion/properties.ts';
import { isRecord, notionObjectUrl, type NotionPage } from './notion/types.ts';

/** Persisted incremental state: page id → last seen `last_edited_time`. */
export type NotionState = {
	version?: number;
	pages?: Record<string, string>;
};

/** Bump when the state layout changes; old state then triggers a full resync. */
export const STATE_VERSION = 1;

const DOC_TYPE = 'notion:page';
/** Stay under Gety's ~10 MB per-document content limit. */
const MAX_CONTENT_BYTES = 8_000_000;
const TRUNCATION_NOTICE = '\n\n…(content truncated)';

/** Extracts the page title from whichever property has type `title`. */
export function pageTitle(page: NotionPage): string {
	if (isRecord(page.properties)) {
		for (const property of Object.values(page.properties)) {
			if (!isRecord(property) || property.type !== 'title') {
				continue;
			}
			const items = property.title;
			if (!Array.isArray(items)) {
				continue;
			}
			const title = items
				.map((item) =>
					isRecord(item) && typeof item.plain_text === 'string'
						? item.plain_text
						: ''
				)
				.join('')
				.trim();
			if (title.length > 0) {
				return title;
			}
		}
	}
	return 'Untitled';
}

export function buildPageDoc(page: NotionPage, markdown: string): WireDoc {
	const { content, bytes } = clampContent(withProperties(page, markdown));
	const metadata: Record<string, string> = {
		url: typeof page.url === 'string' && page.url.length > 0
			? page.url
			: notionObjectUrl(page.id),
	};
	if (typeof page.created_time === 'string') {
		metadata.created_at = page.created_time;
	}

	const doc: WireDoc = {
		id: page.id,
		title: pageTitle(page),
		content,
		content_format: 'markdown',
		doc_type: DOC_TYPE,
		original_file_size: bytes,
		metadata,
	};
	if (typeof page.last_edited_time === 'string') {
		doc.doc_updated_at = page.last_edited_time;
	}
	const parentId = parentPageId(page);
	if (parentId != null) {
		doc.parent_id = parentId;
	}
	return doc;
}

/** Database-page properties carry key facts; prepend them to the body. */
function withProperties(page: NotionPage, markdown: string): string {
	const properties = isRecord(page.properties)
		? propertiesToMarkdown(page.properties)
		: '';
	if (properties.length === 0) {
		return markdown;
	}
	const section = `## Properties\n\n${properties}`;
	return markdown.length > 0 ? `${section}\n\n${markdown}` : `${section}\n`;
}

/** The parent page id, when the parent is itself a page (not a database). */
function parentPageId(page: NotionPage): string | null {
	const parent = page.parent;
	if (
		isRecord(parent) && parent.type === 'page_id' &&
		typeof parent.page_id === 'string'
	) {
		return parent.page_id;
	}
	return null;
}

/** True when the source marks the page archived or trashed (any API version). */
export function isGonePage(page: NotionPage): boolean {
	return page.archived === true || page.is_archived === true ||
		page.in_trash === true;
}

/** Extracts the known-pages map, discarding stale or malformed state. */
export function knownPagesFromState(
	state: NotionState | null | undefined,
): Record<string, string> {
	if (state?.version !== STATE_VERSION || !isRecord(state.pages)) {
		return {};
	}
	const pages: Record<string, string> = {};
	for (const [id, lastEdited] of Object.entries(state.pages)) {
		if (typeof lastEdited === 'string') {
			pages[id] = lastEdited;
		}
	}
	return pages;
}

/** Known page ids that a full enumeration no longer returned. */
export function collectDeletes(
	known: Record<string, string>,
	seen: ReadonlySet<string>,
): string[] {
	return Object.keys(known).filter((id) => !seen.has(id));
}

function clampContent(text: string): { content: string; bytes: number } {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(text).length;
	if (bytes <= MAX_CONTENT_BYTES) {
		return { content: text, bytes };
	}

	const budget = MAX_CONTENT_BYTES - encoder.encode(TRUNCATION_NOTICE).length;
	let end = Math.min(text.length, budget);
	let sliced = text.slice(0, end);
	while (end > 0 && encoder.encode(sliced).length > budget) {
		end = Math.floor(end * 0.9);
		sliced = text.slice(0, end);
	}
	// Do not end on a dangling surrogate half.
	if (/[\uD800-\uDBFF]$/.test(sliced)) {
		sliced = sliced.slice(0, -1);
	}
	const content = sliced + TRUNCATION_NOTICE;
	return { content, bytes: encoder.encode(content).length };
}

export default class NotionConnector extends Connector<
	ManifestConfig,
	NotionState
> {
	/** Split out so tests can inject a client with a stubbed fetch. */
	protected createClient(token: string): NotionClient {
		return new NotionClient(token, this.signal);
	}

	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		const token = (this.config.personal_access_token ?? '').trim();
		if (token.length === 0) {
			throw new Error(
				'Notion Personal Access Token is required. Create an internal ' +
					'integration at https://www.notion.so/my-integrations and set ' +
					'its secret in the connector settings.',
			);
		}

		const client = this.createClient(token);
		const known = knownPagesFromState(this.lastState);
		const merged: Record<string, string> = { ...known };
		const seen = new Set<string>();

		for await (const pages of client.searchPages()) {
			const updates: DocUpdate[] = [];
			for (const page of pages) {
				if (isGonePage(page)) {
					continue;
				}
				seen.add(page.id);
				const lastEdited = typeof page.last_edited_time === 'string'
					? page.last_edited_time
					: '';
				if (lastEdited.length > 0 && known[page.id] === lastEdited) {
					continue;
				}

				let markdown: string;
				try {
					markdown = blocksToMarkdown(await client.fetchBlockTree(page.id));
				} catch (error) {
					if (isObjectNotFound(error)) {
						// Deleted or unshared between search and fetch; the delete
						// diff below (or the next poll) will clean it up.
						seen.delete(page.id);
						continue;
					}
					throw error;
				}
				updates.push(upsert(buildPageDoc(page, markdown)));
				merged[page.id] = lastEdited;
			}
			// Checkpoint after each search batch so a failed poll can resume
			// without refetching already-processed pages.
			yield {
				updates,
				state: { version: STATE_VERSION, pages: { ...merged } },
			};
		}

		// Full enumeration finished: anything previously known but unseen is gone.
		const deletedIds = collectDeletes(known, seen);
		const pages: Record<string, string> = {};
		for (const id of seen) {
			const lastEdited = merged[id];
			if (lastEdited != null) {
				pages[id] = lastEdited;
			}
		}
		yield {
			updates: deletedIds.map((id) => del(id)),
			state: { version: STATE_VERSION, pages },
		};
	}
}
