# System Prompt Customization

How the coding agent assembles its system prompt and what users can control with `SYSTEM_TEMPLATE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `TITLE_SYSTEM.md`, and CLI flags. Programmatic API options are called out where they expose the same routes or full replacement.

Primary implementation:

- `packages/coding-agent/src/main.ts` (`applyResolvedSystemPromptInputs`)
- `packages/coding-agent/src/sdk.ts` (`CreateAgentSessionOptions`, prompt construction)
- `packages/coding-agent/src/system-prompt.ts` (`discoverSystemPromptOverride`, `buildSystemPrompt`, `BuildSystemPromptOptions`)
- `packages/coding-agent/src/prompts/system/system-prompt.md` (default instruction template)
- `packages/coding-agent/src/prompts/system/custom-system-prompt.md` (plain `SYSTEM.md` template)
- `packages/coding-agent/src/prompts/system/project-prompt.md` (generated project/environment footer)

## Inputs and precedence

| Input                                   | Source                 | Effect                                                                                                                             |
| --------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--system-prompt-template <path>`       | CLI                    | Strictly reads `<path>` as Handlebars source and replaces the bundled default instruction block. Highest custom-prompt precedence. |
| `--system-prompt <text-or-file>`        | CLI                    | Existing plain-text custom route. Highest custom-prompt precedence. Mutually exclusive with the template flag.                     |
| `SYSTEM_TEMPLATE.md`                    | Discovered config file | Raw Handlebars source. Used only when no explicit override and no discovered `SYSTEM.md` is supplied.                              |
| `SYSTEM.md`                             | Discovered config file | Existing plain-text custom route. Used only when no explicit override is supplied.                                                 |
| `--append-system-prompt <text-or-file>` | CLI                    | Adds plain text to the rendered prompt. Highest append precedence.                                                                 |
| `APPEND_SYSTEM.md`                      | Discovered config file | Existing plain-text append route; used when the append flag is absent.                                                             |

**CLI precedence:** An explicit `--system-prompt` or `--system-prompt-template` flag wins over discovered `SYSTEM_TEMPLATE.md` and `SYSTEM.md`; an explicit `--append-system-prompt` wins over discovered `APPEND_SYSTEM.md`. The two custom-prompt flags are mutually exclusive, and supplying both fails clearly. An explicitly supplied empty `--system-prompt` literal still counts as explicit and suppresses custom-prompt discovery.

