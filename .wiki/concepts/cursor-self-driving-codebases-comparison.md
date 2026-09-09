# Multi-Agent Workflows: OMPK vs. Cursor Self-Driving Codebases & Token-Saving Fusion

## 1. Architectural Comparison: OMPK vs. Cursor Self-Driving Codebases

**We have many of the necessary components, but we haven’t yet combined them into—or demonstrated—the continuously autonomous system described in that article.**

The most useful distinction is:

> **OMPK currently provides several capable multi-agent execution paths. Cursor’s final research design makes one particular planner/worker operating model the default.**

I read the article and inspected our current orchestration, isolation, durable queues, relay, recovery, and model-routing implementations. This compares us with **the research architecture in that February 2026 post**, not every capability of today’s Cursor product.

## What Cursor actually ended up with

Their final architecture is not simply “an orchestrator spawning agents”:

- A **root planner does no coding** and owns the overall goal.
- It recursively delegates substantial areas to **scope-owning subplanners**.
- Workers execute bounded tasks in **their own repository copies**.
- Workers do not coordinate laterally; they return rich handoffs to the responsible planner.
- Those handoffs trigger further planning, keeping the system moving continuously.
- They removed the central integrator and tolerated temporary errors to avoid serializing everything.

Their reported week-long run and peak of approximately **1,000 commits/hour** are impressive scale evidence, but not a production-quality benchmark. The article explicitly acknowledges imperfect code and temporary breakage.

## Where we compare

| Dimension | Cursor’s final research design | OMPK today |
|---|---|---|
| **Recursive delegation** | Planners recursively delegate ownership of substantial scopes. | **Supported**, with runtime recursion controls. But recursive, scope-owning subplanners are not mandatory or the default workflow. |
| **Planner/worker separation** | Planners plan; workers code. | **Partial.** Some specialist roles have hard restrictions, but a general root or task agent can still plan, code, review, and integrate. |
| **Worker context** | Narrow worker context, followed by a rich upward handoff. | **Good foundations:** fresh child sessions, bounded assignments, result artifacts, and recovery capsules. Explicit session forks can inherit broader context. |
| **Repository isolation** | Every worker gets its own copy. | **Available, not universal.** Native task isolation defaults to `none`; isolated execution requires configuration and an explicit request. The GitHub relay automatically creates per-job clones. |
| **Durable execution** | The overall system keeps running and recovering. | **Real implementations exist:** a local SQLite-backed operational runner and a separate Durable Object queue with leases, retries, fencing, reconciliation, and dead-letter recovery. These are not merely plans. |
| **Continuous replanning** | Worker handoffs keep planners updating their scopes and generating more work. | **The biggest missing integration.** We have continuation hooks, reminders, recovery, and durable dispatch, but those do not establish a default, continuously running recursive replanner. |
| **Communication** | Primarily upward/downward handoffs; no worker cross-talk. | IRC and peer coordination are first-class. Useful for small teams, but we do not impose Cursor’s communication discipline for large runs. |
| **Integration** | Removed the central integrator to improve throughput. | Isolated task output converges into the parent checkout; repository policy also specifies a serialized merge owner and final union verification. |
| **Cost control** | The experiment asks whether substantially more compute produces proportionally more useful work. | We expose work-class model routing and token-savings behavior. **That is a different optimization target**, not evidence that we deliver equivalent throughput more cheaply. |
| **Proven autonomous scale** | Reports a week-long run with hundreds of concurrent agents. | We have **not demonstrated an equivalent run or published comparable useful-throughput measurements**. A configurable concurrency limit is not such evidence. |

## We have more machinery than our recent sessions suggest

There are three distinct implementation paths worth separating:

1. **Interactive native tasks** — subagents, optional isolation, IRC, handoffs, recovery, and parent integration.
2. **The local operational runner** — durable jobs, transactional claims, lease renewal, checkpoints, and expired-lease recovery.
3. **The hosted Linear/GitHub queue and relay** — durable admission, fencing, retries, isolated GitHub workspaces, and controlled publishing.

So it would be wrong to say, **“We need to build a durable scheduler from scratch.”** We already have that machinery.

The issue is that these paths do not yet constitute one clearly enforced end-to-end workflow:

```text
Goal → recursive planning → durable task dispatch → isolated execution
     → handoff → replanning → verified integration → continued progress
```

Also, written collaboration policy, runtime enforcement, and deployed behavior are not interchangeable. Our policy is stricter than some native defaults, and the hosted relay has guarantees that a normal interactive task does not automatically receive.

## Our current practical bottleneck

**Our recent implementation work still resembled Cursor’s earlier continuous-executor stage.**

I was responsible for planning, researching, implementing, reviewing, integrating, building, diagnosing failures, and watching CI. We delegated investigations, but the root retained most implementation and delivery responsibility.

That concentration of responsibility is exactly what Cursor eventually split apart.

The later regeneration of our tracked executables illustrates another practical gap: **isolating source work is not enough; generated outputs and shared build resources also need ownership.** It does not mean OMPK lacks isolation capabilities, but it does show that our current operating practice does not automatically coordinate all concurrent work.

## What I would adopt—and what I would not

### Adopt next

**1. An explicit autonomous workflow mode with an enforced planning-only root.**  
Use existing role/tool restrictions, rather than relying on a prompt saying “please delegate.” Subplanners should own outcomes, not just pass along tiny chores.

**2. Wire that mode into the existing durable execution machinery.**  
Planner outputs become durable work contracts; worker completion or failure becomes an event that updates the responsible planner. Reuse the existing queue, lease, and recovery components rather than introducing another competing task ledger.

**3. Make isolation the default for writing workers in that mode.**  
Require a real workspace, declared scope, integration strategy, and ownership of generated artifacts. Fresh conversation context is not repository isolation.

**4. Use structured upward handoffs as the primary feedback path.**  
Include results, verification, deviations, newly discovered problems, and suggested follow-ups. Keep IRC available for bounded clarification, rather than making every worker participate in global coordination.

**5. Benchmark useful scaling before increasing fan-out.**  
Compare small controlled runs—say 4, 8, and 16 workers—using:
- Accepted, verified tasks per hour.
- Cost per accepted task.
- Conflict and rework rates.
- Recovery from killed workers.
- Human interventions required.
- Time spent waiting on builds or integration.

That would tell us much more than token throughput or commit counts.

### Do not copy blindly

**I would not adopt “temporary breakage everywhere” on our production `main`.** We are changing a load-bearing harness, not running a disposable browser research experiment.

A better adaptation is an isolated integration branch with bounded reconciliation, while keeping production and releases gated. We can reduce integration bottlenecks without abandoning the correctness guarantees we actually need.

## Bottom line

**We are close enough in components that this is primarily a workflow-integration and enforcement project—not a new harness from scratch.**

But we are **not yet equivalent in autonomous operation or demonstrated scale**. The next meaningful step is not adding more agent types or raising the concurrency cap. It is making our existing planners, durable queues, isolated workers, handoffs, and integration gates function as one coherent continuous system.

**Key implementation evidence:** [native isolation defaults](packages/coding-agent/src/config/settings-schema.ts:4302), [task integration](packages/coding-agent/src/task/index.ts:2075), [local durable runner](packages/coding-agent/src/operational/runner.ts:234), [hosted queue](packages/ompk-linear-agent/src/queue-core.ts:161), [relay workspaces](packages/ompk-linear-agent/relay/relay.ts:2004), and [collaboration policy](docs/multi-agent-fork-collaboration.md:27).

---

## 2. Token-Saving Fusion Mode vs. Autonomous Workflow Architecture

**They address different problems—and ideally should work together.**

- **Token-saving Fusion asks:** “Which model should do this work, and how much context should we spend on it?”
- **Cursor’s planner/worker design asks:** “Who owns this work, how does it get dispatched, and what keeps the project progressing without a human driving every cycle?”

Fusion is our **model-routing and context-cost layer**. The autonomous architecture is the **work-ownership and execution layer**.

## What Fusion already contributes

Our token-saving mode overlaps meaningfully with the planner/worker approach:

| Mechanism | Token-saving Fusion | Cursor-style autonomous workflow |
|---|---|---|
| **Separate planning from bulk execution** | Encourages planning/intelligence work to use the appropriate thinking roles, with delegated implementation on task models. | Makes planner-versus-worker responsibility a structural property of the system. |
| **Fresh workers** | Can delegate bounded work into fresh sessions instead of growing the root’s context indefinitely. | Uses bounded workers as the normal execution unit. |
| **Compact results** | Evidence digests and cited findings reduce how much raw material returns to the root. | Rich upward handoffs inform the planner’s next decisions. |
| **Specialized execution** | Routes browser work, lightweight context gathering, and substantial tasks differently. | Assigns ownership by project scope, then delegates execution within it. |
| **Cost control** | Explicitly tries to limit expensive/default-model usage and unnecessary context. | The article focuses primarily on sustained useful throughput, including spending substantially more compute. |
| **Continuous progress** | Does not itself supply a continuous project-planning loop. | Replanning and delegation continue as part of the architecture. |

So **Fusion already provides part of the economic foundation for that architecture**. It does not, by itself, provide the whole autonomous workflow.

## The important distinction: routing is not role enforcement

This is where I should qualify my earlier description of Fusion as “completed.”

**The core token-saving implementation is present. But that does not mean we have enforced a complete planner/worker operating model.**

From the current source:

- Model routing is implemented for recognized work classes and explicit evidence-digest tasks.
- Explicit model and difficulty selections take precedence.
- The default-model call limit has runtime behavior: continuing root work can switch to the task model when that model is resolvable and authenticated; otherwise the code supplies a steering reminder.
- **The root is still allowed to code.**
- “Delegate substantive intelligence to planning/thinking roles” is not equivalent to a hard restriction that prevents the root from doing that work itself.

Consequently, Fusion can reduce the cost of the root’s activity **without removing the root as the planning, implementation, review, and integration bottleneck**.

That is the central gap between our current mode and the architecture discussed in the Cursor article.

## A concrete example

Suppose the goal is:

> Fix authentication across three providers, update their tests, and ship the changes.

### Token-saving Fusion today

The root can:
1. Ask lightweight workers to inspect each provider.
2. Request a higher-capability planning pass.
3. Delegate implementation to task models.
4. Receive concise findings and results.
5. Personally coordinate the fixes, integration, verification, and next steps.

That can be a useful, economical multi-agent workflow. But **the root still has to organize and sustain the process**.

### An autonomous workflow using Fusion

A planning-only root would assign outcomes to provider-specific subplanners. Those subplanners would dispatch isolated implementation tasks through the durable queue.

Worker results would return to their owning planners, which would decide whether to:
- Accept the work.
- Request a correction.
- Create a newly discovered task.
- Escalate a cross-provider issue.

Fusion would determine the appropriate model for each planning, research, implementation, or browser step. Integration and verification would follow an explicit workflow rather than relying on the root to remember and perform every transition.

**Same cost-routing capability; a much stronger execution structure around it.**

## What we should preserve from Fusion

I would not replace Fusion with a “throw hundreds of expensive agents at it” approach. I would use it underneath the autonomous workflow:

```text
Autonomous workflow
  Owns goals, scopes, task states, handoffs, recovery, and integration

Token-saving Fusion
  Chooses model roles and controls context expenditure for those steps

Execution infrastructure
  Provides isolated workspaces, durable queues, tools, leases, and logs
```

One important refinement would be to make **handoffs concise but complete**. An evidence digest should not discard the failed approaches, unresolved risks, or changes to the task’s assumptions that a planner needs to make its next decision. Saving tokens by omitting those can create more rework than it saves.

Likewise, a planning-only root should not simply become a cheaper implementation agent after its call allowance is exhausted. **Its responsibility should remain planning; Fusion should select a model appropriate to that responsibility.**

## How we should measure the combination

We have not yet demonstrated that Fusion delivers a particular savings percentage, or that it scales useful output like Cursor’s research run.

The right measurement is not merely **fewer tokens in the root session**. It is:

> **Total model cost per accepted, verified task—including workers, retries, review, and integration.**

Otherwise, we could make the root look cheap while spending more overall on duplicated investigation or repeated corrections.

**Bottom line:** token-saving Fusion is a valuable part of the system we want. The next step is to make its planning/execution separation structural and connect it to our existing durable execution machinery—not to replace it or merely add more agents.
