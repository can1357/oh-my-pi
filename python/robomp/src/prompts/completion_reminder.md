Turn ended unfinished.

Issue: {{repo.full_name}}#{{issue.number}} — {{issue.title}}
Branch: `{{workspace.branch}}`

Issue classified; bug reproduced; NO turn-ending action.
For `bug` / `documentation` issues, exactly one turn-ending action:
1. `gh_push_branch` + `gh_open_pr` — committed fix; pushed branch; opened PR.
2. `mark_unable_to_reproduce` — genuinely cannot reproduce after a real attempt; need reporter-provided reproduction details.
3. `abort_task` — unrecoverable environment failure.

Review TodoList and prior tool calls; continue where stopped. Do NOT re-classify or re-post the same preamble comment. Fix drafted in worktree → commit, push, open PR now. No source files edited → fix; continue to PR.

MUST end this turn: call one of the three listed tools.
