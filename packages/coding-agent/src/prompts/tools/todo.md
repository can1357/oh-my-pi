Tasks identified by verbatim content, NEVER generated IDs (task-1). Unique, stable task/phase names; lost text: view, NEVER guess.
Before work, init for 3+ steps, requested task sets, or new instructions. MUST list EVERY user item separately (phased/numbered/bulleted/N); NEVER omit or remember leftovers.
After successful mutation: no active means earliest pending starts (phase order); multiple active means only earliest stays. Blocked NEVER starts automatically; unblock returns pending. Done out of order may rewind pointer but NEVER reopen completed. Mark done immediately; follow phase order.
External waits (user/agent/service): block with optional reason suppresses stop reminder, starts next pending. Unblock when actionable; append a clearing task for agent-actionable blocker.
Every call MUST include `finish_turn`. Ordinary progress: `finish_turn: false`; batch init with first work, done/start with next action, and continue working.
Final update: include the complete user-facing text with a Todo-only mutation batch and set `finish_turn: true`. Ending this reply does not complete tasks; waiting on the user may end the reply.
