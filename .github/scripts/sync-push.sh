#!/usr/bin/env bash
# sync-push.sh — publish what sync-upstream.sh left in $SYNC_REPORT_DIR/result.env.
# Spec: docs/superpowers/specs/2026-10-17-fork-rebase-stack-design.md §2
#
# clean + tests pass -> old main saved to main-prev, HEAD force-pushed to main (leased on OLD)
# anything else      -> HEAD force-pushed to SYNC_BRANCH for the conflict PR
# Every push is leased: a main or sync branch that moved since the run started is never
# overwritten; the push fails and the next run starts from the new state.
# Env: SYNC_BRANCH (default sync/rebase), SYNC_REPORT_DIR (default <git-dir>/sync-report)
# Output (last line): UP-TO-DATE | PROMOTED <sha> | STAGED <sha>. Exit: 0 | 1 push rejected
set -euo pipefail

SYNC_BRANCH="${SYNC_BRANCH:-sync/rebase}"
REPORT_DIR="${SYNC_REPORT_DIR:-$(git rev-parse --absolute-git-dir)/sync-report}"
# shellcheck disable=SC1091 # written by sync-upstream.sh
. "$REPORT_DIR/result.env"
NEW=$(git rev-parse HEAD)

if [ "$STATUS" = "up-to-date" ]; then
  echo "UP-TO-DATE"
  exit 0
fi

if [ "$STATUS" = "clean" ] && [ "$TESTS" = "pass" ]; then
  git push -q --force origin "$OLD:refs/heads/main-prev"
  git push -q --force-with-lease="main:$OLD" origin "HEAD:refs/heads/main" \
    || { echo "ERROR: main moved since $OLD; not overwritten" >&2; exit 1; }
  # a stale conflict branch from an earlier run is obsolete once main moved on
  git push -q origin --delete "$SYNC_BRANCH" 2>/dev/null || true
  echo "PROMOTED $NEW"
  exit 0
fi

LEASE=$(git ls-remote origin "refs/heads/$SYNC_BRANCH" | cut -f1)
git push -q --force-with-lease="$SYNC_BRANCH:$LEASE" origin "HEAD:refs/heads/$SYNC_BRANCH" \
  || { echo "ERROR: $SYNC_BRANCH moved during the run; not overwritten" >&2; exit 1; }
echo "STAGED $NEW"
