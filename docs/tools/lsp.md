# lsp

> Query language servers for diagnostics, navigation, symbols, renames, code actions, capabilities, and raw requests.

## Source
- Entry: `packages/coding-agent/src/lsp/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/lsp.md`
- Key collaborators:
  - `packages/coding-agent/src/lsp/client.ts` — client process lifecycle and JSON-RPC
  - `packages/coding-agent/src/lsp/config.ts` — config loading, auto-detect, server selection
  - `packages/coding-agent/src/lsp/lspmux.ts` — optional `lspmux` command wrapping
  - `packages/coding-agent/src/lsp/mux/daemon.ts` — broker-shared LSP transport and private-process fallback
  - `packages/coding-agent/src/lsp/edits.ts` — apply `WorkspaceEdit` and text edits
  - `packages/coding-agent/src/lsp/utils.ts` — URI conversion, symbol resolution, formatting, glob expansion
  - `packages/coding-agent/src/lsp/types.ts` — tool schema and protocol types
  - `packages/coding-agent/src/lsp/clients/index.ts` — custom linter client cache/factory
  - `packages/coding-agent/src/lsp/clients/lsp-linter-client.ts` — LSP-backed linter adapter
  - `packages/coding-agent/src/lsp/clients/biome-client.ts` — Biome CLI diagnostics/formatting adapter
  - `packages/coding-agent/src/lsp/clients/swiftlint-client.ts` — SwiftLint CLI diagnostics adapter
  - `packages/coding-agent/src/tools/index.ts` — tool registration and `lsp.enabled` gating
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — timeout defaults and clamping
  - `packages/coding-agent/src/lsp/defaults.json` — built-in server definitions for auto-detect

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string enum | Yes | One of `diagnostics`, `definition`, `references`, `hover`, `symbols`, `rename`, `rename_file`, `code_actions`, `type_definition`, `implementation`, `status`, `reload`, `capabilities`, `request`. |
| `file` | string | No | File path; for `diagnostics` also a glob; for workspace forms use `"*"`; for `rename_file` this is the source path. |
| `line` | number | No | 1-indexed line number for position-based actions. Defaults to `1` on the single-file action path. |
| `symbol` | string | No | Substring used to resolve the column on `line`. Supports `name#N` occurrence selectors; `N` is 1-indexed and defaults to `1`. Required when `line` is given for `definition`/`references`/`rename` against project-aware servers. |
| `query` | string | No | Workspace symbol query, code-action selector/filter, or LSP method name for `action=request`. |
| `new_name` | string | No | Required for `rename` and `rename_file`. |
| `apply` | boolean | No | For `rename`/`rename_file`, apply unless explicitly `false`. For `code_actions`, list unless explicitly `true`. |
| `timeout` | number | No | Seconds, default `20`; `clampTimeout("lsp", ...)` applies the positive `tools.maxTimeout` cap first, then the tool's `5..300` range (so the 5-second floor still wins over a lower global cap). |
| `payload` | string | No | JSON string for `action=request`; overrides auto-built params. |

## Outputs
- Single-shot `AgentToolResult`; `content` is always one text block: `[{ type: "text", text: string }]`.
- `details` is `LspToolDetails`: `action`, `success`, optional `serverName`, optional original `request`.
- Empty navigation/symbol lookups such as `No definition found` are additionally marked `useless: true` so compaction may elide them; a clean diagnostics result is retained as verification evidence.
- No streaming updates, artifact URIs, or background jobs. The inline TUI renderer merges call and result, adds action-aware formatting, and supports collapsed/expanded views.
- The tool is discoverable rather than eagerly loaded. Read-only actions (`diagnostics`, navigation, hover, symbols, `status`, `capabilities`) request read approval; `rename`, `rename_file`, `code_actions`, `reload`, and `request` request write approval regardless of `apply`.
- Many validation failures are returned as ordinary text results with `details.success: false`; aborts throw `ToolAbortError` instead.

