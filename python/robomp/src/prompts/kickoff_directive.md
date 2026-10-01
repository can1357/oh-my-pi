# Maintainer directive: {{repo.full_name}}#{{issue.number}}

Title: {{issue.title}}
Issue author: @{{issue.author}}
Current labels: {{issue.labels}}
Default branch: `{{repo.default_branch}}`
Working branch (checked out at cwd): `{{workspace.branch}}`

@{{directive.author}} tagged you. Their directive authoritative; overrides default classification stop rules: `enhancement` normally waits for `accepted`, but this directive permits proceeding.

## Issue body

{{issue.body}}

## Prior conversation

{{thread}}

## Directive from @{{directive.author}}

{{directive.body}}

## What to do

1. Classify first. MUST call `classify_issue(primary=..., priority=..., functional=[...], rationale=...)` before any other side effect, even if directive states answer. Labels: org triage.

2. Execute directive in same session on `{{workspace.branch}}`:
   - Code change → commit on `{{workspace.branch}}`; then `gh_push_branch` + `gh_open_pr`. Both run `bun run fix`, then `bun check`, against worktree; `gh_open_pr` also runs the repo's full `bun run test` and refuses while it is red. On failure, fix cause and call again. PR body MUST use verbatim: `## Repro` / `## Cause` / `## Fix` / `## Verification`. Reply: single `gh_post_comment` linking PR.
   - Question / clarification → one `gh_post_comment`. No branch or PR.
   - Explicit stop / ignore → one acknowledging `gh_post_comment`; halt.

3. Ambiguous directive → one clarifying `gh_post_comment`; stop. NEVER guess.

All side effects MUST use `gh_*` / `classify_issue` / `set_issue_labels`. NEVER shell out to `gh` or `git push`.

Terse. Technical. No emoji.
