---
title: Session Logs
description: "The on-disk session log format: file layout, entry types, persistence transforms, and the load path."
coverage: A
---

Every interactive omp session is persisted as a session log: one JSONL (JSON Lines) file that is append-only in normal operation. The file opens with a fixed-width title slot line, then a session header line, then one JSON object per line — each object a session entry. Entries are linked into a tree by `(id, parentId)` rather than a flat sequence, which is what makes rewinding, branching, and forking inside a single file possible. Logs live under `~/.omp/agent/sessions/`, in one directory per working directory:

```text
~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
```

The user-facing workflows built on these files — resume, continue, fork, branch, export, share — are documented in [Sessions](/oh-my-pi/features/sessions/). This page is about the on-disk format itself: how files are named and laid out, what each entry type records, what happens to content between memory and disk, and how a file is loaded back.

## File naming and directory layout

Session directories under `~/.omp/agent/sessions/` are named per working directory. The cwd is classified by canonical location into one of three encodings:

| cwd location | encoded directory name |
| --- | --- |
| Inside the home directory | `-<relative-path>`, with `/`, `\`, `:` replaced by `-` (e.g. `~/work/proj` → `-work-proj`) |
| Inside the tmp directory | `-tmp-<relative-path>` (e.g. `/tmp/x` → `-tmp-x`) |
| Anywhere else | Legacy absolute form: `--` followed by the absolute path with the leading slash stripped and `/`, `\`, `:` replaced by `-` |

Session files are named `<timestamp>_<sessionId>.jsonl`: the timestamp is an ISO-8601 string with `:` and `.` replaced by `-` (so it sorts correctly), and the session id is a UUIDv7.

Two one-time, best-effort migrations run when a session directory is computed:

- Legacy home directories of the form `--<home-encoded>-*--` are renamed to the current `-<relative>` form.
- Directories from the reverted 17.2.5–17.2.8 hashed scheme (`<scope>-<readable>-<sha256hex>`) are renamed back to legacy absolute names.

Each session file has a sibling artifacts directory: the file path minus `.jsonl` (e.g. `<timestamp>_<id>.jsonl` → `<timestamp>_<id>/`). Persisted subagent sessions live inside the parent's artifacts directory as `<parent-artifacts>/<agentId>.jsonl`.

A session file is not created eagerly: nothing is written until the first assistant message (or a forced write), so sessions that never produce a response leave no file.

## Physical layout

A session file has three layers, in order:

1. **Title slot** — one fixed-width line, exactly 256 UTF-8 bytes including the trailing newline. Not JSON.
2. **Session header** — one JSON line describing the session.
3. **Entries** — one JSON line per session entry, appended over time.

A file therefore looks like this (values elided; the slot line is padded to its fixed width):

```text
{ "type": "title", "v": 1, "title": "<session title>", "updatedAt": "<iso>", "pad": "      ..." }
{ "type": "session", "version": 3, "id": "<uuidv7>", "timestamp": "<iso>", "cwd": "<abs path>" }
{ "type": "message", "id": "<8-hex>", "parentId": null, "timestamp": "<iso>", "message": { "role": "user", "content": "..." } }
{ "type": "message", "id": "<8-hex>", "parentId": "<8-hex>", "timestamp": "<iso>", "message": { "role": "assistant", "content": "..." } }
{ "type": "compaction", "id": "<8-hex>", "parentId": "<8-hex>", "timestamp": "<iso>", "summary": "...", "firstKeptEntryId": "<8-hex>", "tokensBefore": 12345 }
```

### Title slot

The first line is `{ "type": "title", "v": 1, "title", "source"?, "updatedAt", "pad" }`, serialized to exactly 256 UTF-8 bytes including the trailing newline. The title is truncated to the longest codepoint prefix that fits in the slot and the remainder is padded with spaces. A first line that is not a `type: "title", v: 1` slot marks a legacy pre-slot file.

The slot is updated in place: on a title change the manager appends a `title_change` entry and rewrites the first 256 bytes of the file at offset 0 in a single disk task. On load, the slot overrides the header's `title` / `titleSource`.

### Session header

The header is the second line of the file. A fresh header is written when a session starts; a forked session writes a fresh header too.

| Field | Meaning |
| --- | --- |
| `type` | `"session"` |
| `version` | Current session version (`3`); v1 headers omit it |
| `id` | Session UUIDv7 |
| `title?` / `titleSource?` | Auto-generated title from the first message; source is `"auto"` or `"user"` |
| `timestamp` | ISO string, written at session start |
| `cwd` | Working directory; `additionalDirectories?` lists extra roots for multi-root sessions |
| `parentSession?` | Parent session id for forks and branches |
| `previousSessionFiles?` | Prior absolute JSONL locations, appended on each successful move of the session file |
| `providerPromptCacheKey?` | Prompt-cache identity inherited by exact-route full forks |

### Entries

Every entry carries the base fields `type`, `id`, `parentId` (string or `null`), and `timestamp`. Entry ids are 8-hex-character random values; the file's current leaf is the `parentId` of the next entry.

## Entry types

| type | Fields beyond the base | Appended by |
| --- | --- | --- |
| `message` | `message` (an agent message: role, content, usage, …) | Message persistence at each turn |
| `thinking_level_change` | `thinkingLevel?`, `configured?` | Thinking-level changes |
| `model_change` | `model` (`provider/modelId`), `role?`, `resolvedModelIsFallback?` | Model switches (role `"fallback"` marks an ephemeral fallback) |
| `service_tier_change` | `serviceTier` | Service-tier changes |
| `compaction` | `summary`, `shortSummary?`, `firstKeptEntryId`, `tokensBefore`, `details?`, `preserveData?`, `fromExtension?`, `warning?` | Session compaction |
| `branch_summary` | `fromId`, `summary`, `details?`, `fromExtension?` | Branch creation from a summarized path |
| `reset_boundary` | none (pure marker) | `/clear`; marks an emission start point on load |
| `custom` | `customType`, `data?` | Extension/foreign entries; **never** included in LLM context (e.g. `foreign_session_import` on session import) |
| `custom_message` | `customType`, `content` (string or content blocks), `details?`, `display`, `attribution?` | Extension entries that **are** included in LLM context |
| `label` | `targetId`, `label` (string or `undefined`) | Label changes on an entry |
| `title_change` | `title`, `previousTitle?`, `source`, `trigger?` | Session renames (also rewrites the title slot) |
| `ttsr_injection` | `injectedRules: string[]` | TTSR rule injections |
| `session_init` | `systemPrompt`, `task`, `tools`, `agent?`, `modelRole?`, `resolvedModel?`, `readOnly?`, `outputSchema?`, `outputSchemaMode?`, `restrictToolNames?`, `spawns?`, `readSummarize?` | Session/agent initialization (incl. subagents) |
| `mode_change` | `mode`, `data?` | Mode switches |
| `credential_pin` | `provider`, `hash` (SHA-256 of account + scope) | Credential pins |

## Persistence transforms

Between an in-memory message and the bytes on disk, each line passes through the transforms below (applied in one synchronous tick per line, plus JSON serialization that renders BigInt values as strings). Secret obfuscation happens earlier, at the provider boundary, before the line is ever built — see the last row.

| Transform | What happens | Notes |
| --- | --- | --- |
| Large-content truncation | Any string field longer than 500,000 characters is cut to fit and suffixed with `\n\n[Session persistence truncated large content]` | Truncation is surrogate-pair-safe; when `content` is truncated, a sibling `lineCount` is recomputed. The transform runs in one synchronous tick, so a crash right after persist cannot lose the entry |
| Signed/encrypted verbatim | Signed and encrypted blocks are never truncated: `thinking` + `thinkingSignature`, `text` + `textSignature`, `toolCall` + `thoughtSignature`, `redactedThinking.data`, `reasoning.encrypted_content`, and whole `anthropicServerTool` web-search-history blocks persist unchanged | `jsonlEvents` keys are dropped from persisted entries |
| Image externalization | Image payloads of 1024 or more base64 characters — `content`-keyed image blocks, `images` arrays, `image_generation_call.result`, and `image_url` data URLs — are replaced with `blob:sha256:<64-hex>` references | Canonical storage is `~/.omp/agent/blobs/<sha256-hex>` with an optional typed display sidecar `<hash>.<ext>`; hashes are over the raw binary, so identical images dedupe across sessions; refs are re-inlined on load |
| Reasoning-signature stripping | `thinkingSignature` is removed from an assistant `thinking` block when the identical reasoning item (matched on `encrypted_content` or `id`) already appears verbatim in that message's OpenAI Responses `providerPayload.items` | Avoids storing encrypted reasoning twice; the in-memory entry is untouched |
| Secret obfuscation | Secrets are replaced with `$$HASH$$` placeholder tokens before the reply is persisted | Applied in the provider boundary on the outbound context; the assistant's reply echoes the placeholders, so the session file contains tokens, not secrets |

### Secret placeholders

Obfuscated tokens follow the grammar `$$[FRIENDLY_][BASE][:hint]$$` — an optional uppercase-friendly prefix, a 12-character base36 keyed hash of the secret, and an optional single-character hint (`:U`, `:L`, `:C`, `:M`). The key lives at `$XDG_STATE_HOME/omp/secret-placeholder.key` or `~/.omp/agent/secret-placeholder.key`. Deobfuscation on load only walks assistant content and LLM-written branch/compaction summaries; user, developer, and tool-result content persists literally and is never deobfuscated.

## Load / resume flow

Loading a session file is the inverse of writing it:

1. **Read the title slot** — the first 256 bytes are peeled off and folded over the header's `title` / `titleSource` (a legacy pre-slot file simply has none).
2. **Parse entries** — files of 8 MiB or more are streamed: chunked byte-buffered JSONL parsing with the title slot peeled, malformed lines skipped, and macrotask yields between chunks. Smaller files parse in one shot. A missing file loads as empty, and the header is validated (`type === "session"` plus a string `id`).
3. **Migrate to the current version** — see [Versioning and migrations](#versioning-and-migrations); migration marks the file for a full rewrite.
4. **Re-inline blobs** — `blob:sha256:` references are resolved back to inline content from `~/.omp/agent/blobs`.
5. **Adopt the header cwd** — the recorded working directory is reused if it still exists.
6. **Rebuild the context** — a root→leaf walk of the entry tree reconstructs the agent messages. Compaction and branch summaries fold into the history, `reset_boundary` entries mark where emission starts, dangling tool calls are stripped (unless explicitly kept), and error/abort assistant turns are dropped from replay context. Transcript vs. LLM-context modes control what the walk includes.
7. **Deobfuscate** — `$$HASH$$` tokens in assistant content and LLM-written summaries are replaced from the placeholder key (tool-call arguments deobfuscated recursively); everything else stays literal.

Incremental appends use an append writer on the hot path. Cold or divergent states trigger an atomic full rewrite (temp file + rename; an `EPERM` on rename falls back to a `.bak` backup), so a crash mid-persist cannot leave a half-written entry.

## Auxiliary files

Each session directory may also contain:

- **`draft.txt`** — the in-progress draft message, written and consumed by draft save/consume.
- **`.draft-only-session`** — marker written when a draft materializes a metadata-only session. On close, if only metadata entries remain (`model_change`, `thinking_level_change`, `service_tier_change`, `mode_change`, `credential_pin`), the session file and its artifacts are deleted.
- **Terminal breadcrumbs** — one plain-text file per terminal under `~/.omp/agent/terminal-sessions/<terminalId>`, containing the cwd, the session file path, and an optional `fresh` line (recorded at a lazy `/new` boundary). `--continue` reads the breadcrumb to reopen the terminal's last session; subagent breadcrumbs resolve up to the interactive parent session.

## Versioning and migrations

The current session version is `3` (`CURRENT_SESSION_VERSION`). Migration reads `header.version ?? 1` (v1 headers carry no version field), mutates entries in place, and forces a full rewrite when anything changed:

| From | Change |
| --- | --- |
| v1 → v2 | Stamps `id` / `parentId` chains onto entries (linear parent); converts compaction `firstKeptEntryIndex` to `firstKeptEntryId` |
| v2 → v3 | Renames the message role `hookMessage` → `custom` |

## Retention and garbage collection

Cold sessions are archived and blobs are garbage-collected. Settings (all under the `gc.*` keys):

| Setting | Default | Effect |
| --- | --- | --- |
| `gc.archive` | `true` | Archive cold sessions (enables the archive pass) |
| `gc.coldArchiveAfterDays` | `30` | Sessions inactive longer than this are archived |
| `gc.retainNewestGlobal` | `20` | Keep the newest N sessions overall |
| `gc.retainNewestPerCwd` | `10` | Keep the newest N sessions per working directory |

Archived session files are moved to `~/.omp/agent/archive/sessions/` and compressed to `.jsonl.gz`. Blob GC removes unreferenced blobs from `~/.omp/agent/blobs/` with a 5-minute write grace — sessions modified within the last five minutes are skipped — and blobs referenced by archived sessions are kept.

## Related

- [Sessions](/oh-my-pi/features/sessions/)
- [Data Directory](/oh-my-pi/reference/data-directory/)
- [SDK](/oh-my-pi/extending/sdk/)
