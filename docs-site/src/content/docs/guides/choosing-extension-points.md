---
title: Choosing Extension Points
description: Compare omp's extension mechanisms — skills, extensions, custom tools, hooks, commands, plugins, MCP servers, and the SDK — and pick the right one.
coverage: B
---

omp can be extended in eight ways, and each one solves a different problem: passive knowledge for the model, executable tool behavior, event interception, user-invoked commands, distribution, out-of-process tools, and programmatic embedding. This guide compares the mechanisms and helps you pick one; each row links to the page that documents it in full.

:::tip
When in doubt, start with an [extension](/oh-my-pi/extending/extensions/). It is a strict superset of hooks and custom tools and can also register slash commands — one file covers most needs.
:::

## Comparison

| Mechanism | What it adds | Where it lives | Who uses it | Lifecycle | Example |
| --- | --- | --- | --- | --- | --- |
| [Skills](/oh-my-pi/extending/skills/) | Knowledge and guidance the model reads on demand | `<skills-root>/<name>/SKILL.md` — native `.omp`, extension packages, Claude/Codex/agents/opencode/github sources, `skills.customDirectories` | Model (via `read` on `skill://` URLs), user (`/skill:<name>` when enabled) | Discovered at startup in three passes: capability providers, custom directories, managed skills | `postgres/SKILL.md` teaching query patterns |
| [Extensions](/oh-my-pi/extending/extensions/) | In-process TypeScript/JS modules that register tools, slash commands, event handlers, shortcuts, CLI flags, and renderers | `<cwd>/.omp/extensions/`, `~/.omp/agent/extensions/`, `extensions` setting, plugin manifests, `--extension`/`-e` | Model (registered tools), user (slash commands), session lifecycle (events) | Loaded at startup; all sources merge into one list deduped by absolute path, first occurrence wins | One file with `pi.registerTool(...)` and `pi.on("tool_call", ...)` |
| [Custom tools](/oh-my-pi/extending/custom-tools/) | Model-callable tools with a parameter schema | `~/.omp/agent/tools`, `.omp/tools`, Claude/Codex tool directories, plugin manifests, configured paths | Model (tool calls) | Discovered at startup; names must not collide with built-ins or other custom tools | A `repo_stats` tool that runs `git ls-files` |
| [Hooks](/oh-my-pi/extending/hooks/) | Event interceptors that block tools, patch tool results, or rewrite the LLM context | Hook factories such as `.omp/hooks/pre/*.ts`; `--hook` is an alias for `--extension` | Agent loop (event interception) | Loaded through the extension runner at startup, deduped by path | `pi.on("tool_call", ...)` returning `{ block: true }` |
| [Custom commands](/oh-my-pi/reference/slash-commands/) | New slash commands defined as Markdown files | `<cwd>/.omp/commands/*.md`, `~/.omp/agent/commands/*.md` (plus Claude/Codex/OpenCode command directories) | User (types `/name`) | Command directories scanned at startup; first match wins on name collisions; no file watcher | A `deploy.md` that expands `/deploy` into a prompt |
| [Plugins & marketplaces](/oh-my-pi/extending/plugins/) | Distribution: one package bundling skills, commands, agents, hooks, tools, MCP servers, LSP servers, and extension modules | Marketplaces with `.omp-plugin/marketplace.json`; installs into `~/.omp/plugins/` or `<project>/.omp/plugins/` | Users (install and enable via `omp plugin` or `/marketplace`) | Installed once, enabled/disabled per scope, content loaded at startup | `code-review@claude-plugins-official` |
| [MCP servers](/oh-my-pi/extending/mcp/) | Out-of-process tools (plus resources and prompts) over JSON-RPC | `.omp/mcp.json`, `~/.omp/agent/mcp.json`; stdio, HTTP, or SSE transports | Model (`mcp__*` tools), user (`/mcp` commands) | Connected at startup behind a 250 ms fast-startup gate; `/mcp reload` swaps the live tool set; automatic reconnect with backoff | The `filesystem` reference server via `npx` |
| [SDK](/oh-my-pi/extending/sdk/) / [RPC](/oh-my-pi/extending/rpc/) | Embed omp in your own process, or drive it from another program | `@oh-my-pi/pi-coding-agent` package; `omp --mode rpc` over newline-delimited JSON on stdio | External programs and drivers | Per-process: SDK sessions are created and disposed in code; RPC reads commands from stdin until it closes | `createAgentSession()` in a Bun script; `{"type":"prompt",...}` frames |

