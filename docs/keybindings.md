# Keybindings

Run `/hotkeys` inside an `omp` session for the built-in shortcut reference. Application-action rows reflect remaps loaded from disk; navigation/editing examples use fixed chords. This is not an inventory of extension-registered shortcuts.

Base editor, input, and selector actions use `tui.editor.*`, `tui.input.*`, and `tui.select.*`; application actions use `app.*`. Definitions live in `packages/coding-agent/src/config/keybindings/tui-keybindings.ts` and `packages/coding-agent/src/config/keybindings/app-keybindings.ts`; the keymap that loads `keybindings.yml` and matches keys is `packages/coding-agent/src/config/keybindings/keybindings.ts`.

The `tui.select.*` actions (`up`, `down`, `pageUp`, `pageDown`, `confirm`, `cancel`) drive every list: pickers, menus, settings pages, dialogs and the setup wizard. Editor and newline bindings work in text fields, including the prompt. `tui.editor.redo` applies only to the prompt with Vim mode off. `tui.input.submit` submits single-purpose inputs (renames, labels, form fields). Home/End, Space, Tab and ←/→ in lists, and Alt+Enter as a new line in fields, stay fixed. Key hints and button tooltips show the keys you bound.

## Customize keybindings

User remaps live in `~/.omp/agent/keybindings.yml`. The file is a YAML mapping whose keys are keybinding action IDs and whose values are either one chord string or an array of chord strings. It is not read from `~/.omp/agent/config.yml`, and there is no nested `keybindings` object.

With a named profile, bindings from the default profile's agent directory are loaded first and the active profile's `keybindings.yml` overrides them action by action. The inherited file is read-only during that profile's startup.

```yaml
app.model.cycleForward: Ctrl+P
app.model.selectTemporary: Alt+P
app.plan.toggle: Alt+Shift+P
```

Chord names are case-insensitive and use the same notation shown in the UI, such as `Ctrl+P`, `Alt+Shift+P`, `Shift+Enter`, and `Ctrl+Backspace`. Modifier order does not matter (`Shift+Ctrl+P` is `Ctrl+Shift+P`), `Esc`/`Return` mean `Escape`/`Enter`, and a symbol typed with Shift is written as the symbol itself: `?` and `Shift+?` are the same key.

If your terminal reports `Ctrl+Shift+Z` as a distinct chord, you can set `tui.editor.redo: ctrl+shift+z`.

Set an action to an empty array to disable it:

```yaml
app.history.search: []
```

## Common action IDs

