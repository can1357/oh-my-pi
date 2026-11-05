#!/usr/bin/env bash
# rebase-forks — move every local feat/* branch onto the fork's integration branch.
#
# The fork mirrors upstream in `main` and lands integration work in
# `integrate/agents-upgrade`; feature branches sit on top of it. After syncing
# the integration branch, run this to move the feature branches forward.
#
# Stops at the first conflict and prints the conflicted files plus the commands
# that finish or abort that rebase. A second run continues with the remaining
# branches only after the in-progress rebase is resolved.
#
# Environment:
#   OMP_FORK_BASE     base branch (default: integrate/agents-upgrade)
#   OMP_FORK_BRANCHES branch glob (default: feat/*)
set -euo pipefail

BASE="${OMP_FORK_BASE:-integrate/agents-upgrade}"
BRANCH_GLOB="${OMP_FORK_BRANCHES:-feat/*}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

die() {
	echo "rebase-forks: $*" >&2
	exit 1
}

git rev-parse --verify --quiet "refs/heads/$BASE" >/dev/null ||
	die "base branch '$BASE' does not exist (set OMP_FORK_BASE)"

git_dir="$(git rev-parse --git-dir)"
for state in rebase-merge rebase-apply; do
	[[ -d "$git_dir/$state" ]] && die "a rebase is already in progress: resolve it with 'git rebase --continue' or 'git rebase --abort' first"
done

[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "worktree has uncommitted changes: commit or stash before rebasing"

start_branch="$(git branch --show-current)"
branches=()
while IFS= read -r branch; do
	[[ -n "$branch" ]] && branches+=("$branch")
done < <(git for-each-ref --format='%(refname:short)' --sort=refname "refs/heads/$BRANCH_GLOB")

[[ ${#branches[@]} -gt 0 ]] || die "no branches match '$BRANCH_GLOB'"

echo "Rebasing ${#branches[@]} branch(es) onto '$BASE'"

repo_root="$(git rev-parse --show-toplevel)"
for branch in "${branches[@]}"; do
	checked_out_in="$(git for-each-ref --format='%(worktreepath)' "refs/heads/$branch")"
	if [[ -n "$checked_out_in" && "$checked_out_in" != "$repo_root" ]]; then
		echo "  ! $branch (checked out in $checked_out_in — skipping)"
		continue
	fi
	if git merge-base --is-ancestor "$BASE" "$branch" 2>/dev/null; then
		echo "  = $branch (already on $BASE)"
		continue
	fi
	echo "  -> $branch"
	if ! git rebase "$BASE" "$branch"; then
		echo "" >&2
		echo "CONFLICT while rebasing '$branch' onto '$BASE'." >&2
		conflicts="$(git diff --name-only --diff-filter=U)"
		if [[ -n "$conflicts" ]]; then
			echo "Conflicted files:" >&2
			echo "$conflicts" | sed 's/^/  /' >&2
			echo "Fix them, then 'git add <files> && git rebase --continue'." >&2
		else
			echo "The rebase failed without conflicted files; inspect it with 'git status'." >&2
		fi
		echo "To give up on this branch: 'git rebase --abort'." >&2
		exit 1
	fi
done

if [[ -n "$start_branch" && "$start_branch" != "$(git branch --show-current)" ]]; then
	git switch "$start_branch"
fi

echo "Done: every branch is on '$BASE'."
