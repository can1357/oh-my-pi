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

## 11) Built-in command note: `/btw`

`/btw <question>` asks an independent side question using the current session
context. Bare `/btw` opens this session's history, with the newest question selected.
Saved side questions are not appended to the main transcript or sent as history
to unrelated turns. Each new `/btw <question>` remains independent; explicit
follow-ups include only the selected side conversation alongside the current
main-session context.

Previous questions and answers are replayed as separate `user` and `assistant`
messages, followed by the new user question, rather than embedded in one prompt.
The original question template stays in the same position across follow-ups.
History is snapshotted before asynchronous conversion and uses the normal
provider normalization and secret-obfuscation pipeline.

The main prompt-cache key and static system/tool prefix are retained. Each BTW
topic has its own stable provider-side conversation identity, separate from the
main conversation and other topics. Successful serialized follow-ups reuse it;
after a cancelled, failed, or interrupted turn the next request uses a new
transport generation, so an unwinding request cannot share its state.
Standalone ephemeral callers without a conversation key keep per-request IDs.
Actual cache hits depend on the provider. The main-session context is still
current, not frozen at the first question; advancing or compacting it can change
the prefix.
Saved BTW records contain visible answer text, not opaque provider reasoning or
replay signatures, so restoration preserves the dialogue roles and text rather
than a byte-for-byte native provider transcript.

- While an inline BTW is running, `Esc` cancels the request and keeps its partial
  answer visible as `Cancelled`. Press `Esc` again to close the panel.
- In history, `Esc` cancels the selected running topic without closing history;
  otherwise it closes history. If another topic is still running, its inline
  panel is restored rather than leaving it hidden in the background.
- Completed, cancelled, and failed panels close with `Esc`; their history stays
  saved. There is no hide-and-continue action or separate `x` cancellation key.
- `c` copies the completed inline answer, or the selected topic's latest nonempty answer.
- After an inline BTW answer completes, `f` opens that topic's follow-up input
  directly, without requiring `/btw` first. The main editor must be empty and focused.
- In history, `f` or `Enter` opens a native follow-up input for the selected topic.
  Inside the input, `Enter` sends a nonempty question and `Esc` cancels the draft
  and returns to history; `f`, `c`, and `x` are ordinary text.
  Escape also cancels a submitted follow-up while its startup writes are pending,
  without starting a model request. If its initial checkpoint was already underway,
  the turn is saved as cancelled before another follow-up can start.
- Follow-ups append to the same topic, retain prior answers and cancelled partial
  output, and survive resume. The original question remains the history-list title;
  `Details` shows every question and answer in chronological order.
- In history, `Up`/`Down` select topics; `Tab` switches between history and
  details. `Right` focuses details, `Left` returns to history.
- Focused details support scrolling, `Page Up`/`Page Down`, and `Home`/`End`.
  Narrow terminals show one pane at a time.
- New questions and follow-ups are refused while any BTW request is running.
  There is no implicit cancellation or queue.
- A refused follow-up submission keeps the draft for retry; repeated Enter while
  submission is pending cannot create duplicate requests.

History is saved as private per-topic files under the session artifact
directory's `btw-history/` subdirectory. This changes `/btw` from transient-only
display to local retention alongside the session. Even a session containing only
side questions is made resumable. `--no-session` keeps history in memory only.
Ordinary transcript export/share does not include these sidecar records.

Each topic uses an OS-backed cross-process lease and a revision check before an
atomic replacement. Running turns keep their lease until a terminal checkpoint;
another process cannot overwrite a live owner or a stale topic snapshot. A
conflicting follow-up is rejected before any model request, and reopening or
retrying reads the latest saved history. Rejected writes never replace the
committed in-memory view.
Root and follow-up timestamps must be nonnegative and within JavaScript's supported
Date range (at most `8.64e15` milliseconds); invalid records are rejected before
history rendering.

Migration is non-destructive until the destination has been selected and
validated. `/move`, `/wt`, and standalone persistent `!cd` refuse relocation while
a BTW request is starting or running, asking the operator to finish or cancel it explicitly.
For `/move`, the same gate is acquired before confirming or creating a missing
destination directory and remains held through relocation. A busy request or
unsaved checkpoint therefore leaves neither a new directory nor a moved session.
The `/wt` gate is acquired before creating a branch or checkout and remains held
through session relocation and configured source cleanup, so a busy refusal does
not leave an unused worktree.
The `!cd` guard runs before shell execution and remains held through cwd adoption
or rollback, so a refused command cannot leave the shell in a different directory.
Cancelled pickers, invalid destinations, and failed moves retain the BTW conversation.
Successful relocation clears the old view only after moving the saved artifacts.

Resuming from a path, the session picker, or an imported session cancels BTW and
waits for its terminal checkpoint before switching. Confirmed deletion of the
active session uses the same cleanup before detaching and removing its artifacts.
Failed BTW persistence leaves the source session and its artifacts intact.
Declining deletion or deleting an inactive session does not cancel the current BTW.
Extension commands using `context.newSession`, `context.switchSession`, or
`context.branch` also run this cleanup before changing session state or clearing
extension UI. This applies both when extensions initialize and when their command
context is reinitialized.

Session operations wait at most 10 seconds for outstanding BTW persistence.
A timeout stops the operation and leaves the current session in place; it does
not cancel the underlying filesystem write or allow migration/deletion to run
later when that write completes. A failed terminal checkpoint also stops these
operations after its pending promise has settled; the unsaved answer remains
available to view and copy. Retrying the operation retries the retained snapshot
against its original disk revision. Transient I/O failures can recover, but a
conflict never silently rebases over another writer's changes. An initial
checkpoint rejection still prevents model dispatch and can reload history normally.
Visible BTW errors use bounded, single-line text with control sequences removed
and embedded home paths shortened; original errors remain available in diagnostic
logs and exception causes for troubleshooting.

Starting a question saves its running state. Completion, error, and explicit
cancellation save a final checkpoint; cancelled answers retain text already
received. A crash can lose uncheckpointed streaming text, but a saved running
record reopens as `Interrupted` and is never automatically resubmitted.
History remains attached to the session artifacts and follows operations that
copy or remove those artifacts; it does not move the conversation leaf.

The existing inline `b` action promotes a completed single-turn answer to a chat
branch only when the original session/leaf is unchanged and the main session is
idle. Multi-turn side conversations remain in BTW history; promoting only their
latest pair would discard earlier context. History browsing does not promote
answers or relax these branch guards.
