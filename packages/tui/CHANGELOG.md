# Changelog

## [Unreleased]

### Added

- Added Vim `W`, `B`, and `E` motions for navigating whitespace-delimited WORDs ([#13099](https://github.com/can1357/oh-my-pi/pull/13099) by [@Scott-Simmons](https://github.com/Scott-Simmons)).
- Added Vim `s`/`S` (substitute characters / lines, Visual `S` changes whole lines) and the linewise line motions `-`, `+`, and `_` ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added Vim redo (`Ctrl+R`) and counted undo (`3u`); undo and redo return the cursor to where the change began, as in Vim ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added Vim registers: named `"a`–`"z` (uppercase appends), `"0` for yanks, `"1`–`"9` and `"-` for deletes, and the `"_` black hole ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added Vim `X`, `Y`, `~`, the case operators `g~`/`gu`/`gU` (with `g~~`/`guu`/`gUU`), `gJ`, `ge`/`gE`, `gp`/`gP`, `gv`, and `gi` ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added Vim counted inserts (`3ix`, `2ofoo`), Visual `p`/`P`/`r`/`u`/`U`/`~`, and Visual `X`/`D`/`Y`/`C`/`R` on whole lines ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added Vim `gj`/`gk` to move by screen row through wrapped lines ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added `Editor.onHistorySearch`, which Vim's Normal-mode `/` and `?` call so the host can open its prompt-history search ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added Vim `:` in Normal mode on an empty prompt: it types `/` in Insert mode, so the slash-command menu opens ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added Vim `"+p`/`"*p` to put the system clipboard; `Editor.onYank` now also gets the register name ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added `vimMode` and `configureEditor` options to `HtmlFormDialog` and `HookEditorComponent`: with `vimMode` their text boxes are Vim-mode editors (a form's one-line fields and "Other" answers too; passwords stay plain), `j`/`k` step between a form's option rows, and `Escape` leaves Insert mode before it closes or cancels anything ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added `Editor.vimStartMode` and `Editor.resetVimMode()`: each prompt (on enabling Vim mode, after a submit, on reset) starts in the start mode; Normal-mode `k`/`j`/`-`/`+` past the first or last line step through prompt history ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added `Editor.captureHistoryState()`, which hosts override so a remembered draft (and Vim's `k`/`j` history steps) brings back the attachments they keep beside the text; `CustomEditor` implements it ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))

### Changed

- `Editor` re-announces its Vim mode through `onVimModeChange` when it gains focus, so a host's cursor shape follows the editor holding the keys ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- The `vim` status-line segment shows a pending command even with `display: "none"`, which now hides only the mode ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))

### Fixed

