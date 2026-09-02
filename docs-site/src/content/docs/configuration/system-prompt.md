---
title: System Prompt Customization
description: Replacing or appending the system prompt with SYSTEM.md, APPEND_SYSTEM.md, and the matching CLI flags.
coverage: A
---

The system prompt is the model-facing instruction block `omp` sends at the start of every turn. You can append to it or replace its stable instruction block with `SYSTEM.md`, `APPEND_SYSTEM.md`, and the matching CLI flags. Use these for project-wide conventions, code-style reminders, persona swaps, or any instruction that should travel with the project or your account.

## Inputs

Four user-controllable inputs feed prompt assembly. Each one resolves as either a literal string or, if the argument looks like a file path, the contents of that file.

| Input | Source | Effect |
|---|---|---|
| `--system-prompt <text-or-file>` | CLI flag | Replaces the stable default instructions. Highest precedence. |
| `SYSTEM.md` | `<cwd>/.omp/SYSTEM.md`, then `~/.omp/agent/SYSTEM.md` (and equivalent paths under `.claude`, `.codex`, `.gemini`) | Same effect as `--system-prompt`; used when the flag is absent. |
| `--append-system-prompt <text-or-file>` | CLI flag | Adds a prompt block. Without a custom system prompt it goes after all default blocks; with one it goes after the custom block and before the preserved project/environment footer. |
| `APPEND_SYSTEM.md` | Same discovery as `SYSTEM.md` | Same effect as `--append-system-prompt`; used when the flag is absent. |

Precedence (highest first):

1. `--system-prompt`
2. project `SYSTEM.md`
3. user `SYSTEM.md`

For append, the same precedence applies between `--append-system-prompt`, project `APPEND_SYSTEM.md`, and user `APPEND_SYSTEM.md`.

:::caution
Discovery for `SYSTEM.md` and `APPEND_SYSTEM.md` does **not** walk up ancestors. Running `omp` from `<repo>/subdir` does not pick up `<repo>/.omp/SYSTEM.md`; the file must live directly under the cwd's config base or in the user-level location.
:::

## Replace vs append

Normal CLI startup builds the default provider-facing prompt blocks first, then applies CLI or discovered file overrides:

- Providing `--system-prompt` or `SYSTEM.md` replaces only the stable default instructions. The dynamic project/environment footer (workstation info, context files, dir-context list, workspace tree, current date, cwd, and related project context) remains.
- Providing `--append-system-prompt` or `APPEND_SYSTEM.md` without a custom system prompt appends a new block after all default blocks.
- Providing both a custom system prompt and an append prompt produces: custom system prompt block, append prompt block, then the preserved dynamic project/environment footer.

What each mode keeps and loses:

| Mode | Stable default instructions | Skills, rulebook, always-apply rules, tool inventory | Dynamic project/environment footer |
|---|---|---|---|
| No override | Kept | Kept | Kept |
| `APPEND_SYSTEM.md` only | Kept | Kept | Kept (your text is appended after all default blocks) |
| `SYSTEM.md` only | **Replaced** | **Replaced** | Kept |
| Both | **Replaced** | **Replaced** | Kept (after your two blocks) |

Because `SYSTEM.md` replaces the stable default instructions, the generated skills, rulebook summaries, always-apply rules, tool inventory, and the built-in guidance that tells the model when to read `skill://<name>` are not available to the model in a custom system prompt. If you need automatic skills loading, keep the default block and add your customization via `APPEND_SYSTEM.md`. If you fully replace with `SYSTEM.md`, you must hard-code any skill names or instructions you want the model to know about, and those will not track discovery automatically.

## Templating contract

Contents of `SYSTEM.md`, `APPEND_SYSTEM.md`, `--system-prompt`, and `--append-system-prompt` are treated as plain text. They are resolved before prompt-block replacement and are not rendered as Handlebars templates. If your file contains `{{cwd}}`, `{{date}}`, `{{#if hasMemoryRoot}}`, or any other Handlebars expression, those characters appear verbatim in the prompt sent to the model. There is no supported public surface for variables like `cwd`, `date`, `environment`, `workspaceTree`, `skills`, `rules`, `toolRefs`, `hasMemoryRoot`, or `hasObsidian`; they change between releases and are not stable for user configs to depend on.

If a future release exposes a templating surface, it will be opt-in and documented here.

## Worked examples

### Tweak the default — keep default, add a few rules

Use `APPEND_SYSTEM.md` (or `--append-system-prompt`) without `SYSTEM.md`. The stable default instructions and the dynamic project/environment footer stay intact; your text is appended as an additional block.

```text
# ~/.omp/agent/APPEND_SYSTEM.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

### Replace the stable default instructions

Use `SYSTEM.md` (or `--system-prompt`). You replace the stable default instructions, but normal CLI startup still preserves the dynamic project/environment footer.

```text
# ~/.omp/agent/SYSTEM.md
You are a code reviewer. Read diffs, surface issues, never edit files.
- Cite paths with backticks.
- Prefer concrete fixes over abstract advice.
```

If you do this and want default tool guidance, exploration rules, or workflow rules, copy what you need from the bundled `system-prompt.md` template and maintain it yourself. There is no way to inherit selected sections from the stable default instruction block.

### Customize automatic session titles

`SYSTEM.md` and `APPEND_SYSTEM.md` do not affect the model call that names a new session. Use a separate `TITLE_SYSTEM.md` file, discovered with the same project-then-user config-directory pattern:

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
If the message carries no concrete task, output exactly `none`.
```

When `TITLE_SYSTEM.md` is absent, the bundled `title-system.md` and `tiny-title-system.md` prompts are used. The `<title>...</title>` wrapper is preserved in either path.

## Discovery paths

The primary CLI path uses `findConfigFile`, which checks `<cwd>/.omp`, `<cwd>/.claude`, `<cwd>/.codex`, `<cwd>/.gemini`, and the user-level equivalents. It does **not** walk up ancestors. Files in `<ancestor>/.omp/SYSTEM.md` are ignored when `omp` is started from a subdirectory.

Net effect: put `SYSTEM.md` / `APPEND_SYSTEM.md` directly under `<cwd>/.omp` (or another supported config base under cwd) or in the user-level location (`~/.omp/agent/SYSTEM.md` and so on). Ancestor paths are not searched.

:::tip
The discovery bases (`.omp`, `.claude`, `.codex`, `.gemini`) are tried in order. If you keep guidance in a different tool's directory, the `native` `.omp` location wins when both exist.
:::

## Quick reference

| Goal | Use |
|---|---|
| Add an instruction on top of the full default prompt | `APPEND_SYSTEM.md` or `--append-system-prompt` |
| Replace the stable default instructions but keep project/environment context | `SYSTEM.md` or `--system-prompt` |
| Preserve generated skills, rulebook, and tool guidance while customizing | `APPEND_SYSTEM.md`; `SYSTEM.md` replaces that generated block |
| Customize automatic session titles | `TITLE_SYSTEM.md`; chat-turn `SYSTEM.md` / `APPEND_SYSTEM.md` do not affect title generation |
| Use `{{cwd}}` / `{{date}}` / other internals in my file | Not supported. Files are inserted verbatim. |
| Inherit specific sections from the stable default instructions | Not supported; use append, or copy what you need into `SYSTEM.md`. |
| Override at a per-repo level | Project `SYSTEM.md` under the cwd you launch `omp` from |
| Override globally | `~/.omp/agent/SYSTEM.md` or `~/.omp/agent/APPEND_SYSTEM.md` |
