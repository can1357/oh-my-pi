Send/receive short text messages between agents in this process.

<instruction>
- Main agent is `Main`; subagents reuse their task id (`AuthLoader`, `AuthLoader-2` on repeat).
- `op: "list"` — peers with status (`running` | `idle` | `parked`), unread count, parent, last activity. Use when unsure who exists.
- `op: "send"` — fire-and-forget; returns per-recipient receipts immediately, NEVER waits for the recipient to act. Outcomes: delivered, or `failed` (unreachable). `to: "all"` broadcasts to live peers.
- Messaging an `idle`/`parked` peer wakes it — no separate revive call.
- `op: "wait"` — block for a message (optionally only `from` one peer); consumes + returns it. Timeout = clean "no message", not an error.
- `op: "inbox"` — drain pending messages without blocking.
- `op: "complete"` — signal that work with `to` is done. When both peers complete each other, a Fusion sidekick peer resets its context for the next interaction.
- Replies arrive only when the recipient sends one. For peer background, `read` `history://<id>`, don't interrogate.
</instruction>

<when_to_use>
Reach for `irc` when going alone is wasteful or wrong; when in doubt, message.
- **Unexpected state** — missing file, config contradicting the assignment, API/tool behaving differently than told. DM `Main` (or your spawner), don't guess.
- **Blocked by another agent** — a peer holds the file/branch/resource/decision you need, or started your change. DM them (or broadcast to find who) before duplicating work.
- **Decision outside your scope** — a genuine fork the assignment didn't pre-decide. Ask the requester, don't pick unilaterally.
- **Coordination** — a peer's in-flight work overlaps yours (roster shows each peer's role + activity); message before editing a shared file or duplicating a sibling's change.

NEVER for: routine progress updates, things a tool call can verify, questions your assignment/repo/docs already answer.
</when_to_use>

<etiquette>
Applies to sending + replying.
- **Plain prose only.** NEVER JSON status payloads like `{"type":"task_completed",…}` — write a normal sentence.
- **NEVER quote the message you answer.** Lead with the answer; set `replyTo`.
- **Learn about peers via IRC** — NEVER grep artifacts, read other sessions' JSONL, or shell-poke. DM them, or `read` `history://<id>`.
- **Send, then keep working.** `wait`/`await: true` only when you cannot proceed. NEVER "did you get my message?". A `failed` receipt = peer unreachable — move on; NEVER retry in a loop.
- **Answer expected questions** via `irc send` to the sender (finish your current step first).
- **Stay terse.** One question per send; share files via `local://`/`memory://`/`artifact://` URLs, never pasted blobs.
- **Address peers by exact id** from `op: "list"` (e.g. `AuthLoader`, `Main`). NEVER invent friendly names.
- **NEVER IRC what a tool answers.** A `read`, grep, or build resolves it? Do that first.
- Use `complete` only when the current interaction is fully done and no follow-up is expected; it requires `to` and never broadcasts.
</etiquette>
