# Context files

Context files are Markdown instruction files that `omp` discovers automatically before a session starts and injects into the agent's project context. Use them for repository conventions, architecture notes, test and review expectations, and instructions that should travel with a user account or a project.

You never have to ask the agent to go read `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or similar files — the relevant ones are already discovered, loaded, and placed in context when the session begins.

## How context files relate to other concepts

Four similarly named things behave differently. Keep them straight:

- **Context files** are read as plain Markdown and shown to the agent in generated project instructions (inside `<repo-rules>` with the default prompt template). They are session-opening instructions and background for repository work.
- **Sticky rules** come from a top-level native `RULES.md`. They are converted into an always-apply rule that is re-attached near the current turn, so they keep their hold even after the visible conversation grows. See "Sticky rules vs normal context" below.
- **Discovery providers** are the config-source adapters (`native`, `claude`, `codex`, `gemini`, `opencode`, `github`, `agents`, `agents-md`) that know where each tool keeps its files. The same provider that contributes context files may also contribute MCP servers, slash commands, skills, hooks, tools, prompts, and settings.
- **Model providers** are inference backends such as `anthropic`, `openai`, `google`, `groq`, `ollama`, and `openrouter`. They have nothing to do with context files except that both kinds of id share the one `disabledProviders` list — see "Disabling discovery providers" below and [Providers](./providers.md).

Authoring **skills** and **rule** files (as opposed to the sticky `RULES.md`) is covered in [Skills](./skills.md). Customizing the system prompt with `SYSTEM.md` is covered in [System prompt customization](./system-prompt-customization.md).

## Native `.omp` files

The native provider is the recommended format for new projects. It reads from your user agent directory and from `.omp/` directories inside a project, and it has the highest discovery priority, so its files win over every other convention at the same scope.

| File                                          | Scope   | Behavior                                                                                                                                                                                                                                             |
| --------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.omp/agent/AGENTS.md`                      | User    | User-level context for every session unless the `native` provider is disabled.                                                                                                                                                                       |
| `<nearest-non-empty-ancestor>/.omp/AGENTS.md` | Project | Project context, but only when `AGENTS.md` exists in the **nearest non-empty `.omp/` directory** found while walking from cwd toward the repository root. OMP does not continue to a farther `.omp/` directory when the nearest one lacks this file. |
| `~/.omp/agent/RULES.md`                       | User    | User-level sticky rule content. Loaded as an always-apply rule, not as a context file.                                                                                                                                                               |
| `<nearest-non-empty-ancestor>/.omp/RULES.md`  | Project | Project sticky content, but only when `RULES.md` exists in the same nearest non-empty `.omp/` directory selected by the walk.                                                                                                                        |

Two details matter:

- **The nearest non-empty `.omp/` directory owns native project discovery.** Discovery starts in the current working directory and climbs toward the repository root. Once it finds a non-empty `.omp/`, it stops; native `AGENTS.md` and `RULES.md` are each read from that directory only. A missing file does not make discovery continue upward.
- **Empty directories and files contribute nothing.** An empty `.omp/` directory is skipped during the walk. In the selected non-empty directory, an empty `AGENTS.md` or `RULES.md` contributes nothing.

`~/.omp/agent` is shorthand for the active native agent directory. `PI_CODING_AGENT_DIR` relocates it. A named profile (`omp --profile <name>`, `OMP_PROFILE`, or `PI_PROFILE`) uses `~/.omp/profiles/<name>/agent` by default; external-tool user bases such as `~/.claude` are not profile-scoped.

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
- Because `repo/packages/api/.omp/` is the nearest non-empty native directory, project sticky content can only come from `repo/packages/api/.omp/RULES.md`. If that file is absent, `repo/.omp/RULES.md` is **not** used.

Put broad, durable project background in `AGENTS.md`. Reserve `RULES.md` for short, hard requirements that must stay visible across long conversations.

## Other supported context conventions

`omp` also discovers the context and rule files of other agent tools so existing projects keep working without migration.

