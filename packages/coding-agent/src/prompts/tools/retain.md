Store ≥1 fact in long-term memory for future sessions.

Use: durable, reusable knowledge—user preferences, project decisions, architectural choices; anything improving future responses. No ephemeral task state.

{{#if globalScope}}`scope: global` stores an item in the shared bank every project recalls; reserve it for cross-project preferences and facts.
{{/if}}Each item MUST be specific, self-contained: who, what, when, why. Batch related facts per call; deduplicated and consolidated.

Optional item fields: `memoryType` picks the memory kind (defaults to semantic). Set `verified: true` only when the procedure was actually executed and its checks passed (tests/commands ran green) — a procedural item without it renders with an `[unverified]` marker on recall. Set `trigger` (keywords/paths) only for facts that must surface regardless of query wording — environment rules, tool mandates, repo conventions: the row then enters the memory block whenever a recall query shares a keyword or the session touches a matching path. Add `tags: ["profile"]` for standing facts and rules the user wants in effect at all times (machine setup, hard requirements, long-term preferences): those surface in the always-in profile section on every session start, independent of query wording — reserve the tag for what must never scroll away, not for ordinary facts.
