Turn ended with unpushed work in worktree.

Issue: {{repo.full_name}}#{{issue.number}} — {{issue.title}}
Branch: `{{workspace.branch}}`

End-of-turn workspace state:

{{dirty.summary}}

Any nonzero count → roboomp discards work when session ends. Act on this summary:

- **Uncommitted changes** → stage and commit; if unintentional, `git restore`. If work ready, run `bun run fix` before commit; formatter/lint gates reject pushes if `fix` exits non-zero.
- **Unpushed commits** → after successful `bun run fix`, call `gh_push_branch`. If it refuses for another reason, fix root cause; do not skip gate.

If fix genuinely complete and gates pass, push, then comment on PR with one-line summary of changes since previous push. Do not re-classify issue, re-post original preamble, or call `abort_task`; recoverable.

MUST end turn with either successful `gh_push_branch`, or clean worktree (no uncommitted changes; no commits ahead of `origin`) and explanation in a comment.
