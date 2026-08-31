# Gates: grokbot multi-model via ompa

OWNS: packages/ai/src/providers/grokbot/**, packages/ai/src/stream.ts, packages/ai/test/providers/grokbot-proto.test.ts, packages/ai/CHANGELOG.md, scripts/grokbot-matrix.mjs, GATES.md

Scope: Multiple grokbot models complete inference via ompa/sand for text and (non-Anthropic) tool-enabled requests; Anthropic+tools is documented as upstream-blocked.

- [x] G1: Matrix script proves text-only inference for representative grokbot models including Claude
  CHECK: bun scripts/grokbot-matrix.mjs --mode text
  EXPECT: MATRIX_TEXT_PASS
  EVIDENCE: 2026-08-31 — 10/10 models PASS (incl. Claude haiku/sonnet/opus, grok-4.5 text)

- [x] G2: Matrix script proves tool-enabled inference for representative non-Anthropic grokbot models
  CHECK: bun scripts/grokbot-matrix.mjs --mode tools
  EXPECT: MATRIX_TOOLS_PASS
  EVIDENCE: 2026-08-31 — grok-4.6, composer-2.5, gemini-3.7-flash, gpt-5.6-sol, kimi-k3, glm-5.2 PASS; grok-4.5+tools and Claude+tools informational upstream failures

- [x] G3: ompa print smoke succeeds for grok-4.6, composer-2.5, and gpt-5.6-sol
  CHECK: bun scripts/grokbot-matrix.mjs --mode ompa-smoke
  EXPECT: OMPA_SMOKE_PASS
  EVIDENCE: 2026-08-31 — dist/omp 18.0.11 rebuilt; all three models return pong42

- [x] G4: Unit coverage for requested-model mapping and connect-trailer formatting remains green
  CHECK: bun test test/providers/grokbot-proto.test.ts -t "formatGrokbotConnectTrailerError|requested model mapping"
  EXPECT: 0 fail
  CWD: packages/ai
  EVIDENCE: 2026-08-31 — 12 pass, 0 fail

ABANDON: G2-claude-tools Cursor InferenceService Anthropic adapter returns HTTP 400 for any tools payload on Claude models (haiku/sonnet/opus); same renewer works via Cursor AgentService and non-Anthropic grokbot models. Wire matches Cursor InferenceAgentTool proto. Track upstream; do not claim Claude+tools on grokbot until Cursor returns a usable Anthropic body.

ABANDON: G2-grok-4.5-tools sand InferenceService returns HTTP 422 for grok-4.5 with any tools payload; grok-4.6 tools work. Text-only grok-4.5 passes G1.
