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

Older unqualified action names are migrated when `keybindings.yml` is loaded, but new docs and new configs should use the namespaced action IDs above. Existing `keybindings.json` files are still accepted and migrated to `keybindings.yml`; `keybindings.yaml` is also accepted.

## Vim editing mode

Off by default. Turn it on with **Vim Editing Mode** in `/settings` (Interaction → Input), or set it directly:

```yaml
tui.vimMode: true
```

The prompt then starts in Insert mode and behaves exactly as it always has. `Escape` switches to Normal mode; the prompt border changes color so the current mode is visible at a glance. While Vim mode is on, Insert draws a bar cursor and Normal/Visual a block — the software cursor always, the real terminal cursor via DECSCUSR under `PI_HARDWARE_CURSOR` — overriding the terminal's configured shape until the session restores it on exit. This is a useful subset of Vim, not a full implementation — enough for keyboard-only navigation and selection without adding more `Ctrl` chords that terminals, shells, and tmux already claim.

| Mode        | Enter with              | Leave with                                              |
| ----------- | ----------------------- | ------------------------------------------------------- |
| Insert      | `i` `a` `I` `A` `o` `O` | `Escape`                                                |
| Normal      | `Escape` from Insert    | any Insert-mode key                                     |
| Visual      | `v`                     | `Escape`, or an operator (`y` `d` `c`)                  |
| Visual line | `V`                     | `Escape`, or an operator (`y` `d` `c`)                  |

### Normal mode

| Keys                          | Meaning                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `h` `j` `k` `l`               | Move by character and line (arrow keys work too)               |
| `0` `^` `$`                   | Line start / first non-blank / line end                        |
| `w` `b` `e`                   | Next word, previous word, end of word                          |
| `gg` `G`                      | First line, last line (`5gg` and `5G` jump to line 5)          |
| `1`–`9` prefix                | Repeat a motion or operator, e.g. `3w`, `5j`, `2dd`            |
| `i` `a` `I` `A`               | Insert before / after cursor, at line start / line end         |
| `o` `O`                       | Open a line below / above and insert                           |
| `x` `D` `C`                   | Delete character, delete to line end (`2D` takes `count` lines), change to line end (`2C` likewise) |
| `d` `y` `c` + motion          | Operate over a motion, e.g. `dw`, `d$`, `yb`, `cw`             |
| `dd` `yy` `cc`                | Linewise delete / yank / change                                |
| `d` `y` `c` + text object     | Operate over a text object, e.g. `diw`, `ca(`, `ci"`, `dap`    |
| `p` `P`                       | Put the last yank or delete after / before the cursor          |
| `u`                           | Undo                                                            |

### Text objects

A text object follows an operator (`diw`) or extends a Visual selection (`viw`). `i` takes the inside, `a` takes the surroundings; counts apply, e.g. `d2aw`.

| Object            | Covers                                                                     |
| ----------------- | -------------------------------------------------------------------------- |
| `iw` `aw`         | Word; `aw` also takes the adjoining whitespace                             |
| `iW` `aW`         | Whitespace-delimited WORD                                                  |
| `i"` `i'` `` i` `` | Inside the quotes on the current line (`a"` takes the quotes too)          |
| `i(` `i[` `i{` `i<` | Inside the innermost matching pair, nesting-aware and across lines         |
| `a(` `a[` `a{` `a<` | The same pair including its delimiters (`b` and `B` alias `(` and `{`)     |
| `ip` `ap`         | Paragraph — the run of non-blank (or blank) lines, linewise                |

### Visual mode

`v` starts a character-wise selection and `V` a line-wise one; motions move the free end. `y` copies the selection to the system clipboard (and to the internal register, so `p` puts it back), `d` deletes it, and `c` deletes it and drops into Insert mode. `x` deletes like `d`, and `s` changes like `c`. `o` jumps to the other end of the selection. `Escape` cancels.

A selection that would cut through an attachment placeholder such as `[Image #1, 800x600]` or `[Paste #2, +30 lines]` takes the whole placeholder with it, so a delete can never leave a corrupt fragment behind.

### Escape

`Escape` is shared with the app-level interrupt, so Vim mode takes it only when it has something to do:

- **Insert mode** → switch to Normal mode.
- **Visual mode**, or a half-typed count or operator → cancel back to a quiet Normal mode.
- **Normal mode with nothing pending** → falls through to its usual meaning (dismiss autocomplete, abort the running turn, clear the draft).

Vim keys never shadow app chords: `Ctrl`-combinations, `Enter`, and `Tab` keep their normal behavior in every mode, so `Enter` still submits from Normal mode. Prompt history stays on `Up`/`Down` in Insert mode only — in Normal mode those keys are `k` and `j`, so navigating a multi-line draft never loads a previous prompt.
