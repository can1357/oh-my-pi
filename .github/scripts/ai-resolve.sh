#!/usr/bin/env bash
# ai-resolve.sh <path>... — let a Command Code model (headless omp) resolve the conflicted
# files of a stopped rebase in place, then keep only what passes the guard.
# Spec: docs/superpowers/specs/2026-10-17-fork-rebase-stack-design.md §2
#
# Never stages, commits or pushes: sync-upstream.sh stages the result. The agent runs in
# a step without write credentials. The index (which holds the conflict stages) and every
# target file are snapshotted first, so anything the agent breaks is restored exactly.
# Env: COMMAND_CODE_API_KEY (required; unset -> AI-SKIPPED)
#      SYNC_AI_MODEL   (default commandcode/z-ai/glm-5.3-flash)
#      SYNC_REPORT_DIR (default <git-dir>/sync-report)
# Output (last line): AI-SKIPPED <why> | AI-FAILED <why> | AI-RESOLVED <R>/<C>
# Exit: 0 unless git itself breaks — the marker files are always the fallback.
set -euo pipefail
export GIT_LITERAL_PATHSPECS=1

HERE=$(cd "$(dirname "$0")" && pwd)
MODEL="${SYNC_AI_MODEL:-commandcode/z-ai/glm-5.3-flash}"
GITDIR=$(git rev-parse --absolute-git-dir)
export SYNC_REPORT_DIR="${SYNC_REPORT_DIR:-$GITDIR/sync-report}"
mkdir -p "$SYNC_REPORT_DIR"

TARGETS=("$@")
C=${#TARGETS[@]}
[ "$C" -gt 0 ] || { echo "AI-SKIPPED no conflicted paths"; exit 0; }
[ -n "${COMMAND_CODE_API_KEY:-}" ] || { echo "AI-SKIPPED COMMAND_CODE_API_KEY unset"; exit 0; }
command -v omp >/dev/null || { echo "AI-SKIPPED omp not installed"; exit 0; }

START=$(git rev-parse HEAD)
SNAP=$(mktemp -d)
trap 'rm -rf "$SNAP"' EXIT
cp "$GITDIR/index" "$SNAP/index"
UNTRACKED_BEFORE=$(git ls-files --others --exclude-standard)
DIRTY_BEFORE=$(git diff --name-only) # conflicted paths show up here too
i=0
for p in "${TARGETS[@]}"; do
  [ -f "$p" ] && cp -p -- "$p" "$SNAP/t$i"
  i=$((i + 1))
done
printf '%s\n' "${TARGETS[@]}" > "$SYNC_REPORT_DIR/ai-targets.txt"

restore_target() { # <index>: put the marker version (or its absence) back
  local p=${TARGETS[$1]}
  if [ -f "$SNAP/t$1" ]; then cp -p -- "$SNAP/t$1" "$p"; else rm -f -- "$p"; fi
}
same_as_snapshot() { # <index>
  local p=${TARGETS[$1]}
  if [ -f "$SNAP/t$1" ]; then [ -f "$p" ] && cmp -s -- "$SNAP/t$1" "$p"; else [ ! -e "$p" ]; fi
}
is_target() {
  local t
  for t in "${TARGETS[@]}"; do [ "$t" = "$1" ] && return 0; done
  return 1
}
drop_new_untracked() {
  comm -13 <(printf '%s\n' "$UNTRACKED_BEFORE" | sort) \
    <(git ls-files --others --exclude-standard | sort) \
    | while IFS= read -r p; do
        [ -n "$p" ] || continue
        is_target "$p" && continue
        rm -f -- "$p"
        echo "UNTRACKED $p removed"
      done
}
redact() { # keep the key out of anything that may be uploaded as an artifact
  [ -f "$1" ] && KEY="$COMMAND_CODE_API_KEY" perl -pi -e 's/\Q$ENV{KEY}\E/[REDACTED]/g' "$1"
  return 0
}

set +e
omp -p --no-session --auto-approve --model "$MODEL" "@$HERE/../prompts/resolve-conflicts.md" \
  >> "$SYNC_REPORT_DIR/ai-transcript.txt" 2>&1
rc=$?
set -e
redact "$SYNC_REPORT_DIR/ai-transcript.txt"
redact "$SYNC_REPORT_DIR/ai-notes.md"

# Undo anything the agent committed or staged: HEAD and the conflict index come back.
[ "$(git rev-parse HEAD)" = "$START" ] || git reset -q --soft "$START"
cp "$SNAP/index" "$GITDIR/index"

if [ "$rc" -ne 0 ]; then
  for ((i = 0; i < C; i++)); do restore_target "$i"; done
  drop_new_untracked
  echo "AI-FAILED omp exited $rc"
  exit 0
fi

# --- guard: trust nothing the agent claims -----------------------------------
while IFS= read -r p; do
  [ -n "$p" ] || continue
  is_target "$p" && continue
  printf '%s\n' "$DIRTY_BEFORE" | grep -qxF -- "$p" && continue
  git checkout -q -- "$p"
  echo "OUT-OF-SCOPE $p reverted"
done < <(git diff --name-only)
drop_new_untracked

R=0
: > "$SYNC_REPORT_DIR/ai-resolved.txt"
for ((i = 0; i < C; i++)); do
  p=${TARGETS[$i]}
  same_as_snapshot "$i" && continue # untouched: markers stay
  if [ -f "$p" ] && bash "$HERE/check-sync-markers.sh" "$p" >/dev/null \
    && ! grep -qF -- "$COMMAND_CODE_API_KEY" "$p"; then
    echo "$p" >> "$SYNC_REPORT_DIR/ai-resolved.txt"
    R=$((R + 1))
  else
    restore_target "$i"
    echo "PARTIAL $p reverted"
  fi
done
echo "AI-RESOLVED $R/$C"
