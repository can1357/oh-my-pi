---
type: Concept
title: Coding-agent reliability hardening
description: Recent reliability fixes that reduce ambiguous routing, unsafe WikiGraph file reads, offload drill-down regressions, and bundled-agent check failures.
tags: [coding-agent, reliability, wikigraph, routing, compaction, agents]
timestamp: 2026-07-09T00:00:00Z
status: implemented
---

# Coding-agent reliability hardening

Recent hardening work focused on making advanced harness paths safer and easier to verify.

## WikiGraph path sandbox

`wikigraph://path/...` is now constrained to the calling session `cwd` plus configured `wikigraph.roots`.

Implementation notes:

- Root settings are read from `ResolveContext.settings` when available.
- `<cwd>` and `~` roots are expanded before comparison.
- Target and roots are canonicalized with `fs.realpath` when possible, with `path.resolve` fallback.
- Relative traversal and absolute paths outside allowed roots fail with `wikigraph: path is outside allowed roots`.

Tests cover allowed session-cwd reads, allowed `<cwd>/.ompk/wiki` reads, allowed configured root reads, `../` rejection, and absolute-path rejection.

## 9router ID normalization

`NineRouterController` now uses explicit helper names:

- `toNineRouterComboId()` strips `9router/` before matching IDs returned by the local 9router `/models` endpoint.
- `toNineRouterSelector()` stores selected combos as `9router/<combo-id>` model-role selectors.

This documents the key convention: inside `NineRouterController`, provider-looking IDs such as `openrouter/...`, `ag/...`, and `gc/...` are 9router combo IDs. Direct provider selectors must bypass the controller and be written as normal model roles elsewhere.

Tests cover `openrouter/*`, `ag/*`, `gc/*`, and existing `9router/*` candidates.

## Offload artifact drill-down

Offload trace tests now include an end-to-end artifact protocol round trip:

1. Build an offload trace from raw evidence.
2. Render the trace.
3. Extract `artifact://<id>` from the rendered markdown.
4. Resolve it through `ArtifactProtocolHandler`.
5. Assert the resolved content equals the original raw evidence exactly.

This locks down the progressive-disclosure promise: compact trace context can still recover raw evidence.

## Bundled agent checks

Bundled browser-control agent wiring was repaired so `bun check` parses the embedded agent definition list and sees imported markdown templates as used. The repository-level `bun check` gate passes after the fix.

## Verification

Relevant checks run during implementation:

```bash
bun test packages/coding-agent/test/internal-urls/wikigraph-protocol.test.ts
bun test packages/coding-agent/test/session/offload-trace.test.ts packages/coding-agent/test/nine-router-controller.test.ts packages/coding-agent/test/task/bundled-agents.test.ts
bun check
```
