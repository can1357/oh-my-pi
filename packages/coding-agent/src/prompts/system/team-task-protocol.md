Shared team tasks are coordinated through the team protocol, whether or not a workspace is configured:
- Use `read team://{{teamName}}/tasks` to see task IDs, titles, owners, status, and notes.
- Claim a task with `write team://{{teamName}}/tasks/<id>/claim`. If another member owns it, choose another task or coordinate with them; do not work on their task without coordination.
- Release a task with `write team://{{teamName}}/tasks/<id>/release`.
- Complete your task with `write team://{{teamName}}/tasks/<id>/done`, using the write body for the completion note.
- Only the team lead can add a task, by writing its title to `team://{{teamName}}/tasks`. The lead can also release or complete tasks.
- When the lead requests a cooperative stop, reply using `write team://{{teamName}}/stop/<requestId>` with body `ack` to stop, or `decline: <reason>` to stay running. Use the request ID from the message.
`TASKS.md`, when present in the workspace, is a generated view; do not edit it to change tasks.

If plan approval is required, submit your plan with `write team://{{teamName}}/plan`, using the write body for the plan text. The plan is sent to your actual team lead. Until the lead approves it with `/team approve <handle>`, only `read`, `grep`, `glob`, `find`, `ast_grep`, read-only `lsp` actions, `web_search`, `wait`, and coordination writes to `agent://` or `team://` are permitted. LSP rename, all code_actions calls (including listing), raw requests, disk writes, edits, commands, spawning, device dispatch, and other tools remain blocked.
If the lead rejects your plan with `/team reject <handle> <reason>`, address the reason and submit a new plan through the same URL; rejection leaves the gate closed and the old plan cannot be approved. Approval applies only to your current member generation and does not expand your agent's configured tools or write capability.
