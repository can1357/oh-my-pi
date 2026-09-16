# @oh-my-pi/pi-natives

Native Rust functionality via N-API.

## What's Inside

- **Grep**: Regex-based search powered by ripgrep's engine with native file walking and matching
- **Find**: Native glob-based file/directory discovery with gitignore support
- **SIXEL**: Terminal image encoding for SIXEL-capable terminals (decode, resize, encode in one pass)
- **Audio**: Cross-platform low-latency microphone capture and gapless speaker playback
- **WebRTC**: Native Opus media, SDP offer/answer negotiation, and data-channel events for live sessions
- **File locking**: Process-owned cross-process locks with in-memory kernel names on Linux/Windows and `flock(2)` sidecars on other Unix platforms
- **PDF**: In-memory PDF-to-Markdown extraction with OCR-page classification via `pdf-inspector`

General-purpose image processing (decode/resize/encode for files and buffers)
lives in [`Bun.Image`](https://bun.com/docs/runtime/image) on the JS side; this
crate only ships the SIXEL encoder because no built-in equivalent exists for
that terminal protocol.

## Usage

```typescript
import { encodeSixel, grep, pdfToMarkdown } from "@oh-my-pi/pi-natives";

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

// SIXEL encode for a terminal cell box (px)
const sequence = encodeSixel(pngBytes, widthPx, heightPx);

// Extract PDF text and identify pages that still need OCR
const pdf = await pdfToMarkdown(pdfBytes);
console.log(pdf.markdown, pdf.pagesNeedingOcr);
```

## Shell subprocess completion

`Shell.run` reports a command's actual exit status and streams its output through
the supplied callback. On macOS, the host and the native shell share `SIGCHLD`.
Registering another host listener must not leave an already exited command
waiting until its deadline. The shell retains its normal asynchronous wait and
rechecks that same child's status every 100 ms. It never repeats the command or
turns an unsuccessful exit into success; cancellation and output collection
remain unchanged.

The real regression runs in an isolated Bun process, registers a host signal
listener, and checks delayed completion, output, and an unsuccessful command.
From the repository root, run `bun test tests/process/child-completion.test.ts`.

## Building

```bash
# Build native addon from workspace root (requires Rust)
bun run build

# Type check
bun run check
```

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
  embedded-addon.js      # Standalone binary embed stub/generated metadata
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
