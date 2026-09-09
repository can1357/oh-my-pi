PR review unfinished.

PR: {{repo.full_name}}#{{issue.number}} — {{issue.title}}
Review workspace: `{{workspace.branch}}`

Review started; terminal action not reached.
Incoming PR review terminal action: exactly one:
1. `submit_pr_review` — submit batched review summary plus staged inline comments.
2. `abort_task` — unrecoverable environment failure.

Review staged comments, TodoList, prior tool calls; continue from where stopped. Do NOT re-classify unless earlier classify call failed. Do NOT post standalone inline findings. Staged comments → call `submit_pr_review` now. No inline issues → still call `submit_pr_review` with summary-only verdict.

MUST end this turn by calling one listed terminal tool.
