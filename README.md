<p align="center">
  <img src="assets/hero.png" alt="omp">
</p>

<p align="center">
  <strong>A coding agent with the IDE wired in — rewritten in Rust.</strong><br>
  <strong><a href="https://omp.sh">omp.sh</a></strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/stencil-hq/omp?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
</p>

Pre-release: the workspace is being built up subsystem by subsystem; expect
renames and breaking changes without notice.

## Workspace layout

All crates live under `crates/*` (virtual workspace, resolver 3). Package
names are `omp-` prefixed; directory names are not.

### Core primitives

| Crate      | What it is                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| `core`     | Compact strings/bytes, sparse collections, encodings, shared data structures, and tolerant JSON (`slopjson`) |
| `ar`       | Bounded lazy ZIP/TAR/TAR.GZ reading, deterministic archive writing                                           |
| `walker`   | Filesystem traversal, filtering, file-candidate discovery                                                    |
| `edit`     | Edit engine: replace, patch, apply_patch, hashline, sloppy modes with streaming previews and jsdiff-compatible diffs |
| `ast`      | Tree-sitter source analysis, structural search, AST-aware editing                                            |

### AI & Inference

| Crate     | What it is                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `catalog` | Typed offline provider/route/model/capability catalog (embedded snapshot, no runtime heuristics)             |
| `ai`      | Typed request/response contracts and `Client` over the Tower service stack (routing, auth, retries, budgets) |

### Services

| Crate           | What it is                                                                    |
| --------------- | ----------------------------------------------------------------------------- |
| `proto`         | Generated Protobuf messages and optional gRPC bindings for the wire protocols  |
| `rpc`           | gRPC transport, handshake, health, TLS, Unix-socket plumbing, and JSON-RPC stdio harness |
| `observability` | OpenTelemetry instrumentation, metrics, export, redaction                     |
| `env`           | Typed client boundary for environment services                                |
| `envd`          | Project environment daemon: filesystem, docserver (LSP/transactions), in-process grep, process, tool, and extension-host operations |
| `serve`         | Tonic gRPC projections for inference, authentication, and content-addressed blob services |
| `oauth`         | Provider-independent bounded OAuth discovery, PKCE authorization, callback, registration, and token primitives |
| `collab`        | Versioned, bounded collaboration substrate: room cryptography, Protobuf framing, replication, relay transport |
| `memory`        | Durable default-off Mnemopi memory banks, recall, retention, and isolated embeddings |

### Agent

| Crate            | What it is                                                                           |
| ---------------- | ------------------------------------------------------------------------------------ |
| `journal`        | Authoritative `.oms` event journal and content-addressed blob store                   |
| `dom` / `vocab`  | Materialized session tree and shared closed structural vocabulary                    |
| `session`        | Journal-first session fold, components, rewind, subscriptions, and projections        |
| `con`            | Typed convars, command stream, bindings, aliases, and cfg persistence                 |
| `cache`          | Document, GitHub, MCP, secret-key, and statistics caches                              |
| `tool` / `tools` | Typed revisioned tool contracts/registry, and the resource-owning built-in executors |
| `agent`          | Kernel, dispatch, cancellation, jobs, Directors, hooks, and approvals                |
| `driver`         | Headless kernel composition, discovery, cfg execution, registries, and subagent spawn |
| `app`            | Production CLI application and daemon                                                |
| `e2e`            | Executable cross-crate acceptance proofs                                             |
| `ext`            | Extension configuration, dependency resolution, lockfiles, index metadata, and local trust state |
| `sdk`            | Stable native embedding facade for OMP sessions, callbacks, discovery, and tools |
| `snapcompact`    | Pure-Rust bitmap archive rendering and provider-aware framing for context compaction |

### Shell

| Crate            | What it is                                               |
| ---------------- | -------------------------------------------------------- |
| `shell`          | Standalone Bash parser and execution engine (`omp-shell`)|
| `shell-builtins` | In-process coreutils and process builtins (no fork/exec) |

### Interface

