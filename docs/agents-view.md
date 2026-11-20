# Agent View

The Agent View lists every live omp session on the machine, from any directory, and lets you attach to background sessions, stop them, or start new ones. Background sessions run inside the omp daemon, so they keep working when the terminal or SSH connection that started them goes away.

## Open it

| Input | Behavior |
| --- | --- |
| `omp agents` | Open the view in the current terminal. |
| `←` on an empty composer | Move the current session to the background and open the view with it selected. In an attached background session, `←` detaches back to the view. |

`omp agents --json` prints the same sessions as JSON instead; `omp agents --cwd <dir>` limits the list to sessions working in `<dir>`. When stdout is not a terminal, `omp agents` prints a plain table.

## The list

Sessions are grouped by what they need, in this order:

| Group | Statuses |
| --- | --- |
| Needs input | The session asks a question or waits for an approval. |
| Error | The last turn ended with an error. |
| Working | Running a turn, compacting, or still starting. |
| Idle | Finished and waiting for the next prompt. |

Each row shows a status glyph (animated while running), the session title, its working directory, what it is doing or asking, and how long ago it was last active. Sessions running in a terminal of their own (foreground sessions) are dimmed and marked `fg`: they are listed but cannot be attached or stopped from the view; press `←` in their terminal to move them to the background. A session that more than one process has open is listed once.

The list refreshes every second. When a session starts waiting for input or fails, the terminal bell rings and the window title becomes `N awaiting input · omp agents`.

## Keys

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select a session. |
| `Enter` or `→` (empty prompt) | Attach to the selected background session. |
| Type, then `Enter` | Start a background session in the current directory with that prompt. |
| `/resume [query]`, then `Enter` | Pick a saved session with the `omp --resume` picker (filtered by `query`) and open it in the background, attached. A session that is already running is attached instead, or reported when it runs in another terminal. |
| `Ctrl+X` | Stop the selected background session, with any other background process on the same session (asks first; `y` or `Enter` confirms). |
| `Esc` | Clear the prompt; with an empty prompt, go back to the session you just left, or quit. |
| `q` (empty prompt), `Ctrl+C` | Quit. Background sessions keep running. |

A prompt line that starts with `/` is a command, never a new session; while you type one, the hint line lists the commands. `/resume` is the only command so far.

## Attaching

Attaching hands the terminal to the session: it repaints its full history and renegotiates keyboard, paste and mouse support for your terminal. Press `←` on an empty composer to detach back to the view. `Ctrl+Z` (the `app.suspend` key) also detaches, from anywhere — use it while a question or approval dialog has the keyboard. A background session never suspends itself. Only one terminal can be attached to a session at a time; attaching from a second terminal takes the session over and sends the first one back to its Agent View.

If the connection drops (for example when the daemon is upgraded), the view reports it and the session keeps running; attach again with `Enter`.

## Environment

A background session starts with a copy of the environment of the terminal that started it (when backgrounding with `←`, or the terminal running the Agent View for new sessions). Terminal-specific variables such as `SSH_*`, `TMUX*`, `ITERM_*`, `KITTY_*` and `VSCODE_*` are dropped. Everything else is kept, provider API keys and proxy settings included. Like every daemon-supervised process, the launch environment is stored in the daemon's private database under `~/.omp/run/daemon` (owner-only) for as long as the unit exists. Later changes in your shell do not reach a running background session; stop it and start it again to pick them up.

Status records live in `~/.omp/run/agents/status` (owner-only). They hold the session's title, working directory, model and current activity, never its environment.
