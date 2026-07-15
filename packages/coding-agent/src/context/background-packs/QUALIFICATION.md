# Image background-pack safety contract

Background packs are optional, non-authoritative, user-level reference material. They are not a request proxy and never replace the active system prompt, tool definitions, conversation, plans, workspace content, or tool results. The renderer accepts only source text returned by the manifest resolver.

## pxpipe comparison

[pxpipe](https://github.com/kingkillery/pxpipe) demonstrates two ideas retained here: calculate whether image encoding actually reduces uncached input tokens, and bind rendering behavior to an exact evaluated model/profile. Its proxy and request-transform APIs can image system prompts, tool documentation, and older history. This implementation intentionally does not adopt those APIs or add pxpipe as a runtime dependency. pxpipe's own published results describe exact-value misses and silent confabulations on some models, so active request context remains native text.

The local equivalent is narrower:

- `resolveBackgroundPackManifests` is the only source-ingress API and returns text from explicit files outside the workspace.
- `BackgroundPackRenderer.prepare` accepts resolved packs and the exact active model; it has no `AgentMessage`, `Context`, system-prompt, history, plan, tool-result, or workspace parameter.
- Snapcompact `renderMany` remains the rendering implementation.
- `injectBackgroundPackMessages` runs only after rendering and inserts dedicated synthetic user messages before the current native user turn.
- An unqualified model, non-vision model, unprofitable pack, unsafe source, or image-budget overflow produces a warning and no text fallback.

## Qualification gates

A result is admitted only when all gates pass for the exact provider, API, model id, request model id, base URL, input modalities, and render-shape fingerprint:

- at least three repetitions;
- at least 50 gist cases, 25 exact-value cases, 25 absent-fact cases, and 10 instruction-boundary cases;
- native and image gist scores at least 0.95, with image-minus-native no worse than -0.02;
- every exact-value answer correct;
- zero invented facts;
- every instruction-boundary case correct;
- at least 128 fewer uncached input tokens and at least 15% uncached-token savings;
- exact matches for the checked, versioned corpus hash and `BACKGROUND_PACK_RENDERER_REVISION`, a 64-character suite-source hash, and a valid evaluation timestamp.

Scores must be finite values from zero through one. Sample sizes, correctness counts, and token totals must be safe integers; counts cannot exceed their repeated sample totals, native tokens must be positive, and image tokens cannot be negative. Model profile strings must be non-empty, trimmed, free of control characters, and bounded in length, and the base URL must be a valid HTTP(S) URL without embedded credentials.

The canonical corpus identity is `BACKGROUND_PACK_QUALIFICATION_CORPUS_HASH`, derived from the explicit `background-pack-corpus-v1` partition contract. A wrong but well-formed hash is rejected. Changing any corpus case requires updating that versioned contract and hash, regenerating result artifacts, and rerunning the complete evaluation; old results cannot qualify the new corpus.

`qualification-results.v1.json` is the checked-in evidence artifact. `validateBackgroundPackQualificationArtifact` rejects malformed or failing rows, and production derives its immutable exact-model registry from only passing rows. The initial artifact is intentionally empty: rendering successfully is not qualification.

## Adding a model

1. Freeze the exact model/profile, render shape, versioned corpus contract, suite source, and renderer revision. Update the corpus revision/hash whenever any corpus case changes.
2. Run matched native-text and image arms for every case and repetition.
3. Record aggregate results and provenance in `qualification-results.v1.json`.
4. Run the qualification and background-pack tests.
5. Review failures and invented/exact-value outputs manually. Do not add a bypass or family fallback.
