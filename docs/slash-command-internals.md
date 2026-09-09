# Slash command internals

This document describes how slash commands are discovered, deduplicated, surfaced in interactive mode, and expanded at prompt time in `coding-agent`.

## Implementation files

- [`src/extensibility/slash-commands.ts`](../packages/coding-agent/src/extensibility/slash-commands.ts)
- [`src/capability/slash-command.ts`](../packages/coding-agent/src/capability/slash-command.ts)
- [`src/discovery/builtin.ts`](../packages/coding-agent/src/discovery/builtin.ts)
- [`src/discovery/omp-plugins.ts`](../packages/coding-agent/src/discovery/omp-plugins.ts)
- [`src/discovery/claude.ts`](../packages/coding-agent/src/discovery/claude.ts)
- [`src/discovery/codex.ts`](../packages/coding-agent/src/discovery/codex.ts)
- [`src/discovery/claude-plugins.ts`](../packages/coding-agent/src/discovery/claude-plugins.ts)
- [`src/discovery/agents.ts`](../packages/coding-agent/src/discovery/agents.ts)
- [`src/discovery/opencode.ts`](../packages/coding-agent/src/discovery/opencode.ts)
- [`src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/slash-commands/acp-builtins.ts`](../packages/coding-agent/src/slash-commands/acp-builtins.ts)
- [`src/slash-commands/available-commands.ts`](../packages/coding-agent/src/slash-commands/available-commands.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`src/modes/utils/ui-helpers.ts`](../packages/coding-agent/src/modes/utils/ui-helpers.ts)

## 1) Discovery model

Slash commands are a capability (`id: "slash-commands"`) keyed by command name (`key: cmd => cmd.name`).

The capability registry loads all registered providers, sorted by provider priority descending, and deduplicates by key with **first wins** semantics.

### Provider precedence

Current slash-command providers and priorities:

1. `native` (OMP) — priority `100`
2. `omp-plugins` (extension packages) — priority `90`
3. `claude` — priority `80`
4. `claude-plugins` — priority `70`
5. `agents` (`.agent`/`.agents` standard dirs) — priority `70`
6. `codex` — priority `70`
7. `opencode` — priority `55`

Tie behavior: equal-priority providers keep registration order. Current import order registers `claude-plugins` before `agents` before `codex`, so plugin commands win over both on name collisions.

### Name-collision behavior

For `slash-commands`, collisions are resolved strictly by capability dedup:

- highest-precedence item is kept in `result.items`
- lower-precedence duplicates remain only in `result.all` and are marked `_shadowed = true`

This applies across providers and also within a provider if it returns duplicate names.

Built-ins are not items in this file capability. They live in the unified built-in registry and are dispatched before session-level extension/custom/file expansion in TUI and ACP/RPC modes. Autocomplete/ACP availability also reserves built-in names and aliases first.

### File scanning behavior

Providers mostly use `loadFilesFromDir(...)`, which currently:

- defaults to non-recursive matching (`*.md`)
- uses native glob with `gitignore: true`, `hidden: false`, `fileType: File`
- reads matching files in parallel and transforms them into `SlashCommand` items

So hidden files/directories are not loaded, ignored paths are skipped, and file order follows native glob result order unless a provider adds its own ordering.

## 2) Provider-specific source paths and local precedence

## `native` provider (`builtin.ts`)

Search roots come from `.omp` directories:

- project: `<cwd>/.omp/commands/*.md`
- user: active profile agent directory `commands/*.md` (`~/.omp/agent/commands/*.md` for the default profile; `~/.omp/profiles/<name>/agent/commands/*.md` for a named profile)

`getConfigDirs()` returns project first, then user, so **project native commands beat user native commands** when names collide.

## `omp-plugins` provider (`omp-plugins.ts`)

Scans `commands/*.md` in configured extension-package roots and enabled npm/link plugins. Root precedence is invocation/CLI, project settings, user settings, then installed plugins. Marketplace roots are excluded here to avoid duplicate discovery and are handled by `claude-plugins`.

## `claude` provider (`claude.ts`)

Loads, subject to `commands.enableClaudeUser` and `commands.enableClaudeProject` settings:

- user: `~/.claude/commands/**/*.md` (recursive)
- project: `<cwd>/.claude/commands/**/*.md` (recursive)

Commands in subdirectories additionally get a namespaced alias: `foo/bar.md` is registered under both `bar` and `foo:bar` (`addClaudeCommandNamespaceAliases`).

The provider pushes user items before project items, so **user Claude commands beat project Claude commands** on same-name collisions inside this provider.

## `codex` provider (`codex.ts`)

Loads:

