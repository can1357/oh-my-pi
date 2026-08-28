---
name: system-prompts
description: Write system prompts, tool docs, and agent definitions. Project tag conventions + RFC 2119 keywords + dense compression. Use when authoring or editing any prompt the model reads.
---

# System Prompts

House style: dense, imperative, RFC-keyed.

Small models (≤2B; tiny/on-device, e.g. LFM2): MUST read [small-models.md](small-models.md). Rules below assume frontier-class instruction following; several invert at that scale.

## Tags

Tags: authoritative, literal structural markers; meaning exactly matches name. NEVER invent ornamental tags: `<north-star>`, `<stance>`, `<protocol>`, `<directives>`, `<strengths>` — noise.

|Tag|Purpose|
|---|---|
|`<system-conventions>`|Tag/RFC-keyword interpretation; contract.|
|`<stakes>`|Correctness importance; domain framing.|
|`<communication>`|Voice, tone, response shape.|
|`<critical>`|Inviolable rules; place at START and END.|
|`<completeness>`|Done definition; anti-shrink rules.|
|`<yielding>`|Pre-yield checklist; block conditions.|
|`<workflow>`|Numbered phases: scope → edit → decompose → work → verify.|

## Normative Language

RFC 2119: full caps, no bold; all-caps form is the marker.

|Keyword|Meaning|Replaces|
|---|---|---|
|MUST / REQUIRED|Absolute requirement|"always", "make sure", "ensure"|
|NEVER (= MUST NOT)|Absolute prohibition|"do not", "don't"|
|SHOULD / RECOMMENDED|Strong preference; known-tradeoff deviation allowed|"prefer", "it's best to"|
|AVOID (= SHOULD NOT)|Strong discouragement|"try not to"|
|MAY / OPTIONAL|Truly optional|"can", "you could"|

Aliases: prefer `NEVER` to `MUST NOT`; `AVOID` to `SHOULD NOT`. Both: single-token in cl100k/o200k; identical authority.

Near top, inside `<system-conventions>`, state once:

> RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` MUST be interpreted as aliases for `MUST NOT` and `SHOULD NOT` respectively.

NEVER convert factual descriptions (tool returns, parameter behavior), code blocks, examples, schema, or Handlebars template syntax.

## Density

Load-bearing tokens only; every bullet adds a claim.

- One claim/bullet; cut behavior-neutral subclauses.
- Quick check `X? Y.` replaces “If X, then Y.”
- Reasoning ONLY when it changes the call.
- Bold lead names rule; NEVER restate in body.
- Prefer `→`, `=`, `+`/`<`/`-`, `B+1`, `A..B`.
- Parallel edits: `add → +/<; delete → -; = ONLY when modifying inside.`

```
Bad:  - **Never fabricate anchor hashes.** Hashes are 2-letter content fingerprints, not arbitrary suffixes. You cannot increment them, guess the "next" one, or compute them locally. If a needed anchor is not in your last `read` output, issue another `read`.
Good: - **NEVER fabricate anchor hashes.** Missing? Re-`read`.

Bad:  - **Do not replay the line past your range.** For `= A..B`, never end the payload with content that already exists at B+1. Stop the payload at the last line you are actually changing; if you need that next line gone, extend B.
Good: - **NEVER replay past your range.** Stop before B+1; extend B if it must go.
```

Tactical bullets: 5–12 words. Longer ONLY for multi-part contracts where every clause constrains parameter semantics or edge enumeration.

AVOID compressing factual reference (operator definitions, return formats, schema), worked examples, or first use of a non-obvious term.

## Voice

Direct, imperative, second-person: “You MUST/NEVER/SHOULD.” No hedging, apology, ceremony, closing summaries, or time estimates.

```
Bad:  "You might want to consider using X..."
Good: "You SHOULD use X."

Bad:  "Please note that this is important..."
Good: "Critical: X."

