# Natives Addon Loader Runtime

This document covers the runtime loader shipped by `@pk-nerdsaver-ai/pi-natives`: how `native/index.js` decides which `.node` file to require, how compiled-binary embedded payloads are extracted, and what startup failures report.

## Implementation files

- `packages/natives/native/index.js`
- `packages/natives/native/loader-state.js`
- `packages/natives/native/embedded-addon.js`
- `packages/natives/scripts/embed-native.ts`
- `packages/natives/package.json`

## Scope and responsibility

The loader is intentionally narrow:

- Build a platform/CPU-aware candidate list for addon filenames and directories.
- Treat an embedded-addon manifest as a compiled-binary signal when present.
- Optionally materialize embedded addon archive contents into a versioned per-user cache directory.
- On Windows `node_modules` installs, stage addon files into the versioned cache to avoid locked-DLL update failures.
- Attempt candidates in deterministic order and return the first addon that `require(...)` loads and validates.

For install and compiled-binary paths, the loader verifies a release sentinel export named from `package.json#version` (for example `__piNativesV16_0_3`). Workspace-dev loads skip this validation so a local checkout can rebuild after a pull. The loader does not validate the full export surface; stale same-version or incomplete binaries still surface as missing members or native errors at use sites.

## Runtime inputs and derived state

At module initialization, `native/index.js` computes:

- **Platform tag**: `${process.platform}-${process.arch}` (for example `darwin-arm64`).
- **Package version**: from `packages/natives/package.json`.
- **Core directories**:
  - `leafPackageDir`: directory of the platform leaf package, resolved via `require.resolve("@pk-nerdsaver-ai/pi-natives-<tag>/package.json")`; `null` when no leaf is installed (e.g. local dev) and forced to `null` in compiled-binary mode.
  - `nativeDir`: package-local `packages/natives/native`.
  - `execDir`: directory containing `process.execPath`.
  - `versionedDir`: `<getNativesDir()>/<packageVersion>`.
  - `userDataDir` fallback:
    - Windows: `%LOCALAPPDATA%/omp` or `%USERPROFILE%/AppData/Local/omp`.
    - Non-Windows: `~/.local/bin`.
- **Natives cache root** (`getNativesDir()`):
  - if `$XDG_DATA_HOME/omp` exists, `$XDG_DATA_HOME/omp/natives`;
  - otherwise `~/.ompk/natives`.
- **Compiled-binary mode** (`detectCompiledBinary`): true if any of:
  - embedded-addon manifest is non-null,
  - `PI_COMPILED` env var is set,
  - `import.meta.url` contains Bun embedded markers (`$bunfs`, `~BUN`, `%7EBUN`).
- **Windows staging mode** (`shouldStageNodeModulesAddon`): true only on Windows, in non-compiled mode, when `nativeDir` is inside `node_modules`.
- **Variant override**: `PI_NATIVE_VARIANT` (`modern`/`baseline` only; invalid values ignored).
- **Selected variant**: explicit override, otherwise runtime AVX2 detection on x64 (`modern` if AVX2, else `baseline`).

## Platform support and tag resolution

`SUPPORTED_PLATFORMS` is fixed to:

- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`
- `win32-x64`

Unsupported platforms are not rejected before probing. The loader first tries the computed candidate paths. If all fail and `platformTag` is unsupported, it throws an unsupported-platform error listing supported tags.

## Variant selection (`modern` / `baseline` / default)

### x64 behavior

1. `PI_NATIVE_VARIANT=modern|baseline` wins when valid.
2. Otherwise AVX2 support is detected:
   - Linux: scan `/proc/cpuinfo` for `avx2`.
   - macOS: `sysctl -n machdep.cpu.leaf7_features`, then `machdep.cpu.features`.
   - Windows: PowerShell `[System.Runtime.Intrinsics.X86.Avx2]::IsSupported`.
3. AVX2 selects `modern`; unavailable or undetectable AVX2 selects `baseline`.

### Non-x64 behavior

No variant suffix is used; the filename is `pi_natives.<platform>-<arch>.node`.

### Filename construction

`loader-state.js#getAddonFilenames` returns:

- Non-x64 or no variant: `pi_natives.<tag>.node`
- x64 + `modern`:
  1. `pi_natives.<tag>-modern.node`
  2. `pi_natives.<tag>-baseline.node`
  3. `pi_natives.<tag>.node`
- x64 + `baseline`:
  1. `pi_natives.<tag>-baseline.node`
  2. `pi_natives.<tag>.node`

The default unsuffixed fallback remains part of the x64 candidate list.

