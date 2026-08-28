# Changelog

## [Unreleased]

### Added

- omp Desktop: a native app for driving omp, with a session list grouped by git checkout, a streaming transcript that renders omp's own tool cards, a read-only diff and file tree, a task panel, live subagents, and screens for settings, plugins and MCP servers.
- The transcript uses omp's `titanium` theme and ships MesloLGM Nerd Font, so it looks like the same session does in a terminal.
- A context menu on every surface: sessions can be renamed, exported to HTML, revealed in Finder, stopped or deleted from it.
- Plan mode is usable from the app, and its approval dialog shows the plan rather than asking you to approve a title.
- Compaction confirms before it runs, reports progress, can be cancelled, and leaves a record in the transcript.
- Starting a chat asks which project, listing the ones already in the sidebar.
- Native notifications when a turn ends or an approval is waiting, and clicking one brings that session forward.

### Fixed

- Opening a file in the editor, revealing it in Finder and the OAuth login now work; they were rejected by a missing permission scope and did nothing at all.
- Renaming or exporting a session that is not open now acts on that session instead of on an empty one, while reporting success.
- Renaming or exporting a closed session now fails and says so when the throwaway process could not open it, instead of acting on the empty session it booted with and reporting success.
- Renaming or exporting a session that predates omp recording a working directory no longer dies with a filesystem error.
- Pressing Escape to dismiss a menu or the expanded composer no longer aborts the running turn.
- The file tree's context menu now opens.
- Cut and paste in the text menu now act on the field you opened the menu in.
- Two of the three MCP actions could never succeed; the screen now offers only the one that can.
- The sleep-prevention setting was missing the agent's own default, so it reported "Off" over a machine that was in fact staying awake.
- The transcript no longer re-renders on every keystroke.
- A diff the shell cut short is no longer offered to the clipboard as a patch: it applied cleanly and wrote the wrong file. The panel says when what it is showing is incomplete.
- Failures from the model picker and the approval-mode menu are shown instead of dropped.
- Renaming or exporting a session whose process is running but whose view is not open now refuses instead of starting a second agent on the same transcript.
- "Stop the process" works from Settings and the other non-session screens, where it used to do nothing while the sidecar kept running.
- The working indicator's dots are round again; the previous fix lost to the flattener on specificity while claiming to have won.
- A sidebar dot no longer stays on "finished" for the session you are reading; being on screen counts as having seen it.
- An MCP argument with spaces in it — a quoted `-e` script, a path — is kept as one argument instead of being split into several, which used to launch the server with the wrong argv.
- Reopening the model picker after a failed load now retries instead of showing "Nothing matches" until the app is restarted, and only the model actually in use is highlighted when two providers share an id.
- Remounting a session no longer leaves the tab in an error state: a second start for the same tab attaches to the live process again.
- Your message appears the moment you send it, instead of waiting for the agent to echo it back — which on the first message of a session meant several seconds of a blank screen while its MCP servers connected.
- The working indicator now lights when you press Send rather than when the turn finally opens.
- Opening a session issues its startup queries in parallel where they do not depend on each other, which halves the round trips before the transcript is on screen.
- Stopping or deleting a session while its process is still starting now actually stops it, instead of reporting success and letting the process come up anyway.
- Copying the diff of a new file now produces a patch that applies, instead of putting an empty string on the clipboard.
- A message refused after the agent had already accepted it comes back to the composer instead of vanishing; the reason is shown where you are, including inside the expanded editor.
- An approval or question the agent has stopped waiting for now closes itself instead of holding the screen and the queue behind it.
- The editor dialog opens on the document it was asked to edit rather than blank, so submitting untouched no longer replaces that document with nothing.
- A session whose process dies mid-turn no longer keeps showing as working, blocking the window close and offering Stop where Send belongs.
- A rename detected on the worktree side is read as a rename instead of producing a phantom file with a truncated name.
- Opening a session that the agent refuses to switch to now says so, instead of showing that session's name over a different one.
- Deleting a session now stops its process even when the session route is not mounted; the transcript used to be unlinked from under a running agent whose next write went to a file with no name.
- Renaming or exporting a session from Settings no longer starts a second agent on a transcript the running one still has open; the menu says to open the session first.
- "Stop the process" now stops it from Settings, where it was an enabled menu entry that did nothing at all.
- A background turn is no longer the first thing evicted when a fourth tab opens: the pool now counts streaming output as activity, not just what the app types.
- The pre-warmed spare counts against the three-process ceiling instead of quietly making it four.
- A spare that finished starting after the pool had filled is now discarded instead of installed as a fourth process.
- A failed history reload on re-attach now says so in the tab, instead of rendering a live session as an empty new chat.
- Returning to a session after visiting Settings no longer aborts the turn that was running.
- A chat you started in the app comes back as itself after its process is reclaimed, instead of reopening as a different, empty session under the transcript you were reading.
- Opening a saved session now shows that session's model, thinking level and context usage straight away, rather than the ones the process started with.
- Re-attaching to a session already in progress now shows its conversation instead of an empty transcript.
- Reloading a session's history while a turn is running no longer drops the reply being written or the tool card still spinning.
- Starting a chat in a folder used earlier in the same run no longer silently re-attaches to that earlier chat.
- Clicking your own chat's row no longer opens a second process on the same session file.
- A session you have just started now appears in the sidebar without restarting the app.
- The task panel now renders tasks, distinguishes blocked and abandoned ones, and shows why a task is blocked.
- Reopened sessions show each tool's arguments instead of an ellipsis.
- Diff and file-tree paths work for a session running in a subdirectory of the repository.
- A failed tool no longer draws the same marker as one that succeeded.
- The composer grows with its text and the Send button no longer stretches with it.
- A message the app could not hand off — an evicted or crashed session, a dead relay — now stays in the composer with the reason on screen, instead of being cleared into nothing.
- A prompt refused after it was accepted now says why, instead of disappearing in silence.
- Sending just as a turn begins no longer loses the message: prompts queue behind the running turn the way the terminal's do.
