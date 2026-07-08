Send/receive short text messages between agents in this process.

<instruction>
- Main agent is `Main`; subagents reuse their task id (`AuthLoader`, `AuthLoader-2` on repeat).
- Beyond the schema: `send` is fire-and-forget (returns `delivered`/`failed` receipts, NEVER blocks on the recipient). `wait` consumes the returned message; timeout = clean "no message", not an error. `inbox` drains pending. `complete` resets a Fusion sidekick peer's context once both peers complete each other.
- Messaging an `idle`/`parked` peer wakes it — no separate revive call.
- Replies arrive only when the recipient sends one. For peer background, `read` `history://<id>`, don't interrogate.
</instruction>

<when_to_use>
DM `Main` (or your spawner) instead of guessing when:
- an unexpected state — missing file, config contradicting the assignment, API/tool behaving differently than told
- a peer holds the file/branch/resource/decision you need, or started your change (DM them, or broadcast to find who, before duplicating work)
- the assignment didn't pre-decide a fork you face (ask the requester)
- a peer's in-flight work overlaps yours (roster shows each peer's role + activity); message before editing a shared file or duplicating a sibling's change

When in doubt, message.

NEVER for: routine progress updates, things a tool call can verify, questions your assignment/repo/docs already answer.
</when_to_use>

<etiquette>
For both sending and replying:
- Plain prose only. NEVER JSON status payloads like `{"type":"task_completed",…}`; NEVER quote the message you answer (lead with the answer; set `replyTo`); NEVER grep artifacts, other sessions' JSONL, or shell-poke — DM them, or `read` `history://<id>`.
- `wait`/`await: true` only when you cannot proceed. A `failed` receipt = peer unreachable — move on; NEVER retry in a loop. NEVER "did you get the message?".
- One question per send; address peers by exact id from `op: "list"` (e.g. `AuthLoader`, `Main`), NEVER invent friendly names. Answer expected questions via `irc send` to the sender. Share files via `local://`/`memory://`/`artifact://` URLs, never pasted blobs.
- NEVER IRC what a tool answers. A `read`, grep, or build resolves it? Do that first.
- `complete` only when the current interaction is fully done and no follow-up is expected; it requires `to` and never broadcasts.
</etiquette>
