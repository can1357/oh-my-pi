# OMP2 Autonomous Development & Verification Capabilities

**Date:** 2025-01-09
**Status:** Research report
**Scope:** Source-backed audit of implemented autonomous development and verification infrastructure

---

## Executive Summary

OMP2 has a mature, journal-first autonomous development runtime. The core consists of:
- A **Director stack** for multi-turn behavior orchestration (11 built-in Directors)
- A **crash-tolerant journal** (.oms format) with blob CAS for persistence
- A **5-phase hook decision procedure** for extensions and admission control
- An **ADW workflow engine** for declarative, phase-based workflows with resume
- A **job board** with 4 execution shapes (Tool, Subagent, Process, Remote Execution)
- **Typed tool contracts** with central dispatch policy and output bounding
- **E2E proofs** P1-P14 covering concurrency, cancellation, crash recovery, and isolation

This report distinguishes implemented capabilities from partial, planned, or absent ones.

---

## 1. ADW and Workflow Orchestration

### Implemented

**ADW Workflow Engine** (`crates/driver/src/adw/mod.rs`, 1469 lines)

Pure state machine that drives phase-based workflows. Key structures:

- `WorkflowDefinition` — declares phases, inputs, outputs, posture requirements
- `AdwHost` trait — resolves posture, dispatches phases, reports results
- `run()` / `run_with_log()` — drives a workflow to acceptance, halt, block, failure, or cancellation
- `resume_from_log()` — resumes from journal after crash (ADR 0051 D5, D6)
- `PhaseResult` / `PhaseStatus` / `PhaseRecord` — settled phase outcomes
- `RunExit` — terminal run status with records

**Run Journal** (`crates/journal/src/runlog.rs`, 375 lines)

Typed vocabulary for ADW run logging:
- `adw.run.start@1` — run genesis with workflow digest, model, posture
- `adw.phase.dispatch@1` — phase attempt committed
- `adw.phase.settle@1` — phase attempt finished
- `adw.phase.uncertain@1` — recovery found dispatch without settle
- `adw.run.halt@1` — run stopped without finishing
- `adw.run.done@1` — run reached terminal outcome

**Posture Resolution** (`crates/contract/src/posture.rs`)

Execution posture (network scope, write scope) resolved by host before dispatch. Domain compares posture against phase requirements.

**Delegated Execution** (`crates/contract/src/delegated/`)

Support for delegated executors:
- `delegated/executor.rs` — executor interface
- `delegated/policy.rs` — policy mediation
- `delegated/drive.rs` — drive logic for delegated phases
- `delegated/permission.rs` — permission model

### Partial

**Remote Execution** (`crates/driver/src/adw/remote.rs`)

Remote code phase execution with fallback to local. P13 (`crates/e2e/tests/p13_remote_exec.rs`) exists but is **not gated in CI** (the one gap per AGENTS.md).

### Classification

| Capability | Status | Location |
|------------|--------|----------|
| Phase-based workflow engine | Implemented | `crates/driver/src/adw/` |
| Run journal with resume | Implemented | `crates/journal/src/runlog.rs` |
| Posture resolution | Implemented | `crates/contract/src/posture.rs` |
| Delegated execution | Implemented | `crates/contract/src/delegated/` |
| Remote execution | Partial (not CI-gated) | `crates/driver/src/adw/remote.rs` |

---

## 2. Native Task Scheduling and Dependency Handling

### Implemented

**Job Board** (`crates/agent/src/jobs.rs`, 2967 lines)

Runtime supervision index rebuilt from `<meta><jobs>` DOM tree. Four execution shapes:

```rust
pub enum JobKind {
    Tool,       // Detached ordinary tool call
    Subagent,   // Child agent kernel
    Process,    // Supervised process or daemon
    Execution,  // Remote execution backend job
}
```

Key capabilities:
- `JobBoard` — connects DOM elements to kill boundaries
- `JobState` — lifecycle tracking (pending, running, settled, cancelled)
- `JobRef` — durable reference with idempotency
- Settlement delivery — settled jobs re-wake the loop with results
- Approval integration — `ApprovalBook` for ticket-based approvals
- Execution backend integration — `omp-exec` crate for remote backends