## Flow
1. `packages/coding-agent/src/tools/index.ts` registers `lsp: LspTool.createIf`. The tool is present only when both `session.enableLsp !== false` and `lsp.enabled` (default `true`) allow it. A session with `lspReadOnly` rejects every action outside `LSP_READONLY_ACTIONS`; restricted sessions default both to LSP disabled and read-only if it is explicitly re-enabled.
2. `LspTool.execute()` in `packages/coding-agent/src/lsp/index.ts` clamps `timeout` with `clampTimeout("lsp", ...)`, including the optional global `tools.maxTimeout` ceiling, builds an `AbortSignal.timeout(...)`, and combines it with the caller signal.
3. `getConfig()` loads and caches `LspConfig` per cwd, applies idle-timeout config via `setIdleTimeout()`, and reuses the cached config on later calls. Workspace `reload` is the explicit exception: it clears and rebuilds that cwd's config cache before reloading the newly selected servers.
4. Config loading in `packages/coding-agent/src/lsp/config.ts` merges `defaults.json` with JSON/YAML overrides from project, project config dirs, user config dirs, plugin roots/marketplace metadata, and home; if there are no overrides it auto-detects servers from root markers plus executable discovery. See [LSP configuration](../lsp-config.md) for filenames, precedence, and server fields.
5. Server routing uses `getServersForFile()` / `getServerForFile()` from `config.ts`: extension or basename match, then sort primary servers before linters. `index.ts` further filters custom linter clients out of navigation/refactor paths with `getLspServersForFile()` / `getLspServerForFile()`.
6. `getOrCreateClient()` caches one client per `command:cwd`. With `lsp.shared` (default `true` in SDK sessions), it first asks the broker-managed project mux for a shared transport; failure falls back to a private `ptree.spawn()`. An external `lspmux` wrapper takes precedence over broker sharing. The client then starts its message reader, sends `initialize`, stores capabilities, and sends `initialized`.
7. The message reader in `client.ts` parses LSP frames, resolves pending requests, caches `publishDiagnostics`, tracks `$/progress` tokens for project-load completion, answers `workspace/configuration`, and applies `workspace/applyEdit` requests through `applyWorkspaceEdit()`.
8. File-scoped actions call `ensureFileOpen()` before requests. Column resolution uses `resolveSymbolColumn()` from `utils.ts`: read the target file, pick first non-whitespace when `symbol` is omitted, otherwise find the exact or case-insensitive match on the target line and honor `#N` occurrence selectors.
9. Actions dispatch in `LspTool.execute()` through dedicated branches: workspace-only branches (`status`, some `diagnostics`, workspace `symbols`, workspace `reload`, `capabilities`, `request`) run before the single-file switch; all other single-file actions share one client lookup and `switch(action)`.
10. Requests go through `sendRequest()` in `client.ts`, which allocates an incrementing JSON-RPC id, installs abort and timeout handling, sends `$/cancelRequest` on abort, and rejects on timeout or process exit.
11. Actions that return edits either preview with `formatWorkspaceEdit()` or apply with `applyWorkspaceEdit()` from `edits.ts`; `rename_file` also performs the filesystem rename and then sends `workspace/didRenameFiles`.
12. Non-abort failures inside the single-file action block are converted to `LSP error: ...`; many precondition failures return explicit text without throwing.

## Modes / Variants
### Routing and workspace scope
- `file: "*"` is only special for `diagnostics`, `symbols`, and `reload`.
- `status` ignores `file`.
- `capabilities` with omitted `file` or `"*"` inspects all non-custom LSP servers; with a concrete file it scopes to matching non-custom servers.
- `request` with omitted `file` or `"*"` chooses the first available non-custom LSP server; with a concrete file it chooses that file's primary non-linter server.
- `rename_file` sends `workspace/willRenameFiles` and `workspace/didRenameFiles` to every non-custom LSP server from `getLspServers(config)` whose `fileTypes` match the source, destination, or any enumerated rename pair — not just one file-scoped server.
- Diagnostics are the only tool action that queries both normal LSP servers and custom linter clients (`BiomeClient`, `SwiftLintClient`, or `LspLinterClient`).

### `diagnostics`
**Inputs**
- Required: `file`, unless using workspace mode with `file: "*"`.
- Optional: `timeout`.

**Execution**
- `file: "*"`: `runWorkspaceDiagnostics()` selects the first matching project type in Rust → TypeScript → Go workspace/module → Python order. It runs Rust `cargo check --message-format=short`, TypeScript `npx tsc --noEmit`, Python `pyright`, or Go `go build`: `go.mod` uses `./...`, while `go.work` first reads `go work edit -json` and builds every `Use[].DiskPath/...` pattern (falling back to `./...`). Unknown projects return a supported-marker message without spawning a checker.
- Concrete file or glob: `resolveDiagnosticTargets()` treats non-globs as one target, otherwise expands a `Bun.Glob` up to `MAX_GLOB_DIAGNOSTIC_TARGETS`.
- Per file, every matching server runs: custom clients call `lint(file)`; real LSP servers optionally wait for project load, capture `diagnosticsVersion`, `refreshFile()`, then `waitForDiagnostics()` for fresh `publishDiagnostics` (settles on the latest publish; exact-version match accepted immediately).
- Results are deduplicated by range+message and severity-sorted.

