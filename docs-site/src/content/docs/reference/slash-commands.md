---
title: Slash Commands
description: Slash commands available in the TUI.
coverage: A
---

Slash commands are typed into the interactive prompt (after a `/`) and execute a built-in action — switch model, open a dashboard, branch the session, manage plugins, and so on. This page lists every built-in command registered in the TUI. Commands from skills, extensions, custom commands, MCP prompts, and file-based commands also appear in the picker; see [Other command sources](#other-command-sources) and [Custom slash commands](/oh-my-pi/extending/extensions/).

Unknown `/...` text is not rejected by the TUI: if the command has no handler, the literal text is sent to the agent as a prompt.

Built-in commands are grouped below by what they do, in the same order they appear in the TUI picker.

## Modes and planning

| Command | Description | Usage |
| --- | --- | --- |
| `/settings` | Open settings menu | `/settings` |
| `/setup` _(alias `/providers`)_ | Open provider setup | `/setup [providers]` |

Mode-toggling commands — each opens its own page for full usage and subcommands:

| Command | Description |
| --- | --- |
| [`/plan`](/oh-my-pi/modes/plan-mode/) | Toggle plan mode (agent plans before executing) |
| [`/plan-review`](/oh-my-pi/modes/plan-mode/) | Re-open the plan review for the latest plan (plan mode only) |
| [`/vibe`](/oh-my-pi/features/vibe-mode/) | Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset) |
| [`/goal`](/oh-my-pi/modes/goal-mode/) | Toggle goal mode (persistent autonomous objective for this session) |
| [`/guided-goal`](/oh-my-pi/modes/goal-mode/) | Have the agent interview you in chat, then set up goal mode |
| [`/loop`](/oh-my-pi/modes/loop-mode/) | Toggle loop mode. While enabled, the next prompt you send re-submits after every yield. Esc cancels the current iteration; /loop again to disable. |
| [`/queue`](/oh-my-pi/modes/queue-mode/) | Queue a message for after the agent yields |

## Model and runtime

| Command | Description | Usage |
| --- | --- | --- |
| `/model` _(alias `/models`)_ | Switch model for this session | `/model [model-id]` |
| `/switch` | Switch model for this session (same as alt+p) | `/switch` |
| `/fast` | Toggle priority service tier (OpenAI service_tier=priority, Anthropic speed=fast) | `/fast [on\|off\|status]` |
| `/computer` | Toggle the native computer-use tool for this session | `/computer [on\|off\|status]` |
| `/vision` | Control the inspect_image vision-delegation tool for this session | `/vision [on\|off\|auto\|status]` |
| `/prewalk` | Switch to a fast/cheap model at the next action (works even without --prewalk) | `/prewalk` |
| `/advisor` | Toggle the advisor (a second model that reviews each turn and injects notes) | `/advisor [on\|off\|status\|dump [raw]\|configure]` |

`/advisor` subcommands: `on`, `off`, `status`, `dump [raw]`, `configure`.

## Export and sharing

| Command | Description | Usage |
| --- | --- | --- |
| `/export` | Export session to HTML file | `/export [--themes] [path]` |
| `/dump` | Copy session transcript to clipboard (and write LLM request JSON to tmp) | `/dump` |
| `/share` | Share session via an encrypted link (share server or secret gist) | `/share` |
| `/collab` | Share this session live via a relay | `/collab [start\|view\|stop\|status] [relayUrl]` |
| `/join` | Join a shared collab session | `/join <link>` |
| `/leave` | Leave the collab session | `/leave` |
| `/browser` | Toggle browser headless vs visible mode | `/browser [headless\|visible]` |

`/collab` subcommands: `view`, `status`, `stop`.

## Conversation and session

| Command | Description | Usage |
| --- | --- | --- |
| `/copy` | Pick text or code from the conversation to copy | `/copy [code\|cmd]` |
| `/todo` | View or modify the agent's todo list | `/todo [<subcommand>]` |
| `/session` | Session management commands | `/session [info\|delete\|pin [account]]` |
| `/jobs` | Show async background jobs status | `/jobs` |
| `/usage` | Show provider usage and limits | `/usage [show\|reset [account\|active]]` |
| `/stats` | Launch the local stats dashboard | `/stats [--port <port>]` |
| `/changelog` | Show changelog entries | `/changelog [full]` |
| `/hotkeys` | Show all keyboard shortcuts | `/hotkeys` |
| `/tools` | Show tools currently visible to the agent | `/tools` |
| `/context` | Show estimated context usage breakdown | `/context` |

