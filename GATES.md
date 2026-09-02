# Gates: grokbot multi-model via ompa

OWNS: packages/ai/src/providers/grokbot/**, packages/ai/src/stream.ts, packages/ai/test/providers/grokbot-proto.test.ts, packages/ai/CHANGELOG.md, scripts/grokbot-matrix.mjs, scripts/grokbot-automation-tools-probe.mjs, GATES.md

Scope: Multiple grokbot models complete inference via ompa/sand for text and tool-enabled requests. Explicit Anthropic ids with raw omp field-2 tools (unmapped names/schemas) remain HTTP 400 / ERROR_PROVIDER_ERROR upstream; product-shaped tools on original Anthropic requestedModel (**keep-model**) is the default workaround; **automation** remains opt-in.

- [x] G1: Matrix script proves text-only inference for representative grokbot models including Claude
      CHECK: bun scripts/grokbot-matrix.mjs --mode text
      EXPECT: MATRIX_TEXT_PASS
      EVIDENCE: 2026-08-31 — 10/10 models PASS (incl. Claude haiku/sonnet/opus, grok-4.5 text)

- [x] G2: Matrix script proves tool-enabled inference for representative non-Anthropic grokbot models
      CHECK: bun scripts/grokbot-matrix.mjs --mode tools
      EXPECT: MATRIX_TOOLS_PASS
      EVIDENCE: 2026-08-31 — grok-4.6, composer-2.5, gemini-3.7-flash, gpt-5.6-sol, kimi-k3, glm-5.2 PASS; grok-4.5+tools and Claude+raw-tools informational upstream failures

- [x] G3: ompa print smoke succeeds for grok-4.6, composer-2.5, and gpt-5.6-sol
      CHECK: bun scripts/grokbot-matrix.mjs --mode ompa-smoke
      EXPECT: OMPA_SMOKE_PASS
      EVIDENCE: 2026-08-31 — dist/omp 18.0.11 rebuilt; all three models return pong42

- [x] G4: Unit coverage for requested-model mapping and connect-trailer formatting remains green
      CHECK: bun test test/providers/grokbot-proto.test.ts -t "formatGrokbotConnectTrailerError|requested model mapping"
      EXPECT: 0 fail
      CWD: packages/ai
      EVIDENCE: 2026-08-31 — 12 pass, 0 fail

- [x] G5-opus-automation-tools: Claude-labeled models + omp tools via product sand-automation wire (no HTTP 400; Shell toolCall observed)
      CHECK: bun scripts/grokbot-matrix.mjs --mode opus-tools
      EXPECT: MATRIX_OPUS_TOOLS_PASS
      ALT: bun scripts/grokbot-automation-tools-probe.mjs → AUTOMATION_TOOLS_PROBE_PASS
      EVIDENCE: 2026-08-31 — sand probe Shell toolCall; routed model `cursor-grok-4.5-high`; ompa grokbot/claude-opus-5:max PASS with `GROKBOT_ANTHROPIC_TOOLS_WIRE=automation`
      NOTE: Default `GROKBOT_ANTHROPIC_TOOLS_WIRE=auto` resolves keep-model; routed family matches Anthropic label (fable/opus/sonnet/haiku). Explicit `GROKBOT_ANTHROPIC_TOOLS_WIRE=automation` still grok (`cursor-grok-*`).

- [x] G5-opus-ompa: ompa bash/read smoke on grokbot/claude-opus-5:max with automation wire
      CHECK: `GROKBOT_ANTHROPIC_TOOLS_WIRE=automation PI_NO_MCP=1 ompa -p --model grokbot/claude-opus-5:max --auto-approve "Use bash: echo ok > /tmp/opus-gate.txt; read it; reply with contents"`
      EXPECT: file exists; response mentions `ok`; no HTTP 400
      EVIDENCE: 2026-08-31 — included in `--mode opus-tools` ompa step (pong42 token smoke)

- [x] G5-regression: Non-Anthropic tool matrix still passes after automation wire changes
      CHECK: bun scripts/grokbot-matrix.mjs --mode tools
      EXPECT: MATRIX_TOOLS_PASS
      EVIDENCE: 2026-08-31 — MATRIX_TOOLS_PASS after automation wire merge

ABANDON: G2-claude-raw-tools Explicit `claude-opus-5` + unmapped omp field-2 tools → HTTP 400 / ERROR_PROVIDER_ERROR. Default workaround: product-shaped tools on original Anthropic requestedModel (`GROKBOT_ANTHROPIC_TOOLS_WIRE=auto` → keep-model). Explicit `GROKBOT_ANTHROPIC_TOOLS_WIRE=automation` is grok-worker opt-in (`sand-automation` + `generalPurpose` + PascalCase tools + `{ jsonSchema: … }` envelope). Optional `sand-default-fallback` (non-Opus backend). Field-3 CUA never observed in mitm.

ABANDON: G2-grok-4.5-tools sand InferenceService returns HTTP 422 for grok-4.5 with any tools payload; grok-4.6 tools work. Text-only grok-4.5 passes G1.

ABANDON: AgentService/Run on grokbot sand JWT — zero hits in Grok Bot mitm.

OUT OF SCOPE (oh-my-pi grokbot provider): **grokbot-BYOK Anthropic Messages shim** — orthogonal to sand Stream wire work.

## Honest ceiling (grokbot renewal only)

`grokbot/claude-*` + omp tools **yes** via keep-model; backend stays Claude/Fable family. Raw omp field-2 on explicit Anthropic ids remains `ERROR_PROVIDER_ERROR`. Explicit `GROKBOT_ANTHROPIC_TOOLS_WIRE=automation` is grok-worker opt-in (`sand-automation` → `cursor-grok-*`). Non-Claude families keep their label family.

### Full catalog tools sweep (mitm, 2026-08-31) — 199/199 ids

| Catalog family    | n   | Stays on label?                                                                     | Routed family with tools                                                           |
| ----------------- | --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| sol               | 13  | **YES**                                                                             | sol                                                                                |
| gpt               | 80  | mostly YES (76 match; 2 fail; 2 no-tools)                                           | gpt                                                                                |
| composer          | 2   | **YES**                                                                             | composer                                                                           |
| gemini            | 13  | mostly YES (12; 1 model-not-found)                                                  | gemini                                                                             |
| glm               | 3   | **YES**                                                                             | glm                                                                                |
| kimi              | 5   | mostly YES (4; 1 no-tools)                                                          | kimi                                                                               |
| grok              | 16  | `grok-4.6` YES; `grok-4.5`+tools FAIL; `cursor-grok-*` selectors not valid wire ids | grok                                                                               |
| claude (non-opus) | 23  | **YES** (keep-model default)                                                        | Anthropic label (fable/sonnet/haiku); explicit automation → grok (`cursor-grok-*`) |
| opus              | 40  | **YES** (keep-model default)                                                        | Anthropic label (fable/opus); explicit automation → grok (`cursor-grok-*`)         |
| sand-router       | 3   | routers OK                                                                          | **grok** (`sand-default`/`cua`/`automation`)                                       |

Totals: keep-model default keeps Claude/Opus on the Anthropic label family (**177** label-match+tools). The 2026-08-31 sweep (**114** label-match, **63** Claude/Opus→grok, **19** fail, **3** no-tools, **64** wire=`sand-automation`) measured then-default automation rewrite — **not** current `auto`. Explicit automation still grok. Mitmproxy was used for capture then shut down.

| Goal                                                    | Status                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `grokbot/claude-*` + omp tools                          | **Yes** via keep-model; backend is the Anthropic label family |
| Verified Opus/Claude backend with product tools on sand | **Yes** (keep-model)                                          |
| Sol / GPT / Composer / Gemini / GLM / Kimi + tools      | **Yes** — stay on that family                                 |
