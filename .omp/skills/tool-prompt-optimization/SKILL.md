---
name: tool-prompt-optimization
description: Optimize the description prompts an AI agent reads to learn its built-in tools (the `.md` files under prompts/tools/). Two halves: (1) measure how much of a prompt is already inferable from the tool's JSON parameter schema + name, to prune redundancy with evidence; (2) house authoring rules for what belongs in a tool prompt vs what stays in code. Use when auditing, trimming, writing, or reviewing tool prompts, deciding what schema field descriptions already cover, or testing schema-vs-prompt overlap before deleting prompt lines.
---

# Tool Prompt Optimization

Prompt/schema overlap: content reconstructible from `(name, JSON schema, blank outline)` is a *prune candidate*, never an automatic delete. Probe this overlap for evidence, not vibes: predict the prompt body from those inputs. Reliably recovered lines: candidates; no-model recovery: load-bearing — keep.

## Run probe

`scripts/probe.ts`: `@oh-my-pi/pi-ai` `completeSimple`; production-matching model/auth/provider behavior.

```bash
bun .omp/skills/tool-prompt-optimization/scripts/probe.ts \
  --schema <file|json> --template <file|text> --name <tool_name>
```

- Required: `--schema`, `--template` — file path or inline value.
- No `--model`: panel `fireworks/kimi-k2.7-code`, `anthropic/claude-opus-4-8`, `openai/gpt-5.5` × `--samples` (default 3); requires `FIREWORKS_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.
- `--model p/id,p/id`: override panel. Tune: `--samples N`, `--max-tokens`, `--json`.
- Programmatic: `import { probe } from "./scripts/probe.ts"` → `{ prompt, results: [{ model, samples: [{ text, stopReason, usage, error }] }] }`.

### Builtin shortcut — preferred for this repo

`scripts/probe-builtin.ts` instantiates the live tool; gets exact `toolWireSchema`, `tool.description`, and derived outline:

```bash
bun .omp/skills/tool-prompt-optimization/scripts/probe-builtin.ts --tool <name> [--no-summary] [--show]
```

- `--show`: resolved schema, derived outline, real prompt; exits without API calls. Inspect before spending tokens.
- `--no-summary`: direct summary-line-blank ablation.
- `--samples` / `--model` / `--max-tokens` / `--json`: panel passthrough. Output ends with real prompt for in-place diff.
- Factory-map bypasses settings allowlist: gated `irc`, `github`, … resolve. Construction availability gate (e.g. missing `gh` CLI) → manual inputs.

## Inputs

**Schema:** wire schema the model sees, never hand-sketch. Arktype:

```ts
import { arkToWireSchema } from "@oh-my-pi/pi-ai"; // or toolWireSchema(tool)
JSON.stringify(arkToWireSchema(toolSchema), null, 2);
```

Include `required`, `additionalProperties: false`; omission makes usage appear looser than reality.

**Template:** actual `.md` structure with bodies blanked — one-line summary, then each section tag containing `...`.

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

## Interpret

Bucket each real-prompt line:

- **Prune candidate:** stable across samples **and** models; schema restatement — parameter names/types, `required`, field-description value examples, stated clamp ranges.
- **Keep:** no model recovers it — defaults/direction (`gitignore` default true); routing/escalation (`NEVER` shell out to `find`/`fd` → use this tool; broad exploration → `Task` subagent); exact output shape (mtime sort, grouping, `artifact://` truncation); worked anti-patterns; type-invisible constraints (AST metavariable grammar, C++ trailing `;`).

One sample: noise. Stable cross-sample/model overlap is only a candidate; history must clear it. MUST NOT delete on inferability alone.

## Caveats — before every deletion

- **MUST `git blame` each cut line; read its commit/issue.** Many lines are incident scar tissue: hallucinated flag, shell-out, repo-root scan, fabricated anchor. Keep scar tissue. History distinguishes schema restatement from incident prevention. Inferability necessary, NEVER sufficient.
- **Memorization ≠ inference:** public repos, including this one, may be training data. Repo-specific prediction absent from schema — exact tool names, internal URI schemes, `Task` subagent — is recitation; discount it.
- **Outline leaks:** summary and section names hint. For schema-alone inference, second pass: no summary, generic section tags. Content surviving only the summary is summary-inferable, not schema-inferable.

## Verdict

Predictions usually recover schema-covered parameter mechanics/generic usage, not defaults, output shape, routing, anti-patterns, domain grammar. Prune the former only after per-line `git blame`; keep the latter. Self-documenting flag tools (`find`) prune heavily; DSL/capability tools (`read`, `ast_grep`) barely.

## Tool Prompt Authoring

Tool prompts are not API docs: teach when to choose a tool, input shape, and agent-owned failures. Engine internals, recovery heuristics, fallback chains, performance tuning: code.

### Surface, not machinery

Agents choose from prose, not source: tell WHEN/WHY, NEVER internal HOW.

- `read.md`: every covered source — file/dir/archive/sqlite/PDF/URL — prevents `cat`/`curl`/`tar`; omit chunker, binary sniffer, cache layer.
- `lsp.md`: "You MUST use `lsp` whenever a language server is available — safer than text-based alternatives." Omit LSP wire protocol, server lifecycle, capability negotiation.
- `ast_edit`: metavariable syntax/workflow: "Loosest existence check: `pat: 'executeBash'` with narrow paths"; omit AST engine, query compilation, tree-sitter grammar selection.
- `hashline.md` (this repo): patch grammar — anchors, ops, payloads, ranges — and successful edit shapes. Hide `tryRecoverHashlineWithCache`, fuzz factor, bigram tables, `findUniqueSuffixMatch`, `untilAborted`, `formatGroupedFiles`; agent sees only "the tool resolved your typo" or "the anchor was stale, re-read".

If a detail cannot change agent behavior, it does NOT belong. Each sentence MUST shift an agent decision.

### Good prompt anatomy

1. **One-line purpose:** agent-vocabulary problem; not "wraps libfoo with X", but "compact, line-anchored edit format".
2. **Input grammar/surface:** operators, parameters, selectors; concrete emitted syntax.
3. **Worked examples:** 3–8 common shapes. Example IS explanation; do not narrate twice.
4. **Agent-owned failure shapes:** input-fixable stale anchors, missing payload prefix, fabricated hash; omit silently recovered failures.
5. **Anti-patterns:** real-failure WRONG/RIGHT pairs for retry-causing mistakes, never imagined ones.
6. **`<critical>` recap:** 3–6 load-bearing lines for agents skipping body.

### Exclude

- Implementation file/function names, module layout.
- Recovery, retry, normalization, caching, fuzz matching.
- Performance characteristics such as "this is O(n)", unless strategy-changing.
- Telemetry, logging, debug flags, unsettable env vars.
- Version history, deprecated parameters, "previously this worked differently".
- Cross-tool plumbing such as "this calls `read` under the hood", unless coordination required.
