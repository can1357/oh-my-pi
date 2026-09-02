---
title: Context Files and Rules
description: How omp discovers and injects AGENTS.md-style context files, sticky RULES.md files, and rule files with frontmatter.
coverage: A
---

Context files are Markdown instruction files that `omp` discovers automatically before a session starts and injects into the agent's project context. Use them for repository conventions, architecture notes, test and review expectations, and instructions that should travel with a user account or a project. You never have to ask the agent to read `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or similar files — the relevant ones are discovered, loaded, and placed in context when the session begins.

## Native `.omp` files

The native provider is the recommended format for new projects. It reads from your user agent directory and from `.omp/` directories inside a project, and it has the highest discovery priority, so its files win over every other convention at the same scope.

| File | Scope | Behavior |
|---|---|---|
| `~/.omp/agent/AGENTS.md` | User | User-level context for every session unless the `native` provider is disabled. |
| `<ancestor>/.omp/AGENTS.md` | Project | Project context. `omp` walks upward from the current directory to the repository root and uses the **nearest** non-empty `.omp/AGENTS.md`. Farther native project files are not also included. |
| `~/.omp/agent/RULES.md` | User | User-level sticky rule content. Loaded as an always-apply rule, not as a context file. |
| `<ancestor>/.omp/RULES.md` | Project | Project sticky rule content. Same nearest-ancestor walk-up. Loaded as an always-apply rule. |

Two details matter:

- **Walk-up to the repository root.** Discovery starts in the current working directory and climbs through each ancestor up to the repository root, stopping at the first ancestor that has a usable `.omp/` directory. The *nearest* match wins; ancestors above it are not loaded as native context.
- **The `.omp/` directory must be non-empty.** An empty `.omp/` directory is skipped during the walk-up, so the search continues to the next ancestor. An empty `AGENTS.md` or `RULES.md` file contributes nothing.

`~/.omp/agent` is the user base. If `PI_CODING_AGENT_DIR` is set, it relocates that base, so the user files become `$PI_CODING_AGENT_DIR/AGENTS.md` and `$PI_CODING_AGENT_DIR/RULES.md`.

### Monorepo example

```text
repo/
  .omp/
    AGENTS.md
    RULES.md
  packages/api/
    .omp/
      AGENTS.md
```

Starting a session in `repo/packages/api`:

- The native context file is `repo/packages/api/.omp/AGENTS.md` (the nearest one). `repo/.omp/AGENTS.md` is **not** also included.
- The project sticky rule is `repo/packages/api/.omp/RULES.md` if present; otherwise the walk-up continues and `repo/.omp/RULES.md` is used.

Put broad, durable project background in `AGENTS.md`. Reserve `RULES.md` for short, hard requirements that must stay visible across long conversations.

## Other supported context conventions

`omp` also discovers the context and rule files of other agent tools, so existing projects keep working without migration.

| Provider id | Convention path | Scope | Notes |
|---|---|---|---|
| `native` | `.omp/AGENTS.md` | User + project | Recommended `omp` format. User file at `~/.omp/agent/AGENTS.md`; project file is the nearest non-empty `.omp/AGENTS.md` walking up to the repo root. |
| `claude` | `.claude/CLAUDE.md` | User + project | User file `~/.claude/CLAUDE.md`; project file `<cwd>/.claude/CLAUDE.md` only (no ancestor walk-up). |
| `codex` | `.codex/AGENTS.md` | User | User file `~/.codex/AGENTS.md` only. Project-level Codex context comes from a standalone `AGENTS.md` via the `agents-md` provider. |
| `gemini` | `.gemini/GEMINI.md` | User + project | User file `~/.gemini/GEMINI.md`; project file `<cwd>/.gemini/GEMINI.md` only (no ancestor walk-up). |
| `opencode` | `.config/opencode/AGENTS.md` | User | User file `~/.config/opencode/AGENTS.md` only. |
| `github` | `.github/copilot-instructions.md` | User + project | Project file `<cwd>/.github/copilot-instructions.md` only (no ancestor walk-up), plus a user-global `~/.copilot/copilot-instructions.md` (relocate with `COPILOT_HOME`) and an `AGENTS.md` from each `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` entry. |
| `agents` | `.agent/AGENTS.md`, `.agents/AGENTS.md` | User + project | User files from `~/.agent/` and `~/.agents/`; project files discovered while walking up from the current directory to the repository root. |
| `agents-md` | `AGENTS.md` | Project | Standalone `AGENTS.md` files (not inside a config directory), discovered by walking up from the current directory to the repository root (or home when no repo root is known). Files whose parent directory name starts with `.` are ignored — those belong to a config-directory provider instead. |
| `github` | `.github/instructions/**/*.instructions.md` | Project rules | GitHub Copilot / VS Code instruction files become rules. `applyTo: '*'` or `applyTo: '**'` is injected as always-apply context; other `applyTo` globs are listed in the rulebook with their `description` and are readable as `rule://<name>`. |