- Fixed the footer on spilled bash output naming the bare `local://N.log`: it now names `local://N.log:raw`, the selector that reads the original output ([#18764](https://github.com/can1357/oh-my-pi/issues/18764), [#19964](https://github.com/can1357/oh-my-pi/pull/19964) by [@JamieJ5926](https://github.com/JamieJ5926))
- Fixed Tern Plan Review annotations being dropped before they reached omp, so saved comments now enable Refine ([#20250](https://github.com/can1357/oh-my-pi/pull/20250) by [@ash-miku](https://github.com/ash-miku))
- Fixed Ctrl+[ not leaving Vim Insert, Replace or Visual mode, or cancelling a pending operator, under the Kitty keyboard protocol or modifyOtherKeys; inside the Vim modes it now does what Escape does ([#19547](https://github.com/can1357/oh-my-pi/issues/19547), [#20209](https://github.com/can1357/oh-my-pi/pull/20209) by [@JamieJ5926](https://github.com/JamieJ5926))
- Truncated `ast_grep` results show the exact next offset (`use skip=N for the next page`) in the result view and the native view; results recorded without it keep the generic hint ([#20203](https://github.com/can1357/oh-my-pi/pull/20203) by [@MikeeI](https://github.com/MikeeI))
- Fixed the dot between extension statuses in the status bar drawing in the accent colour instead of the dim separator colour ([#15740](https://github.com/can1357/oh-my-pi/issues/15740), [#20218](https://github.com/can1357/oh-my-pi/pull/20218) by [@JamieJ5926](https://github.com/JamieJ5926))
- Fixed the cursor drifting left while typing Korean in Paradev terminals ([#20246](https://github.com/can1357/oh-my-pi/pull/20246) by [@HuitaePark](https://github.com/HuitaePark))
- Fixed the TUI in a Herdr desktop terminal staying at the smaller size Herdr reported for a peek, drawing in the top part of the pane over stale rows until the window was resized ([#20222](https://github.com/can1357/oh-my-pi/pull/20222) by [@bbelchak](https://github.com/bbelchak))
- Zellij's own dark or light report now sets the detected appearance, so a light Zellij theme over a dark host background is no longer detected as dark ([#20132](https://github.com/can1357/oh-my-pi/issues/20132), [#20207](https://github.com/can1357/oh-my-pi/pull/20207) by [@JamieJ5926](https://github.com/JamieJ5926)).
- Fixed Ctrl+V doing nothing in an `ask` form's text inputs, textareas, and Other answers. Clipboard images still require an open option note ([#20217](https://github.com/can1357/oh-my-pi/pull/20217) by [@SuperUserA](https://github.com/SuperUserA))
- `repairTaskParams()` now promotes a JSON-string `tasks` payload to an array and repairs item prose, so a string-encoded batch call reaches validation intact ([#20190](https://github.com/can1357/oh-my-pi/pull/20190) by [@arfoux](https://github.com/arfoux))
- Fixed Vim `.` not retyping the inserted text when the keys arrived in one burst (e.g. `ccfoo` typed quickly) ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Fixed Vim `w`, `b`, and `e` stopping at the end of the line; they now cross lines like Vim's, and `dw`, `d}`, and `2D` follow Vim's rules for multi-line and end-of-line spans ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Fixed Vim `gg`, `G`, `dd`, and linewise puts landing in column 0 instead of the first non-blank; `dk` on the first line no longer deletes it; `D`/`C` no longer leave `j`/`k` stuck at line end ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Fixed Vim `v$` not selecting through the line break and `g`-commands (`gg`, `gU`) doing nothing in Visual mode ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Fixed Vim `cc`, `cj`, and other linewise changes keeping the start of the line when the cursor was mid-line, and storing the old text so `p` spliced it into a line instead of putting it back as whole lines ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Fixed Vim `di(`, `ci{`, and other bracket objects doing nothing when the cursor is before the brackets; like Vim 9.2 they now use the next pair ahead ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))

### Removed

- Removed `MCPProgress` and `parseMCPProgress` from `@oh-my-pi/pi-tui/tools/mcp`; they are exported from `@oh-my-pi/pi-tui/tools/mcp-progress` ([#20224](https://github.com/can1357/oh-my-pi/pull/20224) by [@JustasMasiulis](https://github.com/JustasMasiulis))

## [19.1.1] - 2026-11-23

### Added

- Added host-provided runtime choices for settings menus through `SettingsRuntimeContext.runtimeOptions`, while preserving built-in choices for thinking levels, themes, and composer shapes.
- Added interrupt metadata so hosts can distinguish a parent-agent termination from a user-initiated interrupt.

### Fixed

- Fixed handoffs being skipped when only the model’s upstream pin changes.
- Fixed the `/usage` activity calendar retaining its history when a refresh fails, while indicating that the data is not synced.
- Fixed SVG images blinking in ask forms when questions extend beyond the panel.
- Fixed the active-turn status line so elapsed time updates smoothly at tenths of a second.
- Fixed assigning a model to a role when pressing Enter again on the selected model, which could incorrectly remove the role.
- Updated the quick model picker (`Alt+P`) to include models added to the catalog after a session began, even when the session is restricted by `--models` or `enabledModels`.
- Fixed images and other path-based files appearing as unavailable in Tern when the TUI and Tern run on different machines or in local sessions without Tern’s shared file directory.

### Removed

- Removed `OmfgPanelComponent.markSaved` and the `saved` panel state; the `/omfg` panel now closes after a rule is saved.

## [19.1.0] - 2026-11-21

### Breaking Changes

- Retired the `ComposerPreferences.completeScrollback`, `TranscriptContainer.completeScrollback`, and `Composer.setRunActive` APIs, along with the `transientChrome`, `selfClearingChrome`, and `billedChrome` options of `Composer.setRuntimeChildren`. Retirement now consistently uses the height left by on-screen chrome.
- Moved `convertImageToPng`, `convertImageToPngShared`, `cachedPngConversion`, and `imagePayloadKey` from `@oh-my-pi/pi-tui/chat/image-loading` to `@oh-my-pi/pi-tui/png-conversion`.
- Replaced `OutputSinkOptions.artifactPath` and `artifactId` with the `allocateArtifact` (`ArtifactAllocator`) callback, which allocates an artifact only when output first exceeds its inline view.
- Removed the `windows-altgr` module; Windows AltGr recovery is now provided by `translateWindowsAltGrSequence` in `@oh-my-pi/pi-natives`.

### Added

- The editor now displays described changes for `magic` mode as Markdown in the transcript while it waits for the apply model to return final diffs.
- The UI now responds to terminal `features` events without waiting for a new hello message.

### Changed

- Tool commands run inside a bash call render as nested tool cards in the bash card
- Tool activity and job titles show the brief label of a structured intent; the Spotlight inspector still exposes the full request.
- Improved transcript layout around docked reports, waiting asks, completion lists, dialogs, todo lists, subagent panels, queued messages, and other lower-screen chrome so visible content and reclaimed rows behave more predictably.
- Native chat and web search cards now present tool results and sources more clearly, including expandable page excerpts, multi-line titles, and a unified sources grid.
- Windows console VT input and AltGr handling now use the native terminal integration.
- Background jobs and running Bash commands now provide live, step-specific output for pipelines, redirects, and command stages, with controls to switch streams or follow the live output. Job cards also show the active command step and more compact metadata.
- Bash command footers now use a compact, icon-based layout for timing, exit status, job and process details, artifacts, and minimizers.

### Fixed

- Fixed the TUI freezing at 100% CPU while streaming text that begins with a blank line followed by a line containing `|`.
- Fixed the TUI freezing when charting a table whose numbers overflow (`1e400`, a `p999…` header with hundreds of digits, a `1e-300 → 1e300` change) or sit above 2^53 and differ only slightly.
- Fixed the editor freezing when a vim count is typed with hundreds of digits; counts now cap at 99,999.
- Fixed Windows input mode freezing on a key record with an impossibly large repeat count.
- Fixed backward character jump (`Ctrl+Alt+]`) at the start of a line finding the cursor's own character instead of searching earlier lines.
- Fixed light-theme detection inside Zellij when the terminal reports a light background.
- Preserved custom foreground colors and text styles in status-line segments while continuing to apply the accent color to unstyled statuses.
- Fixed transcript rows and tool cards disappearing or appearing truncated when overlays and panels were open.
- Fixed cursor flicker in kitty terminals during spinner updates.
- Preserved background colors on truncated rows while scrolling.
- Fixed WebP and JPEG images rendering as blank gaps on Kitty graphics-compatible terminals when displayed through a bare `Image`.
- Improved terminal output handling so large repaints remain row-safe and slow or unavailable terminal writers no longer freeze input.
- Preserved prefilled or hidden `__proto__` controls when ask HTML forms time out.
- A single-question ask form now submits on the first Enter press.
- Improved native-terminal ask forms so answering long questions no longer causes the entire card to resize and stall on every movement.

## [19.0.1] - 2026-11-19

### Added

- The native session sheet shows a `Local` report line (the session's `local://` directory) as a copyable field beside the ID and file ([#19778](https://github.com/can1357/oh-my-pi/pull/19778) by [@farnoy](https://github.com/farnoy))

### Fixed

- Fixed images from a previous session reappearing at the top-left of the screen after `/new` in herdr-app ([#19749](https://github.com/can1357/oh-my-pi/pull/19749) by [@jaredlyon](https://github.com/jaredlyon))
- Loop-stall diagnostics (`ui.loop-blocked`) no longer sample the JS thread while no TUI runs, such as in an external editor or after the session ends ([#19703](https://github.com/can1357/oh-my-pi/pull/19703) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the usage dashboard rendering exhausted or pressured usage rows without a quota bar (prepaid balances, spent quotas) as dim informational text; they now take the error or warning color their reported status calls for, and a spent quota with no measurable amount reads "exhausted" instead of "no data" ([#19764](https://github.com/can1357/oh-my-pi/issues/19764))

## [19.0.0] - 2026-11-18

### Breaking Changes

- Full-output references and the `[raw output: …]` footer now use `local://N.log` instead of `artifact://N`.

### Added

- Added the `btw` composer mode, including the `btwMode` theme color in all bundled themes.
- Added feature-gated native docking for runtime children, allowing components to appear only on terminals that advertise the required capability.
- Added options to preserve intraword underscores when stripping inline Markdown and to open `JobsSheet` on a selected job.
- Custom message payloads can now be excluded from model context while remaining available in normalized and restored saved entries.
- Added transcript blocks for output reported by running background jobs and services.

### Changed

- Reworked ask dialogs into a single stacked flow: the active question stays open while answered questions fold into compact summaries with their selected options visible. This applies across terminal and native interfaces and improves keyboard navigation, sizing, and host composer integration.
- Improved composer behavior while an ask dialog is pending: the composer indicates that typing there will skip the question, folds to a compact state when appropriate, and offers an explicit Skip & send action for drafts that bypass the ask.
- Added support for folded and faint composer states and clearer visual indication when the interface is awaiting an answer.
- Model search now supports `provider/model` queries, prioritizing exact provider matches and searching that provider's model IDs first.

### Fixed

- Improved background-job notices in Tern by grouping all output under one header and showing the complete lines.
- Fixed Tern composer handling of `->` and `=>` so typing them no longer unexpectedly inserts a line break.
- Fixed web search results without a synthesized answer to show each source once with a concise cleaned excerpt.
- Fixed long Tern tool-approval prompts so their details scroll within the available window and the choices and Approve/Deny controls remain visible.
- Fixed table chart unit display and change-factor calculations for measurements with scaled units.
- Fixed checkbox groups so pressing Enter with nothing selected first checks the focused box.
- Ask forms now open each question with its preselected answer, allowing Enter to accept the recommendation without replacing it.

## [18.22.2] - 2026-11-18

### Added

- `ui.loop-blocked` log records now name what held the event loop (`cause`, `causeShare`, `top`), sampled by an always-on profiler; `PI_LOOP_SAMPLER=0` turns it off

### Changed

- On Windows, terminal output is written off the JS thread, so input and rendering stay responsive while the console drains a large repaint

### Fixed

- On Windows, omp no longer freezes when the terminal stops reading its output (a hung Windows Terminal, a paused ssh client); it keeps running and catches up once the terminal reads again

## [18.22.1] - 2026-11-17

### Added

- Task tool and agent hub rows now use distinct, theme-aware colours for the main agent and subagents; themes can optionally customize the six subagent colours.
- Added word wrapping for table columns and rows, preserving hard line breaks so long table content remains readable.

### Changed

- Improved terminal UI responsiveness and reduced CPU usage while streaming long responses, monitoring the event loop, and typing with macOS spell checking enabled.
- Status account identities can now include an optional credential ID, allowing usage to be attributed to API-key accounts and cached usage to refresh when the credential changes.

### Fixed

- Images in Ask forms now render correctly in Kitty-protocol terminals, including Kitty, Ghostty, and herdr.
- Fixed model mentions followed by punctuation so they become editable chips without consuming the punctuation.
- Fixed /copy to copy the visible prose from mid-turn out:// replies, including replies sent by commands, instead of the tool's internal result text.

## [18.22.0] - 2026-11-16

### Breaking Changes

- Terminals that support output backpressure must now implement onOutputDrain(callback), which returns an unsubscribe function; terminals without backpressure can omit both pendingOutputBytes and onOutputDrain.
- Updated PlanReviewOverlay options to use PlanReviewOverlayChoice objects and report choice IDs to onPick and selectOption. Refine and Save actions now reflect plan feedback and saving behavior; removed disabledIndices and externalEditorName, and updated describe to receive DescribeContext.

### Added

- Added configurable model search placement, provider scopes, and an optional thinking-level slider to ModelPickerComponent; selected thinking levels are reported through onPick metadata. The native picker sheet now supports anchoring, scope styling, level display, and icon actions.
- Added a native plan review document and dock with editable and commentable plans, quote annotations, plan-edit notifications, Approve, Save, and Cancel actions, plus model selection.

### Changed

- Provider scopes now show only the selected provider's models when a provider is chosen, with scope cycling able to return to the full model list.
- Updated thinking-level controls to use left and right arrow keys, and refreshed the slider and footer hint presentation.
- Retitled the plan-saving overlay to “Save plan” and updated its action label.

### Fixed

- Fixed slow scrolling and typing in long agent transcripts.
- Fixed slow typing and cursor movement in drafts longer than 256 lines.

## [18.21.0] - 2026-11-16

### Added

- Added support for pasting images into `HtmlFormDialog` option notes when opened with `acceptImages`, including image attachment, removal, and access to retained images through `OptionNote.images`.
- Added live web-page and image rendering in assistant replies for supported terminals, including inline images and embedded page previews. Added the `/btw` transcript note for sharing side topics without interrupting the main conversation.

### Changed

- Improved reasoning-capability discovery so models awaiting discovery follow the session's thinking default and offer automatic thinking in addition to disabled and effort-level settings.
- Renamed the public `html-form/media` APIs to `media`, including `loadMedia`, `Media`, and `MAX_MEDIA_BYTES`.

### Fixed

- Fixed fallback model selection so roles are offered only models they can use, excluding incompatible image and speech models.
- Fixed macOS spelling assistance, autocorrect, replacements, and word completion for shell (`!`) and Python (`$`) drafts.

## [18.20.1] - 2026-11-14

### Added

- Added task counts to the Todo status line when work is assigned to multiple targets.
- Preserved pasted images when copying Composer drafts in Tern.
- Added the ability to delete the selected prompt from history by pressing Delete at the end of the Ctrl+R search field.
- Added distinct theming for Markdown links using registered extension schemes, with a muted fallback for themes that do not define the new color.
- Improved compound Bash command approval dialogs by distinguishing allowed and approval-required segments and opening at the first segment requiring approval.
- Added an optional Branch action to chat, including the `b` shortcut in the BTW history sheet.

### Fixed

- Fixed asynchronous Bash commands switching from the interpreted shell view to the raw command line.
- Improved transcript rendering when switching to a subagent, resuming a session, or rebuilding a long transcript so the newest messages appear immediately.
- Fixed Markdown task lists displaying the wrong checkbox state for completed and open items.
- Fixed iTerm2 inserting terminal resize data into the composer when reporting in-band resizes.
- Improved working-row animation while waiting for tools or models on terminals without synchronized output, including tmux 3.6.
- Fixed expanded IRC tool cards to show complete soft-wrapped output and added an expand hint to collapsed cards containing hidden text.
- Fixed premature scrolling in the `/resume` session picker when navigating near the middle of the list.

## [18.20.0] - 2026-11-12

### Added

- The Spotlight sheet of a `;`/`,` path `read` shows each part as its own section, numbered from its file's lines with its own ranking ([#18713](https://github.com/can1357/oh-my-pi/pull/18713) by [@eggpeat](https://github.com/eggpeat))

### Fixed

- Fixed `grep` tool results in ANSI and native Tern views to show a `binary matches` warning on both zero-match and matching searches ([#18988](https://github.com/can1357/oh-my-pi/pull/18988) by [@alphastorm](https://github.com/alphastorm))
- The `/resume` picker deletes sessions through the `app.session.delete` action (default Backspace or Delete) and shows its keys in the hints, so `keybindings.yml` can replace the shortcut, for example with Ctrl+D, or disable it with `[]`; a bound key that also deletes backward, such as Backspace or Ctrl+W, still edits a typed search query ([#17938](https://github.com/can1357/oh-my-pi/issues/17938), [#18961](https://github.com/can1357/oh-my-pi/pull/18961) by [@wolfiesch](https://github.com/wolfiesch))
- Typing `/job` lists the `jobs` command first again instead of jumping whole-hyphen-segment skill matches like `skill:…-job-…` above it: inner-segment skill hits now tie (rather than outrank) command-prefix matches, so the tie keeps the popup command-first ([#18891](https://github.com/can1357/oh-my-pi/issues/18891), [#18916](https://github.com/can1357/oh-my-pi/pull/18916) by [@yuzu-octopus](https://github.com/yuzu-octopus))

## [18.19.0] - 2026-11-12

### Added

- GitHub Actions watch cards now show current-step progress and can be expanded with Ctrl+O to display ordered step states and durations in ANSI and native Tern views.

### Fixed

- Fixed comparison charts mislabeling gaps against a rival column as improvements or regressions.
- Fixed Tern edit diffs showing unrelated one-line hunks and incorrect line numbers around distant changes.
- Fixed table charts incorrectly interpreting words such as “with,” “to,” and “from” in column names as comparison conditions.
- Fixed chart row names containing trailing numbers, such as “EmbeddingGemma 2” and “Jev 15,” being split or incorrectly nested.
- Fixed `read` rejecting colon-separated line ranges and displaying a single requested range as multiple rows.

### Removed

- Removed the `blocked` status from `TodoStatus`, the `blocker` field from `TodoItem`, and the `block`/`unblock` operations from `TodoOperation`.

## [18.18.9] - 2026-11-11

### Added

- Added the Sofya label for `sofya` web search results ([#18185](https://github.com/can1357/oh-my-pi/pull/18185) by [@yusufgurdogan](https://github.com/yusufgurdogan))
- The context breakdown counts instruction files and skills from the system prompt as built, matching `/context`, and lists Instruction files as its own category ([#17971](https://github.com/can1357/oh-my-pi/pull/17971) by [@c-w-z](https://github.com/c-w-z))
- Context Viewer adds an Instruction Files category and opens Skills like any other category; `ContextViewEntry.sourceMarkers` colors viewer-only source markers by category in previews and full content, and `ContextViewData.notices` lists snapshot caveats under the Overview legend ([#17971](https://github.com/can1357/oh-my-pi/pull/17971) by [@c-w-z](https://github.com/c-w-z))

### Fixed

- In Tern, an `ask` question outside a `<fieldset>` gets its own tab instead of sharing the tab of the question before it ([#18660](https://github.com/can1357/oh-my-pi/pull/18660) by [@DocksDocks](https://github.com/DocksDocks))
- The `/resume` picker shows dates of sessions older than a week in the locale from `LC_ALL`, `LC_TIME` or `LANG` instead of always using `MM/DD/YYYY` ([#18863](https://github.com/can1357/oh-my-pi/pull/18863) by [@raoulkent](https://github.com/raoulkent))
- Fixed an `ask` HTML form in Tern not taking typing after a click on its Other row or a text well while a composer draft held the keyboard: the click now hands the keys to the form, as ↑/↓ does, instead of every key still editing the draft
- Agent Hub status scopes (All, Running, Done, Parked) show icons in Tern instead of empty squares ([#18880](https://github.com/can1357/oh-my-pi/pull/18880) by [@a-glapinski](https://github.com/a-glapinski))
- Fixed streaming tables that overflow the screen staying squeezed to their header's column widths after the rows arrive ([#18909](https://github.com/can1357/oh-my-pi/pull/18909) by [@JustasMasiulis](https://github.com/JustasMasiulis))

### Removed

- Removed `estimateSkillsTokens()` and the `skillful` context-usage option; Skills tokens come from the built prompt's sources ([#17971](https://github.com/can1357/oh-my-pi/pull/17971) by [@c-w-z](https://github.com/c-w-z))

## [18.18.8] - 2026-11-11

- The live transcript reuses its per-block walk list across each frame's readers instead of rebuilding it three times per frame, so settled transcripts cost fewer short-lived allocations per frame ([#18705](https://github.com/can1357/oh-my-pi/pull/18705) by [@yuzu-octopus](https://github.com/yuzu-octopus))

### Changed

- Ask forms support notes on options: `n` on radio/checkbox rows and `Alt+n` on select menus (`app.ask.note`), with selected notes shown alongside submitted answers and notes on unchosen options marked as drafts ([#18779](https://github.com/can1357/oh-my-pi/pull/18779) by [@Shadorain](https://github.com/Shadorain))

### Fixed

- Ask form textareas edited from Tern now restart the inactivity timeout instead of submitting mid-edit
- Fixed a picture in an `ask` form staying painted on screen after the form closed ([#18693](https://github.com/can1357/oh-my-pi/pull/18693) by [@jaredlyon](https://github.com/jaredlyon))
- Fixed terminal Device Attributes replies (such as `^[[?64;1;2;4;6;17;18;21;22c`) leaking into the shell prompt on exit ([#18662](https://github.com/can1357/oh-my-pi/pull/18662) by [@asuffield](https://github.com/asuffield))

## [18.18.7] - 2026-11-10

### Changed

- `grep` and `ast_grep` results with no matches render as one line with `0 matches` in the warning color, dropping the separate `No matches found` row ([#18700](https://github.com/can1357/oh-my-pi/pull/18700) by [@JustasMasiulis](https://github.com/JustasMasiulis))

### Fixed

- Saved-reset messages name the Claude Fable weekly limit as "Claude Fable weekly" instead of its raw id ([#18661](https://github.com/can1357/oh-my-pi/pull/18661) by [@TheAifam5](https://github.com/TheAifam5))

## [18.18.6] - 2026-11-09

### Added

- The `wait` result's `JobSnapshot` now carries `settledAtMs` (epoch ms when the run settled, absent while it is still running), so a snapshot can tell a result that finished during the call from one recovered from an earlier, never-delivered completion ([#18635](https://github.com/can1357/oh-my-pi/pull/18635) by [@yuzu-octopus](https://github.com/yuzu-octopus))
- Added a `thinking.set` composer action so Tern's phone effort menu can pick a thinking level in one tap
- Added All, Running, Done and Parked status scopes with counts to the agent hub's roster, so Tern's phone can filter agents by status
- A prompt and a turn's answer list their actions for a phone's long press (`actions.hold`): Copy, Edit & resend (a prompt's), Retry turn, Rewind to here… and Fork from here; the desktop keeps its hover toolbars
- A click or tap on a turn on the native rewind page picks it, and the rewind selector can open on a given turn (`startAt`)
- A status notice can carry a button on its native toast (`StatusNoticeAction`), such as the Undo after a rewind

### Fixed

- Fixed streamed rows being clipped above the screen before they reached scrollback while the working row was up, so a scrolled-back terminal saw rows jump at the screen's top edge and the whole screen dropped when a run ended ([#12307](https://github.com/can1357/oh-my-pi/issues/12307), [#16117](https://github.com/can1357/oh-my-pi/pull/16117) by [@galtamam-cmyk](https://github.com/galtamam-cmyk)). `Composer.setRuntimeChildren` takes a `billedChrome` option for roots billed at their current height instead of through the floor.
- Fixed rows of a streaming reply, and the top rows of a table taller than the screen, going missing from both the screen and scrollback with `tui.completeScrollback` on; such a table now keeps the column widths it had when it outgrew the screen ([#16355](https://github.com/can1357/oh-my-pi/pull/16355) by [@galtamam-cmyk](https://github.com/galtamam-cmyk))

## [18.18.4] - 2026-11-09

### Added

- `ask` HTML forms with two or more `<fieldset>`s show one tab per question plus a Review tab in Tern; Next moves on, ←/→ and PgUp/PgDn switch tabs, and Submit lives on Review ([#18608](https://github.com/can1357/oh-my-pi/pull/18608) by [@Gabriel-Hiss](https://github.com/Gabriel-Hiss))
- `ask` HTML forms hide to one row with `app.ask.hide` (`Alt+H`) or the Hide button, as the ask dialog does ([#18608](https://github.com/can1357/oh-my-pi/pull/18608) by [@Gabriel-Hiss](https://github.com/Gabriel-Hiss))

### Fixed

- Prefilled single-line `ask` fields now open at the start of their value instead of scrolling to the end when focused ([#18585](https://github.com/can1357/oh-my-pi/issues/18585)).
- Fixed the `│` rails of a wrapped box-drawing tree line (`├── **label**: …`) taking the color and weight of the node's leading bold, italic or code span under colorful Markdown; continuation rails now match the first row's rails and the node text keeps its own styling ([#18584](https://github.com/can1357/oh-my-pi/pull/18584) by [@chan1103](https://github.com/chan1103))
- Fixed relayed Windows terminal events after an event-loop stall so they neither abort the running turn nor type TSP data into the composer ([#18512](https://github.com/can1357/oh-my-pi/issues/18512)).
- Fixed transcript rows a few turns above the composer disappearing from the screen and from scrollback, at a place that moved with every resize, while a todo list or subagent panel stayed up after a turn ([#18510](https://github.com/can1357/oh-my-pi/pull/18510) by [@mccraigmccraig](https://github.com/mccraigmccraig))
- Fixed `xd://<device>:raw` and `xd://<device>:conflicts` resolving as that device. Those suffixes stay in the name, so the read or write no longer runs the device ([#18561](https://github.com/can1357/oh-my-pi/pull/18561) by [@wisehead](https://github.com/wisehead))
- Fixed `ask` HTML forms taller than the composer area being cut off and unscrollable in Tern: the form now scrolls in the composer's place, and Cancel/Submit stay visible
- Fixed the Agent Hub in Tern freezing itself and the session behind it once hundreds of agents are listed: moving the selection no longer re-sends every roster row, and live roster updates on large hubs are batched (up to once a second) so the terminal keeps up

## [18.18.3] - 2026-11-09

### Breaking Changes

- The `ask` tool renderer now draws `{ html }` form calls and `AskToolDetails { answers, timedOut }` results; `QuestionResult` and the question-list detail fields were removed.

### Added

- Added a Note entry to the right-click menu of each ask dialog answer row in Tern, annotating that answer without picking it ([#18551](https://github.com/can1357/oh-my-pi/pull/18551) by [@H4vC](https://github.com/H4vC))
- Added `HtmlFormDialog`, which renders an HTML form as an interactive terminal form, splits long forms into pages, and returns the answers as JSON. Single `<select>`s are one-row dropdowns, radio and checkbox groups get a free-text "Other" answer, `<img>` (URL, `data:` URI or local file) and inline `<svg>` pictures load in the background, an optional inactivity timeout submits the current values, and Tern terminals get the form natively.
- Added a `cursor: "start"` option to `Editor.setText` so prefilled multi-line text opens at its first line.

### Changed

- The ask dialog's Note right after a pointer click now annotates the highlighted answer of the question shown instead of the answer just clicked, and the Note button no longer names a redirect target ([#18551](https://github.com/can1357/oh-my-pi/pull/18551) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed the ask dialog's `n` right after a keyboard pick annotating the previous question's answer instead of the highlighted row shown; only a pointer click still redirects Note to the answer just picked, and the Note button then names it ([#18317](https://github.com/can1357/oh-my-pi/pull/18317) by [@DonMikone](https://github.com/DonMikone))

## [18.18.2] - 2026-11-08

### Added

- Added a model catalog refresh callback that lets applications update the active model scope after catalogs are re-fetched.
- Preserved unfinished answers in ask dialogs and custom editors, allowing users to resume drafts when reopening them.

### Changed

- Simplified Bash previews for redirection to /dev/null by showing a single icon in the Nerd Font symbol preset.

### Fixed

- Fixed streaming and scrolling display issues in terminals without synchronized output, including duplicated rows and blank screens or status lines.
- Fixed Markdown rendering while streaming list items, preserving bold text and heading formatting.
- Fixed wrapping of long embedded Bash arguments so indentation and the gutter remain aligned.
- Fixed prompts and Enter presses entered while the application was starting so they submit normally instead of leaving Enter as a newline.
- Fixed restored transcripts so aliased tool calls use the same rendering as live tool calls.
- Fixed debugger tool cards with tabs and control characters in arguments so their displayed width remains accurate.
- Fixed LaTeX styling in nested content, including bold and italic resets, radical and optional-argument styling, color scoping, and inline math in headings.
- Fixed unnecessary repainting in the setup wizard while waiting for input in ANSI terminals.
- Fixed Windows ConPTY event handling so delayed terminal event data no longer appears in the composer.
- Fixed OSC 8 hyperlink support in Rex terminals so transcript URLs and file paths are command-clickable.

## [18.18.1] - 2026-11-08

### Added

- Grep headers syntax-highlight regex patterns, including incomplete patterns while a call streams, in terminal and native views ([#18392](https://github.com/can1357/oh-my-pi/pull/18392) by [@JustasMasiulis](https://github.com/JustasMasiulis)).

### Changed

- Grep results for a single searched file no longer repeat `1 file` after the match count; the header already names the file ([#18422](https://github.com/can1357/oh-my-pi/pull/18422) by [@JustasMasiulis](https://github.com/JustasMasiulis)).

### Fixed

- Pinned sessions color their pin icon with the theme accent in the status line instead of the session title's color, matching the resume picker ([#18401](https://github.com/can1357/oh-my-pi/pull/18401) by [@SuperUserA](https://github.com/SuperUserA))
- A saved bash trace the shell visualization can no longer restore (e.g. a `tool_result` hook rewrote its `script`) renders as plain command and output instead of crashing the TUI and every `omp --resume` of that session ([#18338](https://github.com/can1357/oh-my-pi/issues/18338))
- Tables with near-equal large numeric columns no longer crash transcript rendering during chart analysis ([#18343](https://github.com/can1357/oh-my-pi/issues/18343))
- A JPEG truncated before its end-of-image marker is rejected when read and omitted from the request, instead of failing the whole provider request with "unsupported image" ([#18385](https://github.com/can1357/oh-my-pi/pull/18385) by [@iwangjie](https://github.com/iwangjie))
- Desktop notifications use unique OSC 99 ids per omp process to avoid interfering with other omp processes ([#18413](https://github.com/can1357/oh-my-pi/pull/18413) by [@farnoy](https://github.com/farnoy))
- `updateNotesToolRenderer` now renders `update_notes` calls that omit `body` ([#18439](https://github.com/can1357/oh-my-pi/pull/18439) by [@eggpeat](https://github.com/eggpeat))
- The copy overlay now offers fenced code blocks indented under list items, and splits code and quote blocks the same way the message renderer draws them ([#18410](https://github.com/can1357/oh-my-pi/pull/18410) by [@farnoy](https://github.com/farnoy))

## [18.18.0] - 2026-11-07

### Fixed

- Ctrl+J from a win32-input-mode record with `VK_J` and `Uc=LF` now decodes as `ctrl+j`, so Windows Terminal / mini-term insert a newline instead of submitting ([#18253](https://github.com/can1357/oh-my-pi/pull/18253) by [@Clannad47](https://github.com/Clannad47))
- The BTW history page (`f` on a side answer) scrolls its reader and history list with the mouse wheel, matching the other scrolling sheets ([#18303](https://github.com/can1357/oh-my-pi/pull/18303) by [@ImAlexBlock](https://github.com/ImAlexBlock))
- The BTW history list shows the date for questions asked before today (and the year for ones from an earlier year), instead of a bare time that read as today's; a follow-up asked on a later day than its topic shows its date too ([#18210](https://github.com/can1357/oh-my-pi/pull/18210) by [@a-glapinski](https://github.com/a-glapinski))

## [18.17.0] - 2026-11-06

### Breaking Changes

- `MarkdownTheme.heading` receives the heading depth (1–6) as a second argument; callers must pass it.
- Shell visualization uses the native presentation engine: shell node IDs are opaque strings, and native shell nodes receive presentation data, not raw execution traces.
- Replaced `CustomEditor.modelMentionLabel` with `resolveModelMention` (returns `{ label, selector }`); `collapseModelMentions` takes the same callback; `getModelMentionSuggestions` returns `ModelMentionCompletion`.
- `SetupHost` must implement `autoUpdate`, `canAutoUpdate()` and `saveAutoUpdate()` for setup version 3's auto-update scene.
- Removed `SPINNER_ADVANCE_MS` in favor of the shared spinner clock; `sharedSpinnerFrame` is exported from `spinner-clock`.
- Removed `formatMeta` from `render/render-utils`.
- `TranscriptContainer.nativeBlocks()` and `Composer.describeSurface()` now require the frame's `DescribeContext`.
- `GradientHighlightSpec.lightness` now maps gradient position to lightness like `hue` instead of taking a fixed percentage.

### Added

- Colorful Markdown, on by default (`setMarkdownColorful`): headings by level, bold/italic, inline code and table headers take distinct hues from the theme's `terminal.ansi` palette. `MarkdownTheme` gains optional `strong`, `emphasis` and `tableHeader` roles; `Theme.ansiFg()` paints a palette slot, falling back to the terminal's own palette.
- Bash cards show incremental Python-like pseudocode with a Raw toggle, failure marks and variable values; the inspector adds layers, split source and timestamp replay. Native hosts draw an inline segmented run box (`shell` = command, `omp.tool.bash.output` = output).
- `VersionUpdate`, `WelcomeComponent.setVersionUpdate()` and `ComposerWelcomeUpdate.versionUpdate`: the welcome banner shows background self-update progress, readiness or failure.
- `newSessionThinkingLevel` / `resolveConfiguredThinkingLevel` resolve a new session's starting thinking level; `ComposerCache.writeStatus` accepts `{ shared: false }` to keep a project's status out of the any-project fallback.
- `SettingItem.menu` exposes a cycling row's choices as a menu opened by `SettingsList.openSubmenuFor`; Enter/Space still cycle.
- `StatusLineComponent.setSessionPinned()` / `setPinnedSessionIds()` / `isSessionPinned()` track pinned sessions; `session_name` shows the theme's pin icon for them ([#17848](https://github.com/can1357/oh-my-pi/pull/17848) by [@SuperUserA](https://github.com/SuperUserA))
- Extension transcript presenters (`setTranscriptPresenters`, `readTranscriptPresentation`, `TranscriptPresentationState` in `chat/transcript-presentation`) draw tool cards and read entries full, compact or hidden ([#17960](https://github.com/can1357/oh-my-pi/pull/17960) by [@materemias](https://github.com/materemias))
- `PresentedBlock` applies transcript presenters to advisor, skill, execution, background-job, TTSR and other non-tool blocks; `TtsrNotificationComponent.rules` exposes its merged rules ([#17997](https://github.com/can1357/oh-my-pi/pull/17997) by [@materemias](https://github.com/materemias))
- `LinkBrowserComponent` (`overlays/link-browser`) browses a transcript fullscreen with stable link hint tags; `LinkHints` / `viewportLinkTargets()` share tagging with `Composer`; `ChatTranscriptBuilder` accepts `textRenderers` ([#16476](https://github.com/can1357/oh-my-pi/pull/16476) by [@materemias](https://github.com/materemias))
- `cache` status-line segment with warm/cold indicators, plus `StatusLineSession.getPromptCacheStatus`, `icon.cacheWarm` / `icon.cacheCold`, the `omp.composer.cache` fact and `promptCacheBrief` / `promptCacheDetails` helpers ([#12677](https://github.com/can1357/oh-my-pi/issues/12677)) ([#17496](https://github.com/can1357/oh-my-pi/pull/17496) by [@will-bogusz](https://github.com/will-bogusz))
- `^` model mentions suggest supported effort levels after `:` and refresh as you type via optional `AutocompleteProvider.trySyncModelMentionCompletion`, so Tab accepts the current row ([#17574](https://github.com/can1357/oh-my-pi/pull/17574) by [@a-glapinski](https://github.com/a-glapinski))
- Shared spinner clock (`spinner-clock`: `setSpinnerInterval`, `sharedSpinnerFrame`, `spinnerTickDelay`) ticks all spinners together; `0` makes them static ([#14240](https://github.com/can1357/oh-my-pi/pull/14240) by [@mccraigmccraig](https://github.com/mccraigmccraig))
- Frame-rate ceiling (`frame-rate`: `setMaxFps`, `minFrameIntervalMs`) for rendering and animations; frames awaited by a keystroke keep 30 fps ([#14240](https://github.com/can1357/oh-my-pi/pull/14240) by [@mccraigmccraig](https://github.com/mccraigmccraig))
- `setMotionEffects` (`motion-effects`) turns off decorative motion: status-line blink, brand fade, magic-keyword sweep and native `fx` spans ([#14240](https://github.com/can1357/oh-my-pi/pull/14240) by [@mccraigmccraig](https://github.com/mccraigmccraig))
- `CompactTranscriptBlock` (`chrome/transcript-container`): consecutive blocks whose `isTranscriptBlockCompact()` is true render without blank rows between them, in terminal and native (TSP) surfaces ([#17997](https://github.com/can1357/oh-my-pi/pull/17997) by [@materemias](https://github.com/materemias))

### Changed

- Ask cards drop per-question section headers; each question shows its id and flags inline (`(db · 3 options)`) ([#18104](https://github.com/can1357/oh-my-pi/pull/18104) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Tab in the `/usage` Details view switches back to Overview ([#17962](https://github.com/can1357/oh-my-pi/pull/17962) by [@SuperUserA](https://github.com/SuperUserA))
- LSP results use one header with request and counts, preview each reference's source line, and syntax-highlight previews and definition snippets ([#18106](https://github.com/can1357/oh-my-pi/pull/18106) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Grep and AST Grep headers show the search scope after the pattern, errors show the tool title and pattern, and collapsed AST Grep drops `meta:` rows ([#18105](https://github.com/can1357/oh-my-pi/pull/18105) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- AST Edit's header shows the search scope; the `proposed` state and replacement counts move to the card's bottom border ([#18105](https://github.com/can1357/oh-my-pi/pull/18105) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Centered sheets and dialogs on narrow native terminals fill the pane only once their content reaches half the screen height.

### Fixed

- Tern acknowledgements and visibility reports no longer appear as text in the editor when they arrive during a paste, including through Windows ConPTY.
- The `find` card marks searches cut short by its 20 s budget as `timed out` ([#18161](https://github.com/can1357/oh-my-pi/pull/18161) by [@will-bogusz](https://github.com/will-bogusz))
- Tern's classic renderer no longer leaves stale inline images over text while an answer streams or the pane resizes.
- The native composer's first frame shows the cached thinking/effort level instead of the plain model icon.
- Clicking a many-valued enum setting's popup on native settings pages now opens its menu.
- Ask notes no longer carry over between successive single-select questions ([#17979](https://github.com/can1357/oh-my-pi/issues/17979))
- LSP references no longer render as diagnostics or hover cards when a line looks like a diagnostics summary or code fence ([#18106](https://github.com/can1357/oh-my-pi/pull/18106) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- The LSP diagnostics card lists diagnostics per file, counts every file, and reports server failures instead of `No issues` ([#18106](https://github.com/can1357/oh-my-pi/pull/18106) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Closing an overlay that others opened over no longer makes them return focus to it ([#16476](https://github.com/can1357/oh-my-pi/pull/16476))
- ASCII tree branches are two columns wide (`|-`, `'-`), so child rows align like Unicode trees ([#18103](https://github.com/can1357/oh-my-pi/pull/18103) by [@JustasMasiulis](https://github.com/JustasMasiulis))

## [18.16.0] - 2026-11-02

### Breaking Changes

- `buildExecutionFrame` sets its loader into the new `bottomBorder` itself, so callers no longer add it as a row and must dispose it; `buildStatusFooter` no longer takes `status` or `exitCode`, and `executionStatusLabel` returns a settled run's `exit N` / `cancelled` marker for that border ([#17732](https://github.com/can1357/oh-my-pi/pull/17732) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- `SessionSelectorOptions.loadAllSessions` and `SessionPickerHost.loadAllSessions` resolve to a `SessionListing`, and `allSessions` takes one, so the all-projects scope can show preliminary rows before its complete listing
- `Editor.prediction` is replaced by `Editor.predictions`, which returns every prediction for the next prompt, most likely first, and `Editor.onPredictionAccepted` receives the inserted prediction's index in that list ([#17796](https://github.com/can1357/oh-my-pi/pull/17796) by [@wolfiesch](https://github.com/wolfiesch))

### Added

- `SessionSelectorOptions.completeSessions` (and `SessionPickerOptions.completeSessions`) replaces the picker's preliminary rows with the complete listing once it settles, keeping the query, the selected session, and deletes/renames made meanwhile
- `/btw` answers can show a steering prompt as a block behind a pink rail (a toned card in Tern) that `Alt+I` (`app.btw.inject`, remappable) sends to the main session; once sent it turns green with `➤` on each line, without moving ([#17618](https://github.com/can1357/oh-my-pi/pull/17618) by [@apullin](https://github.com/apullin))
- Added `singleLine` and `finiteWidth` to `utils` for row-confined text and cell widths
- `Loader.inlineText()` returns the current spinner frame and message as one styled line, and `DynamicBorder.setLabel()` sets a label (or a function re-read every render) into the rule ([#17732](https://github.com/can1357/oh-my-pi/pull/17732) by [@JustasMasiulis](https://github.com/JustasMasiulis))

### Changed

- The ASCII symbol preset's status glyphs are all three columns wide: success is `[+]`, error `[-]`, aborted `[#]` and pending `[ ]` (alongside `[~]` running, `[!]` warning and `[i]` info), and status spinners animate as `[|] [/] [-] [\]` ([#17732](https://github.com/can1357/oh-my-pi/pull/17732) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Built-in renderers no longer use `status.done`, `theme.status.done` or the `done` value of `ToolUIStatus`; they remain as aliases of `status.success` / `success` (an explicit `symbols.overrides["status.done"]` still applies to `theme.status.done`) ([#17732](https://github.com/can1357/oh-my-pi/pull/17732) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Every finished state shows the success glyph (`✔`, ASCII `[+]`). Task rows, verdicts and headers, background-job, launch and supervised-process rows, Eval cells, Vibe, Wait and process job rows, Yield and the generic tool card showed a separate `•` done dot, and a finished Read showed `●` (ASCII `[x]`). Live Task agent rows show the pending or running glyph, and a Task whose merge failed shows the warning glyph ([#17732](https://github.com/can1357/oh-my-pi/pull/17732) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Edit and Write animate their streaming spinner in the card header, as Eval does, and show their `preview` / `streaming` label in the card's bottom border instead of on a row below the content; `streaming` ends once the content has fully arrived ([#17732](https://github.com/can1357/oh-my-pi/pull/17732) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- `!` shell and `$` Python runs show their spinner, and then `exit N` or `cancelled`, in the frame's bottom border instead of on rows of their own; the spinner is the status spinner tool headers use ([#17732](https://github.com/can1357/oh-my-pi/pull/17732) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- GitHub run-watch job rows use the shared status glyphs: a running job shows the running glyph instead of a warning-colored dot, a queued job the pending glyph instead of a hollow circle (a job in a state omp does not recognize keeps the circle), and a passed job's glyph is green like other success glyphs. Ask's multi-line custom answer lines up under its first line in every symbol preset ([#17732](https://github.com/can1357/oh-my-pi/pull/17732) by [@JustasMasiulis](https://github.com/JustasMasiulis))

### Fixed

- An LSP result other than diagnostics, such as a raw `request` response, that contains the error glyph (`✘`, ASCII `[-]`) is shown as a response instead of as diagnostics reading "No issues" with the rest of its lines dropped ([#17732](https://github.com/can1357/oh-my-pi/pull/17732) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- `Editor.onPredictionAccepted` and `Editor.onPredictionShown` report when Tab or Right inserts the rest of the composer prediction and when a frame paints it (at least one cell in the terminal, or the ghost on a native editor node) ([#17739](https://github.com/can1357/oh-my-pi/pull/17739) by [@wolfiesch](https://github.com/wolfiesch))
- Added `OutputMeta.minimized` (bash minimizer filter, raw and minimized byte counts, raw-output artifact), shown as a `Minimized` fact on bash result cards ([#16586](https://github.com/can1357/oh-my-pi/pull/16586) by [@will-bogusz](https://github.com/will-bogusz))
- Added `isColumnTruncationNotice` and `hasColumnTruncationClause` to `tools/output-meta`, matching the `[Some lines truncated to …]` clause that `formatOutputNotice` emits alone or inside a longer notice, and `LimitsMeta.columnTruncated.rawByteCap`, which makes that notice name the byte cap a `:raw` read of the first cut line stops at ([#16595](https://github.com/can1357/oh-my-pi/pull/16595) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the model browser showing Factory Droid's undiscounted credit rate during a Factory promotion (2× instead of 1.6× for GPT-5.6 Sol); rows now show the rate in force and the model details show the next rate and its date ([#16309](https://github.com/can1357/oh-my-pi/pull/16309) by [@will-bogusz](https://github.com/will-bogusz))
- With two or more `Editor.predictions`, the ghost text follows the first one the draft is a prefix of; a typed draft that equals a shorter one keeps the ghost of a longer one. Once the buffer equals one of them with no ghost (always right after Tab, Right, or the list inserts one), a dim `⇥ N more` hint appears; press Tab to list them all, then Enter, Tab or Right to swap the whole line (never submitting) or Esc to keep it ([#17796](https://github.com/can1357/oh-my-pi/pull/17796) by [@wolfiesch](https://github.com/wolfiesch))
- F2 now opens the rename dialog in the resume picker in Ghostty, kitty and other terminals using the kitty keyboard protocol; F1 and F4 shortcuts work there too ([#17812](https://github.com/can1357/oh-my-pi/issues/17812)).
- Added `Component.nativeTrailers()`, which lets a transcript block add native blocks of its own directly after it. Trailing blocks stay visible while the block is collapsed.

## [18.15.0] - 2026-11-01

### Breaking Changes

- `GroupedLineContext.isUrl` is replaced by `url`, the internal URL a header names or a body row belongs to ([#17608](https://github.com/can1357/oh-my-pi/pull/17608) by [@JustasMasiulis](https://github.com/JustasMasiulis))

### Added

- Added `FILE_NAME_COLOR`, `formatStyledPath` and `pathNameStart` to `render/render-utils` for paths in tool bodies and Tern file rows; `createGroupedRowStyler`, `groupedLinkTargets`, `fitGroupsToBudget`, `groupsByFile` and `isMatchRow` to `tools/grouped-file-output`; `splitReadQuery` to `tools/read`; and `HASHLINE_TAG_SUFFIX_RE` to `tools/hashline-format`. `classifyGroupedLines` reports each file header's full `displayPath` and `suffix`, and a `TranscriptStatusPart` without `color` keeps its already-styled text ([#17608](https://github.com/can1357/oh-my-pi/pull/17608) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- `JobsPanelJob.caption`: the jobs sheet's detail pane shows it, muted, between the job's purpose and its command (`omp.jobs.caption`) ([#17649](https://github.com/can1357/oh-my-pi/pull/17649) by [@wolfiesch](https://github.com/wolfiesch))

### Changed

- The Background jobs sheet names each job by what it is for when the model said so, shows that above the full command in the detail pane, and no longer repeats the command in an empty widget box for jobs that print nothing ([#17649](https://github.com/can1357/oh-my-pi/pull/17649) by [@wolfiesch](https://github.com/wolfiesch))
- File paths in tool output share one style: a dim directory and the file name in the custom-message label color (bronze in titanium), with line locations and selectors (`:1-175`, `:42:14`, `?q=`) muted. This covers Grep, AST Grep, AST Edit, Glob, Find, LSP, diagnostics, grouped Reads and file mentions; Glob's folder icon is muted like the file-type icons, and paths in tool headers keep their color ([#17608](https://github.com/can1357/oh-my-pi/pull/17608) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Grep, AST Grep and AST Edit results label each file with its full path instead of the model-facing `# dir/` and `## file#tag` headers, and each file gets its own tree branch. Their collapsed previews fit the same row budget the same way, cutting the last file short rather than overflowing, and end with `… N more matches` (`… N more files` for AST Edit) ([#17608](https://github.com/can1357/oh-my-pi/pull/17608) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- AST Grep match rows link to their line, as Grep's do ([#17608](https://github.com/can1357/oh-my-pi/pull/17608) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- LSP diagnostics carry their severity color on the `[error]`/`[warning]` tag instead of the location, and collapsed diagnostic rows now show that tag ([#17608](https://github.com/can1357/oh-my-pi/pull/17608) by [@JustasMasiulis](https://github.com/JustasMasiulis))

### Fixed

- Rex sessions now render Kitty graphics without forcing the protocol, including when only `TERM=xterm-rex` identifies the client ([#17651](https://github.com/can1357/oh-my-pi/issues/17651)).
- Fixed collapsed AST Grep showing no matches when its first file or folder was taller than the preview, and its `… N more` row counting hidden folders instead of hidden matches ([#17608](https://github.com/can1357/oh-my-pi/pull/17608) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Fixed collapsed AST Edit overflowing its preview when the first file's diff was long ([#17608](https://github.com/can1357/oh-my-pi/pull/17608) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Fixed search and diagnostic file paths in Tern dropping the leading `/` of absolute paths and a folder's own `(…)` ending, and AST Edit diffs in Tern losing highlighting to the file's `#tag`; a file name ending in lowercase or other-length `#…` text keeps it ([#17608](https://github.com/can1357/oh-my-pi/pull/17608) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Fixed a read of a URL drawing as dead text in the folded read row: its target is not a file path, so no link was built for it, and clicking the URL did nothing. The row (and each row of a grouped read) now links to the URL itself, gaining an `https://` scheme for a bare `www.` host ([#17598](https://github.com/can1357/oh-my-pi/pull/17598) by [@iacore](https://github.com/iacore))
- Fixed replayed transcripts ignoring a registered `async-result` message renderer, so a replayed conversation rendered differently from the live one ([#17372](https://github.com/can1357/oh-my-pi/pull/17372) by [@AlexBrd999](https://github.com/AlexBrd999), from [#14484](https://github.com/can1357/oh-my-pi/pull/14484) by [@F0Rextasy](https://github.com/F0Rextasy); [#14131](https://github.com/can1357/oh-my-pi/issues/14131))

## [18.14.2] - 2026-10-31

### Added

- Added `assertModelSupportsEffortCeiling()`, which throws when a model has no supported thinking effort at or below a `task.maxEffort` ceiling ([#12229](https://github.com/can1357/oh-my-pi/pull/12229) by [@Xytronix](https://github.com/Xytronix))
- Added `iconButton()`, `quietButton()` and `segmentedTabs()` to `native/overlay`, and `disabled`, `busy` and `icon` options to `actionButton()`
- Added `nativeTail` to `Composer.setRuntimeChildren` options: containers whose children continue the native surface's `main` after the transcript instead of riding in the dock
- Added `isHighlightLanguage` and `createCodeFrameStyler` for renderers that highlight source lines in their file's language ([#17550](https://github.com/can1357/oh-my-pi/pull/17550) by [@JustasMasiulis](https://github.com/JustasMasiulis))

### Changed

- Grep and read results with gaps between line runs now render in Tern as one code block that scrolls sideways as a whole, with `…` gap rows aligned in the line-number gutter
- Tern builds that draw the `button` kind get omp's buttons as real buttons (pointer cursor, accessible pressed/disabled state, a disabled button's tooltip says why) and segmented controls as `tabs` `variant: "segmented"`; older Tern builds keep the role-styled rows
- Source lines in Grep, AST Grep and Find results and LSP symbol names are syntax-highlighted in their file's language instead of drawn in one color; consecutive lines highlight together, so multi-line strings and comments keep their colors ([#17550](https://github.com/can1357/oh-my-pi/pull/17550) by [@JustasMasiulis](https://github.com/JustasMasiulis))

### Fixed

- Fixed table charts plotting a ratio column against the timings it divides (`ratio` 0.997 beside `C++ (ms)` drew as "719× less"): `analyzeTable` reads a column equal to the quotient of two others as restating them, written bare or as `×`
- Fixed IRC coordination cards remaining visible when Hide Tool Activity is enabled, including incoming messages, automatic replies, relays, and workpool messages in live and replayed transcripts ([#17498](https://github.com/can1357/oh-my-pi/pull/17498) by [@dannyboy-ai](https://github.com/dannyboy-ai)).
- Fixed text after a nested color losing the outer color, such as the rest of the `/mcp` and `/ssh` hints after the highlighted command (`Run /mcp list to see all configured servers.`) falling back to the default text color instead of staying muted ([#17521](https://github.com/can1357/oh-my-pi/pull/17521) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Fixed LSP definition, type definition and implementation results showing the raw `Found 1 definition(s):` text; the response now counts them (`1 definition`) and shows each location over its source lines, its own line marked like a grep match ([#17549](https://github.com/can1357/oh-my-pi/pull/17549) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Fixed an LSP definition, type definition or implementation location whose path starts with whitespace being dropped, with its source lines shown under the previous location
- Fixed session tree user and assistant turns looking identical in themes whose `accent` and `success` colors match or nearly match (`dark-terminal`, `dark-poimandres`, `light-poimandres`): user rows are now bold, the `assistant:` label switches to the path color, and custom and advisor messages are muted ([#17520](https://github.com/can1357/oh-my-pi/pull/17520) by [@wolfiesch](https://github.com/wolfiesch))

## [18.14.1] - 2026-10-31

### Added

- Added a `maxRows` callback to `FigureMarkdown`, `SvgFigure` and `TableChartFigure` so surfaces shorter than the screen can fit their figures; zero hides a figure without delaying transcript completion ([#15661](https://github.com/can1357/oh-my-pi/issues/15661), [#15853](https://github.com/can1357/oh-my-pi/pull/15853) by [@KunoLu](https://github.com/KunoLu))

### Fixed

- Fixed IME composition text in the BTW history `Follow up:` input appearing at the left edge instead of at the caret when the hardware cursor is enabled ([#17427](https://github.com/can1357/oh-my-pi/issues/17427))
- Fixed session tree rows overlapping when messages, tool arguments, or labels contain carriage returns or Unicode line/paragraph separators (`U+2028`, `U+2029`), while keeping multiline formatting in the selected entry preview ([#17430](https://github.com/can1357/oh-my-pi/pull/17430) by [@lincicomb](https://github.com/lincicomb)).
- Fixed the Background jobs sheet dropping a finished job and its output while you were reading it; the selected job now stays until you select another ([#17506](https://github.com/can1357/oh-my-pi/pull/17506) by [@H4vC](https://github.com/H4vC))

## [18.14.0] - 2026-10-29

### Breaking Changes

- Moved `PINNED_HUD_TOGGLE_ID` to the coding agent's task output manager so reserving subagent IDs no longer loads the interactive editor.
- Updated `StatusLineHost.resetExpiryNotice` to receive the session and manage warning deduplication; custom status-line components must use the new signature.
- Removed `ToolExecutionHandle.setToolActivityVisible`; tool-activity visibility is now controlled by transcript components, while reply blocks remain visible by default.
- Removed the `@oh-my-pi/pi-tui/theme/defaults` export. Bundled palettes are now available through `getBuiltinThemes()` from `theme/defaults.json`.

### Fixed

- Fixed table-chart direction detection so measures are not incorrectly marked as better based on header words; single-measure tables are now sent for judging when local charting is appropriate.
- Fixed LSP diagnostics that incorrectly showed “No issues” before a language server had reported; such files are now shown as unverified. ([#17293](https://github.com/can1357/oh-my-pi/pull/17293) by [@JustasMasiulis](https://github.com/JustasMasiulis))
- Fixed Esc-Esc rewind in Tern selecting interrupted turns with no visible output instead of the last displayed turn.
- Fixed streamed code blocks losing lines that scrolled off screen before the closing fence arrived; completed lines now remain available in scrollback. ([#17333](https://github.com/can1357/oh-my-pi/pull/17333) by [@gzkGit777](https://github.com/gzkGit777))

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
- Added `@oh-my-pi/pi-tui`, the terminal UI that replaces `@oh-my-pi/pi-tui`: one tree of Tern Surface Protocol nodes drawn natively by Tern and as terminal rows elsewhere, with signals and a compiler-free JSX runtime, role-based painters and widgets, a terminal driver (input, capabilities, multiplexers, images, resize policies, notifications), Markdown and text utilities, themes, and test utilities (`testing/terminal`, `testing/cells`)

### Fixed

- Corrected math environment detection to properly handle blocks starting with `\begin`
- Cmd+A highlights the full text of editors and inputs when the terminal forwards the shortcut. Typing, deleting or pasting replaces the selected range.
- Native overlays follow the field they are anchored to, including when the field moves or shares its local key with another field.
- Native menu and tree toggles now reach the intended control or branch. Clicking behind an explicitly modal sheet no longer moves keyboard focus out of it.
- In terminal rows, modal sheets block clicks into the screen behind them. Inline clicks and hover follow the visible content after scrolling, and closing a fullscreen view restores the previous mouse setting.
- Returning to the shell after a native session no longer leaves terminal replies in the shell prompt, including after a fatal error.
