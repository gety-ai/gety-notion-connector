import assert from 'node:assert/strict';
import { propertiesToMarkdown } from './properties.ts';

Deno.test('propertiesToMarkdown renders common property types', () => {
	const markdown = propertiesToMarkdown({
		Name: { type: 'title', title: [{ plain_text: 'ignored' }] },
		Status: { type: 'status', status: { name: 'In progress' } },
		Priority: { type: 'select', select: { name: 'High' } },
		Tags: {
			type: 'multi_select',
			multi_select: [{ name: 'a' }, { name: 'b' }],
		},
		Estimate: { type: 'number', number: 2.5 },
		Done: { type: 'checkbox', checkbox: false },
		Owner: { type: 'people', people: [{ name: 'Ada' }, { name: 'Grace' }] },
		Due: { type: 'date', date: { start: '2026-07-01', end: '2026-07-15' } },
		Site: { type: 'url', url: 'https://example.com' },
		Contact: { type: 'email', email: 'a@example.com' },
		Ticket: { type: 'unique_id', unique_id: { prefix: 'ENG', number: 42 } },
		Note: {
			type: 'rich_text',
			rich_text: [
				{
					type: 'text',
					plain_text: 'multi\nline',
					annotations: { bold: true },
				},
			],
		},
	});

	assert.equal(
		markdown,
		[
			'- **Status:** In progress',
			'- **Priority:** High',
			'- **Tags:** a, b',
			'- **Estimate:** 2.5',
			'- **Done:** No',
			'- **Owner:** Ada, Grace',
			'- **Due:** 2026-07-01 → 2026-07-15',
			'- **Site:** https://example.com',
			'- **Contact:** a@example.com',
			'- **Ticket:** ENG-42',
			'- **Note:** **multi line**',
		].join('\n'),
	);
});

Deno.test('propertiesToMarkdown renders formulas, rollups and relations', () => {
	const markdown = propertiesToMarkdown({
		Total: { type: 'formula', formula: { type: 'number', number: 7 } },
		Window: {
			type: 'rollup',
			rollup: { type: 'date', date: { start: '2026-01-01' } },
		},
		Names: {
			type: 'rollup',
			rollup: {
				type: 'array',
				array: [{ type: 'select', select: { name: 'x' } }],
			},
		},
		Parent: {
			type: 'relation',
			relation: [{ id: 'abc-123' }],
		},
	});

	assert.equal(
		markdown,
		[
			'- **Total:** 7',
			'- **Window:** 2026-01-01',
			'- **Names:** x',
			'- **Parent:** [Related page](https://www.notion.so/abc123)',
		].join('\n'),
	);
});

Deno.test('propertiesToMarkdown skips empty, unknown and malformed values', () => {
	const markdown = propertiesToMarkdown({
		Empty: { type: 'rich_text', rich_text: [] },
		NoName: { type: 'select', select: null },
		Mystery: { type: 'made_up_type', made_up_type: { some: 'thing' } },
		Broken: 'not a property',
	});
	assert.equal(markdown, '');
});
