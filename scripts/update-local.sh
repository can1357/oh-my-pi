#!/usr/bin/env bash
# Update omp from a local checkout.
#
#   scripts/update-local.sh [--allow-dirty] [--no-sync] [--no-push]
#                           [--force-reset] [--resolve-ai] [branch]
#                           [-- install-local args...]
#
# Upstream (can1357/oh-my-pi) is always read from its `main` branch.
# <branch> (default: dev) is the fork working branch: it is created from
# origin/main (ynsr) if missing so fork-specific commits are preserved,
# then rebased onto upstream/main and pushed to origin. With --force-reset,
# origin/main is afterwards reset to exactly upstream/main (fork-only
# commits on main are discarded — they live on <branch>).
# Finally <branch> is fast-forward pulled from origin and reinstalled via
# scripts/install-local.sh in wrapper mode.
# Extra args after `--` are forwarded to install-local.sh.
#
# Examples:
#   scripts/update-local.sh
#   scripts/update-local.sh staging
#   scripts/update-local.sh dev -- --mode binary
#   scripts/update-local.sh --no-sync   # origin only, skip upstream rebase
set -euo pipefail

ALLOW_DIRTY=0
BRANCH="dev"
BRANCH_SET=0
INSTALL_ARGS=()
UPSTREAM_REMOTE="upstream"
UPSTREAM_URL="https://github.com/can1357/oh-my-pi.git"
UPSTREAM_BRANCH="main"
FORCE_RESET=0
RESOLVE_AI=0
NO_SYNC=0
NO_PUSH=0

usage() {
	cat <<'EOF'
Usage: update-local.sh [--allow-dirty] [--no-sync] [--no-push]
                       [--force-reset] [--resolve-ai]
                       [--upstream-remote NAME] [--upstream-url URL]
                       [--upstream-branch NAME]
                       [branch] [-- install-local args...]

  branch            fork working branch to sync, push, and install
                    (default: dev); upstream side is always upstream/main
  --allow-dirty     proceed even with uncommitted changes (may still fail
                    on checkout/rebase if files conflict)
  --no-sync         skip upstream rebase; update from origin only
  --no-push         rebase locally but do not push the result to origin
  --force-reset     after pushing <branch>, reset origin/main to exactly
                    upstream/main (discards fork-only commits on main)
  --resolve-ai      on rebase conflict, ask `omp --auto-approve -p` to
                    resolve markers in place; on agent failure, abort and
                    print manual recovery steps (default: abort immediately)
  --upstream-remote remote name for can1357/oh-my-pi (default: upstream)
  --upstream-url    URL used when adding the upstream remote
                    (default: https://github.com/can1357/oh-my-pi.git)
  --upstream-branch upstream branch to sync from (default: main)
  -- ARGS...        forwarded to scripts/install-local.sh
  -h, --help        show this help

Defaults to wrapper mode unless --mode is forwarded.
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		-h | --help)
			usage
			exit 0
			;;
		--allow-dirty)
			ALLOW_DIRTY=1
			shift
			;;
		--no-sync)
			NO_SYNC=1
			shift
			;;
		--no-push)
			NO_PUSH=1
			shift
			;;
		--force-reset)
			FORCE_RESET=1
			shift
			;;
		--resolve-ai)
			RESOLVE_AI=1
			shift
			;;
		--upstream-remote)
			UPSTREAM_REMOTE="${2-}"
			[ -n "$UPSTREAM_REMOTE" ] || { printf 'error: --upstream-remote needs a value\n' >&2; exit 1; }
			shift 2
			;;
		--upstream-url)
			UPSTREAM_URL="${2-}"
			[ -n "$UPSTREAM_URL" ] || { printf 'error: --upstream-url needs a value\n' >&2; exit 1; }
			shift 2
			;;
		--upstream-branch)
			UPSTREAM_BRANCH="${2-}"
			[ -n "$UPSTREAM_BRANCH" ] || { printf 'error: --upstream-branch needs a value\n' >&2; exit 1; }
			shift 2
			;;
		--)
			shift
			INSTALL_ARGS+=("$@")
			break
			;;
		-*)
			printf 'error: unknown option: %s\n' "$1" >&2
			usage >&2
			exit 1
			;;
		*)
			if [ "$BRANCH_SET" -eq 0 ]; then
				BRANCH="$1"
				BRANCH_SET=1
				shift
			else
				printf 'error: unexpected argument: %s\n' "$1" >&2
				usage >&2
				exit 1
			fi
			;;
	esac
