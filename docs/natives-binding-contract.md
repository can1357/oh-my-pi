# Natives Binding Contract (JavaScript/TypeScript Side)

This page defines the public JS/TS boundary between `@oh-my-pi/pi-natives` callers and its N-API addon. The authoritative public root surface is `packages/natives/native/index.d.ts` plus the explicit ESM exports in `native/index.js`; Rust internals not present there are not package API.

## Contract layers

1. `crates/pi-natives/src/**/*.rs` defines `#[napi]` functions, classes, objects, and enums.
2. `bun --cwd=packages/natives run build:bindings` runs napi-rs, installs the host addon and generated `native/index.d.ts`, then runs `gen-enums.ts`.
3. `gen-enums.ts` reads the declarations, rewrites napi-rs `const enum` declarations to runtime-usable declarations, and replaces the marked block in `native/index.js` with explicit class/function exports and literal enum objects.
4. `native/index.js` loads the addon and binds that generated root surface. `DesktopSession` is routed through `desktop-adapter.js` for compatibility with older desktop ABIs; current classes pass through unchanged.

There is no `NativeBindings` declaration-merging lifecycle or `packages/natives/src/<module>` wrapper convention. The loader checks release identity for install/compiled loads (with a narrow pre-sentinel compatibility exception), not every public symbol; a function export the loaded addon omits is `missingNativeExport(name)` — `undefined` on a current addon, and on a stale workspace addon a throwing stub that names the addon and the rebuild command (`bun run build:native`).

## Public entrypoints

`packages/natives/package.json` exports:

| Entry                            | Public values                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@oh-my-pi/pi-natives`           | Generated root classes, functions, and enum objects from `native/index.js` / `index.d.ts`. Importing is eager.                  |
| `@oh-my-pi/pi-natives/desktop`   | `createDesktopSession(options): DesktopSession`; addon load is deferred until invocation.                                       |
| `@oh-my-pi/pi-natives/clipboard` | `copyToClipboard(text)` and `readImageFromClipboard()` plus the `ClipboardImage` type; addon load is deferred until invocation. |

Two additional public subpaths are lazy:

- `@oh-my-pi/pi-natives/path`: `expandWindowsLongPath(path)` and `getWindowsShortPath(path)`; native loading occurs only on Windows, while other platforms return the input unchanged.
- `@oh-my-pi/pi-natives/vcs`: repository discovery/requirements (`git`, `repo`, `repoForDisplay`, `require`, `requireGit`, `gitInfo`, `jj`, `isPureJj`), clone/detach/patch helpers, VCS error predicates, and `watch`. Native-backed calls load and memoize the addon. `repoForDisplay` prefers Jujutsu on equal-root ties; `repo` retains Git-safe discovery precedence.

Do not import unexported `native/*` implementation paths from package consumers.

## Current root surface by owner

| Category                 | Representative public exports                                                                                                                                     | Rust owner                                                            | Call style           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------- |
| Search and workspace     | `grep`, `search`, `hasMatch`, `fuzzyFind`, `glob`, `invalidateFsScanCache`, `listWorkspace`                                                                       | `grep.rs`, `fd.rs`, `glob.rs`, `iofs.rs`, `workspace.rs`              | mixed sync/promise   |
| AST and code structure   | `astGrep`, `astMatch`, `astEdit`, `blockRangeAt`, `nodeChainAt`, `enclosingBlockBoundaries`, `summarizeCode`, `wasmGrammarFor`                                      | `ast.rs`, `block.rs`, `summary.rs`, `grammars.rs`                     | mixed sync/promise   |
| Edit engine              | `EditSession`, `EditStore`, edit inspection/diff/grammar helpers, hashline helpers, `notebookToEditableText` | `edit.rs`, `crates/pi-edit` | mixed |
| OAuth callbacks          | `NativeOAuthCallback` | `oauth_callback/mod.rs` | class/promises |
| Apple Foundation Models  | `appleFmAvailability`, `appleFmGenerate`, `appleFmCancel` | `applefm/mod.rs` | promise, handle/callback, sync |
| Mermaid rendering        | `renderMermaidAscii` | `mermaid/mod.rs` | sync |
| Diff and vectors         | `diffLines`, `diffWords`, `diffLineRuns`, `structuredPatchHunks`, `DiffStream`, `cosineSimilarityPairs`, `mmrRerankIndices`, `vectorIndexTopK`                     | `diff.rs` (core in `pi-diff`), `vectors.rs`                            | sync transforms; mixed `DiffStream` |
| Shell and PTY            | `executeShell`, `Shell`, `PtySession`                                                                                                                             | `shell.rs`, `pty.rs`                                                  | classes/promises     |
| Process and files        | `Process`, `FileLock`, `execReplace`                                                                                                                              | `ps.rs`, `file_lock/mod.rs`                                           | classes/mixed        |
| Desktop and clipboard    | `DesktopSession`, `copyToClipboard`, `readImageFromClipboard`                                                                                                     | `desktop/mod.rs`, `clipboard.rs`                                      | class, sync, promise |
| Audio and live media     | `AudioCapture`, `AudioPlayback`, `LiveWebRtcPeer`                                                                                                                 | `audio.rs`, `live.rs`                                                 | classes/mixed        |
| Text and highlighting    | `wrapTextWithAnsi`, `truncateToWidth`, `sliceWithWidth`, `extractSegments`, `visibleWidth`, `setHangulCompatJamoWidthOverride`, `highlightCode`, `HighlightStream`, language queries | `text.rs`, `highlight.rs`                                             | sync                 |
| Conversion and rendering | `htmlToMarkdown`, `pdfToMarkdown`, `rasterizeSvg`, `encodeSixel`, `renderSnapcompactPng`, `snapcompactSupportedChars`                                              | `html.rs`, `pdf.rs`, `svg.rs`, `sixel.rs`, `snapcompact.rs`           | mixed sync/promise   |
| Tokens and system        | `countTokens`, macOS appearance, cross-platform power exports, `getWorkProfile`, `deviceCheckGenerateToken`                                                                       | `tokens.rs`, `appearance.rs`, `power.rs`, `prof.rs`, `devicecheck.rs` | mixed                |
| Spelling (macOS)         | `macOSCheckSpelling`, `macOSAutocorrectWord`, `macOSSpellingGuesses`, `macOSSpellCheckerAvailable`                                            | `spelling.rs`                                                         | mixed sync/promise   |
| Word prediction          | `TextPredictor` (`ngram`, `smollm`, and macOS-only `apple` engines; served to editors by the `text-predict` daemon)                                                | `predict.rs`, `crates/pi-predict`                                     | class/promises       |
| Version control          | `vcsDiscover`, `vcsGitClone`, `vcsDetachGitDir`, `vcsJoinPatches`, `vcsValidateHunkSelections`, `VcsRepo`, `VcsGitRepo`, `VcsJjWorkspace`                          | `vcs.rs`                                                              | mixed sync/promise   |
| Terminal output          | `TtyWriter`                                                                                                                                                       | `tty_writer.rs`                                                       | class                |
| Isolation                | `isoBackend`, `isoProbe`, `isoResolve`, `isoIsUnavailableError`, `isoStart`, `isoStop`, `isoDiff`                                                                 | `iso.rs`                                                              | mixed sync/promise   |
| Keys                     | `parseKey`, `matchesKey`, Kitty/legacy helpers                                                                                                                    | `keys.rs`                                                             | sync                 |

Consult `native/index.d.ts` for exact option/result fields and signatures. Notable current signatures include `renderSnapcompactPng(...): Promise<string>`, `readImageFromClipboard(): Promise<ClipboardImage | undefined | null>`, and typed-array vector inputs/results.

`ShellOptions`, `ShellRunOptions`, and `ShellExecuteOptions` accept an injected `ShellFilesystem`. Its error-first `handler` returns a `Promise<ShellFsResponse>` with filesystem failures encoded as `error` data. `nativeLocalPaths: true` bypasses the handler for all host paths and sends only URL paths to it; absent/false routes every path to the handler. A run-specific filesystem replaces the session filesystem only for that run.

Newer surface members on existing exports (all present in `native/index.d.ts`):

- `ShellRunResult.workingDir?` — shell working directory after command completion (added 16.3.0), letting hosts sync cwd without a hidden probe command.
- `GrepOptions.maxCountPerFile?` — per-file content-mode match cap (added 15.10.11). Note `GrepOptions` has no `cache` field; directory grep is always uncached (`FuzzyFindOptions`/`GlobOptions` carry the opt-in `cache` flag).
- `snapcompactSupportedChars(font, chars)` — font glyph-capability probe (added 16.2.7).

## Sync, Promise, and callback rules

The call style is part of the public contract:

- CPU-heavy/blocking APIs generally return promises through napi-rs tasks, including `grep`, `glob`, `fuzzyFind`, AST search/edit, `summarizeCodeAsync`, snapcompact rendering, and HTML conversion.
- Tokio-backed operations such as shell, PTY, isolation lifecycle, device check, desktop operations, and live media use promises where declared.
- In-memory transforms and direct probes generally remain synchronous: `search`, `hasMatch`, block boundaries, text/layout helpers, diffs, vector ranking, highlighting, key parsing, and isolation probe/resolve helpers.
- Stateful resources are classes. Their constructors and individual methods can have different sync/async behavior; use the declarations rather than assuming the whole class is asynchronous.

Changing a public function between synchronous and promise-returning is breaking. `renderSnapcompactPng`, for example, must be awaited even though adjacent snapcompact character probing is synchronous.

Callback parameters generated from napi-rs `ThreadsafeFunction` use an error-first shape such as `(error: Error | null, value) => void`. Where a streaming API returns a promise, its callback does not replace that promise. `appleFmGenerate` instead returns a numeric cancellation handle and streams JSON events through its callback. Exact timing and optionality are export-specific.

## Objects, enums, and binary data

`#[napi(object)]` structs become TS interfaces such as search results, AST payloads, shell/PTY results, desktop options/results, audio/live events, and isolation records. napi-rs owns runtime conversion; TypeScript optionality does not provide semantic validation to untyped callers.

The generated runtime enum objects currently are:

- `AstMatchStrictness`
- `DiffSide`
- `Ellipsis`
- `Encoding`
- `FileType`
- `GrepOutputMode`
- `IsoBackendKind`
- `IsoChangeKind`
- `KeyEventType`
- `MacOSAppearance`
- `ProcessStatus`
- `ShellFsFileType`
- `ShellFsMissing`
- `ShellFsOp`
- `ShellFsResolve`

Numeric and string enum declarations constrain TypeScript callers but do not by themselves prove that arbitrary untyped values are semantically valid. Binary APIs use typed arrays (`Uint8Array`, `Float32Array`, `Float64Array`, `Uint32Array`) where declared; do not replace them with ordinary arrays without an explicit conversion.

## Import and error behavior

- Importing the root throws if no compatible addon candidate loads. Lazy subpaths defer that failure until a native-backed operation is called.
- Install and compiled candidates normally must report the package version through their stamp or legacy sentinel. A pre-sentinel addon with no release identity can pass a narrow core/desktop compatibility check if its disk file lacks the expected current stamp. Workspace-development candidates skip this validation.
- A resident prior-version addon can produce a restart-specific mismatch; a stale file on disk produces a reinstall diagnosis.
- The loader does not check the full export set. A same-version incomplete build can therefore load and later expose `undefined` members.
- N-API conversion errors throw or reject before Rust business logic runs. Native task and async failures generally reject their promises; `EditSession.apply` returns engine failures as `isError` outcomes instead.

## Binding-change checklist

1. Add or change the owning Rust `#[napi]` item; register a new module in `crates/pi-natives/src/lib.rs`.
2. Run `bun --cwd=packages/natives run build:bindings` when the exported type surface changes. The default Cargo-backed `build` also regenerates declarations/exports; Bazel-backed and explicit-target artifact builds leave them unchanged.
3. Confirm `native/index.d.ts` has the intended JS name, types, optionality, callback shape, and sync/promise return.
4. Confirm the marked block in `native/index.js` contains the class/function and any enum runtime object.
5. Add a lazy subpath wrapper only when deferred loading is required, and then add matching `package.json#exports` runtime/types entries.
6. Update all direct consumers and remove the obsolete implementation when the native path becomes canonical.
7. Run a focused scenario that imports and invokes the changed export against the newly built addon.