:::caution
Providers marked "no ancestor walk-up" only look in the current working directory's config directory. If you need ancestor walk-up behavior, use the native `.omp/AGENTS.md` format or a standalone `AGENTS.md`, or launch `omp` from the directory that holds the config directory.
:::

## Load order and shadowing

When two providers describe the *same* scope, the higher-priority provider wins. Provider priorities:

| Priority | Provider id |
|---:|---|
| 100 | `native` |
| 80 | `claude` |
| 70 | `agents`, `codex` |
| 60 | `gemini` |
| 55 | `opencode` |
| 30 | `github` |
| 10 | `agents-md` |

Discovered files are then deduplicated by scope:

- **One user context file** is kept across all providers. Because `native` has the highest priority, `~/.omp/agent/AGENTS.md` shadows every other user-level context file.
- **One project context file per directory depth.** Depth is measured from the current directory: the cwd is depth 0, its parent depth 1, and so on. Config subdirectories of an ancestor (`.claude/`, `.github/`, `.gemini/`, …) count as the same depth as that ancestor.
- **At the same depth, the higher-priority provider shadows the rest.**
- **Across depths, multiple files survive.** In a monorepo, an ancestor `AGENTS.md` and a package-level one are different depths and both load.
- **Byte-identical files are collapsed.** If two surviving files have exactly the same content, only the copy closest to the cwd is kept.

After deduplication, project files are sorted so **farther ancestors appear first** and files **closer to the cwd appear last**. Later files sit nearer the end of the context block, where they are most prominent.

### Worked shadowing example

```text
repo/
  AGENTS.md
  packages/api/
    AGENTS.md
    .github/copilot-instructions.md
```

Starting in `repo/packages/api`:

- `repo/AGENTS.md` is found by `agents-md` at depth 2 and kept.
- `repo/packages/api/AGENTS.md` (`agents-md`, priority 10) and `repo/packages/api/.github/copilot-instructions.md` (`github`, priority 30) both resolve to depth 0. GitHub's higher priority shadows the package-level standalone `AGENTS.md`, so the Copilot file wins at that depth.
- The two kept files are ordered root-first, package-last, so the package file is the more prominent one.
- If you add `repo/packages/api/.omp/AGENTS.md`, `native` (priority 100) wins depth 0 outright, shadowing both lower-priority files.

## Injection behavior

Discovered context files are injected into the opening project prompt as a single `<context>` block, one `<file>` element per surviving file, in the sort order above:

```xml
<context>
You MUST follow the context files below for all tasks:
<file path="/abs/path/to/repo/AGENTS.md">
...root content...
</file>
<file path="/abs/path/to/repo/packages/api/.github/copilot-instructions.md">
...package content...
</file>
</context>
```

The agent sees each file's absolute path and its fully expanded Markdown content (with `@` imports already resolved — see below). Loading is automatic; there is no need to instruct the agent to search for `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or similar files during a session.

