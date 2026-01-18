# IPython Kernel REPL Integration Plan

## Assumptions
- No sandboxing or persistence beyond the current agent session.
- Local Python + ipykernel available (install step needed if missing).
- Integration follows existing `bash` tool behavior for streaming, truncation, and TUI rendering.

## Reference Docs
- Kernel protocol + message flow: `docs/ipy-kernel-protocol.md`
- TUI streaming + truncation mapping: `docs/ipy-tui-ux.md`
- Integration points and adapter interfaces: `docs/ipy-integration-points.md`
- Python prelude helpers: `docs/ipy-prelude.md`

## Open Decisions to Lock
- Kernel reuse policy: per-session shared kernel vs per-call kernel. Recommendation: per-session shared kernel with per-call queueing.
- Parallel tool calls: queue per kernel, spawn new kernel for concurrent calls if requested.
- Kernel restart policy: restart on crash or after N executions / memory threshold (start with crash-only).
- Startup policy: lazy init by default; optional warm start at session begin.
- Interrupt mode: prefer `interrupt_request` when supported; fall back to SIGINT.

## Phase 1 — Kernel IPC + Executor + Tool Wiring
Goal: end-to-end `python` tool that executes code via ipykernel, streams output, and returns bash-style results.

### TODO
- [ ] Add a kernel lifecycle module (spawn, connect, shutdown) per `docs/ipy-kernel-protocol.md`.
- [ ] Implement connection file generation with free-port allocation and HMAC signing.
- [ ] Implement ZMQ client wiring for shell/iopub/control/stdin/hb channels.
- [ ] Implement message encoding/decoding (`<IDS|MSG>` framing + JSON parts + HMAC signature).
- [ ] Implement `KernelConnection.execute()` that streams IOPub messages and resolves on `status: idle`.
- [ ] Implement `python-executor.ts` mirroring `BashExecutorOptions` and `BashResult` semantics (see `docs/ipy-integration-points.md`).
- [ ] Reuse or extract `createOutputSink` logic so Python executor gets the same truncation + spill behavior as bash.
- [ ] Add `python` tool module mirroring `bash.ts` streaming/onUpdate behavior (see `docs/ipy-tui-ux.md`).
- [ ] Add tool registration and prompt template for `python` tool.
- [ ] Add settings flag to select tool exposure: bash-only, ipy-only, or both (default ipy-only).
- [ ] Auto-fallback: if kernel launch fails, expose bash tool only for that session.
- [ ] Update all prompts that reference the bash tool via template rendering so tool availability is dynamic.
- [ ] Add a Python tool prompt describing built-in helpers and shell bridge (see `docs/ipy-prelude.md`), plus matplotlib guidance (`plt.show()` headless; use `plt.savefig()` or return figure).
- [ ] Environment propagation: pass user env vars (with explicit allowlist/denylist), set PYTHONPATH, and detect venv when launching kernel.
- [ ] Dependency detection: detect `python` + `ipykernel` availability; return actionable error if missing.
- [ ] Manual validation: stdout, stderr, errors, timeouts, large output truncation, image/png, and application/json rendering.

## Phase 2 — TUI/UX Polish + Reliability + Tests
Goal: solid UX parity with bash tool and reliable CI coverage.

### TODO
- [ ] Add a dedicated renderer or reuse `bashToolRenderer` with Python-specific label/metadata.
- [ ] Ensure expand/collapse behavior uses `details.fullOutput` and `truncateTail` consistently.
- [ ] Implement queueing for concurrent calls to the same kernel; add a config option for per-call kernels.
- [ ] Error recovery: detect kernel crash/ZMQ drop and auto-restart once per session.
- [ ] stdin handling: on `stdin_request`, return a tool error after timeout with guidance (no silent hangs).
- [ ] Output types: support `text/plain`, render `image/png` (kitty images), and render `application/json` as a collapsible property tree (reuse task tool tree renderer patterns). If only `text/html` is present, convert to markdown and emit as text output.
- [ ] Kernel selection: document a future `kernel` parameter and strategy for multiple Python versions.
- [ ] Startup optimization: measure kernel spawn latency; if >2s, consider warm start on session init or prelude injection after kernel_info.
- [ ] Heartbeat monitoring: periodic HB ping (e.g., every 5s) to detect silent kernel death; restart on failure.
- [ ] Tests: mock kernel messages for unit tests; add a dev logging flag for IPC trace output.
- [ ] Add developer docs for kernel requirements, shell bridge behavior, and troubleshooting.

## Exit Criteria
- `python` tool can execute multi-line code and stream output in TUI.
- Output truncation and full-output expansion match bash tool behavior.
- Timeouts/cancellations produce consistent error messaging.
- Kernel crash detection triggers automatic restart.
- Tests cover core execution and error paths.
