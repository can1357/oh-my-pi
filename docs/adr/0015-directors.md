# 0015. Directors own candidate yields

Status: accepted
Date: 2026-09-02
Area: control-plane

## Context

pi's extension layer is good, but it has a loop-shaped hole. Installing the most popular Plan and
Goal extensions and activating both produces: "Warning: Another workflow is active in this
session. End it before starting Plan mode." There is no workflow API in pi; both extensions came
from the same author, who built a private one — a `WorkflowMutex` speaking over a
`"workflow:mutex:v1"` event channel with an `"agent-workflow"` group, held-group map, and
generation counter. It keeps that author's plugins from colliding and cannot make anyone else's
compose.

omp v1 had the same hole with less ceremony. The exclusivity "system" was, in its entirety:

```ts
if (this.goalModeEnabled || this.goalModePaused) { this.showWarning("Exit goal mode first."); return; }
if (this.vibeModeEnabled)                        { this.showWarning("Exit vibe mode first."); return; }
// …restated by hand at six other entry points
```

Things increasingly want to direct the loop: plan wants another turn until a plan exists, goal
wants another turn until the goal is complete, `/force` wants to alter the next inference, the
todo reminder wants one last chance to object before yield. Each was a private flag checked at
seven entry points; none could see the others.

## Decision

The agent layer owns ONE primitive for behavior that keeps control across turns: a stack of
**Directors**. "Stack" means a live subtree in the session DOM (0003), never a runtime array
promised to serialize later. The DOM is the authority; the loop only walks it.

```text
candidate yield flows this way ────────────────────────────────┐
                                                               ▼
Base  →  TodoReminder  →  Goal  →  Plan  →  ForceTool(write)
                                                parent    child/top
```

The loop MUST stay this boring:

```python
while True:
    request = directors.prepare_inference(base_request)  # outside → inside
    turn = await inference(request)
    await execute_tools(turn)
    if turn.has_tool_calls:
        continue
    decision = await directors.on_yield(turn)            # inside → outside
    match decision:
        case Continue(): continue
        case Yield():    return
```

`prepare_inference` walks outside→in so the innermost Director refines the request its parent was
about to make. `on_yield` walks inside→out. Each Director returns exactly one of:

- **Pass** — let the next Director inspect the candidate yield;
- **Continue** — consume the yield and run another turn;
- **Yield** — consume it and yield to the user;
- **Push** — put a child Director on top of itself;
- **Done** — pop itself, then offer the same candidate yield to its parent;
- **Fail** — pop with an error.

Because the stack is a subtree: rewind removes Directors, resume restores them, and a remote
inspector sees which Director currently owns the candidate yield.

Extensions and built-ins use the same call: `await agent.direct(VerifyBeforeYield(...))`. Plan mode
is a full composition, not a mode: it pushes `ForceTool` when the plan file is missing
(`agent.force_tool("write", until=…, reminder=…, retries=3)`), receives the same candidate yield
back on `Done`, and either continues or yields. While Plan is active it does not `Pass`, so the
outer TodoReminder never sees that yield.

```xml
<directors>
  <todo-reminder id="d1">
    <plan id="d2" plan-file="local://auth-plan.md">
      <force-tool id="d3" tool="write" attempts="1" max-attempts="3"/>
    </plan>
  </todo-reminder>
</directors>
```

A **hook** observes or edits one inference or turn. A **Director** keeps control across turns and
intercepts yield. Anything that needs the second MUST be a Director; anything that only needs the
first MUST NOT be. Built-in behavior (plan, goal, vibe, autoresearch, reminders, verification)
MUST run on this public surface so holes in it cannot be ignored.

## Consequences

- Independently written behaviors compose without knowing each other's flags; exclusivity is a
  property of stack position, not seven hand-written checks.
- Yield ownership is a journaled fact: rewind, resume, fork, and inspection need no per-feature
  outcome tracking.
- `force_tool` becomes a small built-in Director rather than a special inference flag; its
  semantics stop at intent (0016).
- Prohibited: per-feature `*_mode_enabled` booleans on the controller, private mutex protocols
  between extensions, and any loop path that decides yield outside the Director walk.
- Cost accepted: every loop-owning behavior is rewritten as a Director with declared state, and a
  behavior that wants to see a yield its inner sibling consumed cannot — that is the contract.

## Status in omp

**Implemented.** Primary implementation: `crates/agent/src/director.rs`. Director stacks, verdicts,
slot arbitration, binds, and journal-derived state are implemented and covered by the ported
acceptance suite. Goal's Director retains ownership but yields on a prose-only candidate;
`crates/app/src/chat_control.rs` revalidates the live session pause, Plan, configured presentation
mode, and actor-local pending-input gate after an 800 ms idle boundary, then submits at most one
hidden continuation as a distinct session turn. Continuation arming, Goal identity, token
accounting baselines, finite-budget state, pause, completion, and drop are durable Director
properties; `crates/driver/src/headless/goal.rs` executes the hidden `goal@1` session tool directly
against that selected-branch state, and `crates/agent/src/loop.rs` derives the model-visible Goal
tool roster from it on every request. A prose-only continuation journals its hold, replay preserves
it, tool progress or genuine user input re-arms it, interruption and session selection pause the
Goal, and budget exhaustion holds as `budget-limited` rather than claiming completion. Separately,
`crates/agent/src/loop.rs` treats canonical `pause_turn` completions as non-terminal only at the
mailbox-safe boundary, caps consecutive pause-only re-samples at eight, re-arms the cap after tool
progress, yields to queued user input, and journals the eligibility decision on the originating
assistant node for replay.

## References

- The Harness Playbook, "The control plane" → "Behaviors: the loop-shaped hole", "Directors own
  candidate yields", "Plan mode, completely", "Hooks, Directors, and inference"
- 0002 (one owner), 0003 (tree as authority), 0004 (rewind/resume derive from the tree),
  0016 (semantic requests), 0019 (forced-call escalation)
- `crates/agent/src/regime.rs`, `crates/agent/src/arbiter.rs`, `crates/agent/src/control.rs`,
  `docs/architecture/agent-loop.md`, `docs/py/15-regimes.md`, `AGENTS.md` "Locked Deviations"
