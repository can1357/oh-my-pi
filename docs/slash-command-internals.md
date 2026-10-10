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
- [`src/discovery/omp-extension-roots.ts`](../packages/coding-agent/src/discovery/omp-extension-roots.ts)
- [`src/config/claude-paths.ts`](../packages/coding-agent/src/config/claude-paths.ts)
- [`src/utils/command-args.ts`](../packages/coding-agent/src/utils/command-args.ts)
- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/slash-commands/acp-builtins.ts`](../packages/coding-agent/src/slash-commands/acp-builtins.ts)
- [`src/slash-commands/available-commands.ts`](../packages/coding-agent/src/slash-commands/available-commands.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`src/modes/utils/ui-helpers.ts`](../packages/coding-agent/src/modes/utils/ui-helpers.ts)

## 1) Discovery model

Slash commands are a capability (`id: "slash-commands"`) keyed by command name (`key: cmd => cmd.name`).

The capability registry loads enabled providers in parallel, consumes their results in provider-priority order (descending), and deduplicates by key with **first wins** semantics. `disabledProviders` removes entire providers; `disabledExtensions` entries such as `slash-command:<name>` omit individual commands from normal loads.

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

Foreign user-level sources are opt-in through `enabledProviders` (`claude`, `codex`, `opencode`, or `claude-plugins`; `*`/`all` enables all). Project sources are unaffected by this user opt-in. Claude/OpenCode also retain commands-only user toggles, described below. Setting `CLAUDE_CONFIG_DIR` opts in and relocates Claude's user source.

### Name-collision behavior

For `slash-commands`, collisions are resolved strictly by capability dedup:

- highest-precedence item is kept in `result.items`
- lower-precedence duplicates remain only in `result.all` and are marked `_shadowed = true`

This applies across providers and also within a provider if it returns duplicate names.

Extension-registered handler commands use a separate rule: the last loaded extension registering a name wins, both in the command list and handler lookup. This is not capability deduplication.

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
The default paths above can be relocated by `PI_CONFIG_DIR`, the default-profile `PI_CODING_AGENT_DIR`, or an SDK discovery `agentDir`; the project directory remains `.omp`.

## `omp-plugins` provider (`omp-plugins.ts`)

Scans `commands/*.md` in explicit extension-package directories, the effective `extensions` setting, and enabled npm/link plugins, in that order. The configured array follows settings replacement precedence; project and user arrays are not concatenated. Session-supplied effective roots are reused on reload. Explicit-only discovery omits configured and installed roots, and file entrypoints contribute no subdirectory resources. Marketplace roots are excluded here to avoid duplicate discovery and are handled by `claude-plugins`.

## `claude` provider (`claude.ts`)

The project side is controlled by `commands.enableClaudeProject` (default `true`). The user side loads when Claude is opted in, `CLAUDE_CONFIG_DIR` is set, or `commands.enableClaudeUser` is `true` (default `false`):

- user: `<Claude config dir>/commands/**/*.md` (recursive; defaults to `~/.claude`)
- project: `<cwd>/.claude/commands/**/*.md` (recursive)

Commands in subdirectories additionally get a namespaced alias: `foo/bar.md` is registered under both `bar` and `foo:bar` (`addClaudeCommandNamespaceAliases`).

The provider pushes user items before project items, so **user Claude commands beat project Claude commands** on same-name collisions inside this provider.

## `codex` provider (`codex.ts`)

Loads:

- user: `~/.codex/commands/*.md` (only when `codex` user discovery is opted in)
- project: `<cwd>/.codex/commands/*.md`

Both sides are loaded then flattened in user-first order, so **user Codex commands beat project Codex commands** on collisions.

Codex command content is parsed with frontmatter stripping (`parseFrontmatter`), and command name can be overridden by frontmatter `name`; otherwise filename is used.

## `opencode` provider (`opencode.ts`)

The project side is controlled by `commands.enableOpencodeProject` (default `true`). The user side loads when OpenCode is opted in or `commands.enableOpencodeUser` is `true` (default `false`):

- user: `~/.config/opencode/commands/*.md`
- project: `<cwd>/.opencode/commands/*.md`

Both sides are loaded then flattened in user-first order, so **user OpenCode commands beat project OpenCode commands** on collisions. OpenCode command content is parsed with frontmatter stripping, and command name can be overridden by frontmatter `name`; otherwise filename is used.

## `claude-plugins` provider (`claude-plugins.ts`)

Loads roots via `listClaudePluginRoots(...)`, which reads the active Claude config directory's `plugins/installed_plugins.json`, the active OMP plugins directory's `installed_plugins.json` (profile/XDG-aware), and the nearest project `.omp/plugins/installed_plugins.json`. Claude-origin user roots require `claude` or `claude-plugins` user opt-in; OMP and explicit local roots do not. Disabled registry entries and Claude `enabledPlugins: false` entries are excluded.

For each root it normally scans `<pluginRoot>/commands/*.md`. Manifest `commands`/`slash-commands` entries can instead select directories or individual Markdown files; the first populated key wins. Command names are prefixed with the plugin name when one is present: `<plugin>:<command>`.

Across the three registries, roots are merged by precedence rather than sorted: `--plugin-dir` injected roots come first, then project-scoped entries (which shadow user entries for the same plugin id), then user entries, with the OMP registry authoritative over Claude's for the same plugin id. Within each registry, per-plugin entry order from the JSON data is preserved; there is no additional sort step.

## `agents` provider (`agents.ts`)

Scans non-recursive `commands/*.md` under `.agent/` and `.agents/` from cwd up to the repository root (or home when there is no repository), then `~/.agent/commands` and `~/.agents/commands`. Home is not scanned again as a project root. Under WSL, Windows-host home candidates are appended when discoverable. Within this provider, the nearest project root is first; `.agent` precedes `.agents`; project entries precede user entries.

## 3) Materialization to runtime `FileSlashCommand`

`loadSlashCommands()` in `src/extensibility/slash-commands.ts` converts capability items into `FileSlashCommand` objects used at prompt time.

For each command:

1. parse frontmatter/body (`parseFrontmatter`)
2. description source:
   - `frontmatter.description` if present
   - else first non-empty body line (max 60 chars with `...`)
3. keep parsed body as executable template content
4. compute a display source string like `via Claude Code Project`
5. preserve `argumentHint` from discovery, or parse `argumentHint`/`argument-hint` frontmatter for autocomplete ghost text and ACP input hints

Codex/OpenCode providers strip frontmatter before this stage. Their discovered argument hints survive, but the runtime description currently falls back to the body rather than using the separately discovered description.

Frontmatter parse severity is level-dependent:

- discovered user/project commands use warning-level parsing with fallback key/value parsing
- a capability item explicitly marked `native` would use fatal parsing
- bundled fallback templates use fatal parsing

### Bundled fallback commands

After filesystem/provider commands, embedded command templates are appended (`EMBEDDED_COMMAND_TEMPLATES`) if their names are not already present.

The current embedded set is `/init`, from `src/task/commands.ts`, and is used as a fallback (`source: "bundled"`).

## 4) Interactive mode: where command lists come from

Interactive mode combines multiple command sources for autocomplete and command routing.

At construction time it builds a pending command list from:

- built-ins (`buildTuiBuiltinSlashCommands(...)`, materialized from `BUILTIN_SLASH_COMMAND_DEFS` with live argument completion and inline hints)
- extension-registered slash commands (`extensionRunner.getRegisteredCommands(...)`)
- TypeScript custom commands (`session.customCommands`), mapped to slash command labels
- optional skill commands (`/skill:<name>`) when `skills.enableSkillCommands` is enabled

Then `init()` calls `refreshSlashCommandState(...)`, reusing the session's startup-discovered commands when available, to install the base autocomplete provider (`createPromptActionAutocompleteProvider`) containing:

- pending commands above
- discovered file-based commands
- discovered prompt-template commands whose names aren't already taken by a built-in/hook/custom/skill/file command

`refreshSlashCommandState(...)` also updates `session.setSlashCommands(...)` so prompt expansion uses the same discovered file command set.
Extension-registered autocomplete factories wrap this base provider in registration order; malformed or throwing factories are skipped.

### Refresh lifecycle

Slash command state is refreshed:

- during interactive init
- after cwd changes, including `/move` (`applyCwdChange` reloads project settings, clears plugin-root caches, and refreshes session skills/commands)
- when the editor component is swapped
- by explicit plugin reload flows such as `/reload-plugins`
- when session command-metadata notifications arrive, including live settings changes, skill management, and MCP prompt updates (autocomplete rebuilds from current session state)

There is no continuous file watcher for command directories.

### Other surfacing

The Extensions dashboard also loads `slash-commands` capability and displays active/shadowed command entries, including `_shadowed` duplicates.

## 5) Routing and prompt-pipeline placement

The unified built-in registry is checked before `AgentSession.prompt(...)` in TUI and ACP/RPC modes. A built-in can consume input or return residual prompt text. TUI-only built-ins are omitted from ACP availability and dispatch; ACP-visible built-ins are the entries with a text-mode `handle`.

Built-in parsing splits at the first whitespace or colon, so `/model:opus` is a built-in invocation. Extension/custom/file parsing instead splits only at the first literal space, preserving names such as `plugin:command`. In the TUI, a built-in with arguments falls through when its spec does not declare `allowArgs`; the ACP dispatcher leaves argument validation to the handler.

After that boundary, `AgentSession.prompt(...)` processes slash input in this order when `expandPromptTemplates !== false`:

1. **Extension commands** (`#tryExecuteExtensionCommand`)  
   If `/name` matches an extension-registered command, its handler executes immediately and prompt returns.
2. **TypeScript custom commands and MCP prompt commands** (`#tryExecuteCustomCommand`)
   A match may return:
   - nonempty `string` -> replace prompt text with that string
   - empty string or `void/undefined` -> treated as handled; no LLM prompt
3. **File-based slash commands** (`expandSlashCommand`)  
   If text still starts with `/`, attempt markdown command expansion.
4. **Prompt templates** (`expandPromptTemplate`)  
   Applied after slash/custom processing.
5. **Delivery**
   - idle: prompt is sent immediately to agent
   - streaming: prompt is queued according to `streamingBehavior` (`steer`, `followUp`, or `aside`)

`runCommands: false` skips extension/custom handlers but still expands file commands and prompt templates. `expandPromptTemplates: false` bypasses all four expansion stages. Normal user prompts then undergo model-mention expansion and magic-keyword matching; synthetic prompts do not trigger magic notices.

This is why built-ins reserve their names before file commands are considered, slash command expansion sits before prompt-template expansion, and custom commands can transform away the leading slash before file-command matching.

## 6) Expansion semantics for file-based slash commands

`expandSlashCommand(text, fileCommands)` behavior:

- only runs when text begins with `/`
- splits the command name at the first literal space after `/` (tabs/newlines do not delimit the name)
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
- empty quoted arguments are discarded in this default, non-strict parsing mode

Argument substitution is one pass over the template; dollar placeholders inside argument values are not substituted again. Missing positional values, zero start/length slices, and out-of-range slice starts render as empty strings.

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
  - `"aside"` -> inject at the next step boundary without interrupting an in-flight tool batch (a running interruptible `wait` ends)
- if `streamingBehavior` is omitted, prompt throws an error

### Important command-specific streaming behavior

- Extension commands are executed immediately even during streaming (not queued as text).
- `steer(...)`/`followUp(...)` helper methods reject extension commands (`#throwIfExtensionCommand`) to avoid queuing command text for handlers that must run synchronously.
- Those helpers expand prompt templates, but do not run custom handlers or expand file commands. Use `prompt(..., { streamingBehavior })` for the full command pipeline.
- Compaction queue replay uses `isKnownSlashCommand(...)` to decide whether queued entries should be replayed via `session.prompt(...)` (for known slash commands) vs raw steer/follow-up methods.

## 9) Error handling and failure surfaces

- Provider load failures are isolated; registry collects warnings and continues with other providers.
- Invalid slash command items (missing name/path/content or invalid level) are dropped by capability validation.
- Frontmatter parse failures:
  - items explicitly marked `level: "native"` and bundled templates: fatal parse error bubbles
  - discovered user/project commands (including the native OMP provider): warning + fallback key/value parse
- Extension/custom command handler exceptions are caught and reported via extension error channel (or logger fallback for custom commands without extension runner), and treated as handled (no unintended fallback execution).

## 10) Built-in command note: `/pause`

`/pause` is available only in the interactive TUI. It engages a process-global gate for the main agent, in-process subagents, and the advisor. Each agent parks at its next safe boundary: in-flight calls finish, nothing is aborted, and no new work starts until the gate is released.

From the pause screen, press the configured interrupt key (Esc by default), Enter, Space, or Ctrl+C to resume. Ctrl+C resumes rather than aborting any agent.

## 11) Built-in command note: `/btw`

`/btw <question>` asks an independent side question about the transcript being
viewed: the focused subagent's session when one is focused, otherwise the main
session. It uses that session's active model and context, including partial
streaming assistant text. Bare `/btw` opens that view's history, with the newest
question selected.
Saved side questions are not appended to the main transcript or sent as history
to unrelated turns. Each new `/btw <question>` remains independent; explicit
follow-ups include only the selected side conversation alongside the current
viewed-session context.

Previous questions and answers are replayed as separate `user` and `assistant`
messages, followed by the new user question, rather than embedded in one prompt.
The original question template stays in the same position across follow-ups.
History is snapshotted before asynchronous conversion and uses the normal
provider normalization and secret-obfuscation pipeline.

The viewed session's prompt-cache key and static system/tool prefix are retained. Each BTW
topic has its own stable provider-side conversation identity, separate from the
owning session's conversation and other topics. Successful serialized follow-ups reuse it;
after a cancelled, failed, or interrupted turn the next request uses a new
transport generation, so an unwinding request cannot share its state.
Standalone ephemeral callers without a conversation key keep per-request IDs.
Actual cache hits depend on the provider. The viewed session's context is still
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
directory's `btw-history/` subdirectory. Focused subagent histories use
`btw-history/sessions/<session-id>/` within the shared artifacts directory and
are isolated from the main session and siblings. This is local retention
alongside the session. Even a session containing only
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
idle. Focused-subagent answers cannot be promoted to a main-session branch.
Multi-turn side conversations remain in BTW history; promoting only their
latest pair would discard earlier context. History browsing does not promote
answers or relax these branch guards.

## 12) Bundled command note: `/annotate`

`/annotate` lets the operator attach notes to a diff or text before the agent acts. With no argument it opens a source menu.

| Command | Source |
|---|---|
| `/annotate code-review [focus]` | Local base-branch, working-copy, or commit diff, or a GitHub PR |
| `/annotate last` | Latest non-empty assistant reply on the active branch |
| `/annotate session` | A message or block picked in the `/copy` selector |
| `/annotate path/to/file` | Text read from a file |
| `/annotate "text"` | Literal text |

The whole remainder after `/annotate` is one source specification (`CustomCommand.execute` receives it verbatim as `rawArgs`):

- A remainder wrapped in matching `"` or `'` is literal text; only the outer pair is stripped and the interior is kept byte-for-byte.
- Unquoted `last`, `session`, and `code-review …` select those modes. To annotate a file whose path starts with one of these words, prefix it with `./` (for example `/annotate ./code-review notes.md`).
- Anything else is one file path, spaces included, resolved with `resolveReadPath` against the live session cwd. Missing or non-regular paths notify and never fall back to literal text.

Argument completion offers the modes, a `./` file-path starter, and a quote starter. `CustomCommand.getArgumentCompletions(prefix, cwd)` receives the live session cwd, so file suggestions follow `/move` and `/wt`.

**Code review.** The menu lists up to three GitHub PRs referenced in the conversation, then the local diff kinds. `/annotate code-review pr://owner/repo/N [focus]` skips the menu. The diff is resolved once in the live session cwd and frozen (`ResolvedReviewTarget`); the overlay and the reviewer prompt read the same snapshot, filtered by the same exclusion rules as `/review` (`src/extensibility/custom-commands/bundled/review/diff.ts`). The overlay offers **Continue with LLM review** (submits the `/review` prompt with the notes as operator focus) and **Paste annotations into prompt**. Both include the optional `[focus]` text. Nothing is posted to GitHub.

Without an interactive UI, `code-review` delegates to `/review` instead of opening the annotation overlay; text-source annotation refuses to send a message.

**Text sources.** Feedback is always pasted into the composer, never submitted. File and literal sources are embedded verbatim. The latest reply is referenced as "your last reply" and only the annotated lines are quoted. An older session prose message longer than 1,000 characters is condensed by one call to the current session model (its credentials, no fallback model); if that call fails or returns an unusable result, the full source is embedded with a warning.

**ANSI layout.** Diff and text source lines hard-wrap by terminal cells, preserving indentation, expanded tabs, internal/trailing spaces, empty lines, and intact graphemes rather than wrapping prose words. Diff continuation rows align with the content, with foreground styling closed on each physical row; every continuation retains the same original logical note anchor. PgUp/PgDn page through visual rows, and `g`/`G` reach the beginning/end, including continuations of a single long source line. A focused truncated filename floats over existing rows without reflowing the file list, moves upward if needed to fit, and collapses when focus leaves. Paths taller than the whole pane show an explicit omission marker and retain the filename suffix. Like ask-tool notes, the note editor follows the configured terminal hardware-cursor preference, using the terminal's native cursor when enabled and a software cursor when disabled. The final glyph stays visible at the exact text width; the first overflow glyph wraps.

**Overlay keys.** `a` adds a line note, `A` a whole-file/whole-text note, `e` edits the note(s) at the cursor (with a chooser when several apply), `u` undoes the last add/edit/delete. The external-editor key (`app.editor.external`, Ctrl+G by default) opens `$VISUAL` or `$EDITOR`. While writing a note, it replaces the draft without saving it; for a typed prompt, it edits a temporary file and replaces the text the paste uses. Session messages are not editable, since the paste omits or summarizes them and notes on edited text would quote lines the model never sees.

With a supported multiplexer, the key opens the full file in a pane using `$VISUAL` then `$EDITOR` when focus identifies a direct file source, a local-diff file, or an unambiguous selected read/edit/write tool file. The annotation remains live while the editor runs; its captured text or diff stays frozen rather than reloading asynchronously. PRs have no local file mapping; prose, bash commands, and ambiguous multi-file targets are not inferred.

Without a supported multiplexer or launcher, the existing stop/open/start editor flow remains: direct-file sources are edited in place and re-read, while local-diff files open from the repository root. Direct-file edits refresh the source. A line note whose quote still matches its row is kept; one moved to exactly one row is retargeted; any other line note is dropped and undo history cleared. A non-zero editor exit warns but still uses saved contents. Shell-input multiplexer launches require POSIX confirmation.

In the note editor, Enter saves, Shift+Enter inserts a newline, and Escape discards the draft. Notes are trimmed on save; saving an empty edit deletes the note, and an empty new note is ignored. Line anchors (quoted source line, diff hunk header and raw row) are kept exactly.

## 13) Built-in command note: `/plan-review`

`/plan-review` reopens the Plan Review overlay for the latest plan (plan mode only). In the Contents sidebar `a` annotates the selected section; in the plan body `a` annotates the top visible line. `e` edits the annotation(s) at that section or line (with a chooser when several apply) and `u` undoes the latest section deletion or annotation change. The note editor behaves like `/annotate`'s: Enter saves, Shift+Enter inserts a newline, Escape discards the draft, the external-editor key replaces the draft without saving, and saving an empty edit deletes the annotation.
