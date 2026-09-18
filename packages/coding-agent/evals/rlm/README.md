# RLM offline A/B eval

Data-driven scorecard for the prompt-as-variable spill engine (`src/rlm/`).

## Arms

| arm | meaning |
|-----|---------|
| `off` | Native path: full tool bodies stay in root context |
| `on`  | RLM spill: oversized tool text → `rlm://h/<id>` stubs |

## Metrics

| id | definition |
|----|------------|
| M1 | `1 - rootCorpusBytes/originalBytes` on treatment |
| M2 | context-token drop on vs off (`Tokenizer.countTokens`) |
| C3 | no planted needle inside spilled stubs |
| M5 | needle recoverable via `RlmStore.search` |

## Run

```bash
cd packages/coding-agent
bun evals/rlm/orchestrate.ts
bun evals/rlm/report.ts          # exit 1 on gate failure
```

Live mid-session toggle (RPC, not this harness):

```bash
# see plan: /rlm on → dumpTools includes rlm
```

## Gates (`workloads.json`)

- M1 ≥ 90% body reduction on fat workloads
- M2 ≥ 30% context token drop (W1/W2/W3)
- C3 needle never in stub
- M5 search recovers needle when on
