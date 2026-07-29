---
name: tool-prompt-optimization
description: Optimize the description prompts an AI agent reads to learn its built-in tools (the `.md` files under prompts/tools/). Two halves: (1) measure how much of a prompt is already inferable from the tool's JSON parameter schema + name, to prune redundancy with evidence; (2) house authoring rules for what belongs in a tool prompt vs what stays in code. Use when auditing, trimming, writing, or reviewing tool prompts, deciding what schema field descriptions already cover, or testing schema-vs-prompt overlap before deleting prompt lines.
---

# Tool Prompt Optimization

A tool's description prompt and its parameter schema overlap. Whatever a model can reconstruct from the **schema + tool name + a blank outline** is a *prune candidate* — the schema may already teach it. This skill measures that overlap so you prune with evidence, not vibes. A candidate is never an automatic delete (see caveats — history first).

Core move: give a model only `(name, JSON schema, outline)` and have it predict the prompt body. Lines it predicts reliably are *prune candidates*. Lines it never recovers are *load-bearing* — keep them.

## Run the probe

`scripts/probe.ts` routes through `@pk-nerdsaver-ai/pi-ai` (`completeSimple`) so model/auth/provider behavior matches production.

```bash
bun .omp/skills/tool-prompt-optimization/scripts/probe.ts \
  --schema <file|json> --template <file|text> --name <tool_name>
```

- `--schema` and `--template` are the only required inputs (file path or inline value).
- No `--model` → 3-model panel (`fireworks/kimi-k2.7-code`, `anthropic/claude-opus-4-8`, `openai/gpt-5.5`) × `--samples` (default 3). Needs `FIREWORKS_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.
- `--model p/id,p/id` overrides the panel; `--samples N`, `--max-tokens`, `--json` tune it.
- Programmatic: `import { probe } from "./scripts/probe.ts"` → `{ prompt, results: [{ model, samples: [{ text, stopReason, usage, error }] }] }`.

### Builtin shortcut (preferred for this repo's tools)

Skip building the two inputs by hand — `scripts/probe-builtin.ts` instantiates the live tool, pulls the EXACT wire schema (`toolWireSchema`) and rendered prompt (`tool.description`), and derives the outline for you:

```bash
bun .omp/skills/tool-prompt-optimization/scripts/probe-builtin.ts --tool <name> [--no-summary] [--show]
```

- `--show` prints the resolved schema + derived outline + real prompt and exits (no API calls) — use it to eyeball inputs before spending tokens.
- `--no-summary` runs the ablation (blank the summary line) directly.
- `--samples` / `--model` / `--max-tokens` / `--json` forward to the panel; output ends with the REAL prompt so you can diff in place.
- It bypasses the settings allowlist via the factory map, so gated tools (`irc`, `github`, …) resolve. If a tool refuses to construct (an availability gate like a missing `gh` CLI), fall back to the manual inputs below.

## Build the two inputs

**Schema** — use the *wire* schema the model actually sees, not a hand-sketch. For this repo's arktype tool schemas:

```ts
import { arkToWireSchema } from "@pk-nerdsaver-ai/pi-ai"; // or toolWireSchema(tool)
JSON.stringify(arkToWireSchema(toolSchema), null, 2);
```

Include `required` and `additionalProperties: false` — omitting them makes the model infer looser usage than the real tool.

**Template (outline)** — the real `.md`'s structure with bodies blanked: the one-line summary, then each section tag with `...` inside.

```
Structural code search via native ast-grep AST matching.

<instruction>
...
</instruction>

<output>
...
</output>

<critical>
...
</critical>
```

## Interpret results

Bucket every line of the real prompt against the predictions:

- **Prune candidate** — content that is STABLE across samples AND agrees across models AND restates the schema (param names, types, "required", value examples already in a field `description`, clamp ranges already stated). The schema teaches it; the prompt repeats it.
- **Keep** — content no model recovers: defaults and their direction (`gitignore` default true), cross-tool routing/escalation ("NEVER shell out to `find`/`fd` → use this tool", "broad exploration → Task subagent"), exact output format (mtime sort, grouping, `artifact://` truncation), worked anti-patterns, and hard constraints invisible to a type (the AST metavariable grammar, C++ trailing `;`).