**Task Execution** (`crates/agent/src/dispatch.rs`, 4532 lines)

Central dispatch policy:
- `DispatchPolicy` — output bounds (64 KiB default, 8 MiB hard), blocking limit (30s), interrupt grace (1s)
- `Dispatcher` — multiplexed loop, concurrent read-only calls, exclusive mutating calls
- `ToolCancellation` — scoped cancellation (Foreground, ReadOnly, Background)
- Artifact spill — complete output to blob store when bounded

**Cancellation Tree** (`crates/agent/src/cancel.rs`)

Hierarchical cancellation:
- Session-level cancellation
- Turn-level cancellation (`TurnCancellation`)
- Per-call cancellation scopes
- Grace periods and force termination (ADR 0011)

### Classification

| Capability | Status | Location |
|------------|--------|----------|
| Job board with 4 execution shapes | Implemented | `crates/agent/src/jobs.rs` |
| Central dispatch policy | Implemented | `crates/agent/src/dispatch.rs` |
| Hierarchical cancellation | Implemented | `crates/agent/src/cancel.rs` |
| Approval relay | Implemented | `crates/agent/src/jobs.rs` + `crates/envd/src/approval_relay.rs` |
| Remote execution backends | Implemented | `crates/agent/src/jobs.rs` (via `omp-exec`) |

---

## 3. Session and Journal Persistence

### Implemented

**Journal** (`crates/journal/src/lib.rs`, 687 lines)

Crash-tolerant `.oms` journal:
- Flat raw-SSE file format, blank line commits entry
- Exclusive advisory lock prevents divergent writers
- Truncates only after last commit point on open
- Branch support via `prior` links (rewind never destroys history)
- `Journal::create()` / `Journal::open()` / `Journal::append()`
- Custom `Vocabulary` for extension kinds

**Blob Store** (`crates/journal/src/blob.rs`)

Content-addressed storage:
- `BlobStore` — CAS for compaction summaries, spilled output, attachments
- `BlobRef` — content address reference
- `BlobStage` — staging for large outputs before commit

**Session** (`crates/session/src/session.rs`, 1379 lines)

Journal-derived authoritative session tree:
- `Session` — mutable controller, folds journal entries into DOM
- `ComponentRegistry` — journal-to-DOM reducers
- Idempotency keys — `IdempotencyKey` for replay-safe mutations
- `AppendOutcome` — Appended vs Replayed
- `ToolReceipt` — per-call cost tracking (bytes, elapsed, outcome)
- `UnsettledCall` — live chain of in-progress tool calls
- Subscribe pattern — `Session::subscribe()` for observers

**Components** (`crates/session/src/components/`)

Built-in journal-derived `<meta>` components:
- `con.rs` — console-variable subtree
- `directors.rs` — Director engagement subtree
- `jobs.rs` — detached-work projection
- `lifecycle.rs` — lifecycle-sensitive components
- `prompts.rs` — deferred-prompt subtree
- `todo.rs` — todo snapshot projection

**Rewind** (`crates/session/src/rewind.rs`, 87 lines)

Lifecycle work derivation:
- `LifecycleWork` — terminate, spawn, retained lists
- `diff()` — diffs lifecycle-bearing elements between DOM snapshots
- Handles `<subagent>`, `<job>`, and running tool-call elements

### Classification

| Capability | Status | Location |
|------------|--------|----------|
| Crash-tolerant journal | Implemented | `crates/journal/src/lib.rs` |
| Content-addressed blob store | Implemented | `crates/journal/src/blob.rs` |
| Session with fold and components | Implemented | `crates/session/src/session.rs` |
| Idempotent mutations | Implemented | `crates/journal/src/idempotency.rs` |
| Rewind and lifecycle diff | Implemented | `crates/session/src/rewind.rs` |
| Branch support (prior links) | Implemented | `crates/journal/src/chain.rs` |

---

## 4. Checkpointing and Recovery

### Implemented

**Crash Recovery** (`crates/session/src/exit_diagnostics.rs`)

Exit diagnostics:
- `SessionExit` — crash tail, exit cause, exit signal
- `latest_session_exit()` — reads last exit state
- `CrashTail` — recovered bytes from incomplete journal entry