Deeper-directory `AGENTS.md` files that were *not* auto-loaded (for example, ones below the current directory) are surfaced separately in a `<dir-context>` block that lists their paths and tells the agent to read them before editing those directories. Those files are pointers, not full injected content.

## `@` imports

Inside any context file, an `@path` token expands inline to the referenced file's content before injection:

```markdown
# Project notes

Read @docs/architecture.md before changing storage code.
Shared release steps live in @../RELEASE.md and personal aliases in @~/.notes/aliases.md.
```

The exact rules:

- **Relative paths resolve from the importing file's own directory**, not the session's working directory.
- **`~/` and `~`** resolve from the user's home directory; absolute paths are used as-is.
- **Tokens inside fenced code blocks and inline code spans are left untouched** — useful when you want to *write about* an `@token` without expanding it.
- **`git@github.com:org/repo.git` and `user@example.com`-style tokens are not treated as imports.** A token only counts when the `@` sits at the start of a line or after a space or tab.
- **Trailing sentence punctuation is trimmed** off the path (`. , ; : ! ? ) ] } " '`), so `@docs/setup.md.` imports `docs/setup.md`.
- **Imports recurse up to five hops.** An imported file may itself contain `@` imports, up to a total depth of five.
- **Cycles are skipped.** A file already pulled into the current expansion tree is not re-expanded, so mutual imports terminate cleanly.
- **A missing or unreadable target leaves the original `@token` text in place** rather than erroring.

## Sticky rules vs normal context

Use a normal context file (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, …) for the bulk of your guidance: repository overview, code style, build and test commands, review expectations, and local conventions. These load into the opening `<context>` block.

Use a top-level **`RULES.md`** for the handful of hard requirements that must stay active even after a long conversation has pushed the opening context far up the transcript:

```markdown
# ~/.omp/agent/RULES.md

Never commit or push unless the user explicitly asks.
Do not edit generated files.
```

`RULES.md` is special:

- It is read **only** at the native locations — `~/.omp/agent/RULES.md` and the nearest `<ancestor>/.omp/RULES.md` from the cwd up to the repo root. A `RULES.md` anywhere else is ignored.
- It is loaded as an **always-apply rule**, not as a context file, so it is re-attached near the current turn and keeps its hold across long sessions.
- It is **always sticky**: frontmatter cannot make it non-sticky. If you want conditional or opt-in behavior, write a normal rule file instead (see below).

Keep `RULES.md` short. Long background belongs in `AGENTS.md`, where it costs context budget only once.

## Rule files

Beyond whole-context files, `omp` discovers individual **rule files** — one Markdown file per rule, with optional YAML frontmatter controlling how the rule is applied. Rule discovery locations:

| Provider id | Project locations | User locations |
|---|---|---|
| `native` | `<cwd>/.omp/rules/*.{md,mdc}` (when the cwd `.omp` directory exists) | `~/.omp/agent/rules/*.{md,mdc}` |
| `agents` | `<ancestor>/.agent/rules/` and `<ancestor>/.agents/rules/`, walking up from cwd to the repo root | `~/.agent/rules/` and `~/.agents/rules/` |
| `cursor` | `<cwd>/.cursor/rules/*.{mdc,md}` | `~/.cursor/rules/*.{mdc,md}` |
| `windsurf` | `<cwd>/.windsurf/rules/*.md` | `~/.codeium/windsurf/memories/global_rules.md` |
| `cline` | Nearest `.clinerules` file or `.clinerules/*.md` directory, searching upward from cwd | — |

The rule name is the filename without its `.md`/`.mdc` extension (except `.clinerules` files, which are named `clinerules`, and the Windsurf global file, named `global_rules`). Top-level `RULES.md` files are synthesized as a rule named `RULES` with `alwaysApply: true` forced.

