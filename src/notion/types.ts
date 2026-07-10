export interface NotionRichTextItem {
	type?: string;
	plain_text?: string;
	href?: string | null;
	annotations?: {
		bold?: boolean;
		italic?: boolean;
		strikethrough?: boolean;
		underline?: boolean;
		code?: boolean;
	};
	equation?: { expression?: string };
}

/**
 * A raw Notion block. The type-specific payload lives under a key named
 * after `type` (e.g. `block.paragraph`), so it is indexed as `unknown` and
 * narrowed via `blockPayload`.
 */
export interface NotionBlock {
	id: string;
	type: string;
	has_children?: boolean;
	[key: string]: unknown;
}

/** A Notion block with its (already fetched) children. */
export interface BlockNode {
	block: NotionBlock;
	children: BlockNode[];
}

export interface NotionPage {
	object: string;
	id: string;
	url?: string;
	created_time?: string;
	last_edited_time?: string;
	/** Pre-2026 API versions; replaced by `is_archived` in 2026-03-11. */
	archived?: boolean;
	is_archived?: boolean;
	in_trash?: boolean;
	parent?: unknown;
	properties?: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function blockPayload(block: NotionBlock): Record<string, unknown> {
	const payload = block[block.type];
	return isRecord(payload) ? payload : {};
}

export function richTextOf(
	payload: Record<string, unknown>,
	key = 'rich_text',
): NotionRichTextItem[] {
	const items = payload[key];
	if (!Array.isArray(items)) {
		return [];
	}
	return items.filter(isRecord) as NotionRichTextItem[];
}

/** Stable browser URL for a Notion page or database id. */
export function notionObjectUrl(id: string): string {
	return `https://www.notion.so/${id.replaceAll('-', '')}`;
}
