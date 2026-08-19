# Task-contract orchestration

Task contracts are ephemeral, deterministic request context for substantial root-session work. They are implemented in `packages/coding-agent/src/orchestration/` and wired by `AgentSession`; they are not added to the primary agent's permanent system prompt and are never written to session storage.

## Runtime behavior

`AgentSession.prompt()` calls `compileIntent()` only for substantial, user-authored prompts in a main session. It stores the resulting compiled contract only in that `AgentSession` instance, computes its SHA-256 digest with `computeTaskContractDigest()`, and appends a hidden `task-contract-notice` custom message to the executor turn.

The same compiled contract is passed to `buildContractInjectionBlock()` for both targets:

- executor: a full `<task-contract>` block
- advisor: a compact `<active-task-contract>` block

Both blocks contain the same 16-character digest prefix. The advisor block is installed when its runtime is created and whenever a compiled contract changes; it replaces the legacy assignment snapshot block when both exist.

The state is cleared on `/new`, session switch/reload, branch, `/btw` branch, and tree navigation. It therefore cannot cross session boundaries. Retry continuations, post-compaction auto-continuations, and the next ordinary prompt after a manual or idle compaction re-inject the same executor digest block when the prior notice no longer survives context maintenance.

## Compiler policy

`compileIntent(userText, options?)` is a pure heuristic compiler. It emits a `TaskContractV1`, inferred assumptions, all gaps, a material `unresolved` subset, and at most one `QuestionSpec`.

Gap priority uses normalized factors:

```text
S = 0.25I + 0.20U + 0.20B + 0.25R + 0.10(1-E)
```

- `I`: normalized impact
- `U`: uncertainty (`1 - confidence`)
- `B`: branching value
- `R`: normalized risk
- `E`: user effort

A gap is material at `S >= 0.60`. Gaps sort deterministically by descending score and then stable gap id. Low-impact, non-material gaps become explicit assumptions rather than questions.

The compiler asks at most one question. Authorization, destructive action, external action, irreversible cost, security, privacy, and safety gaps are hard overrides: when their scope is not explicitly approved, they remain material and can supply the one question regardless of ordinary score selection. All material gaps appear in the executor `<unresolved>` block; the advisor sees blocking/significant gaps in `<open-gaps>`.

When the runtime has a pending question, the next response is consumed as its one answer through `patchContractFromAnswer()`, including a detailed response such as `deploy to staging`. A fresh imperative root request (`implement`, `build`, `fix`, and similar) instead replaces the ephemeral contract. A patched contract is re-injected with a new digest and never produces a second question for that root turn. If other material gaps remain, the executor and advisor receive them in `<unresolved blocked="true">` / `<open-gaps blocked="true">`; this is context for the agent, not completion enforcement.

## XML safety

`contract-injector.ts` escapes `&`, `<`, `>`, double quotes, and single quotes in element text and attributes. Empty optional sections are omitted. `buildRecoveryInjection()` returns an empty string when it has neither unmet criteria nor a recovery summary, so callers cannot send a blank recovery block.

## Completion enforcement

Compiled root contracts activate the existing evidence-backed completion gate through `AgentSession.setActiveTaskContract(toActiveTaskContractSnapshot(contract))`. Assignment-child and compiled-root adapters share that one gate; for compiled roots, `root-completion-gate.ts` converts each successful, non-useless tool result after contract activation into an append-only `EvidenceLedger` record tied to the affected criterion IDs, then derives pass/fail/unproven coverage from that ledger instead of trusting completion prose. Failed and pre-activation results provide no evidence. Compiled contracts remain ephemeral and are still cleared on every session boundary. Criterion-adjudication and Prime control-plane wiring remain later M2 work.

## Relevant files

| File | Role |
|---|---|
| `src/orchestration/task-contract.ts` | Contract schema, defaults, parsing, substantial-request heuristic, legacy snapshot helpers |
| `src/orchestration/intent-compiler.ts` | Deterministic compiler, normalized gap scoring, assumptions, one-question policy |
| `src/orchestration/contract-injector.ts` | Executor/advisor XML blocks and safe recovery fragments |
| `src/orchestration/reasoning-plan.ts` | Canonical task-contract digest |
| `src/advisor/task-contract-block.ts` | Advisor prompt composition for compiled and legacy contract blocks |
| `src/session/agent-session.ts` | Ephemeral root state, message-level executor injection, advisor synchronization, and lifecycle clearing |

## Tests

- `test/orchestration/task-contract.test.ts`: schema, defaults, XML, and substantial-request detection
- `test/orchestration/intent-compiler.test.ts`: scoring, stable ordering, overrides, assumptions, and the one-question policy
- `test/orchestration/contract-injector.test.ts`: executor/advisor blocks, digest parity, XML escaping, and recovery-block behavior
- `test/agent-session-task-contract-runtime.test.ts`: root-session executor/advisor injection, retry persistence, and session isolation