- user: `~/.codex/commands/*.md`
- project: `<cwd>/.codex/commands/*.md`

Both sides are loaded then flattened in user-first order, so **user Codex commands beat project Codex commands** on collisions.

Codex command content is parsed with frontmatter stripping (`parseFrontmatter`), and command name can be overridden by frontmatter `name`; otherwise filename is used.

## `opencode` provider (`opencode.ts`)

Loads, subject to `commands.enableOpencodeUser` and `commands.enableOpencodeProject` settings:

- user: `~/.config/opencode/commands/*.md`
- project: `<cwd>/.opencode/commands/*.md`

Both sides are loaded then flattened in user-first order, so **user OpenCode commands beat project OpenCode commands** on collisions. OpenCode command content is parsed with frontmatter stripping, and command name can be overridden by frontmatter `name`; otherwise filename is used.

## `claude-plugins` provider (`claude-plugins.ts`)

Loads plugin command roots via `listClaudePluginRoots(...)`, which reads `~/.claude/plugins/installed_plugins.json`, `~/.omp/plugins/installed_plugins.json`, and the nearest project-scoped registry resolved from cwd. For each root it scans `<pluginRoot>/commands/*.md` (the directory can be remapped by plugin config keys `commands`/`slash-commands`), and command names are prefixed with the plugin name: `<plugin>:<command>`.

Across the three registries, roots are merged by precedence rather than sorted: `--plugin-dir` injected roots come first, then project-scoped entries (which shadow user entries for the same plugin id), then user entries, with the OMP registry authoritative over Claude's for the same plugin id. Within each registry, per-plugin entry order from the JSON data is preserved; there is no additional sort step.

## `agents` provider (`agents.ts`)

Scans non-recursive `commands/*.md` under `.agent/` and `.agents/` from cwd up to the repository root, then `~/.agent/commands` and `~/.agents/commands`. Within this provider, the nearest project root is first; `.agent` precedes `.agents`; project entries precede user entries.

## 3) Materialization to runtime `FileSlashCommand`

`loadSlashCommands()` in `src/extensibility/slash-commands.ts` converts capability items into `FileSlashCommand` objects used at prompt time.

For each command:

1. parse frontmatter/body (`parseFrontmatter`)
2. description source:
   - `frontmatter.description` if present
   - else first non-empty body line (max 60 chars with `...`)
3. keep parsed body as executable template content
4. compute a display source string like `via Claude Code Project`

Frontmatter parse severity is level-dependent:

- discovered user/project commands use warning-level parsing with fallback key/value parsing
- a capability item explicitly marked `native` would use fatal parsing
- bundled fallback templates use fatal parsing

### Bundled fallback commands

After filesystem/provider commands, embedded command templates are appended (`EMBEDDED_COMMAND_TEMPLATES`) if their names are not already present.

Current embedded set comes from `src/task/commands.ts` and is used as a fallback (`source: "bundled"`).

## 4) Interactive mode: where command lists come from

Interactive mode combines multiple command sources for autocomplete and command routing.

At construction time it builds a pending command list from:

- built-ins (`BUILTIN_SLASH_COMMANDS`, includes argument completion and inline hints for selected commands)
- extension-registered slash commands (`extensionRunner.getRegisteredCommands(...)`)
- TypeScript custom commands (`session.customCommands`), mapped to slash command labels
- optional skill commands (`/skill:<name>`) when `skills.enableSkillCommands` is enabled

Then `init()` calls `refreshSlashCommandState(...)` to load file-based commands and install one autocomplete provider (`createPromptActionAutocompleteProvider`, a `PromptActionAutocompleteProvider` wrapping a `CombinedAutocompleteProvider`) containing:

- pending commands above
- discovered file-based commands
- discovered prompt-template commands whose names aren't already taken by a built-in/hook/custom/skill/file command

`refreshSlashCommandState(...)` also updates `session.setSlashCommands(...)` so prompt expansion uses the same discovered file command set.

### Refresh lifecycle

Slash command state is refreshed:

- during interactive init
- after `/move` changes working directory (`applyCwdChange` resets capabilities and refreshes against the new cwd)
- when the editor component is swapped
- by explicit plugin reload flows such as `/reload-plugins`

There is no continuous file watcher for command directories.

### Other surfacing

The Extensions dashboard also loads `slash-commands` capability and displays active/shadowed command entries, including `_shadowed` duplicates.

## 5) Routing and prompt-pipeline placement

The unified built-in registry is checked before `AgentSession.prompt(...)` in TUI and ACP/RPC modes. A built-in can consume input or return residual prompt text. TUI-only built-ins are omitted from ACP availability and dispatch; ACP-visible built-ins are the entries with a text-mode `handle`.

