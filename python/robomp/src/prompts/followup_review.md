# PR review: {{repo.full_name}}#{{pr.number}}

Review comment on PR you opened.

## Prior conversation

{{thread}}

## @{{comment.author}} — `{{comment.path}}`{{comment.line_range}}

{{comment.body}}

---

- MUST read diff context around cited line range before acting.
- Address comment; push follow-up commit on `{{workspace.branch}}`.
- Reply: single `gh_post_comment` summarizing changes, one line per concrete fix.
- Clarification, not change? Answer with `gh_post_comment`; NEVER touch code.
- Point already resolved on `{{workspace.branch}}` or already answered in the prior conversation or this session: stay silent — no commit, no comment; NEVER a second "already resolved" reply.
