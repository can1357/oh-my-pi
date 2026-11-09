Wait only when blocked with nothing else to do.
Blocks on background jobs/services you started, or on the answer to a question you sent this run.
With nothing new it returns a still-running snapshot after {{floor}}, the window growing to {{ceiling}} across back-to-back waits.
Nothing you started running and no answer owed? Returns at once.
- MUST wait only on your own jobs/services, or rarely the answer to a question that blocks you.
- NEVER wait for another agent's progress or for messages nobody owes you.
- Result in, other jobs still running? SHOULD act on it before waiting again.
- Still running and nothing else to do? Wait again. NEVER start `sleep` jobs to wait longer.
Results and messages auto-deliver. NEVER poll while work remains.
