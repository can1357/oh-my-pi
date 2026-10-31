Manage active goal-mode objective.

Single `op` field:
- `create`: starts goal; enables goal mode. Requires `objective`; optional positive `token_budget`. Only when no goal exists and none is paused.
- `get`: returns current active/paused goal, remaining token budget, and live objective-editing mode.
- `update`: edits only the active objective in place. Requires `objective`; never pass `token_budget`. Allowed only after an explicit user request to change the objective, never for autonomous scope reduction or a request merely to continue working. `goal.modelObjectiveUpdates` controls access: `disabled` (default) rejects model edits; `confirm` requires user approval of each old/new objective; `on-request` trusts your interpretation of the explicit request without another prompt. Use `get` to check the current mode. Preserve goal status, identity, budget, and accumulated usage.
- `resume`: re-activates paused goal for continued work.
- `complete`: marks goal complete only when actually done and every deliverable verified against current evidence. NEVER because budget low or turn ending.
- `drop`: discards current goal without completing it and ends goal mode; `goal` tool leaves your tool set immediately, so you cannot `create` a replacement (not even later in the same turn or eval cell). To change the objective, use an authorized `update` when enabled; otherwise ask the user to set the new goal. NEVER drop/create to bypass editing permissions.

Paused goal from `get` → MUST `resume` before continuing work.
