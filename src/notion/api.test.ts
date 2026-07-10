import assert from 'node:assert/strict';
import { NotionApiError, NotionClient } from './api.ts';
import type { NotionPage } from './types.ts';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init,
	});
}

function makeClient(
	fetchFn: (url: string, init: RequestInit) => Response | Promise<Response>,
): NotionClient {
	return new NotionClient('test-token', new AbortController().signal, {
		baseUrl: 'https://notion.test/v1',
		fetchFn: (url, init) => Promise.resolve(fetchFn(url, init)),
		requestIntervalMs: 0,
	});
}

async function collect<T>(iterator: AsyncGenerator<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iterator) {
		items.push(item);
	}
	return items;
}

Deno.test('searchPages paginates and keeps only page objects', async () => {
	const bodies: Record<string, unknown>[] = [];
	const client = makeClient((_url, init) => {
		const body = JSON.parse(String(init.body)) as Record<string, unknown>;
		bodies.push(body);
		if (body.start_cursor == null) {
			return jsonResponse({
				results: [{ object: 'page', id: 'p1' }],
				has_more: true,
				next_cursor: 'cursor-2',
			});
		}
		return jsonResponse({
			results: [
				{ object: 'page', id: 'p2' },
				{ object: 'database', id: 'd1' },
			],
			has_more: false,
			next_cursor: null,
		});
	});

	const batches = await collect(client.searchPages());

	assert.equal(batches.length, 2);
	assert.deepEqual(batches[0].map((page: NotionPage) => page.id), ['p1']);
	assert.deepEqual(batches[1].map((page: NotionPage) => page.id), ['p2']);
	assert.equal(bodies[1].start_cursor, 'cursor-2');
	// Ascending keeps mid-poll edits enumerable; descending could skip
	// pages and cause false diff-deletes.
	assert.deepEqual(bodies[0].sort, {
		direction: 'ascending',
		timestamp: 'last_edited_time',
	});
});

Deno.test('request retries 429 responses honoring retry-after', async () => {
	let attempts = 0;
	const client = makeClient(() => {
		attempts += 1;
		if (attempts === 1) {
			return new Response('slow down', {
				status: 429,
				headers: { 'retry-after': '0' },
			});
		}
		return jsonResponse({ results: [], has_more: false });
	});

	const batches = await collect(client.searchPages());

	assert.equal(attempts, 2);
	assert.deepEqual(batches, [[]]);
});

Deno.test('non-ok responses throw NotionApiError with details', async () => {
	const client = makeClient(() =>
		jsonResponse(
			{
				object: 'error',
				code: 'unauthorized',
				message: 'API token is invalid.',
			},
			{ status: 401 },
		)
	);

	await assert.rejects(
		() => client.searchPages().next(),
		(error: unknown) => {
			assert.ok(error instanceof NotionApiError);
			assert.equal(error.status, 401);
			assert.equal(error.code, 'unauthorized');
			assert.match(error.message, /API token is invalid/);
			return true;
		},
	);
});

Deno.test('fetchBlockTree recurses children, skips child pages, resolves synced blocks', async () => {
	const calls: string[] = [];
	const childrenByParent: Record<string, unknown[]> = {
		'page-1': [
			{ id: 'b1', type: 'toggle', has_children: true, toggle: {} },
			{
				id: 'b2',
				type: 'child_page',
				has_children: true,
				child_page: { title: 'Sub' },
			},
			{
				id: 'b3',
				type: 'synced_block',
				has_children: false,
				synced_block: { synced_from: { block_id: 'orig-1' } },
			},
		],
		'b1': [{ id: 'b4', type: 'paragraph', has_children: false, paragraph: {} }],
		'orig-1': [
			{ id: 'b5', type: 'paragraph', has_children: false, paragraph: {} },
		],
	};
	const client = makeClient((url) => {
		calls.push(url);
		const id = url.match(/blocks\/([^/?]+)\/children/)?.[1] ?? '';
		return jsonResponse({
			results: childrenByParent[id] ?? [],
			has_more: false,
		});
	});

	const tree = await client.fetchBlockTree('page-1');

	assert.deepEqual(tree.map((node) => node.block.id), ['b1', 'b2', 'b3']);
	assert.deepEqual(tree[0].children.map((node) => node.block.id), ['b4']);
	assert.equal(tree[1].children.length, 0);
	assert.deepEqual(tree[2].children.map((node) => node.block.id), ['b5']);
	assert.ok(!calls.some((url) => url.includes('/blocks/b2/')));
});

Deno.test('block children pagination follows next_cursor', async () => {
	const client = makeClient((url) => {
		const second = url.includes('start_cursor=cursor-2');
		return jsonResponse({
			results: [
				{ id: second ? 'b2' : 'b1', type: 'paragraph', paragraph: {} },
			],
			has_more: !second,
			next_cursor: second ? null : 'cursor-2',
		});
	});

	const tree = await client.fetchBlockTree('page-1');

	assert.deepEqual(tree.map((node) => node.block.id), ['b1', 'b2']);
});

Deno.test('requests carry auth and version headers', async () => {
	let headers: Headers | null = null;
	const client = makeClient((_url, init) => {
		headers = new Headers(init.headers);
		return jsonResponse({ results: [], has_more: false });
	});

	await collect(client.searchPages());

	assert.ok(headers != null);
	assert.equal(
		(headers as Headers).get('authorization'),
		'Bearer test-token',
	);
	assert.equal((headers as Headers).get('notion-version'), '2026-03-11');
});

Deno.test('has_more without next_cursor fails instead of truncating', async () => {
	const client = makeClient(() =>
		jsonResponse({
			results: [{ object: 'page', id: 'p1' }],
			has_more: true,
			next_cursor: null,
		})
	);

	await assert.rejects(
		() => collect(client.searchPages()),
		/has_more without a next_cursor/,
	);
});

Deno.test('requests are spaced by the configured interval', async () => {
	const timestamps: number[] = [];
	const client = new NotionClient('test-token', new AbortController().signal, {
		baseUrl: 'https://notion.test/v1',
		requestIntervalMs: 30,
		fetchFn: (_url, _init) => {
			timestamps.push(Date.now());
			return Promise.resolve(jsonResponse({
				results: [],
				has_more: timestamps.length < 3,
				next_cursor: timestamps.length < 3 ? `c${timestamps.length}` : null,
			}));
		},
	});

	await collect(client.searchPages());

	assert.equal(timestamps.length, 3);
	assert.ok(timestamps[1] - timestamps[0] >= 25);
	assert.ok(timestamps[2] - timestamps[1] >= 25);
});