**Output text**
- Single target with no issues: `OK`.
- Single target with issues: `<summary>:\n<grouped diagnostics>`.
- Batch/glob target: one section per file, plus an initial truncation warning when the glob exceeds the file cap.
- Workspace mode: `Workspace diagnostics (<detected description>):\n<command output>`.

### `definition`
**Inputs**
- Required: `file`.
- Optional: `line`, `symbol`, `timeout`.

**Execution**
- Sends `textDocument/definition` with `{ textDocument, position }`.
- Accepts `Location`, `Location[]`, `LocationLink`, or `LocationLink[]`; `normalizeLocationResult()` converts `LocationLink` to `targetSelectionRange ?? targetRange`.
- Requires `symbol` when `line` is given on project-aware servers (the first-non-whitespace-column fallback is disabled for this action).
- Waits for project load before the request.

**Output text**
- `No definition found` or `Found N definition(s):` followed by `file:line:col` and one context line above/below each location.

### `type_definition`
Uses the same location normalization and output shape as `definition`, but sends `textDocument/typeDefinition` and reports `type definition(s)`. Unlike `definition`, the implementation does not require an explicit `symbol` when `line` is supplied; without one it resolves the first non-whitespace column.

### `implementation`
Uses the same location normalization and output shape as `definition`, but sends `textDocument/implementation` and reports `implementation(s)`. Unlike `definition`, the implementation does not require an explicit `symbol` when `line` is supplied; without one it resolves the first non-whitespace column.

### `references`
**Inputs**
- Required: `file`.
- Optional: `line`, `symbol`, `timeout`.

**Execution**
- Sends `textDocument/references` with `includeDeclaration: true`.
- Requires `symbol` when `line` is given on project-aware servers (the first-non-whitespace-column fallback is disabled for this action).
- For project-aware servers, retries up to `REFERENCES_RETRY_COUNT` times when the only hit is the queried declaration; between retries it waits for project load and sleeps `REFERENCES_RETRY_DELAY_MS`.
- First `REFERENCE_CONTEXT_LIMIT` references include surrounding context; the rest are location-only.

**Output text**
- `No references found` or `Found N reference(s):` with contextual entries first, then `... M additional reference(s) shown without context` when truncated.

### `hover`
**Inputs**
- Required: `file`.
- Optional: `line`, `symbol`, `timeout`.

**Execution**
- Sends `textDocument/hover`.
- `extractHoverText()` flattens strings, markup content, marked-string objects, or arrays into plain text.

**Output text**
- `No hover information` or the extracted hover text.

### `symbols`
**Inputs**
- Workspace mode: required `file: "*"`, plus required `query`. Omitting `file` currently returns `Error: file parameter required...` before workspace-symbol dispatch.
- Document mode: required `file`.
- Optional: `timeout`.

**Execution**
- Workspace mode sends `workspace/symbol` to every non-custom LSP server, post-filters matches with `filterWorkspaceSymbols()`, deduplicates with `dedupeWorkspaceSymbols()`, then truncates to `WORKSPACE_SYMBOL_LIMIT`.
- Document mode sends `textDocument/documentSymbol` to the primary server. If the first item has `selectionRange`, it formats hierarchical `DocumentSymbol`s; otherwise it formats flat `SymbolInformation`s.

**Output text**
- Workspace mode: `Found N symbol(s) matching "query":` plus formatted `name @ file:line:col`, with an omission line when over the limit.
- Document mode: `Symbols in <file>:` plus hierarchical or flat symbol lines.

### `rename`
**Inputs**
- Required: `file`, `new_name`.
- Optional: `line`, `symbol`, `apply`, `timeout`.

**Execution**
- Requires `symbol` when `line` is given on project-aware servers, then waits for project load, sends `textDocument/rename`, receives a `WorkspaceEdit`.
- `apply !== false` applies edits immediately with `applyWorkspaceEdit()`.
- `apply === false` renders a preview with `formatWorkspaceEdit()`.

