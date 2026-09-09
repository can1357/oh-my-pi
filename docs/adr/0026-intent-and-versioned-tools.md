# 0026. Every tool carries `i`; every tool is versioned

Status: accepted
Date: 2026-09-02
Area: tools

## Context

Two recurring gaps in pi-shaped tool contracts:

- **Nothing says what a call is for until it finishes.** Arguments stream in over seconds; the
  preview renderer has a half-parsed `command` or `path` and nothing human-readable. Tools that
  wanted a summary each invented their own field — `reason`, `purpose`, `description` — so the
  journal had no uniform place to look and renderers had per-tool special cases.
- **Traces cannot be evaluated per contract.** A tool's argument shape or rendering changes;
  old sessions still contain calls under the old shape. Parsing a frequently changed tool's I/O to
  measure its success rate over time then requires guessing which contract produced each call.

Once traces are used for evaluation or repair (0029, 0022), guessing any of name, version, intent,
input, output, diagnostics, or usage is avoidable technical debt.

## Decision

1. Every tool schema MUST carry an `i` argument: a short present-participle intent
   ("Reading tool identity", "Listing open PRs"). It is the first thing the model emits, so it
   arrives while arguments are still streaming and the preview can show what the model believes it
   is doing before the call completes.
2. `i` is the only intent channel. Tools NEVER add their own `reason` / `purpose` / `why`
   fields; the journal summary and the transcript preview read `i`.
3. Every tool MUST be versioned: its durable identity is `name@rev`, where `rev` bumps when the
   argument contract or the model-facing projection changes. The identity is recorded on every
   journaled call.
4. Name, version, intent, input, output, diagnostics, and usage are protocol data on the tool-call
   element (0008), never inferred from rendered text or reconstructed after the fact.

## Consequences

- Speculative preview during streaming has something meaningful to render for every tool, with no
  per-tool code (0030).
- Traces can be filtered by `name@rev` and scored per contract; a rendering or schema change never
  silently contaminates an evaluation set.
- Prohibited: unversioned tool registrations; per-tool intent fields; renderers that derive intent
  by parsing arguments.
- Cost accepted: one extra short string per call, generated on every invocation, and a small
  discipline cost for authors to bump `rev` when a contract moves.

## Status in omp

**Implemented.** Primary implementation: `crates/tool/src/lib.rs`. Every native schema receives `i`; durable calls record `ToolIdentity { name, rev }`. The production checkpoint family is a clean revisioned cutover: `checkpoint@3` owns named create/list and `rewind@4` owns explicit token-or-label selection; the former create-only and report-only argument shapes are rejected rather than accepted through aliases. `crates/tools/src/web_search.rs` records the expanded provider/query/deadline contract as `web_search@2` and carries an explicit, redacting `@1` journal lift.

## References

- The Harness Playbook, "The tool surface" — "Contract hygiene: intent and version"
- 0008 (tool call as one streaming element), 0029 (AutoQA consumes `name`/`rev`), 0022
- `crates/tool/src/lib.rs`, `crates/tool/src/incoming.rs`
