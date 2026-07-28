Look up what the user was actually doing on this machine, from the local Activity Memory timeline.

The timeline is recorded continuously by a separate always-on app that samples the foreground window and stores sanitized metadata — which application, and window titles only. There are no screenshots, no page contents, and no keystrokes. Everything stays on this machine.

Use this when the user refers to their own recent work in a way you cannot answer from the conversation or the repository:

- "what was I working on this morning?"
- "what did I do yesterday afternoon?"
- "how long was I in the browser today?"
- "pick up where I left off before lunch"

Do not use it to infer what a *file* changed or what a command did — git history, the session transcript, and the filesystem are authoritative for that and are far more precise. This tool answers only "which apps and windows had focus, and for how long".

Results are bucketed by local hour, with tracked time and the application mix per hour. Window-title digests are included by default and are the most useful signal for identifying a task; set `includeDigests: false` when you only need the time breakdown.

Coverage is best-effort. Hours where the machine was asleep, the app was not running, or nothing had focus simply report no activity — absence of data is not evidence the user was idle, so do not assert that they were.