Programmatic API options use separate contracts, not CLI flags; see [Programmatic API options](#programmatic-api-options).

That empty literal suppresses discovered `SYSTEM.md` and `SYSTEM_TEMPLATE.md`, but does not disable OMP-generated instructions; only the programmatic `CreateAgentSessionOptions.systemPrompt` full-replacement option does that.

Without an explicit custom source, discovery is project-first, then user-level. Within each scope a literal beats a template: project `SYSTEM.md` beats project `SYSTEM_TEMPLATE.md`, which beats user `SYSTEM.md`, which beats user `SYSTEM_TEMPLATE.md`. `SYSTEM.md` is the long-established override, so an existing literal keeps working until its author deliberately removes it in favor of a template. Both filenames resolve through the same capability providers, so ancestor walk-up (repo-root `.omp` from a nested cwd) and `.agent` / `.agents` directories apply to templates exactly as they do to literals. `.claude`, `.codex`, and `.gemini` bases resolve at the launch cwd and user home.

The native user path follows the active profile: with `omp --profile work`, `~/.omp/agent` becomes `~/.omp/profiles/work/agent`. `PI_CONFIG_DIR` changes the native config-directory name. This shared config lookup does not use `PI_CODING_AGENT_DIR` as an arbitrary replacement base. An explicit CLI flag or programmatic API option still wins over every discovered file. See [Configuration usage](./config-usage.md) for the shared config-directory contract.

`--system-prompt-template <path>` is a strict file path: a missing, unreadable, empty, or malformed template is an error, never a literal prompt. Discovered `SYSTEM_TEMPLATE.md` files degrade instead of bricking startup: an empty discovered template is skipped (the discovered literal, if any, already won discovery), and a malformed discovered template without a same-scope literal warns and renders the bundled prompt. A same-scope literal always wins discovery, so a malformed template beside a literal is never rendered. Discovered templates are read once through capability discovery; later runtime rebuilds re-render that in-memory source.

### Text or file resolution

The existing plain-text flags keep their resolution rules. For a single-line `--system-prompt` or `--append-system-prompt` value, OMP first tries to read that value as a file path. If reading fails because the path does not exist (or is too long to be a path), the value is used literally. A value containing a newline is used literally without a file read. Other file-read failures are logged and the original value is still used literally. This fallback does **not** apply to `--system-prompt-template`.

## What plain `SYSTEM.md` replaces

`SYSTEM.md` does not become a raw, sole system message. The CLI stores it as `CreateAgentSessionOptions.customSystemPrompt`, and `buildSystemPrompt` renders `custom-system-prompt.md` instead of the default `system-prompt.md`.

The plain custom template keeps these generated surfaces:

- the custom text and any append text;
- discovered context files;
- discovered skills;
- always-apply rules and the rulebook listing;
- secret-redaction guidance when enabled.

The separate project/environment footer remains and carries workstation data, deeper-directory context pointers, optional workspace information, and the final completion requirements. Optional extra system blocks, such as computer-tool safety and active nested-repository context, also remain when applicable. Provider-callable tool schemas are still generated by the provider-facing session.

What disappears is the content unique to the default instruction template: its built-in role/personality text, tool inventory and general tool policy, internal-URL catalog, exploration/delegation/workflow rules, and `xd://` protocol guidance. Generated skills and rules are **not** lost; the bundled plain custom template renders them explicitly.

Consequences:

- To add a few instructions while retaining the complete default prompt, use only `APPEND_SYSTEM.md` or `--append-system-prompt`.
- To replace the default instruction template while retaining the bundled plain-custom generated sections, use `SYSTEM.md` or `--system-prompt`.
- If a plain custom prompt still needs the default tool policy or workflow, copy and maintain the required guidance yourself; selective inheritance from `system-prompt.md` is not supported.

### Append placement

Without `SYSTEM.md` or `SYSTEM_TEMPLATE.md`, append text is rendered at the end of `project-prompt.md`, after the default instruction block and project/environment content.

With `SYSTEM.md`, append text is rendered immediately after the custom text in `custom-system-prompt.md`. Context, skills, and rules follow it, and the separate project/environment footer follows that block. The templates prevent the append text and context files from being emitted twice.

With `SYSTEM_TEMPLATE.md` (or `--system-prompt-template`), append text remains generated by the normal project/footer route; the raw template controls block 0 and does not receive an implicit copy of the append text.

OMP-generated append content (for enabled memory/auto-learn features and MCP guidance) is combined before the user-supplied append text.
Those generated blocks can end with `## MCP Server Instructions`, whose text declares
itself server-controlled and unverified. Whenever a generated block precedes the
user-supplied text, the text is rendered under its own `## User Instructions` heading
so it cannot read as a trailing paragraph of a server-owned section. On its own — no
generated block — the append text is emitted unchanged, without a heading.

## Inputs by session type

Which automatic inputs reach each kind of session. An input applies only when it exists or is enabled, and Personality means the default template's personality block. Advisors build a dedicated prompt that also carries memory instructions and the shared and per-advisor instructions; `@path` imports in `WATCHDOG.md` are expanded.

| Session type     | `AGENTS.md`   | `CLAUDE.md` / `GEMINI.md` | `APPEND_SYSTEM.md` / `--append-system-prompt` | MCP tools | MCP server instructions | `WATCHDOG.md` | Personality |
| ---------------- | ------------- | ------------------------- | --------------------------------------------- | --------- | ----------------------- | ------------- | ----------- |
| Main session     | Discovered    | Discovered                | Yes                                           | Yes       | Yes                     | No            | Configured  |
| Task subagent    | Not inherited | Inherited                 | No                                            | Inherited | Inherited               | No            | `none`      |
| Advisor/watchdog | Inherited     | Inherited                 | No                                            | No        | No                      | Yes           | None        |

1. Task spawning drops inherited context files whose basename is `agents.md` (case-insensitive). Text pulled in through `@` imports is not filtered, and additional workspace roots are discovered separately.
2. Context discovery selects one user file and one project file per directory depth, and higher-priority providers win. A standalone `CLAUDE.md` is supported; `GEMINI.md` is read from the user and project `.gemini` directories.
3. A task agent's `tools:` list does not remove MCP tools or server instructions: the tools stay available top-level or under `xd://`. Plan-mode tasks and children of restricted sessions run with `restrictToolNames`, which drops both.

## Handlebars template route

`SYSTEM_TEMPLATE.md` and `--system-prompt-template <path>` select raw Handlebars source from a file. Programmatic callers can instead pass raw Handlebars source through `CreateAgentSessionOptions.systemPromptTemplate` or `buildSystemPrompt({ systemPromptTemplate })`; those programmatic options are the template itself, not a path. Each route is rendered instead of the bundled `system-prompt.md` with the same live data and registered helpers as that bundled template.

Generated blocks that are outside block 0 remain normal: the project/environment footer (including generated context and append material), computer safety, active nested-repository context, and provider tool schemas are retained. Data-driven sections that normally live inside the bundled template are not appended by magic. `skills`, `rules`, `alwaysApplyRules`, `toolInventory`, `internalUrls` (one rendered line per internal URL scheme available in the session), `xdevTools`, and `xdevDocs` are available to the template, but each is emitted only if the template references it. In particular, omitting `{{toolInventory}}` or `{{xdevDocs}}` omits that in-block catalog. Mount-notice dedupe follows the rendered output: a template whose block 0 contains an `xd://` reference claims the catalog, one that omits it does not.

The generated project/footer route already renders `contextFiles` and `appendPrompt` once. A template SHOULD NOT render those fields in block 0 unless it intentionally wants duplicate copies.

Use effective session settings and live tool data rather than copying today's rendered prose. `eagerTasks` and `eagerTasksAlways` reflect task settings captured when the session starts, while `xdevDocs`, `toolInventory`, and `toolRefs` reflect mounted devices and tool state whenever the prompt rebuilds. `xdevDocs` also reflects the `tools.xdevDocs` / `tools.xdevInlineDevices` settings used for that rebuild.

The template has the same helper set used by the bundled prompt (`if`, `each`, `unless`, `list`, `when`, `has`, `ifAny`, `includes`, and the other registered helpers). No extra helper is created for a user file. Values inserted into a template are data, not a second template pass: Handlebars-looking text inside `xdevDocs`, context files, tool descriptions, or other values is not recursively rendered.

Treat both sides of this boundary as prompt input. Protect template files like other system-level configuration, and review workspace, extension, MCP, and mounted-device descriptions before treating them as trusted policy; dynamic xdev metadata can be third-party text. The CLI reads a template file once at launch. Programmatic raw source is already in memory. Later runtime prompt rebuilds re-render that in-memory source with current live data and settings, but do not re-read a changed file; restart OMP after editing the file.

## Plain-text and template contracts

`SYSTEM.md`, `APPEND_SYSTEM.md`, `--system-prompt`, and `--append-system-prompt` remain plain text. They are values inserted into bundled Handlebars templates; their contents are not recursively compiled as Handlebars.

For example, if `SYSTEM.md` contains:

```handlebars
Working in
{{cwd}}
on
{{date}}.
{{#if internalUrls.length}}Internal URLs available.{{/if}}
```

those characters reach the model literally. Internal values such as `cwd`, `skills`, `rules`, and `toolRefs` remain private implementation details for the plain route. The calendar date is deliberately not exposed as a template value anymore — it rides the per-request first-turn reminder instead (see above).

Only the opt-in `SYSTEM_TEMPLATE.md` / `--system-prompt-template` / programmatic `CreateAgentSessionOptions.systemPromptTemplate` and `buildSystemPrompt({ systemPromptTemplate })` routes compile Handlebars. A malformed template or an empty template fails clearly; it is never silently downgraded to plain text.

## Recipes

### Add rules to the default prompt

Create `APPEND_SYSTEM.md` without a `SYSTEM.md` or `SYSTEM_TEMPLATE.md`:

```text
# ~/.omp/agent/APPEND_SYSTEM.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

### Supply a custom base prompt

```text
# <cwd>/.omp/SYSTEM.md
You are a code reviewer. Read changes, surface concrete issues, and never edit files.
Cite paths with backticks.
```

OMP still adds the generated context, skills, rules, and project/environment footer, but not the default instruction template's tool and workflow guidance.

### Migrate the bundled prompt

1. Copy `packages/coding-agent/src/prompts/system/system-prompt.md` to `~/.omp/agent/SYSTEM_TEMPLATE.md` or `<cwd>/.omp/SYSTEM_TEMPLATE.md`.
2. Edit the prose while keeping the required Handlebars blocks and live-data placeholders.
3. NEVER copy a rendered `/dump` prompt: it freezes settings, tool catalogs, and mounted-device data.
4. Diff your template against the shipped source path when updating OMP.
5. Remove or rename any same-scope `SYSTEM.md`: a discovered literal beats a discovered template, so the template takes effect only once the literal is gone.

### Supply a Handlebars template

Create `<cwd>/.omp/SYSTEM_TEMPLATE.md` (or pass the same file to `--system-prompt-template`):

```handlebars
# Delegation
{{#if eagerTasksAlways}}
After settling the design, MUST delegate substantial work through `{{toolRefs.task}}`.
{{else}}
{{#if eagerTasks}}
After settling the design, SHOULD delegate substantial work through `{{toolRefs.task}}`.
{{else}}
Delegate only when the request or repository guidance calls for it.
{{/if}}
{{/if}}

# Tools
{{toolInventory}}

{{#if xdevTools.length}}
## xd:// protocol
Write JSON args as `content` to `xd://<tool>` via `{{toolRefs.write}}`.
{{xdevDocs}}
{{/if}}
```

This is a complete, runnable Handlebars Markdown template. It uses only built-in block helpers and live fields. It deliberately references `eagerTasksAlways`, `eagerTasks`, `toolInventory`, `xdevTools`, `toolRefs`, and `xdevDocs`; omitted fields would not be inserted automatically.

### Replace the personality block

The default template renders a personality block chosen by the `personality` setting (`default`, `friendly`, `pragmatic`, `none`). A user-level `PERSONALITY.md` replaces the selected preset's text:

```text
# ~/.omp/agent/PERSONALITY.md
Follow ASD-STE100 Simplified Technical English for all responses.
```

Only the agent directory is checked (`~/.omp/agent` by default; profile- and XDG-aware) — there is no project-level or other-config-base lookup. `personality: none` still omits the block entirely (subagents always run with `none`), and an empty or unreadable file falls back to the configured preset with a logged warning.

### Customize automatic session titles

`SYSTEM.md` and `APPEND_SYSTEM.md` do not affect title-generation calls. Use `TITLE_SYSTEM.md`:

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
If the message has no concrete task, output exactly `none`.
```

`TITLE_SYSTEM.md` uses the same project-first, config-base discovery and no-ancestor-walk behavior. When absent, OMP uses its bundled title prompt. The override is used for both initial automatic titles and replan-driven title refreshes.

Generated title output has an enforced normalization contract even with a custom prompt. OMP considers only the first trimmed line, strips surrounding quotes, `<title>...</title>` markers, and terminal punctuation, and treats `none` or `<title/>` as “no title yet.” A result longer than 80 characters or 12 words is rejected rather than truncated. Empty, deferred, or rejected output leaves the session unnamed, so a later eligible title attempt can name it.

## Programmatic API options

Programmatic API callers use separate options, not CLI flags: `CreateAgentSessionOptions.systemPromptTemplate` and `buildSystemPrompt({ systemPromptTemplate })` take raw Handlebars source; `CreateAgentSessionOptions.customSystemPrompt` is already-loaded literal text, while `buildSystemPrompt`'s `customPrompt` is plain text with path-or-literal resolution (or `resolvedCustomPrompt` is already-loaded text).

A template source and literal custom prompt cannot be combined: `systemPromptTemplate` conflicts with `customSystemPrompt` in `CreateAgentSessionOptions`, and with `customPrompt` / `resolvedCustomPrompt` in `buildSystemPrompt`. These combinations fail clearly instead of silently choosing one.

## Full provider-facing replacement (programmatic API only)

`CreateAgentSessionOptions.systemPrompt` is a different, lower-level programmatic API. A fixed string or array—including an empty string or array—replaces every OMP-generated block and bypasses discovery/rendering of an unused system-prompt template. It does not bypass option validation: defining both `systemPromptTemplate` and `customSystemPrompt` is rejected even when either value is empty or `systemPrompt` is a fixed replacement. A callback instead receives the generated block array after normal template/custom assembly and returns its replacement; normal template discovery and errors apply to that route. Either form can omit all generated context and safety blocks.

`CreateAgentSessionOptions.systemPromptTemplate` is the compositional programmatic API described above: it accepts raw Handlebars source, replaces block 0, and keeps the OMP-generated footer, context/append route, safety blocks, active-repository context, and provider tool schemas. It is mutually exclusive with `customSystemPrompt`. The exported `buildSystemPrompt({ systemPromptTemplate })` option has the same raw-text contract and conflict behavior; its `customPrompt` option remains plain text with path-or-literal resolution.

The CLI flags and files do **not** set `systemPrompt`: they select the plain/template custom route and append route, which continue through the OMP-generated blocks described above.

## Quick reference

| Goal                                                                       | Use                                                                                                              |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Add instructions while keeping the complete default prompt                 | `APPEND_SYSTEM.md` or `--append-system-prompt`                                                                   |
| Replace the default instruction block with plain text                      | `SYSTEM.md` or `--system-prompt`                                                                                 |
| Replace the default instruction block with Handlebars                      | `SYSTEM_TEMPLATE.md` or `--system-prompt-template <path>`                                                        |
| Supply raw Handlebars through the programmatic API                         | `CreateAgentSessionOptions.systemPromptTemplate` or `buildSystemPrompt({ systemPromptTemplate })`                |
| Replace every provider-facing system block                                 | `CreateAgentSessionOptions.systemPrompt`                                                                         |
| Customize automatic session titles                                         | `TITLE_SYSTEM.md`                                                                                                |
| Replace the personality block while keeping the rest of the default prompt | `PERSONALITY.md`                                                                                                 |
| Use `{{cwd}}` or other internal variables in a plain user file             | Not supported; plain user content is inserted verbatim                                                           |
| Include live settings, tool inventory, or xdev docs in a template          | Reference the corresponding Handlebars fields, such as `{{eagerTasks}}`, `{{toolInventory}}`, and `{{xdevDocs}}` |
| Inherit selected default-template sections automatically                   | Not supported; a template must reference the data it needs                                                       |
| Per-directory override                                                     | A supported config base directly under the cwd used to launch OMP                                                |
| Global override                                                            | The active native agent directory, or another supported user config base                                         |