| Action ID                    | Default                                                               | Meaning                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app.model.cycleForward`     | `Ctrl+P`                                                              | Cycle role models forward                                                                                                                              |
| `app.model.cycleBackward`    | `Shift+Ctrl+P`                                                        | Cycle role models backward                                                                                                                             |
| `app.model.selectTemporary`  | `Alt+P`                                                               | Pick a model temporarily for this session                                                                                                              |
| `app.model.select`           | `Alt+M`                                                               | Open the model selector and set roles                                                                                                                  |
| `app.plan.toggle`            | `Alt+Shift+P`                                                         | Toggle plan mode                                                                                                                                       |
| `app.history.search`         | `Ctrl+R`                                                              | Search prompt history                                                                                                                                  |
| `tui.editor.redo`            | `Ctrl+^`, `Ctrl+Shift+6`                                               | Redo an edit to the prompt with Vim mode off                                                                                                           |
| `app.tools.expand`           | `Ctrl+O`                                                              | Toggle tool-output expansion                                                                                                                           |
| `app.tools.toggleVisibility` | `Ctrl+Shift+O`                                                        | Show or hide tool activity                                                                                                                             |
| `app.links.hint`             | `Alt+O`                                                               | Tag each [extension link](./extensions.md#extension-link-schemes) on screen; type a tag to pick it, `Esc` cancels; again or `Page Up` browses all      |
| `app.ask.hide`               | `Alt+H`                                                               | Hide a pending `ask` question to one line (the Hide button in Tern); the same key, `Enter`, or Show brings it back                                     |
| `app.ask.note`               | `N`, `Alt+N`                                                          | Add or edit a note on the highlighted `ask` option; dropdowns use the first key that does not type text, since letters jump to options                 |
| `app.approval.approve`       | `Ctrl+Enter`, `Ctrl+Q`                                                | Approve a pending tool call outright (the Approve button in Tern); `Esc` denies, and `Enter` takes the Approve/Deny choice highlighted with the arrows |
| `app.thinking.toggle`        | `Ctrl+T`                                                              | Toggle thinking-block visibility                                                                                                                       |
| `app.thinking.cycle`         | `Shift+Tab`                                                           | Cycle thinking level                                                                                                                                   |
| `app.editor.external`        | `Ctrl+G`                                                              | Edit the draft in `$VISUAL` / `$EDITOR`                                                                                                                |
| `app.local.open`             | `Alt+G`                                                               | Pick a session `local://` file and edit it in `$VISUAL` / `$EDITOR` (same as `/local`)                                                                 |
| `app.message.followUp`       | `Ctrl+Q`, `Ctrl+Enter`                                                | Queue a follow-up message                                                                                                                              |
| `app.message.dequeue`        | `Alt+Up`, `Shift+Up`                                                  | Dequeue a queued message back into the editor                                                                                                          |
| `app.btw.inject`             | `Alt+I`                                                               | Send a `/btw` answer's steering prompt to the main session (needs `btw.inject`)                                                                        |
| `app.retry`                  | `F5`, `Alt+R`                                                         | Retry the last failed assistant turn                                                                                                                   |
| `app.display.reset`          | `Alt+L`                                                               | Reset terminal display                                                                                                                                 |
| `app.clipboard.copyLine`     | `Alt+Shift+L`                                                         | Copy the current line                                                                                                                                  |
| `app.clipboard.copyPrompt`   | `Alt+Shift+C`                                                         | Copy the whole prompt                                                                                                                                  |
| `app.clipboard.pasteTextRaw` | `Ctrl+Shift+V`, `Alt+Shift+V`                                         | Paste clipboard text without collapsing it                                                                                                             |
| `app.clipboard.pasteImage`   | Linux: `Ctrl+V`; macOS: `Ctrl+V`, `Cmd+V`; Windows: `Ctrl+V`, `Alt+V` | Paste from the clipboard (image preferred, text fallback)                                                                                              |
| `app.stt.pushToTalk`         | `Space`                                                               | Hold to record and release to transcribe. Remap this action or set it to `[]` to disable push-to-talk without disabling speech-to-text.                |
| `app.stt.toggle`             | Unbound                                                               | Start or stop speech-to-text recording with each press; independent of push-to-talk.                                                                   |
| `app.live.toggle`            | `Ctrl+L`                                                              | Start or stop live voice mode (same as `/live`)                                                                                                        |
| `app.agents.hub`             | `Alt+A`                                                               | [Open the Agent Hub](./agent-hub.md)                                                                                                                   |
| `app.session.delete`         | `Backspace`, `Delete`                                                 | Ask to delete the selected session in the resume picker; a key that also deletes backward edits a typed search query instead                           |
| `app.session.pin`            | `Alt+K`                                                               | Pin the selected session in the resume picker; pinned sessions stay on top, including in search results                                                |
| `app.session.unpin`          | `Alt+Shift+K`                                                         | Unpin the selected session in the resume picker                                                                                                        |
| `app.tree.previousBranch`    | Unbound                                                               | Jump to the previous visible branch in `/tree` ([details](./tree.md))                                                                                  |
| `app.tree.nextBranch`        | Unbound                                                               | Jump to the next visible branch in `/tree` ([details](./tree.md))                                                                                      |

To disable push-to-talk while keeping speech-to-text available through a separate toggle binding:

```yaml
app.stt.pushToTalk: []
app.stt.toggle: Ctrl+Shift+S
```

While speech-to-text is enabled, non-printable keys and chords assigned to `app.stt.pushToTalk` are reserved: a tap is swallowed instead of running its normal editing or application action. A plain printable key tap still types normally. Text-assistance transformations from initial taps are preserved; only unchanged literal repeat text is removed when a hold is recognized. Each configured alternative is independent; alternating between alternatives does not combine them into one hold. Hold detection requires a terminal that delivers key auto-repeat.

### Click to dictate in Tern

With `stt.enabled` on, the native composer shows a microphone beside Send. Click it to start recording without holding a key. While the speech model loads, the button shows **Starting…**; click it again to cancel. Once it changes to **Recording · Stop**, click it to stop, then wait for **Transcribing…** to finish.

Dictation started with this button stays in the draft, regardless of `stt.submitTrigger`. Review or edit the text, then press Enter or click Send. While dictation is recording or transcribing into the draft, Enter and Send do nothing.

