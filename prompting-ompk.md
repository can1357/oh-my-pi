## Yes — and OMPK is already surprisingly close

Prompt engineering principles:

> Convert the strongest prompt principles into typed task contracts, orchestration state, reviewer prompts, and runtime gates—using prose only where judgment is genuinely required.

OMPK already has several of the necessary pieces:

* The base prompt requires complete work and verification before yielding.
* `task.md` requires self-contained assignments, specialist roles, and observable acceptance criteria.
* `AssignmentContractV1` already makes objective, deliverables, scope, procedures, and acceptance immutable, while requiring structured evidence and blocker reporting.
* The advisor is an independent, read-only reviewer that can interrupt with `concern` or `blocker`.

So the opportunity is to **connect these pieces into a stronger research-and-execution loop**.

# 1. Create a root-level task contract

Right now, the strongest contract machinery appears focused on parent-to-subagent assignments. The main agent itself should receive a typed contract for substantial work.

Something like:

```ts
interface TaskContractV1 {
  objective: string;
  deliverables: string[];

  completionCriteria: Criterion[];
  nonSolutions: string[];
  knownFailureModes: FailureMode[];

  evidenceRequirements: EvidenceRequirement[];
  constraints: string[];
  assumptions: Assumption[];

  verificationPolicy: VerificationPolicy;
  orchestrationPolicy: OrchestrationPolicy;
}
```

The important additions relative to the current assignment contract are:

### `nonSolutions`

These encode what appears productive but does not satisfy the user:

```yaml
nonSolutions:
  - Disabling or weakening existing tests
  - Suppressing the exception without fixing its cause
  - Implementing only a special case
  - Returning a design without implementing it
  - Claiming success from static inspection alone
```

### `knownFailureModes`

These become targeted reviewer checks:

```yaml
knownFailureModes:
  - Breaks Windows path handling
  - Fails when the input collection is empty
  - Creates a race between sibling workers
  - Changes a public API without migration
  - Treats a tool timeout as success
```

The Cycle Double Cover prompt is effective partly because it specifies both the theorem and the exact classes of false proof that should be rejected. 

## Where it belongs

Not permanently in `system-prompt.md`.

Generate it after the user’s request is classified as substantial, then inject it as an ephemeral system block:

```xml
<task-contract version="task-contract/v1">
...
</task-contract>
```

That keeps the global prompt lean while giving difficult tasks a sharp completion boundary.

---

# 2. Extend `AssignmentContractV1`, not replace it

Your existing contract is already a strong foundation. It supports:

* Immutable objective and deliverables.
* Allowed and denied paths.
* Parent-authored procedures.
* Typed acceptance checks.
* `success`, `failed`, `blocked`, and `partial` results.
* Per-criterion evidence.
* Changed-file reporting.
* Digest validation.

I would introduce `assignment-contract/v2` with a few additional fields:

```ts
interface AssignmentContractV2 extends AssignmentContractV1 {
  nonSolutions?: readonly string[];
  failureModes?: readonly FailureMode[];
  evidencePolicy?: EvidencePolicy;

  strategyFamily?: string;
  independenceGroup?: string;
  priorBlockedRoutes?: readonly BlockedRoute[];

  resultRequirements?: {
    claimsRequired: boolean;
    counterevidenceRequired: boolean;
    unresolvedGapsRequired: boolean;
  };
}
```

A useful structured result would be:

```ts
interface AssignmentResultV2 {
  status:
    | "success"
    | "failed"
    | "blocked"
    | "partial"
    | "falsified";

  claims: Claim[];
  evidence: AcceptanceEvidence[];
  counterevidence: Evidence[];
  changedFiles: string[];

  blockers?: Blocker[];
  unresolvedGaps?: Gap[];
  recommendedNextAction?: string;
}
```

`falsified` is useful because a worker that disproves an approach has produced valuable work, even though it did not implement anything.

---

# 3. Optimize for **independent approach coverage**, not maximum fan-out

This is the largest prompt-level change I would make.

The current task prompt says:

> “Maximize fan-out” and issue the widest possible batch.

That is appropriate for mechanical implementation slices, but less appropriate for:

* Root-cause investigations.
* Architecture design.
* Difficult debugging.
* Open-ended optimization.
* Security review.
* Research.
* Product or operational analysis.

Ten agents pursuing the same theory are often less useful than three agents investigating genuinely different causal families.

I would change the instruction to:

```text
Maximize useful independence, not raw agent count.

For mechanical work, fan out across independent implementation slices.

For uncertain or investigative work:
- Assign materially different hypotheses, representations, or attack surfaces.
- Give each strategy family a stable identifier.
- Avoid spawning multiple agents in the same family unless they use a distinct
  mechanism or one is explicitly adversarial.
- Redirect capacity when several agents converge on the same underlying approach.
```

## Add a `strategyFamily`

Example debugging portfolio:

```yaml
tasks:
  - role: Database-path investigator
    strategyFamily: persistence
  - role: Concurrency investigator
    strategyFamily: concurrency
  - role: Configuration investigator
    strategyFamily: environment
  - role: Regression-history investigator
    strategyFamily: recent-changes
```

