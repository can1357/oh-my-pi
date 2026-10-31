#!/usr/bin/env bash
#
# Report what this CI run changes, measured from the merge base, so a job can
# skip work its inputs do not need.
#
#   scripts/ci-changed-paths.sh <pathspec>...   changed paths, one per line
#   scripts/ci-changed-paths.sh --print-base    the merge base commit
#
# Exit 0: the answer is known. For pathspecs, empty stdout is the only answer
#         that lets a caller skip.
# Exit 3: the answer is unknown; stderr says why. A caller must run (or fail),
#         never skip.
#
# The base comes from the GitHub event, never from `CI` or a local branch:
#   pull_request  HEAD is the merge commit GitHub built (refs/pull/N/merge).
#                 Its first parent is the base branch tip the PR merges into,
#                 which is also merge-base(HEAD^1, HEAD).
#   push          `before` in the payload, the branch tip the push replaced.
#                 A push that is not forced is a fast-forward, so `before` is
#                 an ancestor of HEAD and is the merge base. A forced push or
#                 a new branch has no usable base.
#   anything else (workflow_dispatch, schedule, ...) has no base.
#
# The diff never starts at a base tip that HEAD does not contain: a two-dot
# diff against a moved base reports the base's own commits as this run's.
# `--no-renames` keeps both sides of a rename, so moving a file out of a
# pathspec still counts as a change to it.
#
# Needs `actions/checkout` with `fetch-depth: 2`; a push that replaced more
# than one commit fetches `before` (tree only) by its SHA.
set -uo pipefail

unknown() {
	echo "ci-changed-paths: $*" >&2
	exit 3
}

print_base=false
if [ "${1:-}" = "--print-base" ]; then
	print_base=true
	shift
	[ "$#" -eq 0 ] || unknown "--print-base takes no pathspec"
elif [ "$#" -eq 0 ]; then
	unknown "no pathspec given"
fi

zero=0000000000000000000000000000000000000000
case "${GITHUB_EVENT_NAME:-}" in
	pull_request)
		base=$(git rev-parse --verify --quiet 'HEAD^1') || unknown "HEAD^1 is missing (checkout needs fetch-depth: 2)"
		git rev-parse --verify --quiet 'HEAD^2' >/dev/null \
			|| unknown "HEAD is not a merge commit (checkout ref is not refs/pull/N/merge)"
		merge_base=$(git merge-base "$base" HEAD 2>/dev/null) || unknown "no merge base between HEAD^1 and HEAD"
		;;
	push)
		event=${GITHUB_EVENT_PATH:-/dev/null}
		before=$(jq -r '.before // empty' "$event" 2>/dev/null) || unknown "cannot read the push payload"
		# Not `.forced // empty`: jq's `//` treats false as missing.
		forced=$(jq -r '.forced' "$event" 2>/dev/null) || unknown "cannot read the push payload"
		[ -n "$before" ] && [ "$before" != "$zero" ] || unknown "push created the branch; there is no previous tip"
		[ "$forced" = false ] || unknown "push was not a fast-forward (forced=$forced); the previous tip need not be an ancestor"
		if ! git cat-file -e "$before^{commit}" 2>/dev/null; then
			git fetch --no-tags --quiet --depth=1 --filter=blob:none origin "$before" 2>/dev/null \
				|| unknown "cannot fetch the previous tip $before"
		fi
		merge_base=$before
		;;
	*)
		unknown "event '${GITHUB_EVENT_NAME:-unset}' has no base to compare against"
		;;
esac

if $print_base; then
	echo "$merge_base"
	exit 0
fi
echo "ci-changed-paths: $GITHUB_EVENT_NAME, diff from merge base $merge_base to $(git rev-parse HEAD)" >&2
git diff --no-renames --name-only "$merge_base" HEAD -- "$@" || unknown "git diff from $merge_base failed"
