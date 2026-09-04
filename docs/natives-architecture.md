# Natives Architecture

`@oh-my-pi/pi-natives` combines a JavaScript ESM loader with a Rust Node-API addon:

1. **Package/loader layer** selects, loads, and validates the correct `.node` addon, then exposes generated named ESM exports.
2. **Rust N-API layer** implements those exports and supplies napi-rs-generated TypeScript declarations.

## Authoritative files

- `packages/natives/package.json`
- `packages/natives/native/index.js` and `index.d.ts`
- `packages/natives/native/loader-state.js` and `loader-state.d.ts`
- `packages/natives/native/desktop.js` and `desktop.d.ts`
- `packages/natives/native/clipboard.js` and `clipboard.d.ts`
- `packages/natives/native/embedded-addon.js`
- `packages/natives/scripts/build-bindings.ts`
- `packages/natives/scripts/embed-native.ts`
- `packages/natives/scripts/gen-enums.ts`
- `packages/natives/scripts/gen-npm-packages.ts`
- `scripts/bazel-natives.ts`
- `crates/pi-natives/src/lib.rs` and its modules

## Package entrypoints

The package exports three entrypoints:

| Import                           | Runtime               | Types                   | Load behavior                                                                           |
| -------------------------------- | --------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `@oh-my-pi/pi-natives`           | `native/index.js`     | `native/index.d.ts`     | Loads the addon immediately, then binds every generated class/function and enum object. |
| `@oh-my-pi/pi-natives/desktop`   | `native/desktop.js`   | `native/desktop.d.ts`   | Exposes `createDesktopSession(options)` and defers addon loading until it is called.    |
| `@oh-my-pi/pi-natives/clipboard` | `native/clipboard.js` | `native/clipboard.d.ts` | Exposes lazy `copyToClipboard` and `readImageFromClipboard` wrappers.                   |

There is no `packages/natives/src` wrapper layer. Root consumers call generated N-API exports directly. The lazy subpaths exist so workers can import their JS wrapper without loading the large addon before the relevant operation initializes.

Current root capabilities include:

- search, globbing, workspace scans, AST matching/editing, code summaries, syntax highlighting, text layout, token counting, and structured diffs;
- shell, PTY, process, file-lock, isolation, and work-profile primitives;
- desktop capture/input/accessibility, clipboard, audio capture/playback, live WebRTC, device-check, SIXEL, snapcompact rendering, and vector ranking;
- PDF inspection/Markdown conversion, SVG rasterization, macOS spelling services, and in-process Git/Jujutsu operations.

## Loader and distribution

`native/index.js` calls `loadNative()` from `loader-state.js`. The platform tag is `${process.platform}-${process.arch}`. Supported tags are:

- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`
- `win32-x64`
- `win32-arm64`

x64 builds have `modern` (x86-64-v3/AVX2) and `baseline` (x86-64-v2) variants. `PI_NATIVE_VARIANT=modern|baseline` overrides automatic detection. Automatic detection reads `/proc/cpuinfo` on Linux, calls `sysctl` on macOS, or queries `System.Runtime.Intrinsics.X86.Avx2` in PowerShell on Windows. Its result is inherited by subsequent workers and child processes through the private `__PI_NATIVE_VARIANT_CACHE` environment entry. Non-x64 builds use an unsuffixed filename.

Filename fallback is:

- modern x64: `-modern.node`, then `-baseline.node`, then unsuffixed `.node`;
- baseline x64: `-baseline.node`, then unsuffixed `.node`;
- non-x64: unsuffixed `.node` only.

The published core package contains loader JS, declarations, and metadata but no `.node` files. Release publishing generates `@oh-my-pi/pi-natives-<platform>-<arch>` optional-dependency leaf packages and injects them at the same version into the core manifest. `LEAF_TARGETS` in `gen-npm-packages.ts` is the authoritative publish target list.

### Candidate ownership and order

For a normal installed package, the platform leaf is probed before the core package's `native/` directory and `process.execPath` directory. Workspace development skips leaf resolution so local artifacts win.

Compiled mode is detected by a populated embedded manifest, `PI_COMPILED`, or a Bun embedded marker in `import.meta.url`. It probes the versioned cache and legacy user-data directory before package/executable locations. `getNativesDir()` is `$XDG_DATA_HOME/omp/natives` only when `$XDG_DATA_HOME/omp` already exists; otherwise it is `~/.omp/natives`.

A populated manifest references `embedded-addons.<tag>.tar.gz`. Extraction allows only manifest-listed basename-only regular files, writes atomically into `<getNativesDir()>/<version>`, and validates file size. On Windows `node_modules` installs, the loader instead stages a leaf/core addon in that versioned directory so a running process does not lock the copy Bun must replace during an update.

After an addon loads successfully, the loader best-effort removes cache directories whose valid semantic version is older than the current package. The current, future, and non-semver directories remain.

## Load validation and runtime initialization

Every install or compiled candidate must expose the version sentinel computed from `package.json#version`, such as `__piNativesV17_2_5`. Workspace loads skip this check. The loader does not validate a complete symbol list.

After `require(...)` and sentinel validation, the loader calls `__ompInstallTokioRuntime()` when present. Rust deliberately avoids creating worker threads during `#[module_init]`, while the dynamic-loader lock is held. The post-load hook installs bounded Windows Tokio/Rayon pools; older addons without the hook use napi-rs defaults. Hook failure is best-effort and appears only in startup markers when enabled.

Set `PI_DEBUG_STARTUP` to emit synchronous `[startup]` markers to stderr around addon loading, extraction, and runtime installation.

## Rust module ownership

`crates/pi-natives/src/lib.rs` registers the current modules:

- platform/runtime: `appearance`, `clipboard`, `crash_handler`, `desktop`, `devicecheck`, `file_lock`, `iofs`, `power`, `prof`, `ps`, `pty`, `shell`, `spelling`, `tty_writer`, `vcs`;
- media/live: `audio`, `live`, `sixel`, `snapcompact`, `svg`;
- code/data: `ast`, `block`, `diff`, `fd`, `glob`, `glob_util`, `grep`, `highlight`, `html`, `keys`, `pdf`, `summary`, `text`, `tokens`, `utok`, `vectors`, `workspace`;
- isolation/task support: `iso`, `task`, plus N-API boundary/conversion helpers (`js`, crate-private `utils`, test-only `testing`);
- language metadata re-exported from `pi_ast::language`.

Rust `#[napi]` functions, classes, objects, and enums generate the declaration surface. Default snake_case Rust names become camelCase JavaScript names.

## Ownership boundaries

- **Package/scripts** own binary selection, CPU variants, optional leaf resolution, embedded extraction, Windows staging, declarations, and explicit ESM exports.
- **`pi-natives` and supporting crates** own algorithms, native resources, platform behavior, cancellation, and N-API conversion.
- **Consumers** own higher-level tool policy, rendering, artifacts, and user-facing fallbacks not encoded in a primitive.

For the supporting-crate map, see [`native-crates.md`](./native-crates.md). For exact loader diagnostics, see [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.md).

## Runtime flow

1. A consumer imports the eager root or a lazy subpath.
2. `loadNative()` computes mode, platform, variant, filenames, and ordered candidates.
3. Embedded extraction or Windows staging may prepend a cache candidate.
4. Candidates are required in order and install/compiled loads are sentinel-validated.
5. The optional post-load runtime hook runs, then stale cache versions are cleaned up best-effort.
6. The root binds generated named exports; lazy subpaths invoke selected bindings through wrappers.
7. Callers invoke N-API functions/classes; napi-rs performs argument and result conversion.
