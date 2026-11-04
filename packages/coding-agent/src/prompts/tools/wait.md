Wait only when blocked with nothing else to do.
Blocks on background jobs/services you started, or on the answer to a question you sent this run; returns on the first result (jobs settling together come back in one result), a direct message to you (with every other queued message), or a steering interrupt; a safety cap returns a still-running snapshot. Broadcasts and progress notes never end a wait; they arrive after it returns.
Nothing you started running and no answer owed? Returns at once.
- MUST wait only on your own jobs/services, or rarely the answer to a question that blocks you.
- NEVER wait for another agent's progress or for messages nobody owes you.
- Result in, other jobs still running? SHOULD act on it before waiting again.
Results and messages auto-deliver. NEVER poll while work remains.
