# System Prompt Customization

How the coding agent assembles its system prompt and what users can control with `SYSTEM.md`, `APPEND_SYSTEM.md`, `TITLE_SYSTEM.md`, and the matching CLI flags.

Primary implementation:

- `packages/coding-agent/src/main.ts` (`discoverSystemPromptFile`, `discoverAppendSystemPromptFile`, `applyResolvedSystemPromptInputs`)
- `packages/coding-agent/src/sdk.ts` (`CreateAgentSessionOptions`, prompt construction)
- `packages/coding-agent/src/system-prompt.ts` (`buildSystemPrompt`, `resolvePromptInput`, `loadSystemPromptFiles`)
- `packages/coding-agent/src/prompts/system/system-prompt.md` (unified Runtime/System/Append template)
- `packages/coding-agent/src/prompts/system/project-prompt.md` (Project zone)

## Inputs and precedence

| Input | Source | Effect |
| --- | --- | --- |
| `--system-prompt <text-or-file>` | CLI | Replaces the bundled System zone while preserving Runtime and Project. Highest precedence. |
| `SYSTEM.md` | Discovered config file | Same replacement as the flag; used when the flag is absent. |
| `--append-system-prompt <text-or-file>` | CLI | Appends text after the selected System zone and before Project. Highest append precedence. |
| `APPEND_SYSTEM.md` | Discovered config file | Same append behavior as the flag; used when the flag is absent. |

`SYSTEM.md` and `APPEND_SYSTEM.md` are searched project-first, then user-level. At each scope the config bases are ordered `.omp`, `.claude`, `.codex`, `.gemini`:

1. `<cwd>/.omp/<file>`, `<cwd>/.claude/<file>`, `<cwd>/.codex/<file>`, `<cwd>/.gemini/<file>`
2. `~/.omp/agent/<file>`, `~/.claude/<file>`, `~/.codex/<file>`, `~/.gemini/<file>`

The native user path follows the active profile: with `omp --profile work`, `~/.omp/agent` becomes `~/.omp/profiles/work/agent`. `PI_CONFIG_DIR` changes the native config-directory name. This shared config lookup does not use `PI_CODING_AGENT_DIR` as an arbitrary replacement base.

Discovery does **not** walk ancestors. Starting OMP in `<repo>/packages/api` does not discover `<repo>/.omp/SYSTEM.md`; launch from `<repo>`, put the file under the current directory's config base, or use a user-level file. See [Configuration usage](./config-usage.md) for the shared config-directory contract.

A flag wins over every discovered file. For each filename, project scope wins over user scope and the first config base in the order above wins within that scope.

### Text or file resolution

For a single-line value, OMP first tries to read that value as a file path. If reading fails because the path does not exist (or is too long to be a path), the value is used literally. A value containing a newline is used literally without a file read. Other file-read failures are logged and the original value is still used literally.

## What `SYSTEM.md` replaces

`SYSTEM.md` does not become a raw, sole system message. The CLI stores it as `CreateAgentSessionOptions.customSystemPrompt`; the unified `system-prompt.md` template replaces only its System zone while preserving Runtime.

`buildSystemPrompt` assembles four ordered zones:

1. **Runtime** — conventions, tools, tool policy, skills, rules, MCP/internal protocols, and tool-specific safety. Harness-owned and always preserved.
2. **System** — role, personality, behavior, workflow, and delivery contract. The bundled default is replaced as a unit by a custom prompt.
3. **Append** — optional user text appended after the selected default/custom System.
4. **Project** — workstation, context files, directory rules, workspace tree, and repository context. Dynamically rendered and always preserved.

`system-prompt.md` is the unified Runtime/System/Append template. Its `{{#if customPrompt}}` branch selects custom text; the `{{else}}` branch renders the bundled System behavior. `project-prompt.md` renders the Project zone as a subsequent provider-facing block.