The parent can then see whether it has four approaches or four differently worded versions of one approach.

---

# 4. Add blind-first exploration

The proof prompt deliberately prevents early agents from seeing the currently favored approach. That reduces anchoring and correlated mistakes.

OMPK batch tasks currently share a common `context`, and the task prompt encourages putting shared background in one location.

Add an orchestration option such as:

```ts
type ContextPolicy =
  | "shared"
  | "blind"
  | "staged";

interface TaskItem {
  contextPolicy?: ContextPolicy;
  revealSiblingFindings?: boolean;
}
```

### Behavior

* **`shared`**: normal implementation work.
* **`blind`**: each worker sees the task contract and raw evidence, but not the parent’s favored hypothesis or sibling findings.
* **`staged`**: independent first pass, then a synthesis phase in which findings are revealed.

This would work especially well for:

* Bug diagnosis.
* Code review.
* Architecture alternatives.
* Incident postmortems.
* Benchmark interpretation.
* Vendor or technology selection.

---

# 5. Make blocked routes first-class orchestration state

The current result contract allows `blocked` and a blocker list, which is good.

But the parent should also maintain a registry:

```ts
interface ApproachRecord {
  family: string;
  mechanism: string;
  status:
    | "unexplored"
    | "active"
    | "promising"
    | "blocked"
    | "falsified"
    | "completed";

  evidence: string[];
  blocker?: string;
  blockerFingerprint?: string;
  reopenCondition?: string;
}
```

Then add this parent prompt rule:

```text
When an approach stalls on a missing dependency, unavailable fact, or
theorem-strength assumption, mark it blocked.

Do not assign another worker to the same approach family and blocker unless
the new assignment names a materially different mechanism or evidence source
that could bypass the blocker.
```

This prevents agent loops such as:

```text
Agent 1: blocked by missing API behavior
Agent 2: independently discovers same blocker
Agent 3: retries same interpretation
Agent 4: proposes “investigate API behavior more”
```

A blocker fingerprint also gives your router and training layer useful telemetry.

---

# 6. Separate implementers, falsifiers, and auditors

OMPK’s current `role` field is a strong primitive because it shapes the worker’s system identity.

Use role categories explicitly:

```ts
type WorkerMode =
  | "explore"
  | "implement"
  | "falsify"
  | "audit"
  | "synthesize";
```

### Example pipeline

```text
Independent explorers
        ↓
Candidate route selected
        ↓
Implementer
        ↓
Falsifier / breaker
        ↓
Acceptance auditor
        ↓
Root verification
```

The falsifier should receive:

* The task contract.
* The proposed design or patch.
* Known failure modes.
* Relevant test and runtime evidence.

But it should not be told to “help make the solution work.” Its goal is to find the smallest concrete counterexample or failure.

Example prompt:

```text
Attempt to falsify this candidate solution.

Do not propose stylistic improvements. Look for a concrete input, environment,
concurrency schedule, compatibility constraint, or acceptance criterion that
causes the proposed solution to fail.

Return either:
1. A reproducible failure with evidence, or
2. The exact checks performed and why none invalidated the candidate.
```

---

# 7. Give the advisor the task contract

The advisor already receives incremental transcript deltas, can inspect files with read-only tools, and can issue `nit`, `concern`, or `blocker` advice.

However, its current prompt is mainly oriented toward general technical risk and code quality. It should also receive a compact representation of the active task contract.

Add:

```xml
<active-task-contract>
  <objective>...</objective>
  <completion-criteria>...</completion-criteria>
  <non-solutions>...</non-solutions>
  <known-failure-modes>...</known-failure-modes>
</active-task-contract>
```

Then augment the advisor prompt:

```text
Audit progress against the active task contract.

Raise a concern when the agent is producing an adjacent result that does not
satisfy the stated completion criteria.

Raise a blocker when the current route necessarily violates a non-solution
rule, omits a required deliverable, or relies on evidence that cannot establish
the claimed result.

Do not repeat criteria merely because they remain unfinished; intervene only
when the current work is likely to make them impossible or falsely appear done.
```

That would turn the advisor into an **acceptance-criteria watchdog**, not merely a second programmer.

---

# 8. Keep `WATCHDOG.md` project-specific

`WATCHDOG.md` is already exactly the right place for persistent reviewer-only risks such as dangerous APIs and architectural boundaries. It is isolated from the primary agent’s regular context, which avoids taxing every executor turn.

Use it for recurring traps:

```markdown
# OMPK review priorities

Especially reject:

- New task paths that bypass AssignmentContract verification.
- Workers that report success without criterion-level evidence.
- Router fallbacks that silently change autonomy or tool ceilings.
- Subagent retries that lose the original contract digest.
- Prompt changes that duplicate instructions already supplied by tool schemas.
- New shared-context behavior that leaks sibling conclusions into blind exploration.
```

Do **not** put task-specific criteria in `WATCHDOG.md`; inject those dynamically.

---

# 9. Add a main-agent completion gate

The base prompt currently says:

> “Verify behavior changes before yielding.”

That is a good instruction, but it is still prose.

