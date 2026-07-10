import { isRecord, notionObjectUrl, type NotionRichTextItem } from './types.ts';
import { richTextToMarkdown } from './markdown.ts';

/**
 * Renders a page's non-title properties as a Markdown bullet list.
 * Database-backed pages carry their key facts (status, tags, owners,
 * dates) in properties, so indexing them matters as much as the body.
 * Values are kept as plain searchable text; only structural Markdown
 * (bold names, links) is emitted.
 */
export function propertiesToMarkdown(
	properties: Record<string, unknown>,
): string {
	const lines: string[] = [];
	for (const [name, property] of Object.entries(properties)) {
		if (
			!isRecord(property) || typeof property.type !== 'string' ||
			property.type === 'title'
		) {
			continue;
		}
		const rendered = propertyValue(property.type, property[property.type]);
		const value = rendered?.replaceAll(/\s*\n\s*/g, ' ').trim() ?? '';
		if (value.length === 0) {
			continue;
		}
		lines.push(`- **${name}:** ${value}`);
	}
	return lines.join('\n');
}

function propertyValue(type: string, value: unknown): string | null {
	switch (type) {
		case 'rich_text':
			return richTextToMarkdown(
				Array.isArray(value)
					? value.filter(isRecord) as NotionRichTextItem[]
					: [],
			);
		case 'number':
			return typeof value === 'number' ? String(value) : null;
		case 'select':
		case 'status':
			return isRecord(value) && typeof value.name === 'string'
				? value.name
				: null;
		case 'multi_select':
			return joinNames(
				value,
				(item) => typeof item.name === 'string' ? item.name : null,
			);
		case 'people':
			return joinNames(value, personName);
		case 'date':
			return dateRange(value);
		case 'checkbox':
			return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : null;
		case 'url':
			return typeof value === 'string' && value.length > 0 ? value : null;
		case 'email':
		case 'phone_number':
			return typeof value === 'string' && value.length > 0 ? value : null;
		case 'files':
			return joinNames(
				value,
				(item) => typeof item.name === 'string' ? item.name : null,
			);
		case 'relation':
			return joinNames(
				value,
				(item) =>
					typeof item.id === 'string'
						? `[Related page](${notionObjectUrl(item.id)})`
						: null,
			);
		case 'formula':
		case 'rollup':
			return computedValue(value);
		case 'created_time':
		case 'last_edited_time':
			return typeof value === 'string' ? value : null;
		case 'created_by':
		case 'last_edited_by':
			return isRecord(value) ? personName(value) : null;
		case 'unique_id': {
			if (!isRecord(value) || typeof value.number !== 'number') {
				return null;
			}
			const prefix = typeof value.prefix === 'string' ? value.prefix : '';
			return prefix.length > 0
				? `${prefix}-${value.number}`
				: String(value.number);
		}
		default:
			return null;
	}
}

function computedValue(value: unknown): string | null {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return null;
	}
	const inner = value[value.type];
	if (typeof inner === 'string' && inner.length > 0) {
		return inner;
	}
	if (typeof inner === 'number') {
		return String(inner);
	}
	if (typeof inner === 'boolean') {
		return inner ? 'Yes' : 'No';
	}
	if (value.type === 'date') {
		return dateRange(inner);
	}
	if (value.type === 'array' && Array.isArray(inner)) {
		const parts = inner
			.filter(isRecord)
			.map((item) =>
				typeof item.type === 'string'
					? propertyValue(item.type, item[item.type])
					: null
			)
			.filter((part): part is string => part != null && part.length > 0);
		return parts.length > 0 ? parts.join(', ') : null;
	}
	return null;
}

function dateRange(value: unknown): string | null {
	if (!isRecord(value) || typeof value.start !== 'string') {
		return null;
	}
	return typeof value.end === 'string'
		? `${value.start} → ${value.end}`
		: value.start;
}

function personName(person: Record<string, unknown>): string | null {
	return typeof person.name === 'string' && person.name.length > 0
		? person.name
		: null;
}

function joinNames(
	value: unknown,
	render: (item: Record<string, unknown>) => string | null,
): string | null {
	if (!Array.isArray(value)) {
		return null;
	}
	const parts = value
		.filter(isRecord)
		.map(render)
		.filter((part): part is string => part != null && part.length > 0);
	return parts.length > 0 ? parts.join(', ') : null;
}
