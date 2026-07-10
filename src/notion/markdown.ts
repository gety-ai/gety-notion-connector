import {
	type BlockNode,
	blockPayload,
	isRecord,
	notionObjectUrl,
	type NotionRichTextItem,
	richTextOf,
} from './types.ts';

/** A rendered block plus whether it is a list item (list items join tightly). */
interface Chunk {
	text: string;
	listItem: boolean;
}

/** Renders a fetched Notion block tree as GitHub-flavored Markdown. */
export function blocksToMarkdown(nodes: BlockNode[]): string {
	const markdown = joinChunks(renderSiblings(nodes, ''));
	return markdown.length > 0 ? `${markdown}\n` : '';
}

/** Renders inline Notion rich text as Markdown. */
export function richTextToMarkdown(items: NotionRichTextItem[]): string {
	return items.map(renderRichTextItem).join('');
}

export function richTextToPlain(items: NotionRichTextItem[]): string {
	return items.map((item) => item.plain_text ?? '').join('');
}

function renderRichTextItem(item: NotionRichTextItem): string {
	if (item.type === 'equation') {
		const expression = item.equation?.expression ?? item.plain_text ?? '';
		return expression.length > 0 ? `$${expression}$` : '';
	}

	const raw = item.plain_text ?? '';
	if (raw.length === 0) {
		return '';
	}

	// Emphasis markers must hug the text, so keep surrounding spaces outside.
	const leading = raw.match(/^\s*/)?.[0] ?? '';
	const trailing = leading.length === raw.length
		? ''
		: raw.match(/\s*$/)?.[0] ?? '';
	let core = raw.slice(leading.length, raw.length - trailing.length);

	if (core.length > 0) {
		const annotations = item.annotations ?? {};
		if (annotations.code === true) {
			core = core.includes('`') ? `\`\` ${core} \`\`` : `\`${core}\``;
		}
		if (annotations.bold === true) {
			core = `**${core}**`;
		}
		if (annotations.italic === true) {
			core = `*${core}*`;
		}
		if (annotations.strikethrough === true) {
			core = `~~${core}~~`;
		}
	}

	const href = typeof item.href === 'string' && item.href.length > 0
		? item.href
		: null;
	const decorated = href != null && core.length > 0
		? `[${core}](${mdUrl(href)})`
		: core;
	return leading + decorated + trailing;
}

function renderSiblings(nodes: BlockNode[], indent: string): Chunk[] {
	const chunks: Chunk[] = [];
	let numberedIndex = 0;
	for (const node of nodes) {
		numberedIndex = node.block.type === 'numbered_list_item'
			? numberedIndex + 1
			: 0;
		const chunk = renderNode(node, indent, numberedIndex);
		if (chunk != null && chunk.text.length > 0) {
			chunks.push(chunk);
		}
	}
	return chunks;
}

function joinChunks(chunks: Chunk[]): string {
	let out = '';
	let previousWasListItem = false;
	for (const chunk of chunks) {
		if (out.length === 0) {
			out = chunk.text;
		} else if (previousWasListItem && chunk.listItem) {
			out += `\n${chunk.text}`;
		} else {
			out += `\n\n${chunk.text}`;
		}
		previousWasListItem = chunk.listItem;
	}
	return out;
}

function renderChildren(node: BlockNode, indent: string): string {
	return joinChunks(renderSiblings(node.children, indent));
}

