# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `blyzer/oh-my-pi`. Use the `gh` CLI from this clone.

## Conventions
- Create/read/list/comment/label/close issues with `gh issue` commands.
- Before the first issue creation, verify the target with `gh repo view --json nameWithOwner`; file only in the user's own repo.
- Prefer native GitHub sub-issues and issue dependencies for parent/child and blocking relationships; if unavailable, use `Part of #N` and `Blocked by: #N` in the issue body.
- A skill's “publish to the issue tracker” means create a GitHub issue; “fetch the relevant ticket” means read it with `gh issue view`.

## Pull requests as a triage surface
PRs as a request surface: no. Leave this off unless the repo later decides to triage external PRs as requests.

## Wayfinding
Use a parent issue for the map and child issues for tickets; prefer GitHub sub-issues. If unavailable, use a task list and `Part of #N`.
