# 0021. Inference owns strict-schema budgets and grammar dialects

Status: accepted
Date: 2026-09-02
Area: inference

## Context

Constrained sampling was one of the first features added to omp v1's fork of pi:

```diff
+   strict?: boolean;
+   customFormat?: { syntax: "lark" | "regex"; definition: string };
+   customWireName?: string;
```

pi followed months later with LARK and strict support, exposed as an opaque structure the provider
layer passes through. Two system-wide constraints make a pass-through insufficient:

1. **Strict-schema capacity is a shared budget.** Many providers cap the number of strict schemas
   per request. Enough independently authored extensions each setting `strict: true` make the
   provider reject every request, and the user has no way to find which plugin to patch except
   binary search.
2. **Grammar dialect is provider-specific.** A LARK grammar handed to every provider is itself
   invalid on most of them; Anthropic has never parsed one, Google rejects half of JSON Schema. An
   extension cannot maintain that map because the user may route the same model through a native
   host, a proxy, or a custom provider — routing is user-controlled, not extension-controlled.

pi's answer was a large per-provider constraint document (`CONSTRAINTS.md`, 168 lines) plus schema
utilities, and it still let three independent extensions brick a request nobody could debug
(`docs/py/13-inference.md`).

## Decision

Constraint declarations are intents; the inference layer owns everything between the intent and
the wire.

1. An extension or tool declares **intent** only: strictness, an optional grammar
   (`{ syntax: lark | regex, definition }`), and a priority. It NEVER declares a wire format.
2. Inference owns, in order:
   - **capability detection** — does this route enforce strict schemas or this grammar syntax
     (catalog data, 0017; `unknown` is not "yes");
   - **the budget** — per-route ceilings on advertised tools and strict-schema slots, spent in
     priority order across every registration, stable for a given registration set so a prompt
     prefix does not churn;
   - **dialect normalization** — the schema is rewritten once per provider flavor before emission;
   - **fallback** — when capability or budget is absent, the tool ships as plain JSON Schema and
     charitable client-side decoding validates the result (0020);
   - **surfacing** — invalid output is repaired where unambiguous and otherwise returned to the
     model as a structured, retryable error.
3. Every degradation is a receipted adjustment (`Dropped`, with a typed reason such as
   `catalog.strict-schema-unsupported` or `catalog.grammar-unsupported`), never a silent change.
4. An intent that can never be satisfied (`on_unsupported=ERROR` on a device that cannot reach the
   wire) is a declaration-time error, not a runtime surprise.

## Consequences

- A user adding a tenth strict extension does not brick the harness; the lowest-priority intents
  degrade with a visible receipt.
- The same tool works through a native host, a proxy, and a custom provider without the extension
  knowing which; the dialect layer chooses.
- Prohibited: `strict`, `customFormat`, or a wire name as raw fields on a tool definition;
  provider-name checks in extensions to decide whether to send a grammar.
- Cost accepted: an intent may be honored one turn late or not at all when the budget is full; a
  stable prefix is worth more than one turn of strictness.

## Status in omp

**Partial.** Primary implementation: `crates/inference/src/codec`. Inference owns grammar/strict-schema translation. Gap: strict-schema token/time budgets and all grammar-dialect fallbacks are not proved end to end.

## References

- The Harness Playbook, "The inference" — "Strict sampling needs budgets and dialects"
- pi `packages/ai/src/utils/schema/CONSTRAINTS.md` (the pass-through approach)
- 0016, 0017, 0018, 0020, 0022
- `crates/inference/src/plan.rs`, `crates/inference/src/call.rs`, `crates/tool/src/registry.rs`,
  `docs/py/13-inference.md`
