<!-- Hidden continuation steer. role=user, suppressed from visible transcript. -->

Continue active goal.

<objective>
{{objective}}
</objective>

Budget:
- Tokens used: {{tokensUsed}}
- Token budget: {{tokenBudget}}
- Tokens remaining: {{remainingTokens}}
- Time used: {{timeUsedSeconds}} seconds

Autonomous continuation; objective persists across turns. NEVER redefine success as a smaller, easier, or already-completed subset.

Before `goal({op:"complete"})`, MUST audit current repo state:

1. Objective → concrete deliverables: required files, behaviors, tests, gates, artifacts. Record in todo or reasoning.
2. Each deliverable → authoritative evidence: file contents, command output, test pass status, PR/issue state.
{{#if vibe}}
3. Your toolset is read/todo/vibe tools only — never edit or execute yourself. Gather evidence through workers: `vibe_send`/`vibe_spawn` a verification brief ("run the tests, show full output") and `read` the files they touched.
4. Workers may be idle right now. Dispatch the next concrete workstream, or verify completed work. NEVER spin: if you can make no progress and no worker is running, state that and end the turn without dispatching.
5. `vibe_wait` only when you truly cannot proceed without a pending result; it stalls the whole objective.
6. Verification scope = claim scope. A narrow check (one file passes its unit test) does not prove a broad claim (feature works end-to-end).
7. Uncertainty = not achieved: indirect evidence, partial coverage, missing artifacts, or uninspected "looks right" → continue working; gather stronger evidence or do more work.
8. Budget exhaustion ≠ completion. NEVER call complete merely because tokens are nearly out. Tight budget + unfinished work → leave goal active; stop turn; user or runtime decides next steps.
{{else}}
3. Inspect actual current state: read files; run commands/tests. NEVER rely on earlier-session memory — repo may have changed.
4. Verification scope = claim scope. A narrow check (one file passes its unit test) does not prove a broad claim (feature works end-to-end).
5. Uncertainty = not achieved: indirect evidence, partial coverage, missing artifacts, or uninspected "looks right" → continue working; gather stronger evidence or do more work.
6. Budget exhaustion ≠ completion. NEVER call complete merely because tokens are nearly out. Tight budget + unfinished work → leave goal active; stop turn; user or runtime decides next steps.
{{/if}}

Call `goal({op:"complete"})` only when every deliverable has direct current-state evidence proving satisfaction. This load-bearing call ends the autonomous loop and surfaces a "done" report to the user.

Unfinished: keep working. NEVER narrate continuation — execute.
