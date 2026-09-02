---
title: Steering the Agent
description: How system prompt customization, context files and rules, skills, magic keywords, stream rules, and budget directives combine to shape agent behavior.
coverage: B
---

omp reads behavior from several independent layers: the system prompt, context files and rules, skills, magic keywords, per-turn budget directives, stream rules, and approval modes. Each layer targets a different scope — one turn, one project, one account, one team — and a different enforcement style, from informational prompt content to enforced runtime gates. This page maps the layers, documents the precedence the sources define, and walks through a workflow for picking the right lever.

## The steering stack

| Layer | What it does | Scope | Where it enters |
|---|---|---|---|
| [System prompt](/oh-my-pi/configuration/system-prompt/) | Replaces or extends the stable instruction block via `--system-prompt` / `SYSTEM.md` / `--append-system-prompt` / `APPEND_SYSTEM.md` | Flag: one process. Files: project or user | Start of every turn |
| [Context files & rules](/oh-my-pi/configuration/context-files/) | `AGENTS.md`-style files injected at session start; `RULES.md` sticky rules; `.omp/rules/*.md` rule files | User + project | Opening context block, system prompt, or live stream monitoring |
| [Skills](/oh-my-pi/extending/skills/) | On-demand capability packs read via `skill://<name>`; `/skill:<name>` commands | User, project, or plugin | System-prompt metadata; model reads content when relevant |
| [Magic keywords](/oh-my-pi/features/magic-keywords/) | `ultrathink`, `orchestrate`, `workflowz` add a hidden instruction for the turn | One turn | Hidden notice in the turn containing the word |
| Budget directives | `+Nk` / `+Nk!` set a per-turn output-token ceiling | One turn | The turn containing the directive |
| [Stream rules](/oh-my-pi/features/stream-rules/) | Rules with a trigger condition watch the model's output and interrupt or remind on a match | User + project | Live monitoring of text, thinking, and tool streams |
| [Approvals](/oh-my-pi/configuration/approvals/) | Allow, deny, or prompt per tool before it runs | Per session or per tool | Before each tool execution |

### System prompt

The default system prompt is a stable instruction block (role, tool inventory, workflow rules) plus a dynamic project/environment footer. Two inputs modify it:

- `--append-system-prompt <text-or-file>` or `APPEND_SYSTEM.md` appends a block after the default instructions. This is the safe way to add guidance without losing anything.
- `--system-prompt <text-or-file>` or `SYSTEM.md` swaps the stable instruction block for your text. The custom template still renders discovered context files, skills, always-apply rules, the rulebook listing, and the project/environment footer, but the default block's role/personality text, tool inventory, internal-URL catalog, and exploration/delegation/workflow guidance are gone. If you want those kept, append instead.

For each filename, precedence is flag > project file > user file. Discovery checks `<cwd>/.omp`, `<cwd>/.claude`, `<cwd>/.codex`, `<cwd>/.gemini`, then the user-level equivalents — it does not walk up ancestors. File contents are plain text; `{{cwd}}`-style expressions are not templated.

### Context files and rules

Context files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, …) are discovered before the session starts and injected into the opening project prompt as a single `<context>` block with one `<file>` element per surviving file. The native `.omp/AGENTS.md` is the recommended format: it has the highest provider priority, and the nearest non-empty `.omp/` directory walking up to the repository root wins. At the same scope, providers shadow each other (native > claude > agents/codex > gemini > opencode > github > agents-md); at different directory depths, multiple files load, ordered farthest-ancestor-first so the file closest to your working directory is the most prominent.

Rule files — one Markdown file per rule with optional frontmatter — land in exactly one of three buckets:

- **Always-apply** (`alwaysApply: true`): full content injected into the system prompt on every session.
- **Rulebook** (a `description`, not always-apply, no trigger): listed in the system prompt by name and description; the model reads the full content on demand via `rule://<name>`. Matching is advisory — globs do not auto-select rules.
- **TTSR** (a `condition` or `astCondition`): stays out of the prompt entirely until the model's own output matches the trigger, then interrupts the stream.

Rules deduplicate by name only, first-wins by provider priority: native > omp-plugins > agents > cursor/windsurf > cline > github > builtin-defaults. A same-named project rule therefore overrides a bundled built-in rule (for example the `ts-no-any` stream rule).

Top-level `RULES.md` (user `~/.omp/agent/RULES.md`, project `<ancestor>/.omp/RULES.md`) is special: it is loaded as an always-apply rule named `RULES` and re-attached near the current turn, so it keeps its hold after a long conversation has pushed the opening context far up the transcript. The user copy shadows the project copy. Keep it short; long background belongs in `AGENTS.md`, which costs context budget only once.