| Crate          | What it is                                                                    |
| -------------- | ----------------------------------------------------------------------------- |
| `tui`          | Retained-mode terminal UI: components, rendering, input, terminal integration |
| `chat`         | Actor over `Session::subscribe()`: transcript projection, cards, composer, overlays |
| `macros`       | Procedural macros for declarative TUI markup and per-thread function caching |
| `gui`          | GPU-accelerated native window host for omp-tui apps                           |
| `desktop`      | Actor-owned native desktop capture, input, and accessibility automation |
| `webview`      | Pluggable embedded-browser surfaces using system webviews or installed Chromium/Firefox |
| `py`           | Embedded free-threaded CPython runtime with frozen stdlib                     |
| `audio`        | Cross-platform native audio capture, playback, metering, and PCM16 WAV encoder (CoreAudio, ALSA, WASAPI) |

### Infrastructure

| Crate      | What it is |
| ---------- | ---------- |
| `secrets`  | Secret-rule validation, reversible keyed placeholders, and provider-bound text redaction |
| `sandbox`  | Deferred isolation boundary for OMP process confinement |
| `http`     | Process-wide outbound HTTP connection pools and TLS policy |

### Top level

| Path                  | What it is                                            |
| --------------------- | ----------------------------------------------------- |
| `PLAN.md`             | P0–P7 verification gate ledger                        |
| `.plan/quirks/`       | Catalog and inference notes                           |
| `.plan/qa/`           | Joined-system QA findings and stable regressions      |
| `fixtures/llm-oracle` | Recorded inference fixtures                           |
| `npm/pi-coding-agent` | npm package shim (`scripts/gen-npm-packages.py`)      |
| `vendor/python`       | Gitignored embedded-Python build inputs (see below)   |

## Building

Pinned nightly toolchain via `rust-toolchain.toml`; edition 2024, hard-tab
formatting (`cargo fmt`), workspace lint policy in the root `Cargo.toml`.

```sh
cargo build            # or: cargo check
just test              # nextest + doctests, workspace minus e2e
```