`/todo` subcommands: `edit`, `copy`, `export [<path>]` (default `TODO.md`), `import [<path>]` (default `TODO.md`), `append [<phase>] <task...>`, `start <task>`, `done [<task|phase>]`, `drop [<task|phase>]`, `rm [<task|phase>]`.

`/session` subcommands: `info`, `delete`, `pin [account]`.

`/usage` subcommands: `show`, `reset [account|active]`.

`/changelog` subcommands: `full`.

## Dashboards

| Command | Description | Usage |
| --- | --- | --- |
| `/extensions` _(alias `/status`)_ | Open Extension Control Center dashboard | `/extensions` |
| `/agents` | Open Agent Control Center dashboard | `/agents` |

## Navigation

| Command | Description | Usage |
| --- | --- | --- |
| `/branch` | Create a new branch from a previous message | `/branch` |
| `/fork` | Create a new fork from a previous message | `/fork` |
| `/tree` | Navigate session tree (switch branches) | `/tree` |

## Auth and integrations

| Command | Description | Usage |
| --- | --- | --- |
| `/login` | Login with OAuth provider | `/login [provider\|redirect URL]` |
| `/logout` | Logout from OAuth provider | `/logout [provider]` |
| `/mcp` | Manage MCP servers (add, list, remove, test) | `/mcp <subcommand>` |
| `/ssh` | Manage SSH hosts (add, list, remove) | `/ssh <subcommand>` |

`/mcp` subcommands: `add <name> [--scope project|user] [--url <url>] [-- <command...>]`, `list`, `remove <name> [--scope project|user]`, `test <name>`, `reauth <name>`, `unauth <name>`, `enable <name>`, `disable <name>`, `smithery-search <keyword> [--scope project|user] [--limit <1-100>] [--semantic]`, `smithery-login`, `smithery-logout`, `reconnect <name>`, `reload`, `resources`, `prompts`, `notifications`, `help`.

`/ssh` subcommands: `add <name> --host <host> [--user <user>] [--port <port>] [--key <keyPath>]`, `list`, `remove <name> [--scope project|user]`, `help`.

## Security

| Command | Description | Usage |
| --- | --- | --- |
| [`/security`](/oh-my-pi/features/security/) | Plan, run, inspect, import, and compare OMP-native security scans | `/security <subcommand>` |

`/security` subcommands: `plan` (create an immutable security scan plan), `scan` (start a planned or newly planned native scan), `status` (show native scan operation status), `cancel` (cancel a running native scan), `scans` (list stored project security scans), `show` (render a scan or `security://` resource), `import` (import SARIF or a Codex Security bundle), `export` (export a canonical bundle, SARIF, or report), `validate` (validate one finding with OMP-native tools), `compare` (compare finding lineage across two scans), `disposition` (set a finding disposition with rationale).

## Session lifecycle

| Command | Description | Usage |
| --- | --- | --- |
| `/new` | Start a new session | `/new` |
| `/clear` | Clear the conversation context in place, keeping the session | `/clear` |
| `/fresh` | Reset provider stream state without changing the local transcript | `/fresh` |
| `/drop` | Delete the current session and start a new one | `/drop` |
| `/compact` | Manually compact the session context | `/compact [<mode>] [focus]` |
| `/shake` | Drop heavy content from context (tool results, large blocks) | `/shake [elide\|images]` |
| `/handoff` | Hand off session context to a new session | `/handoff [focus instructions]` |
| `/resume` | Resume a different session | `/resume [session id\|@claude\|@codex]` |
| `/btw` | Ask an ephemeral side question using the current session context | `/btw <question>` |
| `/tan` | Run a full background agent on tangential work | `/tan <work>` |
| `/omfg` | Forge a TTSR rule from a complaint to stop a recurring behavior | `/omfg <complaint>` |
| `/retry` | Retry the last failed agent turn | `/retry` |
| `/debug` | Open debug tools selector | `/debug` |
| `/memory` | Inspect and operate memory maintenance | `/memory <subcommand>` |
| `/rename` | Rename the current session | `/rename <title>` |
| `/move` | Move the current session to a different directory | `/move [<path>]` |
| `/add-dir` | Add a workspace directory to this session (multi-root) | `/add-dir <path>` |
| `/remove-dir` | Remove a workspace directory from this session | `/remove-dir <path>` |
| `/dirs` | List this session's workspace directories | `/dirs` |
| `/exit` | Exit the application | `/exit` |

