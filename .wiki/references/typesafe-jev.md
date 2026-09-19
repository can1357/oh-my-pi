---
type: Reference
title: TypeSafe Jev — System One judgment model
description: Typed judgments (noul/choice/score) over caller-supplied state via POST /v1/systemone; no text generation, streaming, or tool calls.
resource: https://docs.typesafe.ai
tags: [vendor-docs, typesafe, jev, system-one, judgment, verification]
timestamp: 2026-09-19T00:00:00Z
---

# Summary

Jev is TypeSafe's System One model: a decision model, not a chat model. One
endpoint, `POST https://api.typesafe.ai/v1/systemone`, takes `state` (string,
JSON object, or array of strings) plus a map of typed `questions` and returns
typed `answers` — it does not write replies, produce code, or generate
explanations. Three primitives:

* **Noul** — yes/no; returns `noul` (probability of yes). No confidence field.
* **Choice** — one of a defined set; returns `choice`, `probabilities`, `confidence`.
* **Score** — position across ordered levels (2–10); returns `score` (can land
  between levels), `probabilities`, `legend`, `confidence`.

All questions in one request run in parallel against the same `state` and
cannot see each other's answers. Question ids are caller-chosen and are not
sent to the model. `confidence` is a derived statistic over the answer
distribution, not a correctness guarantee.

# Contract and economics

* Model id `jev-1.13.0`; aliases `jev-latest` / `jev-preview` currently resolve
  to it. Pin the versioned id before tuning thresholds.
* Pricing: $42 per billion input tokens (~$0.042/Mtok); output tokens free.
* Limits: 64k total context per request, ≤32k for `state` + the longest
  question; 250k tokens/s and 1,200 req/min (docs warn these adjust without
  notice). Errors: 401, 422, 429, 529 Overloaded (retry with backoff).
* SDKs: `@typesafe-ai/sdk` (JS, Node ≥20) and `typesafe-sdk` (Python ≥3.10);
  both read `TYPESAFE_API_KEY`. Data is not used for training; ZDR for
  enterprise.
* Jev is NOT available through OpenRouter (verified 2026-09-19 against the
  live `/api/v1/models` list — 446 models, no match); it requires a direct
  `api.typesafe.ai` key. The shipped verification seam is therefore
  `ix_bridge action=verify` backed by `src/lib/openrouter-judge.ts`
  (OpenRouter chat-completions, default `google/gemini-3.5-flash-lite`);
  `evals/typesafe-jev/` measures its accuracy/latency and keeps `--judge
  typesafe` for direct comparison if a key ever exists.

Validation status (2026-09-19): 15 real captured states / 33 labeled judgments;
judge accuracy 31/33 (~94%), mean latency ~1s. A blind independent relabel of
all 33 judgments agreed with the original labels 33/33 — zero contestable
labels — so both judge misses (`form_filled` aria-values blind spot, fixed by
DOM augmentation; `is_about_iana` overconfidence on an ambiguous question) are
genuine misses, not labeler noise.

# Documented failure modes (jev-1.13 jaggedness)

* Literal — answers the words written; put boundary cases in `criteria`.
* No math, counting, or dates — compute those in code.
* Indirection costs accuracy — avoid double negatives and multi-hop chains.
* Context rot — accuracy falls as `state` fills with irrelevant detail.
* No adversarial resistance — injected instructions inside `state` can steer
  answers; treat page/DOM text as untrusted data.
* No structural invariants — `P(noul) ≠ 1 − P(negated noul)`; Noul and Choice
  disagree on the same question. Never carry thresholds between primitives.
* Not a generator — don't try to make it write.

# Relevance to this codebase

Jev cannot be a catalog model: `KnownApi` in
`packages/catalog/src/types.ts` lists only message/streaming transports
(`openai-completions`, `anthropic-messages`, …), and Jev has no chat endpoint.
The honest seam is a judgment client — `src/lib/typesafe-http.ts` in
`packages/coding-agent`, mirroring the `elevenlabs-http.ts` precedent
(non-chat provider, env-only credentials, no ModelRegistry entry). Intended
use: bounded semantic judgments behind existing lanes — e.g. a `noul` gate
("does this DOM state satisfy the goal?") verifying `pi/browser-control`
work, or a `choice` over candidate actions — with low-confidence results
escalated to a reasoning model rather than acted on.

# Citations

[1] [TypeSafe docs — Models](https://docs.typesafe.ai/models.md)
[2] [TypeSafe docs — HTTP API](https://docs.typesafe.ai/api.md)
[3] [TypeSafe docs — System One](https://docs.typesafe.ai/concepts/system-one.md)
[4] [TypeSafe docs — Confidence](https://docs.typesafe.ai/confidence.md)
[5] [TypeSafe docs — Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)
[6] [TypeSafe docs — JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md)
