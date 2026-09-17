# JEV showcase benchmarks (omp)

**Audience:** maintainers reproducing the public TypeSafe/Hermes demos — not end-user onboarding.
Using Jev in omp only needs `TYPESAFE_API_KEY` + `/jev` (see repo `docs/environment-variables.md`).

Recreates the **offline test contracts** and **live scorecard harness** from the
three public Jev demos:

| Demo | Upstream | What it showcases | omp port |
|------|----------|-------------------|----------|
| Skill suggestion | [docs.typesafe.ai cookbooks/skill_suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion) | 488-request battery; wrong_load + needless_load vs oracle | `skill-suggestion/` + `test/jev-showcase-skill-suggestion.test.ts` |
| Computer use | [awlevin/typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use) | Factorized 3-Choice decide (~$0.0002/step) | `computer-decide/` + `test/jev-showcase-computer-decide.test.ts` |
| Browser ultrafast | [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) | Operation + target heads, one System One request | `src/jev-showcase/browser-action-space.ts` + `test/jev-showcase-browser-factorized.test.ts` |

Hermes `evals/browser_use/` is a **different** benchmark (browser_exec A/B vs
built-in tools). This directory tracks **Jev/System One** demos only.

## Quick run (offline, CI-safe)

```bash
cd packages/coding-agent
bun test test/jev-showcase-*.test.ts
bun test test/computer-decide*.test.ts test/skills-suggest.test.ts
```

## Live batteries (resume-safe jsonl)

### Skill suggestion

```bash
source ~/.omp/.env   # TYPESAFE_API_KEY from vault

# Build full Hermes roster (~209 skills) from a hermes-agent checkout:
bun evals/jev-showcase/skill-suggestion/build-hermes-roster.ts

# 12-task smoke (default roster.json subset):
bun evals/jev-showcase/skill-suggestion/orchestrate.ts
bun evals/jev-showcase/skill-suggestion/report.ts

# Full roster + custom task file (drop-in cookbook requests.json when you have it):
JEV_ROSTER_PATH=evals/jev-showcase/skill-suggestion/data/hermes_roster.json \
JEV_TASKS_PATH=evals/jev-showcase/skill-suggestion/data/requests.json \
JEV_CONCURRENCY=4 \
bun evals/jev-showcase/skill-suggestion/orchestrate.ts
```

**Note:** TypeSafe does not publish the cookbook's `requests.json` (488 labeled turns) or
`json_cache.json` as standalone downloads. Build `hermes_roster.json` locally with the script
above; drop in `requests.json` from a cookbook checkout if you have one.

Scorecard columns match the cookbook: **wrong_load** and **needless_load** (lower is better).

### Computer decide

```bash
# rules → rerank only
bun evals/jev-showcase/computer-decide/orchestrate.ts

# + live Jev
export TYPESAFE_API_KEY=...
JEV_ARMS=rules-rerank,jev bun evals/jev-showcase/computer-decide/orchestrate.ts

# + isolated GTK e2e (Xvfb tier 1)
PI_COMPUTER_E2E=1 JEV_ARMS=e2e bun evals/jev-showcase/computer-decide/orchestrate.ts

bun evals/jev-showcase/computer-decide/report.ts
```

Completed cells in `results/results.jsonl` are skipped on rerun.

## Reference numbers (TypeSafe cookbook, Hermes 182-skill roster)

| arm | wrong_load | needless_load |
|-----|------------|---------------|
| agent alone | 16.8% | 9.8% |
| TypeSafe suggest | 7.3% | 4.0% |
| oracle | 2.5% | 1.2% |

The bundled task battery is a **representative subset** (12 tasks, 12-skill roster).
Drop in the full `requests.json` + `hermes_roster.json` from the cookbook to reproduce the 488-run battery verbatim.