**Replay** (`crates/session/src/fold.rs`)

Replay from journal:
- Same fold function for live append and replay
- Idempotency ensures no duplicate effects
- `Session::create()` + replay = full recovery

**ADW Resume** (`crates/driver/src/adw/resume.rs`)

Workflow resume from run journal:
- Replays recorded dispatches and settles
- Detects uncertain attempts (dispatched but not settled)
- Safe retry only for read-only, no-effects phases
- Records uncertain attempts and halts

**Unknown Effects Recovery** (`crates/agent/src/loop.rs`)

Tool call recovery after crash:
- `UnknownEffectsCall` — calls that may have run
- `RetryConfirmation` — caller confirms re-run
- `RetryOutcome` — Ran or NeedsConfirmation
- NOT_STARTED vs STARTED reasons for disappeared calls

**Compaction** (`crates/agent/src/directors/compaction.rs`, 1162 lines)

Context management as implicit checkpoint:
- Automatic compaction at 80% context threshold
- Two strategies: `soft` (LLM summary) and `snapcompact` (verbatim PNG archive)
- Manual compaction via `/compact`
- Handoff document mode for context transfer

### Classification

| Capability | Status | Location |
|------------|--------|----------|
| Crash recovery from journal | Implemented | `crates/session/src/exit_diagnostics.rs` |
| Journal replay | Implemented | `crates/session/src/fold.rs` |
| ADW workflow resume | Implemented | `crates/driver/src/adw/resume.rs` |
| Unknown effects recovery | Implemented | `crates/agent/src/loop.rs` |
| Context compaction | Implemented | `crates/agent/src/directors/compaction.rs` |
| Snapcompact (verbatim archive) | Implemented | `crates/agent/src/directors/snapcompact.rs` |

---

## 5. Tool Execution and Permissions

### Implemented

**Typed Tool Contracts** (`crates/tool/src/lib.rs`, 2519 lines)

Revisioned tool contracts:
- `ToolSpec` — typed parameters, results, effects, confinement
- `Registry` — tool registry with versioned identities
- `InvocationFeed` — streaming argument consumption
- `IncomingParams` — live parameter access during streaming
- `CallOutcome` — terminal outcomes with typed results
- `Effects` — declared side effects (read, write, exec, network)
- `Confinement` — execution sandbox declaration
- `ToolRestrictions` — roster restrictions (ADR 0024)
- `DevicePath` — device-based tool routing

**Central Dispatch** (`crates/agent/src/dispatch.rs`)

Execution policy:
- `DispatchPolicy` — output bounds, blocking limits, interrupt grace
- `Dispatcher` — multiplexed execution loop
- Concurrent read-only, exclusive mutating calls
- Central spill gate with `artifact://` addressing
- Policy denials — `RosterDenial`, `WriteScopeDenied`

**Tool Execution Backends** (`crates/tools/`)

Implementations in separate crate, registered via `Registry::register()`.

**Environment Protocol** (`crates/env/` + `crates/envd/`)

Client/host split:
- `omp-env` — typed client, no host resources
- `omp-envd` — live project-environment host (220+ files)
- Filesystem, process, document, tool authorities
- Python extension-host/worker supervision

**Permissions** (`crates/tool/src/restrictions.rs`)

- `ToolRestrictions` — latched wire roster per session
- `RosterDenial` — policy denial reasons
- `plan_target_matches` — plan-mode write restrictions
- Per-call restriction snapshots enforced at dispatch

### Classification

| Capability | Status | Location |
|------------|--------|----------|
| Typed tool contracts | Implemented | `crates/tool/src/lib.rs` |
| Central dispatch policy | Implemented | `crates/agent/src/dispatch.rs` |
| Tool registry | Implemented | `crates/tool/src/registry.rs` |
| Environment protocol | Implemented | `crates/env/` + `crates/envd/` |
| Roster restrictions | Implemented | `crates/tool/src/restrictions.rs` |
| Device-based routing | Implemented | `crates/tool/src/device_path.rs` |

---

## 6. Native Verification and Test Discovery

### Implemented

