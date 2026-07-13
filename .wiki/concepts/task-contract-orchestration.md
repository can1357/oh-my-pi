---
type: Concept
title: Task-contract and orchestration runtime
description: Ephemeral root task contracts, intent compilation, evidence ledger, and completion-gate modules under packages/coding-agent/src/orchestration.
tags: [orchestration, task-contract, evidence, completion-gate, agent-session]
timestamp: 2026-07-12T00:00:00Z
status: implemented
---

# Task-contract and orchestration runtime

Status: implemented (M1 contracts + Phase 0A planning primitives; evidence-backed completion enforcement remains a separate gate path)

## Scope

Under `packages/coding-agent/src/orchestration/`:

1. **Ephemeral task contracts** for substantial root-session user prompts (M1).
2. **Planning foundation** — reasoning plans, evidence ledger, module registry, self-discovery, completion gates (Phase 0A+).

Contracts are **not** baked into the permanent system prompt and are **not** written to session storage. Full operator doc: `docs/task-contract-orchestration.md`.

## Task contracts (M1)

`AgentSession.prompt()` calls `compileIntent()` for substantial, user-authored prompts in a **main** session only.

```text
user prompt → compileIntent → TaskContractV1 (in-memory)
  → digest (SHA-256, computeTaskContractDigest)
  → hidden task-contract-notice custom message
  → executor block <task-contract>
  → advisor block <active-task-contract> (same 16-char digest prefix)
```

Cleared on `/new`, session switch/reload, branch, `/btw` branch, and tree navigation — cannot cross session boundaries. Retries and post-compaction continuations re-inject the same digest when the notice no longer survives context maintenance.

### Compiler policy

`compileIntent(userText)` is a pure heuristic compiler:

- Emits `TaskContractV1`, assumptions, gaps, material `unresolved` subset, at most one `QuestionSpec`.
- Gap score: `S = 0.25I + 0.20U + 0.20B + 0.25R + 0.10(1-E)` (impact, uncertainty, branching, risk, inverse effort).
- Material at `S >= 0.60`. Hard overrides for auth, destructive/external/irreversible, security/privacy/safety when not explicitly approved.
- One question max; answers patch via `patchContractFromAnswer()`; a fresh imperative root request replaces the contract.

**M1 does not** call `setActiveTaskContract()` for compiled root contracts, so it does **not** enable evidence-backed success gating by itself.

## Planning / evidence stack

| Module | Role |
| --- | --- |
| `task-contract.ts` | Schema, defaults, substantial-request heuristic |
| `intent-compiler.ts` | Deterministic compile + gap scoring |
| `contract-injector.ts` | Executor/advisor XML (escaped), recovery fragments |
| `reasoning-plan.ts` | Plan / digest helpers |
| `evidence-ledger.ts` | Append-only `EvidenceRecordV1` (claim + criterion IDs + kind/status) |
| `completion-gate.ts` / `root-completion-gate.ts` | Criterion-linked completion checks |
| `criterion-adjudication.ts` | Pass/fail/blocked/unproven judgments |
| `module-registry.ts` | Planning module registry |
| `self-discovery.ts` | Classifier for self-discovery |
| `collaboration-policy.ts` / `context-policy.ts` | Spawn/context policy |
| `orchestration-telemetry.ts` | Telemetry |
| `approach-registry.ts` | Approach registry |
| `agent-harness.ts` / `agent-execution-profile.ts` | Harness / execution profiles |

Evidence kinds include `command`, `test`, `source`, `artifact`, `runtime`, `review`, `cleanup`. Progress prose alone is not evidence — records must tie to criterion IDs for the root completion gate.

## Session wiring

Primary owner: `packages/coding-agent/src/session/agent-session.ts` (ephemeral root state, injection, lifecycle clear). Advisor composition: `src/advisor/task-contract-block.ts`.

## Tests (representative)

- `test/orchestration/task-contract.test.ts`
- `test/orchestration/intent-compiler.test.ts`
- `test/orchestration/contract-injector.test.ts`
- `test/agent-session-task-contract-runtime.test.ts`

## Related

- `docs/task-contract-orchestration.md` (canonical long-form)
- [Remote workspace](remote-workspace.md) — Docker sandbox jobs (different package)
- [Ethereal workspaces](ethereal-workspaces.md) — session cwd isolation
