# msvc cross toolchain — knobs & validation notes

Hermetic clang-cl + lld-link + xwin (MSVC CRT/SDK) cc toolchain for
`x86_64-pc-windows-msvc`, cross-linking from linux-x64 (CI) and darwin (dev)
exec hosts. Replaces cargo-xwin.

## Layout

| Piece | Where | Why separate |
| --- | --- | --- |
| `@llvm_msvc_tools` | `llvm.bzl` | LLVM 20.1.7 release archive for the fetching host, pruned to clang-cl/lld-link/llvm-lib/llvm-rc/llvm-mt + `lib/clang/*/include`. Downloads (~2 GiB) are sha256-pinned → Bazel repository cache. |
| `@xwin_sysroot` | `sysroot.bzl` | xwin 0.6.5 (pinned per-host sha256) runs `splat` in the repo rule. The ~1 GiB CRT/SDK payload comes from the Microsoft CDN via xwin itself and is **not** in Bazel's repo cache — a cold output base re-downloads it. Keep `sysroot.bzl` stable. |
| `@msvc_cc` | `cc.bzl` | Wrapper scripts + `cc_toolchain` + MSVC feature config (copied from the resolved rules_cc, like `@local_config_cc`). Cheap to regenerate — iterate flags here. |
| `toolchain()`s | `//bazel/toolchains` (`msvc-cc-from-*`) | One per exec host (linux-x64/arm64, darwin-arm64/x64), all pointing at `@msvc_cc//:cc_toolchain`; only the local host's variant can resolve. `target_compatible_with = [windows, x86_64]` ⇒ can never shadow zig on linux. |
| MODULE.bazel | `# --- msvc cross toolchain ---` section | `rules_cc` 0.2.17 (= Bazel 9.2's builtin pin) + the three `use_repo_rule` instantiations. Plus one target-suffixed env key inside the existing `audiopus_sys` annotation (see below). |

## Design decisions

- **No toolchains_llvm**: it wants to register full host cc toolchains, which
  risks shadowing the zig linux toolchains. Direct LLVM release fetch instead.
- **Wrappers self-locate from `$0`** (execroot-relative sibling repos), so they
  work from Bazel actions (cwd = execroot) *and* from build scripts, where
  rules_rust `${pwd}`-expands `CC`/`AR` to absolute paths and cc-rs/cmake spawn
  tools from other cwds.
- **CRT: static `/MT` for the shipped addon.** The toolchain *default* is
  dynamic `/MD` (rules_cc's msvc branch default outside `dbg` without the
  `static_link_msvcrt` feature), matching what napi/cc-rs produced under
  cargo-xwin. But `//:natives-win32-x64-baseline` overrides to static CRT:
  `-Ctarget-feature=+crt-static` for rustc (crate BUILD select) plus the
  `static_link_msvcrt` cc feature (enabled for win32 in the `native_addon`
  transition, `bazel/defs.bzl`) so the C deps compile `/MT` in lock-step.
  Without this the `.node` imports `VCRUNTIME140.dll` from the Visual C++
  Redistributable, which is absent on a clean Windows install and makes the
  loader's dlopen fail with error 126 (issue #8439).
- **SSE floor in the wrapper, not annotations**: `-msse4.1 -msse4.2` live in the
  clang-cl wrapper, which only ever targets win32-x64 (baseline = x86-64-v2 ⊇
  SSE4.2). This is the old build-native.ts CFLAGS hack, windows-only by
  construction.
- **cmake generator via target-suffixed env**: `crate_universe` cannot select()
  annotations per platform, and a second `crate.annotation` for the same crate
  hard-fails the extension (`_insert_annotation` dupe check; `annotation_select`
  is unused/broken in rules_rust 0.71.3). Instead the existing `audiopus_sys`
  annotation carries `CMAKE_GENERATOR_x86_64_pc_windows_msvc=Ninja` — cmake-rs
  reads `VAR_<triple>` before `VAR`, so the key is inert for all other targets.
  cmake-rs sets `CMAKE_SYSTEM_NAME=Windows` itself when target ≠ host.
- **cmake tool discovery**: wrappers are named bare `clang-cl`, `lld-link`,
  `llvm-lib`, `llvm-rc`, `llvm-mt` (no `.sh`) because CMake's
  `CMakeFindBinUtils`/`find_program` probes for those names next to
  `CMAKE_C_COMPILER`, and cc-rs sniffs the MSVC/clang-cl tool family from the
  basename. The clang-cl wrapper also exports link.exe-style `LIB` and passes
  `-fuse-ld=lld-link` so compiler-driver links (cmake `try_compile` ABI checks)
  resolve CRT import libs without a toolchain file.
- **ring 0.17.14 needs no perl/nasm**: verified in its build.rs — crates.io
  tarballs use `pregenerated/*-nasm.o` objects directly for windows-msvc
  (`use_nasm()` path only shells out during the maintainer packaging step).
  The .o files flow through `cc::Build.object()` into llvm-lib.

## Reproducibility / cache implications

- First fetch per host: ~2 GiB LLVM (repo-cache backed) + ~15 MiB xwin +
  ~1 GiB MS CDN splat (not repo-cache backed). Splat repo ends up ~800 MiB.
- `--manifest-version 17` pins the VS2022 channel, but Microsoft advances the
  channel payload over time → splat is stable day-to-day, not bit-reproducible
  forever (same property cargo-xwin had). Action keys only depend on the files
  actually read, so remote-cache hit rates degrade gracefully after an MS bump.
- Toolchain binaries differ per exec host (linux vs mac clang) → win32 link
  actions do not share remote-cache entries across host OSes. CI is
  linux-x64-only for this target, so this only affects dev machines.

## Already verified (darwin-arm64 dev host, 2026-07-27)

- `bazel build --nobuild //:natives-win32-x64-baseline` analyzes clean;
  `cquery deps(...)` confirms `@msvc_cc//:cc_toolchain` (not the host Xcode
  toolchain) resolved for the windows target. Full fetch + splat took ~2.5 min
  on a fast link; crate-universe generation included the
  `CMAKE_GENERATOR_x86_64_pc_windows_msvc` annotation.
- Wrapper smoke test outside Bazel: `clang-cl /MD` compiled a windows.h +
  smmintrin.h SSE4.1 program and driver-linked it via `-fuse-ld=lld-link` +
  `LIB` into a valid PE32+ exe; the standalone `lld-link` wrapper (rustc's
  `-Clinker` path) and `llvm-lib` also produced a PE exe / ar archive.
- xwin's `10.0.26100 -> .` self-referential version symlinks broke Bazel's
  glob ("too many levels of symbolic links"); `sysroot.bzl` now prunes any
  readdir entry whose realpath equals its parent, post-splat.
- blake3 MASM (`ml64.exe` from cc-rs on non-windows hosts): `bin/ml64.exe` /
  `bin/ml64` shims exec `llvm-ml -m64`. All four blake3 1.8.5
  `blake3_*_x86-64_windows_msvc.asm` files assemble to valid amd64 COFF
  objects through the shim (invoked cc-rs-style via PATH with joined `/Fo`).
  cc-rs finds the shim through the blake3 crate.annotation, which prepends
  `$${pwd}/external/+msvc_cc_repository+msvc_cc/bin` to the build-script PATH
  (`$$` because annotation env runs through Bazel make-var expansion; the
  rules_rust runner then substitutes `${pwd}` → exec root). The wrapper dir
  reaches the sandbox via the cc toolchain's `all_files`. NOTE: the PATH entry
  hardcodes @msvc_cc's canonical repo name — keep in sync if the repo rule or
  repo name changes. The generated crate graph includes this annotation.
- audiopus_sys/opus cmake exe links (can.internal finding #2): cmake's
  `vs_link_exe` demands rc/mt tools that `find_program` can't locate on a
  linux/mac PATH. @msvc_cc now generates `toolchain.cmake` (self-locating via
  `CMAKE_CURRENT_LIST_DIR`: compiler/linker/rc/mt = the wrappers) handed to
  cmake-rs through `CMAKE_TOOLCHAIN_FILE_x86_64_pc_windows_msvc` in the
  audiopus_sys annotation (same `$${pwd}` + canonical-repo-path mechanism as
  the blake3 shim). Second failure mode fixed in the same file: `try_compile`
  defaults to the Debug config → `/MDd` → `msvcrtd.lib`, which the lean splat
  (like cargo-xwin's) does not carry; toolchain.cmake pins
  `CMAKE_TRY_COMPILE_CONFIGURATION=Release`, `CMAKE_POLICY_DEFAULT_CMP0091=NEW`
  and `CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded` (static release `/MT`
  everywhere, matching the addon's static-CRT policy — issue #8439).
  Verified on darwin: scratch `project(C)` + `add_executable` configures with
  "Clang 20.1.7 with MSVC-like command-line" and links a valid PE32+ exe
  through vs_link_exe with the wrapper rc/mt/linker.

## What to verify on can.internal (linux-x64)

1. `bazel build //:natives-win32-x64-baseline` end-to-end link; check the
   produced `pi_natives.win32-x64-baseline.node` imports (dumpbin/llvm-readobj):
   expect **no** `VCRUNTIME140.dll` and **no** `api-ms-win-crt-*` (static CRT);
   only core Windows system DLLs (kernel32, ntdll, advapi32, …) should remain.
2. LLVM 20.1.7 Linux-X64 binaries are built on a newish Ubuntu: confirm the
   kata runner image's glibc is ≥ 2.35-ish and has `libtinfo6`/`libstdc++6`
   (usual LLVM release-binary runtime deps).
3. `ninja` + `cmake` must be on the audiopus_sys build-script PATH
   (`/usr/local/bin:/usr/bin:/bin`) on the kata image — same requirement the
   old ensure-cmake action satisfied for cargo-xwin.
4. audiopus_sys configure: cmake should report
   "Clang with MSVC-like command-line", take `toolchain.cmake` (log shows the
   vs_link_exe --rc/--mt pointing into the wrapper dir), and produce opus.lib
   with /MD objects. If mt is ever asked to actually merge manifests, note
   the official LLVM llvm-mt lacks libxml2 and would error — not hit today.
5. tree-sitter grammar compiles via cc-rs: wrapper is picked up as `CC`
   (family detection needs the basename to contain `clang-cl` — it does).
6. ring: no `nasm`/`perl` spawns in the build-script log; archive step uses
   the `llvm-lib` wrapper.
7. blake3: build-script log should show `ml64.exe` resolving to the shim (no
   "failed to find tool" error); spot-check the assembled objects land in the
   rlib.
8. Repo fetch time/disk on the pods (first fetch ~3 GiB, ~25 min worst case);
   consider pre-warming the bazel output base or a persistent
   `--repository_cache` volume if it hurts.

## Knobs

- LLVM version/sha256s: `llvm.bzl` (`_LLVM_VERSION`, `_LLVM_DISTS`). 20.1.7 is
  the newest release with archives for all four host tuples.
- xwin version + manifest channel: `sysroot.bzl` (`_XWIN_VERSION` 0.6.5 — last
  release with darwin binaries; `_XWIN_MANIFEST_VERSION` "17").
- Compile/link flags, include/libpath set, CRT choice: wrapper templates and
  `cc_toolchain_config` attrs in `cc.bzl`.
- Static CRT if ever needed: build with the standard `static_link_msvcrt`
  feature (`--features=static_link_msvcrt`) instead of editing flags.
