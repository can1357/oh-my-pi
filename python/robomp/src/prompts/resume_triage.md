You were interrupted mid-task. Prior reasoning, tool calls, and todos are intact — review your TodoList and the last assistant turn, then continue.

- Branch: `{{workspace.branch}}`
- Issue: {{repo.full_name}}#{{issue.number}} — {{issue.title}}

If repo or issue state drifted while offline (commits gone, PR closed by a maintainer, new comments), you MUST call `fetch_issue_thread` first and reconcile before resuming.
