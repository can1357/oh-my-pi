#!/usr/bin/env bash
# sync-pr-body.sh — write the conflict-PR body for a staged rebase (sync/rebase = HEAD).
# Spec: docs/superpowers/specs/2026-10-17-fork-rebase-stack-design.md §3
#
# Reads $SYNC_REPORT_DIR/result.env and the report files sync-upstream.sh / ai-resolve.sh
# left behind. The `fork-sync-old` comment is machine-read by fork-promote.yml (lease sha).
# Env: SYNC_REPORT_DIR (default <git-dir>/sync-report),
#      GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID (links; optional)
# Writes: $SYNC_REPORT_DIR/pr-body.md
set -euo pipefail

REPORT_DIR="${SYNC_REPORT_DIR:-$(git rev-parse --absolute-git-dir)/sync-report}"
BODY="$REPORT_DIR/pr-body.md"
LIMIT=60000 # GitHub caps PR bodies at 65536 chars
# shellcheck disable=SC1091 # written by sync-upstream.sh
. "$REPORT_DIR/result.env"
SERVER="${GITHUB_SERVER_URL:-https://github.com}"
short() { git rev-parse --short "$1"; }

ROWS=""
while IFS=$'\t' read -r subject p; do
  [ -n "$p" ] || continue
  if grep -qxF -- "$p" "$REPORT_DIR/unresolved.txt" 2>/dev/null; then
    cell="**UNRESOLVED**"
  elif grep -qxF -- "$p" "$REPORT_DIR/ai-resolved.txt" 2>/dev/null; then
    cell="AI"
  else
    cell="resolved"
  fi
  ROWS+="| \`$p\` | $subject | $cell |"$'\n'
done < "$REPORT_DIR/conflicts.txt"

RANGE_DIFF=$(git range-diff --no-color "$BASE..$OLD" "$UP..HEAD" 2>&1 || true)

{
  echo "<!-- fork-sync-old: $OLD -->"
  echo "Fork stack rebased from upstream \`$(short "$BASE")\` onto \`$(short "$UP")\` — **$(git rev-list --count "$BASE..$UP") upstream commits**, stack of $(git rev-list --count "$UP..HEAD") commits."
  echo
  echo "Conflicts: **$K** ($U unresolved). Tests on the rebased tree: **$TESTS**."
  if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    echo
    echo "Fork stack after rebase: $SERVER/$GITHUB_REPOSITORY/compare/$(short "$UP")...sync/rebase"
  fi
  if [ -n "$ROWS" ]; then
    printf '\n| path | stack commit | resolution |\n| --- | --- | --- |\n%s' "$ROWS"
  fi
  if [ -s "$REPORT_DIR/ai-notes.md" ]; then
    printf '\n**AI notes**\n\n'
    cat "$REPORT_DIR/ai-notes.md"
  fi
  printf '\n<details open><summary>Stack range-diff (before → after)</summary>\n\n````\n'
  printf '%s\n' "${RANGE_DIFF:0:LIMIT-4000}"
  printf '\n````\n\n</details>\n'
  cat <<'EOF'

## To land

1. Fix anything **UNRESOLVED** or failing: push commits to `sync/rebase` (amend the stack commit with `git rebase -i` if you want it folded in).
2. Wait for `Sync guard` to go green.
3. Add the **`promote`** label. `fork-promote.yml` force-pushes `sync/rebase` to `main` (old `main` saved as `main-prev`) and closes this PR.

Do **not** use the merge button: that would merge upstream history into the old stack instead of replacing it.
EOF
  if [ -n "${GITHUB_RUN_ID:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
    echo
    echo "Full report (upstream shortlog, diffstat, logs): $SERVER/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID (artifact \`sync-report\`)."
  fi
} > "$BODY"