| Provider id | Convention path                             | Scope          | Notes                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `native`    | `.omp/AGENTS.md`                            | User + project | Recommended OMP format. User file in the active native agent directory; project file is read only from the nearest non-empty `.omp/` directory walking toward the repo root.                                                                                                                                                                                 |
| `claude`    | `.claude/CLAUDE.md`                         | User + project | User file `~/.claude/CLAUDE.md`; project file `<cwd>/.claude/CLAUDE.md` only (no ancestor walk-up).                                                                                                                                                                                                                                                          |
| `codex`     | `.codex/AGENTS.md`                          | User           | User file `~/.codex/AGENTS.md` only. Project-level Codex context comes from a standalone `AGENTS.md` via the `agents-md` provider, not from `<cwd>/.codex/AGENTS.md`.                                                                                                                                                                                        |
| `gemini`    | `.gemini/GEMINI.md`                         | User + project | User file `~/.gemini/GEMINI.md`; project file `<cwd>/.gemini/GEMINI.md` only (no ancestor walk-up).                                                                                                                                                                                                                                                          |
| `opencode`  | `.config/opencode/AGENTS.md`                | User           | User file `~/.config/opencode/AGENTS.md` only.                                                                                                                                                                                                                                                                                                               |
| `github`    | `.github/copilot-instructions.md`           | User + project | Project file `<cwd>/.github/copilot-instructions.md` only (no ancestor walk-up), plus a user-global `~/.copilot/copilot-instructions.md` (relocate with `COPILOT_HOME`). `AGENTS.md` candidates from `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` are also considered at user scope, where normal one-user-file deduplication applies.                                 |
| `agents`    | `.agent/AGENTS.md`, `.agents/AGENTS.md`     | User + project | User files from `~/.agent/` and `~/.agents/`; project files discovered while walking up from the current directory to the repository root.                                                                                                                                                                                                                   |
| `agents-md` | `AGENTS.md`                                 | Project        | Standalone (non-config-directory) `AGENTS.md` files, discovered by walking up from the current directory to the repository root and, when that repository is nested under the user's home directory, through enclosing workspace directories up to but not including the home directory. With no repository root, discovery uses the home directory as the boundary for sessions under home and includes that boundary file. Files whose parent directory name starts with `.` are ignored — those belong to a config-directory provider instead.                                                                   |
| `github`    | `.github/instructions/**/*.instructions.md` | Project rules  | GitHub Copilot / VS Code instruction files become rules. `applyTo: '*'`, `applyTo: '**'`, or `applyTo: '**/*'` is injected as always-apply content; other `applyTo` globs are listed in the rulebook with a generated description when needed and are readable as `rule://<name>`. Missing `applyTo` also produces a rulebook entry and a discovery warning. |

Providers marked "(no ancestor walk-up)" only look in the current working directory's config directory. If you need ancestor walk-up behavior, prefer the native `.omp/AGENTS.md` format or a standalone `AGENTS.md` (the `agents-md` provider), or launch `omp` from the directory that holds the config directory.

## Load order and shadowing

When two providers describe the _same_ scope, the higher-priority provider wins. Provider priorities:

| Priority | Provider id       |
| -------: | ----------------- |
|      100 | `native`          |
|       80 | `claude`          |
|       70 | `agents`, `codex` |
|       60 | `gemini`          |
|       55 | `opencode`        |
|       30 | `github`          |
|       10 | `agents-md`       |

Discovered files are then deduplicated by scope:

- **One user context file** is kept across all providers. Because `native` has the highest priority, `~/.omp/agent/AGENTS.md` shadows every other user-level context file.
- **One project context file per directory depth.** Depth is measured from the current directory: the cwd is depth 0, its parent depth 1, and so on. Config subdirectories of an ancestor (`.claude/`, `.github/`, `.gemini/`, …) count as the same depth as that ancestor.
- **At the same depth, the higher-priority provider shadows the rest.**
- **Across depths, multiple files survive.** In a monorepo, an ancestor `AGENTS.md` and a package-level one are different depths and both load.
- **Byte-identical files are collapsed after ordering.** Among project copies, the one closest to the cwd survives. The single surviving user-scope file sorts after project files, so it survives instead when its content is identical to project content.

Final injection order is **farther project ancestors first**, then project files closer to the cwd, then the surviving user-scope file. Later files sit nearer the end of the generated context and are more prominent.

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
- If you add `repo/packages/api/.omp/AGENTS.md`, `native` (priority 100) wins depth 0 outright, shadowing both lower-priority files.

## Injection behavior

With the default prompt template, discovered context files are injected into the opening project prompt as one `<repo-rules>` block, with one `<file>` element per surviving file in the sort order above:

```xml
<repo-rules>
You MUST follow the context files below for all tasks:
<file path="/abs/path/to/repo/AGENTS.md">
...root content...
</file>
<file path="/abs/path/to/repo/packages/api/.github/copilot-instructions.md">
...package content...
</file>
</repo-rules>
```

When `SYSTEM.md` selects the bundled custom-prompt template, the same files are emitted in that template's `<project>` / `<instructions>` section instead. In either mode, the agent sees each file's absolute path and fully expanded Markdown content (with `@` imports already resolved).

