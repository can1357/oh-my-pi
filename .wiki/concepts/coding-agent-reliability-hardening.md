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

## July 29: CI recovery and repeatability

### Treat the CI harness as the test contract

The initial CI-repair work merged as [PR #18](https://github.com/kingkillery/oh-my-pk/pull/18). Its durable lesson is procedural: reproduce the **actual CI unit**, not a convenient local subset.

- `scripts/ci-test-ts.ts` is the authoritative runner. It classifies coding-agent tests into buckets, selects the exact files, runs each group with Bun's `--smol` mode, applies the CI-style environment scrub, and carries the aggregate's `--only-failures` behaviour.
- Reproduce a failing bucket on Linux with the same native addon and runner flags that CI uses. Windows-only path, casing, and home-directory mocks are useful diagnostics but are not acceptance evidence for the Linux job.
- The runner fails fast by default. A failure leaves later chunks **unknown**, not green; use `--keep-going` when the goal is the complete failure set. This prevents a fix that merely exposes a later failure from being misreported as a regression.

### Bound Bun runtime-state accumulation

The unchunked singleton/global-state bucket exposed a Bun 1.3.14 runtime crash (`panic(main thread): Segmentation fault at address 0x4`, exit 132) after substantial state accumulated in one process. Bun's own crash banner identifies this as a runtime bug rather than an application exception.

The investigation established two distinct mitigations:

1. `acp-agent-fusion-sidekick.test.ts` now disposes the harnesses it creates. This removes a deterministic two-file trigger, but was not by itself sufficient for the exact CI file list and invocation.
2. [PR #32](https://github.com/kingkillery/oh-my-pk/pull/32) chunks the singleton bucket into groups of ten files, retaining per-chunk process-state coverage while bounding heap growth and leaked child-process accumulation. Its PR CI passed the singleton job and every non-release CI job.

The first post-merge `main` run (`30482788360`) kept the singleton job green but failed separately in the native/unit bucket: `julia-prelude.test.ts` timed out in a hook. That bucket then stopped after its first 10-file chunk, leaving the remaining 51 chunks explicitly **unknown**. It is a distinct test-reliability follow-up, not evidence that the singleton crash returned.

The chunking is explicitly a temporary NER-134 mitigation. Re-evaluate and remove it when a Bun release fixes the underlying crash; any suite that genuinely requires cross-file state must keep those files in the same chunk.

### Context-file disable IDs: precise going forward, compatible for existing users

[PR #33](https://github.com/kingkillery/oh-my-pk/pull/33) is the remaining context-file follow-up, pending CI at the time this note was written. It changes newly written `disabledExtensions` IDs for context files from a basename-only form to a resolved, path-qualified form with forward slashes. Disabling one project's `AGENTS.md` therefore no longer suppresses same-named context files in another project.

The change deliberately dual-reads the old basename ID. Existing settings continue to disable the files they previously matched, including the old collision behaviour, rather than silently re-enabling a file that a user deliberately disabled. Only newly created disable entries receive the path-level precision.

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