## Candidate path construction and fallback ordering

`resolveLoaderCandidates(...)` expands every filename across directories, then de-duplicates while preserving first occurrence order.

### Non-compiled runtime

Candidates are grouped by directory class, in order:

1. `<leafPackageDir>/<filename>` for every filename (omitted when `leafPackageDir` is `null`)
2. `<nativeDir>/<filename>` then `<execDir>/<filename>`, per filename

The leaf package dir comes first so the optional-dependency binary published with the release is preferred over any `.node` left in the core package's `native/` (e.g. a stale local-dev build).

On Windows installs where `nativeDir` is inside a `node_modules` segment (`shouldStageNodeModulesAddon`), `<versionedDir>/<filename>` staging candidates are prepended ahead of the leaf candidates so a locked `node_modules` binary can be sidestepped during `bun install -g` updates. The staged file is copied from `leafPackageDir ?? nativeDir` before probing.

### Compiled runtime

Candidates are grouped, in order:

1. `<versionedDir>/<filename>` then `<userDataDir>/<filename>`, per filename
2. `<nativeDir>/<filename>` then `<execDir>/<filename>`, per filename

At load time, an extracted embedded candidate, or a staged Windows candidate when no embedded candidate exists, is prepended ahead of these de-duplicated candidates.

## Embedded addon extraction lifecycle

`embedded-addon.js` is generated by `scripts/embed-native.ts`. The reset stub exports `embeddedAddon = null`. A populated manifest has:

- `platformTag`
- `version`
- `archive`: `{ format: "tar.gz", filename, filePath }`
- `files[]` entries with `variant`, `filename`, and `size`

Extraction (`maybeExtractEmbeddedAddon`) runs only when:

1. compiled-binary mode is true,
2. `embeddedAddon` is non-null,
3. manifest `platformTag` equals the runtime platform tag,
4. manifest `version` equals the package version,
5. a variant-appropriate embedded file exists.

Variant file selection:

- Non-x64: prefer `default`, then first available file.
- x64 + `modern`: prefer `modern`, fallback to `baseline`.
- x64 + `baseline`: require `baseline`.

Materialization:

1. Ensure `<versionedDir>` exists.
2. Select `<versionedDir>/<selected filename>`.
3. If the current cached file exists and its size matches manifest metadata, reuse it.
4. Otherwise extract `embeddedAddon.archive.filePath` into `<versionedDir>` using the manifest `files[]` allowlist.
5. Verify the selected target by size and return it as the first candidate.

Archive, directory, or write failures are appended to the loader error list; probing continues through normal candidates.

## Lifecycle and state transitions

```text
Init
  -> Load package metadata and embedded-addon manifest
  -> Compute platform/version/variant/filenames/candidate paths
  -> (compiled + embedded manifest matches?)
       yes -> extract archive to versionedDir when needed (record errors, continue)
       no  -> skip extraction
  -> (Windows non-compiled node_modules install and no embedded candidate?)
       yes -> stage leaf/core addon to versionedDir (record errors, continue)
       no  -> skip staging
  -> For each runtime candidate in order:
       require(candidate)
       -> sentinel validation passes or is workspace-dev: return addon exports (READY)
       -> failure: record error, continue
  -> none loaded:
       if unsupported platform tag -> throw Unsupported platform
       else -> throw Failed to load (tried-path diagnostics + hints)
```

## Failure behavior and diagnostics

### Unsupported platform

If all candidates fail and `platformTag` is not supported, the loader throws:

- `Unsupported platform: <tag>`
- supported platform list
- issue-reporting guidance

### No loadable candidate

If the platform is supported but no candidate can be loaded, the final error includes:

- `Failed to load pi_natives native addon for <platformTag>` or `<platformTag> (<variant>)`
- every attempted path with the corresponding `require(...)` or sentinel-validation error
- mode-specific remediation hints

### Compiled-binary startup failures

Compiled mode diagnostics include:

- expected versioned cache target paths (`<versionedDir>/<filename>`),
- remediation to delete the versioned cache and rerun,
- direct release download `curl` commands for each expected filename.
- release sentinel mismatch details when a loadable `.node` belongs to another `@pk-nerdsaver-ai/pi-natives` version.

### Non-compiled startup failures

Normal package/runtime diagnostics include:

- reinstall hint (`bun install @pk-nerdsaver-ai/pi-natives`),
- local rebuild command (`bun --cwd=packages/natives run build`),
- optional x64 variant build hint (`TARGET_VARIANT=baseline|modern bun --cwd=packages/natives run build`).