### Skills

A skill is a folder with a `SKILL.md` file. omp exposes discovered skills to the model as name + description metadata in the system prompt; content is fetched on demand through the `read` tool against `skill://<name>`. When skill commands are enabled, every discovered skill also works as a `/skill:<name>` slash command. Skills deduplicate by name with the same provider-priority model as rules. They are capability packs for team or domain knowledge — distinct from context files (persistent instructions) and from slash commands (user-invoked entry points).

### Magic keywords

`ultrathink`, `orchestrate`, and `workflowz` are standalone prose words in your prompt that add a hidden, user-attributed instruction for that turn: careful multi-step reasoning, multi-agent orchestration, or a deterministic multi-subagent workflow. The instruction applies only to the turn containing the keyword. Matching is deliberate — exact lowercase, standalone prose, ignored inside code spans and fenced blocks — so paths and source text do not accidentally trigger behavior. The whole feature and each keyword have `magicKeywords.*` settings switches.

### Stream rules (TTSR)

Stream rules watch the agent's text, thinking, and tool-argument streams as the turn streams. On a regex (`condition`) or structural (`astCondition`) match, the turn is aborted, a `ttsr_triggered` event fires, and a retry is scheduled that appends a hidden reminder (`<system-interrupt>`) telling the model what it violated. Rules with `interruptMode: never` do not abort: tool-stream matches fold a `<system-reminder>` block into the matched tool's result, and prose matches queue a deferred reminder after the message. `ttsr.repeatMode` controls whether a rule can fire again (`once` default, or `after-gap` every `ttsr.repeatGap` turns). omp ships 28 built-in language rules (all `interruptMode: never`, scoped to edit/write streams) that are overridable by same-named rules.

`/omfg <complaint>` forges a TTSR rule from a complaint: it drafts the rule, validates it against the current conversation, saves it under `.omp/rules/` (project) or `~/.omp/agent/rules/` (user), and registers it live. Test and inspect rules with `omp ttsr list`, `omp ttsr test '<snippet>'`, and `omp ttsr scan <dir>`.

### Budget directives

A standalone `+<number>[k|m]` token in your message sets a per-turn output-token budget, for example `+50k`, `+1.5k`, or `+2m`. By default it is **advisory**: the model self-limits using the `budget` helper in [code execution](/oh-my-pi/features/code-execution/) (`budget.remaining()`). Appending `!` (`+500k!`) makes it a **hard ceiling**: eval `agent()` spawns are refused once the turn's spend reaches it. Matching is anchored to token boundaries, so prices and version strings such as `version 1.2.3`, `c++`, or `+500kfoo` do not trigger it. For the eval `budget` helper, the per-turn directive takes precedence over an active [Goal Mode](/oh-my-pi/modes/goal-mode/) budget; with no directive, the goal budget applies, and with neither there is no ceiling. Goal mode's own cap is set with `/goal budget <N|off>` and, when exhausted, switches the session to a `goal-budget-limit` prompt for the remainder.

### Approvals

Approvals are the guardrail layer, not prompt content. Every tool declares a tier (`read`, `write`, `exec`); the active `tools.approvalMode` (`always-ask`, `write`, `yolo`) decides what is auto-approved, with per-tool overrides via `tools.approval.<tool>` (`allow`, `deny`, `prompt`) and per-run flags (`--approval-mode`, `--auto-approve`, `--yolo`). A `deny` blocks the call no matter what the prompt says, which makes this the layer to use when the goal is to stop the agent from doing something rather than to steer how it does it.

## How the layers interact

Rule discovery runs a fixed pipeline: all providers normalize their files into one rule shape, deduplicate by name with first-wins provider precedence, then bucket every surviving rule into TTSR, always-apply, or rulebook — TTSR takes priority over the other buckets, and a rule with both a trigger and `alwaysApply: true` goes to TTSR when the trigger is accepted.

The precedence the sources document:

| Precedence | Order |
|---|---|
| System prompt inputs | `--system-prompt` > project `SYSTEM.md` > user `SYSTEM.md`; same for append |
| Settings layers | Runtime CLI flags/env vars > `--config` overlays (later wins) > project settings > global settings |
| Context files at the same scope | native > claude > agents/codex > gemini > opencode > github > agents-md; nearest directory depth wins; farther depths also load |
| Rule files with the same name | native > omp-plugins > agents > cursor/windsurf > cline > github > builtin-defaults; first wins |
| Rule buckets | TTSR > always-apply/rulebook |
| `RULES.md` | User copy shadows project copy (same rule name `RULES`) |
| Always-apply injection | An always-apply rule whose normalized content already appears in the system/append prompt or a loaded context file is omitted from automatic injection |

