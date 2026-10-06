Manage active goal-mode objective.

Single `op` field:
- `create`: starts goal; enables goal mode. Requires `objective`; optional positive `token_budget`. Only when no goal exists and none is paused.
- `get`: returns current active/paused goal and remaining token budget.
- `resume`: re-activates paused goal for continued work.
- `complete`: marks goal complete only when actually done and every deliverable verified against current evidence. NEVER because budget low or turn ending.
- `drop`: discards current goal without completing it and ends goal mode; `goal` tool leaves your tool set immediately, so you cannot `create` a replacement (not even later in the same turn or eval cell). To change the objective, NEVER drop; ask the user to set the new goal.

Paused goal from `get` → MUST `resume` before continuing work.
