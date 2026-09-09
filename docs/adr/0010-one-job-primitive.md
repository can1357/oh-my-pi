# 0010. One job primitive for tools, subagents, daemons, and background work

Status: accepted
Date: 2026-09-02
Area: runtime

## Context

A raw tool callback can block for an arbitrary amount of time. Left unbounded, one long call causes
four distinct failures at once:

- the agent cannot adjust — it is inside an `await` with no way to observe or redirect the work;
- the user returns to a stuck session;
- an autonomous job (Factorio row, 0001) waits forever with nobody to notice;
- the provider's KV cache expires before the call returns, so the next turn pays full prefix cost.

Backgrounding was the obvious fix and was added ad hoc: a background flag on `Bash`, a separate
`Task` tool for subagents, a daemon manager elsewhere, each with its own timeout, output retention,
and inspection surface. A diagram Claude drew of its own `Bash` and `Task` tools showed the two
converging on the same interface: a signal in, a stream in, a stream out. Subagents, daemons, remote
functions, and ordinary tool calls have the same shape.

The duplication is visible in what users and agents ask for: users want to inspect a backgrounded
`Bash` for the same reason they want to inspect a subagent; agents want to discover peer daemons for
the same reason they want to message a peer worker. Each separate primitive had to grow those
features independently or lack them.

## Decision

- There MUST be one job primitive. Tool calls, subagents, daemons, remote functions, and
  backgrounded work are all instances of it: `signal + stream in + stream out`.
- Backgrounding MUST be part of the primitive, not a per-tool flag. Any job can be detached; a
  detached job settles through the same path a foreground job does.
- Maximum blocking time MUST be one policy owned by the runtime. A call that exceeds it detaches
  rather than holding the turn; the agent receives a job reference and continues.
- There MUST be one timeout policy, one artifact path for retained output (0009), and one
  observability surface (list, attach, logs, wait, cancel) across all job kinds. A feature added to
  the primitive — smart wait, dead-lettering, settlement delivery — applies to every kind.
- Cancellation of any job MUST go through the kill boundary (0011).

## Consequences

- The agent loop never blocks indefinitely on a tool; the KV cache stays warm because turns end.
- Inspecting a backgrounded shell, a subagent, and a daemon is the same operation, so the UI and the
  agent-facing tools learn it once.
- Prohibited: per-tool background flags with private timeout logic; subagent-specific or
  daemon-specific settlement paths; output retention that differs by job kind.
- Cost accepted: even a 50 ms `Read` is modelled as a job that happens to settle synchronously. The
  fast path stays fast; the type is shared.

## Status in omp

**Implemented.** Primary implementation: `crates/agent/src/jobs.rs`. The kernel job board and session `<meta><jobs>` component own detached tools and subagents. A durable call-entry link lets `JobBoard` adopt a terminal tool artifact after restart when `tool.result@1` committed but `jobs.settle` did not; otherwise the missing execution unit is orphan-settled, and the atomic async-result marker prevents duplicate delivery. Remote detached outcomes use the same path: `crates/driver/src/headless/kernel.rs` resumes verified CAS replication after a stream reconnect, while `crates/envd/src/blobs.rs` persists session/invocation-scoped delivery leases across host restarts, acknowledges each lease once, and releases content only after journal-derived roots disappear. `crates/agent/src/dispatch.rs` holds new tool, subagent, and job admission at the journal-derived global pause gate while existing units may settle.

Named daemons use that same surface: `crates/driver/src/subagent/hub.rs` maps
start/list/describe/logs/wait/send/restart/stop onto generation-fenced `omp-env` process requests,
projects each daemon as a normal `JobBoard` entry, bounds followed logs and wait buffers, and does not
acknowledge stop before `omp-envd` reports terminal process-tree settlement.

`crates/driver/src/subagent/workpool.rs` implements the work-pool observation producer without
adding a second settlement path: real worker transitions are topology-authenticated, display-only
events. `crates/driver/src/subagent/{workpool_scheduler.rs,workpool_runtime.rs}` owns persistent
worker selection, queueing, batches, dead-worker requeue, fresh-worker policy, and cancellation.
The actor prioritizes settlement over a bounded command inbox, auto-settles when its accepted queue
drains, waits for every worker's ordinary `JobBoard` settlement, and applies asynchronous mailbox
backpressure without duplicating the observation or model input. Production composition binds its
`ParentSessionHost` through `ProjectEnvironment::bind_eval_sdk_parent`; every job insertion and
snapshot patch crosses a typed `Up::SessionMutation` request so only the kernel actor touches the
authoritative `Session`. Its aggregate is a normal
`JobBoard` entry whose result keeps the atomic delivered marker; each transition also patches a
typed `workpool_state` snapshot, so replay can adopt a drained aggregate when a restart lands between
worker completion and `jobs.settle`. Worker-job results remain internal while authenticated
per-batch replies use the ordinary session mailbox. Each worker turn installs a child-local,
batch-specific `yield@2` roster: one strict
numbered key per stable item id, one incremental result per item, duplicate/unknown rejection, and
journal-replayed assembly in authored item order before aggregate settlement. A durable forced-yield
Director stays engaged through partial item submissions and uses the same bounded soft-to-native
retry ladder as ordinary schema-bound subagents. Eval-defined `@tool`
registrations are sealed at that authenticated bridge boundary and installed into each worker's
child-local registry; calls still flow through the ordinary tool dispatch, result, CAS spill, and
cancellation path rather than a workpool-specific executor.

## References

- The Harness Playbook, "The runtime" — "Bound blocking time once"
- 0008 (the call element these jobs mutate), 0009 (artifact path), 0011 (kill boundary), 0007
  (subagents as jobs with isolated views), 0001 (Factorio: no human to unstick a session)
- `crates/agent/src/jobs.rs` (`JobBoard`), `crates/tool/src/lib.rs` (`ToolTerminal::Detached`,
  `JobRef`), `crates/envd/src/worker.rs`, `crates/e2e/tests/p3_detached_jobs.rs`
