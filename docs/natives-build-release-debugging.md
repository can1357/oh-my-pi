# Natives Build, Release, and Debugging Runbook

This runbook describes how `@oh-my-pi/pi-natives` produces `.node` addons, generated declarations, and compiled-binary embedded payloads, and how to debug loader/build failures.

Addon **artifacts are built by Bazel** (`rules_rust` + `crate_universe` + hermetic cc toolchains); the cargo workspace stays authoritative for local Rust iteration (rust-analyzer, `cargo nextest`) and for napi typedef regeneration. Runtime loading and embedding are unchanged.

It follows the architecture terms from `docs/natives-architecture.md`:

- **build-time artifact production** (Bazel `//:natives-<target>` via `scripts/bazel-natives.ts`)
- **embedded addon manifest generation** (`scripts/embed-native.ts`)
- **runtime addon loading** (`native/index.js`, `native/loader-state.js`)

## Implementation files

Build side:

- `BUILD.bazel` (root) — the eight `//:natives-<target>` addon targets + aggregate filegroups
- `bazel/defs.bzl` — the `native_addon` rule/transition
- `bazel/platforms/BUILD.bazel` — one `platform()` per shipped addon
- `bazel/variants/BUILD.bazel` — `baseline`/`modern` ISA constraint values
- `bazel/toolchains/` — musl rustc disambiguation + the msvc cross cc toolchain (`msvc/NOTES.md`)
- `bazel/clippy.bazelrc` — generated from `[workspace.lints]` in `Cargo.toml`
- `MODULE.bazel`, `MODULE.bazel.lock`, `.bazelrc`, `.bazelversion` (Bazel 9.2.0)
- `scripts/bazel-natives.ts` — the canonical driver (build + locate + install)
- `crates/pi-natives/BUILD.bazel`, `crates/pi-natives/Cargo.toml`

Package side (unchanged runtime/packaging):

- `packages/natives/scripts/build-bindings.ts` — dev-only typedef regeneration
- `packages/natives/scripts/embed-native.ts`, `gen-enums.ts`, `gen-npm-packages.ts`
- `packages/natives/package.json`
- `packages/natives/native/index.js`, `native/loader-state.js`

## Build architecture

### 1) `//:natives-<target>` addon targets

Root `BUILD.bazel` instantiates one `native_addon` per shipped `(platform, arch, ISA-variant)`:

| Target                               | Platform                                    | Canonical output                      |
| ------------------------------------ | ------------------------------------------- | ------------------------------------- |
| `//:natives-linux-x64-baseline`      | `//bazel/platforms:linux-x64-baseline`      | `pi_natives.linux-x64-baseline.node`  |
| `//:natives-linux-x64-modern`        | `//bazel/platforms:linux-x64-modern`        | `pi_natives.linux-x64-modern.node`    |
| `//:natives-linux-arm64`             | `//bazel/platforms:linux-arm64`             | `pi_natives.linux-arm64.node`         |
| `//:natives-linux-musl-x64-baseline` | `//bazel/platforms:linux-musl-x64-baseline` | `pi_natives.linux-x64-baseline.node`  |
| `//:natives-linux-musl-arm64`        | `//bazel/platforms:linux-musl-arm64`        | `pi_natives.linux-arm64.node`         |
| `//:natives-darwin-x64-baseline`     | `//bazel/platforms:darwin-x64-baseline`     | `pi_natives.darwin-x64-baseline.node` |
| `//:natives-darwin-arm64`            | `//bazel/platforms:darwin-arm64`            | `pi_natives.darwin-arm64.node`        |
| `//:natives-win32-x64-baseline`      | `//bazel/platforms:win32-x64-baseline`      | `pi_natives.win32-x64-baseline.node`  |

Notes:

- musl addons **intentionally reuse** the plain `linux-<arch>` filenames — the loader never sees gnu and musl side by side; release jobs keep them in separate invocations/dest dirs (`scripts/bazel-natives.ts` hard-errors on a basename collision within one run).
- Aggregates: `//:natives-linux-all` (all linux targets + the msvc cross build, i.e. everything buildable from a linux-x64 host) and `//:natives-darwin-all` (mac hosts only).

### 2) `native_addon` rule (`bazel/defs.bzl`)

`native_addon` wraps `//crates/pi-natives:pi_natives` (a `rust_shared_library`) in a configuration transition that pins, per target:

- `--platforms=<the addon's platform>`
- `--compilation_mode=opt`
- `@rules_rust//rust/settings:lto=thin`
- extra rustc flags `-Ccodegen-units=16 -Cstrip=symbols`

