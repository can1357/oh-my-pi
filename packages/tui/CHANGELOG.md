# Changelog

## [Unreleased]

### Breaking Changes

- `StatusLineHost.resetExpiryNotice` now receives the session first and owns deduplication; `StatusLineComponent` no longer limits the saved-reset expiry warning to once per conversation

### Added

- Added file-backed task previews and optional `taskFile` and `taskFileSha256` provenance on `AgentProgress` and `SingleResult` ([#17133](https://github.com/can1357/oh-my-pi/pull/17133) by [@iliaal](https://github.com/iliaal)).
- Added `Editor.nativeTypeahead` (published as the TSP `typeahead` prop) and `Composer.releaseHeldInput()`: a deferred-input `Composer.start` asks Tern to keep and draw startup typing until the app releases the held input
- Added `PI_LINK_SCHEME` and `PI_LINK_HOST` for host-qualified file links with optional line and column positions in remote sessions ([#15855](https://github.com/can1357/oh-my-pi/pull/15855) by [@KunoLu](https://github.com/KunoLu)).
- `AssistantMessageComponent` accepts display-only assistant text renderers and redraws one reply with `rerenderMessage(timestamp)`; `splitAssistantMessageToolTimeline` reports each segment's `contentOffsets` ([#16238](https://github.com/can1357/oh-my-pi/pull/16238) by [@materemias](https://github.com/materemias))
- `setExtensionLinks()` makes markdown draw links of registered schemes as a dotted-underlined label without URL suffix or terminal hyperlink; `Composer.viewportLinkAt()` and `Composer.startLinkHints()` / `typeLinkHint()` pick them by click or keyboard tag (new `app.links.hint` keybinding, Alt+O) ([#16239](https://github.com/can1357/oh-my-pi/pull/16239) by [@materemias](https://github.com/materemias))
### Changed

- Improved view placement for JSON trees when output lines are column‑capped
- On a terminal expected to speak TSP, a `deferInput` start delivers plain typing (printable text, Backspace) to the focused component live; only the first other key and the keys after it wait for `TUI.releaseHeldInput()`
- In Tern builds that support it, JSON tool results, MCP arguments, eval JSON output and structured subagent results appear in Tern's own interactive JSON viewer: small objects and arrays show whole on one line, larger ones fold to a one-line preview you click to expand
- JSON trees elsewhere are more compact: objects and arrays that fit about 60 characters show on one row (`0: [[3, "vt"], 98]`), and array indices show as dim, right-aligned numbers instead of `[0]`
- In Tern, `omp setup` is a native page: a step bar over searchable Sign in and default model sheets (the highlighted model stays in view as you arrow), and it skips the glyph, composer shape and theme steps, which Tern draws itself
- Signing in during `omp setup` uses the same sign-in dialog as `/login`
### Fixed

- Fixed the LSP diagnostics view showing "No issues" for files whose language server had not reported yet; they now show as unverified ([#17293](https://github.com/can1357/oh-my-pi/pull/17293) by [@JustasMasiulis](https://github.com/JustasMasiulis))

## [18.13.3] - 2026-10-28

### Added

- The resume picker renames the selected session in place: F2 opens a dialog prefilled with the current title, Enter commits, Esc cancels ([#17262](https://github.com/can1357/oh-my-pi/pull/17262) by [@Twilight0](https://github.com/Twilight0))

### Changed

- Updated Bun engine requirement to ≥1.4.4

### Fixed

- Restored WebP and JPEG images stay visible in Kitty scrollback after resuming a session ([#17220](https://github.com/can1357/oh-my-pi/issues/17220)).
- Escape in an annotation note no longer discards it: the overlay closes and `getDraft()`/`restoreDraft()` let the host keep and reopen the note; **Discard notes and close** (confirmed by a second press) clears them instead, and code review's actions start on Paste so a stray Enter never sends the LLM review ([#17271](https://github.com/can1357/oh-my-pi/pull/17271) by [@H4vC](https://github.com/H4vC), based on [#17230](https://github.com/can1357/oh-my-pi/pull/17230) by [@Shadorain](https://github.com/Shadorain)).
- Fixed terminal replies such as Tern's `tsp;e;{"ev":"ack",…}` showing up in the shell prompt after quitting omp; the exit drain now waits for the terminal to answer a final DA1 sentinel
- Fixed the plan review sheet in Tern squeezing the "continue with" model tiers under a long plan, so the model name overlapped the tier buttons
- `/usage` in Tern shows when each quota resets as a countdown (`resets in 2h30m`) instead of a clock time; hovering shows the date and time
- Fixed extension `ui.select` dialogs treating unconfigured `j`/`k` keys as navigation, which could turn a default No into Yes when typing `ok` then Enter ([#17255](https://github.com/can1357/oh-my-pi/pull/17255) by [@SAKANA-MOONLIGHT](https://github.com/SAKANA-MOONLIGHT)).

### Removed

- Removed support for the TSP `t` (theme) verb, as surface theme synchronization is no longer required

## [18.13.2] - 2026-10-27

### Added

- Added a frame-write listener (`TUI.addFrameWriteListener`) for terminal integrations that need to react to emitted ANSI output, including resize paints ([#17145](https://github.com/can1357/oh-my-pi/issues/17145))
- `HookInputComponent` (`showHookInput`) now accepts `{ secret: true }` to mask typed characters as bullets (`•`) in input overlays ([#17080](https://github.com/can1357/oh-my-pi/pull/17080) by [@GTanger](https://github.com/GTanger))
- Added an ANSI and native `/context` viewer with category navigation, content inspection, token-usage and compaction estimates, and keyboard/mouse controls that adapt across Tern and other terminals ([#16160](https://github.com/can1357/oh-my-pi/pull/16160) by [@C-W-Z](https://github.com/C-W-Z)).

### Fixed

- Fixed `AskDialogComponent`'s draft input guard holding the keyboard until the draft was cleared; Up/Down (or a pointer action) now release it so the question can be answered with the draft parked, and `syncPresentation` receives the effective blocked state ([#17215](https://github.com/can1357/oh-my-pi/pull/17215) by [@H4vC](https://github.com/H4vC))
- Fixed the prompt editor's autocomplete popup (e.g. emoji suggestions after `:D`) staying open and following the cursor after Shift/Ctrl/Alt+Enter inserted a newline, so the next Enter submitted past a stale list; newlines and cursor motion (arrows, Home/End, word jumps, character jumps) now close it ([#17215](https://github.com/can1357/oh-my-pi/pull/17215) by [@H4vC](https://github.com/H4vC))
- Fixed `run_watch` failed-job rows hiding why a job's logs are unavailable; multiline `gh` errors now stay on one row ([#17173](https://github.com/can1357/oh-my-pi/pull/17173) by [@alphastorm](https://github.com/alphastorm))

### Removed

- Removed the static context usage report (`ContextUsageView`, `renderContextUsage`, `describeContextUsage`), `contextUsageHead()`, and the `glyph` and `color` fields of `ContextBreakdown` categories; use `ContextViewer` ([#16160](https://github.com/can1357/oh-my-pi/pull/16160) by [@C-W-Z](https://github.com/C-W-Z)).
- Fixed Markdown tables inside list items disappearing from the terminal transcript ([#17165](https://github.com/can1357/oh-my-pi/issues/17165)).

## [18.13.1] - 2026-10-27

### Added

- ANSI and TSP `/pause` screens show unsettled turns and jobs, hide settled counters, and preserve counts and resume controls on short terminals ([#17073](https://github.com/can1357/oh-my-pi/pull/17073) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added `noteOption` to `ExtensionAskDialogResultItem`, `QuestionResult`, and single-question `AskToolDetails`: the label of the option an ask note is on (unset for a note on the custom answer) ([#17126](https://github.com/can1357/oh-my-pi/pull/17126) by [@H4vC](https://github.com/H4vC))

### Changed

- `StatusLineComponent.setRunningSubagents()` and `setSubagentTreeCost()` now report whether their state changed, allowing callers to skip redundant redraws ([#17131](https://github.com/can1357/oh-my-pi/pull/17131) by [@iliaal](https://github.com/iliaal)).

### Fixed

- Fixed the ask dialog's Note (button or `n`) right after a pick moved to the next question annotating that question's highlighted row instead of the answer just picked ([#17126](https://github.com/can1357/oh-my-pi/pull/17126) by [@H4vC](https://github.com/H4vC))
- Fixed the ask dialog's Next button reopening the custom-answer editor after Other was cancelled instead of moving on to the next question or Review tab

## [18.13.0] - 2026-10-26

### Breaking Changes

- `CoordinationOp` no longer includes `"jobs"`, which no tool has produced since `wait` and `proc://` replaced the `hub` tool ([#16763](https://github.com/can1357/oh-my-pi/pull/16763) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a table's last rows (such as its bottom border) going blank in scrollback when its SIXEL chart was drawn while the reply kept streaming, with the chart painted over them ([#16870](https://github.com/can1357/oh-my-pi/issues/16870))
- Fixed Tern MCP tool cards showing only a clipped one-line summary of the arguments; the call and result cards now include a folded `Args` section with the full arguments ([#16765](https://github.com/can1357/oh-my-pi/issues/16765))
- Fixed pasting an API key or redirect URL into the setup wizard's provider sign-in prompt silently doing nothing ([#16898](https://github.com/can1357/oh-my-pi/pull/16898) by [@camiloeferrera](https://github.com/camiloeferrera))
- Fixed the usage dashboard averaging distinct quota buckets that share a label and window (Google Antigravity's Gemini and Gemini 4 Argon weeklies) into one row, which masked a drained bucket as "50% left"; buckets now group by quota identity, and shared Claude/GPT copies still merge ([#16790](https://github.com/can1357/oh-my-pi/issues/16790))

### Added

- Added `modelEnds` to `GroupedFileSection`: per file, the model-line index just past its last line, so a caller cutting the output can tell which files it shows whole ([#16594](https://github.com/can1357/oh-my-pi/pull/16594) by [@will-bogusz](https://github.com/will-bogusz))
- Added an optional `title` to `BtwHistoryRecord` and a `title` option to `BtwPanelComponent`: the `/btw` panel, history list and thread show it as the topic heading in place of the question, so a side command reads as `/sitrep` instead of its expanded template ([#16815](https://github.com/can1357/oh-my-pi/pull/16815) by [@wolfiesch](https://github.com/wolfiesch))
- Vim mode now supports `.` to repeat the last change, including the text typed in Insert or Replace mode, with Vim's count rules; `u` undoes a whole Insert session or `.` in one step ([#16872](https://github.com/can1357/oh-my-pi/pull/16872) by [@Shadorain](https://github.com/Shadorain))
- Added the `app.local.open` keybinding (default `Alt+G`) and its keyboard shortcuts row ([#16873](https://github.com/can1357/oh-my-pi/pull/16873) by [@Shadorain](https://github.com/Shadorain))
- Added `errorKind` to `EditToolDetails`, set on a failed edit ([#16608](https://github.com/can1357/oh-my-pi/pull/16608) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- Command and eval output panes no longer re-style and re-join their whole output on every frame, so a long command's output stops costing frame time while it sits in the transcript ([#16779](https://github.com/can1357/oh-my-pi/pull/16779) by [@yuzu-octopus](https://github.com/yuzu-octopus))

### Fixed

- Fixed typo underlines changing when the cursor or selection splits a word ([#16821](https://github.com/can1357/oh-my-pi/issues/16821))
- Fixed completed `vibe_wait` and `vibe_list` worker cards repeatedly entering scrollback as elapsed time advanced after partial retirement; completed walls now retain a static snapshot while in-flight waits continue updating.
- Fixed resuming a session with a recorded tool-call path that cannot be turned into a link, which crashed the TUI while it rebuilt the context ([#16806](https://github.com/can1357/oh-my-pi/pull/16806) by [@laviRZ](https://github.com/laviRZ))
- Fixed the Agent Hub reordering its rows on every heartbeat while the session's saved subagents loaded, so no row could be selected until the load ended: a row's place is now fixed when the hub first shows it, an agent the load finds takes its place in the status/recency ranking, and every other new generation goes on top ([#10524](https://github.com/can1357/oh-my-pi/issues/10524), [#16952](https://github.com/can1357/oh-my-pi/pull/16952) by [@lemonleks](https://github.com/lemonleks))
- Fixed the BTW history follow-up composer refusing pasted images; it now attaches them as `[Image #N]` markers and sends the ones whose marker stays in the draft ([#16805](https://github.com/can1357/oh-my-pi/pull/16805) by [@lemonleks](https://github.com/lemonleks))
- Fixed long URLs in fenced code blocks opening only their first visual line on ctrl/cmd-click; each wrapped fragment now carries the full OSC 8 hyperlink when the terminal supports it ([#16740](https://github.com/can1357/oh-my-pi/pull/16740) by [@OriginalByteMe](https://github.com/OriginalByteMe))
- Fixed the newest inline charts and images at the bottom of the screen showing as text placeholders while older ones stayed rendered once a session (or a resumed one) holds more than `tui.maxInlineImages` images ([#16660](https://github.com/can1357/oh-my-pi/issues/16660))
- Fixed Markdown tables in the terminal ignoring their column alignment, so right-aligned and centered columns rendered flush left ([#16658](https://github.com/can1357/oh-my-pi/pull/16658) by [@adi-IL](https://github.com/adi-IL))
- Grep, Glob, Find, and AST Grep result headers wrap a long pattern instead of cutting it off, so the match/file counts and `truncated` warning stay visible ([#16635](https://github.com/can1357/oh-my-pi/issues/16635))

## [18.12.6] - 2026-10-21

### Changed

- In Tern, centered sheets (`/context`, reports, keyboard shortcuts, BTW history, session info, the pause screen) fill the pane when it is narrower than 100 columns instead of floating with margins ([#16676](https://github.com/can1357/oh-my-pi/pull/16676) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed the `/agents` and `/models` hubs in Tern squeezing the left sidebar as long lines (such as a streaming new-agent draft) widen the body pane

## [18.12.4] - 2026-10-20

### Added

- Added `mergeLineRanges` and an optional `BareLineMode` argument to `parseLineRanges` (`"single"` reads a lone bare `N` as that one line) ([#16435](https://github.com/can1357/oh-my-pi/pull/16435) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- `selectorLineRanges()` reads a bare `N` compounded with `raw` (`17:raw`, `raw:17`) as the single line `N`; `parseLineRanges()` takes an optional `"single"` mode for the same rule ([#16438](https://github.com/can1357/oh-my-pi/pull/16438) by [@will-bogusz](https://github.com/will-bogusz))
- Collapsed `wait` cards show one row per finished job (or a single "waiting on N jobs" line) instead of re-printing the whole job tree on every poll; Ctrl+O shows the full tree ([#16486](https://github.com/can1357/oh-my-pi/pull/16486) by [@H4vC](https://github.com/H4vC))
- Bash cards show the elapsed time while a command runs, and wall time, timeout and backgrounded job in the bottom border instead of a separate `⟨…⟩` line ([#16486](https://github.com/can1357/oh-my-pi/pull/16486) by [@H4vC](https://github.com/H4vC))
- The terminal `/jobs` sheet shows the selected job's full command ([#16486](https://github.com/can1357/oh-my-pi/pull/16486) by [@H4vC](https://github.com/H4vC))
- Grep, glob, find, IRC message, and `proc://`/`agent://`/`cfg://` result rows start at the same column as other tool rows ([#16486](https://github.com/can1357/oh-my-pi/pull/16486) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed Tern sessions logging `TSP: terminal stopped acknowledging frames` every 5 seconds for as long as the terminal stops acknowledging frames; it now warns once per stall and logs the stall's length when acknowledgements resume ([#16393](https://github.com/can1357/oh-my-pi/pull/16393) by [@will-bogusz](https://github.com/will-bogusz))
- `splitPathAndSel` and `splitInternalUrlSel` peel comma line lists that include a tail chunk (`:1-12,-15`) or repeat the colon after a comma (`:1-30,:-30`, also beside `:raw`); `splitPathAndSel(path, { foldListColons: false })` keeps the repeated colon in the path ([#16435](https://github.com/can1357/oh-my-pi/pull/16435) by [@will-bogusz](https://github.com/will-bogusz))
- Generic tool cards now reveal the complete result when expanded ([#15335](https://github.com/can1357/oh-my-pi/pull/15335) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Added `footerMeta` to `OutputBlockOptions` and `ToolCardSnapshot` to draw short facts inside a frame's bottom border ([#16486](https://github.com/can1357/oh-my-pi/pull/16486) by [@H4vC](https://github.com/H4vC))
- Fixed markdown table rows shattering at narrow widths when a wide glyph sat in a one-cell column; the glyph is now clamped to its column instead of re-wrapping the row ([#16479](https://github.com/can1357/oh-my-pi/pull/16479) by [@adi-IL](https://github.com/adi-IL)).
- Fixed charts in answers drawing as blank bands, on screen and in scrollback, when iTerm2 drew them in a background tab; inline images now carry an explicit height in rows ([#16471](https://github.com/can1357/oh-my-pi/pull/16471) by [@galtamam-cmyk](https://github.com/galtamam-cmyk))
- Fixed an inline image (such as a table's chart) disappearing in iTerm2 when new output pushed it past the top of the screen; it now moves to scrollback whole ([#16467](https://github.com/can1357/oh-my-pi/pull/16467) by [@galtamam-cmyk](https://github.com/galtamam-cmyk))
- Fixed inline images, hyperlinks, notifications and styled underlines staying off in iTerm2 sessions reached over SSH, where the forwarded `LC_TERMINAL` marker was ignored ([#16450](https://github.com/can1357/oh-my-pi/pull/16450) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Added Eval `mcp_progress` status events, updated in place per call and evictable under the status-event cap, plus `formatMCPProgress()` and `MCPToolDetails.progress` for MCP progress display ([#16431](https://github.com/can1357/oh-my-pi/pull/16431) by [@alphastorm](https://github.com/alphastorm))

## [18.12.3] - 2026-10-19

### Added

- Added `IrcMessage.broadcast`, set on each copy of an `agent://all` broadcast so recipients can tell it from a direct message ([#16312](https://github.com/can1357/oh-my-pi/pull/16312) by [@will-bogusz](https://github.com/will-bogusz))
- `AutocompleteItem.descriptionMatch` marks a slash command matched only through its description; `Editor` Enter no longer applies such a row unless the user moved the selection onto it ([#16265](https://github.com/can1357/oh-my-pi/issues/16265))
- `ApprovalDialogComponent` accepts `grants` and `onGrant`: grant choices above **Approve Once**, led by a toggle that keeps them across sessions ([#16049](https://github.com/can1357/oh-my-pi/pull/16049) by [@Peribunt](https://github.com/Peribunt))
- Added `describeJobWidget`/`renderJobWidgetLines` to draw a background job's widget natively and as terminal lines, `describeJobTiles`/`renderJobTileLines` to draw jobs as tiles (status, title, figure, widget), and `renderSparkline` (with `peakBuckets`/`fitSparkValues`) for one-row block sparklines

### Fixed

- Fixed transparent images with empty top rows disappearing inside Zellij ([#16346](https://github.com/can1357/oh-my-pi/pull/16346) by [@Bouska](https://github.com/Bouska))
- Fixed bash output rewritten by the output minimizer skipping the per-line column cap (`tools.outputMaxColumns`), so a line wider than the cap reached the model whole; the raw output stays in its artifact ([#16314](https://github.com/can1357/oh-my-pi/pull/16314) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the composer caret drifting one cell left per pasted image or video chip in terminals that draw the chip icon as a wide emoji (JetBrains terminal); the `unicode` preset now uses `📷`/`🎬` chip icons ([#16270](https://github.com/can1357/oh-my-pi/issues/16270))
- Fixed Tern hiding user text sent with `/skill:<name>` inside a collapsed skill card; only the loaded skill prompt is hidden ([#16311](https://github.com/can1357/oh-my-pi/issues/16311))
- Fixed SIXEL charts and images overlapping following content when their top rows scroll out of the viewport ([#16245](https://github.com/can1357/oh-my-pi/pull/16245) by [@JustasMasiulis](https://github.com/JustasMasiulis)).

## [18.12.2] - 2026-10-18

### Added

- Added `ComposerPreferences.completeScrollback` (default `false`): rows a growing HUD or dialog pushes off screen go straight to scrollback instead of being held back until it shrinks ([#15692](https://github.com/can1357/oh-my-pi/pull/15692) by [@Ilm-Alan](https://github.com/Ilm-Alan))

### Fixed

- Fixed table charts picking the wrong label and measure columns when numbers group thousands with spaces (`1 988`, `17 083`); they now read like `1,988` ([#16175](https://github.com/can1357/oh-my-pi/issues/16175))
- Fixed terminal capability replies relayed through win32-input-mode appearing as typed input in WSL terminals ([#16137](https://github.com/can1357/oh-my-pi/issues/16137))
- Fixed the status-bar activity spinner and turn timer freezing until the next keypress when the working-row loader is stopped mid-turn; an open turn window now repaints the status line on its own timer ([#16109](https://github.com/can1357/oh-my-pi/pull/16109) by [@tommymorgan](https://github.com/tommymorgan)).
- Fixed pasting sometimes inserting a block of base64 text instead of the pasted text in terminals that deliver pastes through the Kitty clipboard protocol (OSC 5522), most often with dictation apps that paste for you; a slow paste now arrives whole, and keys typed while a paste never finishes are given back instead of lost ([#16170](https://github.com/can1357/oh-my-pi/pull/16170) by [@H4vC](https://github.com/H4vC))
- Fixed a streaming table bouncing everything below it up and down while its last cell was still being written ([#16116](https://github.com/can1357/oh-my-pi/pull/16116) by [@galtamam-cmyk](https://github.com/galtamam-cmyk))
- Fixed inline images in iTerm2 being sized for the wrong cell shape, which left charts smeared or offset ([#16118](https://github.com/can1357/oh-my-pi/pull/16118) by [@galtamam-cmyk](https://github.com/galtamam-cmyk))

## [18.12.1] - 2026-10-17

### Breaking Changes

- `numberedCode`, `readContentCode` and `nativeDiff` take the file's path (`path`) instead of a language, and `describeGroupedOutput` drops its `lang` option: Tern picks the grammar of file contents from their path

### Changed

- Advisor notes in Tern read as a callout tinted by their worst severity: its icon and a tally (`Concern`, `1 blocker · 2 concerns`) head the card with the advisor's name at the end, and several notes each lead with their own severity icon

### Fixed

- Fixed images rendering blank inside tmux on Kitty-capable terminals when tmux's `allow-passthrough` is off (the default); omp now falls back to SIXEL or the text placeholder instead of sending Kitty graphics tmux drops
- Fixed Tern drawing tool cards' file contents (write, read, edit, grep, find, ast-grep, ast-edit) plain or in the wrong language when omp did not know the file's extension (`.ptx`) or mapped it to a neighbor (`.cu` as C++); omp now sends the file's path and Tern picks the grammar

## [18.12.0] - 2026-10-17

### Breaking Changes

- `FindStats.errors` is replaced by `failed` (judge requests that failed) and `unanswered` (unusable answers), and `FindToolDetails` requires a `coverage` status; the find renderer shows `N/M requests failed` ([#15744](https://github.com/can1357/oh-my-pi/issues/15744))

### Added

- Added `pi.showProfile` to `StatusLineSegmentOptions`: `false` keeps the `pi` segment's bare glyph under a named profile, in the rendered bar and in `describe` ([#16063](https://github.com/can1357/oh-my-pi/pull/16063) by [@shgew](https://github.com/shgew))

### Fixed

- Fixed sessions run inside tmux silently falling back to the terminal's true-color profile when the client terminal-type probe answered slowly on a loaded machine ([#16020](https://github.com/can1357/oh-my-pi/pull/16020) by [@CharleoYang](https://github.com/CharleoYang))
- Fixed the `read` result notice printing the absolute resolved path, so a file under the home directory reads `Resolved path: ~/notes.txt` instead of `/home/you/notes.txt` ([#16055](https://github.com/can1357/oh-my-pi/pull/16055) by [@adi-IL](https://github.com/adi-IL)).
- Fixed grep/read previews and other tool cards passing raw escape sequences from file contents to the terminal, which could switch it to the alternate screen with mouse reporting on, live and again on every resume ([#15963](https://github.com/can1357/oh-my-pi/issues/15963))
- Fixed a final status-line render after shutdown scheduling another usage refresh ([#15845](https://github.com/can1357/oh-my-pi/issues/15845)).
- Fixed Ctrl+O on LSP status and other plain LSP responses still clipping every row at 80 columns; expanded rows now wrap to show the full text ([#15824](https://github.com/can1357/oh-my-pi/issues/15824))
- Fixed Ctrl+O leaving long rows clipped in expanded LSP, debug, MCP, web search fallback, yield, task and custom-tool results; expanded rows now wrap to show the full text, expanded LSP references list every location, and the LSP expand hint no longer appears when nothing is hidden ([#15824](https://github.com/can1357/oh-my-pi/issues/15824))
- Fixed jagged text and disappearing translucent details in SIXEL images, including re-encoding when the terminal reports a changed background color ([#15891](https://github.com/can1357/oh-my-pi/pull/15891) by [@Bouska](https://github.com/Bouska)).
- Fixed stale SIXEL backgrounds after terminal restarts, native appearance changes, and failed TSP handshakes, including background changes during the handshake, fixed themes, missing or invalid startup themes, or identical light/dark mappings ([#15891](https://github.com/can1357/oh-my-pi/pull/15891) by [@Bouska](https://github.com/Bouska)).

## [18.11.3] - 2026-10-16

### Added

- Added selection-only session and model picker actions for `/seance`, so choosing a source or model leaves the active session and model unchanged ([#15036](https://github.com/can1357/oh-my-pi/pull/15036) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))

### Changed

- `ApprovalDialogComponent` shows a choice list (Approve, an optional `session` row, Deny): the arrow keys move between them and Enter (armed after `APPROVE_ARM_MS`) takes the highlighted one; while a composer draft holds Enter the highlight sits on Deny, relabeled "Deny and send message"; Tern clicks on a choice take it; Page Up/Down scroll the details

### Fixed

- Fixed a streamed Markdown list keeping every item out of native scrollback until the turn ended, so rows that scrolled off screen were unreachable mid-stream; items in front of the newest one now retire as soon as it begins ([#13676](https://github.com/can1357/oh-my-pi/issues/13676), [#15993](https://github.com/can1357/oh-my-pi/pull/15993) by [@shgew](https://github.com/shgew))
- Fixed SIXEL charts and SVG figures being resampled before display, which softened their text, on terminals whose cell height is not a multiple of 6 such as Windows Terminal ([#16007](https://github.com/can1357/oh-my-pi/issues/16007))

## [18.11.2] - 2026-10-16

### Changed

- Improved nested tool status line rendering: moved preview content into a dedicated collapsible code block when expanded and limited field widths on the one-line summary
- Suppressed typo highlighting for the word currently being typed to avoid distracting inline markers while composing

### Fixed

- Fixed double-clicking an extension switched off in `/extensions` in Tern not switching it back on
- Fixed the queued-messages badge in Tern showing a bare count that read as the first message's number; it now reads `N queued`
- Fixed table charts on TSP terminals to use SVG fences and respect terminal palette
- Fixed table charts in Tern's native view drawing in the other appearance's colors (light labels on a light page) when omp's light/dark detection disagreed with Tern; Tern now colors them in the theme it shows, like the prose around them
- Fixed the /btw history answer being stuck at the bottom while a follow-up is being written: Up/Down and Page Up/Down now scroll the answer without leaving the draft ([#15902](https://github.com/can1357/oh-my-pi/pull/15902) by [@H4vC](https://github.com/H4vC))
- Fixed macOS editor spelling assistance hanging silently when the spelling service stops responding; it now reports and disables itself instead ([#12084](https://github.com/can1357/oh-my-pi/issues/12084), [#14341](https://github.com/can1357/oh-my-pi/pull/14341) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed a chip toggled in a multi-select setting's open submenu leaving its row and its tab's changed badge showing the old selection until the submenu was closed ([#14444](https://github.com/can1357/oh-my-pi/pull/14444) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed `@` file autocomplete freezing when the project contains a symlink into a very large directory tree; the fuzzy walk now stops after 1.5 s and the popup falls back to the immediate-directory listing ([#12317](https://github.com/can1357/oh-my-pi/issues/12317), [#14330](https://github.com/can1357/oh-my-pi/pull/14330) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed omp in a Tern pane showing the classic CLI when a shell rc, dev shell or `.env` set `TERM` to a `screen*`/`tmux*` value with no multiplexer running; only a real tmux/screen/zellij/herdr/cmux/wmux session now keeps Tern's native view off
- omp inside devenv 2.x's reloading `devenv shell` now starts on the classic renderer instead of opening Tern's native view and abandoning it: devenv's terminal layer drops Tern's protocol, so the native view needs `devenv shell --no-reload`. The debug log now records why a Tern pane stays on the classic renderer
- Fixed large terminal paints on Windows being split mid-row, which let other output land inside a row; writes are now cut at row boundaries ([#14187](https://github.com/can1357/oh-my-pi/pull/14187) by [@mateusant13](https://github.com/mateusant13))
- Fixed `TUI.addStartListener()` hooks added after `start()` never running until the next stop/start cycle; a hook added to a running TUI now runs at once ([#15369](https://github.com/can1357/oh-my-pi/pull/15369) by [@LoneExile](https://github.com/LoneExile))
- Fixed the git viewer advertising stage, discard, select and commit keys while showing a clean tree's HEAD commit, where none of them do anything; the footer and sidebar now describe the commit view ([#14347](https://github.com/can1357/oh-my-pi/issues/14347), [#14480](https://github.com/can1357/oh-my-pi/pull/14480) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed the status line `pr` segment keeping the previous branch's PR after switching to the default branch, a detached HEAD, or a branch without a PR ([#15455](https://github.com/can1357/oh-my-pi/pull/15455) by [@ravshansbox](https://github.com/ravshansbox))
- Fixed the status-line footer total leaving out task subagent spend; it now reads the session's cumulative usage, the same source the interactive status line uses ([#14393](https://github.com/can1357/oh-my-pi/pull/14393) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed transcript rows disappearing from scrollback or reappearing out of order when bottom chrome stays taller after a turn, self-clearing HUDs close, or the composer shape changes ([#15820](https://github.com/can1357/oh-my-pi/pull/15820) by [@emmahyde](https://github.com/emmahyde))

## [18.11.1] - 2026-10-15

### Added

- Added a tree layout to the background jobs sheet: subagents' jobs nest under the task job that runs them, busiest branches first, and Cancel appears only on the viewing agent's own jobs ([#15854](https://github.com/can1357/oh-my-pi/pull/15854) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed transcript images not opening their file: image placeholders and native image nodes now link to the source file or a stored copy ([#15872](https://github.com/can1357/oh-my-pi/pull/15872) by [@H4vC](https://github.com/H4vC))
- A collapsing live block no longer leaves its slack as a band of blank rows between the retired history and the live rows: the slack falls below the transcript, so a streamed reply stays contiguous and the input keeps the bottom row ([#15499](https://github.com/can1357/oh-my-pi/pull/15499) by [@iacore](https://github.com/iacore))
- Fixed width-aware text on native (TSP) terminals truncating content two columns early ([#15806](https://github.com/can1357/oh-my-pi/pull/15806) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed Tab/right-arrow completion silently dismissing a selected `@"quoted path"` file suggestion when the path contains spaces ([#15698](https://github.com/can1357/oh-my-pi/pull/15698) by [@drawde-nadroj](https://github.com/drawde-nadroj))
- Bracketed pastes are now capped by their UTF-8 size, so a large multibyte paste no longer buffers past the byte limit ([#15803](https://github.com/can1357/oh-my-pi/pull/15803) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Fixed OSC 66 text-sized spans bypassing truncation when their UTF-16 length was short enough to fit the fast-path guard ([#15802](https://github.com/can1357/oh-my-pi/pull/15802) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Updated the `ast_grep` result view's truncated-match note to suggest `skip` pagination instead of the schema's nonexistent `increase limit` flag ([#15532](https://github.com/can1357/oh-my-pi/issues/15532), [#15543](https://github.com/can1357/oh-my-pi/pull/15543) by [@peda-cos](https://github.com/peda-cos)).
- Fixed a streaming Edit preview with long wrapped lines growing past its row cap, because its tail was budgeted without the diff gutter its continuation rows hang under ([#15679](https://github.com/can1357/oh-my-pi/pull/15679))
- Fixed malformed base64 padding being accepted for chat image attachments before native image decoding ([#15765](https://github.com/can1357/oh-my-pi/pull/15765) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Fixed Shift+Enter submitting and Ctrl+Enter inserting a newline in Windows Terminal 1.25–1.27 after closing any fullscreen view such as `/settings`; the terminal dropped omp's keyboard mode on leaving the alternate screen ([microsoft/terminal#20763](https://github.com/microsoft/terminal/issues/20763)), so omp now re-applies it ([#15868](https://github.com/can1357/oh-my-pi/pull/15868) by [@H4vC](https://github.com/H4vC)).
- Long lines in native (Tern) `read`, `write`, and code-cell source now wrap instead of scrolling each block sideways ([#15823](https://github.com/can1357/oh-my-pi/issues/15823)).
- Fixed long text pastes taking seconds to land in terminals that deliver a paste one key at a time, such as JetBrains' terminal on Windows; omp no longer writes to the terminal for every pasted key ([#15757](https://github.com/can1357/oh-my-pi/issues/15757))
- Fixed Shift+Enter submitting the prompt and Ctrl+Enter inserting a newline in WSL under Windows Terminal 1.24 and earlier, conhost, and other ConPTY hosts without kitty keyboard support; Shift+Enter now inserts a newline and Ctrl+Enter sends a follow-up, as on native Windows.
- Fixed streamed Markdown tables jumping around as each row arrives: the terminal UI fills the row being written in under the existing column widths, and native (TSP) terminals receive each row once its line is complete ([#15856](https://github.com/can1357/oh-my-pi/pull/15856) by [@H4vC](https://github.com/H4vC)).
- Fixed streamed links and inline math showing raw `[text](url` or LaTeX and then rewrapping the paragraph when they close, in the terminal UI and native (TSP) terminals: they now render in their closed form while they stream ([#15864](https://github.com/can1357/oh-my-pi/pull/15864) by [@H4vC](https://github.com/H4vC)).
- Paint-only overlays no longer swallow typing intended for the focused input beneath them ([#15793](https://github.com/can1357/oh-my-pi/issues/15793)).

## [18.11.0] - 2026-10-14

### Added

- Added native composer microphone controls with visible starting, recording and transcription states; a start still loading its model can be cancelled, and Enter and Send wait while dictation is recording or transcribing into the draft ([#15759](https://github.com/can1357/oh-my-pi/pull/15759) by [@daaximus](https://github.com/daaximus)).
- `ApprovalDialogComponent` takes a `draft` option that routes typing to the composer beneath it, so a message can be written while a tool call waits ([#15642](https://github.com/can1357/oh-my-pi/pull/15642) by [@H4vC](https://github.com/H4vC))
- `ApprovalDialogComponent` takes a `fullPrompt` option that the expand key (`app.tools.expand`) or a Details button swaps in for the summarized prompt; it replaces `wrapDetails` ([#15642](https://github.com/can1357/oh-my-pi/pull/15642) by [@H4vC](https://github.com/H4vC))

### Fixed

- SVG fences in CRLF or CR-only assistant Markdown now render as figures instead of source code ([#15663](https://github.com/can1357/oh-my-pi/issues/15663)).
- Fixed clipboard-image and image-path pastes being dropped while the composer draft is edited beneath an ask or approval dialog ([#15642](https://github.com/can1357/oh-my-pi/pull/15642) by [@H4vC](https://github.com/H4vC))
- Fixed inline images inside tmux assuming Kitty graphics from the pane's `TERM`; the attached client is identified from tmux's terminal-type reply or its `TERM` (e.g. `xterm-kitty`), and unrecognized clients go to the SIXEL probe ([#15524](https://github.com/can1357/oh-my-pi/issues/15524)).
- Fixed ```svg fences rendering as their source code instead of a drawing when no theme was installed yet, e.g. in an extension rendering a message that opens with the fence ([#15660](https://github.com/can1357/oh-my-pi/issues/15660))
- Fixed pastes inside tmux 3.5a and older submitting line by line after another program turned bracketed paste off on the pane; omp now re-enables it on the next render or keypress ([#15596](https://github.com/can1357/oh-my-pi/issues/15596))
- Fixed assistant replies containing a table (on image-capable terminals with table charts on) publishing still-streaming rows to native scrollback, which froze the block's append-only retirement and could leave overwritten reply rows in scrollback ([#15693](https://github.com/can1357/oh-my-pi/issues/15693))
- Fixed streamed thinking publishing a line to native scrollback just before a code fence or `<!-- -->` sentinel split across deltas rewrote it with the prose-fold ellipsis ([#15693](https://github.com/can1357/oh-my-pi/issues/15693))
- Fixed streamed assistant text or thinking containing a tab stopping all later rows of the reply from retiring into native scrollback until the turn ended ([#15693](https://github.com/can1357/oh-my-pi/issues/15693))
- Fixed wrapped lines in Write, Read, Edit, Todo, Ask and LSP tool cards losing their alignment under line numbers, tree connectors, and option or code rails ([#15677](https://github.com/can1357/oh-my-pi/issues/15677))
- Fixed SIXEL images leaving their previous raster on screen, drawn again over itself, when the transcript moves them within the viewport ([#15657](https://github.com/can1357/oh-my-pi/issues/15657))

## [18.10.4] - 2026-10-13

### Added

- Added `ApprovalDialogComponent` and the `app.approval.approve` keybinding (default `Ctrl+Enter`, `Ctrl+Q`) ([#15548](https://github.com/can1357/oh-my-pi/pull/15548) by [@H4vC](https://github.com/H4vC))
- Plan review overlay can take a remote answer: it shows the remotely chosen execution tier and locks further input like a terminal approval ([#15552](https://github.com/can1357/oh-my-pi/pull/15552) by [@Shadorain](https://github.com/Shadorain))

### Fixed

- The model browser shows the price a model is billed at now, not the one current when its row was loaded: DeepSeek V4 Pro shows its $0.30 / $1.20 card in effect since 2026-09-14 instead of $1.32 / $3.96, and Gemini 4 Argon switches to $4 / $20 on 2026-12-01 ([#15620](https://github.com/can1357/oh-my-pi/pull/15620) by [@eggpeat](https://github.com/eggpeat))
- Clicking Copy answer in the `/btw` history (and Copy raw in the raw SSE viewer) on native terminals copies the answer instead of the button's label ([#15547](https://github.com/can1357/oh-my-pi/pull/15547) by [@H4vC](https://github.com/H4vC))
- Fixed image previews inside tmux showing as `SIXEL IMAGE (WxH)` placeholder text when the outer terminal lacks SIXEL; SIXEL is now enabled from tmux's DA1 reply only when tmux's terminal description for the attached client has `Sxl` ([#15513](https://github.com/can1357/oh-my-pi/issues/15513))

### Removed

- Removed `tools/eval-format/code-mode-declarations` (`generateCodeModeDeclarations`), which only served Codex Code Mode.

## [18.10.3] - 2026-10-12

### Changed

- Updated model picker to offer manual effort selection for unverified models instead of automatic mode

### Fixed

- Fixed the `snapcompact.shape` settings preview labelling variants `5x8-sent` and repeating the first variant's sample when the frame edge differs from the variant table (Claude and GPT on Cursor; `auto` on high-resolution Claude) ([#15448](https://github.com/can1357/oh-my-pi/pull/15448) by [@will-bogusz](https://github.com/will-bogusz))

## [18.10.2] - 2026-10-12

### Added

- Added opt-in `/tree` branch navigation across visible branches and nested fork depths; bind `app.tree.previousBranch` / `app.tree.nextBranch` (e.g. to `Shift+Left` / `Shift+Right`) in `keybindings.yml` ([#12623](https://github.com/can1357/oh-my-pi/pull/12623) by [@azain47](https://github.com/azain47)).

### Changed

- The `wait` tool's native job rows (`omp.wait.job`) are a single `row`: badge, id and label, progress and clock, without the output preview or capture notice beneath
- The native bash run foot reads In background with a live clock (`omp.run.time` without `stopped`) while a parked job's frames stream (`details.async.state === "running"`, partial), instead of Running
- Native model pickers (/model, the quick switch and the advisor's) mark providers with their logo (`mark.icon: "provider:<id>"`, initials where the terminal has none), and every model row leads with its provider's mark

### Removed

- Removed the unused `app.tree.foldOrUp` / `app.tree.unfoldOrDown` keybinding ids, which no longer did anything.
- Added `parksAsBackground(toolName, details)`, `asyncJobState(details)`, `isSettledJobFrame(details)` and `settleWithJobFrame(component, frame, toolCallId)` (`chat/tool-execution`): whether a returned call's card stays live for its background job's frames (`task` always; `bash` and `eval` under native rendering), the job state a frame reports, and settling the card with the job's last frame (a cancelled job keeps its output and seals as cancelled)
- `BashToolDetails.async.state` and `EvalToolDetails.async.state` gain `cancelled` for a job killed before it finished

## [18.10.1] - 2026-10-12

### Added

- `AssistantMessageComponent`'s native turn footer leads with a Copy icon (`omp.turn.copy`) and a dot instead of the clock icon; it copies the answer's text and shows when the host handles transcript actions

### Changed

- `UserMessageComponent`'s native hover toolbar (`omp.user.tools`) leads with Copy and Rewind icon buttons (`copy`, `rewind`) instead of text labels, then a dot and the time, like the turn usage footer
- `ContextUsageView`'s native body (on terminals with `meter`) leads with the tokens used and the room left before auto-compaction, then one stacked bar ticked at the threshold, the breakdown as rows (`omp.context.cat`, `.cat.free`, `.cat.buffer`: swatch, name, tokens, share; the exact count in the row's `title`) and the snapcompact estimate as labelled rows (`omp.context.snap`); the blocks meter and legend `kv` are gone, and `contextUsageHead` no longer repeats the window size
- `AskDialogComponent`'s native root is `omp.editor.ask` (collapsed: `omp.editor.ask.hidden`, the countdown, the question as `omp.ask.summary`, Skip and Show): a chosen answer is the `accent`-toned row (a check also carries the check icon) instead of the highlighted one; multi-select Other… is `omp.ask.other.check`; the question tabs check answered questions and say their keys in the strip's `title`; the countdown moves from the head to the action bar beside Hide; the preview is `omp.ask.preview`; the Review tab leads with `omp.ask.notice` and lists answers (`omp.ask.answers`) by question name with inline code mono and no `(Recommended)` suffix; option descriptions run inline code mono, notes ride the row's detail as `em`; Submit/Next's tooltip names only Enter (and Space on a multi-select)
- `MCPAddWizard`'s native sheet asks one question per step: a phase strip (`omp.mcpAdd.progress` of `omp.mcpAdd.phase`, toned done/current/upcoming and `neutral` when no auth was needed), the question and its lead (`omp.mcpAdd.title`, `omp.mcpAdd.tag` for optional fields, `omp.mcpAdd.lead`), then a mono field with a placeholder and its rule or refusal (`omp.mcpAdd.field`, `tone: "error"`; `omp.mcpAdd.note`), choice rows with icons and mono tags (`omp.mcpAdd.choices`), status lines (`omp.mcpAdd.status`, `omp.mcpAdd.checks`, `omp.mcpAdd.error`) or the review rows (`omp.mcpAdd.summary`). Cancel, Back and Continue / Save server buttons run Ctrl+C, Esc and Enter instead of a key-hint strip. The connection test shows its own busy step, the OAuth client secret field is masked, and the review saves on Enter (no Yes/No choice)
- `ReportPanel`'s native body carries the role `omp.report.body`
- `HookInputComponent` describes a dock sheet (`omp.overlay.hook-input` col) like `HookEditorComponent`'s: the title's first line (`omp.hook-input.title`, the countdown as `omp.hook-input.timer`) over its further lines (`omp.hook-input.detail`), the field (`omp.hook-input.field`, `tone: "error"` while a submit was refused) with its placeholder, and Cancel / Submit buttons that run Esc / Enter; the key legend under the field is terminal-only
- `JobsSheet`'s native body is a master–detail split (`omp.jobs.split`: `omp.jobs.master` | `omp.jobs.detail`): the job list grouped Running / Recent (`omp.jobs.group` labels), each row a type icon tinted by status with its duration, beside the selected job's status pill, live elapsed and Cancel job (`omp.jobs.status`), its task title or command (`omp.jobs.title` / `omp.jobs.command`), facts (`omp.jobs.facts`: agent, directory, pids, exit code, artifact) and output (`omp.jobs.out`, `omp.jobs.nooutput`); the footer counts running and recent jobs (`omp.jobs.summary`), and no jobs shows an empty state (`omp.jobs.empty`). Task jobs no longer draw an `agent` node here
- `BtwHistoryPanel`'s native sheet is centered and reads like a mail reader: the questions as two-line rows (`omp.btw.history`, list `omp.btw.list` / `omp.btw.list.idle` while the answer has the keys) beside the selected thread (`omp.btw.reader` › `omp.btw.thread` › `omp.btw.turn`: `omp.btw.question` / `omp.btw.followup`, `omp.btw.meta`, `omp.btw.answer`, `omp.btw.error`), the follow-up field under the last answer (`omp.btw.composer`), and footer buttons Stop answer, Copy answer, Close and Follow up (Cancel and Send while composing) in place of the focus labels and key-hint strip; an empty history is an `md` sheet (`omp.btw.empty`)

### Fixed

- `CountdownTimer`'s native `elapsed` no longer sends `stopped: 0`, which froze every native countdown (extension input, selector and editor prompts) at zero from the start
- The native backend's focus now reaches a field inside an `overlay`/`picker` sheet hoisted into the layer from a dock component (the MCP add wizard, login), so that field shows the live caret and focus ring
- `MCPAddWizard` keeps a refused name or URL in its field, clears a stale refusal on Back, ignores a connection test that settles after the user stepped back, and Edit OAuth settings after a failed sign-in opens the settings again instead of doing nothing

## [18.10.0] - 2026-10-12

### Breaking Changes

- Removed `RuntimeChildrenOptions.transient` and `Component.retireDisplacedTranscript`: the composer now bills all chrome below the transcript at the smallest height it has rendered, so no root opts in or out ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))

### Added

- Added the `app.ask.hide` keybinding (default `Alt+H`) and Hide/Show actions on `AskDialogComponent`, which collapse the dialog to a single line while its question stays pending ([#15400](https://github.com/can1357/oh-my-pi/pull/15400) by [@H4vC](https://github.com/H4vC))

### Changed

- The `OMP_TUI_DEBUG` control socket now uses the native IPC transport: it is owner-only and no longer replaces a socket another live process is serving.
- Transcript rows pushed aside by an open dialog, report or HUD now reach scrollback when it closes or newer output pushes them out, instead of while it is open ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))
- A transcript block straddling the top of the screen now sends only its off-screen rows to scrollback; the rest stays live ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed blank rows opening under the editor after an ask or other inline dialog, command report or todo/loader HUD closed in a session that had filled the screen; the screen now refills with the transcript ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))
- Fixed the editor rising above blank rows when a live tool preview collapses under scrolled-off output; it now stays on the bottom row ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))
- Fixed blank rows opening inside a streamed answer when the working loader went away at the end of a turn ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))
- Fixed a split transcript block dropping punctuation-only rows it reveals after the split (such as a tool pane's rule line on expand); the seam now stops before them instead of treating them as already committed ([#15420](https://github.com/can1357/oh-my-pi/pull/15420) by [@H4vC](https://github.com/H4vC))
- Fixed a split transcript block fingerprinting measured rows instead of the bytes committed to scrollback, which could duplicate a SIXEL image prefix once its pending encode landed ([#15420](https://github.com/can1357/oh-my-pi/pull/15420) by [@H4vC](https://github.com/H4vC))
- Fixed a transcript block straddling the top of the screen losing its off-screen rows when the inline-image limit demoted its images to text in the same frame; those rows now reach scrollback as text

### Removed

- Removed `Composer.pinInputToBottom()`; the composer keeps the input on the bottom row by itself ([#15405](https://github.com/can1357/oh-my-pi/pull/15405) by [@H4vC](https://github.com/H4vC))

## [18.9.2] - 2026-10-11

### Added

- Added native TSP rendering support for Tern terminal sessions running inside tmux, with automatic session detection and safe title-setting behavior.

### Fixed

- Improved responsiveness when inserting assistant messages after tool calls in long transcripts.

## [18.9.1] - 2026-10-11

### Fixed

- Fixed inline charts and images leaving overlapping copies over text when moved, resized, replaced, or hidden, while preserving images in scrollback.

## [18.9.0] - 2026-10-11

### Added

- Added opt-in JSON editing for free-form array settings while keeping credential values masked; settings editors now surface submission and validation errors.
- Added ghost-text predictions to the editor via the new `Editor.prediction` callback. Press Tab or Right at the end of a line to accept the suggested text without submitting.
- Expanded table-chart support with stacked, waterfall, timeline, dots, range, slope, butterfly, bullet, ladder, histogram, and stat charts, including error whiskers, share bars, status matrices, and richer before/after visualizations.
- Added richer table-chart planning and presentation controls, including titles, ordering, grouping, shading, normalization, reference lines, polarity, rivals, focus rows, and model-driven selection for smart mode. Charts now identify key findings, highlight best values and changes, and adapt scales and labels for clearer comparisons.
- Added the optional `assistantMessageText` theme token for coloring assistant reply prose while preserving the terminal default when unset or empty.
- Added optional status-line support for showing saved usage resets that expire soon and warning once per conversation when a reset expires within 24 hours.

### Changed

- Improved table-chart planning to prefer waterfall charts over share bars for complex data sets and enforce segment limits for share-chart legibility
- Reduced the time required to rebuild long sessions on resume, particularly sessions with repeated wait polls or todo updates.
- Output summaries now identify the first and last lines omitted by column limits, and truncation notices point to the `:raw` selector for retrieving complete lines.

### Fixed

- Fixed session model selection and setup displaying role chips for roles that resolve to a non-chat runner rather than the model used by the session.
- Improved table-chart parsing and rendering across repeated labels, grouped and paired values, percentages, units, currency, durations, model sizes, links, identifiers, and sparse or side-by-side tables. Charts now avoid duplicate or misleading plots and preserve meaningful comparisons.
- Fixed table-chart scaling for outliers, stacked groups, zeros, logarithmic shading, and values spanning multiple orders of magnitude.
- Fixed `/tree` stalling or using excessive memory when opened on long sessions with many branch points.
- Fixed extension status messages losing SGR colors and text styles in the status line.
- Fixed the eval status list omitting status events discarded from long-running cells.
- Fixed loop-blocked diagnostics to attribute stalls to the correct work phase or terminal writes instead of reporting misleading unknown causes.
- Fixed Agent Hub and status-line spending totals losing cumulative subagent costs after compaction, parking, or follow-up turns.
- Fixed dead-key input on older Windows Terminal versions so quotes are entered correctly with Space, Enter, and Tab.
- Fixed SIXEL graphics detection on terminals, including native Windows Terminal, so SVG figures and inline images work without forcing a graphics protocol.
- Fixed overflow transcript rendering so user messages no longer appear as blank padding bars or leave stray prompt markers across terminal rows.

## [18.8.9] - 2026-10-10

### Breaking Changes

- Removed the `isInsideTmux()`, `isInsideZellij()`, and `isInsideHerdr()` exports; use `hasTerminalMultiplexerSession("tmux" | "zellij" | "herdr", env)` instead ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))

### Added

- `classifyTerminalMultiplexer()` reports `"orca"` inside Orca terminals while `isInsideTerminalMultiplexer()` stays false there, so Orca keeps the direct-terminal render path; `TERMINAL_MULTIPLEXER_ENV_KEYS` lists every environment variable multiplexer detection reads ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Added `terminalMultiplexerSessions()`, `terminalMultiplexerForTerm()`, `classifyTerminalMultiplexerModule()`, and `routeTerminalMultiplexerNotification()`, driven by one multiplexer registry that now owns notification routing and per-multiplexer capability overrides ([#13620](https://github.com/can1357/oh-my-pi/pull/13620) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy))
- Added `change` and `progress` table-chart kinds with `ChartSpec.baseline` and `TableColumn.scores`: a before/after table whose rows have their own units charts each metric as a factor of the baseline column (rows without two numbers are named in the caption), and `analyzeTable` reads whole-number scores (`12/12`, `154/160`) as the percent of their total, keeping `a / b` pairs and lists as written

### Changed

- `StatusLineComponent.describeComposerFacts()` includes the configured `git` segment among the composer's facts (branch and status, the `status.git` click action, pinned so it outlasts the other facts) instead of leaving the branch to Tern's pane header ([#15220](https://github.com/can1357/oh-my-pi/pull/15220) by [@H4vC](https://github.com/H4vC))
- Small-multiple table charts with more than three panels and at most six categories draw as bands of per-metric panels with a color legend, and `worthCharting` counts their panels like categories
- Table charts take the look of Apple's charts and Tern: a UI sans, hairline gridlines, rounded bars and cells, smooth lines over a soft area fill, dot legends, left-aligned category labels that never run off the edge, and axes labeled in one unit (`0, 5k, 10k`)
- Line charts whose series differ 8× or more in size stack panels on their own axes instead of flattening the smaller lines, and their end labels no longer overlap
- SVG figure series colors `--c1`…`--c6` are an even-weight palette led by the theme accent's hue instead of syntax colors

### Fixed

- Fixed `parseCell` throwing on table cells such as `3 constructor` or `2 valueOf calls`, and reading a `constructor` cell as a missing value

## [18.8.8] - 2026-10-10

### Breaking Changes

- `ModelHubCallbacks.onCompactionPointChange` now receives a `confirmed` flag and returns a `CompactionPointChangeResult` (`{ kind: "error" }` or `{ kind: "confirm" }`) instead of an error string; a `confirm` result shows a warning that a second Enter on the same input accepts ([#15048](https://github.com/can1357/oh-my-pi/pull/15048) by [@H4vC](https://github.com/H4vC))
- `ModelCompactionPoint.percent` is replaced by `basis`, a short explanation of why the model compacts there (`fixed`, `85% of 400K base`, `80% of window`) that the model hub preview shows next to the trigger ([#15065](https://github.com/can1357/oh-my-pi/pull/15065) by [@H4vC](https://github.com/H4vC))

### Added

- Added an `inline` option to `HookSelectorComponent` that keeps a selector in the composer slot in Tern instead of opening it as a sheet over the screen ([#15058](https://github.com/can1357/oh-my-pi/pull/15058) by [@H4vC](https://github.com/H4vC))
- Added `ModelHubCallbacks.previewCompactionPoint`, whose line the compaction limit field shows while you type instead of the input syntax ([#15065](https://github.com/can1357/oh-my-pi/pull/15065) by [@H4vC](https://github.com/H4vC))
- Added Vim find and till motions (`f`, `F`, `t`, `T`) in the prompt editor, with `;` and `,` to repeat them ([#15100](https://github.com/can1357/oh-my-pi/pull/15100) by [@Shadorain](https://github.com/Shadorain))
- Added Vim replace (`r`, `R`) in the prompt editor ([#15100](https://github.com/can1357/oh-my-pi/pull/15100) by [@Shadorain](https://github.com/Shadorain))
- Added Vim bracket and quote matching (`%`), paragraph motions (`{`, `}`), line join (`J`), and indent (`>>`, `<<`) in the prompt editor ([#15100](https://github.com/can1357/oh-my-pi/pull/15100) by [@Shadorain](https://github.com/Shadorain))
- Added an external-editor key (Ctrl+G by default) to the annotation overlay for the note draft and, when the host provides `onExternalEditor`, the source being annotated; an edited text source is returned as `editedText` on the paste result ([#15151](https://github.com/can1357/oh-my-pi/pull/15151) by [@Shadorain](https://github.com/Shadorain))
- Added `TUI.releaseHeldInput()`: on a terminal expected to speak TSP, a `deferInput` start now holds keystrokes (TSP events and the cell-size reply still apply; Ctrl+C/Ctrl+D release early) until the app calls it once its session is wired; such terminals also skip the sixel probe ([#15120](https://github.com/can1357/oh-my-pi/pull/15120) by [@H4vC](https://github.com/H4vC))
- Added `TUI.replaceHeldFocus(previous, next)`, which `Composer.setEditor()` calls so a swapped-in editor inherits held startup keys; only keys for the start-time focus owner are now held, and a dialog that takes focus gets its input live ([#15122](https://github.com/can1357/oh-my-pi/pull/15122) by [@H4vC](https://github.com/H4vC))
- Added `RenderResultOptions.elapsedMs` and `cancelled`, `NativeToolHead.command` and `NativeToolView.preview: "children"` for native describe hooks

### Changed

- Tern draws each bash run, eval cell and `!`/`$` run as one box: the command or code, its output, status lines and a foot with state, time and facts; images sit below the box and the bash head shows the intent instead of the command

### Fixed

- Fixed the Agents hub Time column rewinding and freezing for running subagents between progress updates ([#15140](https://github.com/can1357/oh-my-pi/pull/15140) by [@H4vC](https://github.com/H4vC))

## [18.8.7] - 2026-10-09

### Added

- Added cache-release hooks for TUI components and tool cards, allowing extensions to discard derived render data without rebuilding content ([#13632](https://github.com/can1357/oh-my-pi/pull/13632) by [@iliaal](https://github.com/iliaal)).

### Changed

- Subagent "Submit Result" cards now show the submitted result (its fields as a tree, or the report text), the section it fills, and why a submission was rejected, instead of only "Result submitted.".
- Reduced memory held by retired transcript history in long sessions ([#13632](https://github.com/can1357/oh-my-pi/pull/13632) by [@iliaal](https://github.com/iliaal)).

### Fixed

- Reduced memory retained by discarded TSP images and previews ([#14336](https://github.com/can1357/oh-my-pi/pull/14336) by [@iliaal](https://github.com/iliaal)).
- Fixed startup capability probes printing as text in the prompt (e.g. `25a1;stsp;q;{…}pppppp`) on terminals that cannot parse them, such as macOS Terminal.app.
- Fixed the `/resume` picker flashing while a search runs over a large session history: background fuzzy matches now land in one update instead of reordering the list dozens of times per keystroke.

## [18.8.6] - 2026-10-08

### Changed

- Improved rendering performance for streaming long Markdown lists while preserving nested items, numbering, and reference links.

### Fixed

- Added package exports for the native Tern/TSP modules, allowing extensions in compiled `omp` binaries to import them.
- Fixed the Tern `/model` picker's Roles tab so typing and Backspace consistently edit the search field without triggering role commands.
- Fixed the session picker so sessions retain and display their directory when switching between the current folder and all-project views.

## [18.8.5] - 2026-10-08

### Added

- Added a **Compacts at** fact to the model hub preview and a Roles-view **Compaction limit** action (`k`) that edits the selected row's model limit through the new `ModelBrowserSource.compactionPointFor` and `ModelHubCallbacks.onCompactionPointChange` hooks ([#14952](https://github.com/can1357/oh-my-pi/pull/14952) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed `/usage` dashboard cards reordering their limit rows by usage; rows now keep the provider's window order (e.g. 5 hour → weekly → monthly) ([#14953](https://github.com/can1357/oh-my-pi/pull/14953) by [@H4vC](https://github.com/H4vC))
- Fixed Cmd+A, Cmd+C, Cmd+X and Shift+arrow selection doing nothing in the Tern prompt while Vim mode is in Insert mode ([#14954](https://github.com/can1357/oh-my-pi/pull/14954) by [@H4vC](https://github.com/H4vC))

## [18.8.4] - 2026-10-08

### Changed

- Agent Hub keeps existing agents in place while open; new agents appear first in the flat roster or within their tree sibling group ([#13066](https://github.com/can1357/oh-my-pi/pull/13066) by [@kmccleary3301](https://github.com/kmccleary3301))

### Fixed

- Fixed relative file links in Tern assistant replies opening against the folder omp was started in; they now open the file in the session's working directory ([#14879](https://github.com/can1357/oh-my-pi/pull/14879) by [@H4vC](https://github.com/H4vC))
- Fixed Tern modals with no clickable exit: BTW history, git shortcuts and autoresearch gain a Close button, plan review a Cancel button, the agent transcript viewer and `/annotate` review a top-right `esc` that runs Esc, and the `/move` dialog Accept, Cancel and Confirm buttons; new `escCloseButton()` builds the `esc` keycap button ([#14894](https://github.com/can1357/oh-my-pi/pull/14894) by [@H4vC](https://github.com/H4vC))

## [18.8.2] - 2026-10-07

### Removed

- Removed per-call `model` fields from task parameter types.

## [18.8.1] - 2026-10-07

### Fixed

- Fixed the native ask dialog on TSP surfaces so it replaces the composer instead of opening as a modal over the transcript, keeping the transcript readable and scrollable.

## [18.8.0] - 2026-10-07

### Added

- SVG and Mermaid files now render as images or diagrams beneath their file cards, with SVG previews updating while the file streams and Mermaid previews appearing when the file is complete.
- Native tool cards can open expanded regardless of the transcript’s expansion state; the todo checklist uses this behavior.

### Changed

- TSP composer placeholders now appear as the composer title in italicized curly quotes, with “What are we cooking?” used when no title is provided.
- TSP image transfers are more efficient across reconnects and multiple surfaces: images are sent once per connection, existing terminal blobs are detected before upload, and images in the Tern blob cache can be reused without crossing the terminal pty.
- Improved performance and responsiveness across the TUI, including large TSP messages and Markdown documents, streaming output, tool-result cards, debug logs, raw SSE and Git diff views, path and model searches, session and settings lists, plan review, agent transcripts, status updates, assistant links, Kitty images, and large prompt or evaluation content.
- Large debug logs and plan-review histories now retain bounded history to keep the interface responsive, while preserving the newest log entries.

### Fixed

- Fixed slow Markdown processing for certain LaTeX environments and incomplete delimiters.
- Fixed excessive slowdown when formatting long semicolon-free JavaScript evaluations.
- Fixed prompt-editor lag in large drafts containing magic keywords.

## [18.7.0] - 2026-10-06

### Added

- Assistant SVG code blocks now render as inline, theme-colored images on terminals with graphics support, updating as responses stream and adapting to terminal width; SVG that cannot be rendered remains available as code.
- Numeric tables in assistant responses can now include automatically selected, themed charts based on the table’s structure and units.

### Changed

- The status line now recognizes projects located in the user’s `repos` directory.
- Model mentions, `/switch` completions, and model-picker search now update immediately while typing, including with large model catalogs.

### Fixed

- Fixed terminal resizing issues that could cause flicker or briefly display an empty frame.
- Improved `/annotate` handling for long source lines and filenames, preserving indentation and typed note text.
- Fixed fullscreen inputs that could hide the cursor when hardware-cursor support was enabled.
- Fixed model picker and mention-list ordering for same-provider `-latest` models so results remain alphabetically stable.
- Model browser performance metrics now show the correct measurements for each service tier and identify the tier.
- Fixed plan review keyboard navigation so horizontal options use Left/Right and model-slider adjustments use Shift+Left/Right.
- Improved the Ask dialog footer so question-switching keyboard shortcuts are clearly labeled.
- Fixed creating a new agent when its generated system prompt contains a Markdown code fence.
- Timed-out `glob` scans are now labeled as timed out rather than truncated.
- Ctrl+Delete now deletes the word after the cursor, matching Ctrl+Backspace behavior.

## [18.6.3] - 2026-10-06

### Breaking Changes

- `WorkingRowSpec` no longer takes `rate`: the native working row reads spinner, elapsed time, divider, then the intent, and the tok/s readout moved to the composer bar

### Added

- `ComposerNativeState.rate` shows a tok/s readout in the native composer bar after the effort chip, and `ComposerNativeState.thinkingInModel` draws the thinking level as the model chip's icon instead of a separate chip
- `formatTooltipKey` formats a key for a native tooltip: unicode keycap glyphs whatever the symbol preset, `esc` for Escape
- `ImageOptions.requestRender` repaints an image without an image budget once its SIXEL encode lands ([#14529](https://github.com/can1357/oh-my-pi/pull/14529) by [@H4vC](https://github.com/H4vC))
- `AssistantMessageComponent` can keep finished thinking sections expanded via `setExpandThinkingBlocks()`; sections folded by hand stay folded ([#14519](https://github.com/can1357/oh-my-pi/pull/14519) by [@H4vC](https://github.com/H4vC))

### Changed

- `/hotkeys` shows the effective `app.stt.pushToTalk` binding, including `Disabled` when unbound ([#6592](https://github.com/can1357/oh-my-pi/pull/6592) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- SIXEL images are encoded off the main thread, so showing an image no longer stalls the terminal ([#14529](https://github.com/can1357/oh-my-pi/pull/14529) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed native tooltips (composer, working row, queue, pause screen, git and extension dashboards) naming keys with Nerd Font icons Tern's UI font lacks, or as raw key ids (`ctrl+g`); they use keycap glyphs (`⇧⇥`, `⌃G`)
- Fixed Tern's per-turn usage row showing a 24-hour time on a 12-hour terminal clock; the row and its tooltip now follow the terminal's clock, keeping the tooltip's ISO date ([#14565](https://github.com/can1357/oh-my-pi/pull/14565) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed hold-Space push-to-talk stopping the instant recording began (showing "No speech detected.") when opening the microphone briefly froze the UI ([#14463](https://github.com/can1357/oh-my-pi/pull/14463) by [@pgkt04](https://github.com/pgkt04))

## [18.6.1] - 2026-10-04

### Fixed

- Fixed the Space key in the Git diff pane so it stages or unstages the focused hunk instead of scrolling or acting on the wrong change.
- Fixed the BTW history sheet in Tern: the history list no longer collapses beside a long answer, the panes lose their foldable `##` headings, and the arrow/page keys scroll the answer ([#14331](https://github.com/can1357/oh-my-pi/pull/14331) by [@H4vC](https://github.com/H4vC))
- Fixed a single saved side question in the BTW history panel opening on its one-row list: its answer now has focus, and Enter or `f` to follow up jumps to the bottom of the conversation ([#14331](https://github.com/can1357/oh-my-pi/pull/14331) by [@H4vC](https://github.com/H4vC))

## [18.6.0] - 2026-10-03

### Fixed

- Fixed Alt+Up (restore queued steering), arrows and other escape-sequence keys on Windows acting as Esc (interrupting the turn) and typing `[1;3A` into the editor when the console host relays them one byte at a time ([#14216](https://github.com/can1357/oh-my-pi/pull/14216) by [@H4vC](https://github.com/H4vC)).

## [18.5.1] - 2026-10-03

### Added

- Added native terminal support for submitting explicit composer prompts atomically, preserving displaced drafts and attachments for local recall.
- Added progress percentages to subagent entries in the agent tree, task, and wait views.
- Added a `Rebuilding…` indicator for lengthy tmux resize redraws without flashing it for quick updates.
- Added `writeTerminalSequence()` for sending supported terminal escape sequences through the active terminal output stream, with stdout fallback when no terminal is active.

### Changed

- Clipboard payloads are now represented by their length in `PI_TUI_WRITE_LOG` rather than by their contents.

### Fixed

- Fixed pending clipboard-image attachments being bypassed when subsequent input or native prompts were submitted before loading completed.
- Improved narrow `/models` layouts by retaining the scope sidebar while simplifying and truncating model rows as needed.
- Fixed Markdown rendering with themes that do not define their own symbol set; the active theme's symbols are now used as a fallback.
- Fixed model role assignment showing models that are unavailable for the selected provider.
- Improved tmux resize, zoom, and rebuild behavior, including smoother coalesced redraws, reduced visual artifacts and extra output, correct transcript restoration after rapid size changes, and preservation of history when panes are resized.
- Fixed multiline paste on Windows inserting escape-code fragments instead of line breaks, and prevented bracketed-paste markers from appearing in the composer.
- Fixed terminal notifications occasionally corrupting the screen with stray escape-code fragments during streaming output.
- Added rendering and notification compatibility for Monstar terminals, including Kitty graphics, hyperlinks, synchronized output, styled underlines, progress keepalives, and Monstar-focused desktop notifications.
- Fixed Agent Hub transcripts crashing when assistant messages do not include usage or cost data.
- Fixed idle terminal activity notifications while preserving bracketed-paste recovery during input and rendering.
- Fixed diff blocks in ask questions losing their layout; additions and removals now retain separate diff highlighting.
- Fixed duplicate ASCII Plan, Prewalk, and Goal labels in the status line.
- Improved Markdown rendering for long and streamed messages, including display math, fenced code, reference links, lists, whitespace, emphasis, and line breaks, so completed content no longer shows raw markup, misplaced blank lines, or broken block layout.

## [18.5.0] - 2026-10-03

### Breaking Changes

- `WelcomeComponent` no longer takes a model or provider: its constructor is `(version)`, and `setModel()`, `setRecentSessions()`, `setLspServers()`, `handleNativeEvent()`, `RecentSession`, `LspServerInfo`, `WELCOME_SESSION_SLOTS` and `WELCOME_LSP_SLOTS` are gone; `ComposerWelcomeUpdate` drops `modelName`/`providerName`/`recentSessions`/`lspServers`, and `ComposerCache` drops `writeWelcome()`, `writeRecentSessions()`, `writeLspServers()`, `ComposerWelcomeCache` and the `welcome`/`recentSessions`/`lspServers` fields of `ComposerStartupCache`.
- `renderWelcomeTip()` returns its lines without an indent, `Tip:` and the body wrapped together, for the caller to place.

### Added

- Added `ReportPanel`, a read-only command report: a `/btw`-style titled box with an Esc hint in text mode (above the editor, or as a full-screen page whose body scrolls on the arrow/page/Home/End keys and the wheel), and natively a `/usage`-style sheet whose body the terminal scrolls once it is long, with a Close button ([#14136](https://github.com/can1357/oh-my-pi/pull/14136) by [@H4vC](https://github.com/H4vC)).
- Added `contextUsageHead()`, the `/context` title naming the model and its window ([#14136](https://github.com/can1357/oh-my-pi/pull/14136) by [@H4vC](https://github.com/H4vC)).
- Added `Composer.rowsBelow()`, the rows the chrome under a below-transcript root took in the last frame ([#14136](https://github.com/can1357/oh-my-pi/pull/14136) by [@H4vC](https://github.com/H4vC)).
- Added `Composer.pinInputToBottom()`, which keeps the input on the bottom row after chrome above the editor closes when rows it displaced went to scrollback ([#14136](https://github.com/can1357/oh-my-pi/pull/14136) by [@H4vC](https://github.com/H4vC)).
- Added a repeatable native `reveal` (`{ at, n }`): a described node scrolls into view again whenever its `n` changes, without being re-added.

### Changed

- `ContextUsageView` is now a bare report body without its own title, rules or card; `setBreakdown()` was removed ([#14136](https://github.com/can1357/oh-my-pi/pull/14136) by [@H4vC](https://github.com/H4vC)).
- The terminal welcome banner is the gradient logo beside the `omp` wordmark with the version under it and the tip, centered in the terminal; the logo stands alone when the lockup does not fit, and the tip drops below 50 columns. It no longer greets with "Welcome back!", natively either.

### Fixed

- Fixed tool previews on Windows showing a working directory on another drive as a raw absolute path instead of its home-shortened `~/…` form.
- Fixed pasted drive-less `file:///…` URLs (forwarded from a macOS pasteboard or remote session) staying undecoded on Windows instead of loading as image paths.
- Fixed an output artifact whose file cannot be opened (e.g. a directory in the way) being reported on Windows as a write failure and retried later, instead of a terminal open failure.
- Fixed plan review's Contents in Tern: clicking an entry, or moving through them with the arrow keys, now scrolls the plan to that section.

### Removed

- Removed `JobsPanel`, the `/jobs` transcript block; `/jobs` now opens `JobsSheet` natively ([#14138](https://github.com/can1357/oh-my-pi/pull/14138) by [@H4vC](https://github.com/H4vC)).

## [18.4.12] - 2026-10-02

### Changed

- Changed Ctrl+Z in Tern's native composer to undo the last edit (TSP `undo` event) instead of suspending

## [18.4.11] - 2026-10-02

### Added

- Added subagent completion percentages to the agent tree, task, and wait views.

### Changed

- Updated notebook evaluation cells in native hosts to use directional gutter indicators for inputs and outputs, with a progress indicator while a cell is running.

### Fixed

- Fixed multiline paste on Windows so pasted line breaks are inserted correctly instead of terminal escape sequences.

## [18.4.10] - 2026-10-02

### Added

- Added ContextUsageView.setBreakdown to refresh usage card without recreating it
- Added support for change events with flexible values in native TUI

### Fixed

- Keep settled responses reachable in scrollback while an ask panel is open, and keep the editor at the bottom after answering ([#12398](https://github.com/can1357/oh-my-pi/issues/12398), [#13993](https://github.com/can1357/oh-my-pi/pull/13993) by [@Dante-dan](https://github.com/Dante-dan)).
- Fixed a finished `wait` whose jobs were all still running going blank, and the next `wait` removing it while its turn's usage row stayed; the card now keeps its job snapshot ([#12248](https://github.com/can1357/oh-my-pi/issues/12248), [#13978](https://github.com/can1357/oh-my-pi/pull/13978) by [@Dante-dan](https://github.com/Dante-dan)).
- Hidden thinking blocks no longer leave a faint "Thought for Ns" row in Tern's native transcript; only the live "Thinking…" indicator shows while the model reasons.
- Fixed long Markdown paragraphs, such as a read preview of a file with no blank line, stalling rendering: a 44 KB paragraph now renders in about 8 ms instead of 95 ms ([#13961](https://github.com/can1357/oh-my-pi/pull/13961) by [@sjawhar](https://github.com/sjawhar)).
- Fixed Markdown paragraphs with many unclosed `[`, `*` or `_`, or with a long address-like word, stalling rendering for seconds ([#13961](https://github.com/can1357/oh-my-pi/pull/13961) by [@sjawhar](https://github.com/sjawhar)).
- Fixed Markdown paragraphs with many unclosed `~~`, `$`, `\(` or `\[`, nested brackets or emphasis, or unclosed HTML, stalling rendering for seconds: 40 KB of unclosed `~~` took 85 s. Emphasis or links nested a thousand levels deep still render slowly, for seconds per few KB: each level restyles the text inside it ([#13961](https://github.com/can1357/oh-my-pi/pull/13961) by [@sjawhar](https://github.com/sjawhar)).
- Fixed arrow keys acting as Escape and terminal query replies appearing as typed text when running omp on Windows over SSH ([#14034](https://github.com/can1357/oh-my-pi/issues/14034)).
- Fixed `/model` under an `enabledModels`/`--models` scope hiding every judge, search, image, and speech model and dropping their configured role assignments (JUDGE, WEB, IMAGE, …) ([#14016](https://github.com/can1357/oh-my-pi/issues/14016))

### Removed

- Removed the internal `urlTokenPossible` export ([#13961](https://github.com/can1357/oh-my-pi/pull/13961) by [@sjawhar](https://github.com/sjawhar)).
- Removed the internal `autolinkSchemeScanIndex` export ([#13961](https://github.com/can1357/oh-my-pi/pull/13961) by [@sjawhar](https://github.com/sjawhar)).

## [18.4.9] - 2026-10-01

### Added

- Exported `wordCompletionQuery()` so hosts outside the editor can apply the same prose eligibility rules used by ghost-text word completion.
- Added a full-featured Background jobs view with selectable jobs, live status and elapsed time, working directory, process IDs, exit code, command, tailing output, and cancellation for running jobs.

### Changed

- `OutputSink` now limits artifact files to 16 MiB by default while preserving the beginning and end of oversized output and marking the omitted bytes. Set `artifactMaxBytes: 0` to keep artifacts unbounded; `dump()` reports omitted bytes and full-output references identify sampled artifacts.

### Fixed

- Reduced unnecessary composer startup-cache writes and ensured the cache database is released when it closes on Windows.
- Fixed Shift+Enter and Ctrl+Enter prompt behavior in Windows Terminal 1.24 and earlier; Shift+Enter now inserts a newline and Ctrl+Enter sends a follow-up, matching other platforms.
- Improved the Tern native terminal experience across background jobs, settings, debugging, logs, extension management, interactive shell, and provider streams: views remain usable and navigable, preserve output and selection behavior, support keyboard scrolling, and keep key actions accessible.
- Fixed multi-line labels in Background jobs and multi-line titles in native-terminal prompts so their formatting remains readable.

## [18.4.8] - 2026-10-01

### Fixed

- Fixed native-terminal (TSP) frames held back by unacknowledged credits waiting for an unrelated render after the 5-second stall fallback expired; a credit-blocked change now renders as soon as the oldest frame counts as stalled.

## [18.4.7] - 2026-10-01

### Added

- Added an optional `terminal` section to theme JSON (`background`, `foreground`, `chrome`, `widget`, 16 `ansi` colors) naming the terminal a theme was made for, for hosts that paint the terminal themselves; the built-in themes ported from known schemes (GitHub, Nord, Dracula, Catppuccin, Solarized, Gruvbox, Tokyo Night, One, Monokai, Rosé Pine, Poimandres, Celestial) carry their scheme's.

## [18.4.6] - 2026-10-01

### Added

- Added a full-page transcript replay experience for Rewind in native terminals, with branching navigation through the conversation.
- Added agent lineage navigation, including headers and links for moving between a subagent and its ancestors or returning to the main session.
- Added a Jobs overlay for viewing background jobs.
- Added OSC 877 protocol support for native TUI surfaces in Windows ConPTY environments.
- Added customizable native screen layouts through Component.describeScreen and programmatic scrolling for native nodes.
- Added native-terminal text editing support for selections in the composer and single-line inputs, including undoable host edits and safe handling of stale or token-spanning ranges.
- Added optional dismissal handling for error banners, including a Dismiss button in native terminal strips.

### Changed

- Notebook evaluation cells now use dedicated input and output gutters with clearer status indicators.
- Streaming file operations now remain expanded while running and collapse after execution completes.
- Improved native-terminal effort indicators, using terminal glyphs where available and block meters as a fallback.
- Updated native composer navigation when viewing a subagent to show the agent lineage and provide a direct return to the main session.
- Native `/resume` picker sheets drop the "Resume session" heading and the This folder / All projects tabs: the search placeholder names the scope ("Search sessions in app…", "Search all sessions…") and Tab (the footer's All projects / This folder action) switches it. Picker `title` is now optional on the wire.
- Updated the native composer's context display to span the window and provide clearer context usage and session-cost information, with shortcuts to the context and usage views.
- Updated status-line billing summaries to show subagent spend separately from session spend and avoid repeating the same currency or subscription marker for subsequent amounts.

### Fixed

- Fixed search results so gaps between non-adjacent context runs are displayed correctly.
- Fixed custom-answer and note prompts in native terminals so questions are shown completely with the correct titles and are no longer truncated or incorrectly wrapped.
- Fixed text fields in native dialogs to render without a duplicate prompt indicator.
- Fixed native TUI surfaces falling back to plain text rendering in Tern on Windows by accepting OSC 877 messages received through ConPTY.
- Fixed streaming edit, patch, and write operation cards so they remain fully visible while running and collapse only after completion.

## [18.4.5] - 2026-09-30

### Added

- Added Factory Droid base-credit badges; models without a dollar-price reference no longer appear free ([#8577](https://github.com/can1357/oh-my-pi/pull/8577) by [@will-bogusz](https://github.com/will-bogusz), continued in [#13276](https://github.com/can1357/oh-my-pi/pull/13276) by [@DusKing1](https://github.com/DusKing1)).

### Fixed

- Fixed home directories next to shell redirections, control operators or Markdown emphasis (`<`, `>`, `&`, `|`, `*`, `_`) leaking the full path in display-only text ([#11210](https://github.com/can1357/oh-my-pi/pull/11210) by [@DarkPhilosophy](https://github.com/DarkPhilosophy)).
- Fixed the subagent task card showing full home paths in tool intents and arguments, while keeping search patterns literal ([#11210](https://github.com/can1357/oh-my-pi/pull/11210) by [@DarkPhilosophy](https://github.com/DarkPhilosophy)).
- Fixed Enter doing nothing on a fully typed slash-command argument while its completion popup was open (e.g. `/mcp list`): it now submits instead of re-accepting the identical completion; subcommands that still need a required argument (e.g. `/mcp test`) keep inserting the subcommand so you can type it ([#13885](https://github.com/can1357/oh-my-pi/pull/13885) by [@H4vC](https://github.com/H4vC)).

## [18.4.4] - 2026-09-29

### Added

- Added Tern Surface Protocol (TSP) integration for native terminal rendering
- Redesigned transcript, chat, dashboard, and picker UI components for native wire representation
- `HookEditorComponent` accepts pasted images when constructed with `acceptImages`; the ask dialog returns them as `customInputImages` / `noteImages` ([#13774](https://github.com/can1357/oh-my-pi/pull/13774) by [@DrFaustus-vic](https://github.com/DrFaustus-vic))
- Added `formatFileMatches` and `FileMatchSection` to `tools/grouped-file-output` for rendering per-file grep/ast-grep matches in grouped or flat mode.

### Fixed

- The model browser shows `varies`, `included`, or `pricing unknown` for models whose catalog declares that state, instead of labeling them `free` ([#11613](https://github.com/can1357/oh-my-pi/pull/11613) by [@will-bogusz](https://github.com/will-bogusz)).

## [18.4.3] - 2026-09-28

### Added

- Added the native composer and dock redesign for Tern: the composer carries its attachment chips, a `bash`/`python` mode chip (with an eye-off mark for `!!`/`$$`), a thinking-effort chip that cycles on click, and a send keycap that turns into Stop while a turn runs; the working row shows the intent, elapsed time and an `esc Stop` button (a countdown ring and Cancel while retrying, indeterminate progress while compacting); queued messages are pills with a count and an Edit button; todos and running subagents are HUD pills; the status strip draws context as a ring meter with the auto-compaction tick, splits the path into a dim parent and strong leaf, keeps model, context and git longest, and opens the model picker, `/context`, `/git`, `/usage` or the project folder on click; autocomplete items carry named icons, the matched prefix, the full description, live state as a value, and scroll the selection into view
- Added the native transcript redesign for Tern: a failed request is one error frame (HTTP status chip, the message once, Retry / Copy error / Switch model), a recovered retry is a quiet disclosable row, user messages drop their header for a hover toolbar (time, Copy, Rewind), thinking streams under a live starburst, timer and rate and folds to "Thought for 12s" when done, status notices are toasts instead of transcript lines, compaction is a centred divider chip, TTSR rules are an inline notice (the rewound text dims with a `rewound` tag), served-model and cache-miss markers are inline notices, late LSP diagnostics join the edit/write frame they belong to, and clicking a recent session on the welcome card resumes it
- Added native rendering in terminals that speak the Tern Surface Protocol (such as Tern): omp describes its UI as semantic components the terminal lays out, draws and animates in your omp theme (both light and dark variants, updated live when you switch or preview themes), so there is no resize replay or repaint flicker and past transcript entries (tool cards, reactions, collapse state) stay live even after they scroll away; `PI_TUI_NATIVE=0` keeps the classic renderer, `PI_TUI_TSP_RECORD=<file>` records the protocol, and the `OMP_TUI_DEBUG` socket gains `doc`/`tsp` ops
- Added Tern Surface Protocol views for `/usage` and `/session`: quota windows are native progress meters on per-provider cards, the activity heatmap is a native table that drops its oldest weeks when narrow, the Details tab lists every account's meters, `/session` details are key/value sections, and per-turn token throughput is a native rate
- Added Tern Surface Protocol views for the remaining tool cards (task, todo, wait, ask, web search, GitHub, goal, LSP, memory, debug, think, vibe, autoresearch, resolve and `xd://` devices): subagents are nested cards, todos are native lists that strike completed items without an animation timer, and job, tool and retry timers are terminal-clocked instead of repainted
- Added Tern Surface Protocol views for the core tool cards (bash, eval, read, write, edit, AST edit/grep, grep, find, glob, process reads/writes, and the generic fallback card): command and file content, diffs, and search hits with their line numbers are sent as semantic nodes instead of rendered rows
- Added Tern Surface Protocol views for `omp ps` monitor, the autoresearch dashboard, the live voice call panel and the `/cleanse` live board: processes are native selectable lists (click selects, double-click opens info), experiment runs are a native table, mic level and repair progress are native meters, and spinners/uptimes are terminal-clocked instead of repainted
- Added Tern Surface Protocol views for the `/btw`, `/btw` history, `/omfg` and `/cleanse` panels, the `/move` dialog, the `/pause` screen, the pinned error banner, hook loaders, the Codex reset celebration and the composer/snapcompact shape previews: answers stream as native markdown, history and directory suggestions are native selectable lists (click selects, double-click follows up or confirms), the snapcompact sample is a native image, and the pause clock, celebration shimmer and cleanse spinners are terminal-clocked instead of repainted
- Added Tern Surface Protocol views for the prompt editor, inputs, pickers and loaders: the composer is a native editor (caret, Vim selection and mode, ghost completion, placeholder, chip/mention/typo decorations, shimmering magic keywords) with autocomplete as a caret-anchored native list, select and settings lists are native lists where clicking an item does what Enter does, forms, the welcome card and composer attachment chips are semantic nodes, and loader spinners, working-message shimmer and dialog countdowns are terminal-clocked instead of repainted
- Added Tern Surface Protocol views for the content primitives: text, boxes (cards toned by their background or border), disclosures and sections (collapsible sections that mirror terminal toggles), markdown (streamed append-only as native markdown), images (native blobs), key/value lists, metric rows (priority-dropping segments), tables (column priorities kept), trees, progress bars, tab bars (clicking a tab selects it), wizard steps, scroll views, row/stack/split layouts, output panes (streamed raw output), tool cards, code and markdown cells, file and tree lists, link spans and LaTeX; theme-styled text becomes theme-token spans instead of escape sequences
- Added Tern Surface Protocol views for the selector and dialog overlays (model hub, model picker and browser, advisor config, settings, plugins, sessions, session tree, rewind, copy, ask, MCP add wizard, hook selector/input/editor, history search, login, OAuth, logout, reset usage, theme, thinking, queue mode, show images): the terminal draws the overlay frame and titles, lists, tabs, search fields, summaries and key hints are native nodes, clicking an item does what Enter does, and dialog countdowns and spinners are terminal-clocked instead of repainted
- Added Tern Surface Protocol views for the live chrome: the session is described as a flowing transcript plus a docked editor, HUDs and status bar; the status bar is a native strip whose segments drop outer-edge-last from your configured left/right order, its turn spinner, timers, token rate and compaction pulse are terminal-clocked, and the `/context` grid, role-cycle track, key hints and collab QR code are semantic nodes
- Added Tern Surface Protocol views for the chat transcript: user prompts are cards with reaction and live-steer badges that update in place on old messages, assistant replies stream as append-only native markdown, thinking blocks are collapsible sections with a terminal-clocked starburst and tok/s rate, tool calls are status cards with a live elapsed timer whose collapse (click or `Ctrl+O`) reaches every card in the transcript, `!`/`$` runs are cards with native terminal output, and compaction, branch, handoff, skill, advisor, custom, TTSR, todo-reminder, late-diagnostics and cache-miss/served-model entries are semantic cards, sections and rules
- Added a native settings page for `/settings`, plugin settings and advisor configuration in Tern: tabs are pages in a side nav with a count of changed settings, each tab has a one-line lead and its groups as sections, settings are real controls (switches, segmented choices, popup menus that preview themes and status-line styles while you hover, steppers for numeric choices, text fields that show your draft and caret, chips and a drag-to-reorder list for multi-selects), changed settings show a dot with the default and a Reset button, risky ones their warning, search results group by page and section, and the status-line preview sits under its section; every pointer action runs the same code as its key
- Added native picker sheets for rewind, `/tree` and `/copy` in Tern: rewind and copy are a timeline of turns (user prompts with their time, tool turns with the tool's icon) over the transcript; the rewind preview is the turn itself as the transcript draws it under an "everything below is dropped" warning with the count, with branch tabs at a fork and the `f` filter as the search field; `/tree` is an indented tree with the active path marked, labels as badges, filter-mode tabs and the entry's content beside it, and Label edits in the preview; `/copy` previews the turn's code blocks, quotes and links as sections you click to copy, with the focused block highlighted; every button and row click runs the same code as its key
- Added native picker sheets for the agent hub and `/agents` in Tern: the hub's roster shows each agent's status, task, model and cost/time/request/tool/token/context columns (flat or by parent) with the selected agent's facts, context meter and recent activity beside it, the Activity tab filters the cross-agent log from a side column with a Follow toggle, and `/agents` lists agents by source with their model, prewalk and advisor overrides and previews the description and system prompt; every button runs the same action as its key
- Added native sheets for omp's dialogs in Tern: plan review is a large sheet titled by the plan's own heading with the Contents as nav rows, annotations as margin notes, Copy / Edit in $EDITOR head buttons and a decision bar whose first option is the hero; the ask dialog is a bottom sheet over the composer with radio/check rows, a Recommended badge, question tabs plus Review, a countdown ring and Submit / Note / Skip buttons; login shows numbered steps (Open sign-in page and Copy link over a one-line URL, a large click-to-copy device code, a live wait, the paste field) with Cancel; `/hotkeys` opens a "Keyboard shortcuts" sheet whose keys are keycaps; the `/btw`, `/omfg`, `/cleanse`, `/btw` history, pause, plan-save, MCP wizard and Codex reset panels are role-styled sheets, and the pinned error banner is an error strip with Details; every button runs the same code as its key
- Added native full-screen apps in Tern: `omp git`/`/git` is a native diff (File / Split / Inline / Hunks segmented control, change navigation, whitespace and wrap toggles, Stage file) beside a changes sheet with Path/Tree lists, tinted status pills and hover `Stage all`/`Unstage all`, and a docked commit composer (borderless summary with a counter while typing, body, Amend toggle, Commit button); `?` opens a keyboard shortcuts sheet in both renderers; `omp ps` is a page with a scope control, state-toned process rows and an Info / Logs / Restart / Stop / Kill action bar (a pointer Kill asks first); `/cleanse` shows repair lanes as live agent rows under a lane meter; the autoresearch dashboard charts the metric per run and opens as a sheet; the live call panel has a mic meter and Mute / End call buttons; and the `omp cleanse` and `omp setup` pickers are native picker sheets
- Added native picker sheets for `/resume`, `omp --resume` and ⌃R history search in Tern: sessions are two-line cards (title, first prompt or project folder, age, size, status dot, pin, fork and current badges) grouped Pinned / Today / Yesterday / This week / Earlier and ranked flat while you search (prompt-history matches get a `history` badge), with This folder / All projects tabs, a preview of the selected session's facts and conversation, an inline delete confirmation and Resume / Delete / All projects / Close buttons; `omp --resume` fills the screen; history search is a compact sheet of past prompts with the matches marked, their age and folder, and an Insert button
- Added native picker sheets for `/model` and the alt+p / `/switch` model picker in Tern: the model hub is a large sheet with Roles, All models and provider scopes (initials marks, live per-query counts, discovery-state dots, signed-out providers grouped under "Not signed in"), kind tabs with counts, right-aligned Int / t/s / context / $/M columns, a Recent group then one group per provider, role chips with thinking-level dots, a preview pane (copyable id, context, output, price, speed, intelligence, the roles the model can fill, description), the role-assignment strip, the Roles view with fallback chains, and loading/empty states; the quick picker is a compact sheet with the model summary and role chips below the list and a Task model toggle; every row, scope, tab, chip and button runs the same path as its key
- Added Tern Surface Protocol views for the startup splash and setup wizard: the brand mark shimmers natively, every scene (sign-in, model, glyph, composer, theme) is sent as semantic text, spinners, links and inputs, and the splash and outro advance on their deadlines without per-frame repaints

### Changed

- Reduced frame spikes and memory while long assistant replies retire into scrollback mid-stream: retiring rows no longer re-renders the whole published reply once per row, and the transcript no longer rescans the entire session history every frame ([#13650](https://github.com/can1357/oh-my-pi/pull/13650) by [@H4vC](https://github.com/H4vC)).
- Reduced memory held by finished messages: streamed Markdown blocks release their streaming row caches, frozen lex tokens, and syntax-highlight streams when they finalize, and the Mermaid render cache is now size-bounded ([#13650](https://github.com/can1357/oh-my-pi/pull/13650) by [@H4vC](https://github.com/H4vC)).
- Reduced per-frame CPU while streaming Markdown, edit previews (header facts are reused across frames; replace previews process only the visible lines), bash previews (highlighting is deferred to paint and the highlight cache is size-bounded), interleaved thinking blocks, and the live bash/ssh output tail ([#13650](https://github.com/can1357/oh-my-pi/pull/13650) by [@H4vC](https://github.com/H4vC)).
- Changed git status refresh interval to 10 seconds and added generation tracking to avoid stale counts after HEAD moves

### Fixed

- Fixed streaming bash previews showing fields that follow the `env` object (e.g. `command`) as environment assignments ([#13650](https://github.com/can1357/oh-my-pi/pull/13650) by [@H4vC](https://github.com/H4vC)).
- Fixed model picker latency by avoiding unnecessary catalog rebuilds
- Fixed search and filter fields in pickers and lists (model switcher, model and agent hubs, session, history, rewind, tree, hook, sign-in, extension and select lists, the log viewer) ignoring the editor's text keys: every field is now a full single-line input, so word jumps (ctrl/alt+←/→, alt+b/f), line start/end (ctrl+a/e), word and line deletion (ctrl+w/u/k, alt+d), yank, forward delete and undo work everywhere, follow your `tui.editor.*` keybindings, and in Tern the caret is drawn where it actually is in the picker and settings search
- Fixed omp in Tern showing the classic renderer for the first seconds of startup before switching to the native view: with `TERM_PROGRAM=tern` (outside tmux/screen/zellij, unless `PI_TUI_NATIVE=0`) the very first frame is native, the `hello` handshake confirms it in the background, and a terminal that never confirms falls back to the classic renderer with a clean repaint after 1 s
- Fixed the welcome card's logo in Tern not matching omp's terminal mark: the bar now overhangs both legs equally, the legs and gap have the terminal proportions, and the left leg ends in the same faded tail
- Fixed the `@` completion popup showing a `Searching…` placeholder while a refreshed file search is pending; the popup now stays hidden until results arrive, and Escape is no longer swallowed by it
- Fixed multi-line IME and dictation input (for example, voice input in Ghostty or cmux) being sent as one message per line; it now lands in the prompt as a single multi-line draft, while Enter typed during a UI freeze still submits ([#13378](https://github.com/can1357/oh-my-pi/pull/13378) by [@goransh-walia](https://github.com/goransh-walia))

### Removed

- Removed the setup wizard's "Web search" tab; the providers scene is now sign-in only, and web search is chosen through the `web` model role like other kind roles.

## [18.4.2] - 2026-09-28

### Changed

- Optimized activity clock rendering by caching timestamp formatting strings
- Reduced CPU overhead during animated terminal redraws, transcript updates, inline-image bookkeeping, and status-line layout.
- Reduced per-keystroke CPU in `^` model-mention autocomplete and per-frame CPU while streaming (status line, live transcript blocks, tool cards, frame writes).

### Fixed

- Fixed the `@` completion popup swallowing Tab and cursor-movement keys while a narrowed filter matched nothing: with no candidate to accept they now fall through to their normal completion and cursor roles instead of being trapped ([#13046](https://github.com/can1357/oh-my-pi/pull/13046) by [@jchanghong023](https://github.com/jchanghong023)).
- Fixed the Esc-Esc rewind and fullscreen `/copy` selectors getting stuck at the oldest turn of a long session's recent tail; stepping past it now loads the earlier history
- Fixed the composer attachment band showing chip `#1` (and other prefix IDs) as still present when only `#10` remained in the prompt ([#13605](https://github.com/can1357/oh-my-pi/issues/13605))

## [18.4.1] - 2026-09-28

### Breaking Changes

- Replaced `AgentsHubDeps.setDisabledAgents`/`setOverrides` with `setAgentDisabled(name, { disabled })` and `setAgentOverride(property, name, value)`, so each hub edit persists only the agent it changes; `PropertyKind` is exported ([#13308](https://github.com/can1357/oh-my-pi/pull/13308) by [@Vortex727](https://github.com/Vortex727))

### Changed

- LSP servers section is omitted from the welcome screen when LSP is disabled
- Usage dashboards and provider cards can show connected accounts with unavailable usage separately from reported quotas, without treating missing reports as unused or unlimited ([#13476](https://github.com/can1357/oh-my-pi/pull/13476) by [@aktanazat](https://github.com/aktanazat)).

### Fixed

- Fixed sessions exiting as if the terminal hung up when it only stopped reading for a few seconds during a very large repaint (a long transcript's replay behind a busy tmux or container attach) ([#13576](https://github.com/can1357/oh-my-pi/pull/13576) by [@sjawhar](https://github.com/sjawhar))
- Fixed fullscreen overlays rewriting the whole terminal on every change; each frame now repaints only the rows that changed ([#13568](https://github.com/can1357/oh-my-pi/pull/13568) by [@sjawhar](https://github.com/sjawhar))
- Fixed the armed `/loop` status reading `Loop waiting`, which hid that the next prompt becomes the repeated loop body; it now reads `Loop: next prompt repeats` ([#13435](https://github.com/can1357/oh-my-pi/pull/13435) by [@Dante-dan](https://github.com/Dante-dan)).
- Reduced memory held by long sessions: committed transcript blocks no longer keep their rendered-row caches ([#13242](https://github.com/can1357/oh-my-pi/pull/13242) by [@iliaal](https://github.com/iliaal)).
- Fixed the results-limit notice advising `Use limit=` values the tool would clamp straight back; at the hard cap it now reports the reached count alone ([#13263](https://github.com/can1357/oh-my-pi/issues/13263))
- Fixed the rewind filter finding nothing for query words in scripts without spaces (e.g. Chinese): non-Latin words now match as substrings while Latin words keep whole-word matching ([#13361](https://github.com/can1357/oh-my-pi/pull/13361) by [@jchanghong023](https://github.com/jchanghong023))
- The Esc-Esc rewind selector opens on the recent tail of long sessions instead of replaying the whole branch; press `a` to load earlier turns ([#12819](https://github.com/can1357/oh-my-pi/pull/12819) by [@lemonleks](https://github.com/lemonleks)).
- Fixed OSC 8 hyperlinks (file paths, URLs, GitHub refs) rendering as plain text in Herdr panes. Herdr reports `TERM=xterm-256color` without `TERM_PROGRAM`, so its panes were treated as an unknown terminal, although Herdr renders OSC 8 itself and opens links on Ctrl+click. Screen or tmux nested inside a pane still follow their own rules, and `PI_NO_HYPERLINKS=1` still opts out ([#13289](https://github.com/can1357/oh-my-pi/pull/13289) by [@andrebrait](https://github.com/andrebrait)).
- Fixed native stderr output painting over the TUI on Linux ([#13176](https://github.com/can1357/oh-my-pi/issues/13176)).
- Fixed heavy lag while output streams with inline images on SIXEL terminals such as Orca: each visible image was re-encoded on every render pass ([#12998](https://github.com/can1357/oh-my-pi/pull/12998) by [@wimjan123](https://github.com/wimjan123))
- Fixed Kitty-protocol terminals re-encoding every non-PNG image on redelivery and transcript rebuilds ([#13118](https://github.com/can1357/oh-my-pi/issues/13118)).
- Fixed the Windows Terminal taskbar progress animation restarting every second while the agent works ([#12940](https://github.com/can1357/oh-my-pi/pull/12940)).
- Fixed resuming a long session freezing the TUI for several seconds; first paint is now spread across frames ([#12933](https://github.com/can1357/oh-my-pi/issues/12933)).
- The model hub no longer opens a thinking strip or shows the `t` hint for models that cannot reason ([#13112](https://github.com/can1357/oh-my-pi/pull/13112)).

## [18.4.0] - 2026-09-28

### Fixed

- Prevented interrupted wait operations from appearing in the transcript when a queued completion or message is received.

## [18.3.5] - 2026-09-27

### Added

- Added an "OpenAI API" option to the setup wizard's web-search step; the existing ChatGPT-OAuth option is now labeled "OpenAI Codex" ([#13467](https://github.com/can1357/oh-my-pi/pull/13467) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).

## [18.3.3] - 2026-09-27

### Added

- Added responsive ghost-text word completion with pluggable backend providers, context-aware prose filtering, and feedback support.
- Improved autocomplete responsiveness for high-latency file discovery by showing interim suggestions and a searching state while results are refreshed.

### Changed

- Improved word-completion acceptance and persistence when typing through existing ghost text, including more natural handling of trailing spaces and punctuation.
- Made keyboard labels across the TUI platform-aware so shortcuts are displayed using the appropriate key names for the user's operating system.
- Updated the process monitor to distinguish target scope from current and global scope in its labels.

### Fixed

- Fixed autocomplete submission so Enter commits the current input correctly while suggestions are still loading.
- Fixed the background tint for truncated skip lines.

### Removed

- Removed the legacy TinyTitleDownloadProgress overlay in favor of the centralized agent HUD.

## [18.3.1] - 2026-09-25

### Breaking Changes

- Replaced the `CustomEditor` space-hold callbacks and `sttHoldEnabled` option with the `spaceHold.handler` API.
- Removed `Editor.cursorOverrideWidth`; widths for `cursorOverride` glyphs are now measured automatically.

### Added

- Added push-to-talk dictation to `Input`, with live transcription and `cursorOverride` support.
- Added visual indicators for live-steered user messages and paginated content in read-tool results.
- Added transcript support for `cfg://` configuration read and write tool calls.
- Added an Anthropic slow-mode badge to the status-line model segment, showing the priority state, end time, and remaining request percentage when available.

### Changed

- Updated the settings selector so clearing an input field fully unsets the corresponding setting.

### Fixed

- Fixed dimmed blockquote styling after inline code spans.
- Fixed rendering of tool calls and results for top-level extension and MCP tools invoked through `xd://` links.
- Fixed file links in pending Read and Write cards so they open the correct local targets, including paths in the home directory, archives, and databases.

## [18.3.0] - 2026-09-24

### Added

- Added proc:// and agent:// URI support for interacting with processes and agents.
- Added support for xd:// documentation topic URLs.
- Added rendering for background job state and peer-to-peer messages from the wait tool.
- Added supervised bash service rendering with status, readiness, and output information.
- Added a fullscreen annotation overlay for diffs and text, including multi-line notes, editing, deletion, and undo ([#12601](https://github.com/can1357/oh-my-pi/pull/12601) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added Daybreak-enabled account listings to the usage dashboard.

### Changed

- Mermaid flowcharts and state diagrams now automatically choose a layout that best fits the available terminal width and reflow when the terminal is resized.
- Plan Review annotations now support multi-line editing, deletion, and undo ([#12601](https://github.com/can1357/oh-my-pi/pull/12601) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).

### Fixed

- Fixed AltGr characters, including `[`, `]`, `{`, and `}`, being dropped in Windows Terminal when using the kitty keyboard protocol on Hungarian and other international keyboard layouts ([#12984](https://github.com/can1357/oh-my-pi/pull/12984) by [@H4vC](https://github.com/H4vC)).

## [18.2.11] - 2026-09-23

### Added

- Added a Skills section to the settings.
- Enabled OSC 8 hyperlinks in rio.

### Fixed

- Fixed scrolling startup release notes without requiring an initial Escape keypress.
- Improved usage quota display so names remain distinguishable and readable in narrow and multi-column dashboards.

## [18.2.10] - 2026-09-22

### Changed

- Added support for multiple concurrent TUI paint listeners to enable simultaneous session recording and streaming
- Coalesced status event updates for progress-based operations to reduce TUI render overhead

## [18.2.9] - 2026-09-22

### Added

- Added Claude and Codex saved-reset counts, availability, and expiry to usage views, with provider-specific confirmation and uniquely identified account options.
- Added terminal detection and capability support for otty and rio, including Kitty graphics and true-color support where available, plus otty hyperlinks and notifications.
- Added the public `stripTerminalSequences` export for extensions that need to remove terminal control sequences.

### Fixed

- Composer shape previews now use the full available overlay width instead of being clipped at 96 columns.
- Fixed cursor placement when recalling prompts from history, keeping single-line entries at the end and preserving the appropriate position for multi-line entries.
- Restored modified-key handling and terminal notifications over SSH sessions running inside tmux.
- Fixed typed Enter occasionally being interpreted as a literal newline when terminal input events are batched.

## [18.2.8] - 2026-09-21

### Changed

- Improved Bash tool background-task notices by providing completed output as a follow-up and discouraging unnecessary polling.

## [18.2.7] - 2026-09-21

### Breaking Changes

- Removed specialized keyword modules in favor of a centralized registration system

### Added

- Added `find` tool renderer to display search results with hit ranking and score visualization
- Supported collapsing/expanding search hit details and range snippets
- Enabled file hyperlinking for navigation to absolute paths in search results
- Added streaming progress display for incomplete find tool operations
- Added Glyph Protocol support for rendering icons without requiring patched fonts
- Added `setMagicKeywords` for dynamic configuration of highlightable magic keywords

### Fixed

- Prevented magic keywords from triggering spelling autocorrect and underlining

## [18.2.5] - 2026-09-17

### Added

- Added the full coding-agent terminal UI to the package, including themed rendering primitives, shared chrome, tool renderers, chat transcripts, overlays and hubs, status lines, prompt and autocomplete controls, setup flows, and standalone utilities such as the Git TUI, process viewer, debug viewers, boards, and pickers.
- Added reusable terminal UI components for forms, menus, split layouts, disclosures, tree views, tool cards, data widgets, fullscreen hubs, scrollable overlay navigation, and interactive footer chips.
- Added live viewer counts to the status line and exposed paint observers through `TUIOptions.onPaint` and `TUI.setPaintListener` for hosts that need to track committed scrollback and viewport rows.
- Added details and notes fields to todo items, plus an interactive task-list renderer for managing subtasks.
- Added inline summaries for structured task outputs.
- Added image input validation with automatic conversion of unsupported formats and support for video previews in chat.
- Added the MCP Add Wizard for streamlined server configuration.
- Added an `autoresearch` tool renderer for tracking experiments.
- Added side-by-side diff rendering for merge conflicts and improved presentation of GitHub Actions workflow jobs and runs.
- Added the `dark-celestial` built-in theme with a twilight palette and pink, coral, purple, cyan, and peach accents.

### Changed

- Overhauled JSON tree visualization with syntax highlighting, item counts, clearer indentation, and a simplified layout.
- Improved agent task, evaluation, hub, and model displays with clearer layouts, better truncation, and metric support.
- Standardized form labels, descriptions, and overlay styling, and improved overlay text rendering by collapsing newlines consistently.
- Updated spinner animations to use theme-consistent frames and refined tool-output notice stripping for more consistent display.
- Improved performance and responsiveness when rendering long-running Bash streams and large or continuously updating terminal content.

## [18.2.4] - 2026-09-17

### Fixed

- Fixed inline images disappearing or temporarily blanking when resizing the terminal in kitty and Ghostty.

## [18.2.3] - 2026-09-17

### Added

- Editors support whitespace-delimited `^` mention autocomplete and expose registered atoms for host-defined chip rendering.

### Changed

- `fuzzyRank` accepts readonly candidate arrays without copying them.

### Fixed

- Masked inputs no longer expose their text in diagnostic previews.

### Removed

- Removed the internal `fastTailSplices` and `resetFastTailSplices` Markdown instrumentation exports.

## [18.2.1] - 2026-09-15

### Added

- `Editor.deleteCharForward()` exposes the `tui.editor.deleteCharForward` operation to hosts that resolve the chord themselves, applying the same transient-state teardown the key dispatch does (pending character jump, spelling-assist popup) and routing through Vim's `x` in Normal and Visual modes.

### Changed

- Inline image limits now bound Kitty graphics retained from earlier frames and fullscreen overlays; older scrollback images are evicted until replayed.

### Fixed

- Enter now runs a slash command whose argument completes to a directory, instead of descending into it. ([#12112](https://github.com/can1357/oh-my-pi/pull/12112) by [@Huang-404-Q](https://github.com/Huang-404-Q))
- Fixed a resize on Windows leaving the screen with a scrolled-up duplicate transcript and no visible response to input. The in-place resize path (default-on for Warp) anchors one settled repaint on a DSR round trip, but a ConPTY host owns that grid: measured on conhost, resizing the pseudoconsole re-emits its whole viewport from `CSI H` with absolute addressing while the application writes nothing, and re-homes the cursor, so the reply reports column 1 and can never be attributed to its probe tag. ConPTY sessions now keep the alternate-screen borrow, whose settled transaction ends in the `ResizeScrollbackMode` rebuild, and skip that unattributable anchor probe — except inside a multiplexer, which answers the DSR from its own grid, and under `PI_TUI_RESIZE_IN_PLACE=1`, which restores the whole pre-change path ([#11625](https://github.com/can1357/oh-my-pi/pull/11625) by [@bse-ai](https://github.com/bse-ai)).
- Stopped exact-width live rows from entering native scrollback during ConPTY repaints ([#9783](https://github.com/can1357/oh-my-pi/issues/9783)).
- Forward delete no longer leaves the Vim Normal-mode cursor one column past the end of a line after deleting the final grapheme.
- Fixed Tabby CMD sessions enabling synchronized output from a spoofed `WT_SESSION`, which caused streaming repaints to overlap when Tabby's terminal chain mishandled DEC 2026.
- Extension command argument completions now refresh after typing a Space when the previous argument had no suggestions. ([#11060](https://github.com/can1357/oh-my-pi/issues/11060))
- Detect the wmux Windows terminal multiplexer (`WMUX` / `WMUX_SURFACE_ID`) so its panes take the in-place viewport repaint path instead of the direct-terminal scrollback path.

## [18.2.0] - 2026-09-15

### Added

- Added `Editor.textRevision` for content-dependent render caches, including undo and draft restoration.
- Added collapseToAtom method to compress text spans into UI-friendly atoms

### Changed

- Redrawing unchanged terminal rows now avoids rescanning ANSI, hyperlinks, and images.
- Terminal UIs reach their first frame with a smaller startup module graph.

## [18.1.17] - 2026-09-10

### Added

- Editor history can retain local draft snapshots with their paste expansions and host-owned attachment restoration, without writing them to persistent history ([#11524](https://github.com/can1357/oh-my-pi/pull/11524) by [@camjac251](https://github.com/camjac251)).
- Added an optional Vim-style modal editing layer to `Editor`, off unless `setVimMode(true)` is called: Insert, Normal, and Visual/Visual-Line with motions, count prefixes, and operators. `j`/`k` keep Vim's desired column, so passing over a shorter line does not collapse it, and `$` sticks to end-of-line. `p`/`P` paste from an internal register; yanks are surfaced to the host through `onYank` so it can route them to the system clipboard.
- Vim mode now exposes its chrome to hosts: `Editor.vimEnabled`, `Editor.vimPending` (the half-typed command, e.g. `2d`), and `Editor.vimSelectedLines` (Visual selection height). `onVimModeChange` additionally fires when the pending command or selection size changes, not only on mode switches.
- Vim mode now understands text objects: `iw`/`aw` (and `W`), quotes `i"`/`a'`/`` a` ``, bracket pairs `i(`/`a{`/`i[`/`a<` (nesting-aware and multi-line), and paragraphs `ip`/`ap`. They work under an operator (`diw`, `ca(`) and in Visual mode (`viw`), with counts (`d2aw`). Previously `i` after an operator fell through to Insert mode, so `diw` typed text instead of deleting a word.
- Vim mode's `c` operator now actually enters Insert mode (`cw`, `cip`, `c` in Visual); it also follows Vim's `cw`-acts-like-`ce` quirk and parks the cursor correctly when the changed range is empty (`ci"` between bare quotes).
- Added `Terminal.setCursorShape()` (DECSCUSR), restored to the terminal's configured shape on teardown and crash cleanup.

### Changed

- The software cursor now reflects the Vim mode: a reverse-video block in Normal/Visual and an underline in Insert. Both occupy one cell, so layout is unchanged, and non-modal editors keep the reverse-video block they always had.

## [18.1.15] - 2026-09-08

### Fixed

- Stopped long flicker when moving or resizing an omp pane in Warp. Resize repaints in place there after the drag settles (override with `PI_TUI_RESIZE_IN_PLACE=0`), with no alternate-screen borrow, no scrollback replay, blanked live rows so shrink drags cannot archive unfinished rows, and overlay toggle echoes repainting the modal instead of probing ([#11247](https://github.com/can1357/oh-my-pi/pull/11247) by [@H4vC](https://github.com/H4vC)).

## [18.1.14] - 2026-09-07

### Fixed

- `extractMarkdownLinks()` now returns one-row visible labels for formatted and multiline links ([#11086](https://github.com/can1357/oh-my-pi/pull/11086) by [@mustafaabidali](https://github.com/mustafaabidali)).

## [18.1.13] - 2026-09-07

### Fixed

- Fixed notifications never arriving in a Herdr pane. Herdr multiplexes panes like tmux but swallows bare OSC 9 / OSC 99 and has no passthrough envelope, so a backgrounded pane got no signal at all; delivery now goes through `herdr notification show` (a waiting question or an error rings `request`, a settled turn rings `done`), and the in-band write stays as the fallback when the pane id or the `herdr` binary is missing.

## [18.1.12] - 2026-09-06

### Fixed

- Avoid inserting a trailing space when auto-completing directory paths with `@`, and keep autocomplete open when accepting a directory with Tab or Enter.
- Horizontal wheel reports (the sideways drift of a two-finger trackpad scroll) no longer decode as a vertical wheel direction, so fullscreen selectors such as `/copy` and the rewind picker stop jumping up and back down at the end of a scroll gesture.

## [18.1.9] - 2026-09-04

### Added

- Added Markdown hyperlink target resolution while preserving the displayed URL text.

## [18.1.6] - 2026-09-03

### Fixed

- Fixed the band composer layout so the status line remains visible and no longer causes the prompt to shift unexpectedly when the top border is empty.

## [18.1.5] - 2026-09-03

### Fixed

- Fixed terminal query support in supervised PTY processes, including cursor position reports.
- Fixed paste-and-submit handling so an Enter keypress received with a bracketed paste is delivered to the previously focused component; `Editor.onLargePaste` now receives `PasteOptions` describing the queued submit.

## [18.1.3] - 2026-09-02

### Fixed

- Fixed the TUI tearing in Herdr panes so the live viewport updates as one frame instead of leaving the top frozen while only the bottom refreshed. Pane identity vars (`HERDR_PANE_ID` / `HERDR_TAB_ID` / `HERDR_WORKSPACE_ID`) also count as inside Herdr, not only `HERDR_ENV=1`. A DECRPM “unrecognized” report keeps synchronized output on; a “permanently reset” report, or a custom terminal that omits the DECRPM status, still turns it off.

## [18.1.0] - 2026-09-01

### Fixed

- Improved terminal stability when resuming image-heavy sessions, preventing large transcript repaints from being mistaken for stalled output or exceeding the terminal output limit.
- Fixed inline images leaving blank rows in Herdr panes when resuming or rendering sessions in nested terminals.
- Fixed the TUI crashing on reference-style Markdown links whose labels match JavaScript built-in names; these links now render safely as plain text.
- Fixed fatal cleanup leaving the cursor inside a focused input before error output is displayed.
- Fixed resumed sessions showing stale background bands until the next keypress in WSL and Windows Terminal.

## [18.0.11] - 2026-08-29

### Added

- Added `setTerminalHyperlinks()` to let hosts control OSC 8 hyperlink behavior in rendered Markdown links.

### Fixed

- Fixed inline color swatches appearing for words with hex-like prefixes, such as `#each`; swatches now appear only when the entire word is a valid color.

## [18.0.10] - 2026-08-28

### Added

- Press the Right Arrow at the end of a line to accept autocomplete suggestions, inline ghost-text completions, and spelling corrections, just like Tab.
- Added a smooth brand-color transition and an elapsed turn timer to the status line while the agent is working.
- Added a full-width “band” composer style for flush status lines.

## [18.0.9] - 2026-08-28

### Added

- Exported TuiDebugServer for programmatic headless control
- Added debug demonstration script to examples
- Added an `OMP_TUI_DEBUG` Unix socket for headless TUI driving and structured inspection.

### Changed

- Inline hex colors now render with VS Code-style colored backgrounds and automatically selected black or white text for readability, alongside the color swatch.
- LaTeX text formatting commands such as \textbf, \textit, \textsl, and \emph now render as terminal bold or italic text.

### Fixed

- Fixed inline color swatches rendering incorrectly inside highlighted lines.
- Fixed terminal resizing in tmux panes and Windows consoles duplicating the current in-progress turn in scrollback.

## [18.0.8] - 2026-08-27

### Added

- `ProcessTerminal` accepts a `conpty` option to force ConPTY-hosted behavior on or off, keeping terminal tests hermetic on WSL where live env detection would otherwise flip kitty-keyboard flags and write chunking ([#9887](https://github.com/can1357/oh-my-pi/issues/9887)).

### Fixed

- Fixed pending-work animations repeatedly composing expensive frames without applying their full render cost to CPU backpressure.
- Fixed unfinished live viewport rows entering tmux pane history and duplicating streamed output ([#9780](https://github.com/can1357/oh-my-pi/issues/9780)).

## [18.0.7] - 2026-08-26

### Breaking Changes

- Removed the `inlineMathSpanEnd` and `mathStartIndex` exports; the math delimiter grammar now lives in `@oh-my-pi/pi-utils/math-delimiters`.

### Fixed

- Math spans now end at the first unescaped delimiter, so a TeX row break no longer closes a span early: `\(a \\) b\)` renders as one equation, and an escaped `\$` no longer ends `$$…$$`.
- Fixed image previews displaying as garbled characters in Paseo terminals.
- Fixed terminal resizing from duplicating committed history in native scrollback.
- Fixed autocomplete suggestions for bare-name skills such as `/batch` when no command matches the prefix more strongly.

## [18.0.6] - 2026-08-26

### Added

- Added `Markdown.getLastRenderStableText()` to expose the stable prefix of streamed Markdown text for append-only transcript publication.

## [18.0.5] - 2026-08-25

### Breaking Changes

- Renamed the public `TerminalFrameProvider.resetHistory` method to `beginHistoryReplay`.

### Added

- Loader messages can now be provided as a function, allowing dynamic labels such as live countdowns to update on each spinner tick while preserving the existing behavior for static strings.

### Changed

- Improved history replay and terminal output handling so replayed content is rendered efficiently and complete replay results are written together.

### Fixed

- Fixed graceful shutdown so finalized output is correctly retired before handing control back to the shell.
- Fixed terminal scrollback corruption during shutdown, tmux pane zoom and resize, and destructive screen resets, preventing duplicated frames, lost history, and stale transcript re-streaming.
- Fixed streaming Markdown rendering at chunk boundaries to preserve CommonMark emphasis behavior for Unicode text and correctly recognize GFM tables as they are completed.

## [18.0.4] - 2026-08-24

### Changed

- Significantly improved streaming Markdown rendering performance by caching unchanged rows, resuming boundary walks, and inspecting only text deltas for guard scans and OSC 8 normalization.

### Fixed

- Fixed TUI aborting when syntax highlighting fails during Markdown rendering by falling back to unhighlighted text.
- Fixed Korean IME cursor drift in Orca by properly matching two-cell Hangul Compatibility Jamo rendering.

## [18.0.3] - 2026-08-23

### Fixed

- Fixed inline images vanishing from the transcript and scrollback when the session exits: stop no longer deletes transmitted Kitty images from the terminal's graphics store.

## [18.0.2] - 2026-08-23

### Fixed

- Fixed visible history being erased when enlarging the terminal.

## [18.0.1] - 2026-08-23

### Added

- Collapsed individual skill commands into a `/skill:` namespace entry to declutter suggestions
- Added `TUI.renderNow()` for terminal-safe synchronous priority frames that retain resize debounce, output-backlog, and image deferral safeguards.

### Changed

- Improved slash command autocompletion to chain suggestions after selecting a namespace
- Replaced the native-scrollback inference API (`NativeScrollback*` interfaces and the scrollback rebuild/resize settings hooks) with explicit `TerminalFramePlan` history batches.
- Post-resize repaints now recover the reflowed viewport anchor with a cursor-position report (DSR) instead of trusting stale grid coordinates, so a settled resize no longer duplicates the editor/status rows on screen.
- History appends that overflow the screen erase the old live viewport first, so a scroll can only push committed rows and blanks into scrollback, never an unfinished frame.

### Fixed

- Fixed consecutive prompt submissions being skipped by persistent history, allowing the latest project metadata to replace the previous entry without duplicating editor navigation history.
- Fixed the history drain stalling on idle screens: accepting a batch now pumps the next frame, so a large resumed transcript retires to terminal history instead of pinning the live viewport in its emergency aggregate.
- Fixed fuzzy matching so a qualifying whole-word hit is not hidden by an earlier mid-word occurrence ([#8465](https://github.com/can1357/oh-my-pi/pull/8465) by [@Mustaqeem66](https://github.com/Mustaqeem66)).
- Fixed stray characters appearing in the terminal viewport during title updates
- Fixed editor input lag when autocomplete providers are slow by keeping only the latest pending lookup.
- Fixed pasting an image in kitty occasionally spraying base64 text into the composer alongside the image attachment: a kitty OSC 5522 clipboard packet torn by the incomplete-escape flush is now discarded up to its terminator instead of being replayed as keystrokes.
- Fixed Kitty OSC 66 headings activating before the host explicitly enables text sizing.
- Markdown streaming renderer now scans only the mutable tail (not the full document) for reference-link definitions and CR on every frame, eliminating the O(n²) `RegExp.test` cost that accounted for ~26% CPU during active streaming ([#9048](https://github.com/can1357/oh-my-pi/issues/9048)).

## [18.0.0] - 2026-08-22

### Breaking Changes

- Changed native macOS spelling and completion functions to return Promises.
- Updated `EditorTextAssistProvider.tryAutocorrect` signature to receive editor state instead of raw text.
- Updated `Editor.decorateText` signature to provide line and column context instead of raw text.

### Added

- Added `EditorTextAssistProvider` with spelling suggestion support (`ctrl+.`), word replacement choices, and async autocorrection handling.
- Added `Terminal.pendingOutputBytes` and an output-backpressure render gate to drop stale frames on slow terminals.
- Added `deferInput` startup option and `enableInput()` across `Terminal`, `TUI`, and `TUIStartOptions` to improve startup responsiveness.
- Added icon support and customizable theming to autocomplete and select lists.
- Added `MarkdownTheme.createHighlightStream` for incremental syntax highlighting of completed lines in streaming Markdown code blocks.
- Added `maxDescriptionRows` option to `SelectList` layouts to truncate wrapped descriptions with an ellipsis.
- Added `commandUsage` ranking callback support to `CombinedAutocompleteProvider` to prioritize frequently used slash commands.
- Added `Editor.viewportRowsProvider` to constrain autocomplete dropdowns within the available terminal height.
- Added `Editor.setTheme()` to dynamically change themes without recreating the editor or losing draft content.

### Changed

- Adjusted word completion to skip appending a trailing space when the following character is punctuation.
- Increased default autocomplete dropdown height from 5 to 10 items.

### Fixed

- Fixed TUI freezing during large repaints on slow or occluded terminals by moving stdout writes to an off-thread writer.

## [17.4.4] - 2026-08-22

### Added

- Added `setResizeScrollback()` / `ResizeScrollbackMode` (`PI_TUI_RESIZE_SCROLLBACK` env initializer) controlling what a settled in-place width resize does to native scrollback, which the host rewraps naively at the old width: `append` replays the transcript at the settled width below the old-wrap history, `rebuild` clears pane history first (ED3) so it holds exactly one current-width copy, and `preserve` repaints the viewport only with zero history growth. The raw engine defaults to `preserve`; the coding agent's `tui.resizeScrollback` setting (default `append`) governs interactive sessions.

### Fixed

- `visibleWidth` now measures APC sequences (Kitty graphics commands, cursor markers) as zero cells instead of counting their payload as printable text, matching the native width engine.
- Kitty Unicode-placeholder rows with long styled prefixes (e.g. bordered thumbnail cards) are recognized as image lines again, keeping them on the verbatim render path instead of SGR coalescing/truncation.
- Fixed multiplexer width-epoch resolution failing for every real component tree, which forced the conservative full-transcript replay (and one duplicated transcript copy in pane history) on every settled width resize: leading children without a width-epoch revision are no longer validated by width-dependent row counts (reflow is not mutation — identity plus the revision, when reported, is the stability proof), and `Markdown` now reports a width-independent mutation revision so it can sit above an epoch source ([#8193](https://github.com/can1357/oh-my-pi/issues/8193), [#7026](https://github.com/can1357/oh-my-pi/issues/7026)).

## [17.4.2] - 2026-08-21

### Added

- Editor atom table: `insertAtom`/`registerAtom` stage compact atomic tokens whose registered expansion is emitted on submit (`getExpandedText`), alongside the existing paste-marker store.

## [17.4.1] - 2026-08-21

### Added

- Added optional `getNativeScrollbackLiveRegionPinnedStart()` hook to allow nested transcripts to pin a later dashboard without shifting the earliest live seam.

## [17.4.0] - 2026-08-20

### Added

- Added composer border styles (`box`, `claude`, `pi`, `borderless`) via `ComposerStyle` objects and `getComposerStyle`, unifying chrome geometry and rendering across the editor and previews.
- Added support for warning risk notes and row markers in settings lists.

## [17.3.8] - 2026-08-19

### Fixed

- Fixed images rendering as the `[Image: …]` text card on SIXEL terminals that expose no identifying environment variable (foot, xterm, contour): the graphics probe no longer requires Windows Terminal, and no longer reads an XTSMGRAPHICS success reply as a failure.
- Fixed the multiline editor ignoring a `tui.input.submit` remap onto Ctrl+Enter: the hardcoded Ctrl/Shift+Enter → newline fallbacks now yield to an explicit submit binding, so Ctrl+Enter can be used to submit ([#8906](https://github.com/can1357/oh-my-pi/issues/8906)).

## [17.3.5] - 2026-08-16

### Fixed

- Fixed long CPU-bound event-loop stalls being misclassified as system sleep and omitted from loop-blocked diagnostics.
- Fixed focused components with markers falling back to full-screen redraws instead of direct row updates, preserving cursor position and native scrollback across marker changes.

## [17.3.4] - 2026-08-14

### Fixed

- Fixed a terminal Device-Attributes reply leaking into the composer as literal text (e.g. `1;22;…;52c`) when it arrived after the startup capability-probe sentinel FIFO drained, a race made observable by the added latency of an SSH/zmx PTY chain. DA1 replies (`CSI ? … c`) and split private-CSI responses are now consumed for the whole session lifetime, not only while a probe sentinel is outstanding ([#8542](https://github.com/can1357/oh-my-pi/issues/8542)).

## [17.3.3] - 2026-08-14

### Fixed

- Fixed Gemini reports rendering their final headings and tables as one raw code block when the model emitted a lone closing Markdown fence without its opener.

## [17.3.1] - 2026-08-13

### Fixed

- Fixed screen flashing in Herdr panes during transcript streaming.

## [17.3.0] - 2026-08-13

### Fixed

- Fixed an issue where repeated pane-width adjustments or terminal resizing could corrupt native scrollback and soft-wrap behavior.
- Fixed an issue where scaled OSC 66 Markdown headings (such as "Large Headings" on Kitty) would render as invisible placeholders or get partially cleared after a redraw or terminal resize.

## [17.2.13] - 2026-08-11

### Fixed

- Fixed inline images rendering permanently cropped on Kitty direct-placement terminals (WezTerm, Warp) when an image block straddled the viewport top during streaming: placements are now clipped to the visible slice at write time, and a placement id whose cells reached native scrollback is never re-used ([#8070](https://github.com/can1357/oh-my-pi/pull/8070) by [@voonfoo](https://github.com/voonfoo))

## [17.2.12] - 2026-08-08

### Fixed

- Fixed slow Loader paints exceeding their cost-aware CPU duty cycle on WSL/ConPTY when a 200 ms backpressure cap was shorter than the proportional delay ([#8012](https://github.com/can1357/oh-my-pi/issues/8012)).
- Fixed display-math (`$$…$$`) fractions rendering as fragmented text when the numerator and denominator are written on separate source lines: `latexToBlock` treated the top-level newline between `\frac{num}` and `{den}` as a row break, severing `\frac` from its denominator. Such argument-continuation newlines are now preserved so the fraction stays stacked ([#7996](https://github.com/can1357/oh-my-pi/issues/7996)).

## [17.2.11] - 2026-08-07

### Fixed

- Fixed an issue where Herdr panes lost native terminal scrollback during TUI transcript replacements or resize redraws.
- Fixed an issue inside tmux where explicit display resets retained stale light/dark palettes and leaked terminal capability bytes into the editor.

## [17.2.10] - 2026-08-06

### Fixed

- Fixed a startup crash (EIO error) in multiplexer or SSH sessions when a revoked pty leaves stdin.isTTY active.
- Fixed prompt autocomplete to support Windows drive-absolute paths (e.g., C:/ or C:\).
- Fixed desktop notifications in systemd, tmux, or SSH-attached Linux sessions when DBUS_SESSION_BUS_ADDRESS is unset.
- Fixed an issue where Shift+letter and shifted symbol inputs (such as capital letters, ?, and !) were silently dropped on Windows and WSL terminals using ConPTY (e.g., WezTerm).

## [17.2.9] - 2026-08-05

### Fixed

- Fixed table borders (and adjacent cells) inheriting an open inline-code color when a cell's content wraps mid-code-span, by terminating each wrapped cell line's SGR state before the border glyphs ([#7575](https://github.com/can1357/oh-my-pi/issues/7575)).
- Fixed inline images not rendering under WSL + Windows Terminal: the SIXEL capability probe gated on `process.platform === "win32"`, but WSL reports `linux`, so the probe never ran and images fell back to the text placeholder even on Sixel-capable Windows Terminal. The probe now runs on any ConPTY host (native win32 or WSL) ([#6009](https://github.com/can1357/oh-my-pi/issues/6009)).

## [17.2.5] - 2026-08-03

### Fixed

- Fixed Kitty and Ghostty keyboard shortcuts on non-Latin keyboard layouts by requesting base-layout key reporting from the terminal.

## [17.2.4] - 2026-08-01

### Fixed

- Fixed animated Loader paints saturating a CPU core on slow WSL/ConPTY terminals by applying cost-aware cadence backpressure while preserving 30fps on cheap frames ([#7290](https://github.com/can1357/oh-my-pi/issues/7290)).
- Fixed interactive terminals suppressing all output and input when the host project sets `NODE_ENV=test` or `BUN_ENV=test` ([#7261](https://github.com/can1357/oh-my-pi/issues/7261)).

## [17.2.2] - 2026-07-31

### Added

- Added request tokens to explicit OSC 11 appearance refreshes to allow consumers to correlate responses across queued and coalesced terminal probes.

### Fixed

- Fixed the event-loop watchdog incorrectly reporting system sleep or suspension as a synchronous ui.loop-blocked stall.
- Fixed terminal copies of fenced-code blocks retaining margins from components, lists, or blockquotes in assistant messages (#7055 by @GratefulDave).

## [17.2.0] - 2026-07-30

### Added

- Added response-level OSC 11 appearance subscriptions to help terminal consumers distinguish confirmed unchanged background classifications from missing replies.

### Fixed

- Fixed native Windows terminal panes freezing their host during forced closure by skipping the stdout-drain wait after ConPTY disconnects.
- Fixed high CPU usage in the Loader spinner during idle waits by optimizing text wrapping and caching during frame updates.
- Fixed hash-prefixed UUIDs in prose being misclassified as 8-digit CSS colors and receiving spurious swatches.
- Fixed unbounded memory growth and potential host freezes when a PTY consumer stalls by capping the pending stdout backlog and treating undrained consumers as a disconnect.

## [17.1.8] - 2026-07-28

### Fixed

- Fixed wrapped Markdown list continuations losing their hanging indentation in narrow terminal layouts.
- Fixed an issue where emergency exits from fullscreen overlays could leave the Kitty keyboard protocol active, corrupting Arrow Up input in the terminal after exiting.

## [17.1.7] - 2026-07-27

### Added

- Added bulk-input fast path and iterative processing for bracketed paste in the editor
- Added windowed incremental lexing for large markdown documents

### Changed

- Eliminated the dominant markdown streaming CPU cost (73% of a profiled interactive session): marked's GFM `url` tokenizer and `lheading` rule are now gated by O(1)/O(n) charCode pre-checks, the pathological `hr`/`lheading`/`table`/`html` block rules use sticky clones that fail at offset 0 instead of rescanning the source, and the inline math/autolink `start()` scans dropped their regex alternations
- Streaming markdown now freezes the stable prefix through provably closed lists instead of re-lexing everything after the last non-list block on every delta
- Raised the markdown render cache entry budget (32 KiB → 256 KiB) so large messages — exactly the expensive renders — are cacheable
- Deduplicated terminal cursor-visibility writes to skip redundant escape sequences

## [17.1.6] - 2026-07-27

### Fixed

- Fixed omp dying with an uncaught `setRawMode failed with errno: 2` instead of exiting 129 when the terminal disconnects. A recycled terminal pane revokes the pty, so the raw-mode restore in `stop()` hit an fd that is no longer a tty; the throw escaped `#markTerminalDisconnected()` and preempted its own SIGHUP. Terminal teardown on the disconnect path is now best-effort, matching `emergencyTerminalRestore()`, so the exit added in [#5837](https://github.com/can1357/oh-my-pi/pull/5837) always runs.
- Fixed the multi-line prompt editor bypassing the keybindings registry for word/line delete and yank: `ctrl+backspace` (a declared default of `tui.editor.deleteWordBackward`) never fired and `keybindings.yml` remaps of `deleteWordBackward`, `deleteWordForward`, `deleteToLineStart`, `deleteToLineEnd`, `yank`, and `yankPop` were ignored, because those actions were matched with hardcoded chords instead of `keybindings.matches(...)` like cursor motion and the single-line `Input` already do ([#6782](https://github.com/can1357/oh-my-pi/issues/6782)).
- Restored the Windows Terminal raw `0x08` → `ctrl+backspace` disambiguation (`WT_SESSION` set, `SSH_*` unset) by routing the exported `matchesRawBackspace` helper through the `matchesKey`/`parseKey` seam. Remote SSH/container sessions where terminal identity is unavailable can opt in with `PI_TUI_RAW_BACKSPACE_IS_CTRL=1` ([#6782](https://github.com/can1357/oh-my-pi/issues/6782)).
- Fixed plain Backspace deleting a whole word inside tmux/GNU screen/Zellij panes launched from Windows Terminal: multiplexers inherit `WT_SESSION` but emit raw `0x08` for plain Backspace, so the automatic raw-backspace → `ctrl+backspace` heuristic misfired. The heuristic now skips multiplexer sessions (`TMUX`/`STY`/`ZELLIJ` or `TERM` starting with `tmux`/`screen`); `PI_TUI_RAW_BACKSPACE_IS_CTRL=1` remains the explicit opt-in everywhere ([#6784](https://github.com/can1357/oh-my-pi/pull/6784)).

## [17.1.4] - 2026-07-26

### Fixed

- Prevented inline Kitty graphics from covering full-width overlays such as `/switch`.
- Fixed Ctrl+O (expand tools) truncating the session on ConPTY hosts (native Windows and WSL): the full-view replay routed through the ConPTY frame-truncation intended only for bulk transcript-replacement paints (issue #2115), dropping every row above the retained tail behind an "older lines hidden" marker. The bound now keys on paint intent — bulk replacements (initial resume, `/resume`, handoff, resize geometry rebuilds) stay bounded, while a user-driven `resetDisplay()` (Ctrl+O expand, thinking/setting toggles, display reset) replays the whole transcript ([#4863](https://github.com/can1357/oh-my-pi/issues/4863)).

## [17.1.2] - 2026-07-24

### Fixed

- Fixed the terminal flickering when leaving a fullscreen overlay (e.g. `/settings`, the models page) or resizing on terminals that re-report their size whenever the alternate screen buffer toggles: the alt-toggle size echo no longer arms a destructive full-screen (ED3) rebuild, and the in-place repaint path is now auto-detected for any such terminal instead of only Warp ([#6511](https://github.com/can1357/oh-my-pi/issues/6511)).

## [17.1.1] - 2026-07-24

### Fixed

- Fixed WarpTerminal wrapping streamed Compatibility Jamo at the platform-default width instead of its rendered one-cell width ([#6461](https://github.com/can1357/oh-my-pi/issues/6461)).

## [17.1.0] - 2026-07-24

### Added

- Added Text.setStyleFn() to apply foreground stylers at render time, allowing components to dynamically re-resolve colors after invalidation instead of baking in the palette active at construction.

### Fixed

- Fixed an issue where exiting or tearing down the TUI left the terminal in cursor-key/keypad application mode (DECCKM), which broke arrow keys in the parent shell. Both stop() and emergencyTerminalRestore() now correctly emit standard rmkx resets.

## [17.0.9] - 2026-07-23

### Added

- Added `SelectList.setMaxVisible()` so hosts can refit the visible row budget to available height after construction.

## [17.0.8] - 2026-07-22

### Fixed

- Fixed an issue where OSC 8 hyperlinks with inline markup corrupted Markdown table column widths.
- Prevented duplicate autocomplete suggestions for slash commands and their matching aliases.
- Fixed terminal background color detection during screen refreshes (Ctrl+L) inside tmux when passthrough is enabled.

## [17.0.6] - 2026-07-20

### Fixed

- Fixed idle Loader animations on WSL repeatedly entering render scheduling after an expired ConPTY post-paint settle window instead of resuming direct component writes ([#6024](https://github.com/can1357/oh-my-pi/issues/6024)).

## [17.0.5] - 2026-07-18

### Changed

- Improved rendering performance across text, box, editor, and frame layouts by caching validated line widths and avoiding redundant Unicode width measurements.

### Fixed

- Fixed a performance issue where typing in the editor triggered a full UI re-render, significantly improving keystroke responsiveness.
- Restored text wrapping for long descriptions in the slash-command autocomplete picker to ensure readability at standard terminal widths.
- Prevented temporary dashboard frame updates from cluttering the terminal's native scrollback history.
- Added support for cleaning up tracked Kitty graphics, allowing inline images to be properly deleted before falling back to text.
- Fixed an issue where resizing or growing a multiplexer pane would incorrectly overwrite newly exposed rows with blank padding.

## [17.0.3] - 2026-07-17

### Fixed

- Fixed multiline pastes arriving without bracketed-paste markers (e.g. Cmd+V in the Codex desktop embedded terminal on macOS) being split into one submit per line: `StdinBuffer` now collects adjacent ESC-free, CR/LF-bearing stdin reads in a fixed 10 ms classification window and coalesces three or more lines into one paste event, while ambiguous one-break input (including Enter batched with a following keystroke) is replayed unchanged ([#5841](https://github.com/can1357/oh-my-pi/issues/5841)).
- Fixed wrapped OSC 8 links in Markdown tables making cell padding, separators, and adjacent cells clickable ([#5885](https://github.com/can1357/oh-my-pi/issues/5885)).
- Fixed interactive sessions surviving terminal closure and entering a runaway render loop by stopping the TUI and raising SIGHUP when terminal input closes or output fails ([#5835](https://github.com/can1357/oh-my-pi/issues/5835)).
- Fixed native cmux SSH pane resizes inserting blank rows into terminal scrollback by routing remote-transport sessions through the in-place repaint path ([#5857](https://github.com/can1357/oh-my-pi/issues/5857)).
- Fixed the terminal flickering when leaving a fullscreen overlay (e.g. `/settings`) on terminals that re-report their size when the alternate screen buffer toggles: the alt-toggle SIGWINCH echo is height-only, so the resize fast path no longer borrows the alternate screen for it ([#5854](https://github.com/can1357/oh-my-pi/issues/5854)).

## [17.0.2] - 2026-07-17

### Added

- Added a fullscreen overlay mouse-tracking opt-out to allow selection-first dialogs to preserve native terminal text selection.
- Added `Terminal.refreshAppearance()` to allow consumers to manually trigger a refresh of the detected dark/light terminal appearance without periodic polling.

### Fixed

- Fixed an issue where pressing Enter to accept a mid-prompt `/skill:<name>` autocomplete would submit and clear the draft; it now correctly inserts the skill token and leaves the prompt open.
- Fixed Markdown rendering incorrectly turning local file paths containing `www.` or protocol sequences into HTTP links by requiring a valid GFM left boundary for autolinks.
- Fixed terminal resize behavior by restoring alternate-screen rendering during drag frames, preventing wrapped fragments from polluting native scrollback while preserving the overlay-exit flicker fix.
- Added optional right-border scrollbar to the `Editor` component (`setScrollbarVisible`): shows a thumb glyph on the right border when content overflows `maxHeight`, enabling scrollable multi-line editors (e.g. advisor instructions) without losing the submit hint off-screen.

## [17.0.1] - 2026-07-16

### Added

- Added native cmux notification delivery targeted to the current terminal surface.

### Fixed

- Fixed a tmux regression where every non-Kitty pane was forced into legacy keyboard input, collapsing Ctrl+H into Backspace and Shift+Enter into Enter even with `extended-keys on`; the xterm modifyOtherKeys fallback is requested again so tmux honors or ignores it per its own `extended-keys` setting ([#5620](https://github.com/can1357/oh-my-pi/issues/5620)).
- Fixed `@` file-reference and path completion falling through incorrectly inside slash command arguments when command-specific argument completion has no matches ([#5580](https://github.com/can1357/oh-my-pi/issues/5580)).
- Fixed streamed Markdown tables reflowing rows already written to native scrollback when later cells widen a column.
- Fixed fullscreen session-replacement overlays and resize drags exposing stale normal-buffer frames on terminals without effective DEC 2026: asynchronous replacements now keep their overlay visible until the rebuilt transcript is ready, overlay exit is fused into the destructive paint, and resize viewport frames rewrite the normal buffer without alternate-screen switches. Inconclusive DECRQM probes also no longer disable statically detected synchronized output ([#5319](https://github.com/can1357/oh-my-pi/issues/5319)).
- Fixed autocomplete popups moving Windows Terminal IME candidate windows away from the prompt by keeping the terminal cursor anchored at the text insertion point ([#4760](https://github.com/can1357/oh-my-pi/issues/4760)).

## [17.0.0] - 2026-07-15

### Added

- Improved LaTeX rendering for \underbrace, \overbrace, \overset, \underset, and \stackrel to use drawn horizontal braces with centered labels and stacked annotations instead of flat inline glyphs.
- Improved LaTeX rendering of multi-letter subscripts and superscripts by displaying them as raised or lowered blocks instead of ragged per-character Unicode glyphs.
- Added an opt-in Editor.setImeSafeCursorLayout() method to protect macOS IME preedit while retaining the compact bordered layout by default.

### Fixed

- Fixed SIXEL image rendering where images with cell heights not divisible by 6 would have their bottom portion overwritten by subsequent content.
- Fixed an issue where the Kitty OSC 99 desktop-notification capability probe would leak raw text into the terminal pane when running inside a multiplexer like tmux or screen.

## [16.5.2] - 2026-07-14

### Fixed

- Fixed animated Loader ANSI updates causing unnecessary text layout invalidation and re-wrapping on shimmer-only frames (#5230).
- Fixed Ctrl+W (delete word backward) stopping at underscores in snake_case identifiers, treating them as single words (#4776).
- Fixed automatic file completion incorrectly treating punctuation, trailing spaces, and slash-command text as paths, and improved autocomplete dismissal behavior (#5376).
- Fixed Kitty graphics rendering under tmux, ensuring images correctly follow pane scrolling and reflow (#5381).
- Fixed tmux sessions becoming unresponsive after terminal capability replies by falling back to legacy keyboard input mode when the Kitty protocol is unavailable (#5378).
- Fixed PageUp and PageDown keys on an empty prompt editor incorrectly navigating prompt history instead of scrolling the editor viewport (#4754).

## [16.5.1] - 2026-07-14

### Fixed

- Optimized the Markdown rendering cache to prevent large documents from indefinitely occupying cache slots, improving memory usage and performance ([#4820](https://github.com/can1357/oh-my-pi/issues/4820)).
- Fixed viewport corruption on macOS caused by unmanaged stderr writes (such as libmalloc or framework diagnostics) while the terminal is active.
- Fixed an issue where streamed diff code fences retained unhighlighted rows in native scrollback when long transient blocks left the viewport before finalization ([#5126](https://github.com/can1357/oh-my-pi/issues/5126)).
- Fixed native Windows Terminal sessions failing to detect mid-run light/dark theme changes when Mode 2031 appearance notifications are unavailable ([#5091](https://github.com/can1357/oh-my-pi/issues/5091)).
- Hid empty HTML comment separators in Markdown-rendered TUI output instead of displaying them literally ([#4911](https://github.com/can1357/oh-my-pi/issues/4911)).

## [16.5.0] - 2026-07-13

### Changed

 - Improved native scrollback history management by introducing an optional erase-and-replay mechanism to rebuild scrollback when mutated rows (such as finalized tool blocks or collapsed transcripts) diverge. This is now gated behind the `tui.scrollbackRebuild` setting and defaults to off.

### Fixed

- Fixed a rendering issue where resizing the terminal during forced renders (such as tool finalization or image reconciliation) caused the entire transcript to visibly replay and flicker. Forced renders are now consolidated into a single paint once the resize settles.

## [16.4.7] - 2026-07-12

### Fixed

- Fixed keyboard navigation paying an extra frame of input latency after idle; the queue-drain grace now applies only to Ctrl+C and Escape double-press gestures.

## [16.4.6] - 2026-07-12

### Added

- Added support for width-changing editor text decorators on standalone presentation lines, with decorated output safely truncated to the available content width.

## [16.4.5] - 2026-07-11

### Added

- Added `FuzzyText`, a prepared fuzzy-match handle that builds the search index once and matches many queries against it, optimizing performance for large corpora like session or transcript searches.

### Fixed

- Fixed an issue where the mid-prompt `/` autocomplete popup lingered indefinitely on non-path and non-skill tokens. Autocomplete matching is now properly gated to explicit skill namespaces, queries, and prefixes, preventing stale popups from incorrectly rewriting input on Tab or Enter.
- Fixed idle Loader animation driving the full TUI render pipeline on every spinner tick by directly rewriting the Loader's visible rows when geometry is unchanged, reducing idle render work while preserving fallback repaint paths ([#5192](https://github.com/can1357/oh-my-pi/issues/5192)).

## [16.4.1] - 2026-07-10

### Added

- Added full 2-D layout support for display LaTeX math (fractions, matrices, radicals, limits), modeled on the layout approach of [txm](https://github.com/thatmagicalcat/txm) (Terminal TeX Math) by [@thatmagicalcat](https://github.com/thatmagicalcat)
- Added support for `\left`, `\right`, and `\middle` stretchy delimiters in display blocks
- Added rendering for `cases`, `matrix`, `pmatrix`, `bmatrix`, and `vmatrix` environments
- Added support for block-level scripts and big-operator limits (e.g., `\sum`, `\int\limits`)
- Added cross-box styling for `\color`, `\textcolor`, and math font commands (e.g., `\mathbf`)

### Changed

- Improved row alignment and spacing for `align`, `gather`, and `array` environments
- Updated matrix environments to render as baseline-aligned grids with stretched brackets

## [16.4.0] - 2026-07-10

### Fixed

- Fixed terminal flickering during session resume, replacement, or resizing on terminals that do not support synchronized output.

## [16.3.14] - 2026-07-09

### Fixed

- Fixed race condition where scrollback rows could be incorrectly retracted between render frames

## [16.3.13] - 2026-07-09

### Fixed

- Fixed late terminal appearance subscribers missing the already-detected OSC 11 light/dark result, so theme auto-detection picks up the terminal appearance even when the response arrives before the UI subscribes ([#4731](https://github.com/can1357/oh-my-pi/issues/4731)).
- Fixed slash command Tab completion reopening the file autocomplete drawer after accepting no-argument commands ([#4808](https://github.com/can1357/oh-my-pi/issues/4808)).

## [16.3.12] - 2026-07-08

### Fixed

- Fixed selector rendering when a legacy theme omits symbol settings by falling back to an ASCII cursor instead of crashing ([#4745](https://github.com/can1357/oh-my-pi/issues/4745)).
- Kept slash command autocomplete rows compact by truncating descriptions instead of wrapping them into multi-line blocks.
- Fixed mid-prompt skill autocomplete so Tab and Enter accept the highlighted `/skill:<name>` suggestion and Backspace dismisses the popup immediately after removing the triggering slash ([#4619](https://github.com/can1357/oh-my-pi/issues/4619)).
- Fixed submitted slash-command arguments treating `@` file-reference tokens as prompt-composer autocomplete triggers when the command does not define argument completions. ([#4600](https://github.com/can1357/oh-my-pi/issues/4600))
- Fixed box-drawing tree lines (`├── item` — directory layouts, decision trees) in prose shearing apart when they wrap: continuation rows now hang under the node text with ancestor rails carried through (`├` → `│`, `└` → blank) instead of restarting at column 0. Applies to prose paragraphs (including inside blockquotes) only when a line with a branch-connector prefix (`├──`, `└─`, …) actually overflows; fitting lines, non-tree prose, and code blocks render byte-for-byte as before.

## [16.3.10] - 2026-07-06

### Fixed

- Registered emergency terminal restore with the postmortem fatal path whenever a real terminal starts, so fatal exits restore raw mode/alternate screen on the normal CLI graph (previously the registration was a side effect of a barrel module the CLI never imported).

## [16.3.9] - 2026-07-06

### Fixed

- Fixed autocompletion for absolute paths (such as `/tmp/...` or `/Users/...`) at the start of a prompt, ensuring they fall back to file-path completion instead of being incorrectly treated as slash commands.
- Updated absolute path autocompletion behavior so that accepting a suggestion inserts the path without submitting the prompt.

## [16.3.7] - 2026-07-05

### Fixed

- Fixed an issue where `@` file-reference tokens in slash-command arguments incorrectly triggered prompt-composer autocompletion when the command did not define argument completions.
- Fixed a memory leak caused by unbounded map growth in the image budget cache.

## [16.3.6] - 2026-07-04

### Added

- Added `Markdown.getLastRenderSettledRows()`: the rendered frozen-token-prefix row count of the most recent streaming render, exposed (hard-monotone per text lineage) for native-scrollback commit gating. Frozen-prefix code blocks now syntax-highlight during streaming renders so settled rows stay byte-stable across finalize.

### Changed

- Rewrote the native-scrollback commit law around a visual-record model: whatever scrolls above the viewport enters history exactly once, in order — nothing painted ever vanishes. `NativeScrollbackLiveRegion` is now a single method (`getNativeScrollbackLiveRegionStart`) reporting an exactness boundary: rows below it commit as exact audited bytes; rows above it commit as frozen visual snapshots that are audit-exempt while their source stays live and strict-verified exactly once when the boundary passes them (a divergence recommits the final content below the frozen fragment — duplication, never loss). `getNativeScrollbackCommitSafeEnd`/`getNativeScrollbackSnapshotSafeEnd` and the heuristic promotion machinery they fed are removed.
- Simplified committed-prefix auditing to one hard-verified mark deriving three zones (verified/newly-final/frozen); a frame that shrinks below the committed row count re-bases at the first divergence against the recorded prefix so a collapsing live suffix never re-shows or re-commits already-recorded rows.

### Fixed

- Fixed live tool/eval preview boxes spraying duplicated stale copies into native scrollback mid-run: a still-live block's scrolled rows are now frozen visual snapshots that never re-anchor while it runs; at most one repair happens at finalize.
- Fixed streamed content vanishing above the viewport mid-turn: scrolled-off rows always reach native scrollback (as exact bytes for declared-final content, as visual snapshots otherwise) instead of being deferred invisibly.

## [16.3.5] - 2026-07-04

### Fixed

- Fixed the modifyOtherKeys keyboard fallback enabling on unknown SSH terminals, avoiding broken Shift input in iOS SSH clients such as Redock ([#4325](https://github.com/can1357/oh-my-pi/issues/4325)).

## [16.3.3] - 2026-07-02

### Fixed

- Fixed keyboard fallback behavior (modifyOtherKeys) on unknown SSH terminals, resolving broken Shift input in iOS SSH clients like Redock.
- Fixed a native scrollback rendering bug where finalized transcript rows below an active block would duplicate when the active block expanded.
- Fixed autocomplete popups remaining active with stale suggestions after destructive text editing (such as Ctrl+W, Ctrl+U, Ctrl+K, Alt+Backspace, Alt+D, paste, or yank), preventing input corruption when pressing Tab or Enter.
- Skipped Markdown re-lex + re-wrap when `setText` receives the identical text, mirroring the equality guard on `Text.setText` — cuts one of the top streaming CPU hotspots when providers re-emit unchanged content ([#4353](https://github.com/can1357/oh-my-pi/issues/4353)).

## [16.3.0] - 2026-07-02

### Fixed

- Fixed a potential event loop hang when processing oversized, unterminated terminal escape sequences (OSC/DCS/APC).
- Fixed an issue where large Windows terminal session restores could get truncated mid-frame during ConPTY full-paint resume.

## [16.2.13] - 2026-07-01

### Fixed

- Fixed fuzzy-search filtering for CJK and other non-ASCII queries by preserving Unicode letters and numbers during query normalization ([#4114](https://github.com/can1357/oh-my-pi/issues/4114)).

## [16.2.12] - 2026-07-01

### Fixed

- Optimized streaming markdown rendering to reuse already-rendered prefix lines and only render new content deltas, improving performance and reducing redraw flicker.

## [16.2.10] - 2026-06-30

### Fixed

- Fixed mid-prompt `/skill:<name>` autocomplete acceptance wiping the user's draft. The autocomplete now inserts the `/skill:<name> ` token at the cursor (replacing only the partial `/sk` slash token) and preserves prose typed before and after it, so a user can compose a prompt and reach for a skill without losing their train of thought ([#3913](https://github.com/can1357/oh-my-pi/issues/3913)).

## [16.2.9] - 2026-06-30

### Added

- Added `Editor.submit()` to allow programmatic composer submission, enabling integration with speech input and other automated flows.

## [16.2.7] - 2026-06-30

### Fixed

- Fixed an issue where a fast double-Escape keypress was swallowed and ignored, preventing double-escape gestures and subsequent Escape key handlers from firing.

## [16.2.3] - 2026-06-28

### Added

- Added a desktop notification fallback for Linux terminals using D-Bus (via notify-send or gdbus), enabling completion and prompt notifications in VTE-family terminals (such as GNOME Terminal, Ptyxis, Tilix), Alacritty, and xterm. This is automatically skipped for terminals with native notification support (like VS Code and Warp) and can be disabled using the PI_NO_DESKTOP_NOTIFY=1 environment variable.

### Fixed

- Fixed slash skill autocomplete not opening when there is existing prompt text, ensuring mid-prompt slash lookups correctly display and insert skill commands.
- Fixed modified Enter and keyboard shortcuts in fullscreen overlays for terminals using the xterm modifyOtherKeys fallback (such as iTerm2 when Kitty keyboard negotiation is unavailable).

## [16.2.0] - 2026-06-27

### Added

- Added support for rendering HTML <code>, <hr>, and <blockquote> tags with proper theme styling, entity decoding, and layout consistency across Markdown transcripts, table cells, list items, and option labels.
- Added first-class support for Warp terminal (TERM_PROGRAM=WarpTerminal), enabling true color, platform-specific Kitty graphics protocol negotiation for inline images, and safe defaults for OSC 8 hyperlinks and synchronized output.
- Added SelectList.routeMouse() and shared SGR mouse input routing helpers to support fullscreen overlay hit-testing.

### Fixed

- Fixed issues where stray, unmatched, or raw HTML tags would leak into the rendered output.
- Fixed render scheduling to yield behind queued terminal input, preventing delayed Escape key delivery during heavy streaming paints.

## [16.1.20] - 2026-06-25

### Fixed

- Recognized Warp (`TERM_PROGRAM=WarpTerminal`) as a first-class terminal, enabling Kitty inline images on macOS/Linux while keeping Warp's unsafe OSC 8 hyperlinks and Windows Kitty graphics disabled ([#3471](https://github.com/can1357/oh-my-pi/issues/3471)).
- Kept queued interrupt keys ahead of ordinary repaints so a slow long-transcript frame cannot consume the Ctrl+C/Esc double-press window before the second key is handled.

## [16.1.19] - 2026-06-25

### Fixed

- Fixed bordered `Editor` rendering 1–2 cells past the terminal width when the end-of-line cursor glyph landed past a wide trailing grapheme (CJK comma `，`, emoji, etc.), wrapping the bottom-right corner (`╯`) to its own row. The right chrome (padding + `─` + corner) now shrinks by the exact cursor overflow cell count instead of a 1-cell boolean, so the box stays inside `width` for any `paddingX` ([#3431](https://github.com/can1357/oh-my-pi/issues/3431)).

## [16.1.17] - 2026-06-24

### Added

- Added runtime resolution of the Hangul Compatibility Jamo (U+3131..U+318E) display width for terminals known to disagree with the platform default (e.g. Ghostty, which renders these at 2 cells). Fixes doubled/ghosted jamo during Korean IME composition; the resolved width is pushed into the native width engine before the first paint. Other terminals keep the platform default (macOS narrow, otherwise UAX#11), so the override is a no-op outside Ghostty. A runtime DSR/CPR probe for unknown terminals is tracked separately.
- Added `setHangulCompatibilityJamoWidth` / `getHangulCompatibilityJamoWidth` to set the jamo width profile (`"platform" | "unicode" | 1 | 2`); the profile is mirrored into the native `setHangulCompatJamoWidthOverride`.

### Fixed

- Removed the 30-second OSC 11 background-color poll that ran on terminals without DEC Mode 2031 support (macOS Terminal.app, Warp, VS Code's built-in terminal, older Alacritty/WezTerm). Each poll's OSC 11 + DA1 write wiped the user's active text selection on several of those terminals, causing intermittent "can't copy" failures whenever a poll fired mid-drag — most visibly during the Ask tool dialog when the user wants to quote text back from the conversation ([#3297](https://github.com/can1357/oh-my-pi/issues/3297)). Theme detection now relies on the initial startup probe plus Mode 2031 push notifications; affected terminals pick up OS-theme changes on next launch.
- Fixed `@`-path autocomplete failing on Windows for paths outside the cwd. Windows absolute paths (e.g. `C:\\Users\\...`) were not detected as absolute — only `/` was checked — so they were incorrectly joined with the base directory, producing invalid search paths and empty suggestions. Path-join calls also introduced backslashes into suggestion values, breaking round-trip insertion. Absolute path detection now uses `path.isAbsolute()` (handles drive letters) and suggestion paths are normalized to forward slashes (valid on all platforms).
- Fixed settings rows crashing native text truncation when a malformed config value reaches the renderer as a non-string ([#3338](https://github.com/can1357/oh-my-pi/issues/3338)).
- Fixed desktop notifications being silently lost under tmux on the common stack of tmux + kitty/ghostty/wezterm/iTerm2. `TERMINAL_ID` resolves to the inner terminal (whose markers leak into the tmux session env), which maps to `NotifyProtocol.Osc9` / `NotifyProtocol.Osc99`, and `sendNotification()` wrote that raw OSC straight to stdout — tmux dropped it on the floor and `monitor-bell` / `monitor-activity` never fired, so a backgrounded omp pane had no way to flag completion or `ask` blockage. Under `TMUX`, OSC-protocol notifications are now wrapped in tmux's `\x1bPtmux;…\x1b\\` DCS passthrough envelope (so users with `set -g allow-passthrough on` still get the real toast on the outer terminal) and followed by a `\x07` BEL (so `set -g monitor-bell on` reliably flags the window otherwise). The OSC 99 capability probe in `terminal.ts` is wrapped the same way so rich notifications keep working across tmux. `NotifyProtocol.Bell` paths are unchanged. ([#3395](https://github.com/can1357/oh-my-pi/issues/3395))

## [16.1.10] - 2026-06-21

### Fixed

- Fixed streaming output being lost from native scrollback below a commit-unstable "barrier" block (a provisional/collapsed tool preview, a displaceable `job` poll, or a reflowing-markdown reply) once the content under it overflowed the viewport. The engine committed native scrollback only up to the barrier's seam, so rows that scrolled above the window under the barrier were committed nowhere and repainted nowhere — they vanished, and a later shift/finalize/removal of the barrier silently dropped the rows beneath it. The append-only commit floor is now `windowTop` in every non-frozen paint path (ordinary update, shrink re-slice, full paint), so whatever scrolls above the window always reaches history; the seam boundaries now only classify which committed rows stay byte-stable-audited vs. durable-exempt. The committed-prefix audit is range-aware: it audits the forced-overflow suffix in full (re-anchoring — duplication, never loss — when a barrier finalizes), exempts the durable middle (a streaming table re-aligning its columns) from re-anchor spray, and runs a full hard scan of rows a frame newly marks permanent so a single-row finalize edit far above the commit boundary still re-anchors instead of being dropped.

## [16.1.8] - 2026-06-20

### Added

- Added an optional synchronous dynamic description hook for slash-command autocomplete items.

### Fixed

- Fixed Markdown component to strip inline `<span>` and `<text>` tags while preserving their contents and unescaping nested HTML entities (`&lt;`, `&gt;`, `&quot;`, `&apos;`, `&amp;`), preventing raw LLM block/inline formatting residues from leaking into rendered TUI output.

## [16.1.7] - 2026-06-20

### Fixed

- Fixed slash command autocomplete, inline hints, and Enter completion when the slash command is preceded by leading whitespace ([#3095](https://github.com/can1357/oh-my-pi/issues/3095)).
- Fixed empty `/` autocomplete burying user skill commands below every built-in command, so installed skills appear in the initial slash popup ([#2875](https://github.com/can1357/oh-my-pi/issues/2875)).

## [16.1.0] - 2026-06-19

### Added

- `Box` now accepts an optional `border` (box-drawing glyphs + colorizer) and exposes `setBorder()`, drawing a colored outline around its padded/background content. The border is automatically dropped at widths too narrow to frame so a bordered box never overflows its given width.

## [16.0.11] - 2026-06-19

### Breaking Changes

- Removed `getIndentation` and `getIndentationNoescape` exported utilities
- Tab-related operations no longer respect per-file or globally configured indentation settings

### Changed

- Standardized tab expansion to use a fixed display width instead of configurable settings
- Removed support for custom tab width configuration in text rendering and input handling

### Fixed

- Corrected logic in string truncation to prevent improper truncation of short strings
- Fixed a one-frame transcript flash during a non-multiplexer resize drag: while the drag borrowed the alternate screen and painted only the viewport, any ordinary (non-forced) render from a still-animating block — a tool spinner tick, a streamed token, a cursor blink — fell through to the deferred geometry-rebuild full paint, which left the alternate screen to repaint the whole transcript on the normal screen for a single frame before the next SIGWINCH re-entered the viewport fast path, so a live tool block flashed in and vanished. Ordinary renders mid-drag now stay on the viewport fast path; only forced renders (tool finalization, reset, image reconciliation) still preempt it.

## [16.0.10] - 2026-06-18

### Fixed

- Fixed Markdown renderer rendering raw HTML tags (like `<br>`, `<li>`, `<ul>`, `<ol>`, and `<p>`) literally in the terminal by parsing and converting them to appropriate terminal formatting, preserving repeated HTML line breaks, nested HTML list indentation, ordered list numbering, paragraph-wrapped list item markers, paragraph separation, and table sizing after HTML line breaks.
- Fixed animated working-message loader frames repainting at 30fps on terminals without synchronized-output support, which could cause visible flicker during normal prompt rendering ([#2771](https://github.com/can1357/oh-my-pi/issues/2771)).

## [16.0.9] - 2026-06-18

### Fixed

- Fixed bottom-anchored fullscreen overlays keeping their body rows but clipping off footer actions when terminal-height clamping is applied, restoring plan-mode approval options on short or stale-size terminals ([#2957](https://github.com/can1357/oh-my-pi/issues/2957)).

## [16.0.8] - 2026-06-18

### Fixed

- Fixed bracketed paste under kitty+tmux leaking `[27;5;106~` escape tails throughout the pasted text (newlines became visible garbage instead of line breaks). tmux's default `extended-keys-format=xterm` re-encodes paste control bytes as `modifyOtherKeys` sequences (`ESC[27;5;<code>~`), which the paste sanitizer did not decode — only the sibling `csi-u` form (`ESC[<code>;5u`) was handled. Both forms are now decoded back to their literal control byte (Ctrl+J → "\n") before control-character stripping, and the decoder is shared by the multi-line editor and the single-line modal input.

## [16.0.5] - 2026-06-17

### Added

- Added tight layout support (`setTuiTight`/`getPaddingX`) to dynamically remove 1-character horizontal padding from Text, Markdown, Box, and TruncatedText components.

### Changed

- Coalesced byte-adjacent SGR sequences in emitted lines into a single `CSI … m`. The component tree styles each span as `<set>text<reset>`, so adjacent spans emit runs of back-to-back SGR sequences (e.g. a `CSI 39 m` fg-reset immediately followed by the next span's `CSI 38;2;r;g;b m`); merging the run is behavior-preserving because SGR parameters apply left-to-right regardless of framing. On a real transcript this drops ~30-40% of all SGR sequences, cutting the per-frame byte volume and SGR-dispatch count a slow terminal engine (e.g. xterm.js/WebGL under a large viewport) must process. Each emitted sequence is capped at 16 parameter tokens so a long adjacent run is split across several valid CSIs instead of overflowing a terminal's parameter buffer (xterm.js caps at 32 and silently truncates, corrupting colors). A run is never extended past a parameter list that ends in an incomplete semicolon-form extended color (`38/48/58;2` missing a channel or `;5` missing the index), so a following code can't be absorbed as the missing component. Disable with `PI_NO_SGR_COALESCE=1`.

### Fixed

- Fixed image cache invalidation when terminal image protocol, Kitty placeholder mode, or cell dimensions change, preventing stale rendered output
- Fixed direct inline-image placements leaving the cursor inside the reserved image block, which let following chat rows overwrite the middle of rendered screenshots ([#2863](https://github.com/can1357/oh-my-pi/issues/2863)).
- Fixed inline-image replay after startup or resume fallback paints by invalidating cached image rows when the terminal image protocol, Kitty placeholder mode, or cell dimensions change.

## [16.0.3] - 2026-06-16

### Added

- Added `\tfrac` support to stacked display-math rendering so it now displays as a vertical fraction in `latexToBlock` output
- Added markdown parsing for own-line display-math blocks (`$$...$$` and `\[...\]`) and delimiter-free `\begin{...}...\end{...}` math environments so block equations render via LaTeX-to-Unicode
- Added stacked rendering of display-math fractions (`\frac`, `\dfrac`, `\cfrac`): the numerator is drawn over a horizontal bar over the denominator, with surrounding terms and `align`/`equation`-style environment rows aligned to the bar. Triggered for own-line `$$`/`\[` blocks, bare `\begin{...}` environments, and a paragraph whose sole content is a single display-math span; inline `$...$` fractions stay single-line (`½`, `(a+b)/c`)
- Added bare math auto-rendering in `renderMathInText` for math-shaped lines and math environment blocks that omit `$`/`\(` delimiters
- Added LaTeX-to-Unicode rendering for markdown math spans, converting `$$...$$`, `$...$`, `\(...\)`, and `\[...\]` into readable Unicode in Markdown output
- Exported LaTeX conversion helpers from the package entrypoint so consumers can call `latexToUnicode`, `latexToBlock`, `renderMathInText`, `inlineMathSpanEnd`, and `isBareMathEnvironment` directly
- Expanded LaTeX-to-Unicode conversion coverage for additional math fonts, delimiters, extensible arrows, layout environments, cancel/brace annotations, references, and AMS symbols
- Added ANSI color rendering for LaTeX `\textcolor`, scoped `\color`, `\colorbox`, and `\fcolorbox`, including xcolor/CSS color parsing and truecolor/256-color terminal output
- Added an optional `maxWidth` parameter to `MarkdownTheme.resolveMermaidAscii` to allow diagram resolvers to fit ASCII output to the available content width

### Changed

- Changed markdown math rendering to preserve multiline layout for display equations, keeping `\\` row breaks as separate output lines (including inside list items)

### Fixed

- Fixed `alignat`/`alignedat`/`gatheredat` rendering in `latexToBlock` so the required `{n}` preamble is not rendered as visible math content
- Fixed math parsing to leave non-math LaTeX snippets (for example `\begin{itemize}`) and fenced code blocks as literal text instead of rendering them as math
- Fixed `renderInlineMarkdown` to handle top-level display-math tokens so raw `$$...$$` delimiters are no longer leaked
- Fixed inline math span detection so escaped dollars and currency-like patterns (such as `$5` and `$10`) are not converted as math
- Fixed Mermaid diagram rendering in Markdown code blocks to clip each ASCII line to content width before wrapping, preventing preformatted diagram rows from fragmenting
- Fixed fullscreen overlays losing keyboard focus to hidden prompt surfaces, which could make settings unresponsive while a background approval request was pending ([#2789](https://github.com/can1357/oh-my-pi/issues/2789)).
- Fixed `bun test` runs inside a real terminal leaking TUI output: `ProcessTerminal` now honors a headless test-runtime default, so frame paints, `start()` capability probes (OSC 11 / DA1 / kitty), the progress keepalive, notifications, and teardown escapes no longer reach the developer's terminal, and stdin raw mode is never engaged. Previously `#safeWrite` only skipped on `!process.stdout.isTTY`, so a developer running the suite in an interactive terminal saw stray status/editor boxes and probe queries. Terminal-contract suites opt back into real I/O via `setTerminalHeadless(false)`

## [16.0.2] - 2026-06-16

### Fixed

- Fixed VS Code integrated terminal keypad digit CSI-u input being handled as navigation instead of text.
- Fixed xterm-compatible terminals scrolling the native viewport to the bottom on prompt-editor keypresses by disabling `?1010`/`?1011` while the TUI owns the TTY and restoring the prior set modes on exit ([#2732](https://github.com/can1357/oh-my-pi/issues/2732)).
- Fixed CMUX sessions being treated as direct terminals during resize/reset because they do not set `TMUX`/`STY`/`ZELLIJ` and may run with `TERM=dumb`; the renderer now treats CMUX workspace/surface env markers as multiplexer signals and preserves pane scrollback instead of emitting ED3 (`CSI 3 J`).
- Fixed a self-sustaining resize-redraw storm in Warp: the non-multiplexer resize fast path borrows the alternate screen, and Warp re-reports a one-row-different size whenever the alt buffer is toggled, so each drag frame fed back a fresh resize event and the TUI flooded ED3 full repaints with stable geometry. Resize now repaints in place (no alt-screen borrow, no ED3 rewrap) on terminals that re-report size on alt-screen toggles, matching the multiplexer path. Overridable with `PI_TUI_RESIZE_IN_PLACE=1|0`.

## [16.0.1] - 2026-06-15

### Added

- Added Zellij and WezTerm pane environment fallbacks for terminal-specific session continuation when no TTY path is available.

### Fixed

- Fixed slash command autocomplete acceptance replacing only a stale rendered prefix, which could leave fast-typed characters before `/skills:` completions and corrupt the submitted command ([#1745](https://github.com/can1357/oh-my-pi/issues/1745)).

## [15.13.1] - 2026-06-15

### Added

- Added volatile speech-to-text preview support to `Editor` with `setVolatileText(text)`, `clearVolatileText()`, and `commitVolatileText(text)` so hosts can replace, discard, or commit live dictated text at the cursor without appending
- Added an always-on `LoopWatchdog` armed in `TUI.start()`/`TUI.stop()` that logs `ui.loop-blocked` (rising-edge deduped, with `blockedMs` and the phase active during the elapsed interval) when a self-scheduled probe tick runs late, plus a `ui.select-filter` breadcrumb around the `SelectList` fuzzy filter. The phase is read via `takeRecentLoopPhase`, so a synchronous block whose breadcrumb was pushed and popped before the delayed tick runs is still attributed to its phase instead of "unknown". `stop()` cancels the armed timer (via `clearTimeout` on the default handle) so repeated start/stop cycles leave no pending probe, with the generation guard as a fallback ([#2485](https://github.com/can1357/oh-my-pi/issues/2485))
- Added `ctrl+j` as a second default binding for the `tui.input.newLine` action alongside `shift+enter`, so terminals that cannot emit `shift+enter` still have a newline key. On terminals with Kitty-protocol / `modifyOtherKeys` disambiguation `ctrl+j` inserts a newline while `Enter` still submits; on legacy terminals where `ctrl+j` and `Enter` are both byte-identical `LF` it submits (documented limitation). User keybinding overrides still take precedence ([#2473](https://github.com/can1357/oh-my-pi/issues/2473))
- Added an `Editor.onLargePaste(text, lineCount)` hook, fired for a "marker-sized" paste (the point where the editor would otherwise collapse it into a `[Paste #N]` token). Returning `true` lets the host intercept the paste — e.g. to offer wrap-in-code-block / wrap-in-XML / attach-as-file choices — and suppresses the default marker (no undo state is recorded). Added `Editor.insertPaste(content)` so the host can re-insert a (possibly transformed) collapsed paste marker without re-triggering the hook.
- Added `Editor.deleteBeforeCursor(count)`, which removes up to `count` characters immediately before the cursor on the current line (capped at the cursor column, single line, records one undo state). Hosts use it to "track back" optimistically-inserted characters — e.g. the coding-agent hold-`Space` push-to-talk gesture deleting the space-bar auto-repeat burst.
- Added an optional `getNativeScrollbackSnapshotSafeEnd()` to the `NativeScrollbackLiveRegion` contract: a *durable* commit boundary (D ≥ the byte-stable `commitSafeEnd`) for live rows whose current snapshot is permanent content but may still drift bytes later (a streaming markdown table re-aligning its columns). The engine commits these rows when they scroll above the window — never dropping them — but **audit-exempt** (tracked via a new byte-stable `auditRows` prefix), so a later layout change of an already-committed row freezes a stale row in history (duplication never loss) instead of re-anchoring the committed-prefix audit and spraying duplicate snapshots. Components that omit it are unchanged: `durableBoundary === byteStableBoundary` and `auditRows === committedRows`, so the ledger math is byte-identical.

### Fixed

- Fixed overlays without an explicit `maxHeight` dropping their bottom rows off-screen when taller than the terminal: `#resolveOverlayLayout` now defaults the height cap to the available rows, so a tall overlay is sliced to fit (and re-clamps on resize) instead of overflowing the visible region.
- Fixed `Editor.#decorate` rejecting keyword matches glued to the cursor: `CURSOR_MARKER` begins with ESC (non-whitespace), so decorators with a right-boundary lookahead (e.g. `/(?<!\S)ultrathink(?!\S)/`) failed at the seam and dropped highlighting until a trailing character was typed. The decorate hook now splits around the marker and decorates each user-text segment in isolation so word-boundary lookarounds resolve correctly on both sides ([#2475](https://github.com/can1357/oh-my-pi/issues/2475)).
- Fixed non-multiplexer resize drags with width changes briefly showing terminal-reflowed wrapped fragments: transient resize frames now borrow the alternate screen and return to the normal screen for the settled authoritative replay.
- Fixed `isMultiplexerSession()` only checking the `TMUX`/`STY`/`ZELLIJ` env vars and missing the `TERM=tmux-*`/`screen-*` fallback every sibling detector uses. When the multiplexer env was stripped but `TERM` survived (`sudo` without `-E`, `su`, env-sanitizing launchers/ssh), the renderer misclassified the pane as a direct terminal and emitted ED3 (`CSI 3 J`) on resize/replace/`resetDisplay`, which wipes tmux pane history — scrollback only reappeared after a full rerender (Ctrl+L). The check now aligns with `shouldEnableSynchronizedOutputByDefault`, `detectRectangularSgrSupport`, and `getFallbackImageProtocol` in `terminal-capabilities.ts` ([#2544](https://github.com/can1357/oh-my-pi/issues/2544)).

## [15.12.6] - 2026-06-14

### Fixed

- Fixed live transcript rows duplicating into native scrollback during a non-multiplexer resize drag: the viewport fast-path repaint now parks the hardware cursor at the real content bottom (mirroring the authoritative paint) instead of the padded viewport bottom, so a subsequent height shrink no longer scrolls live rows into history before the settle replay
- Fixed inline images flipping to their text fallback during a non-multiplexer resize drag: the viewport fast path now drives the image budget as a stable partial pass that replays the committed per-image live/text split by id, instead of deriving it from the reversed, tail-only walk order

## [15.12.5] - 2026-06-13

### Added

- Added `ViewportTailProvider` to let child components provide their visible tail rows during fast-path non-multiplexer resize rendering
- Added `TUI.resizeViewportPaints` and `TUI.resizeViewportActive` getters to expose deferred resize viewport repaint diagnostics

### Changed

- Changed non-multiplexer terminal resize handling so each SIGWINCH paints only the visible viewport and defers the full rewrap and native scrollback replay until the resize settles

### Fixed

- Fixed issue #2088 viewport flash and repeated full rewrites during rapid terminal drags outside multiplexers by replaying the full transcript only after the resize settle window

## [15.12.4] - 2026-06-13

### Added

- `PI_FORCE_HYPERLINKS=1` / `PI_NO_HYPERLINKS=1` env overrides for the OSC 8 hyperlink capability, mirroring the `PI_FORCE_SYNC_OUTPUT`/`PI_NO_SYNC_OUTPUT` shape (opt-out beats force-on).

### Changed

- Auto-enable OSC 8 hyperlinks inside tmux when tmux self-reports >= 3.4 via `TERM_PROGRAM_VERSION`; tmux 3.4 stores OSC 8 as a cell attribute and forwards it to outer terminals whose `terminal-features` include `hyperlinks`. Older tmux, GNU screen, and tmux without a reported version still default off. Resolution is factored into `hyperlinksUserOverride()` and `shouldEnableHyperlinksByDefault()` mirroring the sync-output helpers ([#2403](https://github.com/can1357/oh-my-pi/issues/2403)).

## [15.11.8] - 2026-06-12

### Changed

- Markdown rendering during streaming re-lexes only the grown tail instead of the whole buffer on every reveal tick. marked has no resumable lexer, but block tokenization is local across a blank-line boundary with balanced fences, so the largest blank-line-bounded prefix's block tokens are frozen and reused (`lex(prefix) ++ lex(tail)`), with a full-lex fallback for non-append edits, reference-link definitions, and CRLF input. The output is byte-identical to a full lex (covered by a contract test), turning the O(N²) cost of revealing a long single-block message into O(N): a 6,000-grapheme reveal dropped from ~575 ms to ~89 ms of CPU in benchmarks.

## [15.11.5] - 2026-06-12

### Added

- Added `fuzzyRank` to return sorted matches together with a fuzzy score
- Added a configurable `Input.prompt` field (defaults to `"> "`; set to `""` for chrome-less embedding inside custom banners)

### Changed

- Changed fuzzy matching to normalize queries and text into words, including camelCase and punctuation separators, before scoring
- Changed `Input.setValue` to place the cursor at the end of the new value instead of clamping it to its previous position, so typing after seeding a prefilled value appends rather than prepends

### Fixed

- Fixed multi-word searches so `fuzzyMatch` no longer matches when query letters are only scattered across unrelated words

## [15.11.4] - 2026-06-12

### Added

- Added `partialHoldTimeout` to `StdinBufferOptions` to control the maximum extra delay held for unambiguous incomplete escape sequences before they are flushed
- Added `SettingsList.sidebarWidth` option for a fixed split-layout sidebar width
- Added mouse pointer support APIs to `SettingsList` with `setHoverItem`, `hitTest`, `hoverTest`, and `routeSubmenuMouse` for row targeting and submenu routing
- Added `SettingsList.setMaxVisible(rows)` and `SettingsList.handleWheel(delta)` for dynamic viewport sizing and mouse-wheel step selection
- Added compact tab features with new `Tab.short` labels and `TabBar.selectTab(id)` for id-based activation of non-muted tabs
- Added pointer-hover and hit-testing APIs to `TabBar` with `setHoverTab`, `tabAt`, and `hoverTab` theme
- Added exported SGR mouse utilities `parseSgrMouse`, `SgrMouseEvent`, and `MouseRoutable`
- Added section support to `SettingsList`: `SettingItem.heading` rows split the list into sections, PgUp/PgDn (`tui.select.pageUp`/`pageDown`) jump between sections (or page when none exist), and wide renders use a split layout — section sidebar on the left, the active section's items on the right — falling back to inline heading rows when the width cannot fit both panes. Headings are skipped by navigation, excluded from search, and styled through the optional `SettingsListTheme.heading` (which receives a `dimmed` flag for headings outside the active section) and `section`.
- Added a host-integration surface to `SettingsList`: a `SettingsListOptions` constructor arg (`layout` to force the flat layout, `typeToSearch: false` to hand the query to a parent, `emptyText`, `hint`), `selectItem(id)`, `getSelectedItem()`, `onSelectionChange`, `hasOpenSubmenu()`, and the exported `getSettingItemFilterText` helper.
- Added keyboard section focus to `SettingsList`: `toggleSectionFocus()` / `sectionFocused` / `hasSectionFocusTargets()` flip Up/Down between row navigation and whole-section jumps — the cursor glyph parks on the active sidebar entry (or the active heading row in the flat layout) while the row cursor hides, Enter/Esc drop focus back to the rows, and any explicit row selection (`selectItem`, wheel, filtering) exits it.
- Added muted tabs to `TabBar` (`Tab.muted` + `TabBarTheme.mutedTab`, skipped by keyboard navigation), `setTabs(tabs, activeId?)`/`setActiveById(id)` for re-rendering the strip without firing `onTabChange`, an optional empty label (drops the `Label:` prefix), and a `showHint` switch for the trailing "(tab to cycle)" hint.

### Changed

- Changed `SettingsList` section-focused keyboard handling so `Up`/`Down` now jump between sections and `Enter`/`Escape` exit section focus before confirming or cancelling a setting
- Changed `SettingsList` split layout at wide widths to render the full list in the right pane and dim items outside the active section instead of showing only the active-section rows
- Changed `SettingsList` to omit the default hint row (and preceding blank line) when `options.hint` is set to an empty string
- Changed tab-bar overflow handling to collapse tabs to their `short` forms before wrapping to multiple lines

### Fixed

- Fixed `StdinBuffer` handling of split SGR mouse reports so fragmented sequences are reassembled instead of leaking their tail bytes as literal input
- Fixed Esc being unreliable (or seconds-slow) inside fullscreen overlays such as `/settings` on kitty-protocol terminals (Ghostty/kitty): the kitty keyboard mode stack is per-screen, so entering the alternate screen silently reverted keys to legacy encoding while the app still parsed them as kitty input. The TUI now re-pushes the active kitty flags right after `\x1b[?1049h` and pops them before `\x1b[?1049l`.
- Fixed `StdinBuffer` tearing a buffered bare `ESC` followed by another escape sequence: the `\x1b\x1b` candidate was consumed as alt+esc before the CSI/SS3 continuation byte was ever inspected, swallowing the Esc keypress and leaking the follower's tail (`[B`, `[<35;22;17M`) as typed text into focused components. Meta-CSI chords (`\x1b\x1b[A`) now stay whole, and `ESC` + SGR mouse report is split into a real Esc keypress plus a parseable report.
- Lowered `PARTIAL_HOLD_MAX_MS` from 500ms to 150ms so a dangling escape partial that never completes (e.g. a bare `ESC` arriving while the kitty-active flag is stale) is delivered after at most ~200ms instead of half a second.
- Fixed deferred partial-flush behavior so pending incomplete escapes are not split across timer boundaries and can still complete when the next chunk arrives
- Fixed kitty keyboard-mode handling of a dangling `ESC` so it can be joined with subsequent CSI mouse/kitty input instead of being emitted as a standalone sequence
- Fixed `SettingsList` to clear section-focus state when filtering items, changing data, scrolling with the mouse wheel, or selecting by ID so stale heading focus does not persist across interactions
- `SettingsList` now renders every state — list, open submenu, filtered results, empty — at one stable height, so interacting with a bottom-anchored settings panel no longer resizes the live terminal region on each keystroke (which forced re-anchoring and could strand stale scrollback rows).

## [15.11.3] - 2026-06-11

### Fixed

- Fixed the root compose letting a lower child's native-scrollback live seam overwrite a higher one: the topmost seam (and its commit-safe extension) now defines the commit boundary, so a status loader below a streaming transcript can no longer cause still-mutable transcript rows to be committed as stale history ([#2328](https://github.com/can1357/oh-my-pi/pull/2328)).

## [15.11.2] - 2026-06-11

### Fixed

- Fixed Ctrl+C/exit corrupting the parent shell on Windows: `emergencyTerminalRestore()` wrote `\x1b[?1049l` (leave alternate screen) unconditionally on every exit path, and conhost/Windows Terminal execute an unconditional cursor restore for it even when the alt buffer was never entered — with no prior save the cursor jumped to the viewport home, so the shell prompt landed on top of the dead frame. The leave sequence is now gated on tracked alt-screen state (set/cleared by the TUI's fullscreen-overlay enter/leave and stop paths).
- Skipped native syntax highlighting for transient markdown streaming renders, including nested list code blocks, leaving code blocks plain until their content stabilizes to avoid main-thread highlighter spikes.

## [15.11.1] - 2026-06-11

### Added

- Added `TUI.requestComponentRender(component)` to schedule component-scoped renders for self-contained updates

### Changed

- Changed the render pipeline to reuse only affected root subtrees for component-scoped updates, avoiding full-tree compose when animations or other isolated component changes occur

### Fixed

- Fixed component-scoped renders to preserve prior live scrollback seam data for skipped root children, preventing duplicate or missing rows during spinner-only updates
- Reported committed native scrollback row counts to interested child components so immutable history can be skipped without breaking live-region commit bookkeeping.
- Fixed `ProcessTerminal` treating asynchronous stdout `EIO` errors as uncaught exceptions: stdout `error` events now mark the terminal dead, disable future renders, and keep the active session process alive ([#2284](https://github.com/can1357/oh-my-pi/issues/2284)).

## [15.11.0] - 2026-06-10

### Added

- Added support for asynchronous `onSubmit` handlers by allowing the callback to return a `Promise<void>`

## [15.10.11] - 2026-06-10

### Added

- `SettingsList` now supports type-to-search filtering with Escape clearing an active query before canceling.

### Changed

- Preserved list selection by item ID when replacing settings so focus stays on the same setting
- Displayed a no matching settings message and search-editing hint when filtering returns no matches
- Expanded settings search matching to include IDs, current values, descriptions, and option values as well as labels
- Raised the stdin split-escape flush window from 10ms to 50ms: over laggy links (ssh, slow multiplexers) a CSI sequence split across reads was flushed as literal data, leaking `[` + `A` style fragments into the editor as typed text
- Lengthened the OSC 11 appearance poll on terminals without Mode 2031 from 2s to 30s — each poll's query write cleared the user's active text selection, breaking copy every two seconds on Alacritty/Warp/older WezTerm
- Rewrote `StdinBuffer.extractCompleteSequences` to index-based scanning: the previous per-iteration `slice` + `Array.from(remaining)[0]` made plain-text bursts O(n²), turning a 100KB non-bracketed paste into a multi-second freeze
- Capped the editor undo stack at 100 entries with word-level coalescing of consecutive single-character inserts (matching `Input`), capped the kill ring at 60 entries, cached word-wrap layout per (line, width) so each render and key handler shares one wrap pass, and batched ≤1000-char single-line pastes into one insert + one trigger-detection pass instead of per-character replay
- Virtualized the frame pipeline around a stable-prefix contract — the renderer no longer does O(total transcript) work per frame. `Component.render` now returns `readonly string[]`: results are component-owned, callers must not mutate them, and an unchanged component returns the same array reference (reference equality proves byte-identical rows). `Container.render` memoizes its concatenation on child references (children are still rendered every frame for their side effects); `Box` replaced its content-hashing cache with the same child-reference memo (no more per-frame `leftPad + line` rebuilds and full-content hashing); `Markdown`, `Spacer`, and `TruncatedText` return their cached arrays by reference instead of defensive copies. The TUI composes a persistent frame from per-child segments and an opt-in `RenderStablePrefix` report (consumable floor semantics for in-place mutators like the transcript), so marker extraction, line preparation (persistent prepared-frame replacing the per-frame rebuilt cache arrays), and the committed-prefix audit now run only over rows at/after the first changed row instead of every line of the transcript every frame
- Rewrote the render core around an append-only native-scrollback contract. Committed rows are immutable: rows enter terminal history exactly once, in order, when the component-reported commit boundary (`NativeScrollbackLiveRegion`) marks them final, and the visible window repaints in place with relative moves. The engine no longer probes the terminal's scroll position or guesses whether a destructive rebuild is safe — the entire ED3-risk/defer/checkpoint machinery (viewport probes, eager streaming mode, dirty-scrollback reconciliation, deferred shrink/mutation intents, streaming high-water rebuilds, ConPTY-specific defer paths) is deleted. ED3 (`CSI 3 J`) now fires only on explicit user gestures: session replace, resize outside multiplexers, and `resetDisplay()`. This structurally removes the yank / flash / duplicated-rows / invisible-until-resize failure families tracked across #1610, #1635, #1651, #1682, #1719, #1746, #1799, #1823, #1962, #1974, #2000, #2011, #2154.
- A frame that shrinks into its committed prefix re-anchors the visible window at the new tail and restarts commit bookkeeping; previously committed rows stay in history (history is never rewritten without a gesture).
- Overlays now composite into the visible window slice only and freeze commits while visible, so overlay pixels can never enter native scrollback and closing an overlay no longer triggers a destructive history rebuild.
- Inline-image budget demotion now deletes the demoted image's graphics by id and lets the window diff repaint the text fallback — no more mid-session destructive full replay when the image cap is exceeded.
- The render-stress harness now validates the contract with a shadow commit ledger (an independent reimplementation of the ledger math fed only by observed frames and bytes), asserting scrollback equals the committed prefix row-for-row and that tape growth matches physical scroll exactly, across randomized op sequences, resizes, overlays, and multiplexer scenarios. The ghostty-web virtual terminal additionally survives libghostty-vt 0.4's WASM allocator traps via an event-log replay/compaction recovery, and strips non-spacing combining marks on input (a margin-aligned combining cluster deterministically corrupts that engine; mark placement through it was already unverifiable).

### Fixed

- Fixed Windows rendering degrading into CP437 mojibake (`Γöé`/`ΓöÇ` instead of box-drawing borders and Nerd Font glyphs) after a console-sharing child process changed the console codepage (e.g. PHP CLI's implicit `chcp`, php.net request #73716): the breakage stayed latent until the next full repaint such as ctrl+o expand. The terminal now re-asserts the UTF-8 codepage (output and input) before each stdout write
- Fixed crash recovery leaving the shell unusable: `emergencyTerminalRestore` (and `terminal.stop()`) never left the alt screen nor disabled mouse tracking, so a crash during a fullscreen overlay stranded the user on the alternate buffer with any-motion mouse reporting spewing escape garbage until a manual `reset`
- Fixed bracketed paste with a lost `ESC[201~` end marker (ssh/tmux truncation) silently eating all subsequent input forever while growing memory unboundedly — paste mode now has an inactivity watchdog (1s) and a byte cap (64 MiB) that exit paste mode and deliver the accumulated bytes through the paste event
- Fixed vertical cursor movement using UTF-16 code units as visual columns: Up/Down over emoji/CJK lines could land the cursor mid-surrogate-pair, rendering a lone surrogate and permanently corrupting the buffer on the next insert; movement now walks graphemes and snaps the target offset to a cluster boundary, also fixing column drift across wide glyphs
- Fixed cursor positions inside whitespace trimmed at a word-wrap boundary mapping to no layout line — the cursor vanished and the viewport jumped to the buffer's last line; the preceding chunk now owns the skipped whitespace run
- Fixed word-delete and kill-to-line operations (Ctrl+W/Alt+D/Ctrl+U/Ctrl+K) cutting through atomic paste markers, leaving `[Paste #1, +30` junk that no longer expanded to the pasted content on submit — delete ranges now extend over any atomic token they intersect
- Fixed the kitty CSI-u printable dedup swallowing a real keystroke arbitrarily long after the duplicated event; the pending codepoint now expires after 25ms
- Fixed `resetDisplay()` being a no-op on the alt screen: the redraw gesture could not repair a corrupted fullscreen modal because `#emitAltFrame` skipped identical-string repaints without consulting the force-repaint flag
- Fixed the ghostty initial-image paint deferral consuming resize/cursor state before abandoning the frame, which could misclassify the deferred render's reflow and corrupt the paint — the deferral check now runs before any frame state is touched
- Fixed the terminal-cursor inline-hint branch adding the full hint width to the line accounting even though the rendered hint was truncated, misaligning right padding whenever the hint overflowed
- Fixed nested markdown list detection sniffing for hardcoded `\x1b[36m` (chalk cyan): every shipped theme emits truecolor/256-color SGR for bullets, so nested items doubled their indentation per level on all real themes; nesting is now tagged structurally by the list renderer. Ordered-list continuation lines also hang by the actual bullet width, so wrapped text under `10.`+ items aligns
- Fixed committed transcript rows silently vanishing when a component re-laid-out content the engine had already scrolled into native history — a TTSR stream rewind truncating a streamed block, or the image budget demoting a committed inline image to its one-line fallback, shifted every row below by the height delta and the engine kept committing from the stale index, skipping that many rows of everything after (missing interruption banners, half-cut images in scrollback). The engine now audits its committed prefix every ordinary frame: an in-place edit or restyle keeps its alignment (stale styling in history remains the accepted artifact), while any shift re-anchors the commit index at the first moved row and recommits from there — history keeps the stale copy and gains a fresh one. Duplication, never loss. The detector (`findCommittedPrefixResync`, exported for the stress harness's shadow ledger) samples the prefix tail SGR-stripped so theme restyles and single-row edits never trigger spurious recommits.
- Fixed budget-demoted inline images shrinking their transcript block: the text fallback is now height-preserving once a graphic has rendered (reserved rows plus the fallback line), so demotion never shifts content below a committed image.
- Fixed stale trailing cells bleeding into committed history on combining-heavy rows: the native width model can over-count Arabic/combining clusters, classifying a short-rendering row as full-width and skipping the trailing erase — the previous occupant's cells then scrolled into scrollback baked into the committed row. Non-ASCII row rewrites now erase the line before writing.

### Removed

- Removed the probe/defer API surface: `TUI.setEagerNativeScrollbackRebuild()`, `TUI.refreshNativeScrollbackIfDirty()`, `TUI.setClearOnShrink()`/`getClearOnShrink()`, `RenderRequestOptions.allowUnknownViewportMutation`, `NativeScrollbackRefreshOptions`, `Terminal.isNativeViewportAtBottom()`, `Terminal.hasEagerEraseScrollbackRisk()`, and the `eagerEraseScrollbackRisk`/`submitPinsViewportToTail` capability fields with their detectors.
- Removed the `PI_TUI_ED3_SAFE`, `PI_CLEAR_ON_SHRINK`, and `PI_TUI_DEBUG` environment variables (the levers they tuned no longer exist; `PI_DEBUG_REDRAW` now logs the commit-ledger state per frame).

## [15.10.10] - 2026-06-09

### Fixed

- Fixed committed transcript rows silently vanishing when a component re-laid-out content the engine had already scrolled into native history — a TTSR stream rewind truncating a streamed block, or the image budget demoting a committed inline image to its one-line fallback, shifted every row below by the height delta and the engine kept committing from the stale index, skipping that many rows of everything after (missing interruption banners, half-cut images in scrollback). The engine now audits its committed prefix every ordinary frame: an in-place edit or restyle keeps its alignment (stale styling in history remains the accepted artifact), while any shift re-anchors the commit index at the first moved row and recommits from there — history keeps the stale copy and gains a fresh one. Duplication, never loss. The detector (`findCommittedPrefixResync`, exported for the stress harness's shadow ledger) samples the prefix tail SGR-stripped so theme restyles and single-row edits never trigger spurious recommits.
- Fixed budget-demoted inline images shrinking their transcript block: the text fallback is now height-preserving once a graphic has rendered (reserved rows plus the fallback line), so demotion never shifts content below a committed image.
- Fixed stale trailing cells bleeding into committed history on combining-heavy rows: the native width model can over-count Arabic/combining clusters, classifying a short-rendering row as full-width and skipping the trailing erase — the previous occupant's cells then scrolled into scrollback baked into the committed row. Non-ASCII row rewrites now erase the line before writing.

### Changed

- Rewrote the render core around an append-only native-scrollback contract. Committed rows are immutable: rows enter terminal history exactly once, in order, when the component-reported commit boundary (`NativeScrollbackLiveRegion`) marks them final, and the visible window repaints in place with relative moves. The engine no longer probes the terminal's scroll position or guesses whether a destructive rebuild is safe — the entire ED3-risk/defer/checkpoint machinery (viewport probes, eager streaming mode, dirty-scrollback reconciliation, deferred shrink/mutation intents, streaming high-water rebuilds, ConPTY-specific defer paths) is deleted. ED3 (`CSI 3 J`) now fires only on explicit user gestures: session replace, resize outside multiplexers, and `resetDisplay()`. This structurally removes the yank / flash / duplicated-rows / invisible-until-resize failure families tracked across #1610, #1635, #1651, #1682, #1719, #1746, #1799, #1823, #1962, #1974, #2000, #2011, #2154.
- A frame that shrinks into its committed prefix re-anchors the visible window at the new tail and restarts commit bookkeeping; previously committed rows stay in history (history is never rewritten without a gesture).
- Overlays now composite into the visible window slice only and freeze commits while visible, so overlay pixels can never enter native scrollback and closing an overlay no longer triggers a destructive history rebuild.
- Inline-image budget demotion now deletes the demoted image's graphics by id and lets the window diff repaint the text fallback — no more mid-session destructive full replay when the image cap is exceeded.
- The render-stress harness now validates the contract with a shadow commit ledger (an independent reimplementation of the ledger math fed only by observed frames and bytes), asserting scrollback equals the committed prefix row-for-row and that tape growth matches physical scroll exactly, across randomized op sequences, resizes, overlays, and multiplexer scenarios. The ghostty-web virtual terminal additionally survives libghostty-vt 0.4's WASM allocator traps via an event-log replay/compaction recovery, and strips non-spacing combining marks on input (a margin-aligned combining cluster deterministically corrupts that engine; mark placement through it was already unverifiable).

### Removed

- Removed the probe/defer API surface: `TUI.setEagerNativeScrollbackRebuild()`, `TUI.refreshNativeScrollbackIfDirty()`, `TUI.setClearOnShrink()`/`getClearOnShrink()`, `RenderRequestOptions.allowUnknownViewportMutation`, `NativeScrollbackRefreshOptions`, `Terminal.isNativeViewportAtBottom()`, `Terminal.hasEagerEraseScrollbackRisk()`, and the `eagerEraseScrollbackRisk`/`submitPinsViewportToTail` capability fields with their detectors.
- Removed the `PI_TUI_ED3_SAFE`, `PI_CLEAR_ON_SHRINK`, and `PI_TUI_DEBUG` environment variables (the levers they tuned no longer exist; `PI_DEBUG_REDRAW` now logs the commit-ledger state per frame).

## [15.10.9] - 2026-06-09

### Added

- Added a `wrapDescription` option to `SelectListLayoutOptions`. When enabled, long descriptions wrap onto continuation rows indented under the description column instead of being silently truncated. The slash-command/skill autocomplete picker now opts in so descriptions like the bundled skills' remain fully readable at normal terminal widths. `maxVisible` becomes the picker's visual row budget so the popup height stays bounded even when items wrap (a single 5-row description with `maxVisible=3` clips with the scrollbar carrying the offscreen tail). Navigation stays item-to-item, the narrow-width fallback (`width <= 40`) is unchanged, and the `ScrollView` scrollbar tracks visual rows so the thumb stays correct when items wrap unevenly. ([#2169](https://github.com/can1357/oh-my-pi/issues/2169))

### Fixed

- Fixed Ghostty's first inline image in a fresh TUI session sometimes rendering as an empty placeholder block by holding the initial Kitty graphics paint until the terminal startup settle window has passed. Direct Kitty placements also keep their zero-width reservation rows non-plain so image-only transcript blocks do not collapse when blank-edge trimming runs.

## [15.10.8] - 2026-06-09

### Fixed

- Fixed TUI renders repeatedly clearing terminal scrollback after content filled the viewport. Unknown viewport probes no longer let foreground-streaming offscreen growth take the destructive `historyRebuild` path on every frame; newly appended tail rows stay reachable while stale history waits for a safe checkpoint. ([#2154](https://github.com/can1357/oh-my-pi/issues/2154))

## [15.10.6] - 2026-06-08

### Added

- Added `TUI.getFocused()` accessor and `Input.pasteText(text)` method so callers consuming non-bracketed paste transports (e.g. kitty's OSC 5522 enhanced clipboard) can route a paste payload to the currently focused modal Input rather than always to the primary editor. Mirrors the existing `Editor.pasteText` semantics: newlines stripped, tabs normalized, NFC normalization applied. ([#2127](https://github.com/can1357/oh-my-pi/issues/2127))

### Fixed

- Fixed tmux/screen/zellij rewind/branch (`requestRender(true, { clearScrollback: true })`) permanently anchoring the input box to the pane top and overlaying scrollback after a streamed reply had grown past the viewport. `#emitFullPaint` only reset `#scrollbackHighWater` inside the `clearScrollback` branch and otherwise raised it monotonically, so inside multiplexers (where `\x1b[3J` is a no-op and `clearScrollback` is forced off) the streaming peak survived the rewind; on the next frame `#planLiveRegionPinnedRender` saw the stale high-water and anchored `renderViewportTop` past the actual content, repainting every visible row blank and parking the cursor at screen row 0 for the rest of the session. A full repaint with `clearViewport: true` re-emits the entire transcript from row 0, so `#scrollbackHighWater` is now assigned (not max-clamped) to the natural push count regardless of whether ED 3 was issued ([#2130](https://github.com/can1357/oh-my-pi/issues/2130)).

## [15.10.5] - 2026-06-08

### Added

- Added `atomicTokenPattern` to `Editor`: when set to a global regex matching placeholder tokens such as `[Image #1, 800x600]` or `[Paste #2, +30 lines]`, a single backspace or forward-delete landing anywhere on a token removes the whole token instead of corrupting it into stray text.

### Changed

- Changed the large-paste placeholder label from `[paste #N +X lines]`/`[paste #N Y chars]` to `[Paste #N, +X lines]`/`[Paste #N, Y chars]`.

### Fixed

- Fixed pasting large text lagging the prompt for hundreds of milliseconds before the `[paste #N …]` placeholder appeared. `StdinBuffer` assembled bracketed pastes by re-concatenating and re-scanning the entire accumulated buffer on every incoming stdin chunk (`#pasteBuffer += chunk; indexOf(END)`), which is O(n²) in the paste size and dominates when the terminal/PTY delivers the paste in many small reads (SSH, tmux, slow hosts) — a 1 MB paste at 1 KB chunks cost ~33 ms and 5 MB ~740 ms. Chunks are now collected in an array and joined once when the end marker arrives, with a short overlap tail carried across chunk boundaries so a marker split between two reads is still detected without rescanning, making assembly O(n) (~1 ms for 5 MB). The `Editor` paste cleaner also dropped its `split("").filter().join("")` per-code-unit array allocation in favor of a single control-character regex pass (~20× faster on large pastes).

## [15.10.4] - 2026-06-08

### Fixed

- Fixed Windows ConPTY session-resume painting the transcript with the last several rows truncated below the viewport until Alt+Tab forced a host repaint. After `sessionReplace`/`historyRebuild`/`overlayRebuild` paints that scroll-push content into native scrollback, the renderer now arms a 150 ms ConPTY settle window that coalesces spinner/blink-driven `requestRender(false)` calls into a single trailing render — Windows Terminal's viewport-follow logic no longer falls further behind the cursor on every tick of the post-paint storm. The arm also reclaims any render request queued *during* the in-flight composition (notably `ImageBudget.endPass()` calling `requestRender()` synchronously when a frame trips the live-graphics cap): without that, the queued request sat on the standard 30 Hz throttle and fired at ~33 ms — well inside the 150 ms quiet window — defeating the coalescing. Bumped the ConPTY per-`WriteFile` chunk cap from 8 KiB to 16 KiB so a multi-megabyte resume paint emits half as many writes (still well under the ~32 KiB threshold from #2034 that the original cap defends against), and made the cap measure encoded UTF-8 bytes instead of JS code units so a CJK-heavy transcript can't silently inflate a 16-KiB-of-code-units chunk into ~48 KiB of `WriteFile` traffic and reintroduce the #2034 viewport bug ([#2095](https://github.com/can1357/oh-my-pi/issues/2095)).

## [15.10.3] - 2026-06-08

### Fixed

- Fixed DEC 2048 in-band resize reports (`CSI 48;rows;cols;hpx;wpx t`) leaking into the focused editor as literal text during a rapid resize. When the window is resized quickly the event loop stays busy long enough for the `StdinBuffer` flush timeout to fire mid-report; the `\x1b[48;…` prefix was emitted as one event and the tail (e.g. `8;125;1156;1125t`) arrived as bare printable characters that the editor inserted. `ProcessTerminal` now reassembles a split in-band report (including a split at the bare `\x1b[4` type field) until its terminator and then drives the resize. A reassembled sequence that turns out not to be a resize report — such as a split kitty key like `\x1b[48;5u` (codepoint 48 = `0`) — is forwarded to the input handler as a single escape sequence rather than dropped or leaked.
- Coalesced terminal-multiplexer SIGWINCH events into a single forced render once the pane stops resizing so closing/dragging a tmux/screen/zellij split no longer flashes the viewport blank before the new geometry repaints ([#2088](https://github.com/can1357/oh-my-pi/issues/2088)).

## [15.10.2] - 2026-06-08

### Added

- Added exported `canonicalKeyId` and `addKeyAliases` keybinding helpers so consumers can share the same canonical shortcut matching semantics as `KeybindingsManager`.
- Added `super` modifier support to native key parsing/matching and bound `super+alt+backspace` / `super+alt+delete` (and `super+alt+d`) into the word-delete defaults so Ghostty's default macOS Option+Backspace wire (`ESC [127;11u` — kitty modifier 11 = super|alt) deletes a word instead of falling through to single-char delete ([#2064](https://github.com/can1357/oh-my-pi/issues/2064)).

### Fixed

- Fixed focus-changing in-place menus leaving stale Working/menu rows and parking the hardware cursor in the old menu viewport on terminals without a scroll-position oracle.
- Fixed redundant terminal cursor updates so repeated renders that do not change the cursor row, column, or visibility no longer emit ANSI move/hide sequences
- Fixed repeated cursor updates during no-op re-renders by reusing the last known cursor state, preventing unnecessary cursor position changes and hide/show sequences
- Fixed the kitty keyboard progressive-enhancement probe to honor the `CSI ? <flags> u` reply even when the terminal answers the DA1 sentinel first. Previously the kitty reply was discarded once the DA1-driven `modifyOtherKeys` fallback engaged, so terminals like Superset/xterm-on-Electron stayed on the fallback and delivered Shift+Enter as a bare `\r` ([#2042](https://github.com/can1357/oh-my-pi/issues/2042)).
- Bounded TUI line fitting for oversized raw rows so ANSI-heavy subagent output and zero-width-heavy text cannot grow render buffers independently of the viewport or hide visible suffix text ([#2045](https://github.com/can1357/oh-my-pi/issues/2045)).
- Fixed tmux offscreen-shrink frames to skip repainting when the visible tail is unchanged, avoiding intermittent blank/refresh flashes in pane terminals ([#2046](https://github.com/can1357/oh-my-pi/issues/2046)).
- Fixed Windows ConPTY hosts (Windows Terminal, Tabby, Hyper, VS Code) parking the viewport at the top of a full paint after a `/resume` or any long-session repaint. `ProcessTerminal#safeWrite` now splits oversized writes into ≤ 8 KiB pieces at line boundaries on `win32` and inside WSL (where stdout still crosses ConPTY at the `wslhost` boundary) so each underlying `WriteFile` stays below the ~32 KiB threshold where ConPTY stops tracking the cursor; the data was always delivered, but the host UI's scroll position would not follow until any focus event forced a re-query. ([#2034](https://github.com/can1357/oh-my-pi/issues/2034))

## [15.10.1] - 2026-06-07

### Breaking Changes

- Removed Kitty temp-file image transmission, its startup support probe, the `PI_KITTY_IMAGE_TRANSMISSION` override, and the temp-file helper exports. Kitty/Ghostty image payloads now stay on in-band base64 before placeholder/direct placement, avoiding blank first renders from temp-file load races.
- Renamed `RenderRequestOptions.allowUnknownViewportMutation` → `allowUnknownViewportTransientRepaint`. The option only permits a transient live-viewport repaint (autocomplete/IME/focused-editor chrome) on hosts that cannot report viewport position; it never authorizes a settled transcript commit. The old name implied any offscreen mutation was safe to push into native scrollback, which led callers to emit duplicate transcript copies.

### Added

- Added `TUI.addStartListener()` so feature hooks can re-enable terminal modes after temporary stop/start cycles such as external-editor handoffs.
- Added `Editor.pasteText()` to apply terminal-style paste handling for text inserted from non-bracketed paste transports
- Added an optional `dispose()` lifecycle method to `Component` so components can release timers and subscriptions during permanent teardown
- Added `Container.dispose()` to propagate teardown to child components when a component tree is permanently discarded
- Added `Loader.dispose()` to stop the loader animation timer when the component is disposed
- Added a `ScrollView` `ellipsis` option (defaults to `Ellipsis.Unicode`) so callers that pre-wrap content to width can pass `Ellipsis.Omit` and suppress the stray per-line `…` that lands on trailing padding.
- Added `ScrollView.handleScrollKey()` plus a `fastScrollLines` option so every scroll view gets shared navigation keys, including Shift+Arrow to scroll faster.
- Added `OverlayOptions.fullscreen`: while the topmost visible overlay sets it, the engine borrows the terminal's alternate screen buffer for the overlay's lifetime and paints only the modal there — no ED3, no transcript re-commit — so the transcript stays untouched on the normal screen and is not scrollable behind the modal. Mouse tracking (`?1000h`/`?1006h`) is enabled for the modal's lifetime and disabled on exit, so the rest of the app keeps the terminal's native text selection.
- Added the `submitPinsViewportToTail` terminal capability and `detectSubmitPinsViewportToTail()`: genuine local terminals where a submit keystroke scrolls the host to its tail reconcile deferred native scrollback at the prompt-submit checkpoint even when the viewport position is unprobeable (Ghostty/kitty/iTerm/WezTerm/Alacritty). Restores the pre-regression submit reconciliation without re-enabling it for Windows Terminal/ConPTY, SSH, or multiplexers, where a submit is not proof the host is at the tail.

### Changed

- Changed static `Loader` messages to repaint only at the spinner's 80 ms cadence; time-dependent message colorizers can opt into 16 ms redraws with `animated: true`.
- Changed keybinding matching to precompute canonical key sets so each input sequence is parsed once per binding check instead of once per candidate key.
- Made `Component.invalidate()` optional so leaf components without render caches no longer need no-op invalidation hooks.
- `TERMINAL` is now a `RuntimeTerminal` whose post-construction capabilities (image protocol and the probe-driven flags) are writable, replacing the `as unknown as MutableTerminalInfo` cast pattern and the positional `withTerminalOverrides` rebuild with a prototype-preserving `clone()`.

### Fixed

- Fixed `Loader` text updates to skip identical messages and preserve the rendered `Text` cache instead of invalidating it every timer tick.
- Fixed fullscreen overlay alt-frame rendering to reuse the current line-preparation path instead of calling removed fitting helpers.
- Reduced TUI render-path line fitting by deferring overlay base-frame fitting until an overlay rebuild and by reusing already-fitted lines in emitters.
- Reduced live-region pinned repaint output by diffing unchanged viewport rows when no sealed rows are being committed to native scrollback.
- Fixed no-append live-region pinned repaints to re-anchor the hardware cursor when the logical viewport shifts.
- Fixed keybinding matching so printable uppercase input preserves `Shift` for bindings such as `shift+a`.
- Optimized terminal image-line detection and Thai/Lao AM normalization checks to avoid hot-path regex scans and substring allocations.
- Fixed `Markdown.render()` cache hits returning the cache's mutable backing array, which let callers that append extra rows corrupt cached Markdown and duplicate those rows on every redraw.
- Fixed first-paint full replays for callers that intentionally replace terminal history by allowing `TUI.start({ clearScrollback: true })`, so they do not briefly append an entire initial frame before the first clean replay.
- Fixed ED3-risk streaming cap accounting to preserve the native scrollback high-water mark for rows that were already physically committed before transient frames were viewport-capped.
- Fixed terminal stop and restore cleanup to disable enhanced paste mode so it does not remain enabled after shutdown
- Removed the per-frame line-fit `Map` cache from the render timer path to avoid forcing JSC rope-string hashing during scheduled viewport repaints.
- Fixed `visibleWidth()` so terminal column measurements for ANSI and OSC text now match the native truncation/wrapping helpers, including OSC 66 text-sizing spans being counted at their scaled payload width
- Fixed cursor, padding, and line-fit behavior when strings contain tabs or OSC escapes by aligning `visibleWidth()` with the native text-width model
- Fixed the transcript — or a re-appearing prior view such as the welcome screen — duplicating itself on terminals without a scroll-position oracle (Ghostty/kitty/iTerm/WezTerm) when a foreground tool completes by rewriting a partly-committed block, or when the transcript is reset. A non-destructive viewport repaint no longer re-paints rows that are byte-identical to what is already committed to native scrollback into the active grid; the repaint anchor is clamped to the committed-and-unchanged prefix (`min(firstChanged, scrollbackHighWater)`).

## [15.10.0] - 2026-06-06

### Changed

- Reworked the DEC 2026 synchronized-output default policy: a positive DECRQM mode-2026 report now **enables** sync (previously a report could only disable it), so conservatively defaulted-off hosts that actually support it — current Zellij, tmux master, foot, contour, mintty — are upgraded at runtime. The static allowlist also covers Alacritty and the VS Code terminal, honors a `TERM_FEATURES` `Sy` advertisement and `WT_SESSION` (Windows Terminal / WSL), and no longer blanket-disables SSH (DEC 2026 passes through to the outer terminal). Risky multiplexers still start off and rely on the probe. Added `synchronizedOutputUserOverride()` as the shared opt-out/force resolver.

### Fixed

- Fixed WSL/Windows Terminal row flicker while typing by repainting changed text rows before clearing only their stale suffix ([#2011](https://github.com/can1357/oh-my-pi/issues/2011)).
- Fixed terminals that support DEC 2026 still tearing/flickering because the renderer ignored a positive DECRQM capability report and kept synchronized output off — most visibly WSL + Windows Terminal, Alacritty (≥0.13), and the VS Code terminal (≥1.108), which were detected yet refused sync.

## [15.9.69] - 2026-06-06

### Added

- Added `TUI.resetDisplay()` to force an immediate full-frame replay, including native scrollback when the host can safely clear it.
- Added `setPaddingY` to `Box` so vertical padding can be updated programmatically after creation.

### Fixed

- Fixed DECCARA background-fill optimization running when synchronized output is disabled, which could expose default-background gaps during rapidly updating tool-use panels ([#2000](https://github.com/can1357/oh-my-pi/issues/2000)).

## [15.9.67] - 2026-06-06

### Added

- Added `setPaddingX` to `Box` so horizontal padding can be updated programmatically after creation
- Added `ScrollView`, a fixed-height viewport component for pre-rendered lines with optional right-edge scrollbars and imperative scroll/page controls.
- Added optional `Terminal.hasEagerEraseScrollbackRisk()` so custom/test terminal implementations can override the global ED3-risk profile without mutating the shared `TERMINAL` object.

### Changed

- Changed `SelectList` to render its visible window through `ScrollView`, replacing the `(N/M)` text scroll indicator with a uniform right-edge scrollbar (the type-to-search hint line is preserved).

### Fixed

- Fixed unknown-viewport deferred renders freezing bottom-anchored live chrome; deferred history mutations can now repaint only the active-grid bottom row with relative cursor movement, so spinner/status tails keep advancing without rewriting rows a scrolled reader can still see.
- Fixed autocomplete popups freezing live repaint on ED3-risk macOS/POSIX terminals with unknown native viewport position; direct autocomplete shrink frames now repaint the live viewport without zero-byte deferral and preserve the old bottom anchor when padding can clear stale popup rows without duplicating committed scrollback.
- Fixed focused Up/Down navigation on ED3-risk macOS/POSIX terminals replaying the whole transcript after dirty foreground-stream renders; selector/editor frames now repaint non-destructively instead of emitting `CSI 3 J` on every arrow-key move ([#1962](https://github.com/can1357/oh-my-pi/issues/1962)).
- Fixed tmux (and screen/zellij) pane scrollback losing the head of a long streamed assistant reply once it grew past the visible pane, and stranding the chrome/footer in pane history after a later collapse — producing the "repeating chunks and missing sections" reporters saw when scrolling back through tmux pane history ([#1974](https://github.com/can1357/oh-my-pi/issues/1974)). The renderer's foreground-streaming cap-to-viewport branch (introduced in 15.9.2 for ED3-risk hosts that can checkpoint-rebuild later) also activated inside multiplexers, where checkpoint reconcile is a no-op (`refreshNativeScrollbackIfDirty` short-circuits because `\x1b[3J` cannot erase pane history). Every streaming frame clipped `lines` to the visible tail and reset `#scrollbackHighWater` to 0, so any row that scrolled above the viewport top was committed nowhere — pane history stayed empty until streaming ended. Meanwhile `#planLiveRegionPinnedRender` was explicitly disabled for multiplexers, but its `#emitLiveRegionPinnedRepaint` is built from the exact primitives tmux accepts (relative cursor moves, per-line `\x1b[2K`, `\r\n` to scroll the sealed prefix past the viewport bottom) and never emits `\x1b[2J`/`\x1b[3J`. The pinned planner now runs in multiplexers too, the cap branch skips them, and the diff/append path commits incrementally into pane history; the actively-mutating live tail stays in the visible viewport only.

## [15.9.5] - 2026-06-05

### Changed

- Changed terminal resize handling so any width or height change always performs a clean reset + redraw: the renderer now unconditionally clears the viewport and native scrollback (`CSI 2 J` / `CSI 3 J`) and replays the full transcript at the new geometry, replacing the previous matrix of conditional viewport-repaint / history-rebuild / deferred-mutation branches. Multiplexer panes still repaint the visible window in place (pane scrollback cannot be erased), but a resize during active ED3-risk foreground streaming now performs the same clean rebuild rather than downgrading to a non-destructive viewport repaint: the terminal already re-wrapped its saved lines at the old width, so the rebuild must erase them (ED 3) instead of leaving the mis-wrapped history on screen. As a deliberate tradeoff this drops the prior no-overflow and confirmed-scrolled guards on resize: a reader scrolled into history snaps back to the bottom and preexisting shell scrollback above the UI is cleared.

### Fixed

- Fixed ED3-risk foreground streaming dropping the scrolled-off head of an append-only live block that alone overflows the viewport (a long streamed assistant reply). The live-region pin again committed native scrollback only up to the live-region start, so once the live block grew past the viewport its earlier rows scrolled above the viewport top but were committed nowhere and repainted nowhere — they vanished, leaving the reply looking like a ~viewport-tall circular buffer. The `NativeScrollbackLiveRegion` seam now also reports an optional append-only `getNativeScrollbackCommitSafeEnd`, and the pinned commit boundary is the deeper of the sealed start and that append-only end: rows in `[liveRegionStart, commitSafeEnd)` above the viewport top commit to scrollback, while volatile live blocks (tool previews that collapse) omit the boundary and keep their mutable rows deferred — preserving the pending-box-above-running-box fix.

## [15.9.4] - 2026-06-05

### Added

- Added `PI_TUI_SYNC_OUTPUT=0` and `PI_TUI_SYNC_OUTPUT=1` to explicitly disable or force-enable DEC 2026 synchronized-output mode, alongside `PI_FORCE_SYNC_OUTPUT=1` as a force-on alias
- Added `PI_TUI_ED3_SAFE=1` environment override to treat a terminal as non-ED3-risk for eager native scrollback rebuilds on unknown POSIX hosts

### Changed

- Changed native-scrollback safety defaults to treat unknown POSIX, SSH, and multiplexer-shaped terminals as ED3-risk for passive rendering; checkpoint replay now requires a positive at-tail viewport proof instead of assuming prompt submit makes host scrollback safe.
- Changed synchronized-output defaults to a conservative opt-in profile: DEC 2026 paint wrappers stay disabled for remote/multiplexer/VTE/unknown terminals unless explicitly forced, while the autowrap guards remain active.

### Fixed

- Fixed ED3-risk unknown-viewport renders repainting offscreen structural edits over stale native scrollback, which could duplicate or shift rows when async blocks collapsed or middle rows were deleted.
- Fixed ED3-risk foreground streams committing mutable live-region rows into native scrollback, which could leave a stale `pending` tool box above the `running` box after the preview re-rendered.
- Fixed TUI shutdown leaving paint-time terminal state and Kitty image data behind by restoring synchronized-output/autowrap modes and purging all transmitted Kitty image ids on stop.
- Fixed stdin buffering splitting surrogate-pair text into UTF-16 halves and reduced timing sensitivity for incomplete escape sequences.
- Fixed terminal content not reflowing after a resize on terminals using DEC 2048 in-band resize (kitty/Ghostty/iTerm2/WezTerm). `ProcessTerminal.columns`/`rows` returned the last cached in-band report even after the OS already knew the new size, so a SIGWINCH whose in-band report was dropped or malformed (split past the stdin flush window, `:`-subparameter fields) re-rendered the whole transcript at the stale width. OS resize events now reconcile cached in-band geometry against the live `process.stdout` dimensions, dropping a stale cached value so the next render uses the true size; a valid in-band report still re-seeds pixel sizing.

## [15.9.3] - 2026-06-05

### Fixed

- Fixed ED3-risk foreground streaming erasing the head of any block that alone overflows the viewport (a tall tool result drawn in one frame, or a multi-line assistant reply growing past the viewport as it streams). The live-region pin committed native scrollback only up to the sealed-prefix boundary (`liveRegionStart`), so rows of the live block that had physically scrolled above the viewport top were neither pushed into scrollback nor kept in the repainted viewport — they vanished. The commit boundary is now the viewport top: every row above the viewport enters scrollback (only the tail still visible in the viewport stays transient and deferred to the checkpoint).
- Fixed the same ED3-risk live-region pin duplicating already-committed scrollback rows when a foreground stream's live region collapsed mid-turn (a tool preview shrinking to its compact result, an assistant block re-wrapping shorter, a late tool completion). Because growth commits every row above the viewport top to native scrollback, a subsequent shrink moved the bottom-anchored viewport back across those committed rows and the repaint re-drew them into the viewport — so they appeared twice on scroll-up, and with no prompt-submit checkpoint to reconcile (autonomous multi-turn runs, or the session ending into the welcome screen) the duplicate was baked permanently into terminal history. The pinned repaint now separates commit geometry from repaint geometry: a collapse clamps the repaint to the committed sealed boundary (`min(#scrollbackHighWater, liveRegionStart)`) instead of re-exposing those rows, leaving native scrollback un-duplicated without emitting ED3 under a possibly-scrolled reader; stale mutable live-region saved lines still reconcile at the next checkpoint.
- Fixed hiding overlays during ED3-risk foreground streaming on unknown-viewport terminals leaving the overlay's transient rows in native scrollback. Overlay visibility reductions now bypass the streaming deferral path and rebuild once, so hidden dialog/notification sentinels are scrubbed immediately.
- Fixed ED3-risk / unknown-viewport terminals (including WSL fronted by Windows Terminal) keeping the foreground-stream eager-rebuild mode active after the stream had already settled. A later scrolled content shrink or resize-with-append could then bypass the anti-yank deferral and repaint from stale geometry, jumping the viewport or replaying the wrong rows. The eager opt-in now drops immediately when no teardown render is pending, and the one-frame post-checkpoint suffix-suppression path no longer overrides geometry reflow handling.

## [15.9.2] - 2026-06-05

### Changed

- Changed foreground-stream rendering on ED3-risk terminals (Ghostty/kitty/Alacritty/VTE/iTerm2 on POSIX) to defer native-scrollback commits for unpinned transient frames: while a turn streams, generic frames repaint only the viewport and suppress `\r\n` scroll growth, so transient output (spinner ticks, partial lines, status rows) never pollutes terminal history. Components that report a `NativeScrollbackLiveRegion` still commit newly sealed prefix rows while keeping the active suffix dirty for checkpoint replay. Native scrollback is reconciled in a single ED3 (`CSI 3 J`) + re-emit at the next checkpoint (prompt submit) or on an explicit user-input/IME opt-in; an erase is never emitted mid-stream under a possibly-scrolled reader. Non-ED3-risk terminals keep their eager live rebuild. ([#1895](https://github.com/can1357/oh-my-pi/pull/1895))

### Fixed

- Fixed ED3-risk foreground streaming dropping sealed transcript rows above the live block until the next prompt-submit checkpoint, which made scrollback beyond the viewport appear duplicated or out of order. The renderer restores native-scrollback live-region pinning so newly sealed rows are appended once while active live rows remain deferred.
- Fixed inline images (added in 15.9) rendering as a wall of empty PUA box glyphs and producing laggy scrolling on Kitty-protocol terminals that do not implement Unicode placeholders — most notably WezTerm (per upstream wezterm/wezterm#986, placeholder support is still unchecked) and the tmux/screen `getFallbackImageProtocol` path that forces Kitty mode even on non-supporting outer terminals (Terminal.app, etc.). `unicodePlaceholders` now defaults on only for `kitty` and `ghostty`; everything else falls back to direct `a=p,i=…,p=…` placement, which those paths already render correctly. `PI_NO_KITTY_PLACEHOLDERS=1` is still honored as a hard opt-out, and a new `PI_KITTY_PLACEHOLDERS=1` opts in on otherwise-unsupported terminals (e.g. a wezterm nightly that has merged placeholder support) ([#1877](https://github.com/can1357/oh-my-pi/issues/1877)).

## [15.9.1] - 2026-06-04

### Fixed

- Fixed the OSC 11 appearance poll re-querying every 2s forever on terminals that support Mode 2031 but never change theme, whose repeated OSC 11/DA1 writes cleared the user's active text selection (breaking copy every 2 seconds). The poll now stops as soon as DECRQM confirms Mode 2031 support, since push notifications make polling redundant.

## [15.9.0] - 2026-06-04

### Added

- Added Kitty `CSI 22 J` screen-to-scrollback clears for non-destructive full paints, while keeping ED3 for destructive history/session rebuilds.
- Added Kitty OSC 99 rich notification formatting and startup capability probing.
- Added Kitty OSC 66 text-sized Markdown H1 headings (2x scale) plus native text-width support for OSC 66 spans. Off by default and gated to Kitty (the only terminal implementing OSC 66) via the `TERMINAL.textSizing` capability; hosts enable it through `setTextSizing`.
- Added Kitty Unicode placeholder image rendering (`U=1` + U+10EEEE with explicit row/column diacritics): inline images are drawn as real text cells that carry the image id in their foreground color, so they survive horizontal slicing, reflow, and overlapping draws instead of relying on cursor-positioned `a=p` placements. Enabled by default on Kitty-family terminals; opt out with `PI_NO_KITTY_PLACEHOLDERS=1`, and falls back to direct placement when a grid exceeds the diacritic table's addressable range.
- Added Kitty temp-file image transmission (`t=t`): on local sessions, decoded PNG bytes are written to a `tty-graphics-protocol` temp file and the path is sent instead of in-band base64, gated behind a startup `a=q,t=t` support probe. Controlled by `PI_KITTY_IMAGE_TRANSMISSION=direct|temp-file|auto`; disabled over SSH unless explicitly forced.
- Added DECRQM capability detection for DEC private modes 2026 (synchronized output) and 2048 (in-band resize). Synchronized-output paint wrappers are dropped when the terminal reports 2026 unsupported (preserving the `PI_NO_SYNC_OUTPUT` override), and DEC 2048 in-band resize is enabled when supported — reported geometry and cell pixel size are updated from `CSI 48 ; rows ; cols ; yPx ; xPx t` reports, with SIGWINCH and `CSI 16 t` kept as fallbacks.
- Added an injectable render scheduler for TUI tests, allowing deterministic render drains without patching global clocks or event-loop timing.
- Added `ImageBudget`, an inline-image cap that keeps only the most recent N images as live terminal graphics and demotes older ones to their text fallback. Once a new image pushes the count past the cap, the renderer hides the oldest via a full redraw plus an explicit Kitty graphics purge (`a=d,d=I`) — text-clear escapes (`CSI 2 J`/`CSI 3 J`) do not remove Kitty images. Configure the cap via `TUI#setMaxInlineImages` (`0` disables it).
- Changed Kitty inline images to a transmit-once + placement scheme: the base64 data is sent a single time (`a=t`) keyed by a stable image id, then every repaint emits only the tiny placement (`a=p,i=…,p=…`). Repaints — including full redraws — no longer re-send image data or stack duplicate placements, and the diff/line buffers and render caches hold short placement strings instead of multi-KB base64. The `ImageBudget` doubles as the transmit store (it tracks which ids are loaded and re-transmits after a purge frees the data). iTerm2/Sixel, which have no addressable image store, keep sending inline data as before.
- Added a renderer-level DECCARA rectangular-SGR optimizer that paints solid background panels/rows (Box/Text/Markdown fills, status bars, any full-width `theme.bg` row) as a single coalesced rectangle escape (`CSI 2*x` / `CSI Pt;Pl;Pb;Pr;<sgr>$r` / `CSI *x`) instead of emitting a full-width run of background-styled spaces on every visible row. It operates at emit time on the final ANSI strings — components are unchanged — and strips only trailing padding it can prove sits under a single non-default background span, coalescing vertically adjacent identical fills into one rectangle and falling back to the original bytes whenever the rectangle would not save bytes. Enabled only on Kitty, which implements the SGR-background extension (`docs/deccara.rst`); **Ghostty is intentionally excluded** because its `CSI $r` is unimplemented (ghostty-org/ghostty#632) and would drop the background entirely. Scrollback-bound rows and the append/scroll paths always keep the padded representation so native history preserves colored cells, and the `PI_NO_DECCARA` kill switch (plus tmux/screen/zellij detection) forces the fallback.
- Added `CMUX_SURFACE_ID` environment variable support to `getTerminalId()`, so cmux terminal surfaces get a stable identifier alongside kitty, tmux, macOS Terminal.app, and Windows Terminal — enabling per-surface session breadcrumbs for `omp -c` in cmux.

### Changed

- Changed TUI tests to use Ghostty's VT engine (`ghostty-web`) instead of `@xterm/headless`.
- Changed the default inline-image live graphics budget from 3 to 8 images.

### Fixed

- Fixed the DECCARA background-fill optimizer rejecting or repainting the wrong cells when a trailing fill crossed from default-background spaces into colored spaces.
- Fixed DEC private-mode reports with DECRPM status 3/4 being treated as unsupported, so permanent 2026/2048 reports stay recognized.
- Fixed OSC 66 text-sizing width and slicing edge cases, including ZWJ emoji payloads and partial slices through scaled spans.
- Fixed focused `Input` components following `TUI#setShowHardwareCursor`, so single-line prompts render either the terminal cursor or software cursor consistently with the editor.
- Fixed the DECCARA background-fill optimizer painting fills on the wrong rows ("split into unaligned halves") in the differential repaint path. When a diff grew the transcript past the viewport, writing the rewritten rows scrolled the terminal, but the absolute DECCARA rectangle coordinates were derived from the pre-scroll viewport top, so every fill landed `scrollAmount` rows too low while the relatively-positioned text settled correctly; rows scrolled into history were also shortened, dropping their background padding from native scrollback. Rectangles now target the post-scroll rows and only rows remaining in the final viewport are optimized.
- Fixed native scrollback desynchronization after terminal width or height changes reflowed overflowing content while the viewport was not at the bottom
- Fixed a notification chip (or any injected block) rendering on top of an actively streaming tool render on ED3-risk terminals (Ghostty/kitty/Alacritty/iTerm2). While a foreground tool streams, its header's elapsed-time counter ticks every frame; once output scrolls the header above the viewport top, each tick is an offscreen edit that — because the eager scrollback-rebuild opt-in is gated off on these terminals — repaints the viewport in place and advances the rendered line count without committing the new overflow to native history. `#scrollbackHighWater` then lagged the logical viewport top, so a later content shrink whose changes landed in the visible region slipped past the shrink-across-boundary guard and reached the differential emitter, which is anchored to `#maxLinesRendered - height`: it rewrote only the suffix, dropped the newly exposed top row, and left a blank at the bottom, drifting every row below the edit one line up so it painted over the rows above. Such shrinks now re-anchor the bottom of the viewport with a non-destructive repaint, and the foreground-streaming shrink-across-boundary case repaints the live tail instead of padding and pinning the pre-shrink viewport.
- Fixed a terminal resize during foreground-tool streaming on an unknown-viewport / ED3-risk host (Ghostty/kitty/Alacritty/iTerm2/WSL) leaving native scrollback permanently out of sync, so scrolling back after the turn showed missing rows. A pure geometry resize (no content change) takes the in-place viewport-repaint path, which — unlike a content-bearing resize that rebuilds via the geometry branch — never flagged native history. Because the prompt-submit checkpoint (`refreshNativeScrollbackIfDirty`) only rebuilds when scrollback is marked dirty on these hosts, the discrepancy was never reconciled. Overflowing geometry repaints whose viewport is not known to be at the bottom now mark scrollback dirty so the next checkpoint rebuilds an exact copy of the transcript.

## [15.8.2] - 2026-06-03

### Added

- Added `PI_NO_SYNC_OUTPUT=1` to disable DEC 2026 synchronized-output wrappers for terminals whose implementation is buggy or visually worse, while keeping the renderer's autowrap guards active during paints ([#1765](https://github.com/can1357/oh-my-pi/issues/1765)).

### Fixed

- Fixed terminal resizes that land in the same render frame as streamed output splicing a phantom blank row into native scrollback and offsetting every later row by one. A height shrink (or width change carrying an append) with content overflowing the viewport fell through to the differential emitter, whose scroll math is anchored to the pre-resize viewport top and hardware-cursor row — both invalidated by the terminal's own resize reflow. Geometry-changed frames now rebuild native history when the viewport is at (or possibly at) the bottom, and defer non-destructively for a reader confirmed scrolled into history.
- Fixed Ghostty/kitty/Alacritty-style ED3-risk terminals freezing the prompt after a deferred shrink; focused keyboard input now uses the same explicit user-input viewport opt-in as autocomplete and can repaint immediately instead of waiting for a resize.
- Deferred eager live scrollback rebuilds under WSL fronted by Windows Terminal (`WT_SESSION` present in a Linux environment) so foreground streaming no longer emits ED3 (`CSI 3 J`) and yanks a reader scrolled into Windows Terminal's host scrollback; deferred rewrites still reconcile at the next prompt-submit checkpoint ([#1610](https://github.com/can1357/oh-my-pi/issues/1610)).
- Fixed tmux (and screen/zellij) pane history gaining a complete duplicate copy of the transcript every time a deferred offscreen edit was followed by another render. Multiplexer panes never receive a destructive scrollback clear, so the dirty-scrollback rebuild path only appended the full transcript on top of preserved pane history — repeatedly. Live frames inside multiplexers now keep repainting the viewport and leave history reconciliation to explicit checkpoints, which also removes the O(transcript) write amplification per frame.
- Fixed tmux pane viewports corrupting and pane history duplicating when a resize coincides with rendering: a resize racing a streamed append reached the stale-anchor diff emitters (phantom rows in the pane), a forced render racing a resize replayed the whole transcript into preserved pane history, and the prompt-submit checkpoint did the same after any deferred offscreen edit. Geometry-changed frames inside multiplexers now repaint the viewport in place, and forced-render geometry replays plus checkpoint replays are disabled there — tmux reflows its own pane grid and its history cannot be cleared, only duplicated.
- Fixed terminal resize events whose dimensions net out unchanged by render time (rapid SIGWINCH round trips during a window drag, coalesced into one 16ms frame) being invisible to the renderer. The terminal reflows its buffer on every resize event — rows move between the viewport and scrollback and can be evicted at the scrollback cap — so diffing against the pre-resize screen splices blank phantom rows into the viewport. The renderer now tracks the resize event itself, not just the dimension delta, and routes such frames through the geometry-change repaint/rebuild paths.
- Fixed Termux terminal resizes (screen rotation or software-keyboard toggles) displacing or hiding output after the viewport height changed. Content-bearing resizes were routed to the differential emitter, whose scroll math is anchored to the pre-resize viewport, so appended rows landed too low; pure height changes were treated as no-ops, exposing blank rows that later appends could fill without growing native scrollback. Termux resizes now repaint or rebuild at the new geometry like every other non-multiplexer terminal.
- Fixed the turn-end teardown frame freezing on ED3-risk terminals (Ghostty/kitty/Alacritty/iTerm2): disabling eager scrollback rebuild now takes effect only after the in-flight frame is classified, so the loader/status removal still paints instead of deferring and leaving a stale spinner until the next keystroke.
- Fixed non-WT ConPTY terminals on Windows (Tabby, Hyper, VS Code, conhost) clearing scrollback and yanking the viewport to the top whenever streaming output or a prompt-submit rebuild arrived while the user was scrolled up. The kernel32 viewport probe describes the ConPTY pseudo-console buffer — which is pinned to the visible grid, invisible to host-UI scrollback — so it reported "at bottom" no matter where the user had scrolled, and the [#1635](https://github.com/can1357/oh-my-pi/issues/1635) fix only distrusted it under `WT_SESSION`, which Tabby and other ConPTY hosts never set. The probe is now removed entirely: every Windows host is treated as viewport-unobservable, live mutations defer destructive rebuilds (no `\x1b[3J`, no viewport movement), and native scrollback reconciles at the prompt-submit checkpoint where the Enter keystroke has already pinned the host viewport to the bottom ([#1746](https://github.com/can1357/oh-my-pi/issues/1746)).
- Fixed emoji-presentation symbols (a default-text symbol followed by variation-selector-16 `U+FE0F`, e.g. `⚠️`, `ℹ️`, `❤️`, keycaps) measuring as 1 cell instead of 2 in the native width engine on macOS. The native scanner now keeps `UnicodeWidthStr` as the source of truth for multi-codepoint graphemes and applies only the local macOS Hangul Compatibility Jamo character-width delta, preserving VS16/keycap sequence widths without reintroducing jamo cursor drift.
- Deferred eager live scrollback rebuilds on macOS Terminal.app and iTerm2 so assistant/tool streaming no longer emits ED3 (`CSI 3 J`) while their native viewport position is unobservable, preserving readers scrolled into terminal history ([#1300](https://github.com/can1357/oh-my-pi/issues/1300)).
- Fixed width-shrink reflow leaving old-width rows in native history so later appends no longer undercount scrollback growth or duplicate wrapped content.
- Fixed hiding overlays after terminal reflow so stale dialog rows are scrubbed from native scrollback on non-multiplexer terminals.

### Removed

- Removed `shouldTrustNativeViewportProbe` and `ProcessTerminal`'s kernel32 `GetConsoleScreenBufferInfo` viewport probe. No Windows environment can answer "is the user's viewport at the bottom" truthfully — under ConPTY (every modern host) the pseudo-console buffer is pinned to the visible grid so the probe always read "at bottom", and under legacy conhost the window tracks the output cursor rather than the buffer tail so it always read "scrolled up" — so the probe and its trust gate are gone; `ProcessTerminal` no longer implements the optional `Terminal.isNativeViewportAtBottom`.

## [15.8.1] - 2026-06-02

### Fixed

- Deferred eager live scrollback rebuilds on VTE terminals so GNOME-style Linux terminals do not flash or erase readable scrollback during streaming ([#1719](https://github.com/can1357/oh-my-pi/issues/1719)).

## [15.8.0] - 2026-06-02

### Fixed

- Deferred eager live scrollback rebuilds on POSIX terminals where xterm ED3 (`CSI 3 J`, erase saved lines) can disturb scrolled-up readers during streaming, while keeping direct user-input and checkpoint rebuilds explicit ([#1682](https://github.com/can1357/oh-my-pi/issues/1682)).
- Fixed TUI shutdown placing the parent shell prompt one row below short rendered content instead of directly on the next line ([#1620](https://github.com/can1357/oh-my-pi/issues/1620)).
- Stopped painting inline color swatches for 4-digit hex runs in Markdown rendering. The `#RGBA` CSS form collides with hashline `#TAG` snapshot tags (4 hex digits, e.g. `#6C5E`), which were sprouting spurious RGB swatches in prose and codespans. Only `#RGB`, `#RRGGBB`, and `#RRGGBBAA` qualify now.

Older entries are archived in [packages/tui/CHANGELOG.md@3deb6751027b](https://github.com/can1357/oh-my-pi/blob/3deb6751027b11b10ac14b2a5c07303817276505/packages/tui/CHANGELOG.md).