Rules deduplicate **by name only**: two files with the same rule name are the same logical rule, and the one from the higher-priority provider wins. Provider order is `native` (100), extension package rules (90), `agents` (70), `cursor` (50), `windsurf` (50), `cline` (40), built-in defaults (1).

### Rule frontmatter fields

| Field | Type | Description |
|---|---|---|
| `description` | string | Required for the rulebook. Rendered next to the rule name in the system prompt listing. Without it, the rule is neither listed in the rulebook nor addressable via `rule://` unless it is always-apply or TTSR-triggered. |
| `globs` | string or list of strings | Rendered inline in the rulebook listing (`- <name> (<glob>, ...): <description>`). For TTSR rules, acts as a path gate: the match context must include at least one matching file path. Does not auto-select rulebook rules for the model. |
| `alwaysApply` | boolean | When `true`, the rule's full content is injected directly into the system prompt on every session. `true` only when the frontmatter literally says `alwaysApply: true`; anything else is `false`. |
| `condition` | regex string or list | TTSR trigger: the rule activates when the pattern matches the model's stream. Legacy `ttsr_trigger` is accepted as an alias. A leading `(?i)`, `(?m)`, or `(?s)` inline flag group maps to the equivalent regex flags. |
| `astCondition` | string or list of strings | TTSR trigger using ast-grep structural patterns, matched on edit/write tool streams where the language is inferred from the file path. A rule may set `condition`, `astCondition`, or both. |
| `scope` | string or list | Narrows TTSR matching to specific stream surfaces. Valid tokens: `text`, `thinking`, `tool` (or `toolcall`), and `tool:<name>(<path-glob>)`. Omitting it watches assistant prose (`text`) and all tool arguments (`tool`), but not thinking. |
| `interruptMode` | `never`, `prose-only`, `tool-only`, or `always` | Overrides the global TTSR interrupt mode for this rule. |

Example rule file:

```markdown
---
description: Database migration safety checks
globs: ["db/migrations/*.sql"]
alwaysApply: false
---

Never add a `DROP TABLE` without a matching backup step.
Migrations must be reversible.
```

`scope` accepts either a comma-separated string or a YAML sequence:

```yaml
# Prose and thinking; equivalent forms:
scope: "text, thinking"
```

```yaml
scope: [text, thinking]
```

```yaml
# Only TypeScript source snapshots produced by edit/write:
scope: "tool:edit(*.ts), tool:write(*.ts)"
```

:::caution
Do not write `scope: "text","thinking"` — adjacent quoted scalars are not valid YAML. Put the comma inside one string or use a YAML sequence.
:::

A `condition` value that looks like a file glob is shorthand: it becomes `tool:edit(<glob>)` and `tool:write(<glob>)` scope entries plus a catch-all `.*` condition. `astCondition` values never trigger this shorthand.

Files without valid frontmatter still load as rules with empty metadata and full content body.

### Always-apply vs rulebook vs TTSR

Every discovered rule lands in exactly one of three buckets:

- **TTSR rules** — any rule with a non-empty `condition` or `astCondition`. These stay out of the prompt entirely until the model's own output matches the trigger, then interrupt the stream. TTSR takes priority over the other buckets. See [Stream Rules](/oh-my-pi/features/stream-rules/) for how triggering works.
- **Always-apply rules** — `alwaysApply: true` and not TTSR. Full content is injected into the system prompt; the rule is also re-readable via `rule://<name>`.
- **Rulebook rules** — have a `description`, are not TTSR, and are not always-apply. Listed in the system prompt by name and description; the model reads the full content on demand via `rule://<name>`. Rulebook matching is advisory — the prompt tells the model to read relevant rules, but `globs` do not automatically select them.

A rule with both a trigger condition and `alwaysApply: true` goes to TTSR if the trigger is accepted; otherwise it falls through to always-apply. A rule with both `alwaysApply` and `description` goes to always-apply only, not the rulebook.

Rules that disable specific entries: list rule names under `ttsr.disabledRules` in settings to drop them, or set `ttsr.builtinRules: false` to drop the built-in default rules.

