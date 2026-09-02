---
title: Built-in Tools
description: The inventory of tools the agent can call — files, search, execution, web, agents, memory, and media — and where each is documented.
coverage: B
---

Every `omp` session gives the agent a set of built-in tools: callable operations for reading and editing files, running code, searching the web, spawning subagents, and more. You never call tools directly, but knowing what exists helps you phrase requests and understand what the agent is doing. Individual tools can be toggled or gated through settings (for example `bash.enabled`, `lsp.enabled`, `debug.enabled`, `computer.enabled`); see [Settings](/oh-my-pi/configuration/settings/).

## Files and editing

- **read** — Reads files, directories, archives, SQLite databases, documents, images, and URLs through one `path` string, with line-range selectors for paging large files.
- **write** — Creates or overwrites files, archive entries, SQLite rows, and writable internal resources.
- **edit** — Applies source edits; the default mode is the hashline patch language consumed from a single `input` string.
- **checkpoint** — Marks the current conversation state so a later rewind can collapse exploratory context into a report.
- **rewind** — Ends an active checkpoint, pruning exploratory context and retaining a concise report.

## Search and navigation

- **glob** — Finds filesystem paths by glob pattern.
- **grep** — Searches file contents with a regex across files, directories, globs, and internal URLs.
- **ast_grep** — Structural code search over supported source files using AST patterns with metavariables. See [Code intelligence](/oh-my-pi/features/code-intelligence/).
- **lsp** — Queries language servers for diagnostics, definitions, references, hover, symbols, renames, and code actions. See [Code intelligence](/oh-my-pi/features/code-intelligence/).

:::note
Legacy tool aliases `search` and `find` still resolve to `grep` and `glob`.
:::

## Code execution

- **bash** — Executes a shell command in the session workspace, with optional PTY or background-job handling. See [Code execution](/oh-my-pi/features/code-execution/).
- **eval** — Executes Python or JavaScript code in persistent cell-based runtimes, with structured `display()` output and image capture. See [Code execution](/oh-my-pi/features/code-execution/).
- **ast_edit** — Previews and applies structural rewrites across source files. See [Code intelligence](/oh-my-pi/features/code-intelligence/).
- **debug** — Drives a DAP debug session: launch/attach, breakpoints, stepping, and inspection. Hidden unless `debug.enabled` is set. See [Debugging](/oh-my-pi/features/debugging/).

## Web and GitHub

- **web_search** — Runs one web query through the first available search provider and returns an answer with source URLs and citations. See [Web search](/oh-my-pi/features/web-search/).
- **browser** — Opens, reuses, and scripts browser tabs against headless Chromium or CDP-attached apps. See [Browser](/oh-my-pi/features/browser/).
- **github** — Dispatches GitHub CLI operations for repositories, issues, pull requests, search, and Actions run watching. See [GitHub](/oh-my-pi/features/github/).

## Security

- **security_scan** — Plans and runs OMP-native security reviews, validates findings, and interacts with Codex Security cloud scans. Gated by `security.enabled`. See [Security](/oh-my-pi/features/security/).

## Agents and coordination

- **task** — Spawns subagents, one per call or as a `tasks[]` batch; with async enabled, spawns run in the background. See [Subagents](/oh-my-pi/features/subagents/).
- **hub** — The agent-coordination surface: peer messaging, background-job control, and supervision of shared long-running processes. See [Collaboration](/oh-my-pi/features/collab/).
- **ask** — Prompts you interactively for option-picker or free-form answers when the agent needs a decision.
- **todo** — Maintains the session todo list you see in the UI, one mutation per call.
- **vibe_spawn** — Starts a persistent `fast` or `good` worker session with a self-contained brief; the turn result arrives when the worker finishes.
- **vibe_send** — Sends a message to a worker session; steers it mid-turn or runs as its next turn.
- **vibe_wait** — Blocks until a worker session finishes its turn, with an optional timeout window.
- **vibe_kill** — Terminates a worker session.
- **vibe_list** — Lists worker sessions and their states.

Available only while `/vibe` mode is active. See [Vibe mode](/oh-my-pi/features/vibe-mode/).

## Hidden and gated tools

Two tools exist but stay out of the normal toolset, appearing only in their respective contexts:

- **yield** — Submits the agent's final result; the subagent result channel. See [Subagents](/oh-my-pi/features/subagents/).
- **goal** — Manages the active goal-mode objective. See [Goal mode](/oh-my-pi/modes/goal-mode/).

## Memory and skills

- **retain** — Stores durable facts in the active long-term memory backend.
- **recall** — Searches long-term memory and returns matching memories.
- **reflect** — Synthesizes an answer over the long-term memory backend.
- **memory_edit** — Updates, forgets, or invalidates long-term memories by id.
- **learn** — Captures a reusable lesson into long-term memory and optionally creates or updates a managed skill.
- **manage_skill** — Creates, updates, or deletes an isolated managed skill.

See [Memory](/oh-my-pi/features/memory/) for how the memory backends are configured.

## Media and desktop

- **inspect_image** — Sends a local image file to a vision-capable model and returns a text analysis.
- **generate_image** — Generates or edits images and writes the results to temporary paths.
- **tts** — Synthesizes a speech audio file from text. See [Voice](/oh-my-pi/features/voice/).
- **computer** — Captures and controls the real host desktop through native OS APIs; disabled by default. See [Computer use](/oh-my-pi/features/computer-use/).
