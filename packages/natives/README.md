# @oh-my-pi/pi-natives

Native Rust functionality via N-API.

## What's Inside

- **Grep**: Regex-based search powered by ripgrep's engine with native file walking and matching
- **Find**: Native glob-based file/directory discovery with gitignore support
- **SIXEL**: Terminal image encoding for SIXEL-capable terminals (decode, resize, encode in one pass)
- **Audio**: Cross-platform low-latency microphone capture and gapless speaker playback
- **WebRTC**: Native Opus media, SDP offer/answer negotiation, and data-channel events for live sessions
- **File locking**: Process-owned cross-process locks with in-memory kernel names on Linux/Windows and `flock(2)` sidecars on other Unix platforms
- **Local IPC**: `IpcServer`/`IpcConnection` over Unix sockets and Windows named pipes — owner-only access, single-instance binding with stale-endpoint takeover, newline or raw framing; `ipcEndpoint(dir, name)` names endpoints per platform
- **PDF**: In-memory PDF-to-Markdown extraction with OCR-page classification via `pdf-inspector`
- **Binary patches**: `applyBinaryPatch(oldPath, patchPath, outPath)` applies an HDiffPatch single-stream patch (HDIFFSF20, zstd or uncompressed), streaming from files; callers verify digests

General-purpose image processing (decode/resize/encode for files and buffers)
lives in [`Bun.Image`](https://bun.com/docs/runtime/image) on the JS side; this
crate only ships the SIXEL encoder because no built-in equivalent exists for
that terminal protocol.

## Usage

```typescript
import { encodeSixelAsync, grep, pdfToMarkdown } from "@oh-my-pi/pi-natives";

// Grep for a pattern
const results = await grep({
	pattern: "TODO",
	path: "/path/to/project",
	glob: "*.ts",
	context: 2,
});

// Find files
const files = await find({
	pattern: "*.rs",
	path: "/path/to/project",
	fileType: "file",
});

// SIXEL encode for a terminal cell box (px), off the JS thread
// (`encodeSixel` is the synchronous form)
const sequence = await encodeSixelAsync(pngBytes, widthPx, heightPx);

// Extract PDF text and identify pages that still need OCR
const pdf = await pdfToMarkdown(pdfBytes);
console.log(pdf.markdown, pdf.pagesNeedingOcr);
```

### Lazy Windows path helpers

Import `expandWindowsLongPath` and `getWindowsShortPath` from
`@oh-my-pi/pi-natives/path` when importing a module must not load the native addon.
The addon loads only when a helper is called on Windows; other platforms preserve
the input path without loading it. These helpers change long/8.3 spellings without
resolving symlinks or junctions.

## Building

```bash
# Build native addon from workspace root (requires Rust)
bun run build

# Type check
bun run check
```

Android ARM64 has an explicit experimental Bazel cross-target for the native
addon; it is not part of the `all` native aggregate. From a Linux host with
Bazel and Android NDK 25b or newer, build just the addon from the workspace
root:

```sh
ANDROID_NDK_HOME=/path/to/android-ndk bun scripts/bazel-natives.ts android-arm64
```

The installer targets API level 24 and installs
`packages/natives/native/pi_natives.android-arm64.node`. It only load-probes
artifacts native to the current host, so a Linux builder never loads Android.

To cross-build a standalone coding-agent Android binary, use the optional Linux-host command:

```sh
ANDROID_NDK_HOME=/path/to/android-ndk bun --cwd=packages/coding-agent run build:android
```

Use Android NDK 25b or newer and released Bun 1.4.3 on the Linux build host;
that compiler version was verified to have the matching Android runtime asset.
The command builds the explicit Bazel `android-arm64` native target, then
compiles the CLI for Bun's `bun-linux-arm64-android` target. The raw executable
is written to `packages/coding-agent/dist/omp-android-arm64`; Bun's runtime is
included, so it does not need an external Bun installation in Termux. The
bundled Bun 1.4.3 runtime targets Android 9 (API 28), while the native addon
targets API 24. The generic `build` and `CROSS_TARGET` paths remain for ordinary
host/cross-target builds.

Install a published binary from Termux with:

```sh
curl -fsSL https://omp.sh/install | sh -s -- --binary
```

Cross-compilation does not verify Android/Termux or seccomp compatibility;
validate the executable on a native non-root Termux device before publishing.

The Android addon omits the native desktop and clipboard modules. The desktop
declarations remain available for type compatibility, but Android does not
provide desktop sessions. The package root and
`@oh-my-pi/pi-natives/desktop` can both be imported; calling
`createDesktopSession()` from the subpath throws
`Unsupported: desktop sessions are not supported on this platform.` No Android
screen-capture or input support is provided.

## Architecture

`@oh-my-pi/pi-natives` publishes a small core package plus generated
platform-specific optional dependency packages:

```
crates/pi-natives/       # Rust source (workspace member)
  src/lib.rs             # N-API exports
  src/sixel.rs           # SIXEL terminal-image encoding
  Cargo.toml             # Rust dependencies
native/                  # Core loader files and local/CI native build outputs
  index.js               # Public native export surface
  loader-state.js        # Platform, ISA variant, and addon resolution
  embedded-addon.js      # Null embed stub; binary builds replace it in memory
  pi_natives.<platform>-<arch>-modern.node   # x64 modern ISA (local/CI artifact)
  pi_natives.<platform>-<arch>-baseline.node # x64 baseline ISA (local/CI artifact)
  pi_natives.<platform>-<arch>.node          # non-x64 build artifact
npm/<platform>-<arch>/   # Generated at publish time, not committed
  package.json           # @oh-my-pi/pi-natives-<platform>-<arch>
  *.node                 # Only that platform's addon binary or x64 ISA variants
```

The published core package contains only the JS loader, declarations, README,
and `package.json`. Release publishing generates one leaf package per supported
`os`/`cpu` pair and injects those leaves into the core manifest as pinned
`optionalDependencies`, so package managers install only the host platform's
native addon. x64 leaves include every built ISA variant, and the loader keeps
choosing between `baseline` and `modern` at runtime.
