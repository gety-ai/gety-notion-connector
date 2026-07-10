// src/index.ts
import {
  Connector,
  del,
  upsert
} from "@gety-ai/connector-sdk";

// src/notion/types.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function blockPayload(block) {
  const payload = block[block.type];
  return isRecord(payload) ? payload : {};
}
function richTextOf(payload, key = "rich_text") {
  const items = payload[key];
  if (!Array.isArray(items)) {
    return [];
  }
  return items.filter(isRecord);
}
function notionObjectUrl(id) {
  return `https://www.notion.so/${id.replaceAll("-", "")}`;
}

// src/notion/api.ts
var DEFAULT_BASE_URL = "https://api.notion.com/v1";
var NOTION_VERSION = "2026-03-11";
var PAGE_SIZE = 100;
var MAX_RETRIES = 5;
var MAX_RETRY_AFTER_MS = 6e4;
var MAX_BACKOFF_MS = 3e4;
var DEFAULT_REQUEST_INTERVAL_MS = 350;
var MAX_BLOCK_DEPTH = 32;
var NotionApiError = class extends Error {
  status;
  code;
  constructor(status, code, message) {
    super(`Notion API error ${status} (${code}): ${message}`);
    this.name = "NotionApiError";
    this.status = status;
    this.code = code;
  }
};
function isObjectNotFound(error) {
  return error instanceof NotionApiError && error.status === 404;
}
var NotionClient = class {
  #token;
  #signal;
  #baseUrl;
  #fetchFn;
  #requestIntervalMs;
  #nextRequestAt = 0;
  constructor(token, signal, options = {}) {
    this.#token = token;
    this.#signal = signal;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.#requestIntervalMs = Math.max(
      0,
      options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS
    );
  }
  /** Yields every page shared with the integration, one search batch at a time. */
  async *searchPages() {
    let cursor;
    while (true) {
      const body = {
        filter: { property: "object", value: "page" },
        // Ascending: timestamps never decrease, so a page edited while
        // we paginate can only move toward the end of the cursor stream
        // and is still enumerated (descending could skip it, and a
        // skipped page would be wrongly diff-deleted).
        sort: { direction: "ascending", timestamp: "last_edited_time" },
        page_size: PAGE_SIZE
      };
      if (cursor != null) {
        body.start_cursor = cursor;
      }
      const response = await this.#request("POST", "/search", body);
      const results = Array.isArray(response.results) ? response.results : [];
      yield results.filter(
        (item) => isRecord(item) && item.object === "page" && typeof item.id === "string"
      );
      if (response.has_more !== true) {
        return;
      }
      cursor = requireCursor(response.next_cursor, "search");
    }
  }
  /** Fetches the full block tree of a page (without descending into child pages). */
  async fetchBlockTree(pageId) {
    return await this.#fetchDescendants(pageId, /* @__PURE__ */ new Set([pageId]), 0);
  }
  async #fetchDescendants(parentId, visited, depth) {
    if (depth >= MAX_BLOCK_DEPTH) {
      return [];
    }
    const nodes = [];
    for (const block of await this.#fetchAllChildren(parentId)) {
      const node = { block, children: [] };
      const childSource = childFetchId(block);
      if (childSource != null && !visited.has(childSource)) {
        visited.add(childSource);
        node.children = await this.#fetchDescendants(
          childSource,
          visited,
          depth + 1
        );
      }
      nodes.push(node);
    }
    return nodes;
  }
  async #fetchAllChildren(blockId) {
    const blocks = [];
    let cursor;
    while (true) {
      const query = new URLSearchParams({ page_size: String(PAGE_SIZE) });
      if (cursor != null) {
        query.set("start_cursor", cursor);
      }
      const response = await this.#request(
        "GET",
        `/blocks/${encodeURIComponent(blockId)}/children?${query}`
      );
      const results = Array.isArray(response.results) ? response.results : [];
      for (const item of results) {
        if (isRecord(item) && typeof item.id === "string" && typeof item.type === "string") {
          blocks.push(item);
        }
      }
      if (response.has_more !== true) {
        return blocks;
      }
      cursor = requireCursor(response.next_cursor, "block children");
    }
  }
  async #request(method, path, body) {
    for (let attempt = 0; ; attempt += 1) {
      this.#signal.throwIfAborted();
      await this.#waitForRequestSlot();
      const response = await this.#fetchFn(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          "Authorization": `Bearer ${this.#token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json"
        },
        body: body == null ? void 0 : JSON.stringify(body),
        signal: this.#signal
      });
      this.#nextRequestAt = Date.now() + this.#requestIntervalMs;
      if (isRetryable(response.status) && attempt < MAX_RETRIES) {
        await response.body?.cancel();
        await sleep(retryDelayMs(response, attempt), this.#signal);
        continue;
      }
      const payload = await response.json().catch(() => null);
      const record = isRecord(payload) ? payload : {};
      if (!response.ok) {
        const code = typeof record.code === "string" ? record.code : "unknown";
        const message = typeof record.message === "string" ? record.message : response.statusText;
        throw new NotionApiError(response.status, code, message);
      }
      return record;
    }
  }
  async #waitForRequestSlot() {
    const waitMs = this.#nextRequestAt - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs, this.#signal);
    }
  }
};
function requireCursor(cursor, context) {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new Error(
      `Notion ${context} response set has_more without a next_cursor.`
    );
  }
  return cursor;
}
function isRetryable(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}
function retryDelayMs(response, attempt) {
  const header = response.headers.get("retry-after");
  if (header != null) {
    const retryAfter = Number(header);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      return Math.min(retryAfter * 1e3, MAX_RETRY_AFTER_MS);
    }
  }
  return Math.min(1e3 * 2 ** attempt, MAX_BACKOFF_MS);
}
function childFetchId(block) {
  if (block.type === "child_page" || block.type === "child_database" || block.type === "unsupported") {
    return null;
  }
  if (block.type === "synced_block") {
    const payload = block.synced_block;
    if (isRecord(payload) && isRecord(payload.synced_from)) {
      const original = payload.synced_from.block_id;
      if (typeof original === "string") {
        return original;
      }
    }
  }
  return block.has_children === true ? block.id : null;
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Poll aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// src/notion/markdown.ts
function blocksToMarkdown(nodes) {
  const markdown = joinChunks(renderSiblings(nodes, ""));
  return markdown.length > 0 ? `${markdown}
` : "";
}
function richTextToMarkdown(items) {
  return items.map(renderRichTextItem).join("");
}
function richTextToPlain(items) {
  return items.map((item) => item.plain_text ?? "").join("");
}
function renderRichTextItem(item) {
  if (item.type === "equation") {
    const expression = item.equation?.expression ?? item.plain_text ?? "";
    return expression.length > 0 ? `$${expression}$` : "";
  }
  const raw = item.plain_text ?? "";
  if (raw.length === 0) {
    return "";
  }
  const leading = raw.match(/^\s*/)?.[0] ?? "";
  const trailing = leading.length === raw.length ? "" : raw.match(/\s*$/)?.[0] ?? "";
  let core = raw.slice(leading.length, raw.length - trailing.length);
  if (core.length > 0) {
    const annotations = item.annotations ?? {};
    if (annotations.code === true) {
      core = core.includes("`") ? `\`\` ${core} \`\`` : `\`${core}\``;
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
  const href = typeof item.href === "string" && item.href.length > 0 ? item.href : null;
  const decorated = href != null && core.length > 0 ? `[${core}](${mdUrl(href)})` : core;
  return leading + decorated + trailing;
}
function renderSiblings(nodes, indent) {
  const chunks = [];
  let numberedIndex = 0;
  for (const node of nodes) {
    numberedIndex = node.block.type === "numbered_list_item" ? numberedIndex + 1 : 0;
    const chunk = renderNode(node, indent, numberedIndex);
    if (chunk != null && chunk.text.length > 0) {
      chunks.push(chunk);
    }
  }
  return chunks;
}
function joinChunks(chunks) {
  let out = "";
  let previousWasListItem = false;
  for (const chunk of chunks) {
    if (out.length === 0) {
      out = chunk.text;
    } else if (previousWasListItem && chunk.listItem) {
      out += `
${chunk.text}`;
    } else {
      out += `

${chunk.text}`;
    }
    previousWasListItem = chunk.listItem;
  }
  return out;
}
function renderChildren(node, indent) {
  return joinChunks(renderSiblings(node.children, indent));
}
function renderNode(node, indent, numberedIndex) {
  const block = node.block;
  const payload = blockPayload(block);
  const text = richTextToMarkdown(richTextOf(payload));
  switch (block.type) {
    case "paragraph":
      return blockWithChildren(
        text.length > 0 ? prefixLines(text, indent) : null,
        node,
        indent
      );
    case "heading_1":
      return heading(node, indent, "#", text);
    case "heading_2":
      return heading(node, indent, "##", text);
    case "heading_3":
      return heading(node, indent, "###", text);
    case "bulleted_list_item":
    case "toggle":
      return listItem(node, indent, "- ", text);
    case "numbered_list_item":
      return listItem(node, indent, `${Math.max(numberedIndex, 1)}. `, text);
    case "to_do": {
      const marker = payload.checked === true ? "- [x] " : "- [ ] ";
      return listItem(node, indent, marker, text, 2);
    }
    case "quote":
      return quoteChunk(node, indent, text);
    case "callout": {
      const icon = calloutIcon(payload);
      const head = icon.length > 0 && text.length > 0 ? `${icon} ${text}` : icon + text;
      return quoteChunk(node, indent, head);
    }
    case "code":
      return codeChunk(payload, indent);
    case "divider":
      return { text: `${indent}---`, listItem: false };
    case "equation": {
      const expression = typeof payload.expression === "string" ? payload.expression : "";
      if (expression.length === 0) {
        return null;
      }
      return {
        text: prefixLines(`$$
${expression}
$$`, indent),
        listItem: false
      };
    }
    case "image": {
      const url = fileUrl(payload);
      if (url == null) {
        return null;
      }
      const caption = richTextToPlain(richTextOf(payload, "caption")).trim();
      const alt = caption.length > 0 ? caption : "image";
      return {
        text: `${indent}![${escapeBrackets(alt)}](${mdUrl(url)})`,
        listItem: false
      };
    }
    case "video":
    case "audio":
    case "file":
    case "pdf":
      return attachmentChunk(block.type, payload, indent);
    case "bookmark":
    case "embed":
    case "link_preview": {
      const url = typeof payload.url === "string" ? payload.url : "";
      if (url.length === 0) {
        return null;
      }
      const caption = richTextToPlain(richTextOf(payload, "caption")).trim();
      const label = caption.length > 0 ? caption : url;
      return {
        text: `${indent}[${escapeBrackets(label)}](${mdUrl(url)})`,
        listItem: false
      };
    }
    case "link_to_page": {
      const target = typeof payload.page_id === "string" ? payload.page_id : typeof payload.database_id === "string" ? payload.database_id : null;
      if (target == null) {
        return null;
      }
      return {
        text: `${indent}[Linked page](${notionObjectUrl(target)})`,
        listItem: false
      };
    }
    case "child_page":
    case "child_database": {
      const title = typeof payload.title === "string" ? payload.title : "";
      const icon = block.type === "child_page" ? "\u{1F4C4}" : "\u{1F5C3}\uFE0F";
      const label = title.length > 0 ? title : "Untitled";
      return {
        text: `${indent}${icon} [${escapeBrackets(label)}](${notionObjectUrl(block.id)})`,
        listItem: false
      };
    }
    case "table":
      return tableChunk(node, payload, indent);
    case "table_row":
      return null;
    case "synced_block":
    case "column_list":
    case "column":
    case "template": {
      const inner = renderChildren(node, indent);
      return inner.length > 0 ? { text: inner, listItem: false } : null;
    }
    case "breadcrumb":
    case "table_of_contents":
    case "unsupported":
      return null;
    default:
      return blockWithChildren(
        text.length > 0 ? prefixLines(text, indent) : null,
        node,
        indent
      );
  }
}
function heading(node, indent, marker, text) {
  const head = text.length > 0 ? `${indent}${marker} ${text}` : null;
  return blockWithChildren(head, node, indent);
}
function blockWithChildren(head, node, indent) {
  const parts = [];
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
  return { text: parts.join("\n\n"), listItem: false };
}
function listItem(node, indent, marker, text, childIndentWidth = marker.length) {
  const head = `${indent}${marker}${text}`;
  const childIndent = indent + " ".repeat(childIndentWidth);
  const children = renderChildren(node, childIndent);
  return {
    text: children.length > 0 ? `${head}
${children}` : head,
    listItem: true
  };
}
function quoteChunk(node, indent, head) {
  const parts = [];
  if (head.length > 0) {
    parts.push(head);
  }
  const children = renderChildren(node, "");
  if (children.length > 0) {
    parts.push(children);
  }
  if (parts.length === 0) {
    return null;
  }
  return {
    text: prefixLines(prefixLines(parts.join("\n\n"), "> "), indent),
    listItem: false
  };
}
function codeChunk(payload, indent) {
  const code = richTextToPlain(richTextOf(payload));
  const language = typeof payload.language === "string" && payload.language !== "plain text" ? payload.language : "";
  const fence = code.includes("```") ? "````" : "```";
  const lines = [`${fence}${language}`, ...code.split("\n"), fence];
  const caption = richTextToPlain(richTextOf(payload, "caption")).trim();
  const body = prefixLines(lines.join("\n"), indent);
  if (caption.length === 0) {
    return { text: body, listItem: false };
  }
  return {
    text: `${body}

${prefixLines(caption, indent)}`,
    listItem: false
  };
}
function attachmentChunk(type, payload, indent) {
  const url = fileUrl(payload);
  if (url == null) {
    return null;
  }
  const caption = richTextToPlain(richTextOf(payload, "caption")).trim();
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const label = caption.length > 0 ? caption : name.length > 0 ? name : type;
  return {
    text: `${indent}[${escapeBrackets(label)}](${mdUrl(url)})`,
    listItem: false
  };
}
function tableChunk(node, payload, indent) {
  const rows = node.children.filter((child) => child.block.type === "table_row").map((child) => {
    const cells = blockPayload(child.block).cells;
    if (!Array.isArray(cells)) {
      return [];
    }
    return cells.map(
      (cell) => tableCellText(Array.isArray(cell) ? cell.filter(isRecord) : [])
    );
  });
  if (rows.length === 0) {
    return null;
  }
  const width = Math.max(
    typeof payload.table_width === "number" ? payload.table_width : 0,
    ...rows.map((row) => row.length),
    1
  );
  const pad = (row) => Array.from({ length: width }, (_, index) => row[index] ?? "");
  const hasHeader = payload.has_column_header === true;
  const header = hasHeader ? pad(rows[0]) : Array(width).fill("");
  const body = hasHeader ? rows.slice(1) : rows;
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...body.map((row) => `| ${pad(row).join(" | ")} |`)
  ];
  return { text: prefixLines(lines.join("\n"), indent), listItem: false };
}
function tableCellText(cell) {
  return richTextToMarkdown(cell).replaceAll("\n", " ").replaceAll("|", "\\|").trim();
}
function calloutIcon(payload) {
  const icon = payload.icon;
  if (isRecord(icon) && typeof icon.emoji === "string") {
    return icon.emoji;
  }
  return "\u{1F4A1}";
}
function fileUrl(payload) {
  const external = payload.external;
  if (isRecord(external) && typeof external.url === "string") {
    return external.url;
  }
  const file = payload.file;
  if (isRecord(file) && typeof file.url === "string") {
    return file.url;
  }
  return null;
}
function escapeBrackets(text) {
  return text.replaceAll("[", "\\[").replaceAll("]", "\\]");
}
function mdUrl(url) {
  return url.replaceAll("(", "%28").replaceAll(")", "%29");
}
function prefixLines(text, prefix) {
  if (prefix.length === 0) {
    return text;
  }
  return text.split("\n").map((line) => line.length > 0 ? prefix + line : prefix.trimEnd()).join("\n");
}

// src/notion/properties.ts
function propertiesToMarkdown(properties) {
  const lines = [];
  for (const [name, property] of Object.entries(properties)) {
    if (!isRecord(property) || typeof property.type !== "string" || property.type === "title") {
      continue;
    }
    const rendered = propertyValue(property.type, property[property.type]);
    const value = rendered?.replaceAll(/\s*\n\s*/g, " ").trim() ?? "";
    if (value.length === 0) {
      continue;
    }
    lines.push(`- **${name}:** ${value}`);
  }
  return lines.join("\n");
}
function propertyValue(type, value) {
  switch (type) {
    case "rich_text":
      return richTextToMarkdown(
        Array.isArray(value) ? value.filter(isRecord) : []
      );
    case "number":
      return typeof value === "number" ? String(value) : null;
    case "select":
    case "status":
      return isRecord(value) && typeof value.name === "string" ? value.name : null;
    case "multi_select":
      return joinNames(
        value,
        (item) => typeof item.name === "string" ? item.name : null
      );
    case "people":
      return joinNames(value, personName);
    case "date":
      return dateRange(value);
    case "checkbox":
      return typeof value === "boolean" ? value ? "Yes" : "No" : null;
    case "url":
      return typeof value === "string" && value.length > 0 ? value : null;
    case "email":
    case "phone_number":
      return typeof value === "string" && value.length > 0 ? value : null;
    case "files":
      return joinNames(
        value,
        (item) => typeof item.name === "string" ? item.name : null
      );
    case "relation":
      return joinNames(
        value,
        (item) => typeof item.id === "string" ? `[Related page](${notionObjectUrl(item.id)})` : null
      );
    case "formula":
    case "rollup":
      return computedValue(value);
    case "created_time":
    case "last_edited_time":
      return typeof value === "string" ? value : null;
    case "created_by":
    case "last_edited_by":
      return isRecord(value) ? personName(value) : null;
    case "unique_id": {
      if (!isRecord(value) || typeof value.number !== "number") {
        return null;
      }
      const prefix = typeof value.prefix === "string" ? value.prefix : "";
      return prefix.length > 0 ? `${prefix}-${value.number}` : String(value.number);
    }
    default:
      return null;
  }
}
function computedValue(value) {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  const inner = value[value.type];
  if (typeof inner === "string" && inner.length > 0) {
    return inner;
  }
  if (typeof inner === "number") {
    return String(inner);
  }
  if (typeof inner === "boolean") {
    return inner ? "Yes" : "No";
  }
  if (value.type === "date") {
    return dateRange(inner);
  }
  if (value.type === "array" && Array.isArray(inner)) {
    const parts = inner.filter(isRecord).map(
      (item) => typeof item.type === "string" ? propertyValue(item.type, item[item.type]) : null
    ).filter((part) => part != null && part.length > 0);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return null;
}
function dateRange(value) {
  if (!isRecord(value) || typeof value.start !== "string") {
    return null;
  }
  return typeof value.end === "string" ? `${value.start} \u2192 ${value.end}` : value.start;
}
function personName(person) {
  return typeof person.name === "string" && person.name.length > 0 ? person.name : null;
}
function joinNames(value, render) {
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value.filter(isRecord).map(render).filter((part) => part != null && part.length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

// src/index.ts
var STATE_VERSION = 1;
var DOC_TYPE = "notion:page";
var MAX_CONTENT_BYTES = 8e6;
var TRUNCATION_NOTICE = "\n\n\u2026(content truncated)";
function pageTitle(page) {
  if (isRecord(page.properties)) {
    for (const property of Object.values(page.properties)) {
      if (!isRecord(property) || property.type !== "title") {
        continue;
      }
      const items = property.title;
      if (!Array.isArray(items)) {
        continue;
      }
      const title = items.map(
        (item) => isRecord(item) && typeof item.plain_text === "string" ? item.plain_text : ""
      ).join("").trim();
      if (title.length > 0) {
        return title;
      }
    }
  }
  return "Untitled";
}
function buildPageDoc(page, markdown) {
  const { content, bytes } = clampContent(withProperties(page, markdown));
  const metadata = {
    url: typeof page.url === "string" && page.url.length > 0 ? page.url : notionObjectUrl(page.id)
  };
  if (typeof page.created_time === "string") {
    metadata.created_at = page.created_time;
  }
  const doc = {
    id: page.id,
    title: pageTitle(page),
    content,
    content_format: "markdown",
    doc_type: DOC_TYPE,
    original_file_size: bytes,
    metadata
  };
  if (typeof page.last_edited_time === "string") {
    doc.doc_updated_at = page.last_edited_time;
  }
  const parentId = parentPageId(page);
  if (parentId != null) {
    doc.parent_id = parentId;
  }
  return doc;
}
function withProperties(page, markdown) {
  const properties = isRecord(page.properties) ? propertiesToMarkdown(page.properties) : "";
  if (properties.length === 0) {
    return markdown;
  }
  const section = `## Properties

${properties}`;
  return markdown.length > 0 ? `${section}

${markdown}` : `${section}
`;
}
function parentPageId(page) {
  const parent = page.parent;
  if (isRecord(parent) && parent.type === "page_id" && typeof parent.page_id === "string") {
    return parent.page_id;
  }
  return null;
}
function isGonePage(page) {
  return page.archived === true || page.is_archived === true || page.in_trash === true;
}
function knownPagesFromState(state) {
  if (state?.version !== STATE_VERSION || !isRecord(state.pages)) {
    return {};
  }
  const pages = {};
  for (const [id, lastEdited] of Object.entries(state.pages)) {
    if (typeof lastEdited === "string") {
      pages[id] = lastEdited;
    }
  }
  return pages;
}
function collectDeletes(known, seen) {
  return Object.keys(known).filter((id) => !seen.has(id));
}
function clampContent(text) {
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
  if (/[\uD800-\uDBFF]$/.test(sliced)) {
    sliced = sliced.slice(0, -1);
  }
  const content = sliced + TRUNCATION_NOTICE;
  return { content, bytes: encoder.encode(content).length };
}
var NotionConnector = class extends Connector {
  /** Split out so tests can inject a client with a stubbed fetch. */
  createClient(token) {
    return new NotionClient(token, this.signal);
  }
  async *poll() {
    const token = (this.config.personal_access_token ?? "").trim();
    if (token.length === 0) {
      throw new Error(
        "Notion Personal Access Token is required. Create an internal integration at https://www.notion.so/my-integrations and set its secret in the connector settings."
      );
    }
    const client = this.createClient(token);
    const known = knownPagesFromState(this.lastState);
    const merged = { ...known };
    const seen = /* @__PURE__ */ new Set();
    for await (const pages2 of client.searchPages()) {
      const updates = [];
      for (const page of pages2) {
        if (isGonePage(page)) {
          continue;
        }
        seen.add(page.id);
        const lastEdited = typeof page.last_edited_time === "string" ? page.last_edited_time : "";
        if (lastEdited.length > 0 && known[page.id] === lastEdited) {
          continue;
        }
        let markdown;
        try {
          markdown = blocksToMarkdown(await client.fetchBlockTree(page.id));
        } catch (error) {
          if (isObjectNotFound(error)) {
            seen.delete(page.id);
            continue;
          }
          throw error;
        }
        updates.push(upsert(buildPageDoc(page, markdown)));
        merged[page.id] = lastEdited;
      }
      yield {
        updates,
        state: { version: STATE_VERSION, pages: { ...merged } }
      };
    }
    const deletedIds = collectDeletes(known, seen);
    const pages = {};
    for (const id of seen) {
      const lastEdited = merged[id];
      if (lastEdited != null) {
        pages[id] = lastEdited;
      }
    }
    yield {
      updates: deletedIds.map((id) => del(id)),
      state: { version: STATE_VERSION, pages }
    };
  }
};
export {
  STATE_VERSION,
  buildPageDoc,
  collectDeletes,
  NotionConnector as default,
  isGonePage,
  knownPagesFromState,
  pageTitle
};
//# sourceMappingURL=main.js.map
