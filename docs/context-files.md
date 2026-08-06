# Context files

Context files are Markdown instruction files that `omp` discovers automatically before a session starts and injects into the agent's project context. Use them for repository conventions, architecture notes, test and review expectations, and instructions that should travel with a user account or a project.

You never have to ask the agent to go read `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or similar files — the relevant ones are already discovered, loaded, and placed in context when the session begins.

## How context files relate to other concepts

Four similarly named things behave differently. Keep them straight:

- **Context files** are read as plain Markdown and shown to the agent inside a `<context>` block. They are advisory background that stays in the session's opening context.
- **Sticky rules** come from a top-level `RULES.md`. They are converted into an always-apply rule that is re-attached near the current turn, so they keep their hold even after the visible conversation grows. See "Sticky rules vs normal context" below.
- **Discovery providers** are the config-source adapters (`native`, `claude`, `codex`, `gemini`, `opencode`, `github`, `agents`, `agents-md`) that know where each tool keeps its files. The same provider that contributes context files may also contribute MCP servers, slash commands, skills, hooks, tools, prompts, and settings.
- **Model providers** are inference backends such as `anthropic`, `openai`, `google`, `groq`, `ollama`, and `openrouter`. They have nothing to do with context files except that both kinds of id share the one `disabledProviders` list — see "Disabling discovery providers" below and [Providers](./providers.md).

Authoring **skills** and **rule** files (as opposed to the sticky `RULES.md`) is covered in [Skills](./skills.md). Customizing the system prompt with `SYSTEM.md` is covered in [System prompt customization](./system-prompt-customization.md).

## Native `.ompk` files

The native provider is the recommended format for new projects. It reads from your user agent directory and from `.ompk/` directories inside a project, and it has the highest discovery priority, so its files win over every other convention at the same scope.

| File | Scope | Behavior |
|---|---|---|
| `~/.ompk/agent/AGENTS.md` | User | User-level context for every session unless the `native` provider is disabled. |
| `<ancestor>/.ompk/AGENTS.md` | Project | Project context. `omp` walks upward from the current directory to the repository root and uses the **nearest** non-empty `.ompk/AGENTS.md`. Farther native project files are not also included. |
| `~/.ompk/agent/RULES.md` | User | User-level sticky rule content. Loaded as an always-apply rule, not as a context file. |
| `<ancestor>/.ompk/RULES.md` | Project | Project sticky rule content. Same nearest-ancestor walk-up as above. Loaded as an always-apply rule. |

Two details matter:

- **Walk-up to the repository root.** Discovery starts in the current working directory and climbs through each ancestor up to the repository root, stopping at the first ancestor whose `.ompk/` holds a non-empty copy of the requested file. The *nearest* match wins; ancestors above it are not loaded as native context.
- **The walk-up is per file.** An ancestor `.ompk/` that lacks the requested file — or holds an empty copy — does not stop the walk; the search continues to the next ancestor. `AGENTS.md` and `RULES.md` resolve independently, so a package-level `.ompk/` with only an `AGENTS.md` still falls through to the repo root's `RULES.md`.

`~/.ompk/agent` is the user base. If `PI_CODING_AGENT_DIR` is set, it relocates that base, so the user files become `$PI_CODING_AGENT_DIR/AGENTS.md` and `$PI_CODING_AGENT_DIR/RULES.md`.

### Monorepo example

```text
repo/
  .ompk/
    AGENTS.md
    RULES.md
  packages/api/
    .ompk/
      AGENTS.md