## Disabling discovery providers

Turn a provider off with the `disabledProviders` setting in `~/.omp/agent/config.yml`, a project's `.omp/config.yml`, or a `--config` overlay:

```yaml
# .omp/config.yml
disabledProviders:
  - claude
  - github
```

`disabledProviders` is a **whole-provider switch with one shared id namespace**, used by two unrelated subsystems:

| Id kind | Examples | Effect when listed |
|---|---|---|
| Discovery provider ids | `native`, `claude`, `codex`, `gemini`, `opencode`, `github`, `agents`, `agents-md` | The entire config source is removed — not just its context files, but also any MCP servers, slash commands, skills, hooks, tools, prompts, and settings it would have contributed. |
| Model provider ids | `anthropic`, `openai`, `google`, `groq`, `ollama`, `openrouter` | The model backend is removed from selection even when its credentials are present. See [Providers](/oh-my-pi/models/providers/). |

Ids are exact and the two namespaces do not collide by accident: `google` disables the Google model backend, while `gemini` disables the Gemini CLI discovery files. Disabling a discovery provider is heavier than it looks — disabling `claude`, for instance, also drops Claude-discovered MCP servers, commands, skills, hooks, tools, and settings, not only `CLAUDE.md`.

`disabledProviders` supports **path-scoped** entries, so you can vary provider availability per subtree:

```yaml
disabledProviders:
  - github            # disabled everywhere
  - path: ~/work/legacy-claude
    providers:
      - claude         # disabled only under this directory
```

A scoped entry applies when the cwd equals the configured path or sits beneath it; `~` expands to home. Bare string entries apply everywhere.

:::caution
Higher-precedence settings layers **replace** array settings rather than appending to them. If your global config disables `claude` but a project config sets `disabledProviders: [github]`, then inside that project Claude discovery is re-enabled and only GitHub is disabled. See [Settings](/oh-my-pi/configuration/settings/) for layer precedence and merge rules.
:::

## Troubleshooting

### A file is not loaded

- Native project context must live at `.omp/AGENTS.md`, and the `.omp/` directory must be non-empty; an empty `.omp/` is skipped and the walk-up continues to the next ancestor.
- A standalone `AGENTS.md` is handled by `agents-md`, not `native`.
- `.claude/CLAUDE.md`, `.gemini/GEMINI.md`, and `.github/copilot-instructions.md` are read only from the current working directory's config directory — not from every ancestor.
- `~/.codex/AGENTS.md` and `~/.config/opencode/AGENTS.md` are user-level only and have no project equivalent.
- Empty files contribute nothing for the native and standalone providers.
- A disabled discovery provider contributes nothing — check `disabledProviders` across your global, project, and `--config` layers.

### The wrong file wins

At one user scope or project depth, the higher-priority provider shadows the others (native > claude > agents/codex > gemini > opencode > github > agents-md). To force deterministic behavior, move your guidance into `.omp/AGENTS.md` (native always wins) or disable the competing discovery provider.

### User context disappeared

Only one user-level context file survives, and `~/.omp/agent/AGENTS.md` has the highest priority. If it exists, it shadows user-level `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.config/opencode/AGENTS.md`, `~/.copilot/copilot-instructions.md`, and `~/.agent`/`~/.agents` files. Consolidate user guidance into the native file or remove the native one if you prefer another tool's file.

### A `RULES.md` file is ignored

Only the native `RULES.md` locations are sticky: `~/.omp/agent/RULES.md` and the nearest `<ancestor>/.omp/RULES.md` from cwd to the repo root. A `RULES.md` in any other directory is not a recognized convention and will not be loaded.

### An `@` import did not expand

Confirm the target exists relative to the importing file (not the cwd). Imports inside fenced code blocks or inline code spans are intentionally left literal, `git@`/email-looking tokens are never imported, cycles are skipped, expansion stops after five hops, and a missing target leaves the original `@path` text unchanged.