Tests run under [cargo-nextest](https://nexte.st) (`just test`, `just test-pkg
<crate>`, `just e2e`). nextest gives each test its own process and a real
parallel scheduler, but it **does not run doctests** — every recipe therefore
pairs `cargo nextest run` with a `cargo test --doc` pass. Invoke `cargo test`
directly only for doctests; otherwise use the recipes so both halves run.
Profiles beyond the defaults:

| Profile | Use |
| --- | --- |
| `dev` | Default. Line tables for workspace crates, no debuginfo for deps. |
| `release` | Shipping build: `opt-level = 2`, thin LTO, 1 codegen unit, stripped. |
| `release-dev` | Same codegen as `release` across 16 units, so a one-crate edit does not re-optimize everything. |
| `release-profiling` | `release` with symbols kept, for `perf`/`samply`/Instruments. |

```sh
cargo build --profile release-dev
```

`.cargo/config.toml` also sets `embed-metadata = false`, which keeps crate
metadata in `.rmeta` rather than duplicating it into every rlib — measured
196 MB → 130 MB of `target/` on a reqwest-sized graph at identical build
times. It needs the pinned nightly, and its accepted spelling is coupled to
the toolchain version.

The embedded-Python crate (`crates/py`) needs a one-time fetch before it
builds:

```sh
crates/py/scripts/fetch-python.sh
```

## Conventions

Dependency, allocation, async, and TUI-rendering rules are mandatory and
live in [`AGENTS.md`](AGENTS.md). Read it before touching anything.

## Architecture & Process Model

### 1. 5-Layer Crate Topology & Turn Flow
The workspace partitions into 5 strictly acyclic layers:
1. **Core Substrate & Primitives**: `omp-core` (with zero-copy `Str`, `Ulid`, `slopjson`), `omp-vocab`, `omp-proto`, `omp-audio`, `omp-http`, `omp-vcs`, `omp-walker`, `omp-desktop`, `omp-snapcompact`, `omp-macros`, `omp-ar`, `omp-secrets`, `omp-oauth`, `omp-cache`, `omp-sandbox`, `omp-webview`.
2. **Domain Modeling, State & Editing**: `omp-journal`, `omp-dom`, `omp-con`, `omp-catalog`, `omp-ast`, `omp-edit`, `omp-scribe`, `omp-collab`, `omp-memory`.
3. **Execution Engines, Tooling & Interpreters**: `omp-ai`, `omp-shell`, `omp-shell-builtins`, `omp-tool`, `omp-tools`, `omp-py`, `omp-env`, `omp-ext`, `omp-tui`, `omp-gui`.
4. **Session, Agent Kernel & Daemons**: `omp-session`, `omp-agent`, `omp-envd`, `omp-observability`, `omp-rpc`, `omp-serve`, `omp-sdk`.
5. **Applications & Composition**: `omp-driver` (`compose_kernel`), `omp-chat`, `omp-app`, `omp-e2e`.

A live turn proceeds in a single-writer journal-first loop:
* **User Input** arrives at `omp-chat` and posts to `Kernel` via an upward `flume::Sender<Up>` mailbox.
* **Journal Commit**: `Kernel` appends `TurnStart` to `omp-session::Session`, which appends raw SSE frames to the `.oms` file before folding into `omp-dom::Dom`.
* **Inference**: `CanonicalPromptSource` projects DOM history to `omp-ai::Client` over Tower middleware (rate-limiting, retries, token budgets).
* **Streaming & Speculative Arguments**: Streamed `ChatEvent`s feed DOM deltas to `omp-chat` in real time. Tool arguments stream into `omp-core::slopjson` while `omp-edit` computes live preview diffs.
* **Tool Execution**: Authorized tool batches run in `omp-envd` (using in-process `omp-shell` and `omp-shell-builtins`). Large outputs exceeding `sv_tools_output_spill_bytes` spill to the content-addressed `BlobStore` (`artifact://sha256/<hex>`). Results commit to `.oms`, fold into DOM, and render atomically via `omp-tui`.

### 2. Operating System Processes
The system uses standalone binaries and hidden same-binary child entry points dispatched in `crates/app/src/main.rs`:

```
OS Host
 └─► omp [chat | print | rpc | acp] (Frontend client)
      │
      ├─► (Detached Daemon) omp envd (PID P2, PGID P2, fresh session)
      │    │
      │    ├─► omp __omp-ext-host (PID P3, PGID P3, FD 3 control channel)
      │    │    └─► [Optional Bubblewrap / Seatbelt sandbox container]
      │    │
      │    ├─► omp __omp-py-worker (PID P4, supervised length-delimited stdio)
      │    │
      │    ├─► omp __omp-eval-child (PID P5, PGID P5, parent watchdog thread)
      │    │
      │    ├─► omp __omp-shell-child '<script>' (PID P6, PGID P6, detached job)
      │    │
      │    ├─► Interactive Subshell (PID P7, PGID P7, PTY master held by envd)
      │    │
      │    ├─► Stdio MCP Servers (PID P8, setsid / process_group(0))
      │    │
      │    ├─► omp browser-relay serve (PID P9, headless Chromium bridge)
      │    │
      │    ├─► LSP Language Servers (PID P10, managed by docserver in envd)
      │    │
      │    └─► omp --omp-sandbox-child (PID P11, Seccomp/Landlock runner)
      │
      └─► (Standalone Daemons / Services)
           ├─► omp serve (Inference/Auth/Blob gRPC daemon)
           ├─► omp-sh (Standalone POSIX shell)
           └─► omp-memory-embedding-worker (FastEmbed vector worker)
```

* **`omp envd` Daemon**: Detached via `process_group(0)`. Shuts down after an idle timeout (`--idle-timeout`, default 60s) when no active client connections or persistent jobs remain. Binary upgrades trigger immediate retirement.
* **Process Watchdogs & FD Shielding**: `__omp-eval-child` shields protocol FDs away from standard I/O and runs a background thread sampling `getppid()` every 100ms; if the parent dies, it executes `kill(-pgid, SIGKILL)` to eliminate orphan processes.
* **Signal Escalation**: Two-stage termination (`SIGTERM` → grace duration → `SIGKILL` to `-pgid`).

### 3. Inter-Process Communication & Protocols

| Channel / Boundary | Transport | Wire Format / Serialization | Address Convention |
|---|---|---|---|
| **Client ↔ `envd`** | UDS / Named Pipe | Varint length-delimited Protobuf (`omp.env.v1`) | `<state_dir>/<build_id>-env` (build-keyed) |
| **Client/Envd ↔ `docserver`** | UDS / Named Pipe | Length-delimited Protobuf | `<state_dir>/doc` (build-stable) |
| **Client ↔ `omp serve`** | UDS / TCP | gRPC via Tonic (`prost`) | `<data_dir>/omp.sock` or `http://<addr>:<port>` |
| **IDE ↔ `omp rpc`** | Stdio Pipes | JSON-RPC 2.0 (newline-delimited JSON) | Child process stdin/stdout |
| **`envd` ↔ `__omp-ext-host`** | Socketpair | Length-delimited Protobuf (`toolhost.v1`) | FD 3 inherited across `pre_exec` |
| **`envd` ↔ `__omp-py-worker`** | Stdio Pipes | Length-delimited Protobuf / MsgPack | Child process stdin/stdout |
| **`envd` ↔ `__omp-eval-child`** | Stdio Pipes | JSON-lines / JSON-RPC 2.0 | Shielded FDs |
| **`envd` ↔ Shells** | PTY | Raw ANSI byte stream | `nix::pty::openpty`, redirected to `OMP_TTY` |
| **Journal Persistence** | File I/O | Server-Sent Events (SSE) raw frames | `<sessions_dir>/<session_id>.oms` |
| **CAS Blob Storage** | File I/O | Raw binary payloads (SHA-256) | `<data_dir>/blobs/<hh>/<hh>/<64-hex>` |

### 4. Cardinality & Authority Boundaries

| Relationship | Cardinality | Discovery / Lifecycle | Architectural Rationale |
|---|---|---|---|
| **Client ↔ `envd` Daemon** | **N - 1** | Clients connect via canonical root-hash UDS. | Centralizes authority over workspace files and persistent processes; prevents lock contention across concurrent terminals. |
| **Project Root ↔ `envd`** | **1 - 1** *(per build)* | Derived from canonical root directory (`Hash32::sum`). | Strict workspace isolation. Build-keyed sockets allow zero-downtime compiler upgrades. |
| **Client Session ↔ `Kernel`** | **1 - 1** | 1 active turn loop per interactive session. | Encapsulates turn lifecycle, prompt token budgets, and local conversation context. |
| **Kernel ↔ Subagents (`task`)** | **1 - N** | Driver spawns child `Kernel` instances tracked in DOM `<job>` tags. | Parallel execution of decoupled coding slices without polluting parent context. |
| **Subagent ↔ Subagent (`hub`)** | **N - N** | Peer-to-peer message routing via `SessionHub`. | Direct coordination and workpool synchronization between concurrent subagents. |
| **`envd` ↔ Python Workers** | **1 - N** *(pooled)* | Bounded pool (`DEFAULT_WORKER_LAYER_CEILING = 8`). | Fault containment: native Python C-extensions (wheels) can segfault or leak memory. Isolating them in worker processes prevents crashing `envd`. |
| **`envd` ↔ Interactive Shells** | **1 - N** | `ExecHost` manages active PTY sessions. | Detached servers and background jobs survive TUI restarts (`hub start`). |
| **Sessions ↔ Journal (`.oms`)** | **1 - 1** | Exactly one writer (`Session`) appends to one `.oms` file (`ADR 0004`). | Append-only linear history guarantees complete crash recovery and deterministic replay. |
| **Sessions ↔ CAS BlobStore** | **N - 1** | Shared project CAS keyed by SHA-256. | Deduplicates massive tool outputs across sessions and subagents. |
| **Clients ↔ `omp serve`** | **N - 1** | Central gRPC server for multiple clients. | Shared inference cache, API key pooling, rate-limiting, and cost accounting. |
| **Collaboration Room** | **1 - N** *(per room)* | 1 host broadcasts DOM patches to N guest viewers over WebSocket relay. | Real-time session observation and shared terminal debugging. |

## License

`omp` is released under the [MIT License](LICENSE).

Third-party material is excluded from these blanket license grants and remains
subject to its own license terms. See [third-party notices](THIRD-PARTY-NOTICES.txt)
for attribution and applicable terms.