Two things follow from the buckets: TTSR is the only layer that actively fires during a turn — it does not depend on the model choosing to follow the prompt — while rulebook rules and context files are informational, and the model reads or follows them at its discretion. If the behavior must never happen, use TTSR, approvals, or a hard budget ceiling; if it is guidance the model should usually follow, use context files, rulebook rules, skills, or an append prompt.

What the sources do **not** rank: there is no documented precedence between different layers — for example between an `APPEND_SYSTEM.md` instruction and an always-apply rule, or between a context file and a skill. Both are simply injected into the prompt; the only cross-layer deduplication is the exact-content omission for always-apply rules above. Do not rely on one layer overriding another; pick the layer whose enforcement style matches the requirement.

## Choosing the right lever

| Goal | Use | Because |
|---|---|---|
| Durable project conventions | `.omp/AGENTS.md` (or another tool's context file) | Injected at session start; native provider wins shadowing |
| Hard requirements that must survive long sessions | `RULES.md` | Always-apply, re-attached near the current turn |
| Domain rules the model should read when relevant | Rulebook rule with a `description` | Listed in the system prompt, read on demand via `rule://` — advisory |
| Stop a recurring mistake | TTSR rule, hand-written or via `/omfg <complaint>` | Fires on the match itself; interrupts or reminds; enforced |
| Team knowledge and playbooks | Skill (`SKILL.md` with a `description`) | Loaded on demand by name and description; also `/skill:<name>` |
| One turn of extra care or delegation | `ultrathink` / `orchestrate` / `workflowz` | Hidden per-turn instruction, no files to maintain |
| Cap a turn's token spend | `+Nk` (advisory) or `+Nk!` (hard) | Per-turn ceiling; the hard variant blocks further eval `agent()` spawns |
| Persona swap or wholesale prompt change | `--system-prompt` / `SYSTEM.md`; small additions: `--append-system-prompt` / `APPEND_SYSTEM.md` | Replaces or extends the stable instruction block |
| Guardrails against destructive tool use | Approvals (`tools.approvalMode`, `tools.approval`, `--approval-mode`) | Enforced before a tool runs, regardless of prompt content |

## A steering workflow

A typical escalation, from one-off correction to enforced rule:

1. **Correct the behavior in the turn.** The agent writes `const x: any = ...` in a new TypeScript file. Tell it once, or add a magic keyword for extra care: `ultrathink about the type boundary here`. The effect ends with the turn.

2. **Forge a rule when it recurs.** Next session the same pattern shows up. Complain once and let `/omfg` draft the rule:

```text
/omfg stop writing `: any` in TypeScript — use unknown or a schema parse
```

   This drafts a TTSR rule from the complaint, validates it against the current conversation, saves it to `.omp/rules/` (project) or `~/.omp/agent/rules/` (user), and registers it live. Verify the trigger before relying on it:

```bash
omp ttsr test 'const x: any = 1'
```

3. **Sharpen the rule.** Edit the generated rule's frontmatter — add `globs` so it only gates `.ts`/`.tsx` files, or set `interruptMode` to control whether it aborts the turn or only reminds. Re-test with `omp ttsr test --rule .omp/rules/<name>.md --source tool --path src/foo.ts 'const x: any = 1'`.

4. **Promote what the team should follow.** The enforced rule stops the violation; a context file or rulebook entry teaches the convention. Put the rationale in `.omp/AGENTS.md` or in a rule with a `description` so the model reads it when the domain applies — and remember a same-named project rule overrides the bundled `ts-no-any` built-in.

5. **Bound long autonomous runs.** For a big migration, cap the turn with `+200k` (advisory) or `+200k!` (hard), and tune approvals so workspace writes run unattended while destructive commands still prompt:

```yaml
tools:
  approvalMode: write
  approval:
    bash: prompt
```

Start at the smallest layer that fixes the problem: a turn-scoped directive first, then a project rule, then team-wide knowledge — and use the enforced layers (TTSR, approvals, hard budgets) only where the behavior must not slip through.

## See also

- [Workflow Recipes](/oh-my-pi/guides/workflow-recipes/)
- [Multi-Agent Workflows](/oh-my-pi/guides/multi-agent/)
- [Internal URLs](/oh-my-pi/guides/internal-urls/) — `rule://` and `skill://` addresses
- [Slash Commands](/oh-my-pi/reference/slash-commands/) — `/omfg` and friends
