import assert from 'node:assert/strict';
import type { PollResult } from '@gety-ai/connector-sdk';
import NotionConnector, {
	buildPageDoc,
	collectDeletes,
	knownPagesFromState,
	type NotionState,
	pageTitle,
	STATE_VERSION,
} from './index.ts';
import { type FetchLike, NotionClient } from './notion/api.ts';
import type { NotionPage } from './notion/types.ts';

const TS_OLD = '2026-01-01T00:00:00.000Z';
const TS_NEW = '2026-02-02T00:00:00.000Z';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init,
	});
}

function titleProperty(text: string): Record<string, unknown> {
	return { Name: { type: 'title', title: [{ plain_text: text }] } };
}

class TestConnector extends NotionConnector {
	constructor(private readonly fetchFn: FetchLike) {
		super();
	}

	protected override createClient(token: string): NotionClient {
		return new NotionClient(token, new AbortController().signal, {
			baseUrl: 'https://notion.test/v1',
			fetchFn: this.fetchFn,
			requestIntervalMs: 0,
		});
	}
}

function prime(
	connector: NotionConnector,
	state: NotionState | null,
	token = 'test-token',
): void {
	Object.assign(connector, {
		config: { personal_access_token: token },
		lastState: state,
		signal: new AbortController().signal,
	});
}

async function collect(connector: NotionConnector): Promise<PollResult[]> {
	const results: PollResult[] = [];
	for await (const result of connector.poll()) {
		results.push(result);
	}
	return results;
}

Deno.test('pageTitle finds the title property regardless of its name', () => {
	const page: NotionPage = {
		object: 'page',
		id: 'p1',
		properties: {
			Status: { type: 'select', select: { name: 'Open' } },
			...titleProperty('My Page'),
		},
	};
	assert.equal(pageTitle(page), 'My Page');
	assert.equal(pageTitle({ object: 'page', id: 'p2' }), 'Untitled');
});

Deno.test('buildPageDoc maps notion page fields onto the wire doc', () => {
	const doc = buildPageDoc(
		{
			object: 'page',
			id: 'page-1',
			url: 'https://www.notion.so/My-Page-page1',
			created_time: TS_OLD,
			last_edited_time: TS_NEW,
			properties: titleProperty('My Page'),
		},
		'# Body\n',
	);

	assert.equal(doc.id, 'page-1');
	assert.equal(doc.title, 'My Page');
	assert.equal(doc.content, '# Body\n');
	assert.equal(doc.content_format, 'markdown');
	assert.equal(doc.doc_type, 'notion:page');
	assert.equal(doc.doc_updated_at, TS_NEW);
	assert.equal(doc.original_file_size, 7);
	assert.deepEqual(doc.metadata, {
		url: 'https://www.notion.so/My-Page-page1',
		created_at: TS_OLD,
	});
});

Deno.test('buildPageDoc falls back to a constructed notion url', () => {
	const doc = buildPageDoc(
		{ object: 'page', id: 'abc-123', properties: {} },
		'',
	);
	assert.deepEqual(doc.metadata, { url: 'https://www.notion.so/abc123' });
});

Deno.test('collectDeletes returns known ids missing from the enumeration', () => {
	assert.deepEqual(
		collectDeletes({ a: TS_OLD, b: TS_OLD }, new Set(['b'])),
		['a'],
	);
});

Deno.test('poll fails fast without a personal access token', async () => {
	const connector = new TestConnector(() => {
		throw new Error('poll must not reach the network without a token');
	});
	prime(connector, null, '   ');

	await assert.rejects(
		() => connector.poll().next(),
		/Personal Access Token is required/,
	);
});

