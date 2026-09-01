# Intelligent Specialist & Parallel Agent Orchestration

Task 09 adds a deterministic specialist-delegation policy on top of Task 08. It does not create another agent loop or another child-agent framework.

## Existing OMP execution reused

The coding-agent already provides bundled agent definitions, `runStructuredSubagent()`, recursive-spawn limits, read-only policy, isolated worktrees, structured outputs, and `mapWithConcurrencyLimitAllSettled()` for bounded batch execution. Task 09 only decides when those mechanisms are worth using.

## Roles

- EXPLORER → `scout`
- ARCHITECT → existing read-only `reviewer` surface
- DEBUGGER → `scout` with failure-focused assignment
- TEST_ENGINEER → `scout` with test-focused assignment
- REVIEWER → `reviewer`
- SECURITY_REVIEWER → `security-reviewer`
- RESEARCHER → `librarian`

Automatic delegation is read-only by policy. The task tool remains the permission, isolation, recursion, and child-execution authority.

## Delegation policy

`decideDelegation()` is deterministic. It considers complexity, confidence, repository size, uncertainty, cross-subsystem scope, failures, architecture ambiguity, independent verification needs, external research needs, security sensitivity, existing evidence, budget, and parallel capability.

Simple tasks always skip delegation. High-confidence tasks with sufficient evidence skip delegation. Delegation is reserved for repeated failures, architecture ambiguity, security-sensitive work, genuine external research, independent verification, or very-complex/large uncertain repository exploration.

The expected-value model is qualitative: a role is chosen only when its expected benefit is material and the estimated reserve fits the remaining specialist budget. The policy never invokes an LLM just to decide whether to delegate.

## Minimal specialist context

Specialists receive only task, relevant/active files, active symbols, current failure/attempt count, current hypothesis, constraints, and one specific question. The context is capped before it reaches the task tool.

## Contracts

Each role has a compact output contract so the primary agent can consume evidence without reading a specialist transcript.

## Parallelism

`PARALLEL_DELEGATE` is only returned for independent read-only perspectives and only when the selected model strategy reports parallel tool support and the configured concurrency limit permits it.

The existing TaskTool `task.batch` path remains the parallel executor. Task 09 does not create another scheduler. Dependent/conflicting writes are never suggested for concurrent execution because automatic specialists are read-only.

The existing executor's cancellation signal remains authoritative. A parent cancellation can stop scheduling/drain child work through the normal TaskTool path. Task 09 does not add a second child-process cancellation protocol.

## Aggregation

`aggregateSpecialistFindings()` keeps identical findings as consensus and preserves divergent findings as conflicts. It never majority-votes a disputed root cause; the primary agent is expected to validate contested findings against repository/verification evidence.

## Integration with Tasks 01–08

- Task 01 supplies complexity/confidence.
- Task 02 supplies the minimum specialist context requirements.
- Task 03 supplies failure/verification evidence.
- Task 04 supplies repository facts.
- Task 05 supplies tool-result signals.
- Task 06 supplies parallel capability and model strategy.
- Task 07 remains the only durable-memory owner; specialist transcripts are not automatically persisted.
- Task 08 remains the top-level execution-state orchestrator. Task 09 is an optional delegation action inside that policy.

The coding-agent runtime injects a compact, transient delegation directive into the current model-call context. It does not append specialist directives to the durable transcript.

## Early result handling

The delegation policy exposes bounded, evidence-first decisions and deduplicates repeated delegation fingerprints. Existing TaskTool batch execution remains the source of truth for launched child work. Because the current batch API waits for already-launched items to settle, Task 09 does not claim mid-batch cancellation of optional specialists that have already started; early acceptance is applied at subsequent scheduling boundaries.

## Controls

- `PI_SPECIALIST_ORCHESTRATION=0` disables the runtime adapter.
- `PI_SPECIALIST_BUDGET_TOKENS` bounds the reserved specialist budget.
- `PI_SPECIALIST_MAX_CONCURRENCY` caps suggested parallel specialist count (maximum 4).

## Telemetry

The runtime exposes `getSpecialistOrchestration(agent)` with the last delegation decision and counts of suggested and avoided delegation. Existing TaskTool child telemetry remains the source for actual child model, token, latency, cancellation, and result-usefulness measurements.