```

Starting a session in `repo/packages/api`:

- The native context file is `repo/packages/api/.ompk/AGENTS.md` (the nearest one). `repo/.ompk/AGENTS.md` is **not** also included.
- The project sticky rule is `repo/packages/api/.ompk/RULES.md` if present; otherwise the walk-up continues and `repo/.ompk/RULES.md` is used.

Put broad, durable project background in `AGENTS.md`. Reserve `RULES.md` for short, hard requirements that must stay visible across long conversations.

## Other supported context conventions

`omp` also discovers the context and rule files of other agent tools so existing projects keep working without migration.

| Provider id | Convention path | Scope | Notes |
|---|---|---|---|
| `native` | `.ompk/AGENTS.md` | User + project | Recommended `omp` format. User file at `~/.ompk/agent/AGENTS.md`; project file is the nearest non-empty `.ompk/AGENTS.md` walking up to the repo root. |
| `claude` | `.claude/CLAUDE.md` | User + project | User file `~/.claude/CLAUDE.md`; project file `<cwd>/.claude/CLAUDE.md` only (no ancestor walk-up). |
| `codex` | `.codex/AGENTS.md` | User | User file `~/.codex/AGENTS.md` only. Project-level Codex context comes from a standalone `AGENTS.md` via the `agents-md` provider, not from `<cwd>/.codex/AGENTS.md`. |
| `gemini` | `.gemini/GEMINI.md` | User + project | User file `~/.gemini/GEMINI.md`; project file `<cwd>/.gemini/GEMINI.md` only (no ancestor walk-up). |
| `opencode` | `.config/opencode/AGENTS.md` | User | User file `~/.config/opencode/AGENTS.md` only. |
| `github` | `.github/copilot-instructions.md` | User + project | Project file `<cwd>/.github/copilot-instructions.md` only (no ancestor walk-up), plus a user-global `~/.copilot/copilot-instructions.md` (relocate with `COPILOT_HOME`) and an `AGENTS.md` from each `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` entry. |
| `agents` | `.agent/AGENTS.md`, `.agents/AGENTS.md` | User + project | User files from `~/.agent/` and `~/.agents/`; project files discovered while walking up from the current directory to the repository root. |
| `agents-md` | `AGENTS.md` | Project | Standalone (non-config-directory) `AGENTS.md` files, discovered by walking up from the current directory to the repository root (or home when no repo root is known). Files whose parent directory name starts with `.` are ignored — those belong to a config-directory provider instead. |
| `github` | `.github/instructions/**/*.instructions.md` | Project rules | GitHub Copilot / VS Code instruction files become rules. `applyTo: '*'` or `applyTo: '**'` is injected as always-apply context; other `applyTo` globs are listed in the rulebook with `description` and are readable as `rule://<name>`. |

Providers marked "(no ancestor walk-up)" only look in the current working directory's config directory. If you need ancestor walk-up behavior, prefer the native `.ompk/AGENTS.md` format or a standalone `AGENTS.md` (the `agents-md` provider), or launch `omp` from the directory that holds the config directory.

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

- **One user context file** is kept across all providers. Because `native` has the highest priority, `~/.ompk/agent/AGENTS.md` shadows every other user-level context file.
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
- The two kept files are ordered root-first, package-last, so `packages/api`'s file is the more prominent one.
- If you add `repo/packages/api/.ompk/AGENTS.md`, `native` (priority 100) wins depth 0 outright, shadowing both lower-priority files.

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

The agent sees each file's absolute path and its fully expanded Markdown content (with `@` imports already resolved — see below). Loading is automatic — there is no need to instruct the agent to search for `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, or similar files during a session.

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
# ~/.ompk/agent/RULES.md

Never commit or push unless the user explicitly asks.
Do not edit generated files.
```

`RULES.md` is special:

- It is read **only** at the native locations — `~/.ompk/agent/RULES.md` and the nearest `<ancestor>/.ompk/RULES.md` from the cwd up to the repo root. A `RULES.md` anywhere else is not a context-file convention and is ignored.
- It is loaded as an **always-apply rule**, not as a context file, so it is re-attached near the current turn and keeps its hold across long sessions.
- It is **always sticky**: frontmatter cannot make it non-sticky. If you want conditional or opt-in behavior, write a normal rule file instead (see [Skills](./skills.md)).

Keep `RULES.md` short. Long background belongs in `AGENTS.md`, where it costs context budget only once.

## Disabling discovery providers

Turn a provider off with the `disabledProviders` setting in `~/.ompk/agent/config.yml`, a project's `.ompk/config.yml`, or a `--config` overlay:

```yaml
# .ompk/config.yml
disabledProviders:
  - claude
  - github