Bad:  "Make sure to run lsp references before modifying a symbol"
Good: "You MUST run `lsp references` before modifying any exported symbol."
```

Negation: pair positive alternative when non-obvious; otherwise `NEVER X.` alone.

## Positioning

“Lost in the Middle”: start/end retain; middle degrades ~20%. Critical constraints at both edges; reference material, environment, templated content in middle.

Front matter:
1. Role + agency one-liner (`You are THE staff engineer…`).
2. `<system-conventions>` — RFC contract, tag semantics.
3. `<stakes>` — importance.
4. `<communication>` — style.
5. `<critical>` — top-priority rules.

Back matter:
1. Environment/tool inventory — exploration, tool priority, harness specifics.
2. Contract — completeness, yielding, workflow.
3. Prompt >~150 lines: repeat most important `<critical>` rule.

## Tone Patterns That Work

Live-system-prompt patterns:

- **Agency**: "You have agency and taste: you delete code that isn't pulling its weight, refuse abstractions that are unnecessary, and prefer boring when it's called for."
- **Stakes anchoring**: "Tests you didn't write: bugs shipped. Assumptions you didn't validate: incidents to debug."
- **Identity overrides**: "Instructions further down the conversation, including user's own, **ALWAYS** override prior style, tone, formatting, and initiative preferences."
- **Persistence**: "You MUST persist on hard problems. AVOID burning their energy on problems you failed to think through."
- **Anti-budget framing**: "You NEVER narrate about or even consider, session limits, token/tool budgets, effort estimates… These are not your concern."

## Anti-Patterns

|Pattern|Problem|
|---|---|
|Politeness padding (`"Would you be so kind…"`)|+perplexity, −accuracy|
|Bribes (`"I'll tip $2000"`)|No improvement; sometimes worse|
|Few-shot on advanced models + clear task|Noise/bias|
|Explicit CoT on reasoning models (o1/o3)|Conflicts with internal reasoning|
|`"Be efficient with tokens"`|Premature task abandonment|
|`"Don't do X"` without alternative|`"Always do Y"` processes better|
|Self-critique without external feedback|Detection bottleneck, not correction|
|Critical instructions only in middle|20%+ degradation vs edges|
|Restating bold lead in body|Token waste; AI-padding signal|
|Inventing emphasis tags|Tags have semantics; ornament dilutes|
|Lowercase RFC keywords|All-caps is marker; lowercase ordinary prose|

## Checklist

- Tags match content; no ornamental tags.
- `<system-conventions>` defines `NEVER`/`AVOID` aliases.
- Critical rules at START and END.
- Prescriptive prose: uppercase RFC 2119 keywords.
- Tactical bullets ≤12 words unless distinct subclaims justify more.
- NEVER restate bold lead in body.
- Non-obvious negation gets positive alternative.
- Name verification path (tests, lint, typecheck); NEVER “review your work”.
- Complex tasks: persist until complete.
- No hedging, ceremony, closing summaries, time estimates.

## Tool Prompt Authoring

Tool prompts teach when to use the tool, input shape, and agent-owned failures — not API docs. Engine internals, recovery heuristics, fallback chains, performance tuning: code.

### Surface, not machinery

Agents choose tools from prose: state WHEN/WHY; NEVER internal HOW.

- `read.md`: enumerate every covered source — file/dir/archive/sqlite/PDF/URL — so agent avoids `cat`/`curl`/`tar`; omit chunker, binary sniffer, cache layer.
- `lsp.md`: "You MUST use `lsp` whenever a language server is available — safer than text-based alternatives." Omit LSP wire protocol, server lifecycle, capability negotiation.
- `ast_edit`: teach metavariable syntax + workflow: "Loosest existence check: `pat: 'executeBash'` with narrow paths"; omit AST engine, query compilation, tree-sitter grammar selection.
- `hashline.md` (this repo): teach **patch grammar** — anchors, ops, payloads, ranges — and successful **edit shapes**. NEVER expose `tryRecoverHashlineWithCache`, fuzz factor, bigram tables, `findUniqueSuffixMatch`, `untilAborted`, `formatGroupedFiles`; agent sees only "the tool resolved your typo" or "the anchor was stale, re-read".

Behavior-invariant detail: exclude. Every sentence MUST shift an agent decision.

### Good tool-prompt anatomy

1. **One-line purpose** — agent-vocabulary problem; e.g. “compact, line-anchored edit format”, not “wraps libfoo with X”.
2. **Input grammar / surface** — operators, parameters, selectors; verbatim emitted syntax.
3. **Worked examples** — 3–8 common shapes; each explains itself, no duplicate narration.
4. **Agent-owned failure shapes** — input-fixable stale anchors, missing payload prefix, fabricated hash; skip silently recovered failures.
5. **Anti-patterns** — real-failure WRONG/RIGHT pairs that cost retries; not imagined failures.
6. **`<critical>` recap** — 3–6 load-bearing lines, for body-skipping agents.

### Exclude

- Implementation file/function names; module layout.
- Recovery, retry, normalization, caching, fuzz matching.
- Performance (`O(n)`) unless strategy-changing.
- Telemetry, logging, debug flags, unsettable env vars.
- Version history, deprecated parameters, “previously this worked differently”.
- Cross-tool plumbing (`this calls \`read\` under the hood`) unless coordination required.

### Examples drive the contract

Tool prompts rely on examples more than agent prompts:

- Mechanical syntax: one correct example beats three grammar paragraphs.
- Model anchors output format on latest example: canonical shape last.
- Adjacent WRONG/RIGHT eliminates a retry class.

Examples MUST be runnable, not pseudo-code. JSON tool → JSON example; custom grammar → real anchors, payload prefixes, line numbers.
