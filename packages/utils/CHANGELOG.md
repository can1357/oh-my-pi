# Changelog

## [Unreleased]

### Added

- Added the Linux `subreaper` spawn option to retain reparented descendants for process-tree cleanup.

### Fixed

- Keep project-directory state unchanged when changing directories fails.
- Fixed `ptree` timeout cleanup and output capture so timed commands retain their deadline through descendant-held pipes and untimed commands read output to EOF.

## [18.0.7] - 2026-08-26

### Added

- Added `math-delimiters`, the LaTeX span/block delimiter grammar (`mathStartIndex`, `mathOpenerAt`, `mathSpanAt`, `mathBlockAt`) shared by every Markdown renderer: pandoc's anti-currency rules for `$…$`, own-line display blocks, and delimiters matched by backslash parity, so an escaped `\$x$` stays literal and a TeX row break cannot end a span early.
- Added `RequestError.sessionBusy(message, data)` to represent ACP session-busy errors (`-32003`) through the shared JSON-RPC transport.
- Exported `getComposerCacheDir` for resolving the per-project Composer cache directory, including support for `XDG_CACHE_HOME`.

### Fixed

- Fixed OMP sessions unexpectedly exiting during socket cleanup or optional-worker communication on Bun.

## [18.0.6] - 2026-08-26

### Added

- Added conventional commit generation with support for dependency, security, configuration, UX, and infrastructure commit types, plus configurable caching and large-diff analysis behavior.

## [18.0.5] - 2026-08-25

### Added

- Added `stableStringifyJson` for deterministic serialization of nested JSON-shaped data.

### Fixed

- Fixed managed Chrome-for-Testing installation failures when extracting the trusted browser download.

## [18.0.4] - 2026-08-24

### Added

- Exported `getAvatarCacheDir` to resolve the avatar cache directory path.

## [18.0.1] - 2026-08-23

### Fixed