Loading is automatic — there is no need to instruct the agent to search for `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, or similar files during a session.

Deeper-directory `AGENTS.md` files that were _not_ auto-loaded (for example, ones below the current directory) are surfaced separately in a `<dir-context>` block that lists their paths and tells the agent to read them before editing those directories. Those files are pointers, not full injected content.

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
- **Tokens inside fenced code blocks and inline code spans are left untouched** — useful when you want to _write about_ an `@token` without expanding it.
- **`git@github.com:org/repo.git` and `user@example.com`-style tokens are not treated as imports.** A token only counts when the `@` sits at the start of a line or after a space or tab.
- **Trailing sentence punctuation is trimmed** off the path (`. , ; : ! ? ) ] } " '`), so `@docs/setup.md.` imports `docs/setup.md`.
- **Imports recurse up to five hops.** An imported file may itself contain `@` imports, up to a total depth of five.
- **Cycles are skipped.** A file already pulled into the current expansion tree is not re-expanded, so mutual imports terminate cleanly.
- **A missing or unreadable target leaves the original `@token` text in place** rather than erroring.

## Sticky rules vs normal context

Use a normal context file (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, …) for the bulk of your guidance: repository overview, code style, build and test commands, review expectations, and local conventions. These load into the opening generated project context.

Use a top-level **`RULES.md`** for the handful of hard requirements that must stay active even after a long conversation has pushed the opening context far up the transcript:

```markdown
# ~/.omp/agent/RULES.md

Never commit or push unless the user explicitly asks.
Do not edit generated files.
```

`RULES.md` is special:

- It is read **only** at native locations: the active user agent directory and the nearest non-empty project `.omp/` directory selected by the cwd-to-repository-root walk. If that project directory has no `RULES.md`, OMP does not fall back to a farther `.omp/RULES.md`.
- It is loaded as an **always-apply rule**, not as a context file, so it is re-attached near the current turn and keeps its hold across long sessions.
- It is **always sticky**: frontmatter cannot make it non-sticky. If you want conditional or opt-in behavior, write a normal rule file instead (see [Skills](./skills.md)).
- Both top-level candidates are synthesized with the rule name `RULES`, and rule deduplication is name-based. In the usual case, a user `RULES.md` shadows the project `RULES.md`; they are not concatenated. Avoid naming a regular file under `.omp/rules/` or the user `rules/` directory `RULES.md`, because native regular rules load earlier and can shadow both sticky candidates.

Keep `RULES.md` short. Long background belongs in `AGENTS.md`, where it costs context budget only once.

## Disabling discovery providers

Turn a provider off with the `disabledProviders` setting in `~/.omp/agent/config.yml`, a project's `.omp/config.yml`, or a `--config` overlay:

```yaml
# .omp/config.yml
disabledProviders:
  - claude
  - github
```

`disabledProviders` is a **whole-provider switch with one shared id namespace**, used by two unrelated subsystems:

| Id kind                | Examples                                                                           | Effect when listed                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery provider ids | `native`, `claude`, `codex`, `gemini`, `opencode`, `github`, `agents`, `agents-md` | The entire config source is removed — not just its context files, but also any MCP servers, slash commands, skills, hooks, tools, prompts, and settings it would have contributed. |
| Model provider ids     | `anthropic`, `openai`, `google`, `groq`, `ollama`, `openrouter`                    | The model backend is removed from selection even when its credentials are present. See [Providers](./providers.md).                                                                |

