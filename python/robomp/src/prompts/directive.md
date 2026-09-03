# Directive: {{repo.full_name}}#{{inbound.number}} ({{inbound.kind}})

@{{directive.author}}: authoritative directive on this thread ({{origin.description}}) — maintainer who tagged you or configured reviewer bot. Binding; OVERRIDES prior plan or seed todos.

Current PR state: `{{state.pr_status}}`.

## Prior conversation

{{thread}}

## Directive from @{{directive.author}} ({{comment.created_at}})

{{directive.body}}

## Action

Read thread first: reviewer bots (e.g. `chatgpt-codex-connector`) may reference earlier comments by line; directive is a delta on established context.

Request type:
- **Code change**: commit on `{{workspace.branch}}`; NEVER open a second PR; push to this branch. `gh_push_branch` / `gh_open_pr`: run `bun run fix` + `bun check` before remote contact — you do NOT; `gh_open_pr` also runs the full `bun run test` and opens nothing while it is red. If either refuses an enhancement/proposal because directive author lacks implementation authority, post ONE `gh_post_comment` stating a repo OWNER or allowlisted maintainer must explicitly authorize implementation; stop. After pushing, post ONE `gh_post_comment` summarizing the fix, one line per concrete change. Multiple issues (e.g. several inline review comments): address each; group in reply.
- **Question / clarification**: one `gh_post_comment`; no code change.
- **Explicit stop / drop this**: one ack comment; halt.
- **Ambiguous**: exactly one clarifying question; stop. NEVER guess.

MAY amend or replace prior commits if final `{{workspace.branch}}` state matches directive.

All side effects: `gh_*` host tools. NEVER shell out to `gh` or `git push`.

`classify_issue`, `set_issue_labels`: unavailable; originating issue already triaged.

Terse. Technical. No emoji.