This mirrors the old cargo `ci` profile. Because the profile lives **in the transition**, a bare `bazel build //:natives-<t>` is always release-grade regardless of `-c`, and every addon shares one cache entry per (platform, source) pair. The rule then symlinks the produced shared library to the loader's canonical `pi_natives.<platform>-<arch>[-<variant>].node` name, scoped under the rule name (`bazel-bin/natives-<t>/…`) so gnu/musl outputs with identical basenames cannot collide at the package level.

Per-target codegen that is not part of the transition lives in `crates/pi-natives/BUILD.bazel` `rustc_flags` selects: `-Ctarget-cpu=x86-64-v2` (baseline) / `x86-64-v3` (modern) via `//bazel/variants`, the napi link args (`-Wl,-undefined,dynamic_lookup` on macOS, `-Wl,-z,nodelete` on linux — `build.rs`/`napi_build::setup()` is deliberately not wired in), `-Ctarget-feature=-crt-static` for musl, and `-Ctarget-feature=+crt-static` for win32-x64 msvc (paired with the `static_link_msvcrt` cc feature enabled in the `native_addon` transition so the C deps compile `/MT` in lock-step — the shipped `.node` then imports no `VCRUNTIME140.dll` from the VC++ Redistributable).

### 3) Platforms and toolchains

| Target family          | cc toolchain                                                               | Notes                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| linux gnu (x64/arm64)  | `@zig_sdk//libc_aware/toolchain:linux_*_gnu.2.17` (hermetic zig cc)        | glibc **2.17** portability floor — same floor the previous cross builds used                          |
| linux musl (x64/arm64) | `@zig_sdk//libc_aware/toolchain:linux_*_musl`                              | dynamic CRT (`-Ctarget-feature=-crt-static` in the crate BUILD)                                       |
| darwin (x64/arm64)     | host Xcode toolchain                                                       | Apple frameworks aren't redistributable; darwin addons build on mac hosts only                        |
| win32-x64 msvc         | `//bazel/toolchains/msvc` (`@msvc_cc`): clang-cl + lld-link + xwin CRT/SDK | hermetic cross-link from linux-x64 CI pods and darwin dev hosts; **static CRT** (`+crt-static` + `static_link_msvcrt`) so the addon needs no VC++ Redistributable; see `bazel/toolchains/msvc/NOTES.md` |