`/compact` subcommands: `soft` (summarize locally with the active model, skip remote endpoints), `remote` (summarize via the remote endpoint / provider-native compaction), `snapcompact` (archive history onto dense bitmap images the model reads back, no LLM call). `snapcompact` rejects a focus argument; the others accept an optional focus string.

`/shake` subcommands: `elide` (strip tool results + large blocks, default), `images` (strip image blocks).

`/memory` subcommands: `view`, `stats`, `diagnose`, `clear`, `reset` (alias of clear), `enqueue`, `rebuild` (alias of enqueue), plus the mental-model suite `mm list`, `mm show <id>`, `mm refresh [id]`, `mm history <id>`, `mm seed`, `mm delete <id>`, `mm reload`.

## Plugins

| Command | Description | Usage |
| --- | --- | --- |
| `/marketplace` | Manage marketplace plugin sources and installed plugins | `/marketplace <subcommand>` |
| `/plugins` | View and manage installed plugins | `/plugins [list\|enable\|disable]` |
| `/reload-plugins` | Reload all plugins (skills, commands, hooks, tools, agents, MCP) | `/reload-plugins` |

`/marketplace` subcommands: `add <source>`, `remove <name>`, `update [name]`, `list`, `discover [marketplace]`, `install [--force] [name@marketplace]` (interactive browser if no args), `uninstall [name@marketplace]` (selector if no args), `installed`, `upgrade [name@marketplace]`, `help`.

`/plugins` subcommands: `list`, `enable <name@marketplace>`, `disable <name@marketplace>`.

## Misc

| Command | Description | Usage |
| --- | --- | --- |
| `/force` _(alias `/force:`)_ | Force next turn to use a specific tool | `/force <tool-name> [prompt]` |
| `/live` | Start Codex-backed realtime voice mode | `/live` |
| `/pause` | Freeze all agents (main, subagents, advisor) until resumed | `/pause` |
| `/quit` _(alias `/q`)_ | Quit the application | `/quit` |

## Other command sources

The TUI picker also surfaces commands from outside the built-in registry. The order in the picker always puts built-ins first, then the sources below in registration order.

- **Skill commands** — `/skill:<name>` appears when `skills.enableSkillCommands` is enabled. Each enabled skill is registered under its slash name.
- **Extension commands** — Extension packages can register slash commands at runtime. They appear in the picker under whatever name they register.
- **Custom commands** — TypeScript custom commands registered through the extension runner appear with their declared labels.
- **MCP prompt commands** — Prompts exposed by connected MCP servers appear as slash commands.
- **File commands** — Markdown files in the standard command directories are loaded as slash commands. Files are scanned from:
  - `<cwd>/.omp/commands/*.md` and `~/.omp/agent/commands/*.md` (native)
  - `<cwd>/.claude/commands/**/*.md` and `~/.claude/commands/**/*.md` (Claude Code, recursive)
  - `<cwd>/.codex/commands/*.md` and `~/.codex/commands/*.md` (Codex)
  - `<cwd>/.opencode/commands/*.md` and `~/.config/opencode/commands/*.md` (OpenCode)
  - claude-plugin roots under `<pluginRoot>/commands/*.md` (namespaced as `<plugin>:<command>`)

For each source, the first match wins on a name collision. Project-scoped commands generally beat user-scoped ones; the exception is Claude Code, where user commands win over project ones.

## Custom slash commands

To author your own slash commands (including file-based Markdown templates and TypeScript extensions), see [Extensions](/oh-my-pi/extending/extensions/). The page covers the directory layout, frontmatter, argument expansion (`$1`, `$@`, `$ARGUMENTS`), and how to register a command from a plugin.