A single sample is noise. Only treat overlap that is **stable across samples and models** as a prune *candidate* — and a candidate is not a verdict until its history clears (see caveats). You MUST NOT delete a line on inferability alone.

## Caveats — read before deleting anything

- **`git blame` before cutting — MUST, not SHOULD.** Many prompt lines were added on purpose after a real failure: a model that hallucinated a flag, shelled out, scanned the repo root, fabricated an anchor. They look redundant precisely because they now prevent the mistake. You MUST `git blame` (and read the commit/issue) every line you intend to cut; the history tells you whether it restates the schema or is scar tissue from an incident. Keep scar tissue. Inferability is necessary for pruning, NEVER sufficient.
- **Memorization ≠ inference.** Public repos (this one included) may be in training data, so a model can *recite* `ast-grep.md` it never *inferred*. Tell: predictions naming repo-specific details absent from the schema (exact tool names, internal URI schemes, the `Task` subagent) are memorized, not derived — discount them.
- **The outline leaks.** The summary line and section names are themselves hints. To isolate *schema-alone* inferability, run an ablation: a second pass with no summary line and generic section tags. Content that survives only with the summary present is "summary-inferable", not "schema-inferable".

## Verdict pattern

Per tool: predictions reproduce parameter mechanics and generic usage (already in the schema) but miss defaults, output shape, cross-tool routing, anti-patterns, and domain grammar. Prune the first set (after `git blame` clears each line); keep the second. Self-documenting flag tools (e.g. `find`) prune heavily; DSL/capability tools (e.g. `read`, `ast_grep`) barely at all.

## Tool Prompt Authoring

Tool prompts are not API docs. They teach the agent **when to reach for the tool, what shape its inputs take, and which failure modes are the agent's responsibility**. Everything else — engine internals, recovery heuristics, fallback chains, performance tuning — stays in code.

### Describe surface, not machinery

The agent picks tools from prose, not source. Tell it WHEN and WHY; NEVER HOW the tool works internally.

- `read.md` enumerates every source it covers (file/dir/archive/sqlite/PDF/URL) so the agent stops reaching for `cat`/`curl`/`tar`. It does NOT mention the chunker, the binary sniffer, or the cache layer.
- `lsp.md`: "You MUST use `lsp` whenever a language server is available — safer than text-based alternatives." No mention of the LSP wire protocol, server lifecycle, or capability negotiation.
- `ast_edit`: teaches metavariable syntax + workflow ("Loosest existence check: `pat: 'executeBash'` with narrow paths"). Does NOT explain the AST engine, query compilation, or tree-sitter grammar selection.
- `hashline.md` (this repo): teaches the **patch grammar** (anchors, ops, payloads, ranges) and the **edit shapes** that succeed. Hides `tryRecoverHashlineWithCache`, the fuzz factor, the bigram tables, `findUniqueSuffixMatch`, `untilAborted`, `formatGroupedFiles`. The agent never learns those names — it just sees "the tool resolved your typo" or "the anchor was stale, re-read".

If the agent's behavior shouldn't change based on a detail, the detail does NOT belong in the prompt. Each sentence MUST shift a decision the agent makes.

### Anatomy of a good tool prompt

1. **One-line purpose.** What problem it solves, in the agent's vocabulary. Not "wraps libfoo with X" — instead "compact, line-anchored edit format".
2. **Input grammar / surface.** Operators, parameters, selectors. Concrete syntax the agent will emit verbatim.
3. **Worked examples.** 3–8 patterns covering the common shapes. Each example IS the explanation — don't narrate it twice.
4. **Failure shapes the agent owns.** Things the agent can fix by changing its input (stale anchors, missing payload prefix, fabricated hash). Skip failures the engine recovers from silently.
5. **Anti-patterns.** WRONG/RIGHT pairs for the mistakes that cost retries. Drawn from real failures, not imagined ones.
6. **`<critical>` recap.** 3–6 lines of the load-bearing rules, in case the agent skips the body.

### What stays out

- Implementation file names, function names, module layout.
- Recovery, retry, normalization, caching, fuzz matching.
- Performance characteristics ("this is O(n)") unless they change the agent's strategy.
- Telemetry, logging, debug flags, env vars the agent cannot set.
- Version history, deprecated parameters, "previously this worked differently".
- Cross-tool plumbing ("this calls `read` under the hood") unless the agent must coordinate them.
