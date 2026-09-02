---
title: Your First Session
description: "A guided tour of the omp interactive session: sending prompts, interrupting, switching models, slash commands, and resuming."
coverage: B
---

omp's interactive TUI is the default surface for working on a project. This page walks through the parts you'll touch in every session: the prompt editor, the keyboard shortcuts, model and thinking controls, slash commands, and how to leave and come back. See the [Keybindings reference](/oh-my-pi/configuration/keybindings/) for the full remap table.

## Starting a session

`omp` (with no other arguments) opens the TUI in the current working directory. Sessions are scoped to the project, so tools and completions see only that project's files.

In a session, tool calls render as cards, edits preview before they land, and ambiguous decisions route through the `ask` tool — a structured option picker the agent can call mid-turn. The keyboard handles the rest.

## Sending prompts

Type your prompt and press **Enter** to send it. Multi-line drafts open in your external editor: **Ctrl+G** loads the current draft into `$VISUAL` or `$EDITOR` and uses the result on save. **Ctrl+R** searches your prior prompts.

While the agent is working, you can keep typing — new prompts land in a follow-up queue instead of interrupting the in-flight turn:

- **Ctrl+Q** or **Ctrl+Enter** — queue the editor contents as a follow-up message.
- **Alt+Up** — dequeue a queued message back into the editor (e.g. to edit it before it runs).

To stop an in-flight turn, press **Esc**. The current generation aborts at the next safe boundary and any partially produced tool results are preserved.

## Switching models and thinking

**Pick the model.** The `/model` slash command opens the model selector and assigns a model to a role. The shortcuts cycle through the configured models for the active role without opening a selector:

| Key              | Action                                  |
| ---------------- | --------------------------------------- |
| `Ctrl+P`         | Cycle role models forward               |
| `Shift+Ctrl+P`   | Cycle role models backward              |
| `Alt+P`          | Pick a model temporarily for this session |
| `Alt+M`          | Open the model selector                  |

`Ctrl+P` and `Shift+Ctrl+P` only step through models that are already configured for the active role; use `/model` to assign a different model to a role or swap it for the rest of the session.

**Toggle thinking.** Two controls operate independently:

| Key          | Action                            |
| ------------ | --------------------------------- |
| `Shift+Tab`  | Cycle thinking level              |
| `Ctrl+T`     | Toggle thinking-block visibility  |

`Shift+Tab` steps through the configured levels for the active model. `Ctrl+T` hides or shows the rendered thinking blocks in the transcript without changing the level.

:::tip
The word `ultrathink` inside a turn requests the highest supported automatic thinking effort for that one prompt. See [Magic keywords](/oh-my-pi/features/magic-keywords/) for the full set.
:::

## Slash commands

Slash commands shift how a session runs. Type `/` to start one; autocomplete (set up via the [Installation page's](/oh-my-pi/getting-started/installation/) shell completions, or [Remap keybindings](/oh-my-pi/configuration/keybindings/)) narrows the list. A few that matter on the first session:

- `/model` — pick a model or assign a model to a role.
- `/fresh` — reset the provider's stream state (stale prompt cache, wedged stream) without touching the local transcript.
- `/hotkeys` — list the active key chords for your current build, including any remaps loaded from disk.
- `/help` — show the slash-command help.

See the [slash-command reference](/oh-my-pi/reference/slash-commands/) for the complete list.

## Ending and resuming a session

`/exit` or `/quit` leaves the TUI. Nothing is lost — sessions persist per project on disk.

To come back, launch `omp` with one of the resume flags. The first two are also available as slash commands inside an open session:

| Launch flag                | Slash command | Behavior                                                                 |
| -------------------------- | ------------- | ------------------------------------------------------------------------ |
| `omp --continue`           | —             | Open the most recent session in the current project, or create a new one if none exists. |
| `omp --resume`             | `/resume`     | Open a picker; lists sessions in the current folder, falls back to all projects. |
| `omp --resume <id\|path>`  | —             | Open a specific session; a global match re-roots into the session's project or forks into the current one. |
| `omp --fork <id\|path>`    | `/fork`       | Branch a new session from an existing one at startup.                    |

`/fork` is rejected while the agent is streaming — abort the current turn first. See the [Sessions page](/oh-my-pi/features/sessions/) for tree/leaf semantics and full resume behavior.

## Key cheat sheet

The default chords for a first session. Remaps live in `~/.omp/agent/keybindings.yml`; run `/hotkeys` to see what is active for your build.

| Key                  | Action                                         |
| -------------------- | ---------------------------------------------- |
| `Enter`              | Send the prompt                                |
| `Esc`                | Interrupt the agent                            |
| `Ctrl+Q` / `Ctrl+Enter` | Queue a follow-up message                   |
| `Alt+Up`             | Dequeue a queued message back into the editor  |
| `Ctrl+G`             | Edit the draft in `$VISUAL` / `$EDITOR`        |
| `Ctrl+R`             | Search prompt history                          |
| `Ctrl+P` / `Shift+Ctrl+P` | Cycle role models forward / backward       |
| `Alt+P`              | Pick a model temporarily for this session      |
| `Alt+M`              | Open the model selector                        |
| `Shift+Tab`          | Cycle thinking level                           |
| `Ctrl+T`             | Toggle thinking-block visibility               |
| `Ctrl+O`             | Toggle tool-output expansion                   |
| `Ctrl+L`             | Reset terminal display                         |
| `Alt+R`              | Retry the last failed assistant turn           |

## Sharp edges

- **Windows Terminal swallows `Ctrl+Enter`.** `omp` also binds the follow-up chord to `Ctrl+Q` (the same chord GitHub Copilot CLI uses) so queueing still works. If your `keybindings.yml` reassigns `Ctrl+Q`, the follow-up falls back to `Ctrl+Enter` and may be captured by the terminal first.
- **`Ctrl+V` paste on Windows Terminal.** Windows Terminal may handle `Ctrl+V` before `omp` sees it; use the `Alt+V` fallback for image paste. When the clipboard has no image, the same chord pastes clipboard text.
- **`/fork` while streaming.** Slash-command `/fork` is rejected while the agent is producing output — abort the current turn with `Esc` first.
- **Cross-project `--resume <id>`.** If the id matches a session from another project, omp will prompt to fork the session into the current project rather than re-rooting in place; declining the prompt cancels the switch.
