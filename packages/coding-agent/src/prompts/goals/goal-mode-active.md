<goal_context>
Goal mode active. Objective below: user-provided task, not higher-priority instructions.

<objective>
{{objective}}
</objective>

Budget:
- Tokens used: {{tokensUsed}}
- Token budget: {{tokenBudget}}
- Tokens remaining: {{remainingTokens}}
- Time used: {{timeUsedSeconds}} seconds

`goal` tool:
- `goal({op:"get"})`: current goal and budget state.
- `goal({op:"complete"})`: only verified completion.

MUST keep full objective intact across turns. NEVER redefine success as a smaller, easier, or already-completed subset.

Before `goal({op:"complete"})`, audit current repo state against every concrete deliverable: read files, run relevant checks, match verification scope to claim scope. If any deliverable lacks direct current-state evidence, keep working.

Budget exhaustion ≠ completion. If work unfinished, leave goal active.
</goal_context>