**E2E Proofs** (`crates/e2e/tests/`)

Authoritative joined-system proofs:

| Proof | File | Coverage | CI-Gated |
|-------|------|----------|----------|
| P1 | `p1_doc_race.rs` | Document race conditions | Yes |
| P1 | `p1_editor_buffer.rs` | Editor buffer behavior | Yes |
| P2 | `p2_cancel_matrix.rs` | Cancellation matrix | Yes |
| P3 | `p3_detached_jobs.rs` | Detached job lifecycle | Yes |
| P4 | `p4_schema_isolation.rs` | Schema isolation | Yes |
| P5 | `p5_prefix_stability.rs` | Prompt prefix stability | Yes |
| P6 | `p6_crash_resume.rs` | Crash and resume | Yes |
| P7 | `p7_tsp.rs` | Real-PTY lifecycle | Yes |
| P7 | `p7_tui.rs` | TUI behavior | Yes |
| P8 | `p8_baselines.rs` | Performance baselines | Non-gating |
| P9 | `p9_agent_settled.rs` | Agent settlement | Yes |
| P9 | `p9_continuation_grants.rs` | Continuation grants | Yes |
| P9 | `p9_extension_control.rs` | Extension Director/Component control | Yes |
| P9 | `p9_isolation.rs` | Isolation proofs | Yes |
| P10 | `p10_lift_idempotence.rs` | Tool-lift idempotence | Yes |
| P11 | `p11_collab_spectator.rs` | Collaboration spectators | Yes |
| P12 | `p12_daemon_approvals.rs` | Daemon approval relay | Yes (macOS only) |
| P13 | `p13_remote_exec.rs` | Remote execution | **No (gap)** |
| P14 | `p14_session_attach.rs` | Session attach | Yes |
| — | `tool_sources.rs` | Environment tool-source routing | Yes |

**Test Infrastructure**

- `cargo nextest run` (not bare `cargo test`)
- `insta` snapshots for shell parser/tokenizer
- `proptest` for encoding, zero-copy slicing, transcript replay
- Real-PTY verification via `.omp/tools/tui.ts` or `OMP_TTY`/`OMP_TUI_DEBUG`
- Bounded waits + RAII-owned processes in E2E

**Cleanse Parsers** (`crates/driver/src/cleanse/`)

Output parsing for verification:
- `parsers/cargo.rs` — Cargo output
- `parsers/junit.rs` — JUnit XML
- `parsers/sarif.rs` — SARIF format
- `parsers/stylelint.rs` — Stylelint output
- `parsers/tap.rs` — TAP format
- `parsers/terraform.rs` — Terraform output

### Classification

| Capability | Status | Location |
|------------|--------|----------|
| E2E proof system (P1-P14) | Implemented | `crates/e2e/tests/` |
| Crash recovery proof (P6) | Implemented | `crates/e2e/tests/p6_crash_resume.rs` |
| Real-PTY verification (P7) | Implemented | `crates/e2e/tests/p7_tsp.rs` |
| Cleanse parsers | Implemented | `crates/driver/src/cleanse/` |
| Performance baselines (P8) | Implemented (non-gating) | `crates/e2e/tests/p8_baselines.rs` |
| Remote exec proof (P13) | Implemented (not CI-gated) | `crates/e2e/tests/p13_remote_exec.rs` |

---

## 7. Hooks, Extensions and Skills

### Implemented

**Hook Decision Procedure** (`crates/contract/src/hooks.rs`, 2168 lines)

5-phase ordered decision procedure:

```rust
pub enum HookPhase {
    Precheck  = 0,  // Deterministic deny-only
    Transform = 1,  // Ordered request transformations
    Review    = 2,  // Parallel, budgeted review
    Approval  = 3,  // Approval requirements, final votes
    Observe   = 4,  // Async observation after outcome
}
```

Hook decisions:
```rust
pub enum HookDecision {
    Allow,           // Affirmative vote
    Deny,            // Refuse
    Modify,          // Replace/patch request
    Defer,           // Abstain
    RequireApproval, // Create approval requirement
}
```