done

step() { printf '\n▶ %s\n' "$1"; }
done_step() { printf '✓ %s\n' "$1"; }

if [ -n "${OMP_REPO_ROOT-}" ]; then
	REPO_ROOT="$OMP_REPO_ROOT"
else
	SCRIPT_PATH="${BASH_SOURCE[0]}"
	while [ -L "$SCRIPT_PATH" ]; do
		LINK_TARGET=$(readlink "$SCRIPT_PATH")
		case "$LINK_TARGET" in
			/*) SCRIPT_PATH="$LINK_TARGET" ;;
			*) SCRIPT_PATH="$(dirname -- "$SCRIPT_PATH")/$LINK_TARGET" ;;
		esac
	done
	REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$SCRIPT_PATH")/.." && pwd -P)
fi
cd "$REPO_ROOT"

git rev-parse --git-dir >/dev/null 2>&1 ||
	{ printf 'error: not a git checkout: %s\n' "$REPO_ROOT" >&2; exit 1; }

if [ "$NO_SYNC" -eq 0 ]; then
	if git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
		step "upstream remote: $UPSTREAM_REMOTE ($(git remote get-url "$UPSTREAM_REMOTE"))"
	else
		step "add $UPSTREAM_REMOTE remote ($UPSTREAM_URL)"
		git remote add -t "$UPSTREAM_BRANCH" "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
	fi
	# Pin the upstream remote to UPSTREAM_BRANCH only: rewrite any stale
	# wildcard fetch refspec so no other upstream branch is ever pulled.
	git config "remote.$UPSTREAM_REMOTE.fetch" "+refs/heads/$UPSTREAM_BRANCH:refs/remotes/$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
	step "fetch $UPSTREAM_REMOTE/$UPSTREAM_BRANCH (main only)"
	git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
fi

step "fetch origin"
git fetch origin

if [ "$ALLOW_DIRTY" -eq 0 ] && [ -n "$(git status --porcelain)" ]; then
	printf 'error: working tree is dirty; commit, stash, or pass --allow-dirty\n' >&2
	git status --short >&2
	exit 1
fi

ensure_branch() {
	# ensure_branch <name> <fallback-ref>: checkout existing local branch,
	# track origin/<name>, or create it at <fallback-ref>.
	local name="$1" fallback="$2"
	if git show-ref --verify --quiet "refs/heads/$name"; then
		git checkout "$name"
	elif git show-ref --verify --quiet "refs/remotes/origin/$name"; then
		git checkout --track "origin/$name"
	elif git rev-parse --verify --quiet "$fallback" >/dev/null; then
		printf 'warning: no local or origin branch named %s; creating at %s\n' "$name" "$fallback" >&2
		git checkout -B "$name" "$fallback"
	else
		printf 'error: no local or origin branch named %s (and fallback %s missing)\n' "$name" "$fallback" >&2
		exit 1
	fi
}

UPSTREAM_REF="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"

if [ "$BRANCH" = "main" ] && [ "$FORCE_RESET" -eq 1 ]; then
	printf 'error: --force-reset cannot target main itself; pass a fork branch (e.g. dev)\n' >&2
	exit 1
fi

# Local main stays a clean mirror of upstream; fork work lives on $BRANCH.
if [ "$NO_SYNC" -eq 0 ]; then
	step "update local main to $UPSTREAM_REF"
	ensure_branch main "$UPSTREAM_REF"
	git pull --ff-only "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
	done_step "main at $(git rev-parse --short HEAD)"
fi

if [ "$BRANCH" != "main" ]; then
	step "checkout $BRANCH"
	# New fork branches start from origin/main (ynsr) so fork-specific
	# commits are preserved, then get rebased onto upstream/main below.
	ensure_branch "$BRANCH" "origin/main"
fi

print_manual_recovery() {
	# print_manual_recovery <upstream-ref>: context for hand-resolving a
	# conflict after the rebase was aborted and the branch is unchanged.
	local ref="$1" files commit
	printf '\nerror: rebase onto %s failed; aborted, local branch unchanged\n' "$ref" >&2
	printf '\nConflicted files:\n' >&2
	git diff --name-only --diff-filter=U >&2 || true
	files=$(git diff --name-only --diff-filter=U || true)
	if [ -n "$files" ]; then
		printf '\nWhat upstream changed in those files:\n' >&2
		while IFS= read -r commit; do
			[ -n "$commit" ] || continue
			git log --oneline "$ref" -- "$commit" | head -5 >&2
		done <<EOFILES
$files
EOFILES
	fi
	printf '\nWhat your branch changed (commits being replayed):\n' >&2
	git log --oneline "$ref..HEAD" | head -10 >&2
	cat >&2 <<'EOFSTEPS'

To resolve manually:
  1. git checkout -b resolve/dev-<date>   # never resolve on dev directly
  2. git rebase <upstream-ref>            # reproduce the conflict
  3. edit markers, git add <files>, git rebase --continue
     (or `git checkout --theirs -- <file>` if upstream already did it,
      `git rebase --skip` if your commit is now obsolete)
  4. git checkout dev && git reset --hard resolve/dev-<date>
  5. re-run omp-update
EOFSTEPS
}

resolve_conflict_ai() {
	# resolve_conflict_ai <upstream-ref>: the rebase is paused with markers
	# in the worktree. Ask the omp agent to resolve, stage, and continue.
	# Returns 0 only if the rebase completes with a clean tree.
	local ref="$1" files prompt
	files=$(git diff --name-only --diff-filter=U || true)
	[ -n "$files" ] || return 1
	command -v omp >/dev/null 2>&1 || return 1
	prompt="You are resolving a git rebase conflict in $REPO_ROOT.
Rebase of $BRANCH onto $ref is paused. Conflicted files:
$files

Rules:
1. Read each conflicted file, understand BOTH sides (ours = fork commits, theirs = upstream).
2. Prefer upstream code for shared logic; keep fork-specific behavior (INSTALL.md docs, fork tooling, update-local.sh) intact.
3. If upstream already implemented what a fork commit did, prefer upstream and drop the duplicate.
4. NEVER leave conflict markers. NEVER commit — only resolve files and \`git add\` them.
5. When every conflicted file is staged and marker-free, run \`git rebase --continue\`. If further conflicts appear in later commits, repeat.
6. If a commit is fully obsolete (upstream supersedes it), run \`git rebase --skip\` for that step.
7. Verify with \`git status\` and \`git diff --check\` before continuing past each step."
	if omp --auto-approve -p "$prompt"; then
		! git rev-parse --verify --quiet REBASE_HEAD >/dev/null \
			&& [ -z "$(git diff --name-only --diff-filter=U || true)" ] \
			&& [ -z "$(git status --porcelain)" ]
	else
		return 1
	fi
}

if [ "$NO_SYNC" -eq 0 ]; then
	step "rebase $BRANCH onto $UPSTREAM_REF"
	BEFORE=$(git rev-parse HEAD)
	if git rebase "$UPSTREAM_REF"; then
		AFTER=$(git rev-parse HEAD)
		if [ "$BEFORE" != "$AFTER" ] && [ "$NO_PUSH" -eq 0 ]; then
			step "push rebased $BRANCH to origin (updates fork)"
			git push --force-with-lease origin "$BRANCH"
			PUSHED=1
		else
			PUSHED=0
		fi
	elif [ "$RESOLVE_AI" -eq 1 ]; then
		step "rebase conflict — asking omp agent to resolve"
		if resolve_conflict_ai "$UPSTREAM_REF"; then
			AFTER=$(git rev-parse HEAD)
			done_step "agent resolved rebase at $AFTER"
			if [ "$BEFORE" != "$AFTER" ] && [ "$NO_PUSH" -eq 0 ]; then
				step "push rebased $BRANCH to origin (updates fork)"
				git push --force-with-lease origin "$BRANCH"
				PUSHED=1
			else
				PUSHED=0
			fi
		else
			printf 'warning: AI resolution failed or agent errored; aborting\n' >&2
			git rebase --abort || true
			print_manual_recovery "$UPSTREAM_REF"
			exit 1
		fi
	else
		git rebase --abort || true
		print_manual_recovery "$UPSTREAM_REF"
		exit 1
	fi
else
	PUSHED=0
fi

if [ "$NO_PUSH" -eq 0 ] && [ "$PUSHED" -eq 0 ] \
	&& git show-ref --verify --quiet "refs/remotes/origin/$BRANCH" \
	&& [ "$(git rev-parse "origin/$BRANCH")" != "$(git rev-parse HEAD)" ] \
	&& git merge-base --is-ancestor "origin/$BRANCH" HEAD; then
	step "push $BRANCH to origin (updates fork)"
	git push origin "$BRANCH"
fi

# Push-then-reset: dev is safe on origin before origin/main is mirrored.
if [ "$FORCE_RESET" -eq 1 ] && [ "$NO_SYNC" -eq 0 ] && [ "$NO_PUSH" -eq 0 ]; then
	step "reset origin/main to $UPSTREAM_REF (exact mirror)"
	git push --force-with-lease=refs/heads/main:origin/main origin "$UPSTREAM_REF:refs/heads/main"
	git fetch origin main
	done_step "origin/main mirrors $UPSTREAM_REF"
elif [ "$FORCE_RESET" -eq 1 ] && [ "$NO_SYNC" -eq 1 ]; then
	printf 'warning: --force-reset needs upstream sync; skipping reset (--no-sync)\n' >&2
elif [ "$FORCE_RESET" -eq 1 ] && [ "$NO_PUSH" -eq 1 ]; then
	printf 'warning: --force-reset implies pushing; skipping reset (--no-push)\n' >&2
fi

if [ "$NO_PUSH" -eq 1 ] && [ "$PUSHED" -eq 0 ] \
	&& git show-ref --verify --quiet "refs/remotes/origin/$BRANCH" \
	&& [ "$(git rev-parse "origin/$BRANCH")" != "$(git rev-parse HEAD)" ] \
	&& ! git merge-base --is-ancestor "origin/$BRANCH" HEAD; then
	printf 'warning: local %s diverged from origin/%s after rebase; skipping pull (--no-push)\n' "$BRANCH" "$BRANCH" >&2
	done_step "synced to $(git rev-parse --short HEAD) (not pushed, not pulled)"
else
	step "pull origin/$BRANCH"
	git pull --ff-only origin "$BRANCH"
	done_step "updated to $(git rev-parse --short HEAD)"
fi

# Default to wrapper mode unless the caller overrides --mode.
HAS_MODE=0
for arg in ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}; do
	if [ "$arg" = "--mode" ]; then
		HAS_MODE=1
		break
	fi
done
if [ "$HAS_MODE" -eq 0 ]; then
	INSTALL_ARGS=(--mode wrapper ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"})
fi
step "install (${INSTALL_ARGS[*]})"
exec "$REPO_ROOT/scripts/install-local.sh" "${INSTALL_ARGS[@]}"