**Output text**
- `Rename returned no edits`, `Applied rename:` plus applied change lines, or `Rename preview:` plus summarized edits.

### `rename_file`
**Inputs**
- Required: `file` source path, `new_name` destination path.
- Optional: `apply`, `timeout`.

**Execution**
- Resolves absolute source and destination, rejects identical paths, missing source, existing destination, empty rename set, or directories with more than `MAX_RENAME_PAIRS` files.
- `enumerateRenamePairs()` returns one `{oldUri,newUri}` pair for a file or walks every regular file in a directory tree.
- Sends `workspace/willRenameFiles` with `{ files: pairs }` to every non-custom LSP server whose `fileTypes` match an affected path; collects returned `WorkspaceEdit`s and server notes.
- Preview mode (`apply === false`) only formats those edits.
- Apply mode coalesces the returned text edits per URI (a project-aware server's edits win on overlap; overlapping edits from other servers are discarded with a note), applies each URI once from a single snapshot, creates the destination parent directory and renames the source path on disk, sends `textDocument/didClose` for every renamed open file, deletes those `openFiles` entries, then sends `workspace/didRenameFiles`.

**Output text**
- Preview: `Rename preview: <file-count label> → <dest>` plus per-server edit summaries and optional server notes.
- Apply: `Renamed <file-count label> → <dest>` plus applied edit summaries, filesystem rename line, and optional server notes.

### `code_actions`
**Inputs**
- Required: `file`.
- Optional: `line`, `symbol`, `query`, `apply`, `timeout`.

**Execution**
- Reads cached diagnostics for the open URI from `client.diagnostics` and sends `textDocument/codeAction` for a zero-width range at the resolved position.
- When `apply !== true`, `query` is passed as `context.only: [query]`; this is a server-side kind filter.
- When `apply === true` and `query` is non-empty, it is a client-side selector: either a zero-based numeric index or a case-insensitive substring of the action title.
- When `apply === true` but `query` is omitted, the current implementation falls through to list mode and does not apply an action.
- Applying a `CodeAction` uses `applyCodeAction()`: optionally `codeAction/resolve`, then `applyWorkspaceEdit(edit)`, then optional `workspace/executeCommand`.
- Applying a bare `Command` only runs `workspace/executeCommand`.

**Output text**
- List mode: `N code action(s):` plus `index: [kind] title` lines.
- Apply mode success: `Applied "title":` plus `Workspace edit:` and/or `Executed command(s):` sections.
- Apply mode miss: `No code action matches "query". Available actions:`.
- Apply mode with no edit/command: `Action "title" has no workspace edit or command to apply`.

### `status`
**Inputs**
- None.

**Execution**
- Reads configured servers from cached `LspConfig` and cross-references `getActiveClients()` so each server is labelled `(configured, not started)` or with its live client status.
- Calls `detectLspmux()` and appends status text when `lspmux` is installed.

**Output text**
- `Language servers: <name (configured, not started) | name (<status>)>` plus an explanatory note line, or `No language servers configured for this project`, optionally followed by `lspmux: active (multiplexing enabled)` or `lspmux: installed but server not running`.

### `reload`
**Inputs**
- Workspace mode: `file: "*"` or omitted `file`.
- Single-file mode: required `file`.
- Optional: `timeout`.

**Execution**
- Workspace mode first invalidates the per-cwd configuration cache, reloads configuration from disk, and then reloads every newly configured non-custom LSP server.
- Single-file mode keeps the cached configuration and reloads the primary server for that file.
- Both modes clear matching recent initialization failures before starting a server. For rust-analyzer servers, `reloadServer()` first tries the `rust-analyzer/reloadWorkspace` request (only rust-analyzer implements it; sending it to other servers such as Roslyn can crash them, so it is gated on the server binary/name). Every server then falls back to a `workspace/didChangeConfiguration` notification carrying the active client's configured settings. If that notification fails, reload tears down the client so the next request cold-starts it. For a shared-mux client, teardown first sends the mux restart notification so the shared server—not only this session's link—is replaced.

**Output text**
- One line per server: `Reloaded <server>`, `Restarted <server>`, or `Failed to reload <server>: ...`.

### `capabilities`
**Inputs**
- Optional: `file`, `timeout`.

**Execution**
- With a concrete `file`, inspects matching non-custom servers for that file.
- With omitted `file` or `"*"`, inspects every non-custom configured server.
- Starts servers as needed and dumps `client.serverCapabilities ?? {}` as pretty JSON.

**Output text**
- Per server: `<server>:` followed by indented `capabilities: { ... }`, or `<server>: failed to start (...)`.

### `request`
**Inputs**
- Required: `query` method name.
- Optional: `file`, `line`, `symbol`, `payload`, `timeout`.

**Execution**
- Chooses one non-custom server: file-scoped primary server, otherwise the first configured non-custom server.
- Param building precedence:
  1. If `payload` is present, parse JSON and use it verbatim.
  2. Else if `file` is concrete and `line` is present, build `{ textDocument: { uri }, position: { line: line - 1, character } }` using `resolveSymbolColumn()`.
  3. Else if `file` is concrete, build `{ textDocument: { uri } }`.
  4. Else use `{}`.
- Opens the file first when `file` is concrete.

**Output text**
- Success: `<server> ← <method>:\n<formatted result>`, where non-string results are `JSON.stringify(..., null, 2)` and nullish values become `null`.
- Failure: `LSP error from <server> on <method>: ...` followed by `  params: <preview>` echoing the request params (truncated to 400 chars).

## Side Effects
- Filesystem
  - Reads config files, target files, and root markers.
  - `rename` and `code_actions` may edit/create/delete/rename files via `applyWorkspaceEdit()`.
  - `rename_file` always renames the source path on disk in apply mode.
  - Server-initiated `workspace/applyEdit` requests also mutate files through `applyWorkspaceEdit()`.
- Network / IPC
  - With `lsp.shared=true` (the default), SDK sessions try a local Unix socket or Windows named pipe to the broker-managed per-project LSP mux. If the mux cannot be reached or started, the client silently falls back to a private subprocess.
  - Private and externally multiplexed servers communicate over local stdio JSON-RPC; the tool itself does not make remote network requests.
- Subprocesses / native bindings
  - Private fallback spawns language servers with `ptree.spawn()`; shared mode asks the broker to maintain one server per project.
  - Workspace diagnostics spawns `cargo`, `npx`, `go`, or `pyright`.
  - `BiomeClient` and `SwiftLintClient` spawn CLI tools.
  - Optional external `lspmux` detection spawns `lspmux status`; supported servers may be wrapped through `lspmux client`.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Caches config per cwd in `configCache`; workspace `reload` invalidates the entry.
  - Caches LSP clients per `command:cwd`, with `pendingRequests`, `diagnostics`, `openFiles`, `serverCapabilities`, and project-load state. The transport may represent a shared mux link rather than an owned process.
  - Caches custom linter clients by `serverName:cwd`.
  - Updates client `lastActivity`; optional idle-timeout cleanup is driven by `setIdleTimeout()`.
- Background work / cancellation
  - Every request has an abortable timeout signal.
  - Aborting an in-flight LSP request sends `$/cancelRequest`.
  - Background message readers persist for each live client until process exit/shutdown.

## Limits & Caps
- Tool timeout clamp: default `20`, min `5`, max `300` seconds — `TOOL_TIMEOUTS.lsp` in `packages/coding-agent/src/tools/tool-timeouts.ts`.
- LSP request default timeout inside `sendRequest()`: `30_000ms` — `DEFAULT_REQUEST_TIMEOUT_MS` in `packages/coding-agent/src/lsp/client.ts`.
- Warmup initialize timeout default: `5_000ms` — `WARMUP_TIMEOUT_MS` in `packages/coding-agent/src/lsp/client.ts`.
- Project-load wait fallback: `15_000ms` — `PROJECT_LOAD_TIMEOUT_MS` in `packages/coding-agent/src/lsp/client.ts`.
- Idle-client sweep interval when enabled: `60_000ms` — `IDLE_CHECK_INTERVAL_MS` in `packages/coding-agent/src/lsp/client.ts`.
- Failed initialization backoff: `3 * 60 * 1000ms` — `INIT_FAILURE_BACKOFF_MS`; a matching single-file or workspace `reload` clears this negative cache so retry is immediate.
- Diagnostic message output cap: first `50` messages — `DIAGNOSTIC_MESSAGE_LIMIT` in `packages/coding-agent/src/lsp/index.ts`.
- Single-file diagnostics wait: `3_000ms` — `SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS`.
- Batch/glob diagnostics wait per file: `400ms` — `BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS`.
- Glob diagnostic target cap: first `20` matches — `MAX_GLOB_DIAGNOSTIC_TARGETS`.
- Workspace symbol cap: first `200` entries — `WORKSPACE_SYMBOL_LIMIT`.
- Reference context cap: first `50` references include source context — `REFERENCE_CONTEXT_LIMIT`.
- References retry count: `2` retries, `250ms` backoff — `REFERENCES_RETRY_COUNT`, `REFERENCES_RETRY_DELAY_MS`.
- Directory rename cap: `1_000` file pairs — `MAX_RENAME_PAIRS`.
- `detectLspmux()` state cache TTL: `5 * 60 * 1000ms`; liveness check timeout: `1_000ms` — `STATE_CACHE_TTL_MS`, `LIVENESS_TIMEOUT_MS` in `packages/coding-agent/src/lsp/lspmux.ts`.
- Workspace diagnostics output cap: first `50` lines from the subprocess.

## Errors
- Missing or invalid inputs are usually returned as text with `details.success: false`, not thrown:
  - missing `file`/`query`/`new_name`
  - invalid JSON in `payload`
  - no matching server
  - invalid `rename_file` source/destination conditions
- `resolveSymbolColumn()` throws explicit errors for missing files, missing symbols, and out-of-bounds `#N` selectors; these surface as `LSP error: ...` or request-specific error text.
- `sendRequest()` rejects on timeout with `LSP request <method> timed out after <ms>ms`.
- Client process exit rejects all pending requests with an exit-code/stderr error assembled in `getOrCreateClient()`.
- Single-file action failures inside the main `try` become `LSP error: <message>`.
- `request` has its own error envelope: `LSP error from <server> on <method>: <message>`.
- Some server failures are intentionally softened:
  - diagnostics continue when one server fails
  - `rename_file` suppresses `workspace/willRenameFiles` “method not found” errors and records other server errors as notes
  - `code_actions` ignores `codeAction/resolve` failures and applies unresolved actions when possible
- Caller aborts are not converted to text: `ToolAbortError` is rethrown. A wall-clock tool timeout without a caller abort instead throws `ToolError`: `LSP <action> timed out after <N>s on <server>. ...`.

## Notes
- `status` reports configured servers from `LspConfig` and labels each one via `getActiveClients()`: `(configured, not started)` means the binary resolves on PATH but no request has spawned it; a live client reports its status.
- `getLspServerForFile()` excludes `createClient` adapters and linter-only servers; navigation/refactor actions never target Biome/SwiftLint custom clients.
- `getServersForFile()` matches both file extensions and exact basenames from `fileTypes`; config can target names like `Dockerfile` if present.
- `symbol` matching is exact first, then case-insensitive, and falls back to the Nth occurrence on the specified line only; it never scans other lines.
- For `definition`, `references`, and `rename` against project-aware servers, omitting `symbol` while passing `line` is rejected with a `ToolError` instead of silently falling back to the first non-whitespace column.
- `code_actions` uses `query` in two different ways: server-side `context.only` filter in list mode, client-side title/index selector when both `apply: true` and a non-empty `query` are present. Despite the model prompt requiring a selector, the implementation currently lists actions rather than applying one when `apply: true` omits `query`.
- `rename` and `rename_file` default to apply. Preview requires `apply: false`.
- `request` with `file: "*"` is treated the same as omitted `file`: it does not build workspace-specific params.
- `reload` does not recreate a client immediately after killing it; the next request triggers reinitialization.
- `workspace/applyEdit` can apply edits initiated by the server outside the direct tool action result path.
- `detectLspmux()` can be disabled with `PI_DISABLE_LSPMUX=1`; only `rust-analyzer` is in `DEFAULT_SUPPORTED_SERVERS`.
- Startup LSP discovery (`discoverStartupLspServers(cwd)` in `sdk.ts`) runs for `enableLsp && options.hasUI`; the background warmup additionally requires `!settings.get("lsp.lazy")`. `lsp.lazy` defaults to `true`, so by default discovered servers are surfaced with status `"available"` (gray dot in the welcome screen) and cold-start through `getOrCreateClient()` on first use (lsp tool call or edit/write on a matching file type). Print/RPC/ACP/script sessions skip discovery and warmup entirely. See `docs/sdk.md` § Startup performance.
- `configCache` is per-process and is not automatically invalidated. Use workspace `reload` (omitted `file` or `file: "*"`) to re-read config, root markers, and plugin configuration; a concrete-file reload only reloads that server and keeps the cached configuration.