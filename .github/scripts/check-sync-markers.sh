#!/usr/bin/env bash
# check-sync-markers.sh — fail while a fork-stack file still carries conflict markers.
# Spec: docs/superpowers/specs/2026-10-17-fork-rebase-stack-design.md §4
#
# No args: scan every file the fork stack touches (merge-base(HEAD, UPSTREAM_REF)..HEAD).
# Args:    scan exactly the given paths (ai-resolve.sh / sync-upstream.sh use this per file).
# Only stack files are scanned: upstream ships legitimate marker fixtures
# (omp's `:conflicts` read selector), so a whole-tree scan would false-positive.
# Env: UPSTREAM_REF (default upstream/main)
# Output: path:line:text per marker line. Exit: 0 clean | 1 markers found
set -euo pipefail
UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"

if [ "$#" -eq 0 ]; then
  PATHS=()
  while IFS= read -r -d '' p; do PATHS+=("$p"); done < <(
    git diff --name-only -z --diff-filter=d "$(git merge-base HEAD "$UPSTREAM_REF")" HEAD
  )
  [ "${#PATHS[@]}" -gt 0 ] || exit 0
  set -- "${PATHS[@]}"
fi

hits=0
for p in "$@"; do
  [ -f "$p" ] || continue
  if grep -HnE '^(<<<<<<<|>>>>>>>)( |$)' -- "$p"; then hits=1; fi
done
exit "$hits"
