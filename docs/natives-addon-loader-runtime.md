# Natives Addon Loader Runtime

This page documents `packages/natives/native/loader-state.js`, the runtime between an ESM entrypoint and a validated `pi_natives.*.node` addon.

## Entrypoints and eager/lazy loading

- `native/index.js` calls `loadNative()` at module evaluation and exposes the generated root API.
- `native/desktop.js`, `native/clipboard.js`, `native/path.js`, and `native/vcs.js` defer native loading. Desktop, path, and VCS wrappers cache their selected class/bindings; clipboard calls `loadNative()` on each invocation. Path helpers return their input unchanged without loading on non-Windows platforms.
- Pure loader helpers are exported for focused tests and do not perform detection or filesystem probing until `loadNative()` or `initLoaderContext()` is called.

A successful call is not memoized by JS. Repeated calls rely on the runtime's `require(...)` module cache, while post-load setup is idempotent or best-effort.

## Loader context

`initLoaderContext()` derives:

- `platformTag`: `${platform}-${process.arch}`;
- package version (the expected addon release, subject to the pre-sentinel compatibility exception below);
- package-local `nativeDir` and the directory of `process.execPath`;
- `nativesDir`, normally `~/.omp/natives`; it uses `$XDG_DATA_HOME/omp/natives` only when `$XDG_DATA_HOME/omp` exists;
- `versionedDir`: `<nativesDir>/<packageVersion>`;
- legacy compiled-binary directory: `%LOCALAPPDATA%/omp` (or `~/AppData/Local/omp`) on Windows, `~/.local/bin` elsewhere;
- workspace/install/compiled mode, optional leaf directory, Windows staging policy, CPU variant, filenames, and ordered candidates.

Compiled mode is true when a populated embedded manifest exists, `PI_COMPILED` is set, or `import.meta.url` contains a Bun embedded marker (`$bunfs`, `~BUN`, or `%7EBUN`). A non-compiled `nativeDir` outside a `node_modules` path is a workspace load. Windows path classification is case-insensitive; other platforms use case-sensitive path matching.

## Platforms and variants

Supported publish tags are:

- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`
- `win32-x64`
- `win32-arm64`

An unsupported tag is reported only after probing candidates.

For x64, `PI_NATIVE_VARIANT=modern|baseline` wins. Invalid values are ignored. Otherwise the private inherited `__PI_NATIVE_VARIANT_CACHE` result is used when valid; only then does the loader detect AVX2:

- Linux reads `/proc/cpuinfo`.
- macOS tries `/usr/sbin/sysctl` and then `sysctl`, querying `machdep.cpu.leaf7_features` and `machdep.cpu.features`.
- Windows under Bun first calls `kernel32.dll!IsProcessorFeaturePresent(40)` through `bun:ffi`. If FFI is unavailable, it tries non-interactive `pwsh.exe`, then `powershell.exe`, for `System.Runtime.Intrinsics.X86.Avx2`; absent/failed probes select baseline.

Detection uses `Bun.spawnSync` when available, then falls back to `node:child_process`. A detected result is written to the private cache environment entry so later workers/children inherit the same decision. Non-x64 does not use or populate a variant.

`getAddonFilenames()` returns:

| Runtime selection    | Ordered filenames                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------- |
| modern x64           | `pi_natives.<tag>-modern.node`, `pi_natives.<tag>-baseline.node`, `pi_natives.<tag>.node` |
| baseline x64         | `pi_natives.<tag>-baseline.node`, `pi_natives.<tag>.node`                                 |
| non-x64 / no variant | `pi_natives.<tag>.node`                                                                   |

## Candidate ordering

`resolveLoaderCandidates()` de-duplicates paths while retaining first occurrence.

### Installed, non-compiled package

1. Every selected filename in `@oh-my-pi/pi-natives-<tag>`.
2. For each filename, package-local `nativeDir`, then the executable directory.

The platform leaf wins over a stale core artifact. Workspace loads deliberately skip leaf resolution.

### Windows `node_modules` staging

When the platform is Windows, the runtime is non-compiled, and `nativeDir` contains a `node_modules` segment:

1. Every selected filename in `versionedDir`.
2. Leaf-package candidates.
3. Package-local and executable candidates.

Before probing, `maybeStageNodeModulesAddon()` copies each available filename from `leafPackageDir ?? nativeDir` to a missing cache target. Existing cache files are retained. This keeps the loaded DLL handle away from the package-manager copy that an update must replace. Directory/copy failures are recorded and normal probing continues.

### Compiled runtime

1. For each filename, `versionedDir`, then the legacy user-data directory.
2. For each filename, package-local `nativeDir`, then the executable directory.

A successfully selected embedded candidate is prepended. Windows staging is disabled in compiled mode.

## Embedded manifest and extraction

`embedded-addon.js` is reset to `embeddedAddon = null` in normal source/published-core state. `scripts/embed-native.ts` can generate a matching manifest containing:

- `platformTag` and package `version`;
- a gzip-compressed tar archive reference;
- `files[]` with `variant`, basename-only `filename`, and `size`.

Extraction runs only for compiled mode with matching platform and version and a selectable file. Selection is:

- non-x64: `default`, then first file;
- modern x64: `modern`, then `baseline`;
- baseline x64: `baseline` only.

The loader creates `versionedDir`. If every manifest file that needs extraction is already a regular file with the declared size, it reuses them. Otherwise it gunzips and parses the tar archive, rejecting unsafe names and non-regular entries, validating sizes for pending manifest files, and writing those files through a temporary file plus rename. Safe regular entries not pending in the manifest are ignored. Missing, truncated, unsafe, wrong-type, and wrong-size entries are errors. Older manifests without an archive can still provide per-file `filePath` metadata.

Extraction errors are accumulated; the loader continues to ordinary candidates.

## Candidate validation and post-load setup

For each candidate:

1. Emit a startup marker when enabled.
2. `require(candidate)`.
3. Unless this is workspace development, require `__piNativesBuildVersion()` to return the package version. The build pipeline writes that version into a fixed 64-byte slot (`PI_NATIVES_VERSION_STAMP:<version>` + NUL padding) after linking (`scripts/stamp-native-version.ts`, called from every `scripts/bazel-natives.ts` install, the local cargo build, and the Nix package build), so a release bump edits no Rust input. Addons published before the stamp expose a per-release `__piNativesV<version_with_underscores>` export instead; those are still read as their release for diagnosis.
4. Call `__ompInstallTokioRuntime()` if the addon provides it.
5. Best-effort remove valid semantic-version cache directories older than the current version.
6. Return the bindings.

The version error distinguishes a previous addon still resident in the current process from a stale file on disk. If the loaded exports report an older release but the candidate bytes contain the current stamp (`PI_NATIVES_VERSION_STAMP:<packageVersion>\0`), the diagnostic says to restart. Otherwise it says to reinstall. The loader does not validate all public exports. As a compatibility exception, an addon with no release identity is accepted if it has `countTokens`, `executeShell`, `visibleWidth`, and a `DesktopSession` with `capture`, `execute`, and `close`, and the candidate bytes do not carry the expected current stamp. An unstamped current addon that exposes the stamp reader is not eligible.

Workspace development skips the version check entirely, so a checkout that pulled a newer release boots before its rebuild. That tolerance is not silent: `native/index.js` uses `missingNativeExport(symbol)` for missing ordinary function exports (release-identity functions remain raw passthroughs), which is `undefined` on a current addon and a throwing stub on a stale one naming the symbol, the addon path, the loaded and expected releases, and `bun run build:native`. `nativeAddonStatus()` reports the same identity (`path`, `version`, `packageVersion`, `stale`) for callers that surface it themselves.

Rust module initialization installs crash diagnostics but does not spawn runtime threads under the dynamic-loader lock. The optional post-load hook installs bounded Windows Tokio and Rayon pools. It is best-effort; older addons or hook failures fall back to napi-rs behavior. Set `PI_DEBUG_STARTUP` to emit synchronous `[startup]` markers to stderr, including hook success/failure.

Cache cleanup ignores read/delete failures and removes only directories named with an older `major.minor.patch` release and an mtime at least ten minutes old. `prepareNativeVersionDir()` refreshes the directory mtime before extraction or staging to protect concurrent starts. Cleanup preserves current/future versions, prerelease/non-version names, ordinary files, and recently active directories.

## Failure diagnostics

If no candidate succeeds:

- an unsupported tag throws `Unsupported platform: <tag>`, the supported list, and issue guidance;
- a supported tag throws `Failed to load pi_natives native addon for <tag>` (including the x64 variant), followed by every candidate/preparation error and mode-specific help.

Compiled help lists expected cache paths, suggests deleting the versioned directory, and prints release-download `curl` commands. Installed-package help suggests reinstalling, the local host build (`bun --cwd=packages/natives run build`), and explicit `scripts/bazel-natives.ts <target> --dest packages/natives/native` builds.

## Lifecycle

```text
entrypoint evaluates or lazy wrapper is invoked
  -> initialize loader context
  -> extract matching embedded archive, if any
  -> otherwise stage Windows node_modules addon, if applicable
  -> require candidates in deterministic order
       -> validate release stamp outside workspace development
       -> install optional post-load runtime; record addon identity
       -> best-effort clean older version caches
       -> return bindings
  -> no success: throw unsupported-platform or aggregated load error
```
