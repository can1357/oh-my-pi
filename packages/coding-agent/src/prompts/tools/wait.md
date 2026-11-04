Wait only when blocked with nothing else to do.
Blocks on background jobs/services you started, or on the reply to a message you sent this run; returns on the first result, a message sent to you, or a steering interrupt; a safety cap returns a still-running snapshot.
Nothing you started running and no reply owed? Returns at once, unless you pass `timeout`: then it idles until a message, a steer or a job result arrives, or `timeout` seconds pass. Use that to wait for another session's message; NEVER start a sleep job to hold a wait open. While an agent waits on your result, `timeout` does not idle: finish your work.
Results and messages auto-deliver. NEVER poll while work remains.
