# ast_edit

> Preview and apply structural rewrites over source files via native ast-grep.

## Source
- Entry: `packages/coding-agent/src/tools/ast-edit.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ast-edit.md`
- Key collaborators:
  - `crates/pi-natives/src/ast.rs` — native rewrite planning and file mutation
  - `crates/pi-ast/src/language/mod.rs` — language aliases and extension inference used by the native wrapper.
  - `packages/coding-agent/src/tools/path-utils.ts` — path/glob parsing and multi-path resolution
  - `packages/coding-agent/src/tools/resolve.ts` — preview/apply queueing
  - `packages/coding-agent/src/tools/render-utils.ts` — parse-error dedupe and display caps
  - `packages/coding-agent/src/utils/file-display-mode.ts` — hashline vs line-number diff references
  - `packages/hashline/src/format.ts` — stable hashline header formatting for preview anchors
  - `packages/natives/native/index.d.ts` — JS-visible native binding contract

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ops` | `{ pat: string; out: string }[]` | Yes | One or more rewrite rules. `pat` must be non-empty. Duplicate `pat` values fail before native execution. Empty `out` deletes the matched node. |
| `paths` | `string[]` | Yes | One or more files, directories, globs, or path-backed internal URLs. At least one non-empty entry is required. Internal-URL globs are rejected; fetched external URLs are read-only and cannot be rewritten. |

Shared AST pattern grammar and language catalog: see [`ast_grep`](./ast-grep.md#inputs).

- `ast_edit` uses the same `$NAME`, `$_`, `$$$NAME`, and `$$$` metavariable semantics.
- The tool prompt adds rewrite-specific constraints:
  - metavariable names must be uppercase and must stand for whole AST nodes,
  - captures from `pat` are substituted into `out`,
  - each rewrite is a 1:1 structural substitution; one capture cannot expand into multiple sibling nodes unless the grammar itself permits that expansion at that position.

`ast_edit` is enabled by default by `astEdit.enabled`. It is discoverable rather than part of the essential tool set.

## Outputs
- Single-shot preview result from `ast_edit` itself. A non-empty proposal begins with `Staged as a proposal — files NOT modified yet...` and names the resolve/reject device paths.
- Model-facing `content` is one text block showing proposed edits, grouped by file for directory/multi-file runs.
  - Each change renders as two lines. Hashline mode uses `-LINE:before` / `+LINE:after` under a `[PATH#TAG]` header; plain mode uses `-LINE:COLUMN before` / `+LINE:COLUMN after`.
  - Only the first line of each `before`/`after` snippet is shown, truncated to 120 characters in the wrapper.
  - `Limit reached; narrow paths.` and formatted parse issues are appended when applicable.
- If no rewrites match, text is `No replacements made` plus formatted parse issues when present.
- `details` includes aggregate preview metadata:
  - `totalReplacements`, `filesTouched`, `filesSearched`, `applied`, `limitReached`
  - optional `parseErrors`, `parseErrorsTotal`, `scopePath`, `files`, `fileReplacements`, `displayContent`, `searchPath`, `cwd`, `meta`
- The tool always previews first (`applied: false` in the direct result). Actual file writes happen only later through a plain-text `write` to `xd://resolve`; the body is the reason.
- When preview produced replacements, `ast_edit` also queues a pending resolve action. Successful apply returns a separate resolve dispatch result (on the `write` call), not another `ast_edit` result.

## Flow
1. `AstEditTool.execute()` validates each op in `packages/coding-agent/src/tools/ast-edit.ts`:
   - empty `pat` fails,
   - at least one op is required,
   - duplicate `pat` values fail,
   - ops are converted to a `Record<pattern, replacement>`.
2. The wrapper reads `PI_MAX_AST_FILES` via `$envpos(..., 1000)` and uses that as the native `maxFiles` cap for both preview and apply.
3. Path normalization, internal URL handling, missing-path partitioning, and multi-path resolution follow the same `path-utils.ts` flow as `ast_grep`.
4. The scope's `isDirectory` flag (set by a stat in `resolveToolSearchScope`) decides whether to render grouped directory output.
5. `runAstEditOnce(...)` always runs native `astEdit(...)` with `dryRun: true` and `failOnParseError: false` on the first pass.
6. Native `ast_edit` in `crates/pi-natives/src/ast.rs`:
   - normalizes the rewrite map and sorts rules by pattern string,
   - resolves strictness (`smart` by default),
   - collects candidate files from a file or gitignore-aware directory scan,
   - infers a language independently for every candidate file unless `lang` was supplied internally,
   - compiles each rewrite for every discovered language; a rule that cannot parse in one language skips that language's files and reports parse issues,
   - parses each file, skips files with syntax-error trees, collects `replace_by(...)` edits for every match, enforces replacement and file caps, and returns textual before/after slices plus source ranges.
7. The TS wrapper deduplicates and caps parse errors, groups changes by file, and renders preview diff lines.
8. If preview found replacements and `applied` is false, `queueResolveHandler(...)` registers a non-forcing pending resolve invoker. While it is pending the session surfaces a `SoftToolRequirement` (`toolName: "write"` with an `xd://resolve` or `xd://reject` `satisfies` predicate) carrying the resolve reminder; the agent runtime injects the reminder and forces `write` only if the model declines that turn.
9. On a `write xd://resolve` dispatch, the queued callback reruns the same rewrite set with `dryRun: false`, recomputes counts, and returns an error result if the live result no longer matches the preview (`stalePreview`). The current implementation compares replacement totals and per-file counts after the rerun; if the new run has already written different counts, the result is marked error.
10. On a non-stale apply, the callback returns `Applied N replacements in M files.` (in hashline mode followed by fresh `[path#tag]` snapshot headers re-recorded from the post-apply content); on discard (`write xd://reject`), the dispatch returns a discard message without mutating files.

## Modes / Variants
- Single file: preview or apply against one file.
- Directory + optional glob: native scan walks the directory, then filters by compiled glob.
- Multiple explicit paths/globs: wrapper unions them into one synthetic scope or runs per-target native calls when paths only meet at root.
- Internal URL inputs: only supported when the router resolves them to a backing file path.
- Preview mode: always the direct `ast_edit` tool result.
- Apply mode: only reachable through the queued resolve callback (a `write` to `xd://resolve` or `xd://reject`) after a preview.
- Hashline output mode vs plain line/column mode: controlled by `resolveFileDisplayMode()`.

## Side Effects
- Filesystem
  - Preview reads files and scans directories.
  - Apply stages every changed file in memory, verifies the full pass, then writes the staged files; a later compute/overlap failure cannot partially mutate earlier files.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Registers a non-forcing pending resolve invoker through `queueResolveHandler(...)`.
  - Surfaces a `SoftToolRequirement` (with the resolve reminder) while pending; the agent runtime forces `write` only on non-compliance — no steering message and no per-preview forced tool choice.
- User-visible prompts / interactive UI
  - Direct `ast_edit` results are previews.
  - Follow-up apply/discard is exposed through writes to `xd://resolve` and `xd://reject`.
- Background work / cancellation
  - Native preview/apply work runs on a blocking worker via `task::blocking(...)`.
  - Cancellation and optional native timeout are cooperative through `CancelToken::heartbeat()`.

## Limits & Caps
- File cap exposed by the wrapper: `PI_MAX_AST_FILES`, default `1000`, in `packages/coding-agent/src/tools/ast-edit.ts`.
- Native `maxFiles` and `maxReplacements` are both clamped to at least `1` when provided in `crates/pi-natives/src/ast.rs`.
- The wrapper never sets `maxReplacements`; native behavior therefore defaults to effectively unbounded replacements for a run.
- Parse issues are deduplicated and capped at `PARSE_ERRORS_LIMIT = 20` entries via `capParseErrors(...)` in `packages/coding-agent/src/tools/render-utils.ts`; `details.parseErrors` carries the capped list and `details.parseErrorsTotal` the pre-cap deduplicated count.
- Directory scans use `include_hidden: true`, `use_gitignore: true`, and skip `node_modules` unless the glob text explicitly mentions `node_modules` in `crates/pi-natives/src/ast.rs`.
- No separate glob-expansion count cap exists. Candidate count is whatever the resolved path/glob expands to after gitignore filtering, then native `maxFiles` stops mutations after the configured number of touched files.
- Preview text truncates each rendered `before` and `after` first line to 120 characters in `packages/coding-agent/src/tools/ast-edit.ts`.

## Errors
- TS wrapper throws `ToolError` for empty patterns, duplicate rewrite patterns, empty path entries, unsupported internal-URL globs, internal URLs without `sourcePath`, and missing paths.
- Native code returns hard errors for:
  - inability to infer a supported language for a candidate (reported as a parse issue in the wrapper's best-effort mode),
  - unsupported explicit `lang` in internal/native calls,
  - bad glob compilation or unreadable search roots,
  - overlapping computed edits (`Overlapping replacements detected; refine pattern to avoid ambiguous edits`),
  - out-of-bounds edit ranges or non-UTF-8 replacement text,
  - write failures during apply,
  - cancellation or timeout.
- With `failOnParseError: false` (the wrapper always uses this), pattern compile failures and file parse failures become `parseErrors` instead of aborting the whole run.
- If every rewrite pattern fails to compile, native `ast_edit` returns a successful zero-replacement result with `parseErrors` populated.
- Files containing tree-sitter error nodes are skipped for rewriting; they do not get partial edits.
- Apply can fail after a successful preview if the preview becomes stale. The resolve callback compares replacement totals and per-file counts and returns an error result rather than silently reporting success for a mismatched preview.

## Notes
- `ast_edit` does not expose the native `lang`, `strictness`, `selector`, `maxReplacements`, `failOnParseError`, or `timeoutMs` fields to the model. The runtime fixes the call shape to a preview-first, smart-strictness, best-effort parse mode.
- Mixed-language scopes are supported: the native layer infers each candidate's language and compiles each rule per discovered language. A pattern that parses for only some languages rewrites those files and reports parse issues for incompatible languages.
- Idempotency is not enforced syntactically. A rewrite like `foo($A) -> foo($A)` previews zero changes because output equals input; a rewrite that keeps matching its own output may still produce replacements on repeated calls.
- Rewrites are accumulated per file, then applied from the end of the file backward after an overlap check. Independent matches can coexist; overlapping matches abort the run.
- Native rewrite rule order is by pattern-string sort, not by the original `ops` array order, because `normalize_rewrite_map(...)` sorts the `(pattern, rewrite)` pairs.
- Preview/apply parity is validated by totals and per-file counts after the apply rerun, not by a byte-for-byte diff of every replacement payload.