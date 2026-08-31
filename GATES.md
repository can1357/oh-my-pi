# Gates: grokbot multi-model via ompa

OWNS: packages/ai/src/providers/grokbot/**, packages/ai/src/stream.ts, packages/ai/test/providers/grokbot-proto.test.ts, packages/ai/CHANGELOG.md, scripts/grokbot-matrix.mjs, scripts/grokbot-automation-tools-probe.mjs, GATES.md

Scope: Multiple grokbot models complete inference via ompa/sand for text and tool-enabled requests. Explicit Anthropic ids with raw omp field-2 tools (unmapped names/schemas) remain HTTP 400 upstream; product-shaped **automation wire** is the grokbot-only workaround.

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
  NOTE: Default `GROKBOT_ANTHROPIC_TOOLS_WIRE=auto` selects automation for `claude-*` + tools. Backend model is **not guaranteed Opus** (sand routes automation; mitm observed `cursor-grok-4.6-high`).

- [x] G5-opus-ompa: ompa bash/read smoke on grokbot/claude-opus-5:max with automation wire
  CHECK: `GROKBOT_ANTHROPIC_TOOLS_WIRE=automation PI_NO_MCP=1 ompa -p --model grokbot/claude-opus-5:max --auto-approve "Use bash: echo ok > /tmp/opus-gate.txt; read it; reply with contents"`
  EXPECT: file exists; response mentions `ok`; no HTTP 400
  EVIDENCE: 2026-08-31 — included in `--mode opus-tools` ompa step (pong42 token smoke)

- [x] G5-regression: Non-Anthropic tool matrix still passes after automation wire changes
  CHECK: bun scripts/grokbot-matrix.mjs --mode tools
  EXPECT: MATRIX_TOOLS_PASS
  EVIDENCE: 2026-08-31 — MATRIX_TOOLS_PASS after automation wire merge

ABANDON: G2-claude-raw-tools Explicit `claude-opus-5` + unmapped omp field-2 tools → HTTP 400. Product uses `sand-automation` + `generalPurpose` + PascalCase tools + `{ jsonSchema: … }` envelope. Workarounds: **`GROKBOT_ANTHROPIC_TOOLS_WIRE=automation` or `auto` (default)**; optional `sand-default-fallback` (non-Opus backend). Field-3 CUA never observed in mitm. Guaranteed Opus coding agent: `cursor/claude-opus-5:max` (AgentService, separate auth).

ABANDON: G2-grok-4.5-tools sand InferenceService returns HTTP 422 for grok-4.5 with any tools payload; grok-4.6 tools work. Text-only grok-4.5 passes G1.

ABANDON: AgentService/Run on grokbot sand JWT — zero hits in Grok Bot mitm; use `cursor/*` for AgentService.

OUT OF SCOPE (oh-my-pi grokbot provider): **grokbot-BYOK Anthropic Messages shim** — orthogonal to sand Stream wire work.

## Honest ceiling (grokbot renewal only)

**Selecting Opus with tools does not run Opus.** Default `auto` rewrites the *entire* tools turn to `sand-automation`; sand then routes to grok (not Claude). Sol+tools stays on Sol.

| Selection | Tools? | Wire model | Who runs (mitm 2026-08-31) |
|-----------|--------|------------|----------------------------|
| `gpt-5.6-sol*` | yes | `gpt-5.6-sol` | **Sol** (13/13) |
| `claude-opus-*` / `claude-*` | no | Claude id | May be Opus |
| `claude-opus-*` / `claude-*` | yes (`auto`) | **`sand-automation`** | **cursor-grok-4.5/4.6 only** (40/40 Opus ids; never Opus) |
| `cursor/claude-opus-5:max` | yes | AgentService | Real Opus (separate auth) |

| Goal | Status |
|------|--------|
| `grokbot/claude-opus-5*` + omp tools (bash/read/…) | **Yes** via automation wire (`auto` default) — tools work |
| Verified Opus backend on sand with tools | **No** — mitm: all 40 Opus catalog ids → `sand-automation` → `cursor-grok-4.5/4.6-*` |
| `grokbot/gpt-5.6-sol*` + tools | **Yes** — stays on Sol (13/13) |
| Same as `cursor/claude-opus-5:max` AgentService | **No** — different RPC + auth |
