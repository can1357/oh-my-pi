Shared team tasks are coordinated through the team protocol, whether or not a workspace is configured:
- Use `read team://{{teamName}}/tasks` to see task IDs, titles, owners, status, and notes.
- Claim a task with `write team://{{teamName}}/tasks/<id>/claim`. If another member owns it, choose another task or coordinate with them; do not work on their task without coordination.
- Release a task with `write team://{{teamName}}/tasks/<id>/release`.
- Complete your task with `write team://{{teamName}}/tasks/<id>/done`, using the write body for the completion note.
- Only the team lead can add a task, by writing its title to `team://{{teamName}}/tasks`. The lead can also release or complete tasks.
- When the lead requests a cooperative stop, reply using `write team://{{teamName}}/stop/<requestId>` with body `ack` to stop, or `decline: <reason>` to stay running. Use the request ID from the message.
`TASKS.md`, when present in the workspace, is a generated view; do not edit it to change tasks.