Before the root agent can produce a successful final yield, the harness should evaluate:

```ts
interface CompletionGate {
  allDeliverablesPresent: boolean;
  criteriaSatisfied: boolean;
  nonSolutionTriggered: boolean;
  requiredEvidencePresent: boolean;
  unresolvedBlockersAcknowledged: boolean;
  scopeValid: boolean;
}
```

Possible outcomes:

* **Pass:** allow success response.
* **Recoverable failure:** inject a focused reminder containing missing criteria.
* **Blocked:** allow a blocked result, not a success claim.
* **Repeated invalid success:** escalate to the advisor or verifier model.

This is the root-level counterpart to your existing assignment verifier.

The principle is:

> Never rely on the same model that performed the work to be the sole judge of whether its success claim is valid.

---

# 10. Make prompt layering explicit

OMPK already constructs its system prompt from separate sources, including custom system prompts, context files, rules, skills, workspace data, and appended content.

I would formalize the responsibility of each layer:

| Layer                             | What belongs there                                    |
| --------------------------------- | ----------------------------------------------------- |
| Base system prompt                | Permanent behavioral invariants                       |
| Project `SYSTEM.md` / `AGENTS.md` | Repository conventions and architecture               |
| Task contract                     | Exact completion criteria and non-solutions           |
| `task.md`                         | Delegation and worker-assignment protocol             |
| Assignment contract               | Immutable child scope and verification                |
| Advisor prompt                    | General adversarial-review behavior                   |
| `WATCHDOG.md`                     | Persistent project-specific reviewer traps            |
| Triggered rule                    | Rare course correction activated by observed behavior |
| Hindsight/memory                  | Durable facts learned from completed work             |

This avoids two common problems:

1. A giant universal prompt that taxes every request.
2. The same instruction being repeated in four layers and gradually drifting.

Your existing prompt builder already warns when context files become bloated because they are injected into every request.

---

# 11. Change the task prompt’s verification rule by work class

The current task prompt says subagents do not verify, lint, or format; the parent runs gates once at the end.

That is efficient for parallel implementation, but too broad.

I would make it conditional:

```text
Mechanical implementation workers:
- Do not run project-wide gates.
- MAY run the smallest targeted check required to validate their local assumption.
- Parent runs shared integration gates once.

Exploration and falsification workers:
- MUST verify every material claim with a concrete read, search, diagnostic,
  command, reproduction, or counterexample where available.

Acceptance auditors:
- MUST execute or inspect the contract-defined checks.
- MUST NOT accept the implementer's narrative as verification.
```

Otherwise an investigation agent can return an unverified theory because “subagents do not verify.”

---

# 12. Use adaptive rounds, not fixed agent counts

The proof prompt’s “64 agents” and “eight hours” are less transferable than its dynamic allocation policy.

For OMPK, use round-based stopping:

```ts
interface SearchBudget {
  maxInitialFamilies: number;
  maxRounds: number;
  maxSameBlockerRetries: number;
  minEvidenceGainToContinue: number;
}
```

Parent prompt:

```text
Begin with a small, diverse portfolio.

Add workers when:
- an approach family is unrepresented,
- a concrete dispute needs independent resolution,
- a promising route contains separable work,
- or an adversarial audit is warranted.

Stop expanding when new workers repeat known evidence or blockers without
introducing a new mechanism.
```

That gives you better cost control than “maximize fan-out.”

# Highest-value implementation order

## Phase 1 — mostly prompt changes

1. Revise `task.md` from **maximum fan-out** to **maximum useful independence**.
2. Add failure modes and non-solutions to assignment formatting.
3. Inject the active task contract into the advisor.
4. Add auditor and falsifier role templates.
5. Add project-level OMPK risks to `.ompk/WATCHDOG.md`.

## Phase 2 — typed harness changes

1. Add a root `TaskContract`.
2. Add `strategyFamily`, `workerMode`, and `contextPolicy`.
3. Add an approach registry and blocker fingerprints.
4. Extend `AssignmentResult` with claims, counterevidence, and gaps.
5. Add root completion-gate enforcement.

## Phase 3 — routing and learning

Capture:

* Task contract class.
* Strategy family.
* Worker mode.
* Route selected.
* Tool sequence.
* Blocker fingerprint.
* Verification outcome.
* Advisor interventions.
* Whether the final completion gate passed initially or after recovery.

That dataset would improve both model routing and tool-routing training because it records **why a route was selected and whether its evidence actually satisfied the contract**, rather than merely recording that a tool was called.

## The central OMPK principle

The proof prompt should not inspire a much longer OMPK prompt. It should inspire a better control plane:

```text
User request
    ↓
Task-contract compiler
    ↓
Risk and uncertainty classification
    ↓
Direct work or diverse orchestration
    ↓
Typed worker evidence
    ↓
Adversarial audit
    ↓
Runtime completion gate
    ↓
Final response
```

The most valuable immediate change is to build on your existing `AssignmentContractV1` and apply the same concept to the **entire root task**, while changing task orchestration from “fan out as widely as possible” to “maintain the widest useful set of independent approaches.”
