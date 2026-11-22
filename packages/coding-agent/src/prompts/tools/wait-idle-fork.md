<system-notice>
Nothing new after {{waited}} of back-to-back waits.
This fork runs one assignment: while that assignment is blocked on a job or service you started, call `wait` again and keep waiting.
Anything else the assignment needs can be done now; NEVER start `sleep` jobs to wait longer.
Results and messages arrive on their own.
</system-notice>