function renderNode(
	node: BlockNode,
	indent: string,
	numberedIndex: number,
): Chunk | null {
	const block = node.block;
	const payload = blockPayload(block);
	const text = richTextToMarkdown(richTextOf(payload));

	switch (block.type) {
		case 'paragraph':
			return blockWithChildren(
				text.length > 0 ? prefixLines(text, indent) : null,
				node,
				indent,
			);
		case 'heading_1':
			return heading(node, indent, '#', text);
		case 'heading_2':
			return heading(node, indent, '##', text);
		case 'heading_3':
			return heading(node, indent, '###', text);
		case 'bulleted_list_item':
		case 'toggle':
			return listItem(node, indent, '- ', text);
		case 'numbered_list_item':
			return listItem(node, indent, `${Math.max(numberedIndex, 1)}. `, text);
		case 'to_do': {
			const marker = payload.checked === true ? '- [x] ' : '- [ ] ';
			// The `[x] ` is item content, so children align two columns in,
			// like any bullet; deeper indentation would render as a code block.
			return listItem(node, indent, marker, text, 2);
		}
		case 'quote':
			return quoteChunk(node, indent, text);
		case 'callout': {
			const icon = calloutIcon(payload);
			const head = icon.length > 0 && text.length > 0
				? `${icon} ${text}`
				: icon + text;
			return quoteChunk(node, indent, head);
		}
		case 'code':
			return codeChunk(payload, indent);
		case 'divider':
			return { text: `${indent}---`, listItem: false };
		case 'equation': {
			const expression = typeof payload.expression === 'string'
				? payload.expression
				: '';
			if (expression.length === 0) {
				return null;
			}
			return {
				text: prefixLines(`$$\n${expression}\n$$`, indent),
				listItem: false,
			};
		}
		case 'image': {
			const url = fileUrl(payload);
			if (url == null) {
				return null;
			}
			const caption = richTextToPlain(richTextOf(payload, 'caption')).trim();
			const alt = caption.length > 0 ? caption : 'image';
			return {
				text: `${indent}![${escapeBrackets(alt)}](${mdUrl(url)})`,
				listItem: false,
			};
		}
		case 'video':
		case 'audio':
		case 'file':
		case 'pdf':
			return attachmentChunk(block.type, payload, indent);
		case 'bookmark':
		case 'embed':
		case 'link_preview': {
			const url = typeof payload.url === 'string' ? payload.url : '';
			if (url.length === 0) {
				return null;
			}
			const caption = richTextToPlain(richTextOf(payload, 'caption')).trim();
			const label = caption.length > 0 ? caption : url;
			return {
				text: `${indent}[${escapeBrackets(label)}](${mdUrl(url)})`,
				listItem: false,
			};
		}
		case 'link_to_page': {
			const target = typeof payload.page_id === 'string'
				? payload.page_id
				: typeof payload.database_id === 'string'
				? payload.database_id
				: null;
			if (target == null) {
				return null;
			}
			return {
				text: `${indent}[Linked page](${notionObjectUrl(target)})`,
				listItem: false,
			};
		}
		case 'child_page':
		case 'child_database': {
			const title = typeof payload.title === 'string' ? payload.title : '';
			const icon = block.type === 'child_page' ? '📄' : '🗃️';
			const label = title.length > 0 ? title : 'Untitled';
			return {
				text: `${indent}${icon} [${escapeBrackets(label)}](${
					notionObjectUrl(block.id)
				})`,
				listItem: false,
			};
		}
		case 'table':
			return tableChunk(node, payload, indent);
		case 'table_row':
			// Rendered by the parent table block.
			return null;
		case 'synced_block':
		case 'column_list':
		case 'column':
		case 'template': {
			const inner = renderChildren(node, indent);
			return inner.length > 0 ? { text: inner, listItem: false } : null;
		}
		case 'breadcrumb':
		case 'table_of_contents':
		case 'unsupported':
			return null;
		default:
			return blockWithChildren(
				text.length > 0 ? prefixLines(text, indent) : null,
				node,
				indent,
			);
	}
}

function heading(
	node: BlockNode,
	indent: string,
	marker: string,
	text: string,
): Chunk | null {
	const head = text.length > 0 ? `${indent}${marker} ${text}` : null;
	// Toggleable headings can carry children; render them right below.
	return blockWithChildren(head, node, indent);
}

function blockWithChildren(
	head: string | null,
	node: BlockNode,
	indent: string,
): Chunk | null {
	const parts: string[] = [];
	if (head != null && head.length > 0) {
		parts.push(head);
	}
	const children = renderChildren(node, indent);
	if (children.length > 0) {
		parts.push(children);
	}
	if (parts.length === 0) {
		return null;
	}
	return { text: parts.join('\n\n'), listItem: false };
}

function listItem(
	node: BlockNode,
	indent: string,
	marker: string,
	text: string,
	childIndentWidth = marker.length,
): Chunk {
	const head = `${indent}${marker}${text}`;
	const childIndent = indent + ' '.repeat(childIndentWidth);
	const children = renderChildren(node, childIndent);
	return {
		text: children.length > 0 ? `${head}\n${children}` : head,
		listItem: true,
	};
}

