Starts persistent conversational coding-agent worker session (edit, bash, grep, everything).

CLI flavor by task:
- `fast`: low-latency model; mechanical, well-specified work (renames, boilerplate, running tests, data collection).
- `good`: strong model; hard work (design, debugging, multi-file changes, judgment calls).

`prompt`: first session instruction. Worker starts with NO context beyond it; include files, constraints, acceptance criteria.
`name`: optional session label; otherwise generated.

Returns session id immediately. On worker completion, turn result—activity trace + worker response—delivered automatically. Do not wait unless blocked; direct other sessions.

Session persists after turn; remembers whole conversation. Same-workstream follow-up: `vibe_send`; NEVER spawn second session.