For live English transcription, select **Nemotron 0.6B (live streaming, English)** in `omp setup speech`, or set `modelRoles.dictation` to `local/nemotron-streaming-en-0.6b`. Words appear in the draft while you speak. The first recording waits for the model to load before opening the microphone; start speaking when the button says **Recording · Stop**. Later recordings reuse the loaded model. See [local speech models](local-models.md#speech-to-text) for download and language details.

## Recover a cleared prompt

Press `Ctrl+C` to clear an unsent composer draft, then `Up` to recall it. Older drafts and submitted prompts share the existing Up/Down navigation. Recalled drafts remain editable and are never sent until you submit them.

Cleared drafts preserve whitespace, collapsed pastes, and image attachments in the current editor's bounded history (100 entries). They are not written to persistent prompt history and do not appear in `Ctrl+R` search. Closing the process discards these canceled drafts; the separate save-on-exit behavior still applies to text currently in the composer. This is not a per-agent stash: history follows the editor, including when Agent Hub changes focus.

The existing double-`Ctrl+C` exit behavior is unchanged. Empty clears do not add history entries.

Recovery is on by default. Turn off **Recall Cleared Drafts** in `/settings` under Interaction > Input, or set `composer.recallClearedDrafts: false`. This takes effect on the next clear without restarting; previously retained drafts remain in history until evicted or the editor closes.

On Windows Terminal, `Ctrl+V` may be handled by the terminal paste command before `omp` sees it; use the `Alt+V` fallback when clipboard image paste appears to do nothing. When the clipboard holds no image, `app.clipboard.pasteImage` pastes the clipboard text instead, so hosts that deliver only this chord (VS Code's integrated terminal when configured to forward `Ctrl+V`, Windows clipboard history via `Win+V`) work for both payload kinds. Windows Terminal also swallows `Ctrl+Enter`, so the `app.message.followUp` chord also binds `Ctrl+Q` — the same chord GitHub Copilot CLI uses — and the same chord submits the agent dashboard's new-agent description and hook-editor prompts. If your existing `keybindings.yml` already assigns `Ctrl+Q` to another action, that user remap wins and follow-up keeps `Ctrl+Enter` unless you explicitly bind `app.message.followUp`.

Terminals that implement OSC 5522 enhanced paste can send clipboard MIME data directly to `omp`; image pastes are attached as `[Image #N]`, while text/plain paste events keep normal paste behavior. When OSC 5522 is unavailable, bracketed paste still handles text, and a pasted single image-file path is loaded as an image when the file is readable from the `omp` host.

Older unqualified action names are migrated when `keybindings.yml` is loaded, but new docs and new configs should use the namespaced action IDs above. Existing `keybindings.json` files are still accepted and migrated to `keybindings.yml`; `keybindings.yaml` is also accepted.

## Vim editing mode

Off by default. Turn it on with **Vim Editing Mode** in `/settings` (Interaction → Input), or set it directly:

```yaml
tui.vimMode: true
```

Each prompt starts in Insert mode, or in Normal mode with **Vim Start Mode** (`tui.vimStartMode: normal`): at startup, after every message you send, and in dialog text boxes. `Escape` switches to Normal mode; the prompt border changes color to show the mode (bash/python mode colors take precedence). The software cursor underlines the current character in Insert mode and uses a block in Normal mode; at line end Insert uses a bar, and Visual mode highlights the selection. The terminal cursor shape is set via DECSCUSR to a bar in Insert and a block in Normal/Visual, and restored on exit. This is a useful subset of Vim, not a full implementation.

The status line also shows the mode, the command being typed, and multi-line Visual selection size. **Vim Mode Indicator** (`tui.vimModeDisplay`) selects `text` (default), `icon`, or `none` (hides the mode). **Vim Show Command** (`tui.vimShowCommand`, on by default) echoes a half-typed command like Vim's `showcmd`, so `15d` shows before its last `d`; it shows even when the mode is hidden. Turn it off to hide it.

Text boxes in dialogs use the same Vim mode: ask-form textareas, one-line text fields, "Other" answers, and option notes, and the ask tool's typed answers and extension text prompts. There `Escape` first leaves Insert mode, and only a second `Escape` closes the note, hands the keys back to the composer, or cancels the prompt. Password fields stay plain. The terminal cursor shape follows whichever box has the keys. On an ask form's option rows and Submit, `j` and `k` move down and up like the arrow keys, and in a text box in Normal mode they leave it from its last or first line. A dropdown keeps `j` and `k` for its letter type-ahead; use the arrow keys there.

| Mode        | Enter with              | Leave with                             |
| ----------- | ----------------------- | -------------------------------------- |
| Insert      | `i` `a` `I` `A` `o` `O` | `Escape`                               |
| Normal      | `Escape` from Insert    | any Insert-mode key                    |
| Visual      | `v`                     | `Escape`, or an operator (`y` `d` `c`) |
| Visual line | `V`                     | `Escape`, or an operator (`y` `d` `c`) |

### Normal mode

| Keys                                | Meaning                                                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `h` `j` `k` `l`                     | Move by character and line (arrow keys work too). Past the first line, `k` (and `-`) loads the previous prompt from history, and past the last line `j` (and `+`) the next one, as in zsh's vi mode; `j` past the newest prompt brings back your draft, undo history included. Edits to a recalled prompt are kept until you send |
| `gj` `gk`                           | Move by screen row through a wrapped line, keeping the screen column (`j`/`k` move by whole lines, as in Vim)                                                                     |
| `0` `^` `$`                         | Line start / first non-blank / line end                                                                                                                                           |
| `-` `+` `_`                         | Previous / next / current line, on its first non-blank; linewise under an operator (`d-`, `c+`, `2d_`)                                                                            |
| `w` `b` `e` `ge` / `W` `B` `E` `gE` | Move by word / whitespace-delimited WORD, across lines like Vim (an empty line counts as a word)                                                                                  |
| `f` `F` `t` `T` + char              | Find / till that character on the line (`;` repeats, `,` reverses)                                                                                                                |
| `gg` `G`                            | First line, last line, on its first non-blank (`5gg` and `5G` jump to line 5)                                                                                                     |
| `1`–`9` prefix                      | Repeat a motion or operator, e.g. `3w`, `5j`, `2dd`                                                                                                                               |
| `i` `a` `I` `A`                     | Insert before / after cursor, at line start / line end; a count repeats the typed text (`3ix` types `xxx`)                                                                        |
| `o` `O`                             | Open a line below / above and insert (`2ofoo` opens two)                                                                                                                          |
| `gi`                                | Insert where Insert mode was last left                                                                                                                                            |
| `x` `X`                             | Delete the character under / before the cursor                                                                                                                                    |
| `D` `C` `Y`                         | `d$`, `c$`, and `yy` (`2D` deletes to the end of the next line)                                                                                                                   |
| `s` `S`                             | Substitute: `s` is `cl` (`3s` changes three characters), `S` is `cc` (`2S` changes two lines)                                                                                     |
| `r` + char                          | Replace the character under the cursor (`3rx` replaces three)                                                                                                                     |
| `R`                                 | Replace mode: typed characters overwrite until Escape                                                                                                                             |
| `~`                                 | Toggle the case of the character under the cursor and move right (`3~` toggles three)                                                                                             |
| `%`                                 | Jump to the matching `()` `[]` `{}` `"` `'` on or after the cursor. Quotes stay on the line; brackets can cross lines. With a count, `50%` goes to that percentage of the buffer. |
| `{` `}`                             | Previous / next paragraph (blank-line boundary)                                                                                                                                   |
| `J` `gJ`                            | Join lines; `J` drops the indent of the following line (an empty line joins without a space), `gJ` keeps all whitespace                                                           |
| `>>` `<<`                           | Indent / outdent by two spaces (`3>>` shifts three lines; `>}` shifts a motion). Empty lines are left alone.                                                                      |
| `d` `y` `c` + motion                | Operate over a motion, e.g. `dw`, `d$`, `yb`, `cw`; a multi-line delete that starts in the indent becomes linewise, as in Vim                                                     |
| `g~` `gu` `gU` + motion             | Toggle / lower / upper case over a motion or text object (`gUiw`); doubled (`gUU`, `guu`, `g~~`) for whole lines                                                                  |
| `dd` `yy` `cc`                      | Linewise delete / yank / change; `cc` keeps one empty line and stores the old lines whole, so `p` puts them back as lines                                                         |
| `d` `y` `c` + text object           | Operate over a text object, e.g. `diw`, `ca(`, `ci"`, `dap`                                                                                                                       |
| `p` `P` / `gp` `gP`                 | Put after / before the cursor; `gp` and `gP` leave the cursor just past the put text                                                                                              |
| `"x` prefix                         | Use register `x` for the next yank, delete, or put (see [Registers](#registers))                                                                                                  |
| `u` `Ctrl+R`                        | Undo / redo, with counts (`3u`); a whole Insert session, or a whole `.`, is one step, and the cursor returns to where the change began                                            |
| `/` `?`                             | Open prompt-history search, the same one `Ctrl+R` opens                                                                                                                           |
| `:`                                 | On an empty prompt, start a slash command: types `/` in Insert mode, so the command menu opens. With a draft it does nothing                                                      |
| `.`                                 | Repeat the last change, including text typed in the Insert session it opened; a count replaces the original one (`3.`)                                                            |
| `gv`                                | Reselect the last Visual selection                                                                                                                                                |

### Text objects

A text object follows an operator (`diw`) or extends a Visual selection (`viw`). `i` takes the inside, `a` takes the surroundings; counts apply, e.g. `d2aw`.

| Object              | Covers                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| `iw` `aw`           | Word; `aw` also takes the adjoining whitespace                         |
| `iW` `aW`           | Whitespace-delimited WORD                                              |
| `i"` `i'` `` i` ``  | Inside the quotes on the current line (`a"` takes the quotes too)      |
| `i(` `i[` `i{` `i<` | Inside the innermost matching pair, nesting-aware and across lines; with none around the cursor, the next pair ahead, as in Vim 9.2 |
| `a(` `a[` `a{` `a<` | The same pair including its delimiters (`b` and `B` alias `(` and `{`) |
| `ip` `ap`           | Paragraph — the run of non-blank (or blank) lines, linewise            |

### Visual mode

`v` starts a character-wise selection and `V` a line-wise one; motions move the free end, and `$` extends through the line break. `y` copies the selection to the register, so `p` puts it back (the system clipboard only with `"+` or `tui.vimYankToClipboard`, see [Registers](#registers)), `d` deletes it, and `c` deletes it and drops into Insert mode. `x` deletes like `d`, `s` changes like `c`, `r` + char replaces every character, `u` / `U` / `~` lower / upper / toggle its case, and `J` / `gJ` join its lines. `X`, `D`, `Y`, `C`, `S`, and `R` act on every line the selection touches, even a character-wise one. `p` and `P` replace the selection with the register (`p` then keeps the replaced text in the register; `P` leaves the register alone). `o` jumps to the other end of the selection. `Escape` cancels.

### Registers

Yanks and deletes fill registers the way Vim's do. An unnamed `p` puts the latest one; `"x` picks another:

| Register  | Holds                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `"a`–`"z` | Named registers; `"A`–`"Z` append to them                                                                 |
| `"0`      | The last yank made without a register name                                                                |
| `"1`–`"9` | Deletes of whole lines or several lines, newest in `"1`                                                   |
| `"-`      | The last delete within a line                                                                             |
| `"_`      | Black hole: the delete is not stored anywhere                                                             |
| `"+` `"*` | The system clipboard: `"+y` copies to it and `"+p` puts it (text ending in a newline puts as whole lines) |

Text killed in Insert mode (`Ctrl+K`, `Ctrl+W`) is what an unnamed `p` puts until Vim stores something newer, and Vim's yanks and deletes stay on the kill ring for `Ctrl+Y`.

Only `"+y` and `"*y` copy to the system clipboard, as in Vim. Turn on **Vim Yanks Copy to Clipboard** (`tui.vimYankToClipboard: true`) to make every yank copy there too, as in Vim with `clipboard=unnamed`. Deletes reach the clipboard only through `"+` / `"*`.

A selection that would cut through an attachment chip such as `📷 #1` or `📄 #2` takes the whole chip with it, so a delete can never leave a corrupt fragment behind.

### Escape

`Escape` is shared with the app-level interrupt, so Vim mode takes it only when it has something to do:

- **Insert mode** → switch to Normal mode (an open autocomplete popup gets the first Escape to dismiss it).
- **Visual mode**, or a half-typed count or operator → cancel back to a quiet Normal mode.
- **Replace mode** (`R`) → switch to Normal mode, stepping back onto the last overwritten character.
- **Normal mode with nothing pending** → falls through to app behavior: dismiss autocomplete, abort active work, or run the configured double-Escape action with an empty editor. An idle main-session draft is preserved; bash/python and focused-agent views have their own Escape behavior.

Vim keys never shadow app chords: `Ctrl`-combinations, `Enter`, and `Tab` keep their normal behavior in every mode, so `Enter` still submits from Normal mode. There are two exceptions: `Ctrl+R` is Vim's redo in Normal mode (history search stays on it in Insert mode), and `Ctrl+[` does what `Escape` does inside the Vim modes, whichever keyboard protocol the terminal uses. Such a key also cancels a half-typed command (`d`, `r`, `f`) first, so the command never carries over into the next prompt. In Normal mode `Up`/`Down` are `k`/`j`, history steps included; in Insert mode they browse history as without Vim mode.

Not supported: marks (`m`, `'`, `` ` ``), searching the draft (`/` and `?` open history search), `n` / `N`, `*` and `#`, macros (`q`, `@`), `Ctrl+A` / `Ctrl+X`, line undo (`U`), and Ex commands (`:` only starts a slash command).