The current date and working directory no longer live in the Project zone: they are emitted as a `<system-reminder>` block on the first user turn of each provider request (`date-cwd-reminder.md`). Keeping per-request bytes out of the system prompt lets open-weight providers (DeepSeek, Qwen, GLM, …) that render tool schemas after the system content keep their prefix cache, and lets a session crossing midnight refresh the date without rebuilding the prompt (#7404).

Consequences:

- `SYSTEM.md` replaces default model behavior, not harness capabilities.
- Tool inventory, tool policy, skills, rules, MCP protocols, and tool-specific safety remain available with custom prompts.
- `APPEND_SYSTEM.md` follows the selected System zone and appears exactly once.
- Project/environment context remains after default, custom, and append content.
- Subagent prompts use the same custom-System path, replacing the main-agent role/workflow without losing Runtime or Project.

When a CLI flag or discovered `SYSTEM.md` provides custom text, `applyResolvedSystemPromptInputs` sets `options.customSystemPrompt`. `buildSystemPrompt` consumes only that caller-supplied text and never walks `SYSTEM.md` itself.

## Plain-text contract

`SYSTEM.md`, `APPEND_SYSTEM.md`, `--system-prompt`, and `--append-system-prompt` are plain text. They are values inserted into bundled Handlebars templates; their contents are not recursively compiled as Handlebars.

The bundled prompt uses Handlebars, but user-provided strings are not compiled with that renderer. A `{{value}}` reference does not recursively render its substituted contents; the value is emitted verbatim:

```handlebars
{{#if customPrompt}}
{{customPrompt}}
{{/if}}
```

For example, if `SYSTEM.md` contains:

```handlebars
Working in
{{cwd}}
on
{{date}}.
{{#if hasMemoryRoot}}Memory enabled.{{/if}}
```

those characters reach the model literally. Internal values such as `cwd`, `skills`, `rules`, and `toolRefs` are private template implementation details, not a user templating API. The calendar date is deliberately not exposed as a template value — it rides the per-request first-turn reminder instead (see above).

## Recipes

### Add rules to the default prompt

Create `APPEND_SYSTEM.md` without a `SYSTEM.md`:

```text
# ~/.omp/agent/APPEND_SYSTEM.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

### Replace model behavior while keeping harness capabilities

Use `SYSTEM.md` (or `--system-prompt`). This replaces the bundled role, personality, workflow, and delivery contract. Runtime still supplies generated tool guidance, skills, rules, MCP/internal protocols, and tool-specific safety; Project still supplies environment and repository context.

```text
# <cwd>/.omp/SYSTEM.md
You are a code reviewer. Read changes, surface concrete issues, and never edit files.
Cite paths with backticks.
```

Use `APPEND_SYSTEM.md` alongside it when a separate final supplement should follow the custom behavior.

### Replace the personality block

The default System zone renders a personality block chosen by the `personality` setting (`default`, `friendly`, `pragmatic`, `none`). A user-level `PERSONALITY.md` replaces the selected preset's text:

```text
# ~/.omp/agent/PERSONALITY.md
Follow ASD-STE100 Simplified Technical English for all responses.
```

Only the agent directory is checked (`~/.omp/agent` by default; profile- and XDG-aware) — there is no project-level or other-config-base lookup. `personality: none` still omits the block entirely (subagents always run with `none`), and an empty or unreadable file falls back to the configured preset with a logged warning. A custom System zone replaces the whole default System, including personality.

### Customize automatic session titles

`SYSTEM.md` and `APPEND_SYSTEM.md` do not affect title-generation calls. Use `TITLE_SYSTEM.md`:

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
If the message has no concrete task, output exactly `none`.
```

`TITLE_SYSTEM.md` uses the same project-first, config-base discovery and no-ancestor-walk behavior. When absent, OMP uses its bundled title prompt. The override is used for both initial automatic titles and replan-driven title refreshes.

Generated title output has an enforced normalization contract even with a
custom prompt. OMP considers only the first trimmed line, strips surrounding
quotes, `<title>...</title>` markers, and terminal punctuation, and treats
`none` or `<title/>` as “no title yet.” A result longer than 80 characters or
12 words is rejected rather than truncated. Empty, deferred, or rejected output
leaves the session unnamed, so a later eligible title attempt can name it.

## Full provider-facing replacement (SDK only)

The normal CLI file/flag path preserves Runtime and Project. SDK code using `CreateAgentSessionOptions.systemPrompt` can replace the complete provider-facing prompt array; CLI customization cannot.

`CreateAgentSessionOptions.systemPrompt` is a different, lower-level API. A string or array replaces the fully rendered default blocks; a callback receives the rendered block array and returns its replacement. This can omit all generated context and safety blocks.

The CLI flags and files do **not** set this property: they set `customSystemPrompt` and `appendSystemPrompt`, which preserve the bundled Runtime and Project zones.

There is no built-in way to inherit selected subsections of the bundled System behavior while replacing the rest. Use Append to retain the complete bundled System, or copy the required behavior into `SYSTEM.md`.

## Discovery and deduplication

When a CLI flag or discovered `SYSTEM.md` provides a custom System zone, `applyResolvedSystemPromptInputs` sets `options.customSystemPrompt`. `buildSystemPrompt` consumes only caller-supplied custom text, so the same or an ancestor `SYSTEM.md` cannot be injected implicitly.

Always-apply rules are deduplicated against the custom prompt, append prompt, and context files.

The exported `loadSystemPromptFiles` helper can walk up to an ancestor config directory, but callers must invoke it explicitly; `buildSystemPrompt` never uses it as a fallback.

## Quick reference

| Goal | Use |
| --- | --- |
| Add instructions while keeping bundled model behavior | `APPEND_SYSTEM.md` or `--append-system-prompt` |
| Replace bundled model behavior while keeping Runtime and Project | `SYSTEM.md` or `--system-prompt` |
| Replace every provider-facing system block | SDK `CreateAgentSessionOptions.systemPrompt` |
| Preserve generated skills, rules, and tool guidance while customizing | `SYSTEM.md`; Runtime remains outside the replaceable System zone |
| Customize automatic session titles | `TITLE_SYSTEM.md` |
| Replace the personality block while keeping the rest of the default System | `PERSONALITY.md` |
| Use `{{cwd}}` or other internal variables in a user file | Not supported; user content is inserted verbatim |
| Inherit selected bundled System subsections | Not supported; use Append or copy the required behavior into `SYSTEM.md` |
| Per-directory override | A supported config base directly under the cwd used to launch OMP |
| Global override | The active native agent directory, or another supported user config base |
