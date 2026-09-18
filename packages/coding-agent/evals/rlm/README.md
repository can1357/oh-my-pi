# RLM offline A/B eval

Data-driven scorecard for the prompt-as-variable spill engine (`src/rlm/`).

## Arms

| arm | meaning |
|-----|---------|
| `off` | Full tool bodies stay in root context |
| `on`  | RLM spill: oversized tool text → `rlm://h/<id>` stubs + store |
| `shake` | Head/tail truncate to `spillBytes` — midpoint needles lost, no store |

## Metrics

| id | definition |
|----|------------|
| M1 | `1 - rootCorpusBytes/originalBytes` on RLM arm |
| M2 | context-token drop RLM vs full (`Tokenizer.countTokens`) |
| C3 | no planted needle inside spilled stubs |
| M5 | needle recoverable (`RlmStore.search` on; shake: present in truncated body) |

## Run

```bash
cd packages/coding-agent
bun evals/rlm/orchestrate.ts
bun evals/rlm/report.ts          # exit 1 on gate failure
bun test test/rlm-context-engine.test.ts test/rlm-v1-acceptance.test.ts
```

## Gates (`workloads.json`)

- M1 ≥ 90% body reduction on fat workloads (RLM)
- M2 ≥ 30% context token drop vs full (W1/W2/W3)
- C3 needle never in stub
- M5 search recovers needle when on
- shake arm present; RLM not 2× worse tokens than shake; RLM keeps M5 when shake drops midpoint

## Live vLLM (GPU)

When a tools-capable OpenAI-compatible server is up (default `http://127.0.0.1:8000`):

```bash
VLLM_MODEL=Qwen/Qwen2.5-1.5B-Instruct bun evals/rlm/live-vllm-harness.ts
# writes results/live-vllm.jsonl (gitignored)
```

Measures: spill stub + root payload drop, `RlmStore.search` needle (M5), live `rlmQuery` TTFT/tokens via streaming chat completions (`cost=$0` local).

Agent multi-turn RPC (`live-slm-bench.ts`) is optional; small SLMs often fail bash/eval schemas — the harness is the load-bearing live gate.