Key features:
- `HookGate` — lifecycle gate for extensions
- `LifecycleHooks` — installed on Kernel and Dispatcher
- Phase legality — each decision legal only in specific phases
- Budgeted review — parallel review with attempt budgets
- Approval integration — `ApprovalSpec` and `ApprovalBook`

**Extension System** (`crates/ext/src/`)

Extension configuration, resolution, locking, trust:
- `config.rs` — extension configuration
- `resolver.rs` — dependency resolution
- `lock.rs` — lockfile management
- `trust.rs` — trust domain
- `workspace_trust/` — workspace trust inventory
- `claude_hooks.rs` — Claude hook integration
- `claude_plugin.rs` — Claude plugin format
- `marketplace.rs` — marketplace integration
- `upgrade.rs` — upgrade management
- Layer model — Client vs Workspace layers
- Trust tiers — Sandboxed vs Trusted

**Extension Registration** (`crates/contract/src/extensions.rs`, 200 lines)

Narrow registration surface:
- `ExtensionRegistrar` — directors, components, tool specs
- `InstalledExtensions` — admitted extensions
- `LiveComponent` — external reducer callback
- No custom journal kinds, no extension-owned state store

**Skills** (`crates/agent/src/loop.rs`)

Skill invocation as typed turns:
- `Kernel::run_skill_turn()` — runs skill prompt as user turn
- `SkillPrompt` — journaled skill metadata
- Skills are prompts, not code — no special execution path

**Managed Skills** (`crates/contract/src/managed_skills.rs`)

Managed skill infrastructure for extension-provided skills.

### Classification

| Capability | Status | Location |
|------------|--------|----------|
| 5-phase hook procedure | Implemented | `crates/contract/src/hooks.rs` |
| Extension system | Implemented | `crates/ext/src/` |
| Extension registration | Implemented | `crates/contract/src/extensions.rs` |
| Live components | Implemented | `crates/contract/src/extensions.rs` |
| Skill invocation | Implemented | `crates/agent/src/loop.rs` |
| Managed skills | Implemented | `crates/contract/src/managed_skills.rs` |

---

## 8. Subagent Lifecycle and Execution Backends

### Implemented

**Director Stack** (`crates/contract/src/director.rs`, 1692 lines)

DOM-backed behavior orchestration:

```rust
pub trait Director: Send + Sync {
    fn id(&self) -> &str;
    fn claims(&self) -> &[Slot];          // Exclusive resources
    fn binds(&self) -> &[(Str, BindValue)]; // Convar bindings
    fn before_inference(...) -> Prepared;  // Cold aux before request
    fn prepare_inference(...);             // Sync request refinement
    fn watch_stream(...) -> StreamWatch;   // Response observer
    fn before_yield(...) -> ();            // Cold aux before yield
    fn observe_turn(...) -> StateUpdate;   // Turn observer
    fn after_settled_turn(...) -> DirectorEffect; // Completion effect
    fn evaluate(...) -> DirectorEffect;    // Candidate yield inspection
}
```

**Built-in Directors** (`crates/agent/src/directors/mod.rs`):

| Director | Purpose | File |
|----------|---------|------|
| `advisor` | Second-model review of yields | `advisor.rs` |
| `autoresearch` | Autonomous research mode | `autoresearch.rs` |
| `compaction` | Context compaction | `compaction.rs` |
| `force_tool` | Force specific tool calls | `force_tool.rs` |
| `goal` | Goal-mode, multi-turn until complete | `goal.rs` |
| `loop_mode` | Loop control mode | `loop_mode.rs` |
| `plan` | Plan composition with write/decision gates | `plan.rs` |
| `prewalk` | Pre-inference model selection | `prewalk.rs` |
| `snapcompact` | Verbatim bitmap compaction | `snapcompact.rs` |
| `stream_rules` | TTSR-like stream behavior | `stream_rules.rs` |
| `todo_reminder` | Todo tracking reminders | `todo_reminder.rs` |
| `vibe` | Vibe coding mode | `vibe.rs` |

**Slot System** (`crates/contract/src/slots.rs`)

Exclusive resource claims:
- `Slot::Mode` — mode prompt ownership
- `Slot::Loop` — loop control ownership
- `Slot::ToolChoice` — tool selection ownership
- `Slot::Worktree` — worktree ownership

