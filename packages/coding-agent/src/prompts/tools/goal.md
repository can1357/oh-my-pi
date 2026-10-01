Manage a session goal. Declaring the tool does not activate goal mode.

Single `op` field:
- `create`: starts goal; enables goal mode. Requires `objective`; optional positive `token_budget`. Only when no goal exists and none is paused.
- `get`: returns current active/paused goal and remaining token budget.
- `resume`: re-activates paused goal for continued work.
- `complete`: marks goal complete only when actually done and every deliverable verified against current evidence. NEVER because budget low or turn ending.
- `drop`: discards current goal without completing it.

Paused goal from `get` → resume before continuing that goal, not before unrelated work. Re-enabling the capability does not resume a paused goal.
