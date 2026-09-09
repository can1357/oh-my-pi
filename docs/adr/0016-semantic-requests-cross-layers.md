# 0016. Directors state intent; inference chooses how to satisfy it

Status: accepted
Date: 2026-09-02
Area: control-plane

## Context

`ForceTool` (0015) expresses one semantic request: "the next successful turn must call `write`."
As written in the playbook it is a Director with `prepare_inference` returning
`request.with_tool_choice(self.tool)` and an `on_yield` that pops on success, continues with a
reminder while retries remain, and fails when they are exhausted.

It does not know whether the selected provider has a native `tool_choice`, whether forcing
destroys the prompt cache on this route, or whether a local model needs an extra prompt to comply.
When omp v1 and pi let the caller carry that knowledge, provider names leaked into control-plane
code and every behavior that wanted to force a tool re-learned the same quirks (0017).

## Decision

The control plane MUST state semantic intent only: force this capability, enforce this output
shape, count these tokens, require a yield. It NEVER names a provider feature, a wire field, a
cache strategy, or a model-specific prompt.

The inference layer MUST own the translation: capability lookup, cost (cache penalties, extra
requests), and escalation (soft prompt, free native flag, costly native flag — 0019). It returns
the same canonical outcome regardless of which strategy satisfied the request, so a Director's
`until` predicate is evaluated on the turn, not on how the turn was obtained.

A request that inference cannot satisfy on the current route is reported to the Director as a
failure of the request, never silently downgraded.

## Consequences

- A Director written once works across incompatible models and providers.
- Provider knowledge stays compiled in one place (0017, 0018); control-plane code has no
  provider branches to review.
- Prohibited: `if provider == …` in Directors or extensions; passing raw `tool_choice` or grammar
  dialects up from the control plane.
- Cost accepted: inference carries an escalation ladder and its bookkeeping; a Director cannot
  micro-manage cost, only state intent and retry budget.

## Status in omp

**Implemented.** Primary implementation: `crates/agent/src/directors/force_tool.rs`. Directors express semantic force intent; inference/catalog capability selects the concrete mechanism.

## References

- The Harness Playbook, "The control plane" → "Hooks, Directors, and inference" (closing
  paragraph); "The inference" opening lesson
- 0015 (Directors), 0017 (compatibility as structured knowledge), 0018 (provider infrastructure),
  0019 (forced-call escalation), 0021 (constrained sampling ownership)
- `crates/agent/src/regime.rs`, `crates/agent/src/tool_choice.rs`, `crates/inference/src/call.rs`,
  `crates/inference/src/plan.rs`, `crates/inference/src/codec/openai_chat.rs`
