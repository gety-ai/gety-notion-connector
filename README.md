# Gety Notion Connector

A Gety custom connector that indexes Notion pages shared with your Notion
integration and converts them to Markdown.

Every page the integration can see (via the Notion search API) becomes one Gety
document: the page title becomes the document title, the page blocks are
rendered as Markdown content, and the document links back to the page in Notion.
Polls are incremental — unchanged pages are skipped, and pages that disappear
from Notion are deleted from the index.

## Setup

The connector needs a Notion API token. Notion offers two kinds; both work here
— paste either one into the connector's **Personal Access Token** setting.

### Option A: Internal connection token (recommended for long-running sync)

Does not expire, and you control exactly which pages get indexed.

1. Open the Notion Developer portal at <https://www.notion.so/developers> and
   create a new internal connection for your workspace.
2. Open the connection's **Configuration** tab and copy its token.
3. In Notion, grant the connection access to the content you want indexed: open
   a page → `...` menu → **Add connections** → select your connection. Child
   pages inherit access, so connecting a few top-level pages is usually enough.

Only read access is needed; do not grant write capabilities you don't use.

### Option B: Personal access token (quickest)

Acts as _you_: it can read everything your account can read, with no per-page
sharing step — but it **expires** (7 days to 1 year), and the connector stops
syncing when it does.

1. Go to <https://www.notion.so/developers/tokens>.
2. Click **New personal access token**.
3. Name it, pick the workspace, choose an expiration, and enable the Notion API
   capability (read access is all this connector needs).
4. Click **Create token** and copy the value immediately — it is shown once.

If you use a PAT, set a calendar reminder before it expires and rotate the token
in the connector settings.

### Install

Install this connector in Gety and paste the token into the required **Personal
Access Token** setting.

## Files

- `manifest.json` declares the connector metadata, the required
  `personal_access_token` config field, and uses `dist/main.js` as the Gety
  runtime entry.
- `src/index.ts` contains the connector: incremental poll loop, document
  mapping, and delete detection.
- `src/notion/api.ts` is a minimal Notion API client (search + block children)
  with pagination, proactive request throttling, rate-limit retries, and abort
  support.
- `src/notion/markdown.ts` renders Notion block trees as Markdown.
- `src/notion/properties.ts` renders database-page properties (status, tags,
  dates, people, …) as a Markdown list that is prepended to the content.
- `dist/main.js` is the committed build output loaded by Gety.
- `dev/gety-connector-sdk/mod.ts` is a local development shim so `deno check`
  and the build script do not require the npm SDK to be installed.
- `src/gen/manifest.d.ts` is generated from `manifest.json` by
  `deno task generate`, `deno task check`, or `deno task build`.

## Build

```bash
deno task verify
deno task build
```

The build keeps `@gety-ai/connector-sdk` external. Gety supplies the real SDK at
runtime through its import map.

`deno task verify` formats code, applies safe lint fixes, runs type checking,
runs tests, then builds. `deno task build` only regenerates `dist/main.js` and
`dist/main.js.map` for fast local iteration.

## Test

```bash
deno task test
deno task verify
```

Unit tests use Deno's built-in test runner and stub the Notion API; they do not
require network access or a real token.

## Live Runner

```bash
cp .env.example .env   # then fill in your token
deno task runner -- --reset-state
```

`dev/runner.ts` is a generic local runner for the Gety connector runtime
contract: it reads `manifest.json`, imports the manifest `entry` (`dist/main.js`
by default), builds config values from `.env`, injects `config`, `lastState`,
and `signal`, then runs `onLoad()` and `poll()`. Each poll cycle creates a fresh
connector instance, matching Gety's one-shot Deno runner lifecycle.

Config environment variables are derived from manifest field IDs: the required
`personal_access_token` field is read from `GETY_CONFIG_PERSONAL_ACCESS_TOKEN`
(or `PERSONAL_ACCESS_TOKEN`). The runner fails fast if it is not set.

Runner output is written outside git:

```text
dev/runs/<timestamp>/
  summary.json
  state.before.json
  state.after.json
  updates.json
  deletes.json
  docs/
    0001-<doc_type>__<doc_id>.md
    0001-<doc_type>__<doc_id>.json
```

The persistent runner state lives at `dev/.runner/state.json`, so repeated runs
exercise incremental sync (the second run should skip unchanged pages). Use
`--reset-state` to start from an empty state. Optional flags:

```bash
deno task runner -- --polls 3 --interval 60
deno task runner -- --state dev/.runner/notion-state.json --out-dir dev/runs
```

## Install In Gety

1. Open Gety's Custom Connectors settings page.
2. Install from local folder and select this repository.
3. Paste your Notion integration secret into **Personal Access Token**.
4. Wait for the first poll to finish, then search for one of your Notion page
   titles.

After changing `src/index.ts`, run `deno task build`, then use Restart in Gety
to load the new `dist/main.js`. Changes to `manifest.json` require uninstalling
and reinstalling the connector.

## Behavior Notes

- Only pages are indexed (`filter.property: "object", value: "page"`), which
  includes database rows; databases themselves are not emitted as documents.
- Database-page properties are rendered into the document content under a
  `## Properties` heading, so statuses, tags, owners, and dates are searchable.
- Child pages appear as links in their parent's Markdown and are indexed as
  their own documents. Pages whose parent is another page also carry `parent_id`
  for hierarchy.
- Images and file attachments are rendered as Markdown links. Notion-hosted file
  URLs are time-limited, so they may expire in previews; the page link always
  works.
- A poll enumerates every visible page (cheap search calls) but only fetches
  block content for pages whose `last_edited_time` changed.
- Deletes are detected by diffing a full enumeration against the previous one.
  Notion's search API is eventually consistent, so a page that briefly drops out
  of search results may be deleted and re-indexed on the next poll.
- Notion rate limits (~3 requests/second) are respected proactively (requests
  are spaced ~350 ms apart) and defensively (`Retry-After` is honored on 429
  responses); very large first syncs simply take a while.
- The connector speaks Notion API version `2026-03-11` and understands both the
  old `archived` and the new `is_archived` page flags.