After that boundary, `AgentSession.prompt(...)` processes slash input in this order when `expandPromptTemplates !== false`:

1. **Extension commands** (`#tryExecuteExtensionCommand`)  
   If `/name` matches an extension-registered command, its handler executes immediately and prompt returns.
2. **TypeScript custom commands and MCP prompt commands** (`#tryExecuteCustomCommand`)
   A match may return:
   - `string` -> replace prompt text with that string
   - `void/undefined` -> treated as handled; no LLM prompt
3. **File-based slash commands** (`expandSlashCommand`)  
   If text still starts with `/`, attempt markdown command expansion.
4. **Prompt templates** (`expandPromptTemplate`)  
   Applied after slash/custom processing.
5. **Delivery**
   - idle: prompt is sent immediately to agent
   - streaming: prompt is queued as steer/follow-up depending on `streamingBehavior`

This is why built-ins reserve their names before file commands are considered, slash command expansion sits before prompt-template expansion, and custom commands can transform away the leading slash before file-command matching.

## 6) Expansion semantics for file-based slash commands

`expandSlashCommand(text, fileCommands)` behavior:

- only runs when text begins with `/`
- parses command name from first token after `/`
- parses args from remaining text via `parseCommandArgs`
- finds exact name match in loaded `fileCommands`
- if matched, applies:
  - positional replacement: `$1`, `$2`, ...
  - slice replacement: `$@[start]` / `$@[start:length]` using 1-based positions
  - aggregate replacement: `$ARGUMENTS` and `$@`
  - template rendering via `prompt.render` with `{ args, ARGUMENTS, arguments }`
  - inline-argument fallback append when the template did not use an inline argument placeholder

### `parseCommandArgs` caveats

The parser is simple quote-aware splitting:

- supports `'single'` and `"double"` quoting to keep spaces
- strips quote delimiters
- does not implement backslash escaping rules
- unmatched quote is not an error; parser consumes until end

## 7) Unknown `/...` behavior

Unknown slash input is **not rejected** by core slash logic.

If no built-in, extension, custom, or file command handles it, `expandSlashCommand` returns the original text and the literal `/...` prompt proceeds through prompt-template expansion and LLM delivery.

TUI and ACP/RPC dispatch the shared built-in registry before `session.prompt(...)`. A TUI-only built-in is not advertised or handled in ACP, so an otherwise unhandled spelling can still fall through as ordinary prompt text there.

## ACP/RPC availability

`buildAvailableSlashCommands(...)` publishes commands first-wins in this order: text-capable built-ins, optional skill commands, extension commands, TypeScript/MCP custom commands, then discovered file commands. Built-in primary names and aliases are reserved; extension names such as `model:foo`, whose prefix parses as a built-in, are filtered from ACP availability. The same file-command load updates the session expansion set.

## 8) Streaming-time differences vs idle

## Idle path

- `session.prompt("/x ...")` runs command pipeline and either executes command immediately or sends expanded text directly.

## Streaming path (`session.isStreaming === true`)

- `prompt(...)` still runs extension/custom/file/template transforms first
- then requires `streamingBehavior`:
  - `"steer"` -> queue interrupt message (`agent.steer`)
  - `"followUp"` -> queue post-turn message (`agent.followUp`)
- if `streamingBehavior` is omitted, prompt throws an error

### Important command-specific streaming behavior

- Extension commands are executed immediately even during streaming (not queued as text).
- `steer(...)`/`followUp(...)` helper methods reject extension commands (`#throwIfExtensionCommand`) to avoid queuing command text for handlers that must run synchronously.
- Compaction queue replay uses `isKnownSlashCommand(...)` to decide whether queued entries should be replayed via `session.prompt(...)` (for known slash commands) vs raw steer/follow-up methods.

## 9) Error handling and failure surfaces

- Provider load failures are isolated; registry collects warnings and continues with other providers.
- Invalid slash command items (missing name/path/content or invalid level) are dropped by capability validation.
- Frontmatter parse failures:
  - native commands: fatal parse error bubbles
  - non-native commands: warning + fallback key/value parse
- Extension/custom command handler exceptions are caught and reported via extension error channel (or logger fallback for custom commands without extension runner), and treated as handled (no unintended fallback execution).

## 10) Built-in command note: `/pause`

`/pause` is available only in the interactive TUI. It engages a process-global gate for the main agent, in-process subagents, and the advisor. Each agent parks at its next safe boundary: in-flight calls finish, nothing is aborted, and no new work starts until the gate is released.

From the pause screen, press Esc, Enter, Space, or Ctrl+C to resume. Ctrl+C resumes rather than aborting any agent.