function quoteChunk(
	node: BlockNode,
	indent: string,
	head: string,
): Chunk | null {
	const parts: string[] = [];
	if (head.length > 0) {
		parts.push(head);
	}
	const children = renderChildren(node, '');
	if (children.length > 0) {
		parts.push(children);
	}
	if (parts.length === 0) {
		return null;
	}
	return {
		text: prefixLines(prefixLines(parts.join('\n\n'), '> '), indent),
		listItem: false,
	};
}

function codeChunk(
	payload: Record<string, unknown>,
	indent: string,
): Chunk {
	const code = richTextToPlain(richTextOf(payload));
	const language = typeof payload.language === 'string' &&
			payload.language !== 'plain text'
		? payload.language
		: '';
	const fence = code.includes('```') ? '````' : '```';
	const lines = [`${fence}${language}`, ...code.split('\n'), fence];
	const caption = richTextToPlain(richTextOf(payload, 'caption')).trim();
	const body = prefixLines(lines.join('\n'), indent);
	if (caption.length === 0) {
		return { text: body, listItem: false };
	}
	return {
		text: `${body}\n\n${prefixLines(caption, indent)}`,
		listItem: false,
	};
}

function attachmentChunk(
	type: string,
	payload: Record<string, unknown>,
	indent: string,
): Chunk | null {
	const url = fileUrl(payload);
	if (url == null) {
		return null;
	}
	const caption = richTextToPlain(richTextOf(payload, 'caption')).trim();
	const name = typeof payload.name === 'string' ? payload.name.trim() : '';
	const label = caption.length > 0 ? caption : name.length > 0 ? name : type;
	return {
		text: `${indent}[${escapeBrackets(label)}](${mdUrl(url)})`,
		listItem: false,
	};
}

function tableChunk(
	node: BlockNode,
	payload: Record<string, unknown>,
	indent: string,
): Chunk | null {
	const rows = node.children
		.filter((child) => child.block.type === 'table_row')
		.map((child) => {
			const cells = blockPayload(child.block).cells;
			if (!Array.isArray(cells)) {
				return [];
			}
			return cells.map((cell) =>
				tableCellText(Array.isArray(cell) ? cell.filter(isRecord) : [])
			);
		});
	if (rows.length === 0) {
		return null;
	}

	const width = Math.max(
		typeof payload.table_width === 'number' ? payload.table_width : 0,
		...rows.map((row) => row.length),
		1,
	);
	const pad = (row: string[]): string[] =>
		Array.from({ length: width }, (_, index) => row[index] ?? '');

	const hasHeader = payload.has_column_header === true;
	const header = hasHeader ? pad(rows[0]) : Array(width).fill('');
	const body = hasHeader ? rows.slice(1) : rows;
	const lines = [
		`| ${header.join(' | ')} |`,
		`| ${Array(width).fill('---').join(' | ')} |`,
		...body.map((row) => `| ${pad(row).join(' | ')} |`),
	];
	return { text: prefixLines(lines.join('\n'), indent), listItem: false };
}

function tableCellText(cell: NotionRichTextItem[]): string {
	return richTextToMarkdown(cell)
		.replaceAll('\n', ' ')
		.replaceAll('|', '\\|')
		.trim();
}

function calloutIcon(payload: Record<string, unknown>): string {
	const icon = payload.icon;
	if (isRecord(icon) && typeof icon.emoji === 'string') {
		return icon.emoji;
	}
	return '💡';
}

function fileUrl(payload: Record<string, unknown>): string | null {
	const external = payload.external;
	if (isRecord(external) && typeof external.url === 'string') {
		return external.url;
	}
	const file = payload.file;
	if (isRecord(file) && typeof file.url === 'string') {
		return file.url;
	}
	return null;
}

function escapeBrackets(text: string): string {
	return text.replaceAll('[', '\\[').replaceAll(']', '\\]');
}

/** Parentheses in a link target would end the Markdown link early. */
function mdUrl(url: string): string {
	return url.replaceAll('(', '%28').replaceAll(')', '%29');
}

function prefixLines(text: string, prefix: string): string {
	if (prefix.length === 0) {
		return text;
	}
	return text
		.split('\n')
		.map((line) => (line.length > 0 ? prefix + line : prefix.trimEnd()))
		.join('\n');
}
