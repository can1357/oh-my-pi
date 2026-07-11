# Changelog

## [Unreleased]

## [16.2.0] - 2026-06-27

### Added

- Added a relaxed JSON parser supporting single-quoted strings, unquoted keys, and comments.
- Added `parseStreamingJson` and `parseStreamingJsonThrottled` for robust, efficient parsing of truncated or incremental streaming JSON.
- Added an XDG-aware document conversion cache directory helper.
- Exported `removeWithRetries()` as a standalone asynchronous function to handle retry-on-EBUSY cleanup logic.

### Changed

- Improved `readSseJson` to gracefully recover truncated or malformed final events using the streaming JSON parser, ending the stream cleanly instead of throwing.
- Increased the retry delay for EBUSY file-lock errors from 25ms to 50ms (extending the total retry window to 2 seconds) to improve reliability on Windows.

## [16.1.8] - 2026-06-20

### Added

- Exported `removeSyncWithRetries()` as a standalone function so tests that manage their own temp dirs can use the same retry-on-EBUSY cleanup logic as `TempDir.removeSync()`.

## [16.1.3] - 2026-06-19

### Changed

- Expanded the `TempDir` Windows retry window from 4×10ms to 40×25ms (1s total) to accommodate SQLite WAL/SHM file handle release delays

### Fixed

- Made EPIPE rejections from IPC `send()` to worker subprocesses (`syscall: "send"`) non-fatal: the global `unhandledRejection` handler now logs and continues instead of terminating the session when an optional subsystem's pipe breaks. A broken optional subsystem (TTS/STT/tiny-title/MCP) can no longer crash the whole agent session mid-task. ([#2997](https://github.com/can1357/oh-my-pi/issues/2997))

## [16.1.2] - 2026-06-19

### Added

- Added `directoryExists(dir)` to `dirs`: resolves whether a path is an existing directory, returning `false` on any stat failure (ENOENT, permission, non-directory). Lets callers check a directory is safe to `chdir` into before `setProjectDir` throws.

### Removed

- Removed the public `createAbortableStream` API from `@pk-nerdsaver-ai/pi-utils`. Consumers should use the lighter, direct-reader `abortableSource` async generator inside `@pk-nerdsaver-ai/pi-utils/stream` to avoid the extra ReadableStream wrapper layer and per-chunk enqueue overhead.

## [16.0.11] - 2026-06-19

### Removed

- Removed `getIndentation`, `setDefaultTabWidth`, and `getDefaultTabWidth` helpers

## [16.0.8] - 2026-06-18

### Changed

- Mermaid diagrams are now rendered to ASCII by a first-party vendored renderer (`src/vendor/mermaid-ascii`, derived from the MIT-licensed `beautiful-mermaid`, ASCII pipeline only) with terminal display width measured via `Bun.stringWidth` (grapheme-aware, correct for wide/East-Asian glyphs and emoji). Inline label formatting (HTML formatting tags and markdown emphasis) is now reduced to plain text instead of printed raw.

### Removed

- Removed the external `beautiful-mermaid` dependency (and its transitive `elkjs`, ~3.13MB) in favor of the vendored ASCII renderer.

## [16.0.3] - 2026-06-16

### Added

- Added `escapeXmlText` utility to escape XML-significant characters `&`, `<`, and `>` in element body text
- Added `isTerminalHeadless()` / `setTerminalHeadless()` to centrally suppress real-terminal side effects (stdout escape/frame writes, stdin raw mode, CSI/OSC capability probes, SIGWINCH, window-title changes, emergency restore) under the test runtime. Defaults on when `bun test` sets `NODE_ENV=test`; terminal-contract tests opt out via `setTerminalHeadless(false)`

## [15.13.3] - 2026-06-15

### Added

- Added `installWorkerInbox(port)` / `consumeWorkerInbox()` to `@pk-nerdsaver-ai/pi-utils/worker-host`. A self-dispatching CLI host that imports a Bun worker module dynamically attaches the worker's real `message` listener after Bun flushes the messages the parent posted before spawn, dropping a synchronously-posted `init`. The host installs this buffering inbox synchronously in the entry's sync prefix so a listener exists at flush time; the worker module consumes it and binds the real handler, replaying anything buffered.

## [15.13.1] - 2026-06-15

### Added

- Added profile-aware directory helpers and isolated profile state roots, while keeping the install ID shared across profiles.
- Added a named-profile API to the `dirs` module — `setProfile()`, `getActiveProfile()`, `getProfileRootDir()`, and `normalizeProfileName()` — plus `resolveProfileEnv()`, which selects the active profile from `OMP_PROFILE` (canonical; takes precedence) then `PI_PROFILE` (legacy fallback, consulted only when `OMP_PROFILE` is unset).
- Added the side-effect-free `@pk-nerdsaver-ai/pi-utils/worker-host` module (`declareWorkerHostEntry()` / `workerHostEntry()`), extracted from `env` (still re-exported there) so worker spawn sites can resolve the self-dispatching CLI host entry without importing `env`'s side-effecting module graph.

