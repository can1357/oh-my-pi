Starts a persistent worker session — a full coding agent (edit, bash, grep, everything) that you drive by conversation. Pick the CLI flavor per task:

- `fast`: low-latency model for mechanical, well-specified work (renames, boilerplate, running tests, data collection).
- `good`: strong model for hard work (design, debugging, multi-file changes, judgment calls).

`prompt` is the session's first instruction. The worker starts with NO context beyond it — include files, constraints, and acceptance criteria. Workers are delegated sessions: for any required registered skill, return a `dependency_required` object with the canonical skill, exact args, `execution_owner: parent_active_session`, `status: not_run`, `reason: delegated_worker_boundary`, dependent gate, and artifact. Never probe `command -v`, `which`, bare `--help`, or `$PATH`, and never send slash commands to the parent. The active director must invoke the exact `/skill:<name> <args>` and validate `skill-dispatch-result/v1`; dependency work remains blocked until then. `name` (optional) labels the session; otherwise one is generated.

Returns immediately with the session id; the turn's result (activity trace + the worker's response) is delivered to you automatically when the worker finishes. Do not wait unless you are blocked — keep directing other sessions.

The session persists after the turn: it remembers the whole conversation. Continue it with `vibe_send`; never spawn a second session for a follow-up on the same workstream.
