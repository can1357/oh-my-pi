Wait only when blocked with nothing else to do.
Blocks on background jobs/services you started, or on the answer to a question you sent this run.
Nothing you started running and no answer owed? Returns at once, unless you pass `timeout`: then it idles until a direct message, a steer or a job result arrives, or `timeout` seconds pass. While an agent waits on your result, `timeout` does not idle: finish your work.
- MUST wait only on your own jobs/services, rarely the answer to a question that blocks you, or (with `timeout`) a message another session told you it will send.
- NEVER wait for another agent's progress or for messages nobody owes you.
- NEVER start a sleep job to hold a wait open.
- Result in, other jobs still running? SHOULD act on it before waiting again.
Results and messages auto-deliver. NEVER poll while work remains.