### Fixed

- Fixed profile directory isolation when a profile's agent `.env` customizes directory roots: directory-affecting keys (`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`, and a default-mode `PI_CODING_AGENT_DIR`) are now honored. The `env` loader rebuilds the `dirs` resolver after applying `.env` files (`refreshDirsFromEnv()`), so a profile `.env` that points XDG roots elsewhere no longer leaks state into the home-based config dir.
- Fixed `installRuntimeModuleResolver()` to keep bare requests from runtime-cache modules inside that registered runtime before falling back to host/workspace packages.

## [15.13.1] - 2026-06-15

### Added

- Added support for a runtime `overrides` map in `RuntimeInstallSpec`, which is now written into generated runtime `package.json` manifests to force dependency pins (including transitive ones) across the runtime tree
- Added a lightweight loop-phase breadcrumb stack (`pushLoopPhase`/`popLoopPhase`/`currentLoopPhase`, plus `takeRecentLoopPhase` which returns the live phase or the most recently popped one and clears it) so the TUI event-loop watchdog can attribute a main-thread block to the phase that caused it — including a synchronous phase already popped before the watchdog's delayed tick runs ([#2485](https://github.com/can1357/oh-my-pi/issues/2485))
- Added `FetchWithRetryOptions.timeout` (forwarded to the underlying `fetch` call). `false` disables Bun's native ~300s pre-response timeout; a positive number overrides the ceiling. Bare browser/Node fetch ignores it ([#2422](https://github.com/can1357/oh-my-pi/issues/2422))

### Fixed

- Made `TempDir` cleanup retry transient Windows `EBUSY`/`EPERM`/`ENOTEMPTY` removal failures so tests are less likely to fail when deleting just-used temp directories.

## [15.12.4] - 2026-06-13

### Fixed

- Fixed abortable stream wrappers to cancel the source stream on abort, so timeout watchdogs release upstream HTTP bodies instead of only stopping the local reader.

## [15.12.0] - 2026-06-12

### Added

