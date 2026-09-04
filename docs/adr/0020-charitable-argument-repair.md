# 0020. Validate the contract strictly, repair the model's dialect charitably

Status: accepted
Date: 2026-09-02
Area: inference

## Context

A tool's `parameters` schema defines its argument shape precisely. That is the right contract for a
human API client; models are not generic API clients. Their mistakes are specific to the tool name
and to the harnesses they were trained against:

- RL-maxxed models call a familiar tool with another harness's schema for it.
- Composer-style models emit `Grep` with its expected shape even when no `Grep` tool is registered.
- Codex, given `paths: string[]`, sends one string delimited by `;` or `,`, depending on the day.

A raw JSON Schema validator turns each of these into a hard rejection. The model then either retries
blind, or the harness author adds a tool-local fix-up — and every tool grows its own slightly
different copy of "accept a comma-separated string for an array" (0002). Neither the model nor the
user can see what was accepted or why.

## Decision

Argument decoding MUST validate the tool's semantic contract strictly and repair the model's
dialect charitably. The repair layer is engine-owned, declarative, and receipted.

1. **Strict on semantics.** A required field missing, a value outside its domain, or an unknown
   tool name is rejected with a structured, retryable error the model can act on. The tool
   implementation NEVER sees an argument set that violates its contract.
2. **Charitable on dialect.** When the mapping from what the model sent to what the schema means is
   unambiguous, decode it: `paths: "a,b"` → `["a", "b"]`; `"true"` → `true`; `"3"` → `3`; a declared
   alias field name → its canonical name; a closed-schema extra key → dropped. Ambiguous input is
   NEVER guessed; it becomes the structured error from rule 1.
3. **Repairs are declared, not improvised.** Coercions and aliases are declared on the argument
   spec by the tool author; the decoder applies them in order. A tool NEVER parses its own raw JSON
   to work around a model.
4. **Every repair is evidence.** The raw arguments are journaled faithfully; the applied repair
   trail (`Alias`, `Coercion`, elision) rides with the call so renderers, receipts, and reviews can
   show what was accepted.
5. JSON Schema validation is one stage of this layer, not the layer. Syntax repair (0022), alias
   resolution, coercion, and elision run before it; the structured error is produced after it.

## Consequences

- Tools ship one schema and receive canonical arguments; the "accept `;`-joined strings" knowledge
  lives once, in the decoder, for every tool.
- Models get an actionable error on real contract violations instead of a schema dump.
- Argument-dialect versions can be tracked per tool revision, so a model's success rate per dialect
  is a query rather than folklore.
- Prohibited: tool-local `serde_json::Value` massaging; silent acceptance of ambiguous input;
  discarding the raw arguments after repair.
- Cost accepted: the decoder is a real component (pull cursor over a growing document, speculative
  union branches, repair trail) rather than a `validate(schema, value)` call.

## Status in omp

**Implemented.** Primary implementation: `crates/tool/src/incoming.rs`. Raw arguments are journaled while the typed decoder performs charitable dialect repair before strict validation.

## References

- The Harness Playbook, "The inference" — "Tool schemas are model-facing protocols"
- blog.can.ac, "The minutiae of tool calling" (2026-08-03)
- 0002, 0008 (tool call as a state stream), 0021, 0022, 0026 (versioned tools)
- `crates/tool/src/incoming.rs`, `crates/tool/src/lib.rs`, `crates/core/src/slopjson/mod.rs`
