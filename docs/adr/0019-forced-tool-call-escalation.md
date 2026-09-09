# 0019. Forced tool calls escalate: soft prompt, free flag, then costly flag

Status: accepted
Date: 2026-09-02
Area: inference

## Context

A forced tool call ("the model must call `submit` next") is the clearest case of why "the provider
supports a flag" is not a feature. A library that treats `tool_choice` as a boolean pass-through has
four ways to handle a route, all of them bad:

- **Error on unsupported providers.** No harness-native feature can rely on forcing without
  excluding a large part of the model roster.
- **Silently drop it.** Callers get an unannounced best-effort path and each writes its own
  enforcement loop on top.
- **Pass it through blindly.** Provider side effects become product bugs. Anthropic turns a forced
  call into a cache miss across the whole conversation, so a "cheap" nudge re-bills the prefix.
- **Do not expose it.** Informed callers reach around the library and recreate the other three
  failure modes in extension code.

Two more facts shape the answer. Hosted APIs such as OpenAI quietly prepend a nudge when
`tool_choice` is set; open-source engines (vLLM and friends) do not, so a model behind vLLM receives
a hard grammar constraint it was never told about and flails, especially with reasoning enabled.
And pi shipped the correct soft-prompt behavior for exactly one route
(`google-gemini-cli.ts`, gated on `isAntigravity && !isClaudeModel(...)`), invisible to every other
caller that needed it (`docs/py/13-inference.md`, "The forced-call ladder").

## Decision

A forced call is a caller intent (0016). Inference MUST satisfy it with the cheapest honest rung
and escalate only when the model does not comply.

1. **Always inject a soft prompt.** Every forced-call attempt carries a system-level directive
   telling the model it must invoke the tool next, regardless of route. This levels hosted APIs and
   open engines.
2. **Set the native flag only when it is free.** If the route declares native `tool_choice`
   support with no penalty, pass the flag. If the flag carries a declared penalty (cache
   invalidation), skip it and rely on the soft prompt.
3. **Escalate on non-compliance.** If the model answers without calling the tool, retry a bounded
   number of times. As the last rung, set the native flag even where it costs something, and record
   the escalation with its penalty. Correctness beats the cache once persuasion has failed.
4. The decision NEVER branches on a provider name. Inputs are catalog capability bits
   (`NAMED_CHOICE`, `REQUIRED_CHOICE`) and the route's declared penalty (0017).
5. Every rung is receipted: a dropped flag, a retry, and a paid escalation are visible adjustments,
   not silent behavior.

This is the provider-side half of the `ForceTool` Director (0015): the Director states the
invariant; inference chooses how to satisfy it.

## Consequences

- Any Director or extension can force a tool on any route in the roster and get the same
  guarantee: soft persuasion first, bounded retries, paid enforcement last.
- Anthropic cache prefixes survive the common case; the user sees `Escalated` with a price only
  when the model ignored the prompt.
- Prohibited: setting `tool_choice` directly from a codec or extension; provider-name checks around
  forcing.
- Cost accepted: a forced call may take up to `retries + 1` attempts before it hard-fails; callers
  cap this with the intent's retry count and `allow_costly_escalation`.

## Status in omp

**Implemented.** Primary implementation: `crates/agent/src/directors/force_tool.rs`. Forced calls escalate from prompt to capability-safe native choice with bounded retries. The ladder itself is `crates/inference/src/plan.rs::forced_call_ladder`, applied per attempt by `crates/inference/src/provider/builtin.rs::forced_call_operation`. Its inputs are compiled by `crates/catalog/src/compile.rs`: `tool_feature_bits` derives `NAMED_CHOICE`/`REQUIRED_CHOICE` from the model's compiled tool policy (affirmative facts only), and the host-declared `forced_tool_choice_penalty` (provider `compat`) is inherited by every model the provider serves unless a more specific rule declares one.

## References

- The Harness Playbook, "The inference" — "Capability policy: forced tool calls"
- 0015 (Directors), 0016 (semantic requests), 0017, 0018
- `crates/inference/src/plan.rs`, `docs/py/13-inference.md` ("The forced-call ladder")
- pi `packages/ai/src/providers/google-gemini-cli.ts` / `google-antigravity-forced-tool.md`
  (the single-route prior art)
