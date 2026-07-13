# Autonomous Root-Task Execution

## Purpose

OMPK should let a user provide a root objective while the runtime owns decomposition, worker allocation, execution placement, validation, retries, and external-state reconciliation.

This policy is the default for root objectives. Existing lower-level controls remain available as explicit overrides.

## User Control Surface

Normal operation has three commands:

1. **Start** — submit a root objective and constraints.
2. **Inspect** — view root progress, material blockers, decisions, evidence, and required intervention.
3. **Redirect** — change an objective or constraint and replan from the current verified state.

The user should not need to choose agents, ticket owners, lane counts, branch allocation, or execution order.

## Root Task Contract

Every root objective compiles into a versioned contract. The existing `TaskContractV1` in `packages/coding-agent/src/orchestration/task-contract.ts` already provides:

- `version` (`task-contract/v1`), `objective`, `deliverables`, `completionCriteria`, `nonSolutions`, `knownFailureModes`, `evidenceRequirements`, `constraints`, `assumptions`, `verificationPolicy`, `orchestrationPolicy`.

Autonomous root-task execution requires the following **additive** fields, introduced as `TaskContractV2` (a superset of V1; V1 continues to parse and remains valid for non-root use):

```yaml
version: TaskContractV2
# --- inherited from V1 ---
objective:
deliverables:
completionCriteria:
nonSolutions:
knownFailureModes:
evidenceRequirements:
constraints:
assumptions:
verificationPolicy:
orchestrationPolicy:
# --- V2 additions for autonomous root execution ---
scope:                    # in-scope surfaces (paths, systems, modules)
nonGoals:                 # explicit exclusions distinct from nonSolutions
writeBoundaries:          # array of WriteScope (see packages/coding-agent/src/task/write-scope.ts)
dependencies:             # ordered/DAG dependencies between decomposed work
requiredArtifacts:        # concrete files, PRs, or records that must exist at completion
acceptanceTests:          # AcceptanceCriterion[] (see packages/coding-agent/src/task/assignment-contract.ts)
evidencePolicy:           # risk-proportional validation selection (see "Validation and Completion")
escalationConditions:     # concrete triggers matching "Escalation Policy" below
externalReconciliation:   # required GitHub/Linear projection targets
```

The compiled contract is immutable for a run. Redirects create a new revision linked to the previous contract and preserve already verified work when still valid.

Field-naming note: fields are camelCase to match the existing `TaskContractV1` shape and its parser conventions. The YAML above uses camelCase keys accordingly.

## Work Units

The planner converts the root contract into independently executable work units. Each unit reuses existing primitives where they exist and must declare:

```yaml
id:
objective:
scope:
nonGoals:
writeBoundary:        # single WriteScope from packages/coding-agent/src/task/write-scope.ts
                      # (mode: exclusive | isolated-patch | proposal-only). "writeBoundary" is
                      # the singular, work-unit-scoped view of a root writeBoundaries entry —
                      # not a rename. Overlap detection uses the existing WriteScope logic.
strategyFamily:       # maps to ApproachRecord.family in
                      # packages/coding-agent/src/orchestration/approach-registry.ts.
                      # No parallel registry is introduced.
dependencies:
requiredArtifact:
acceptanceTests:      # AcceptanceCriterion[] (existing schema on AssignmentContractV1) —
                      # the per-work-unit list is the same shape, not a separate representation.
                      # Check kinds (command_exit, artifact_exists, json_schema, …) are reused.
evidencePolicy:
failureModes:
escalationConditions:
```

Workers receive only the context required for their unit. Full project history must not be copied into every worker prompt.

## Claims and Leases

Work is dynamically claimed instead of permanently pre-assigned.

```text
available -> claimed -> active -> validating -> completed
                         |             |
                         v             v
                      blocked       released
```

This work-unit lifecycle is **distinct from and layered above** `AssignmentVerificationStatus` (`"submitted" | "verifying" | "verified" | "verification_failed"`) in `packages/coding-agent/src/task/types.ts`, which tracks a single assignment's verification outcome. Mapping:

| Work-unit state | Assignment-level status |
|---|---|
| available | (no assignment yet) |
| claimed | (no assignment yet — claim precedes assignment submission) |
| active | `submitted` while worker is executing |
| validating | `verifying` |
| completed | `verified` |
| blocked / released | `verification_failed`, expired lease, or explicit release; assignment status is preserved for audit |

The work-unit lifecycle supersedes assignment-level status for **root-task tracking and gating**; assignment-level status is retained for per-assignment audit and replay.

A claim records:

```yaml
workerId:
workUnitId:
strategyFamily:       # ApproachRecord.family (see Work Units above)
leaseStartedAt:
leaseExpiresAt:
writeBoundary:        # WriteScope (see Work Units above)
expectedArtifact:
heartbeatAt:
```

Expired or abandoned leases are reconciled and released. A released unit becomes claimable again unless the root planner marks it superseded, unnecessary, or terminally blocked.

