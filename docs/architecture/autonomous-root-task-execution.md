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

Every root objective compiles into a versioned contract containing:

```yaml
version: TaskContractV1
objective:
scope:
non_goals:
constraints:
write_boundaries:
dependencies:
required_artifacts:
acceptance_tests:
evidence_policy:
failure_modes:
escalation_conditions:
external_reconciliation:
```

The compiled contract is immutable for a run. Redirects create a new revision linked to the previous contract and preserve already verified work when still valid.

## Work Units

The planner converts the root contract into independently executable work units. Each unit must declare:

```yaml
id:
objective:
scope:
non_goals:
write_boundary:
strategy_family:
dependencies:
required_artifact:
acceptance_tests:
evidence_policy:
failure_modes:
escalation_conditions:
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

A claim records:

```yaml
worker_id:
work_unit_id:
strategy_family:
lease_started_at:
lease_expires_at:
write_boundary:
expected_artifact:
heartbeat_at:
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

When multiple agents investigate the same problem, they must use distinct `strategy_family` values. Otherwise the work is duplicate reasoning and should be sequenced or eliminated.

## Validation and Completion

Implementation and completion judgment are separate responsibilities.

Validation depth is proportional to risk. Documentation-only or low-risk changes may use deterministic checks. Authentication, infrastructure, migrations, state reconciliation, and destructive workflows require independent falsification or integration review.

Child completion is evidence, not root completion. The root task may close only when all required conditions are true:

```yaml
objective_satisfied: true
required_artifacts_present: true
acceptance_tests_passed: true
integration_verified: true
unresolved_blockers: []
claims_reconciled: true
github_reconciled: true
linear_reconciled: true
cleanup_verified: true
```

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

The implementation must add externally observable tests for:

- root objective compilation into `TaskContractV1`;
- lease acquisition, heartbeat, expiry, release, and reclaim;
- prevention of concurrent conflicting write boundaries;
- distinct strategy-family enforcement for redundant investigations;
- risk-proportional validation selection;
- root completion refusing to close on incomplete evidence;
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