- Fixed the Mermaid ASCII renderer throwing on left-to-right diagrams containing a `subgraph`, which made the fenced block fall back to raw source in the terminal. `offsetDrawingForSubgraphs` shifts every drawing coordinate to make room for subgraph borders that extend past the origin, but the canvas had already been sized from the pre-shift grid extents, so edges routed to the outermost column wrote past the allocation and `drawLine` threw on the missing column. The canvas and role canvas now grow by the same shift. ([#9340](https://github.com/can1357/oh-my-pi/issues/9340))
- Fixed child shell environments inheriting Bun-autoloaded `.env.<mode>.local` values from the launch directory. ([#9290](https://github.com/can1357/oh-my-pi/issues/9290))

## [17.4.2] - 2026-08-21

### Fixed

- Made malformed advanced-serialization frames from a worker subprocess non-fatal: Bun surfaces an undecodable IPC frame as a process-level `uncaughtException` in the parent (oven-sh/bun#37287), which the postmortem handler treated as fatal and tore down every active session and subagent. The handler now recognizes the decode failure and, keeping the session alive, faults the active advanced-IPC worker subsystems so their clients reject in-flight requests and recycle the subprocess instead of awaiting forever — mirroring the existing ipc-send EPIPE containment. ([#9158](https://github.com/can1357/oh-my-pi/issues/9158))

## [17.4.1] - 2026-08-21

### Added

- New unified archive API `@oh-my-pi/pi-utils/ar`, providing an `openArchive`/`ArchiveReader` interface across formats (including ZIP/ZIP64, tar with gz/bz2/xz/zst compression, ASAR, RAR 4/5, 7z, ISO 9660, CAB, cpio, RPM, Unix ar, Debian packages, LZH, ARJ, and single-stream compressed files) with lazy ranged reads for local files or HTTP range requests via `httpByteSource`, size limits, symlink-safe extraction, and deterministic archive creation for zip, tar, tar.gz, tar.zst, and asar.

## [17.3.8] - 2026-08-19

### Added

- Exported `BINARY_SNIFF_BYTES`, the header window `isProbablyBinary` sniffs, so a caller holding the whole file in memory can classify the identical prefix through `isProbablyBinaryHeader` instead of reopening the file.

## [17.3.5] - 2026-08-16

### Fixed

- Fixed the Markdown renderer incorrectly breaking into a raw code block when a 4-space-indented line (such as a box-drawing tree child under a └── branch) directly followed paragraph text; it now correctly stays part of the paragraph, matching standard Markdown behavior.

## [17.3.2] - 2026-08-13

### Fixed

- Fixed `fetchWithRetry()` aborts during retry backoff to preserve the documented `"Request was aborted"` error contract ([#8450](https://github.com/can1357/oh-my-pi/issues/8450)).

## [17.3.0] - 2026-08-13

### Fixed

- Optimized performance of partial JSON parsing for long streaming tool-call arguments.
- Fixed Mermaid ASCII multi-word edge labels where routed lines would show through spaces.

## [17.2.15] - 2026-08-12

### Changed

- Extended parsed Server-Sent Events (SSE) to include optional id and retry fields, enabling reconnecting transports to retain stream cursors and respect server-requested retry intervals.

## [17.2.13] - 2026-08-11

### Changed

- Changed stale process-log retention from the newest five files globally to one newest file per completed process and day within the current and previous four local calendar days. This preserves bounded daily diagnostic coverage while continuing to remove one-use audit files.
- Changed outbound User-Agent consumers to share the versioned `USER_AGENT` constant (`omp/<version>`).

### Fixed

- Fixed Mermaid ASCII state pseudostates rendering empty boxes, miscoloring final-state borders, and inverting rounded corners in bottom-to-top diagrams.

## [17.2.11] - 2026-08-07

### Added

- Added `repair` and `rawKeys` options to `parseFrontmatter` to support spec-conformant loading (disabling lenient recovery and preserving keys verbatim), and exported `normalizeFrontmatterKeys` for manual key normalization.

### Fixed

- Fixed the in-house `marked` list tokenizer incorrectly consuming trailing blank lines at the end of input, ensuring correct list tightness and token generation matching standard `marked` behavior.

## [17.2.10] - 2026-08-06

### Added

- Introduced zero-dependency in-house modules replacing external packages, importable via `@oh-my-pi/pi-utils/<module>`: `acp` (Agent Client Protocol), `browsers` (Chrome for Testing discovery/install), `chalk` (ANSI styling), `dates` (date formatting), `dom` (HTML parser, WHATWG DOM subset, and CSS selectors), `docx` (DOCX to HTML), `headers` (browser header generation), `lru` (LRU cache), `marked` (GFM markdown lexer/parser), `readability` (article extraction), `template` (Handlebars-compatible templating), `turndown` (HTML to Markdown), `vterm` (headless terminal emulator), and `xml` (XML parser).
- Added postmortem fatal recovery hint providers to allow applications to print actionable recovery commands before cleanup starts.

### Changed

- Rewrote the logger file backend in-house, maintaining the identical line format, daily rotation, and pruning behavior without external dependencies.

### Fixed

- Fixed PowerShell (`powershell.exe` / `pwsh`) support when used as a custom `shellPath` by correctly passing `-NoLogo -Command` (and `-NoProfile` under `PI_BASH_NO_LOGIN`) instead of POSIX flags.
- Fixed the in-house `marked` list tokenizer consuming the trailing blank line into the list token when the next top-level line was a plain paragraph. The blank now always becomes a separate `space` token (matching real marked), so a list's token shape no longer depends on what follows it — restoring the TUI streaming lexer's freeze invariant — and a list followed by a paragraph is tight, not loose, per CommonMark.
- Added the missing Handlebars built-in `lookup` helper to the in-house `template` engine (`{{lookup obj key}}`, proto-safe property access; a user-registered `lookup` helper still takes precedence).

### Removed

- Removed external dependencies on `handlebars`, `winston`, and `winston-daily-rotate-file`.

## [17.2.9] - 2026-08-05

### Added

- Added a public `compareVersions` utility (`@oh-my-pi/pi-utils`) that compares two version strings with SemVer-2.0 prerelease ordering, build-metadata stripping, and numeric segment comparison without float overflow; never throws.

### Fixed

- Honor the current process `PATH` when caching executable lookups, preventing stale tool paths after environment reloads.
- Parsed account-cap reset windows such as “Your limit will reset in 13 minutes” so credential backoff honors the provider's full reset duration.

## [17.2.6] - 2026-08-03

### Added

- Added a shared `file-lock` utility backed by process-owned native OS locks with automatic crash release and bounded asynchronous retry.

## [17.2.5] - 2026-08-03

### Added

- Added utility functions `parseFlag()`, `getBrowserRelayDir()`, and `getGlobalDaemonRuntimeDir()` to support browser relay mode and global daemon runtime directory resolution.

### Changed

- Updated the lightweight CLI runner to support static command metadata, allowing root help to render without importing full command implementations.

## [17.2.4] - 2026-08-01

### Added

- Added `getSecretPlaceholderKeyPath()`, `getDaemonRuntimeDir()`, `getProviderInFlightRoot()`, and `getMarketplacesRegistryPath()` to resolve secret key, daemon runtime, provider in-flight, and marketplace registry paths under their respective XDG categories (state, data) instead of the config root.
- Existing installs enabling XDG keep their data: a legacy `~/.omp/agent/secret-placeholder.key` or `~/.omp/marketplaces.json` is copied to its XDG location on first resolution, so persisted transcripts still deobfuscate and added marketplaces survive the move.

### Changed

- Headless hosts (print/RPC/ACP/eval/SDK) now use a 1s SQLite `busy_timeout` for the session-critical databases (agent.db, history.db, stats.db) via `getDbBusyTimeoutMs()`, so lock contention no longer freezes the protocol loop for the full interactive 5s timeout; interactive hosts keep the 5s timeout.

### Fixed

- Fixed Bun test-runtime detection treating application-owned `NODE_ENV=test` and `BUN_ENV=test` values as test-runner signals ([#7261](https://github.com/can1357/oh-my-pi/issues/7261)).

## [17.2.1] - 2026-07-30

### Added

- Added a `postmortem.quit` configuration option to safely handle shutdown paths when the terminal output has already disconnected.
- Added project-keyed OMP security-state directory helpers under the user state root.

## [17.1.8] - 2026-07-28

### Added

- Added `setProcessName` utility to set the OS-visible process name on Linux via `bun:ffi`, bypassing Bun's `process.title` limitations.

### Fixed

- Fixed child shell environment filtering to drop launch-directory `.env` values in addition to Bun-autoloaded `.env.local` values.

## [17.1.5] - 2026-07-27

### Fixed

- `getShellConfig` no longer throws `No bash shell found` on Windows hosts without a discoverable bash. `resolveWindowsShell` searches Git for Windows install roots (machine, per-user, `GIT_INSTALL_ROOT`, scoop app dirs — scoop shims `sh.exe`/`git.exe` but never `bash.exe`), then `bash.exe`/`sh.exe` on PATH, and finally falls back to `cmd.exe` from ComSpec with `/c` args, so shell resolution always succeeds.

## [17.1.4] - 2026-07-26

### Fixed

- Fixed postmortem signal and fatal shutdown exits being intercepted by temporary `process.exit` guards during extension startup ([#6488](https://github.com/can1357/oh-my-pi/issues/6488)).
- Corrected Windows shell resolution errors to identify the active global, project, overlay, or runtime source for `shellPath` instead of directing every user to the retired `settings.json` file ([#6579](https://github.com/can1357/oh-my-pi/issues/6579)).
- Contained timed-out child lifecycle rejections so `ptree` callers cannot leak an unhandled `TimeoutError` after settling ([#6635](https://github.com/can1357/oh-my-pi/issues/6635)).
- Fixed an invalid configured `shellPath` being silently masked whenever an earlier caller had already resolved a shell in the same process; the guidance error now surfaces regardless of cache state.

## [17.0.9] - 2026-07-23

### Breaking Changes

- Renamed `getAutoQaDbDir` to `getAutoQaDbPath` for accuracy; update any usage accordingly

## [17.0.5] - 2026-07-18

### Changed

- Updated `installRuntimeModuleResolver` to return an uninstaller function that restores the stock `node:module` resolver once all runtime roots are unregistered.
- Added documentation regarding a known limitation with Bun 1.3.14's `createRequire` behavior when the module resolver patch is active.

## [17.0.2] - 2026-07-17

### Added

- Added a structured log sink API (`registerLogSink`, `LogEvent`, `LogLevel`) to the centralized logger, enabling out-of-band consumers (such as OpenTelemetry) to receive log events without affecting local file or console logging.

### Changed

- Bounded default `ptree.ChildProcess` stderr retention to a 32 KiB tail to prevent memory leaks in long-lived subprocesses. Full stderr capture must now be explicitly requested at spawn time using `{ stderr: "full" }` on `spawn` or `exec`.

### Fixed

- Fixed fatal cleanup failing to reach `process.exit()` when terminal stderr is revoked.
- Isolated rotating log files and audit state per process to prevent concurrent instances from racing during compression and rotation.

## [17.0.1] - 2026-07-16

### Fixed

- Added scoped graceful handling for stdio-write EPIPE rejections so protocol servers can await postmortem cleanup when their peer disconnects ([#4788](https://github.com/can1357/oh-my-pi/issues/4788)).

## [17.0.0] - 2026-07-15

### Fixed

- Improved SSE streaming performance by batching complete lines into a single UTF-8 decode per chunk, reducing decoder overhead.
- Fixed an issue in `parseFrontmatter` where a single malformed YAML line would corrupt sibling values by parsing each line independently.

## [16.5.2] - 2026-07-14

### Fixed

- Improved CLI argument and flag validation error output to display a concise error message and command usage instead of a minified code frame.
- Corrected required variadic positionals to render as `MODELS...` instead of `[MODELS]` in usage help.

## [16.5.1] - 2026-07-14

### Added

- Added terminal stderr guard utilities (suppressTerminalStderr and restoreTerminalStderr) to prevent macOS runtime diagnostics from corrupting TUI viewports while ensuring crash reports remain visible.

### Fixed

- Fixed an issue in Mermaid ASCII routing where unreachable edge attachment points caused unbounded pathfinder searches.

## [16.4.6] - 2026-07-12

### Added

- Added `AsyncDrain`, the deferred write-batching helper previously private to the coding-agent's prompt-history storage; now shared with model-perf recording.

## [16.4.2] - 2026-07-10

### Added

- Added `stringifyJson` utility with support for BigInt serialization.

## [16.3.12] - 2026-07-08

### Added

- Added `postmortem.interceptUnhandledRejections()` to register interceptors consulted before an unhandled rejection tears the process down; a consuming interceptor (e.g. the JS eval runtime claiming rejections floated by user cell code) keeps the process alive and owns reporting.

### Fixed

- Fixed child shell environment filtering to drop launch-directory `.env.local` values that Bun auto-loaded before OMP starts command shells. ([#4723](https://github.com/can1357/oh-my-pi/issues/4723))

## [16.3.10] - 2026-07-06

### Added

- Added `postmortem.markExpectedCleanupError()` / `postmortem.isExpectedCleanupError()` to tag errors thrown by routine resource teardown; the global `uncaughtException`/`unhandledRejection` handlers downgrade marked errors (walking the `cause` chain) to warnings instead of exiting the process.

### Fixed

- Bounded postmortem cleanup with a 10s deadline so a hanging cleanup callback can no longer wedge the process indefinitely after a fatal error or signal; the process now always reaches `process.exit`.

## [16.3.7] - 2026-07-05

### Added

- Added `classifyJsonPrefix`, a strict RFC 8259 streaming-buffer classifier (`"complete" | "prefix" | "invalid"`). Providers use it to disambiguate identifierless streaming tool-call deltas: a `{`-prefixed chunk only advances to a sibling call when the current argument buffer cannot absorb it.

## [16.3.1] - 2026-07-02

### Fixed

- Fixed `parseJsonWithRepair` failing tool calls whose streamed arguments contain an unquoted string value (e.g. `{"paths": packages/foo/*, "i": "…"}`). Final parsing now recovers such barewords in object/array value position as strings, terminating at `,` / `}` / `]` / newline. Recovery deliberately refuses anything that could mask real structure or bad data — truncated values, tokens containing `"` / `{` / `[` or a key-like `:` (URL `://` and Windows `:\` colons stay literal), and non-finite atoms (`NaN`, `Infinity`, `undefined`) — and streaming partial parses still roll back unfinished barewords instead of committing them.

## [16.3.0] - 2026-07-02

### Added

- Added `wrapFetchForExtraCa` and `withExtraCaFetch` utility functions to apply `NODE_EXTRA_CA_CERTS` to Bun's `RequestInit.tls.ca` configuration.

## [16.2.9] - 2026-06-30

### Added

- Improved resilience in `fetchWithRetry()` by adding a response-body retry gate to handle deterministic provider failures that return retryable HTTP statuses.

### Fixed

- Fixed YAML frontmatter parsing for skill descriptions containing unquoted colons (`: `), ensuring typed fields are correctly preserved without triggering unnecessary warnings.

## [16.2.7] - 2026-06-30

### Added

- Added a utility to detect binary files based on content sniffing.

## [16.2.6] - 2026-06-29

### Added

- Added `stripWindowsExtendedLengthPathPrefix()` utility to normalize `\\?\` and native Win32 path prefixes before Bun import or spawn calls.

## [16.2.3] - 2026-06-28

### Added

- Added `escapeXmlAttribute` utility function for safe XML attribute value encoding.

### Fixed

- Fixed a crash in `ptree.ChildProcess.bytes()` and the `ssh://` read path when handling large subprocess outputs (over 128 KB) under Bun by ensuring it consistently returns a `Uint8Array`.

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

- Removed the public `createAbortableStream` API from `@oh-my-pi/pi-utils`. Consumers should use the lighter, direct-reader `abortableSource` async generator inside `@oh-my-pi/pi-utils/stream` to avoid the extra ReadableStream wrapper layer and per-chunk enqueue overhead.

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

- Added `installWorkerInbox(port)` / `consumeWorkerInbox()` to `@oh-my-pi/pi-utils/worker-host`. A self-dispatching CLI host that imports a Bun worker module dynamically attaches the worker's real `message` listener after Bun flushes the messages the parent posted before spawn, dropping a synchronously-posted `init`. The host installs this buffering inbox synchronously in the entry's sync prefix so a listener exists at flush time; the worker module consumes it and binds the real handler, replaying anything buffered.

## [15.13.1] - 2026-06-15

### Added

- Added profile-aware directory helpers and isolated profile state roots, while keeping the install ID shared across profiles.
- Added a named-profile API to the `dirs` module — `setProfile()`, `getActiveProfile()`, `getProfileRootDir()`, and `normalizeProfileName()` — plus `resolveProfileEnv()`, which selects the active profile from `OMP_PROFILE` (canonical; takes precedence) then `PI_PROFILE` (legacy fallback, consulted only when `OMP_PROFILE` is unset).
- Added support for a runtime `overrides` map in `RuntimeInstallSpec`, which is now written into generated runtime `package.json` manifests to force dependency pins (including transitive ones) across the runtime tree
- Added a lightweight loop-phase breadcrumb stack (`pushLoopPhase`/`popLoopPhase`/`currentLoopPhase`, plus `takeRecentLoopPhase` which returns the live phase or the most recently popped one and clears it) so the TUI event-loop watchdog can attribute a main-thread block to the phase that caused it — including a synchronous phase already popped before the watchdog's delayed tick runs ([#2485](https://github.com/can1357/oh-my-pi/issues/2485))
- Added `FetchWithRetryOptions.timeout` (forwarded to the underlying `fetch` call). `false` disables Bun's native ~300s pre-response timeout; a positive number overrides the ceiling. Bare browser/Node fetch ignores it ([#2422](https://github.com/can1357/oh-my-pi/issues/2422))
- Added the side-effect-free `@oh-my-pi/pi-utils/worker-host` module (`declareWorkerHostEntry()` / `workerHostEntry()`), extracted from `env` (still re-exported there) so worker spawn sites can resolve the self-dispatching CLI host entry without importing `env`'s side-effecting module graph.

### Fixed

- Fixed profile directory isolation when a profile's agent `.env` customizes directory roots: directory-affecting keys (`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`, and a default-mode `PI_CODING_AGENT_DIR`) are now honored. The `env` loader rebuilds the `dirs` resolver after applying `.env` files (`refreshDirsFromEnv()`), so a profile `.env` that points XDG roots elsewhere no longer leaks state into the home-based config dir.
- Made `TempDir` cleanup retry transient Windows `EBUSY`/`EPERM`/`ENOTEMPTY` removal failures so tests are less likely to fail when deleting just-used temp directories.
- Fixed `installRuntimeModuleResolver()` to keep bare requests from runtime-cache modules inside that registered runtime before falling back to host/workspace packages.

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