```

`disabledProviders` is a **whole-provider switch with one shared id namespace**, used by two unrelated subsystems:

| Id kind | Examples | Effect when listed |
|---|---|---|
| Discovery provider ids | `native`, `claude`, `codex`, `gemini`, `opencode`, `github`, `agents`, `agents-md` | The entire config source is removed — not just its context files, but also any MCP servers, slash commands, skills, hooks, tools, prompts, and settings it would have contributed. |
| Model provider ids | `anthropic`, `openai`, `google`, `groq`, `ollama`, `openrouter` | The model backend is removed from selection even when its credentials are present. See [Providers](./providers.md). |

Ids are exact and the two namespaces do not collide by accident: `google` disables the Google model backend, while `gemini` disables the Gemini CLI discovery files. Disabling a discovery provider is heavier than it looks — disabling `claude`, for instance, also drops Claude-discovered MCP servers, commands, skills, hooks, tools, and settings, not only `CLAUDE.md`.

Only `enabledModels` and `disabledProviders` support **path-scoped** entries, so you can vary provider availability per subtree:

```yaml
disabledProviders:
  - github            # disabled everywhere
  - path: ~/work/legacy-claude
    providers:
      - claude         # disabled only under this directory
```

A scoped entry applies when the cwd equals the configured path or sits beneath it; `~` expands to home. Bare string entries apply everywhere.

Remember that higher-precedence settings layers **replace** array settings rather than appending to them. If your global config disables `claude` but a project config sets `disabledProviders: [github]`, then inside that project Claude discovery is re-enabled and only GitHub is disabled. See [Settings](./settings.md) for the full layer precedence, merge rules, and path-scoped array details.

## Troubleshooting

### A file is not loaded

- Native project context must live at `.ompk/AGENTS.md` with non-empty content; an ancestor `.ompk/` without a usable `AGENTS.md` is skipped and the walk-up continues to the next ancestor.
- A standalone `AGENTS.md` is handled by `agents-md`, not `native`.
- `.claude/CLAUDE.md`, `.gemini/GEMINI.md`, and `.github/copilot-instructions.md` are read only from the current working directory's config directory — not from every ancestor.
- `~/.codex/AGENTS.md` and `~/.config/opencode/AGENTS.md` are user-level only and have no project equivalent.
- Empty files contribute nothing for the native and standalone providers.
- A disabled discovery provider contributes nothing — check `disabledProviders` across your global, project, and `--config` layers.

### The wrong file wins

At one user scope or project depth, the higher-priority provider shadows the others (native > claude > agents/codex > gemini > opencode > github > agents-md). To force deterministic behavior, move your guidance into `.ompk/AGENTS.md` (native always wins) or disable the competing discovery provider.

### User context disappeared

Only one user-level context file survives, and `~/.ompk/agent/AGENTS.md` has the highest priority. If it exists, it shadows user-level `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.config/opencode/AGENTS.md`, `~/.copilot/copilot-instructions.md`, and `~/.agent`/`~/.agents` files. Consolidate user guidance into the native file or remove the native one if you prefer another tool's file.

### A `RULES.md` file is ignored

Only the native `RULES.md` locations are sticky: `~/.ompk/agent/RULES.md` and the nearest `<ancestor>/.ompk/RULES.md` from cwd to the repo root. A `RULES.md` in any other directory is not a recognized convention and will not be loaded.

### An `@` import did not expand

Confirm the target exists relative to the importing file (not the cwd). Imports inside fenced code blocks or inline code spans are intentionally left literal, `git@`/email-looking tokens are never imported, cycles are skipped, expansion stops after five hops, and a missing target leaves the original `@path` text unchanged.
