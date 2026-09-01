# Adaptive Orchestration Engine

Task 08 adds a deterministic policy layer that coordinates Tasks 01–07 without replacing the OMP agent loop.

## Architecture

```text
user task
   ↓
Task Router (01)
   ↓
Orchestration policy (08)
   ├── Repository Intelligence (04)
   ├── Context Intelligence (02)
   ├── Model Strategy (06)
   ├── Tool Intelligence (05)
   └── Project Memory (07)
   ↓
existing Agent loop / tools
   ↓
Verification + Recovery (03)
   ↓
Orchestration policy
```

The orchestration layer owns only a compact state and next-action decision. Tool execution, provider behavior, permissions, context assembly, repository indexing, model capability detection, memory persistence, and verification remain owned by their existing subsystems.

## Phases

```text
UNDERSTAND → PLAN → IMPLEMENT → VERIFY → REVIEW → COMPLETE
                     │              │
                     │              └→ DIAGNOSE → REPAIR → VERIFY
                     │                                 └→ ESCALATE → REFRESH_CONTEXT
                     └→ REFRESH_REPOSITORY

Any phase → COMPACT when context pressure is high
Any blocked verification → BLOCKED
```

Not every phase executes. SIMPLE tasks start at IMPLEMENT; NORMAL tasks can PLAN; COMPLEX/VERY_COMPLEX tasks can DISCOVER/PLAN/REVIEW.

## Policy

`decideNextAction(state)` uses only deterministic state and subsystem evidence. It does not call an LLM. Each action contains a reason, capability requirements, context requirements, verification requirement, escalation level, and a compact strategy fingerprint.

Recovery is bounded. The intended failure progression is:

```text
FAIL → DIAGNOSE → REPAIR → VERIFY
                   │
                   └ repeated/stagnant → ESCALATE → REFRESH_CONTEXT → REPAIR
```

The same recovery action cannot repeat indefinitely because action transitions are recorded in `lastAction`, `strategyHistory`, `repairCount`, and `escalationLevel`.

## Completion contract

`COMPLETE` is reached only from a satisfied verification/review path. `BLOCKED` and `UNVERIFIED` remain distinct outcomes.

Current repository facts remain authoritative over stale memory. Orchestration only consumes existing Task 04/07 signals; it does not create another repository or memory system.

## Integration

`orchestration-runtime.ts` wraps `Agent.prompt()` once and uses existing `Agent.addBeforeModelCall()`, `Agent.subscribe()`, `Agent.followUp()`, and the existing yield-hook composition. Directives are injected into the current model-call context rather than appended to the durable transcript.

A complex verified task receives at most one bounded review follow-up before completion.

## Telemetry

The state contains counters and timings for model calls, tool calls/failures, parallel groups, verification checks, repairs, escalations, strategy changes, compactions, memory retrievals, repository queries, model wait time, tool wait time, and phase durations.

## Controls

Disable with `PI_ORCHESTRATION=0`.

The existing Task 01–07 feature flags remain authoritative for their own subsystems.

## Verification

Deterministic state-machine/invariant tests live in `orchestration.test.ts`. The core package's exact test command is `bun test --parallel`; the coding-agent package's test command is `bun ../../scripts/ci-test-ts.ts coding-agent-heavy --full`. The implementation environment used for Task 08 did not provide Bun, so these commands were not executed here and no pass result is claimed.
