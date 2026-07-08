---
type: Concept
title: Offload trace (progressive-disclosure compaction memory)
description: Opt-in trace/canvas layer that keeps raw high-volume evidence out of compaction summaries while leaving it recoverable via artifact:// drill-down refs.
tags: [compaction, memory, artifacts, context, progressive-disclosure]
timestamp: 2026-07-08T00:00:00Z
status: implemented
---

# Offload trace

Progressive-disclosure memory path for compaction, inspired by TencentDB-Agent-Memory's L0→L3 layering but implemented natively — no vendor packages, no new URL protocol, no runtime dependencies.

## Problem

Compaction summarization discards raw high-volume evidence (long tool outputs, large reads). After compaction the model can no longer drill back into the details it summarized away.

## Design

At compaction time (manual and auto paths), when `offloadTrace.enabled` is set:

1. Long message evidence (`>= offloadTrace.rawArtifactMinChars`) is saved as an `offload` artifact through the existing `ArtifactManager` — recoverable via `artifact://<id>`.
2. A compact `OffloadTraceCanvas` (nodes + edges + token-saved estimate) is stored in `CompactionEntry.preserveData.offloadTrace`.
3. A bounded `## Trace` markdown section (Mermaid graph + drill-down refs table) is appended to the compaction summary.
4. On context rebuild, `summaryWithPreservedOffloadTrace()` in `session-context.ts` rehydrates the trace into the summary if absent — mirroring the snapcompact preserved-archive pattern.

Drill-down refs use only existing protocols: `artifact://<id>`, `wikigraph://node/<id>`, `wikigraph://path/<path>#L<a>-L<b>`. No `trace://` was added.

## Key files

- `packages/coding-agent/src/session/offload-trace.ts` — model, builder, renderer, validator.
- `packages/coding-agent/src/session/agent-session.ts` — `#attachOffloadTraceToCompaction` before both `appendCompaction()` callsites.
- `packages/coding-agent/src/session/session-context.ts` — rehydration hook.
- `packages/coding-agent/src/config/settings-schema.ts` — settings.
- `packages/coding-agent/test/session/offload-trace.test.ts` — 10 tests: renderer determinism/bounds, refs, maxNodes truncation, version validation, artifact save, rehydration, failure degradation.

## Settings (all config-first, no UI)

```yaml
offloadTrace:
  enabled: false        # opt-in while behavior stabilizes
  maxCanvasChars: 2000
  maxNodes: 24
  rawArtifactMinChars: 4000
```

## Invariants

- Compaction is a recovery path: trace build failures are caught and logged (`logger.debug`); summary and preserveData stay unchanged on failure.
- Artifact write failure degrades to an inline bounded summary node marked `unresolved` — never throws.
- Unknown `version` values in preserved traces are ignored on rehydration.
- Summaries already containing `## Trace` are never double-appended.
