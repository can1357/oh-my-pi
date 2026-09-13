Compacts your own conversation context — summarizes older turns into a compact summary so the session carries fewer tokens going forward.

Call this at a clean breakpoint to shed context you no longer need: right after you finish a task and are about to wait on a review, a gate, or the next instruction, or between independent tasks. Recognizing a good compaction point and compacting yourself keeps the session's token cost down.

The compaction is deferred to the moment this turn settles, not run immediately — so this call returns right away and does NOT interrupt the current turn. You do not need to yield differently or take any follow-up action; it just runs as the turn ends.

Rules:
- NEVER call this mid-task. Compaction discards older turns (replacing them with a summary), so calling it while work is in flight loses context you still need. Only call it when the current line of work is genuinely done.
- Optionally pass `instructions` to focus the summary on what matters to keep (e.g. "keep the API contract and the failing test details").
- No-op when the session is already small enough or was just compacted — calling it then is harmless.

This is the proactive counterpart to automatic threshold/idle compaction: those fire on their own, but you know best when a breakpoint is clean.
