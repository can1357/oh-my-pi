# 0011. Cancellation is a runtime guarantee, not cooperative etiquette

Status: accepted
Date: 2026-09-02
Area: runtime

## Context

In pi and omp v1, extensions and custom tools ran inside the engine's JavaScript isolate. Two things
followed. Hot reload was nearly impossible: there is no way to unload a module that owns live
closures and timers in the same heap. And a tool call could not be forcibly stopped: once it escaped
cooperative cancellation, the only lever left was killing the harness.

JavaScript's `AbortSignal` and Go's `context.Context` are protocols, not enforcement. The failure
modes are ordinary:

- the author forgets to thread the signal into one call;
- a dependency does not accept a signal at all;
- the work is synchronous and never yields to check;
- an infinite retry loop swallows the abort as one more transient error.

In every case a timeout tells the *agent* to move on while the *work* keeps burning CPU, file
handles, and network in the background. Under the Factorio row (0001) nobody is there to notice; under
the multiplexed row the leaked work competes with live agents.

The host/sandbox split (0006) already puts execution outside session authority. Cancellation is the
same boundary viewed from the stop side.

## Decision

- A tool, extension, or job MUST run in an execution unit the host can terminate: a process, a
  worker, a subinterpreter, a VM request, or an equivalent boundary. Termination MUST NOT be able to
  take session authority with it — the unit that dies never owns the journal or the session tree.
- Cancellation is part of the runtime contract. The host MUST first request cooperative settlement,
  then, after a bounded grace, MUST forcibly terminate the unit and record the outcome. A tool author
  who ignores the request cannot prevent the stop.
- After effects have been authorized, forced termination MUST be recorded as uncertainty
  (effects may or may not have happened), never as a silent success or a missing event.
- Extensions and custom tools MUST NEVER share the engine's own runtime heap. Hot reload is a
  consequence: replace the unit, not the module.
- The chosen way to make this boundary pleasant is Python with `@remote` (0036): the extension
  author writes a local-looking function, the runtime ships it to a unit it can kill.

## Consequences

- Every cancellation reaches the resources, not just the awaiting future. Leaked background work is
  a bug in the supervisor, not an expected outcome.
- Hot reload of extensions becomes ordinary process replacement.
- Prohibited: in-process extension execution; tools whose only cancellation is a signal they may
  forget to honour; cancellation semantics that differ by tool.
- Cost accepted: an extra process or worker per execution unit, with the IPC and supervision that
  implies. The supervision code is written once in the engine (0002).

## Status in omp

**Implemented.** Primary implementation: `crates/agent/src/cancel.rs` (scopes) and
`crates/agent/src/dispatch.rs` (the ladder). Every tool scope carries two views of one stop: the
*commit* token a foreground mutation observes (session-only, so a turn interrupt never tears an
atomic commit) and the *interrupt* token the host raises on turn interruption or session
cancellation. `Dispatcher::dispatch` answers the interrupt token with cooperative settlement (feed
interrupt for in-process tools; `ExternalDispatchRequest.cancellation` for worker/remote units,
which `crates/driver/src/headless/kernel.rs` forwards to envd where `ExecHost` applies TERM →
`sv_interrupt_grace` → KILL to the process group), waits `DispatchPolicy::interrupt_grace` for the
unit's own verdict, then forcibly terminates and journals `Abort::EffectsUnknown` — never a missing
`tool.result@1`. A cancelled turn is recorded in the tree (`msg.assistant.end@1 cancelled` when an
assistant is open, then `<notice kind=warn>`), so the chat host derives "turn over" from the DOM.
The pause hold in `crates/agent/src/loop.rs` continues servicing interrupt, session cancellation,
rewind lifecycle, and job settlement instead of becoming an uncancellable wait. Workpool-forwarded
eval handlers execute back inside the retained killable eval process; the child's tool cancellation
token interrupts that IPC request, and reset epochs plus namespace generations fence stale handlers.
Workpool cancellation closes every worker input, raises each worker's shared `JobBoard` kill token,
waits a bounded grace for ordinary settlement, and journals its terminal snapshot before aggregate
delivery. On process restart, a live subagent without an execution unit is orphan-settled instead of
leaving `wait` and explicit revival fenced behind a phantom `running` state.
MCP transport execution in `crates/envd/src/mcp/{stdio,http,legacy_sse,timeout}.rs` applies the same
contract: request and connection deadlines cover framing and body reads, transport shutdown cancels
in-flight HTTP/SSE work, and stdio drop/close terminates and reaps the process tree with bounded
TERM-to-KILL escalation. Hook dispatches own cancellation guards and bounded reply deadlines;
dropping a gate removes its pending reply slot, while a cancelled durable approval is withdrawn and
the never-started call settles skipped. Tool-scoped aborts cancel only matching call scopes: calls
that never crossed the journaled execution-start boundary settle as skipped placeholders, started
calls that ignore the grace settle effects-unknown, and unrelated siblings continue. Inference-time scoped
aborts label each retained call separately and commit placeholders in provider call order. Daemon
startup failure and readiness timeout use the same bounded TERM→KILL process-group boundary in
`crates/envd/src/lib.rs`; hub and public `omp ps` stop/kill commands wait for the exact generation's
terminal state instead of reporting success while descendants remain live.
Proof: `crates/agent/tests/dispatch.rs::interrupt_kills_a_running_shell_tool_and_settles_aborted`,
`crates/agent/tests/dispatch.rs::tool_scoped_abort_forces_only_the_selected_sibling_and_replays`,
`crates/agent/tests/turn.rs::scoped_stream_abort_labels_siblings_in_call_order_and_replays`,
`crates/agent/tests/cancel.rs`,
`crates/envd/src/mcp/http.rs::tests::close_cancels_an_in_flight_http_exchange`,
`crates/envd/src/mcp/stdio.rs::tests::close_terminates_descendant_process_group`, and
`crates/e2e/tests/p7_tui.rs` (real PTY ctrl+c over a `sleep 30`).

## References

- The Harness Playbook, "The runtime" — "Cancellation requires a kill boundary", "Make the
  mandatory boundary pleasant"
- 0006 (host/sandbox split), 0010 (one job primitive), 0008 (call element status), 0036 (Python,
  `@remote`), 0002 (supervision owned once)
- `crates/envd/src/worker.rs`, `crates/envd/src/eval/process.rs`, `crates/agent/src/batch.rs`,
  `crates/agent/src/loop.rs`, `crates/agent/src/jobs.rs`, `crates/e2e/tests/p2_cancel_matrix.rs`
- Prior art named by the post: JavaScript `AbortSignal`, Go `context.Context`