## Decision flow

| I want to… | Use |
| --- | --- |
| Add knowledge, guidelines, or reference material the model can consult on demand | A [skill](/oh-my-pi/extending/skills/) |
| Give the model a new callable behavior | A [custom tool](/oh-my-pi/extending/custom-tools/) — or an [extension](/oh-my-pi/extending/extensions/) if you also need events around the tool |
| React to session, turn, or tool events (block, patch, observe) | An [extension](/oh-my-pi/extending/extensions/) for new work; [hooks](/oh-my-pi/extending/hooks/) only when maintaining existing hook modules |
| Add a slash command without writing code | A [custom command](/oh-my-pi/reference/slash-commands/) file (`.omp/commands/*.md`) |
| Reuse an existing MCP server | [MCP configuration](/oh-my-pi/extending/mcp/) |
| Distribute capabilities to other users | A [plugin or marketplace](/oh-my-pi/extending/plugins/) |
| Drive omp from my own program | The [SDK](/oh-my-pi/extending/sdk/) and [RPC](/oh-my-pi/extending/rpc/) surfaces — see [RPC vs SDK](/oh-my-pi/extending/rpc-vs-sdk/) to pick |

## Combining mechanisms

The mechanisms compose; nothing forces a single choice.

- **Extension packages can bundle skills.** Skills placed next to extension packages loaded through `extensions:`, `--extension`/`-e`, or installed plugins are discovered by the `omp-plugins` provider at priority 90 — directly below native `.omp` skills.
- **Hooks load through the extension runner.** `--hook` is treated as an alias for `--extension`; both add paths to the same loader, and a hook factory is just a module registering `pi.on(...)` handlers. The `HookAPI` is the legacy surface — `ExtensionAPI` covers every hook event plus extension-only events.
- **Extensions can register slash commands.** `pi.registerCommand(...)` adds a command handled in-process; in routing, extension-registered commands run before custom and file commands (after built-ins).
- **Plugins bundle every mechanism.** A plugin package can carry skills, commands, agents, hooks, tools, MCP servers, LSP servers, and extension modules; one install surfaces all of them.
- **MCP tools enter the normal tool registry** under `mcp__<server>_<tool>` names and are replaced live on `/mcp reload`. They are ordinary tools from the agent's perspective, so other extension points — for example `tool_call` interception — apply to them.
- **SDK and RPC inherit the rest.** `createAgentSession()` discovers extensions, skills, context files, prompt templates, slash commands, custom TS commands, MCP servers, and built-in tools unless overridden, so an embedded session exposes the same extension surface as the CLI.

## Next steps

- [Skills](/oh-my-pi/extending/skills/)
- [Extensions](/oh-my-pi/extending/extensions/)
- [Custom Tools](/oh-my-pi/extending/custom-tools/)
- [Hooks](/oh-my-pi/extending/hooks/)
- [MCP Servers](/oh-my-pi/extending/mcp/)
- [Plugins & Marketplaces](/oh-my-pi/extending/plugins/)
- [SDK](/oh-my-pi/extending/sdk/) and [RPC](/oh-my-pi/extending/rpc/) — plus [RPC vs SDK](/oh-my-pi/extending/rpc-vs-sdk/) for the comparison
- [Slash Commands reference](/oh-my-pi/reference/slash-commands/) — includes custom command files