- Added `runtime-install`: shared on-demand runtime dependency support — `ensureRuntimeInstalled()` (locked, idempotent `bun install` of a pinned dependency set into a cache dir) and a multi-root `installRuntimeModuleResolver()`/`resolveRuntimeModule()` for loading those graphs inside compiled binaries (Bun #1763). Extracted from the coding-agent tiny-model worker; now also backs Mnemopi's on-demand fastembed runtime ([#2389](https://github.com/can1357/oh-my-pi/issues/2389))
- Added `getFastembedRuntimeDir()` (~/.omp/cache/fastembed-runtime) alongside `getFastembedCacheDir()`

## [15.11.4] - 2026-06-12

### Added

- Added `getEditorConfigFormatting(file)`: returns the `.editorconfig`-pinned `tabSize`/`insertSpaces` (both optional, no fallback) so LSP-format callers can layer per-file defaults under it without paving over silence with the renderer's display tab width ([#2329](https://github.com/can1357/oh-my-pi/issues/2329)).

## [15.11.3] - 2026-06-11

### Added

- Added `getEditorConfigFormatting(file)`: returns the `.editorconfig`-pinned `tabSize`/`insertSpaces` (both optional, no fallback) so LSP-format callers can layer per-file defaults under it without paving over silence with the renderer's display tab width ([#2329](https://github.com/can1357/oh-my-pi/issues/2329)).

## [15.11.1] - 2026-06-11

### Fixed

- Fixed cleanup reentry noise during fatal shutdown: recursive cleanup requests now no-op idempotently instead of logging repeated `Cleanup invoked recursively` errors ([#2284](https://github.com/can1357/oh-my-pi/issues/2284)).

## [15.11.0] - 2026-06-10

### Added

- Added the `path-tree` module (`buildPathTree`, `walkPathTree`, `formatGroupedPaths`, `isUrlLikePath`), moved from the coding agent's grouped file output so compaction file lists can share the same prefix-folded directory-tree rendering; `formatGroupedPaths` gains an optional `annotate` callback for per-file suffixes

### Fixed

- Fixed the `{{join}}` prompt helper joining with a literal two-character `\n` when templates pass `"\n"` as the separator — Handlebars string literals carry no escape processing. The separator now unescapes `\n`/`\t`, matching the `{{#list}}` helper's documented convention (visible as literal `\n` between paths in compaction `<read-files>` lists).

## [15.10.11] - 2026-06-10

### Added

- Restored `PI_DEBUG_STARTUP` streaming startup markers: `logger.time` now writes a synchronous `[startup] <op>:start` / `:done` / `:fail` stderr line per phase (independent of `PI_TIMING`), so a startup that hangs hard still names the phase it is stuck in — the `PI_TIMING` tree only prints after startup completes and is structurally unable to diagnose a hang. The CLI runner emits `cli:load:<name>` markers around each lazily-imported command module for the same reason.
- Added `logger.openSpanPath()`: ops of the currently-open timing-span chain (root → deepest), used by the coding agent's startup watchdog to name the in-flight phase of a stalled startup.
- Added `declareWorkerHostEntry()` / `workerHostEntry()` (env): self-dispatching CLI entrypoints declare `Bun.main` as the worker host so worker spawn sites can re-enter the single entry module with `WorkerOptions.argv` selectors across source, npm-bundle, and compiled distributions

### Changed

- Changed `prompt.compile()` to cache compiled templates by the raw template string so repeated calls reuse the same compiled function without re-disambiguating
- `Snowflake.formatParts` packs the id as a single 64-bit BigInt hex format instead of stitching four 16-bit segments (simpler and ~1.7x faster), and `getTimestamp` extracts via exact double arithmetic instead of a BigInt round-trip. Output is bit-identical.
- Logger initialization is lazy: the winston logger, file transport, and log-directory creation now happen on first log emission instead of at module import (the import previously cost ~8ms of fs work on the CLI startup path); the in-memory timing infrastructure never touches winston
- `prompt.format()` post-processing got cheap per-line guards and a single-pass ASCII-symbol replacement (was 7 chained regex passes per line), roughly halving render post-processing cost; output is byte-identical

### Fixed

- Fixed `prompt.format()` so ASCII symbol replacements such as `-->` and `!=` still run on lines containing a closing HTML comment token when not inside a comment
- `isCompiledBinary()` now also honors a define-folded `process.env.PI_COMPILED` (only `Bun.env` was checked), so builds that constant-fold `process.env` keep compiled-binary detection without relying on `import.meta.url` bunfs markers
- `omp <cmd> --help` now loads only the requested command module instead of the entire command table, so an unrelated command whose import graph hangs or crashes can no longer take down every per-command help invocation.

## [15.10.8] - 2026-06-09

### Removed

- Removed the exported `hookFetch` API, which previously intercepted `globalThis.fetch` via middleware handlers
- Removed `hookFetch` from the package entrypoint, so imports from `@.../utils` no longer provide this fetch interception helper

## [15.10.0] - 2026-06-06

### Changed

- `logger.printTimings()` (the `PI_TIMING` startup tree) now surfaces two previously-invisible regions: a `(before instrumentation)` line for runtime init / uncaptured pre-marker work, and an `(unattributed self)` line for the root span's own untimed work so the gap between visible top-level spans and `Total` is no longer swallowed. `Total` is now labelled `(since first marker)` to make the window explicit. The restored `module-timer.ts` preload can feed module spans into the report: each module records `onLoad` → final top-level marker as `total`, a prepended body marker → final marker as `body/TLA`, and resolved static imports as a bounded dependency tree so the report separates graph wait from actual top-level module work.

## [15.9.2] - 2026-06-05

### Added

- Added `getAuthBrokerSnapshotCachePath()` with `OMP_AUTH_BROKER_SNAPSHOT_CACHE` override support for isolating the encrypted broker snapshot cache.

## [15.9.1] - 2026-06-04

### Fixed

- Hardened `getIndentation` against malformed paths: any filesystem error from the `.editorconfig` probe (e.g. `ENAMETOOLONG` on oversized garbage path segments) is now swallowed and cached as a miss instead of escaping and crashing the TUI mid-render ([#1871](https://github.com/can1357/oh-my-pi/issues/1871)).
- Fixed `getIndentation` (and the edit renderer's `replaceTabs` callers) crashing with `ENAMETOOLONG`/`ENOTDIR`/etc. when handed a path with an overlong component or a non-directory in its parent chain. Editorconfig discovery now short-circuits to the default tab width on any path component above `NAME_MAX` (255 bytes) and absorbs any `FsError` while walking the editorconfig chain — best-effort discovery must never escape as an uncaught exception ([#1872](https://github.com/can1357/oh-my-pi/issues/1872)).

## [15.9.0] - 2026-06-04

### Added

- Added color helpers `colorLuma` (perceptual luma), `relativeLuminance` (WCAG, linearized sRGB), and `hslToHex` to the color utilities. The luminance helpers parse `#rgb`/`#rrggbb` hex and 256-color palette indices, returning `undefined` for unparseable values.
- Added `peekFileEnds`, a single-open head-and-tail file peek helper that reuses the head bytes for the tail when the file fits the head window.
- Added `peekFileTail`, the tail mirror of `peekFile`: reads up to the last `maxBytes` of a file ending at EOF, reusing the same pooled-buffer strategy (no per-call allocation for small reads).

## [15.7.3] - 2026-05-31

### Added

- Added `getFastembedCacheDir` to return the FastEmbed model cache directory under ~/.omp/cache/fastembed

### Fixed

- Fixed `$flag` environment parsing to accept lowercase truthy values such as `y`, `true`, `yes`, and `on`

## [15.6.0] - 2026-05-30

### Added

- Added an XDG-aware tiny-title model cache directory helper for coding-agent local title models.