Rust toolchains are nightly (pinned in `MODULE.bazel`), with repo-local musl re-registrations in `//bazel/toolchains` carrying an explicit `@zig_sdk//libc:musl` constraint (rules_rust's generated gnu and musl toolchains otherwise share (os, cpu) constraints).

### 4) Third-party crates (`crate_universe`)

`@crates//...` is generated from the workspace `Cargo.toml`/`Cargo.lock`, restricted to exactly the seven shipped triples. Crate-specific build fixes live as `crate.annotation`s in `MODULE.bazel` (see the debugging playbook below).

The root module intentionally omits `crate_universe`'s optional rendering lock. The first evaluation after crate inputs change splices the workspace and generates external repository specs from the pinned `Cargo.lock`; Bazel records that extension result in `MODULE.bazel.lock`, so later clean output bases reuse it. Cargo manifest, lock, and annotation edits therefore require no separate repin step.

## Local development

### Building addons

```bash
# Addon for the current host (x64 hosts pick modern vs baseline via AVX2
# detection), installed into packages/natives/native/. The host target builds
# through the local cargo/napi-rs backend by default; set
# OMP_NATIVE_BUILD_BACKEND=bazel (or pass bazel args after `--`) for bazel:
bun --cwd=packages/natives run build          # = bun ../../scripts/bazel-natives.ts host --dest native
# same, from the repo root:
bun run build:native

# The driver directly — targets are //:natives-* names plus pseudo-targets
# host / linux-all / darwin-all:
bun scripts/bazel-natives.ts <target>... [--dest <dir>] [-- <extra bazel args>]
bun scripts/bazel-natives.ts linux-x64-baseline linux-x64-modern --dest packages/natives/native
bun scripts/bazel-natives.ts darwin-all

# Or bazelisk directly (outputs stay in bazel-bin, nothing is installed):
bazelisk build //:natives-darwin-arm64
bazelisk build //:natives-linux-all
```

The driver builds `host` through the local cargo/napi-rs path (`packages/natives/scripts/build-bindings.ts`) unless bazel is requested via `OMP_NATIVE_BUILD_BACKEND=bazel` or extra bazel args. For explicit targets it runs one `bazel build` for all requested targets, locates outputs via `bazel cquery --output=files` (falling back to the `bazel-bin/natives-<t>/<canonical>.node` path convention), and copies them dereferenced into `--dest` (default `packages/natives/native`). Extra args after `--` go to bazel verbatim. It resolves `bazelisk` (or `bazel`) from `PATH` and honors an `OMP_BAZEL_RC` env var as a `--bazelrc=` startup option (that's how CI injects cache wiring).

Building `linux-all` into one dest would clobber gnu addons with musl ones (shared basenames) — the driver refuses; use separate invocations with separate `--dest` dirs.

### Typedef regeneration (napi CLI, dev-only)

`native/index.js`/`index.d.ts` are **committed**, so Bazel artifact builds never need the napi CLI. Only when the Rust API surface changes its exported typedefs:

```bash
bun --cwd=packages/natives run build:bindings   # = bun scripts/build-bindings.ts
```

This runs the napi CLI (host-only, local cargo profile) against `crates/pi-natives`, installs the regenerated `index.d.ts`, normalizes the addon filename, and re-renders the explicit ESM exports + runtime enum objects via `gen-enums.ts`. Commit the resulting `index.js`/`index.d.ts` changes.

### Opt-in remote cache (`.bazelrc.user`)

`.bazelrc` ends with `try-import %workspace%/.bazelrc.user` (gitignored). The bazel-remote endpoint is cluster-internal only; if you can reach it (VPN/tailnet), wire it read-only:

```
# .bazelrc.user
build --config=cache-ro
build --remote_cache=grpcs://bazel-remote.bazel-cache.svc.cluster.local:9092
build --tls_certificate=infra/bazel-remote/ca.crt
```

`cache-ro`/`cache-rw` in `.bazelrc` carry only policy (upload on/off, `--remote_local_fallback`, retries/timeout so a cache outage never fails the build); endpoint + credentials are always composed by the consumer. A plain `--disk_cache=<dir>` line also works fine here.

## CI

### Split Rust validation and addon production

`.github/workflows/ci.yml` separates `rust_validate` from `native_addons`; TypeScript jobs depend only on `native_addons`.

**Pull requests never build or validate Rust.** Native-affecting PRs are rare enough that they don't warrant a PR-side bazel build: `rust_validate` is skipped entirely (`if: github.event_name != 'pull_request'`), and `native_addons` fetches the latest release's Linux x64 addon pair from the `@oh-my-pi/pi-natives-linux-x64` npm leaf, smoke-loads both, and uploads them as the `native-addons` workflow artifact. The loader skips its version sentinel for workspace loads, so release-versioned addons load fine under a newer checkout. A PR whose TypeScript tests depend on changed native behavior fails visibly (and CI emits a notice on any native-touching PR); the Rust side is validated post-merge on main and again at release.

On non-PR events both jobs run on `omp-kata` pods against the cluster remote cache. `rust_validate` runs:

```bash
bazelisk --bazelrc="$rc" test //crates/...                 # full Rust suite
# clippy scope mirrors `cargo clippy --workspace` (libraries only), split by
# lint policy via a query kind filter:
bazelisk query "kind('rust_library|rust_shared_library', //crates/pi-ast/... + //crates/pi-iso/... + //crates/pi-natives/... + //crates/pi-shell/... + //crates/pi-voice/... + //crates/pi-walker/...)" \
  | xargs bazelisk --bazelrc="$rc" build --config=clippy-strict --
bazelisk query "kind('rust_library|rust_shared_library', //crates/... - (…strict set…) - //crates/vendor/brush-core/... - //crates/pi-builtins/...)" \
  | xargs bazelisk --bazelrc="$rc" build --config=clippy --
bazelisk --bazelrc="$rc" build --config=rustfmt //crates/...
```

- `--config=clippy` = rules_rust clippy aspect + `-Dwarnings`; `--config=clippy-strict` layers the generated `bazel/clippy.bazelrc` for crates with `[lints] workspace = true`.
- `--config=rustfmt` = rustfmt aspect against the workspace `rustfmt.toml`.

`native_addons` on main builds the six Linux-hosted targets one at a time to avoid concurrent-link OOMs, then builds `//:natives-linux-all` as an aggregate consistency check. It uploads every `.node` output as the `native-addons` workflow artifact. Downstream jobs use `.github/actions/native-artifacts` to download that artifact and install the requested target set without invoking Bazel.

No toolchain setup steps are required for native jobs: bazelisk is on the GitHub images and baked into the kata runner image; Bazel fetches Rust/zig/LLVM/xwin hermetically.

### Hosted cache warmer

`.github/workflows/bazel-cache-warm.yml` seeds the GitHub-hosted caches that have no other reliable producer: the `release-darwin-*` bazel disk caches (built on the same macOS images as the `release_binary_darwin` matrix, so a release's bazel build is the version-bump delta instead of a ~40-min cold graph) and the shared bun store entry PR jobs restore but never save. It triggers only on pushes that can change those archives (crate/bazel/lock inputs, `bun.lock`, `.github/**`).

### `bazel-cache` action (`.github/actions/bazel-cache`)

Single source of truth for cache wiring, emitted as a bazelrc fragment (its `rc` output) that consumers pass via `bazelisk --bazelrc=...` or `OMP_BAZEL_RC`. Two modes are selected via `BAZEL_REMOTE_USER`/`BAZEL_REMOTE_PASSWORD`:

| Runner        | Fragment contents                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| omp-kata pod  | A temporary output root, `--config=ci`, the PVC-backed repository/xwin caches, `--config=cache-rw`, the in-cluster TLS remote-cache endpoint and masked Basic-auth header, plus `--remote_download_toplevel` |
| GitHub-hosted | `--config=ci`, `--disk_cache=$HOME/.cache/omp-bazel-disk`, and `--repository_cache=$HOME/.cache/omp-bazel-repo`                                                                                              |

Hosted disk caches use `bazel-disk-v3-<scope>-<os>-<arch>-<config-hash>-<source-hash>`. The config hash covers Cargo/Bazel/toolchain settings; the source hash covers `crates/**` and root `BUILD.bazel`. Restores fall back from the exact key to the config-scoped prefix, then to a bare `<scope>-<os>-<arch>` prefix — the bare fallback is what keeps release version bumps (which rewrite `Cargo.toml`/`Cargo.lock` and thus the config hash) from rebuilding cold; bazel's content-addressed action keys make a stale archive a partial hit, never a wrong output. An inexact restore permits one refreshed exact-key save. Before a hosted build, disk-cache files untouched for 14 days are pruned; repository-cache contents are deliberately not age-pruned because extracted files retain upstream mtimes. The remote endpoint resolves only inside the cluster.

### Native artifact actions

`.github/actions/bazel-natives` is the direct builder: `bazel-cache` → `OMP_BAZEL_RC=<rc> bun scripts/bazel-natives.ts <targets> --dest <dest>`, followed by a disk-cache save after a hosted miss. `.github/actions/native-artifacts` is the no-build consumer: download `native-addons` → run the same driver with `--source`.

### Release binary builds and publishing

Binary builds are build-only and run in parallel with the test fan-out. `release_binary` (Linux + Windows matrices) needs only `native_addons`, whose workflow artifact supplies their addons. `release_binary_darwin` needs only `release_metadata` and starts the moment a release run is detected: darwin artifacts cannot be cross-built on Linux, so each macOS leg builds its own architecture through `bazel-natives` with scope `release-<target_id>` (seeded near HEAD by the warm workflow — normally just the version-bump delta), then `bun run ci:release:build-binaries` embeds and compiles the executable. Publishing is held behind `release_gate` (the aggregate of every validation job): `release_native_leaves` downloads all built addons and publishes the five `@oh-my-pi/pi-natives-<tag>` leaves from one linux runner, and the GitHub release / verify / core npm chain runs beside it.

## Debugging playbook

### Where things land / how to inspect

```bash
# Outputs (workspace-relative): bazel-bin/natives-<target>/pi_natives.<...>.node
bazelisk cquery --output=files //:natives-linux-x64-baseline

# What actions/flags a target produces (add the same --config flags as the build):
bazelisk aquery 'outputs(".*\.node", deps(//:natives-linux-arm64))'
bazelisk aquery 'mnemonic("Rustc", deps(//crates/pi-natives:pi_natives))'

# Which toolchain resolved (e.g. confirm @msvc_cc, not host cc, for win32):
bazelisk cquery 'deps(//:natives-win32-x64-baseline)' | grep msvc_cc

# Keep the sandbox dir + print the full command line of a failing action:
bazelisk build --sandbox_debug --verbose_failures //:natives-<t>

# Analyze without building (cheap cross-target sanity check):
bazelisk build --nobuild //:natives-win32-x64-baseline
```

`scripts/bazel-natives.ts` streams bazel stderr live and repeats a 40-line tail on failure; when its cquery step fails it falls back to the `bazel-bin` path convention.

### Common failure classes (seen during bring-up — fixes already in tree, cite when they resurface)

| Symptom                                                                                        | Cause                                                                                                | Fix (in tree)                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| musl build "succeeds" but emits no `.node`                                                     | musl defaults to `+crt-static`; rustc silently emits no cdylib                                       | `-Ctarget-feature=-crt-static` select in `crates/pi-natives/BUILD.bazel`                                                                                                       |
| opus/cmake `try_compile` fails linking UBSan runtime                                           | zig cc enables UBSan by default; cmake's test exe links with the raw wrapper (no toolchain features) | `CFLAGS=-fno-sanitize=undefined` in the `audiopus_sys` annotation (`MODULE.bazel`)                                                                                             |
| `tree-sitter-just` scanner.c `#error` under opt                                                | scanner hard-errors when `NDEBUG` is set (opt-mode cc default)                                       | `CFLAGS=-UNDEBUG` annotation (cc-rs appends env CFLAGS last, so `-U` wins)                                                                                                     |
| rstest macro: "Cargo.toml not found" in a vendored test                                        | rstest verifies `Cargo.toml` exists in the manifest dir                                              | `compile_data = ["Cargo.toml"]` on the `rust_test` (see `crates/vendor/uu-tail/BUILD.bazel`)                                                                                   |
| vendored tests fail on bare `test_data/...` paths / symlink into srcs                          | tests assume cargo's cwd, incompatible with runfiles execution                                       | `tags = ["manual"]`; run via `cargo nextest` when touching the fork; hermetic sibling test covers the contract                   |
| blake3 msvc: `ml64.exe` not found                                                              | cc-rs resolves MASM from build-script PATH on non-windows hosts                                      | `bin/ml64.exe → llvm-ml -m64` shim in `@msvc_cc`, prepended via the `blake3` annotation PATH                                                                                   |
| audiopus_sys msvc: cmake demands VS generator / rc+mt tools; `try_compile` wants `msvcrtd.lib` | cross cmake on linux/mac hosts; Debug config → `/MDd` which the lean xwin splat lacks                | `CMAKE_GENERATOR_x86_64_pc_windows_msvc=Ninja` + `@msvc_cc`'s `toolchain.cmake` (`CMAKE_TOOLCHAIN_FILE_x86_64_pc_windows_msvc`) pinning wrappers + Release try-compile + `/MT` (static CRT, matches the addon policy) |
| win32 link oddities generally                                                                  | —                                                                                                    | read `bazel/toolchains/msvc/NOTES.md` first: wrapper self-location, `lld-link` flavor/driver-link behavior, `LIB`, `/MD` CRT choice, xwin splat caveats                        |
| `rust_test(crate = ...)` "can't find crate" at macro expansion                                 | rmeta-only pipelined deps break macro_rules re-export harness compiles                               | rust pipelined_compilation stays OFF (`.bazelrc` note)                                                                                                                         |
| build script can't find cmake/ninja                                                            | `--incompatible_strict_action_env` — no host env leaks                                               | explicit `PATH` in the crate annotation (`MODULE.bazel`), not host env                                                                                                         |

### Cache behavior

- **omp-kata:** read-write gRPC to the in-cluster bazel-remote (`grpcs://bazel-remote.bazel-cache.svc.cluster.local:9092`, TLS via the committed `infra/bazel-remote/ca.crt`, htpasswd user `ci`). `--remote_local_fallback` plus retries make an outage degrade to local execution rather than fail the build.
- **GitHub-hosted:** no cluster access; only the darwin release/warm jobs build with bazel here. The v3 `actions/cache` disk key separates config and source generations with prefix + bare fallbacks (see the `bazel-cache` action section above); `.github/workflows/bazel-cache-warm.yml` publishes the `release-darwin-*` archives from the same macOS images as the release consumers.
- **msvc repos:** the ~2 GiB LLVM download is sha256-pinned and repository-cache backed; the ~1 GiB xwin CRT/SDK splat is fetched from the Microsoft CDN inside the repo rule and is **not** repo-cache backed — a cold output base re-downloads it. Microsoft advances the VS channel payload over time, so remote-cache hit rates for win32 actions degrade gracefully after an MS bump (same property the previous cross toolchain had). Win32 link actions also don't share cache entries across host OSes (linux vs mac clang binaries).
- Server-side operations (deploy, TLS/auth, egress, poisoning boundary): `infra/docs/04-arc-and-caching.md` §5.

## Target/variant model and naming conventions

## Platform tag

Both build and runtime use platform tag:

`<platform>-<arch>` (example: `darwin-arm64`, `linux-x64`).

## Variant model (x64 only)

x64 supports CPU variants, encoded as `//bazel/variants` constraint values on the platform (baseline → `-Ctarget-cpu=x86-64-v2`, modern → `x86-64-v3`):

- `modern` (AVX2-capable path)
- `baseline` (fallback)

Non-x64 uses a single default artifact with no variant suffix. There is no build-time variant _switch_: each variant is its own `//:natives-*` target, and the `host` pseudo-target picks modern vs baseline via AVX2 detection.

### Output filenames

- x64: `pi_natives.<platform>-<arch>-modern.node` or `...-baseline.node`
- non-x64: `pi_natives.<platform>-<arch>.node`

Runtime x64 candidate order also includes the unsuffixed default filename after the selected variant candidates.

## Runtime flags

- `PI_NATIVE_VARIANT`: x64 runtime override; valid values are `modern` and `baseline`. Invalid values are ignored and normal detection runs.
- `PI_DEBUG_STARTUP`: writes synchronous `[startup] native:…` markers to stderr around loader entry, embedded extraction, candidate loads, and native Tokio runtime installation; use it to localize startup hangs.
- `PI_COMPILED`: compiled-mode signal. Release compilation constant-folds `process.env.PI_COMPILED` to `"true"`; a populated embedded-addon manifest and Bun embedded URL markers also signal compiled mode.

## Embed lifecycle (`embed-native.ts`)

1. **Init**: compute the platform tag (host values, overridable by the release packaging script for cross-target archives).
2. **Candidate set**:
   - x64 looks for `modern` and `baseline` files;
   - non-x64 looks for one default file.
3. **Validate availability**: at least one expected file must exist in `packages/natives/native`.
4. **Generate archive + manifest**: write `native/embedded-addons.<platform>-<arch>.tar.gz` containing all available target addon files and `native/embedded-addon.js` with package version, archive metadata, and file sizes.
5. **Runtime extraction ready** for compiled mode.

`--reset` writes the null manifest stub (`embeddedAddon = null`) without validating addon availability, and deletes any existing `embedded-addons.*.tar.gz` archives from `native/`.

## Dev workflow vs shipped/compiled behavior

## Local development workflow

Typical local loop:

1. Build addon: `bun --cwd=packages/natives run build`.
2. Loader resolves platform npm leaf-package candidates (`@oh-my-pi/pi-natives-<platform>-<arch>`, when resolvable), then package-local `native/` and executable-dir fallback candidates.
3. Generated declarations in `native/index.d.ts` describe the public TS API (regenerate with `build:bindings` only when the Rust API surface changes).
4. On Windows package installs, the loader first copies a `node_modules` addon into the versioned cache so a running process does not lock the file Bun must replace during a later global update.
5. After a successful load, older semver-shaped version cache directories are removed best-effort; cleanup failures never abort startup.

## Shipped/compiled binary workflow

In compiled mode (`PI_COMPILED`, Bun embedded URL markers, or populated embedded manifest):

1. Loader computes versioned cache dir: `<getNativesDir()>/<packageVersion>`.
2. If embedded manifest matches current platform+version, loader extracts the selected file from `embedded-addons.<tag>.tar.gz` into that versioned dir when the cached file is absent or has the wrong size.
3. Runtime candidate order includes:
   - extracted versioned cache path, if available,
   - versioned cache dir,
   - legacy compiled-binary dir (`%LOCALAPPDATA%/omp` on Windows, `~/.local/bin` elsewhere),
   - package/executable directories.
4. First successfully loaded addon with the expected version sentinel is returned.

This is why packaging + runtime loader expectations must align: filenames, platform tags, CPU variants, and embedded manifest version must match what `native/loader-state.js` probes.

## JS API ↔ Rust export mapping (build sanity subset)

Generated declarations currently include exports from these Rust modules:

| Area                   | Representative JS exports                                                                                                               | Rust source                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Search/workspace       | `grep`, `search`, `hasMatch`, `fuzzyFind`, `glob`, `listWorkspace`, `invalidateFsScanCache`                                             | `grep.rs`, `fd.rs`, `glob.rs`, `workspace.rs`, `iofs.rs`                     |
| AST/block/summary      | `astGrep`, `astEdit`, `blockRangeAt`, `summarizeCode`                                                                                   | `ast.rs`, `block.rs`, `summary.rs`                                           |
| Text/highlight/tokens  | `visibleWidth`, `truncateToWidth`, `highlightCode`, `countTokens`                                                                       | `text.rs`, `highlight.rs`, `tokens.rs`                                       |
| Shell/PTY/process/keys | `executeShell`, `Shell`, `PtySession`, `Process`, `parseKey`                                                                            | `shell.rs`, `pty.rs`, `ps.rs`, `keys.rs`                                     |
| Media/system/iso       | `encodeSixel`, `copyToClipboard`, `detectMacOSAppearance`, `MacOSPowerAssertion`, `getWorkProfile`, `isoBackend`, `isoStart`, `isoDiff` | `sixel.rs`, `clipboard.rs`, `appearance.rs`, `power.rs`, `prof.rs`, `iso.rs` |

## Failure behavior and diagnostics

## Build-time failures

- Bazel analysis/compile failure: `scripts/bazel-natives.ts` surfaces the exit code plus a stderr tail; re-run the printed `bazel build` line directly (add `--verbose_failures`, `--sandbox_debug`) to iterate.
- Unknown target name: the driver errors with the full known-target list (`//:natives-*` names + `host`/`linux-all`/`darwin-all`).
- No `.node` outputs located after a successful build: driver exits 1 (check `bazel cquery --output=files` manually).
- Basename collision (gnu + musl in one invocation): driver refuses to install and names both sources — split into separate `--dest` dirs.
- `build:bindings` (napi) failure: script surfaces non-zero exit and stderr; artifact builds are unaffected (Bazel never runs the napi CLI).

## Runtime loader failures (`native/loader-state.js`)

- Unsupported platform tag: throws with supported platform list after probing fails.
- No candidate could load: throws with full candidate error list and mode-specific remediation hints.
- Embedded extraction and Windows staging problems: archive/mkdir/write/copy errors are recorded and included in final diagnostics if load fails.
- Version mismatch: install/compiled loads that lack the package-version sentinel are rejected during candidate probing.

## Troubleshooting matrix

| Symptom                                                                | Likely cause                                                                                | Verify                                                            | Fix                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Cannot find module` or dynamic library load error for every candidate | Missing release artifact, wrong platform tag, or stale compiled cache                       | Inspect loader error list and `packages/natives/native` filenames | Build correct target (`bun scripts/bazel-natives.ts <t> --dest packages/natives/native`); delete stale cache for the package version |
| Export is missing at runtime but present in TypeScript                 | Stale `.node` loaded, generated declarations newer than binary, or Rust export not compiled | Require the actual candidate and inspect `Object.keys(mod)`       | Rebuild native package and remove stale candidate/cache paths                                                                        |
| x64 machine loads baseline when modern expected                        | `PI_NATIVE_VARIANT=baseline`, no AVX2 detected, or modern file unavailable                  | Check env and filenames in `native/`                              | Build and ship the modern target (`bun scripts/bazel-natives.ts linux-x64-modern --dest packages/natives/native`)                    |
| gnu addon overwritten by musl (or vice versa)                          | Both built into one dest — they share canonical basenames by design                         | Compare `bazel-bin/natives-<t>/` sources vs installed file        | Separate invocations with separate `--dest` dirs (release matrix already does this)                                                  |
| Compiled binary fails after upgrade                                    | Stale extracted cache, embedded archive mismatch, or embedded manifest version mismatch     | Inspect `<getNativesDir()>/<version>` and loader error list       | Delete versioned cache for the package version; regenerate embedded archive/manifest during packaging                                |
| `gen:native` fails with `No native addons found`                       | Required platform artifact was not built before embedding                                   | Check expected list in error text                                 | Build at least one expected artifact for the target, then rerun `gen:native`                                                         |

## Operational commands

```bash
# Addon for the current host, installed into packages/natives/native/
bun --cwd=packages/natives run build

# Explicit targets (x64 variants are separate targets, not env switches)
bun scripts/bazel-natives.ts linux-x64-modern linux-x64-baseline --dest packages/natives/native

# Raw bazel (output: bazel-bin/natives-<t>/pi_natives.<...>.node)
bazelisk build //:natives-darwin-arm64

# Regenerate TS typedefs + enum exports (napi CLI, only on Rust API changes)
bun --cwd=packages/natives run build:bindings

# Generate embedded addon manifest from built native files
bun run gen:native
# Output archive: packages/natives/native/embedded-addons.<platform>-<arch>.tar.gz

# Reset embedded manifest to null stub
bun run gen:native:reset
```

## Orchestrator-side content-addressed build cache (robomp)

When `pi-natives` is built inside the robomp orchestrator (`python/robomp/`), workspaces share built artifacts through a content-addressed cache instead of rebuilding from scratch in every per-issue worktree. The cache is **orchestrator-side only** — `bun --cwd=packages/natives run build` itself is unchanged; the cache lives outside the build pipeline and is populated/captured around `ensure_workspace` and post-task success in `python/robomp/src/natives_cache.py`.

### What is cached

The cache captures the following files from `packages/natives/native/` under the computed key. Correct reuse assumes the worktree contents of keyed paths match committed `HEAD`; because the key ignores uncommitted changes, a build from a dirty keyed path can otherwise be captured under and later reused from the unchanged key:

- `pi_natives.<platform>-<arch>[-variant].node` (glob `pi_natives.*.node`)
- `index.d.ts`
- `index.js`
- `embedded-addon.js`
- `manifest.json` (cache metadata: key, target triple, capture timestamp, source workspace, commit)

An entry is only considered a hit when the `.node` glob matches AND every companion plus the manifest is present. Partial entries are evicted on GC.

### Cache key

The key is `sha256` over `(path \t git-tree-hash \n)` pairs for the following inputs, in this order (order is significant), followed by the target triple:

1. `crates` (whole subtree — pi-natives transitively depends on other workspace crates)
2. `Cargo.lock`
3. `Cargo.toml`
4. `rust-toolchain.toml`
5. `packages/natives` (whole subtree — build script, `scripts/*`, package.json)

Tree hashes come from one `git cat-file --batch-check` invocation against `HEAD`; paths missing from `HEAD` fold in as a fixed null hash so the key stays deterministic across repos that don't ship every input. The target suffix is `<platform>-<arch>` on non-x64. On x64 it is `<platform>-<arch>-<TARGET_VARIANT>`, or `<platform>-<arch>-host` when `TARGET_VARIANT` is unset; the Python cache does not perform AVX2 detection.

Anything outside this input set (Bazel definition files such as `MODULE.bazel`/`BUILD.bazel`, host glibc, env vars other than the target suffix) is **not** in the key. The content hashes also describe committed `HEAD`, not uncommitted worktree changes. Delete the relevant cache entry after an out-of-key or uncommitted build-input change; committing a change under one of the five keyed paths produces a new key automatically.

### Layout and ownership

- Root: `/data/cache/pi-natives` (provisioned by `entrypoint.sh` alongside the cargo caches, owned `root:omp`, mode `02770` setgid so cached files inherit `gid=omp` and stay readable by every slot user).
- Per-repo subdirectory: `<root>/<repo-slug>/` where the slug is `owner__repo` (mirrors `SandboxManager.pool_path`).
- Per-entry directory: `<root>/<repo-slug>/<sha256-key>/` containing the cached files plus `manifest.json`.
- Per-repo lockfile: `<root>/<repo-slug>/.lock` (advisory `fcntl.flock`, exclusive on capture and GC).
- Staging dirs (`.<key>.tmp.<pid>`) during capture; renamed atomically into the final entry path. Stale staging dirs from crashed captures are swept on GC.

### Populate and capture semantics

- **Populate** (workspace ← cache) runs inside `ensure_workspace`. On a key hit the `.node` is **hardlinked** into the workspace (zero-copy, shared inode); the companion `index.d.ts` / `index.js` / `embedded-addon.js` are **copied** (independent inodes) because the bindings regeneration flow (`build-bindings.ts`'s `installGeneratedBindings` and `gen-enums.ts`) rewrites those files via `open(..., 'w')` — an in-place truncate that would otherwise propagate through a hardlink and corrupt the cache. Cross-device hardlink failures (`EXDEV`) fall back to copy.
- **Capture** (cache ← workspace) runs from the post-task success path when the build produced a complete artifact set. Capture uses **copy**, not hardlink: hardlinking a slot-owned workspace file would preserve slot UID ownership on the cached inode and defeat the shared-group model. Copying creates a fresh root-owned, `gid=omp` inode via the setgid cache root. Capture is idempotent under the per-repo flock: a concurrent capture for the same key returns the existing entry.

### Garbage collection

A periodic GC loop runs in `WorkerPool` with two caps per repo. When either cap is exceeded, oldest entries (by `manifest.json.captured_at`) are dropped first:

- entry count cap (`max_entries_per_repo`, default 8)
- byte cap (`max_bytes`, default 4 GiB)

Workspaces that hardlinked a `.node` before GC retain access via the kernel inode refcount — `rmtree` of the cache entry does not delete the file from the workspace.

### Configuration (settings on `robomp.config.Settings`)

| Env var                                     | Default                  | Effect                                                                                              |
| ------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `ROBOMP_NATIVES_CACHE_ENABLED`              | `true`                   | Master switch. When false the populate/capture hooks no-op and every workspace builds from scratch. |
| `ROBOMP_NATIVES_CACHE_ROOT`                 | `/data/cache/pi-natives` | Cache root directory. Must be `root:omp 02770` for cross-slot reads.                                |
| `ROBOMP_NATIVES_CACHE_MAX_ENTRIES_PER_REPO` | `8`                      | LRU entry-count cap, per repo slug.                                                                 |
| `ROBOMP_NATIVES_CACHE_MAX_BYTES`            | `4294967296` (4 GiB)     | LRU byte cap, per repo slug.                                                                        |
| `ROBOMP_NATIVES_CACHE_GC_INTERVAL_SECONDS`  | `3600`                   | Period of the background GC loop in `WorkerPool`.                                                   |

### Manual invalidation

- One key: `rm -rf /data/cache/pi-natives/<repo-slug>/<sha256>`.
- One repo: `rm -rf /data/cache/pi-natives/<repo-slug>`.
- Everything: `rm -rf /data/cache/pi-natives/*` (preserve the root so its setgid mode survives).
- Stuck lock: `rm /data/cache/pi-natives/<repo-slug>/.lock` (only when no orchestrator process is touching the repo).

For a fixed target suffix, a committed `HEAD` change under `crates/`, `Cargo.lock`, `Cargo.toml`, `rust-toolchain.toml`, or `packages/natives/` produces an automatic miss. Changing platform/architecture, or `TARGET_VARIANT` on x64, also selects a different key. Merely editing an uncommitted worktree changes neither the `HEAD` hashes nor the key.
