# Natives Binding Contract (JavaScript/TypeScript Side)

This page defines the public JS/TS boundary between `@oh-my-pi/pi-natives` callers and its N-API addon. The authoritative public root surface is `packages/natives/native/index.d.ts` plus the explicit ESM exports in `native/index.js`; Rust internals not present there are not package API.

## Contract layers

1. `crates/pi-natives/src/**/*.rs` defines `#[napi]` functions, classes, objects, and enums.
2. `bun --cwd=packages/natives run build:bindings` runs napi-rs, installs the host addon and generated `native/index.d.ts`, then runs `gen-enums.ts`.
3. `gen-enums.ts` reads the declarations, rewrites napi-rs `const enum` declarations to runtime-usable declarations, and replaces the marked block in `native/index.js` with explicit class/function exports and literal enum objects.
4. `native/index.js` loads the addon and binds that generated root surface.

There is no `NativeBindings` declaration-merging lifecycle or `packages/natives/src/<module>` wrapper convention. The loader validates only a release-version sentinel for install/compiled loads, not every public symbol.

## Public entrypoints

`packages/natives/package.json` exports:

| Entry                            | Public values                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@oh-my-pi/pi-natives`           | Generated root classes, functions, and enum objects from `native/index.js` / `index.d.ts`. Importing is eager.                  |
| `@oh-my-pi/pi-natives/desktop`   | `createDesktopSession(options): DesktopSession`; addon load is deferred until invocation.                                       |
| `@oh-my-pi/pi-natives/clipboard` | `copyToClipboard(text)` and `readImageFromClipboard()` plus the `ClipboardImage` type; addon load is deferred until invocation. |

Do not import unexported `native/*` implementation paths from package consumers.

## Current root surface by owner

| Category                 | Representative public exports                                                                                                                                     | Rust owner                                                            | Call style           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------- |
| Search and workspace     | `grep`, `search`, `hasMatch`, `fuzzyFind`, `glob`, `invalidateFsScanCache`, `listWorkspace`                                                                       | `grep.rs`, `fd.rs`, `glob.rs`, `iofs.rs`, `workspace.rs`              | mixed sync/promise   |
| AST and code structure   | `astGrep`, `astMatch`, `astEdit`, `blockRangeAt`, `nodeChainAt`, `enclosingBlockBoundaries`, `summarizeCode`                                                       | `ast.rs`, `block.rs`, `summary.rs`                                    | mixed sync/promise   |
| Diff and vectors         | `diffLines`, `diffWords`, `diffLineRuns`, `structuredPatchHunks`, `DiffStream`, `cosineSimilarityPairs`, `mmrRerankIndices`, `vectorIndexTopK`                     | `diff.rs`, `vectors.rs`                                               | sync                 |
| Shell and PTY            | `executeShell`, `Shell`, `PtySession`                                                                                                                             | `shell.rs`, `pty.rs`                                                  | classes/promises     |
| Process and files        | `Process`, `FileLock`, `execReplace`                                                                                                                              | `ps.rs`, `file_lock/mod.rs`                                           | classes/mixed        |
| Desktop and clipboard    | `DesktopSession`, `copyToClipboard`, `readImageFromClipboard`                                                                                                     | `desktop/mod.rs`, `clipboard.rs`                                      | class, sync, promise |
| Audio and live media     | `AudioCapture`, `AudioPlayback`, `LiveWebRtcPeer`                                                                                                                 | `audio.rs`, `live.rs`                                                 | classes/mixed        |
| Text and highlighting    | `wrapTextWithAnsi`, `truncateToWidth`, `sliceWithWidth`, `extractSegments`, `visibleWidth`, `setHangulCompatJamoWidthOverride`, `highlightCode`, `HighlightStream`, language queries | `text.rs`, `highlight.rs`                                             | sync                 |
| Conversion and rendering | `htmlToMarkdown`, `pdfToMarkdown`, `rasterizeSvg`, `encodeSixel`, `renderSnapcompactPng`, `snapcompactSupportedChars`                                              | `html.rs`, `pdf.rs`, `svg.rs`, `sixel.rs`, `snapcompact.rs`           | mixed sync/promise   |
| Tokens and system        | `countTokens`, macOS appearance, cross-platform power exports, `getWorkProfile`, `deviceCheckGenerateToken`                                                                       | `tokens.rs`, `appearance.rs`, `power.rs`, `prof.rs`, `devicecheck.rs` | mixed                |
| Spelling (macOS)         | `macOSCheckSpelling`, `macOSCompleteWord`, `macOSAutocorrectWord`, `macOSSpellingGuesses`, `macOSSpellCheckerAvailable`                                            | `spelling.rs`                                                         | mixed sync/promise   |
| Version control          | `vcsDiscover`, `vcsGitClone`, `vcsDetachGitDir`, `vcsJoinPatches`, `vcsValidateHunkSelections`, `VcsRepo`, `VcsGitRepo`, `VcsJjWorkspace`                          | `vcs.rs`                                                              | mixed sync/promise   |
| Terminal output          | `TtyWriter`                                                                                                                                                       | `tty_writer.rs`                                                       | class                |
| Isolation                | `isoBackend`, `isoProbe`, `isoResolve`, `isoIsUnavailableError`, `isoStart`, `isoStop`, `isoDiff`                                                                 | `iso.rs`                                                              | mixed sync/promise   |
| Keys                     | `parseKey`, `matchesKey`, Kitty/legacy helpers                                                                                                                    | `keys.rs`                                                             | sync                 |

Consult `native/index.d.ts` for exact option/result fields and signatures. Notable current signatures include `renderSnapcompactPng(...): Promise<string>`, `readImageFromClipboard(): Promise<ClipboardImage | undefined | null>`, and typed-array vector inputs/results.

Newer surface members on existing exports (all present in `native/index.d.ts`):

- `ShellRunResult.workingDir?` — shell working directory after command completion (added 16.3.0), letting hosts sync cwd without a hidden probe command.
- `GrepOptions.maxCountPerFile?` — per-file content-mode match cap (added 15.10.11). Note `GrepOptions` has no `cache` field; directory grep is always uncached (`FuzzyFindOptions`/`GlobOptions` carry the opt-in `cache` flag).
- `snapcompactSupportedChars(font, chars)` — font glyph-capability probe (added 16.2.7).

## Sync, Promise, and callback rules

The call style is part of the public contract:

- CPU-heavy/blocking APIs generally return promises through napi-rs tasks, including `grep`, `glob`, `fuzzyFind`, AST search/edit, snapcompact rendering, and HTML conversion.
- Tokio-backed operations such as shell, PTY, isolation lifecycle, device check, desktop operations, and live media use promises where declared.
- In-memory transforms and direct probes generally remain synchronous: `search`, `hasMatch`, block boundaries, text/layout helpers, diffs, vector ranking, highlighting, key parsing, and isolation probe/resolve helpers.
- Stateful resources are classes. Their constructors and individual methods can have different sync/async behavior; use the declarations rather than assuming the whole class is asynchronous.

Changing a public function between synchronous and promise-returning is breaking. `renderSnapcompactPng`, for example, must be awaited even though adjacent snapcompact character probing is synchronous.

Callback parameters generated from napi-rs `ThreadsafeFunction` use an error-first shape such as `(error: Error | null, value) => void`. Streaming callbacks do not replace the owning promise/result. Their exact timing and optionality are declared per export.

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

Numeric and string enum declarations constrain TypeScript callers but do not by themselves prove that arbitrary untyped values are semantically valid. Binary APIs use typed arrays (`Uint8Array`, `Float32Array`, `Float64Array`, `Uint32Array`) where declared; do not replace them with ordinary arrays without an explicit conversion.

## Import and error behavior

- Importing the root throws if no compatible addon candidate loads. Lazy desktop/clipboard subpaths defer that failure until their wrapper is called.
- Install and compiled candidates missing the expected version sentinel are rejected during loading. Workspace-development candidates skip sentinel validation.
- A resident prior-version addon can produce a restart-specific mismatch; a stale file on disk produces a reinstall diagnosis.
- The loader does not check the full export set. A same-version incomplete build can therefore load and later expose `undefined` members.
- N-API conversion errors throw or reject before Rust business logic runs. Native task and async failures reject their returned promises.

## Binding-change checklist

1. Add or change the owning Rust `#[napi]` item; register a new module in `crates/pi-natives/src/lib.rs`.
2. Run `bun --cwd=packages/natives run build:bindings` when the exported type surface changes. This is the declaration/local-addon path; the normal `build` script is the Bazel shipping-addon path.
3. Confirm `native/index.d.ts` has the intended JS name, types, optionality, callback shape, and sync/promise return.
4. Confirm the marked block in `native/index.js` contains the class/function and any enum runtime object.
5. Add a lazy subpath wrapper only when deferred loading is required, and then add matching `package.json#exports` runtime/types entries.
6. Update all direct consumers and remove the obsolete implementation when the native path becomes canonical.
7. Run a focused scenario that imports and invokes the changed export against the newly built addon.
