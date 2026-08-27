# Keybindings

Run `/hotkeys` inside an `omp` session to see the active chords for your current build. The list reflects any remaps loaded from disk and any bindings added by extensions.

## Customize keybindings

User remaps live in `~/.omp/agent/keybindings.yml`. The file is a YAML mapping whose keys are keybinding action IDs and whose values are either one chord string or an array of chord strings. It is not read from `~/.omp/agent/config.yml`, and there is no nested `keybindings` object.

With a named profile, bindings from the default profile's agent directory are loaded first and the active profile's `keybindings.yml` overrides them action by action. The inherited file is read-only during that profile's startup.

```yaml
app.model.cycleForward: Ctrl+P
app.model.selectTemporary: Alt+P
app.plan.toggle: Alt+Shift+P
```

Chord names are case-insensitive and use the same notation shown in the UI, such as `Ctrl+P`, `Alt+Shift+P`, `Shift+Enter`, and `Ctrl+Backspace`.

Set an action to an empty array to disable it:

```yaml
app.history.search: []
```

## Common action IDs

| Action ID                    | Default                                                               | Meaning                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app.model.cycleForward`     | `Ctrl+P`                                                              | Cycle role models forward                                                                                                                                                            |
| `app.model.cycleBackward`    | `Shift+Ctrl+P`                                                        | Cycle role models backward                                                                                                                                                           |
| `app.model.selectTemporary`  | `Alt+P`                                                               | Pick a model temporarily for this session                                                                                                                                            |
| `app.model.select`           | `Alt+M`                                                               | Open the model selector and set roles                                                                                                                                                |
| `app.plan.toggle`            | `Alt+Shift+P`                                                         | Toggle plan mode                                                                                                                                                                     |
| `app.history.search`         | `Ctrl+R`                                                              | Search prompt history                                                                                                                                                                |
| `app.transcript.open`        | `Alt+U`                                                              | Open the fullscreen transcript reader at the latest final answer (same as `/reader`)                                                                                                 |
| `app.tools.expand`           | `Ctrl+O`                                                              | Toggle tool-output expansion                                                                                                                                                         |
| `app.tools.toggleVisibility` | `Ctrl+Shift+O`                                                        | Show or hide tool activity                                                                                                                                                           |
| `app.thinking.toggle`        | `Ctrl+T`                                                              | Toggle thinking-block visibility                                                                                                                                                     |
| `app.thinking.cycle`         | `Shift+Tab`                                                           | Cycle thinking level                                                                                                                                                                 |
| `app.editor.external`        | `Ctrl+G`                                                              | Edit the draft in `$VISUAL` / `$EDITOR`                                                                                                                                              |
| `app.message.followUp`       | `Ctrl+Q`, `Ctrl+Enter`                                                | Queue a follow-up message                                                                                                                                                            |
| `app.message.dequeue`        | `Alt+Up`, `Shift+Up`                                                  | Dequeue a queued message back into the editor                                                                                                                                        |
| `app.retry`                  | `Alt+R`                                                               | Retry the last failed assistant turn                                                                                                                                                 |
| `app.display.reset`          | `Alt+L`                                                               | Reset terminal display                                                                                                                                                               |
| `app.clipboard.copyLine`     | `Alt+Shift+L`                                                         | Copy the current line                                                                                                                                                                |
| `app.clipboard.copyPrompt`   | `Alt+Shift+C`                                                         | Copy the whole prompt                                                                                                                                                                |
| `app.clipboard.pasteTextRaw` | `Ctrl+Shift+V`, `Alt+Shift+V`                                         | Paste clipboard text without collapsing it                                                                                                                                           |
| `app.clipboard.pasteImage`   | Linux: `Ctrl+V`; macOS: `Ctrl+V`, `Cmd+V`; Windows: `Ctrl+V`, `Alt+V` | Paste from the clipboard (image preferred, text fallback)                                                                                                                            |
| `app.stt.toggle`             | Unbound (hold `Space`)                                                | Toggle speech-to-text. By default there is no key chord — hold the space bar to record (push-to-talk) and release to transcribe; bind a chord here for a press-to-toggle alternative |
| `app.live.toggle`            | `Ctrl+L`                                                              | Start or stop live voice mode (same as `/live`)                                                                                                                                      |
| `app.agents.hub`             | `Alt+A`                                                               | [Open the Agent Hub](./agent-hub.md)                                                                                                                                                 |

On Windows Terminal, `Ctrl+V` may be handled by the terminal paste command before `omp` sees it; use the `Alt+V` fallback when clipboard image paste appears to do nothing. When the clipboard holds no image, `app.clipboard.pasteImage` pastes the clipboard text instead, so hosts that deliver only this chord (VS Code's integrated terminal when configured to forward `Ctrl+V`, Windows clipboard history via `Win+V`) work for both payload kinds. Windows Terminal also swallows `Ctrl+Enter`, so the `app.message.followUp` chord also binds `Ctrl+Q` — the same chord GitHub Copilot CLI uses — and the same chord submits the agent dashboard's new-agent description and hook-editor prompts. If your existing `keybindings.yml` already assigns `Ctrl+Q` to another action, that user remap wins and follow-up keeps `Ctrl+Enter` unless you explicitly bind `app.message.followUp`.

Terminals that implement OSC 5522 enhanced paste can send clipboard MIME data directly to `omp`; image pastes are attached as `[Image #N]`, while text/plain paste events keep normal paste behavior. When OSC 5522 is unavailable, bracketed paste still handles text, and a pasted single image-file path is loaded as an image when the file is readable from the `omp` host.

## Latest answer transcript reader

Press `Alt+U` or run `/reader` to open the current session transcript with the latest agent's final answer at the top of the reader, skipping prior tool work and visible reasoning. Use `Up`/`Down`, `Shift+Up`/`Shift+Down`, `PageUp`/`PageDown`, `Home`/`End`, `j`/`k`, `g`/`G`, or the mouse wheel to navigate. Press `r` to return to the answer start and `Esc` or `Ctrl+C` to close the reader.

The reader uses a fullscreen alternate buffer rather than a clickable control in the normal transcript. Normal-buffer mouse capture would interfere with native terminal selection and wheel scroll, and terminal scrollback position is not owned by OMP's semantic transcript renderer.

Older unqualified action names are migrated when `keybindings.yml` is loaded, but new docs and new configs should use the namespaced action IDs above. Existing `keybindings.json` files are still accepted and migrated to `keybindings.yml`; `keybindings.yaml` is also accepted.
