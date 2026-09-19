# CONTEXT_FLOW_AUDIT

**Branch:** `exp/rlm-evidence-addressing` @ `6aa2ddf2f`
**Date:** 2026-09-18

## Prompt flow (actual)

User TUI → `sendUserMessage` → `prompt()` → auto-thinking Jev (CONDITIONAL) → system prompt assembly → [native | RLM spill] → root provider → tool loop → Tokenomics root emit.

## Wiring truth table (summary)

| Component | Status |
|-----------|--------|
| Root model | HOT_PATH |
| RLM spill/search/grants | CONDITIONAL (`rlm.enabled`) |
| Groq EvidencePacket | CONDITIONAL (`rlm.workerMode=evidence-packet`) |
| Tokenomics | HOT_PATH (shadow measurement) |
| TypeSafe Jev | CONDITIONAL (auto-thinking, stop classifier, eval judge) |
| **NanoJev** | **PRESENT_NOT_WIRED** |
| OpenJev | PRESENT_NOT_WIRED |
| z0int | PRESENT_NOT_WIRED |
| Kerdoios | EXPERIMENT_ONLY (P2 notes) |
| fly / mushroom | PRESENT_NOT_WIRED |

## NanoJev — proved not wired

- `rg -i nanojev oh-my-pi-rlm/packages/coding-agent/src` → 0 hits
- Implementation: `openjev/src/z0int/backends/nanojev.py`, `/home/kvn/tmp/NanoJev`
- No package.json dep, no settings key, no CLI flag, no OMP caller

## OpenJev / z0int

Repos exist at `/home/kvn/tmp/openjev` (includes z0int). Zero imports from OMP.

## Jev (TypeSafe)

`packages/ai/src/judgment/typesafe.ts` — remote `jev-latest` API. CONDITIONAL on `providers.judgmentProvider` + credentials. Does not use local NanoJev.

## RLM + Groq

CONDITIONAL on `context.engine=rlm`. Tokenomics policy arms via `deriveContextPolicy()`. EvidencePacketV2 on this branch (P0.2).

## Observability added

- `src/context-flow/` in-memory registry (no new JSONL schema)
- Status line `context_bar` + `context_offload` (root vs external split)
- `/context` → Context Explorer overlay
- Hooks: user prompt, root model call, static not-wired seeds

## Next highest-leverage integration

Wire **RLM mid-turn `emitContextSnapshot`** to Tokenomics (today only on `flushTask`) so OFFLOAD view updates live during search/grant without opening `rlm status`.
