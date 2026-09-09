# Follow-up on {{repo.full_name}}#{{inbound.number}} ({{inbound.kind}})

Thread: {{origin.description}}. PR: `{{state.pr_status}}`.

## Prior conversation

{{thread}}

---

## New comment: @{{comment.author}} ({{comment.created_at}})

{{comment.body}}

---

## Action

- New repro info: re-run `repro_record`; `gh_post_comment` outcome.
- Maintainer dismissal: "intended", "not an issue", "works as designed", or similar, however terse, permanently ends fix workflow—even mid-fix with completed work. No commits, pushes, or PRs. Apply `wontfix` via `set_issue_labels` when available on this thread; at most one short acknowledgement; stop.
- PR change requested: amend `{{workspace.branch}}`; push only for an already-open PR / authorized implementation. NEVER open a second PR or first PR for an unauthorized enhancement/proposal. Short `gh_post_comment` naming changes.
- Confirmation or unrelated question: one `gh_post_comment`; code untouched.
- Bot author or no actionable content: no-op.

MUST reuse recorded session state. NEVER restart from scratch.
