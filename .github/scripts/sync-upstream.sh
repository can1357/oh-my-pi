#!/usr/bin/env bash
# sync-upstream.sh — rebase this fork's commit stack onto upstream main, locally.
# Fork-owned (LaansDole/research-harness).
# Spec: docs/superpowers/specs/2026-10-17-fork-rebase-stack-design.md
#
# main = <upstream commit> + the fork stack (merge-base(origin/main, upstream/main)..origin/main).
# This script never pushes: it leaves the rebased stack on SYNC_BRANCH and writes
# $SYNC_REPORT_DIR/result.env for sync-push.sh, which runs in a credentialed step.
#
# Conflicts: ai-resolve.sh (if COMMAND_CODE_API_KEY is set) resolves them in place;
# whatever it cannot resolve is committed WITH markers so the rebase can finish.
#
# Env: UPSTREAM_URL    (default https://github.com/can1357/oh-my-pi.git)
#      SYNC_BRANCH     (default sync/rebase)
#      SYNC_GATE       (default "bash research/tests/run.sh && bash .github/tests/run_tests.sh")
#      SYNC_REPORT_DIR (default <git-dir>/sync-report; never inside the worktree)
# result.env: STATUS=up-to-date|clean|conflicts OLD BASE UP K U TESTS=pass|fail|skipped
# Exit: 0 (result.env written) | 1 failed
set -euo pipefail
export GIT_LITERAL_PATHSPECS=1 # conflict paths are data, never globs

HERE=$(cd "$(dirname "$0")" && pwd)
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/can1357/oh-my-pi.git}"
SYNC_BRANCH="${SYNC_BRANCH:-sync/rebase}"
GATE="${SYNC_GATE:-bash research/tests/run.sh && bash .github/tests/run_tests.sh}"
export SYNC_REPORT_DIR="${SYNC_REPORT_DIR:-$(git rev-parse --absolute-git-dir)/sync-report}"
REPORT_DIR="$SYNC_REPORT_DIR"

fail() { echo "ERROR: $*" >&2; exit 1; }
result() { # <status> [tests]: the contract sync-push.sh reads
  {
    echo "STATUS=$1"
    echo "OLD=$OLD" "BASE=$BASE" "UP=$UP"
    echo "K=${K:-0}" "U=${U:-0}" "TESTS=${2:-skipped}"
  } | tr ' ' '\n' > "$REPORT_DIR/result.env"
  cat "$REPORT_DIR/result.env"
}
rebasing() { [ -d "$GITDIR/rebase-merge" ] || [ -d "$GITDIR/rebase-apply" ]; }

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
git fetch -q origin main
git fetch -q upstream main
GITDIR=$(git rev-parse --absolute-git-dir)
rm -rf "$REPORT_DIR"
mkdir -p "$REPORT_DIR"

OLD=$(git rev-parse origin/main)
UP=$(git rev-parse upstream/main)
BASE=$(git merge-base "$OLD" "$UP")
if [ "$BASE" = "$UP" ]; then
  result up-to-date
  echo "UP-TO-DATE"
  exit 0
fi
echo "upstream ahead by $(git rev-list --count "$BASE..$UP") commits; stack is $(git rev-list --count "$BASE..$OLD") commits"
git shortlog --no-merges "$BASE..$UP" </dev/null > "$REPORT_DIR/shortlog.txt"
git diff --stat "$BASE" "$UP" > "$REPORT_DIR/diffstat.txt"

git checkout -q -B "$SYNC_BRANCH" "$OLD"
# conflicts.txt: "<stack commit subject>\t<path>"; unresolved.txt: paths left with markers
: > "$REPORT_DIR/conflicts.txt"
: > "$REPORT_DIR/unresolved.txt"
K=0 U=0

set +e
git rebase -q --onto "$UP" "$BASE" >> "$REPORT_DIR/rebase.log" 2>&1
set -e
STOPS=0
while rebasing; do
  STOPS=$((STOPS + 1))
  [ "$STOPS" -le 100 ] || fail "rebase did not finish after 100 stops"
  PATHS=()
  while IFS= read -r -d '' p; do PATHS+=("$p"); done < <(git diff --name-only --diff-filter=U -z)
  if [ "${#PATHS[@]}" -eq 0 ]; then
    # a fork commit whose changes upstream already has: nothing left to apply
    git diff --cached --quiet || fail "rebase stopped without conflicts (see $REPORT_DIR/rebase.log)"
    echo "EMPTY $(git log -1 --format=%s REBASE_HEAD) dropped" | tee -a "$REPORT_DIR/rebase.log"
    git rebase --skip >> "$REPORT_DIR/rebase.log" 2>&1 || true
    continue
  fi
  SUBJECT=$(git log -1 --format=%s REBASE_HEAD)
  for p in "${PATHS[@]}"; do printf '%s\t%s\n' "$SUBJECT" "$p" >> "$REPORT_DIR/conflicts.txt"; done
  K=$((K + ${#PATHS[@]}))

  bash "$HERE/ai-resolve.sh" "${PATHS[@]}" | tee -a "$REPORT_DIR/ai.log"
  for p in "${PATHS[@]}"; do
    if [ -f "$p" ] && ! bash "$HERE/check-sync-markers.sh" "$p" >/dev/null; then
      echo "$p" >> "$REPORT_DIR/unresolved.txt"
      U=$((U + 1))
    fi
    # present -> add (resolved or with markers), absent -> record the deletion
    if [ -e "$p" ]; then git add -- "$p"; else git rm -q --cached -- "$p"; fi
  done
  GIT_EDITOR=true git rebase --continue >> "$REPORT_DIR/rebase.log" 2>&1 || true
done
git merge-base --is-ancestor "$UP" HEAD || fail "rebase did not land on upstream (see $REPORT_DIR/rebase.log)"

if [ "$U" -gt 0 ]; then
  result conflicts skipped
  exit 0
fi
if (eval "$GATE") > "$REPORT_DIR/gate.log" 2>&1; then TESTS=pass; else TESTS=fail; fi
if [ "$K" -eq 0 ]; then result clean "$TESTS"; else result conflicts "$TESTS"; fi