Ids are exact and the two namespaces do not collide by accident: `google` disables the Google model backend, while `gemini` disables the Gemini CLI discovery files. Disabling a discovery provider is heavier than it looks — disabling `claude`, for instance, also drops Claude-discovered MCP servers, commands, skills, hooks, tools, and settings, not only `CLAUDE.md`. To drop the context file alone and keep everything else the provider contributes, use [`disabledExtensions`](#disabling-a-single-context-file) instead.

Only `enabledModels` and `disabledProviders` support **path-scoped** entries, so you can vary provider availability per subtree:

```yaml
disabledProviders:
  - github # disabled everywhere
  - path: ~/work/legacy-claude
    providers:
      - claude # disabled only under this directory
```

A scoped entry applies when the cwd equals the configured path or sits beneath it; `~` expands to home. Bare string entries apply everywhere.

Remember that higher-precedence settings layers **replace** array settings rather than appending to them. If your global config disables `claude` but a project config sets `disabledProviders: [github]`, then inside that project Claude discovery is re-enabled and only GitHub is disabled. See [Settings](./settings.md) for the full layer precedence, merge rules, and path-scoped array details.

## Disabling a single context file

`disabledProviders` removes a whole config source. To drop one context file and keep the rest of what its provider contributes, list its extension id in `disabledExtensions`:

```yaml
# ~/.omp/agent/config.yml, .omp/config.yml, or a --config overlay
disabledExtensions:
  - context-file:user:CLAUDE.md
```

Context-file ids have the form `context-file:<level>:<basename>`, where `<level>` is `user` or `project` and `<basename>` is the file name with no directory part:

| Id                                  | Disables                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `context-file:user:CLAUDE.md`       | The user-level `CLAUDE.md`, while Claude's MCP servers, commands, skills, hooks, tools, and settings keep loading. |
| `context-file:project:AGENTS.md`    | **Every** project-level `AGENTS.md`, at each directory depth the walk reaches — the id carries no depth. |
| `context-file:user:AGENTS.md`       | Every user-level file named `AGENTS.md`, whichever provider supplied it.       |

The match is on level and file name only, so one entry covers every provider that contributes a file of that name at that level, and a project entry cannot be narrowed to a single depth. When you need per-directory control, use a project `.omp/config.yml` in the subtree that should differ, or the path-scoped `disabledProviders` form above.

Disabling is not the same as shadowing, and the difference is visible: a disabled file is dropped before deduplication, so it does not claim its scope. **The file it used to shadow is loaded in its place.** In a project holding both `.claude/CLAUDE.md` and `AGENTS.md`, `CLAUDE.md` normally wins the depth-0 scope; disable `context-file:project:CLAUDE.md` and `AGENTS.md` becomes the project context rather than the scope falling empty. To leave the scope with no file at all, disable each candidate name.

Two everyday uses:

- **Non-interactive runs.** A user-level context file written for your own interactive sessions is usually wrong for `-p` runs driven by another program, which arrive with their own instructions. Disabling it in a `--config` overlay keeps your interactive setup untouched.
- **Delegated work.** When one agent drives another, the caller's own operating instructions travel into the callee's prompt as user-level context and can contradict the task it was actually given.

`disabledExtensions` is not path-scoped: only `enabledModels` and `disabledProviders` accept the `path:` form. Like every array setting it is replaced, not merged, by a higher-precedence layer.

Browse the ids interactively with `/extensions`, which lists every discovered context file with its level, source, and current state, and toggles the same setting.

## Troubleshooting

### A file is not loaded

- Native project context is read only from the nearest non-empty `.omp/` directory. That directory must contain a non-empty `AGENTS.md`; if it does not, discovery does not continue to a farther native directory.
- A standalone `AGENTS.md` is handled by `agents-md`, not `native`.
- `.claude/CLAUDE.md`, `.gemini/GEMINI.md`, and `.github/copilot-instructions.md` are read only from the current working directory's config directory — not from every ancestor.
- `~/.codex/AGENTS.md` and `~/.config/opencode/AGENTS.md` are user-level only and have no project equivalent.
- Empty files contribute nothing for the native and standalone providers.
- A disabled discovery provider contributes nothing — check `disabledProviders` across your global, project, and `--config` layers.
- A single file can also be turned off on its own — check `disabledExtensions` for a matching `context-file:<level>:<basename>` entry, and remember that a project entry applies at every depth. `/extensions` shows the file as `disabled` when this is the cause.

### The wrong file wins

At one user scope or project depth, the higher-priority provider shadows the others (native > claude > agents/codex > gemini > opencode > github > agents-md). To force deterministic behavior, move your guidance into `.omp/AGENTS.md` (native always wins) or disable the competing discovery provider.

### User context disappeared

Only one user-level context file survives, and `~/.omp/agent/AGENTS.md` has the highest priority. If it exists, it shadows user-level `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.config/opencode/AGENTS.md`, `~/.copilot/copilot-instructions.md`, and `~/.agent`/`~/.agents` files. Consolidate user guidance into the native file or remove the native one if you prefer another tool's file.

### A `RULES.md` file is ignored

Only native `RULES.md` locations are sticky: the active user agent directory and the nearest non-empty project `.omp/` directory selected from cwd toward the repo root. If a nearer non-empty `.omp/` directory exists, it blocks farther native directories even when it has no `RULES.md`. A `RULES.md` anywhere else is not a recognized convention.

### An `@` import did not expand

Confirm the target exists relative to the importing file (not the cwd). Imports inside fenced code blocks or inline code spans are intentionally left literal, `git@`/email-looking tokens are never imported, cycles are skipped, expansion stops after five hops, and a missing target leaves the original `@path` text unchanged.
