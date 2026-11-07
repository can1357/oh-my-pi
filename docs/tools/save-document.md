# save_document

> Import a document into the Dakera long-term memory: the server chunks it, embeds the chunks and stamps their provenance.

## Source

- Entry: `packages/coding-agent/src/tools/memory-save-document.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/save-document.md`
- Dakera collaborators:
   - `packages/coding-agent/src/dakera/ingest.ts` — source identity (`documentId` derivation, media-type inference helpers).
   - `packages/coding-agent/src/dakera/client.ts` — `importDocument(...)` (`POST /v1/memory/documents`), `documentJob(...)`.
   - `packages/coding-agent/src/dakera/state.ts` — `ingestDocument(...)` and the auto-ingest hook on `tool_execution_end`.

## Registration / Visibility

- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`.
- Registered only for `memory.backend = "dakera"` with a configured API URL (`isDakeraConfigured(loadDakeraConfig(...))`).
- Requires server engine ≥ 0.12.3 with `documents` enabled (`GET /v1/capabilities`); older servers answer `404`, feature-disabled ones `501`.

## Inputs

| Field         | Type                                 | Required | Description                                                                                       |
| ------------- | ------------------------------------ | -------: | ------------------------------------------------------------------------------------------------- |
| `path`        | `string`                             |       No | Local file to read and import (exactly one source required).                                       |
| `url`         | `string`                             |       No | Web page to fetch and import (exactly one source required).                                        |
| `text`        | `string`                             |       No | Literal content to import (exactly one source required).                                           |
| `title`       | `string`                             |       No | Document title; defaults to the path or URL.                                                       |
| `media_type`  | `'text/plain' \| 'text/markdown' \| 'text/html'` | No | Content format; inferred from the source extension (then an HTML sniff for fetched pages) when omitted. |
| `document_id` | `string`                             |       No | Stable id: re-saving the same id replaces the document in place; omitted → server content-hash id. |

## Outputs

- `content[0].text = "Document imported as <document_id> (<title>)."`
- `details = { documentId, jobId }` — the import runs as a server-side job (chunking + embedding); progress via `dakera/documentJob` (`chunks_stored n/total`).

## Flow

1. Exactly one of `path` / `url` / `text` is read; an empty body is rejected.
2. `DakeraSessionState.ingestDocument(...)` → `DakeraApi.importDocument(...)` POSTs `/v1/memory/documents` with `agent_id`, `content`, `media_type`, `title`, `document_id`.
3. The server chunks the document (default `structure` strategy: headings → paragraphs → sentences → words; chunk budget 400 tokens, overlap 50), embeds each chunk and stamps `metadata._dakera_document` plus the `document:<id>` tag — the same provenance the recall renderer shows and the block-mode doc index summarizes.
4. Auto-ingest variant: successful results of whitelisted tools (`dakera.ingestToolResults`, default: context7 `query-docs`, GitHub `get_file_contents`, `searxng_web_url_read`, `fetch`, deepwiki `read_wiki_contents`) are imported the same way with a `documentId` derived from the source identity (URL / owner+repo+path / library+topic), so a refetch replaces the stored document. Results under 200 characters are skipped as snippets.
