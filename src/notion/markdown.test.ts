import assert from 'node:assert/strict';
import { blocksToMarkdown, richTextToMarkdown } from './markdown.ts';
import type { BlockNode, NotionRichTextItem } from './types.ts';

let blockCount = 0;

function rt(
	text: string,
	extra: Partial<NotionRichTextItem> = {},
): NotionRichTextItem {
	return { type: 'text', plain_text: text, ...extra };
}

function node(
	type: string,
	payload: Record<string, unknown> = {},
	children: BlockNode[] = [],
	id?: string,
): BlockNode {
	blockCount += 1;
	return {
		block: {
			id: id ?? `b${blockCount}`,
			type,
			has_children: children.length > 0,
			[type]: payload,
		},
		children,
	};
}

Deno.test('richTextToMarkdown renders annotations, links and equations', () => {
	const markdown = richTextToMarkdown([
		rt('plain '),
		rt('bold', { annotations: { bold: true } }),
		rt(' and '),
		rt('code', { annotations: { code: true } }),
		rt(' and '),
		rt('site', { href: 'https://example.com' }),
		rt(' and '),
		rt('x^2', { type: 'equation', equation: { expression: 'x^2' } }),
	]);
	assert.equal(
		markdown,
		'plain **bold** and `code` and [site](https://example.com) and $x^2$',
	);
});

Deno.test('link targets escape parentheses', () => {
	const markdown = richTextToMarkdown([
		rt('wiki', {
			href: 'https://en.wikipedia.org/wiki/Bracket_(disambiguation)',
		}),
	]);
	assert.equal(
		markdown,
		'[wiki](https://en.wikipedia.org/wiki/Bracket_%28disambiguation%29)',
	);
});

Deno.test('emphasis markers hug text despite surrounding spaces', () => {
	const markdown = richTextToMarkdown([
		rt('a'),
		rt(' bold ', { annotations: { bold: true } }),
		rt('b', { annotations: { italic: true, strikethrough: true } }),
	]);
	assert.equal(markdown, 'a **bold** ~~*b*~~');
});

Deno.test('headings, paragraphs and dividers', () => {
	const markdown = blocksToMarkdown([
		node('heading_1', { rich_text: [rt('Title')] }),
		node('paragraph', { rich_text: [rt('Hello world.')] }),
		node('heading_2', { rich_text: [rt('Section')] }),
		node('divider'),
	]);
	assert.equal(markdown, '# Title\n\nHello world.\n\n## Section\n\n---\n');
});

Deno.test('nested lists keep numbering, indentation and tight joins', () => {
	const markdown = blocksToMarkdown([
		node('numbered_list_item', { rich_text: [rt('first')] }),
		node('numbered_list_item', { rich_text: [rt('second')] }, [
			node('bulleted_list_item', { rich_text: [rt('child')] }),
		]),
		node('to_do', { rich_text: [rt('done')], checked: true }),
		node('to_do', { rich_text: [rt('open')], checked: false }, [
			node('bulleted_list_item', { rich_text: [rt('sub task')] }),
		]),
		node('toggle', { rich_text: [rt('more')] }, [
			node('paragraph', { rich_text: [rt('hidden')] }),
		]),
	]);
	assert.equal(
		markdown,
		[
			'1. first',
			'2. second',
			'   - child',
			'- [x] done',
			'- [ ] open',
			'  - sub task',
			'- more',
			'  hidden',
		].join('\n') + '\n',
	);
});

Deno.test('quotes and callouts render as blockquotes', () => {
	const markdown = blocksToMarkdown([
		node('quote', { rich_text: [rt('wise words')] }, [
			node('paragraph', { rich_text: [rt('inner')] }),
		]),
		node('callout', {
			rich_text: [rt('note')],
			icon: { type: 'emoji', emoji: '⚠️' },
		}),
	]);
	assert.equal(markdown, '> wise words\n>\n> inner\n\n> ⚠️ note\n');
});

Deno.test('code blocks render fences with language and caption', () => {
	const markdown = blocksToMarkdown([
		node('code', {
			rich_text: [rt('const a = 1;\nconst b = 2;')],
			language: 'typescript',
			caption: [rt('snippet')],
		}),
	]);
	assert.equal(
		markdown,
		'```typescript\nconst a = 1;\nconst b = 2;\n```\n\nsnippet\n',
	);
});

Deno.test('tables render header separators and escape pipes', () => {
	const markdown = blocksToMarkdown([
		node('table', { table_width: 2, has_column_header: true }, [
			node('table_row', { cells: [[rt('Name')], [rt('Value')]] }),
			node('table_row', { cells: [[rt('a|b')], [rt('1')]] }),
		]),
	]);
	assert.equal(
		markdown,
		'| Name | Value |\n| --- | --- |\n| a\\|b | 1 |\n',
	);
});

Deno.test('media, bookmarks and child pages become links', () => {
	const markdown = blocksToMarkdown([
		node('image', {
			type: 'external',
			external: { url: 'https://img.example/x.png' },
			caption: [rt('diagram')],
		}),
		node('bookmark', { url: 'https://example.com' }),
		node('file', {
			type: 'file',
			file: { url: 'https://files.example/report.pdf' },
			name: 'report.pdf',
		}),
		node('child_page', { title: 'Sub page' }, [], 'abc-123'),
	]);
	assert.equal(
		markdown,
		[
			'![diagram](https://img.example/x.png)',
			'',
			'[https://example.com](https://example.com)',
			'',
			'[report.pdf](https://files.example/report.pdf)',
			'',
			'📄 [Sub page](https://www.notion.so/abc123)',
			'',
		].join('\n'),
	);
});

Deno.test('layout blocks flatten and empty paragraphs are skipped', () => {
	const markdown = blocksToMarkdown([
		node('column_list', {}, [
			node('column', {}, [node('paragraph', { rich_text: [rt('left')] })]),
			node('column', {}, [node('paragraph', { rich_text: [rt('right')] })]),
		]),
		node('paragraph', { rich_text: [] }),
		node('breadcrumb'),
		node('equation', { expression: 'E = mc^2' }),
	]);
	assert.equal(markdown, 'left\n\nright\n\n$$\nE = mc^2\n$$\n');
});

Deno.test('empty tree renders empty string', () => {
	assert.equal(blocksToMarkdown([]), '');
});
