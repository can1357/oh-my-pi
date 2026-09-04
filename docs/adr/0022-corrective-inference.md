# 0022. An adapter is complete when it yields one canonical turn

Status: accepted
Date: 2026-09-02
Area: inference

## Context

Wiring a provider URL is the smallest part of supporting a model. The output that comes back is
routinely not what the schema promised:

1. Tool arguments arrive as malformed JSON — single quotes, unquoted keys, Python literals,
   trailing commas, truncated buffers mid-stream.
2. Some models (Gemini and DeepSeek are the named offenders) fall into repetition loops and emit
   the same span until the token limit.
3. Structured output leaks into text. Each model has its own dialect for tool calls and reasoning:
   `<tool_call>` JSON tags, Qwen's `<tool_calls>` XML, Gemini's ```` ```tool_code ```` fences,
   Gemma's `<|tool_call>`, Kimi's `<|tool_calls_section_begin|>`, DeepSeek's `<｜tool▁call▁begin｜>`,
   Harmony's channel headers. When the adapter does not parse the dialect, the user sees a tool
   call rendered as prose (the playbook's screenshot) and the loop never executes it.

In pi, each of these was handled — or not — inside individual provider files, so the agent loop,
renderer, and journal each had to tolerate a slightly different notion of "a turn".

## Decision

A provider adapter is complete only when the rest of the harness receives one canonical turn.
Everything between the wire and that turn is inference's job.

1. Provider frames MUST decode to canonical semantic events (text delta, thinking delta, tool-call
   start/delta/ready, usage, completion). A vendor frame is NEVER forwarded literally to the loop,
   the journal, or a renderer.
2. Inference MUST run a bounded, deterministic recovery pipeline on every stream:
   - repair malformed JSON arguments, with hard limits, and refuse truncated documents rather than
     invent closings for committed output;
   - detect within-attempt and cross-turn repetition and cut the attempt with a typed reason;
   - recognize the model's leaked dialect (catalog-selected, 0017) and synthesize canonical
     `tool_call` and `think` blocks from text;
   - reconcile streamed fragments against the committed arguments so what executes is what was
     received.
3. Every recovery is a receipt (`RecoveryRecord` with a `ReasonId`), and the raw bytes are retained
   only as bounded, secret-safe diagnostic context.
4. Recovery stages are sans-I/O, incremental, and retain only incomplete input; a stage MUST resolve
   deterministically at `finish`.

## Consequences

- The agent loop, journal, transcript protocol (0034), and renderers see one event vocabulary; a
  new model's dialect is a new delimiter table plus a catalog rule, not a change to consumers.
- A leaked tool call becomes an executed tool call; a repetition loop becomes a bounded retry
  instead of a wasted context window.
- Prohibited: codec-specific event types leaking past the codec; renderers parsing `<tool_call>`
  text; the agent loop special-casing a provider.
- Cost accepted: the recovery pipeline is real code with limits and tests, and it runs on every
  token. That is cheaper than every consumer carrying partial versions.

## Status in omp

**Implemented.** Primary implementation: `crates/inference/src/recovery`. Recovery and codec stages normalize vendor behavior into canonical `ChatEvent` turns. Catalog-selected Harmony mitigation keeps the attempt behind the whole-attempt gate, repairs only exactly framed `analysis`/`final` channels, rejects provable unframed leakage with a bounded semantic retry, and carries typed recovery evidence through `turn.receipt@1` so replay observes the same audit record.

## References

- The Harness Playbook, "The inference" — "Corrective inference"
- blog.can.ac, "The minutiae of tool calling" (2026-08-03)
- 0008, 0017, 0020, 0021, 0034
- `crates/inference/src/recovery/`, `crates/inference/src/event.rs`, `crates/core/src/slopjson/mod.rs`,
  `docs/architecture/agent-loop.md`