## Controlled Parallelism

The orchestrator chooses parallelism dynamically:

```text
parallelism = min(
  genuinely_independent_units,
  available_capacity,
  safe_write_boundaries,
  evidence_budget
)
```

Parallel execution is allowed only when units have distinct write boundaries, independent acceptance criteria, limited shared mutable state, and meaningful latency benefit.

When multiple agents investigate the same problem, they must use distinct `strategyFamily` values. Distinctness is enforced against the existing `ApproachRegistry` (`packages/coding-agent/src/orchestration/approach-registry.ts`): two live claims sharing the same `family` are treated as duplicate reasoning and must be sequenced or eliminated. Blocked-fingerprint reuse (`ApproachRegistry.hasBlockedFingerprint`) also prevents re-spawning a family against a known-blocked route.

## Validation and Completion

Implementation and completion judgment are separate responsibilities.

Validation depth is proportional to risk. Documentation-only or low-risk changes may use deterministic checks. Authentication, infrastructure, migrations, state reconciliation, and destructive workflows require independent falsification or integration review.

Child completion is evidence, not root completion. The root task may close only when all required conditions are true.

The existing `CompletionGate` interface in `packages/coding-agent/src/orchestration/completion-gate.ts` already asserts:

```yaml
allDeliverablesPresent: true
criteriaSatisfied: true
nonSolutionTriggered: false
requiredEvidencePresent: true
unresolvedBlockersAcknowledged: true
scopeValid: true
```

Autonomous root execution adds the following **additive** fields as a new gate layer (`RootReconciliationGate`) that composes with `CompletionGate` rather than replacing it — the root completion decision is the AND of both layers:

```yaml
# --- existing CompletionGate (unchanged) ---
allDeliverablesPresent: true
criteriaSatisfied: true
nonSolutionTriggered: false
requiredEvidencePresent: true
unresolvedBlockersAcknowledged: true
scopeValid: true
# --- new RootReconciliationGate additions ---
integrationVerified: true
claimsReconciled: true
githubReconciled: true
linearReconciled: true
cleanupVerified: true
```

Where each root-level field slots in is explicit: reconciliation fields live on `RootReconciliationGate`, not on `CompletionGate`, so implementation does not have to guess.

## External Reconciliation

GitHub and Linear are projections of runtime state, not the execution control plane.

Every terminal decision must be reflected externally:

| Runtime state | External projection |
|---|---|
| available | Todo / Ready |
| claimed or active | In Progress |
| validating | In Review |
| externally blocked | Blocked |
| completed with evidence | Done |
| superseded or unnecessary | Canceled / Not Planned with reason |
| lease expired | Released and reconciled |

No skipped, stale, blocked, or superseded work may remain silently marked active.

## Escalation Policy

The orchestrator interrupts the user only when one of these conditions applies:

- a destructive or irreversible action is required;
- credentials or authorization are missing;
- materially different product directions require a human choice;
- a configured cost threshold would be exceeded;
- the objective conflicts with repository or organizational policy;
- all viable execution routes are exhausted.

Routine implementation choices, retries, lease recovery, branch allocation, local-versus-cloud placement, validation selection, and status updates are runtime responsibilities.

## Runtime Control Loop

1. Receive root objective.
2. Inspect live repository and project state.
3. Compile `TaskContractV1`.
4. Produce executable work units.
5. Detect dependencies and write collisions.
6. Select controlled parallelism.
7. Issue expiring claims.
8. Execute with bounded autonomy.
9. Collect artifacts and evidence.
10. Validate and falsify proportionally.
11. Integrate successful results.
12. Reconcile completed, failed, skipped, superseded, blocked, and released work.
13. Apply the root completion gate.
14. Report the verified result or consequential blocker.

## Required Implementation Tests

This document is a draft contract. The tests below are **required in the follow-up implementation commit**, not in this doc-only PR. The implementation must add externally observable tests for:

- root objective compilation into `TaskContractV2` (superset of `TaskContractV1`, with V1 still parsing);
- lease acquisition, heartbeat, expiry, release, and reclaim;
- prevention of concurrent conflicting write boundaries (via existing `WriteScope` overlap detection);
- distinct `strategyFamily` enforcement for redundant investigations (via existing `ApproachRegistry`);
- risk-proportional validation selection;
- root completion refusing to close when either `CompletionGate` or `RootReconciliationGate` fails;
- explicit reconciliation of skipped, blocked, superseded, and released work;
- redirect preserving still-valid verified artifacts;
- legacy explicit agent and lane controls remaining available as overrides.

## Migration

Adopt this behavior behind a compatibility-preserving default path:

- root objectives use autonomous execution by default;
- explicit low-level orchestration flags continue to override the default;
- existing persisted tasks are migrated or interpreted without losing state;
- external integrations remain projections until reconciliation succeeds;
- rollout supports a feature flag or safe fallback until contract-level tests and representative end-to-end runs pass.
