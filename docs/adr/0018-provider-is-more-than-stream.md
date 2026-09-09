# 0018. A provider is shared infrastructure, not a `stream` function

Status: accepted
Date: 2026-09-02
Area: inference

## Context

pi models a provider as `stream` and `streamSimple`, and little else. That is ideal for standing a
provider up in an afternoon and poor for everything built on top of it afterwards. The pressure
showed up twice in the author's own history: a web-search plugin for pi had to reimplement the
provider's transport, and pi's later `image-models.ts` grew a parallel provider surface for image
generation because the chat surface could not host it.

A provider that only streams chat leaves these unowned:

- Anthropic's token-counting endpoint
- Codex's WebRTC voice endpoint and remote compaction
- Anthropic / OpenAI hosted web search
- embeddings
- image and video generation
- tokenization
- usage and quota queries
- model discovery

Every extension that adds one of these must also implement synchronized OAuth refresh and retries
for the same credential, and in practice each one does it partially and differently.

The same gap hides provider-native controls behind an opaque request object: constrained sampling,
OpenAI text verbosity, Google's context filters, forced tool calls, the developer role, mid-session
system prompts. Callers who want them go around the library and re-create every failure mode the
library was supposed to prevent.

## Decision

A provider is a shared piece of inference infrastructure with a typed operation surface. Its
non-chat operations and its cross-cutting concerns MUST live in the inference layer, NEVER in
extensions.

1. Authentication refresh, credential leasing, retries, rate limiting, and account rotation are
   engine-owned and shared across every operation on a route. An extension NEVER holds or refreshes
   a provider credential itself.
2. The operation surface is enumerated, not implied by `stream`: chat, token counting, tokenization,
   embeddings, image and video generation, transcription and speech, realtime voice, web search,
   usage, and discovery are first-class operations a route may declare. Capability is data (0017);
   absence is `unknown` or `unsupported`, never a silent 404.
3. Provider-native controls are exposed as semantic intents on the request (0016): strictness,
   grammar, forced call, service tier, verbosity, context filters, cache retention, developer role.
   The codec decides how — or whether — each intent reaches the wire, and records the adjustment.
4. Extensions contribute providers as data (routes, models, auth spec, discovery spec) plus
   cold-path hooks (`provider_login`, `provider_refresh`, `before_request`, `provider_usage`,
   `search_parse`); they NEVER implement a second transport, retry loop, or refresh protocol.

## Consequences

- One correct OAuth refresh and one retry policy serve chat, search, embeddings, and voice alike.
  A provider that ships usage or discovery gets it through the same credential path as chat.
- Harness features (title generation, search, memory embeddings, voice) can rely on provider
  operations without each feature bundling a client.
- Bleeding-edge provider controls become available to every caller the day the codec supports
  them, with degradation recorded rather than invented per caller.
- Cost accepted: adding a provider means declaring more than a URL. The declaration is data, so
  the cost is in the catalog, not in code.
- Prohibited: extension-implemented `stream` functions, per-extension HTTP clients to provider
  hosts, per-extension token refresh.

## Status in omp

**Implemented.** Primary implementation: `crates/inference/src/provider`. Provider infrastructure owns auth, codecs, routing, streaming, and typed errors. Local and configured model discovery is implemented by `crates/inference/src/discovery`, the bounded `crates/envd/src/model_discovery.rs` HTTP authority, and driver-owned cache/catalog composition.

## References

- The Harness Playbook, "The inference" — "A provider is more than `stream`"
- pi `packages/ai/src/image-models.ts` (parallel provider surface grown outside `stream`)
- 0002, 0016, 0017, 0019, 0021
- `crates/inference/src/operation/mod.rs`, `docs/py/13-inference.md`