**Subagent Spawning** (`crates/agent/src/jobs.rs`)

Subagent as JobKind:
- `JobKind::Subagent` — child agent kernel
- Isolation via separate session/journal
- Result delivery via job settlement
- Request budget control (`RunControl::with_request_budget()`)
- Read-only ceiling inheritance (`spawns_read_only()`)

**Execution Backends** (`crates/agent/src/jobs.rs` via `omp-exec`)

Remote execution:
- `ExecutionBackend` trait
- `ExecutionRequest` / `ExecutionResult` / `ExecutionRun`
- `ReattachContext` / `ReattachHandle` — durable reattach
- `BackendId` — backend identification
- `DurableExecutionResult` — journaled result format

**Mailbox Protocol** (`crates/contract/src/mailbox.rs`)

Single flume mailbox for agent input:
- `Up` — upward messages (input, interrupts, results)
- `KernelSender` — typed sender
- Priority signals via `tokio::watch` + `select!`

### Classification

| Capability | Status | Location |
|------------|--------|----------|
| Director stack | Implemented | `crates/contract/src/director.rs` |
| 11 built-in Directors | Implemented | `crates/agent/src/directors/` |
| Slot-based resource claims | Implemented | `crates/contract/src/slots.rs` |
| Subagent spawning | Implemented | `crates/agent/src/jobs.rs` |
| Remote execution backends | Implemented | `crates/agent/src/jobs.rs` (via `omp-exec`) |
| Mailbox protocol | Implemented | `crates/contract/src/mailbox.rs` |
| Stream observation | Implemented | `crates/contract/src/director.rs` |

---

## 9. Turn Flow and Kernel Architecture

### Implemented

**Kernel** (`crates/agent/src/loop.rs`, 5548 lines)

The agent turn kernel:

```rust
pub struct Kernel<C> {
    client: C,                    // Inference capability
    dispatcher: Dispatcher,       // Tool dispatch
    cancel: CancelTree,           // Cancellation hierarchy
    director_registry: DirectorRegistry,
    live_components: Vec<Box<dyn LiveComponent>>,
    lifecycle_hooks: Option<LifecycleHooks>,
    prompt: Arc<dyn PromptSource>,
    wire: WireRoster,             // Latched tool roster
    mailbox_tx: flume::Sender<Up>,
    approvals: ApprovalDesk,
    // ...
}
```

**Turn Methods:**
- `run_turn()` — explicit user turn
- `run_authored_turn()` — collaboration turn with author
- `run_skill_turn()` — skill invocation turn
- `run_custom_turn()` — extension-authored turn
- `run_turn_body()` — core turn loop

**Turn Loop** (`run_turn_body`, line 1401):
1. Director stack from DOM
2. Admission control drain
3. Pause gate check
4. Director `after_settled_turn()` (post-crash recovery)
5. Job settlement delivery
6. Request budget check
7. Inference (replay or new request)
8. Tool dispatch and execution
9. Director yield evaluation
10. Loop or yield

**Turn Outcome:**
```rust
pub enum TurnStop {
    Completed,   // Passed Director stack
    Cancelled,   // Cancellation observed
    Steered,     // Steering consumed
    Failed,      // Journaled error
}
```

**Prompt System** (`crates/agent/src/prompt/`)

Scribe compiled templates:
- `slots.rs` — banded named slots (Frozen/Stable/Dynamic/Volatile)
- `projection.rs` — prompt projection from session DOM
- `assets.rs` — prompt assets
- `PromptSource` trait — `system_items()` + `volatile_items()`

### Classification

| Capability | Status | Location |
|------------|--------|----------|
| Kernel turn loop | Implemented | `crates/agent/src/loop.rs` |
| Multiple turn types | Implemented | `crates/agent/src/loop.rs` |
| Director yield arbitration | Implemented | `crates/contract/src/director.rs` |
| Prompt projection | Implemented | `crates/agent/src/prompt/` |
| Banded prompt slots | Implemented | `crates/agent/src/prompt/slots.rs` |
| Stream observation | Implemented | `crates/contract/src/director.rs` |

---