Deno.test('poll upserts changed pages, skips unchanged ones, deletes gone ones', async () => {
	const requested: string[] = [];
	const connector = new TestConnector((url, init) => {
		requested.push(url);
		if (url.endsWith('/search')) {
			assert.equal(init.method, 'POST');
			return Promise.resolve(jsonResponse({
				results: [
					{
						object: 'page',
						id: 'aaa',
						url: 'https://www.notion.so/aaa',
						created_time: TS_OLD,
						last_edited_time: TS_OLD,
						properties: titleProperty('Unchanged'),
					},
					{
						object: 'page',
						id: 'bbb',
						url: 'https://www.notion.so/bbb',
						created_time: TS_OLD,
						last_edited_time: TS_NEW,
						properties: titleProperty('Changed'),
					},
				],
				has_more: false,
			}));
		}
		if (url.includes('/blocks/bbb/children')) {
			return Promise.resolve(jsonResponse({
				results: [
					{
						id: 'blk1',
						type: 'paragraph',
						has_children: false,
						paragraph: {
							rich_text: [{ type: 'text', plain_text: 'Hello from B.' }],
						},
					},
				],
				has_more: false,
			}));
		}
		throw new Error(`Unexpected request: ${url}`);
	});
	prime(connector, {
		version: STATE_VERSION,
		pages: { aaa: TS_OLD, ccc: TS_OLD },
	});

	const results = await collect(connector);

	assert.equal(results.length, 2);

	const [batch, finale] = results;
	assert.equal(batch.updates.length, 1);
	const update = batch.updates[0];
	assert.equal(update.kind, 'upsert');
	if (update.kind !== 'upsert') {
		throw new Error('Expected an upsert update.');
	}
	assert.equal(update.doc.id, 'bbb');
	assert.equal(update.doc.title, 'Changed');
	assert.equal(update.doc.content, 'Hello from B.\n');
	assert.deepEqual(batch.state, {
		version: STATE_VERSION,
		pages: { aaa: TS_OLD, ccc: TS_OLD, bbb: TS_NEW },
	});

	assert.deepEqual(finale.updates, [{ kind: 'delete', id: 'ccc' }]);
	assert.deepEqual(finale.state, {
		version: STATE_VERSION,
		pages: { aaa: TS_OLD, bbb: TS_NEW },
	});

	assert.ok(
		!requested.some((url) => url.includes('/blocks/aaa/')),
		'unchanged pages must not be re-fetched',
	);
});

Deno.test('poll skips archived pages entirely', async () => {
	const connector = new TestConnector((url) => {
		if (url.endsWith('/search')) {
			return Promise.resolve(jsonResponse({
				results: [
					{
						object: 'page',
						id: 'zzz',
						archived: true,
						last_edited_time: TS_NEW,
						properties: titleProperty('Archived'),
					},
				],
				has_more: false,
			}));
		}
		throw new Error(`Unexpected request: ${url}`);
	});
	prime(connector, { version: STATE_VERSION, pages: { zzz: TS_OLD } });

	const results = await collect(connector);
	const finale = results.at(-1);

	assert.ok(finale != null);
	assert.deepEqual(finale.updates, [{ kind: 'delete', id: 'zzz' }]);
	assert.deepEqual(finale.state, { version: STATE_VERSION, pages: {} });
});

Deno.test('poll skips pages flagged is_archived (2026-03-11 field name)', async () => {
	const connector = new TestConnector((url) => {
		if (url.endsWith('/search')) {
			return Promise.resolve(jsonResponse({
				results: [
					{
						object: 'page',
						id: 'yyy',
						is_archived: true,
						last_edited_time: TS_NEW,
						properties: titleProperty('Archived'),
					},
				],
				has_more: false,
			}));
		}
		throw new Error(`Unexpected request: ${url}`);
	});
	prime(connector, { version: STATE_VERSION, pages: {} });

	const results = await collect(connector);

	assert.deepEqual(results.flatMap((result) => result.updates), []);
});

Deno.test('stale or malformed state triggers a full resync', () => {
	assert.deepEqual(knownPagesFromState(undefined), {});
	assert.deepEqual(knownPagesFromState({ pages: { a: TS_OLD } }), {});
	assert.deepEqual(
		knownPagesFromState({ version: 99, pages: { a: TS_OLD } }),
		{},
	);
	assert.deepEqual(
		knownPagesFromState({
			version: STATE_VERSION,
			pages: { a: TS_OLD, b: 42 as unknown as string },
		}),
		{ a: TS_OLD },
	);
});

Deno.test('buildPageDoc links child pages to their parent page', () => {
	const doc = buildPageDoc(
		{
			object: 'page',
			id: 'child-1',
			parent: { type: 'page_id', page_id: 'parent-1' },
			properties: titleProperty('Child'),
		},
		'body\n',
	);
	assert.equal(doc.parent_id, 'parent-1');

	const rootDoc = buildPageDoc(
		{
			object: 'page',
			id: 'root-1',
			parent: { type: 'workspace', workspace: true },
			properties: titleProperty('Root'),
		},
		'body\n',
	);
	assert.equal(rootDoc.parent_id, undefined);
});

Deno.test('buildPageDoc prepends database properties to the content', () => {
	const doc = buildPageDoc(
		{
			object: 'page',
			id: 'db-row-1',
			properties: {
				...titleProperty('Task'),
				Status: { type: 'status', status: { name: 'In progress' } },
				Tags: {
					type: 'multi_select',
					multi_select: [{ name: 'a' }, { name: 'b' }],
				},
			},
		},
		'# Body\n',
	);
	assert.equal(
		doc.content,
		'## Properties\n\n- **Status:** In progress\n- **Tags:** a, b\n\n# Body\n',
	);

	const plain = buildPageDoc(
		{ object: 'page', id: 'plain-1', properties: titleProperty('Plain') },
		'# Body\n',
	);
	assert.equal(plain.content, '# Body\n');
});