## 10. Duplication Risks and Native Reuse Recommendations

### Existing Capabilities That Cover Common Needs

| Common Need | Native Capability | Location |
|-------------|-------------------|----------|
| Task orchestration | Director stack + job board | `crates/contract/src/director.rs`, `crates/agent/src/jobs.rs` |
| Workflow phases | ADW engine | `crates/driver/src/adw/` |
| State persistence | Journal + blob CAS | `crates/journal/` |
| Crash recovery | Journal replay + resume | `crates/session/src/fold.rs`, `crates/driver/src/adw/resume.rs` |
| Admission control | Hook decision procedure | `crates/contract/src/hooks.rs` |
| Extension system | Extension registrar | `crates/contract/src/extensions.rs` |
| Tool execution | Central dispatch | `crates/agent/src/dispatch.rs` |
| Subagent spawning | Job board Subagent kind | `crates/agent/src/jobs.rs` |
| Context management | Compaction Director | `crates/agent/src/directors/compaction.rs` |
| Goal tracking | Goal Director | `crates/agent/src/directors/goal.rs` |
| Plan mode | Plan Director | `crates/agent/src/directors/plan.rs` |
| Verification | E2E proofs + cleanse parsers | `crates/e2e/tests/`, `crates/driver/src/cleanse/` |

### Anti-Patterns to Avoid

1. **Do not create a second production stack** — `crates/driver` + `crates/app` = the production stack. Libraries never build a second stack.

2. **Do not create parallel state** — Durable state = append-only journal + blob store. Turn state = journal-folded session DOM. No parallel mutable source of truth.

3. **Do not create redundant orchestration** — Directors + job board + ADW engine cover orchestration needs.

4. **Do not create redundant memory systems** — Journal + blob CAS + DOM = the memory system.

5. **Do not create redundant verification** — E2E proofs + cleanse parsers + hook system cover verification.

6. **Do not create redundant config stores** — `crates/con` owns typed convars and cfg persistence.

---

## 11. Summary of Capability Status

| Area | Implemented | Partial | Absent |
|------|-------------|---------|--------|
| ADW orchestration | Phase engine, run journal, posture, delegated exec | Remote exec (not CI-gated) | — |
| Task scheduling | Job board, dispatch, cancellation, approvals | — | — |
| Session/journal | Journal, blob CAS, session, components, rewind | — | — |
| Checkpointing | Crash recovery, replay, resume, compaction | — | — |
| Tool execution | Typed contracts, dispatch, registry, env protocol | — | — |
| Verification | E2E proofs P1-P14, cleanse parsers | P13 (not CI-gated) | — |
| Hooks/extensions | 5-phase hooks, extension system, skills | — | — |
| Subagent lifecycle | Directors, slots, subagent jobs, backends | — | — |
| Turn flow | Kernel, turn types, prompt system, stream obs | — | — |

**Overall assessment:** OMP2 has comprehensive autonomous development and verification capabilities. The architecture is journal-first, with crash tolerance built into every layer. The main gap is P13 (remote execution) not being CI-gated.

---

## 12. Key File Index

| File | Lines | Purpose |
|------|-------|---------|
| `crates/agent/src/loop.rs` | 5548 | Agent turn kernel |
| `crates/agent/src/dispatch.rs` | 4532 | Tool dispatch and execution |
| `crates/agent/src/jobs.rs` | 2967 | Job board and supervision |
| `crates/contract/src/director.rs` | 1692 | Director trait and stack |
| `crates/contract/src/hooks.rs` | 2168 | Hook decision procedure |
| `crates/driver/src/adw/mod.rs` | 1469 | ADW workflow engine |
| `crates/session/src/session.rs` | 1379 | Session controller |
| `crates/agent/src/directors/compaction.rs` | 1162 | Context compaction |
| `crates/tool/src/lib.rs` | 2519 | Typed tool contracts |
| `crates/journal/src/lib.rs` | 687 | Crash-tolerant journal |
| `crates/contract/src/extensions.rs` | 200 | Extension registration |
| `crates/session/src/rewind.rs` | 87 | Lifecycle work derivation |
| `crates/journal/src/runlog.rs` | 375 | ADW run journal |
