#!/usr/bin/env bash
# omp-fork — run this fork's coding agent against an isolated profile.
#
# Isolation contract:
#   PI_CODING_AGENT_DIR=$HOME/.omp-fork
# so fork runs never read or write the production profile in ~/.omp. The
# launcher refuses to run with OMP_PROFILE/PI_PROFILE set: an active named
# profile derives its agent dir under ~/.omp/profiles and ignores
# PI_CODING_AGENT_DIR, which would silently drop the isolation.
#
# Install: install -m 755 scripts/omp-fork.sh ~/.local/bin/omp-fork
set -euo pipefail

FORK_ROOT="${OMP_FORK_ROOT:-$HOME/Documents/oh-my-pi}"
CLI="$FORK_ROOT/packages/coding-agent/src/cli.ts"
PROFILE_DIR="$HOME/.omp-fork"

if [[ -n "${OMP_PROFILE:-}" || -n "${PI_PROFILE:-}" ]]; then
	echo "omp-fork: refusing to run with OMP_PROFILE/PI_PROFILE set" >&2
	echo "  a named profile ignores PI_CODING_AGENT_DIR and would use ~/.omp/profiles/<name>" >&2
	echo "  unset OMP_PROFILE (and PI_PROFILE) and retry" >&2
	exit 64
fi

if [[ ! -f "$CLI" ]]; then
	echo "omp-fork: fork checkout not found: $CLI" >&2
	echo "  clone the fork to $FORK_ROOT or set OMP_FORK_ROOT to its root" >&2
	exit 66
fi

mkdir -p "$PROFILE_DIR"
export PI_CODING_AGENT_DIR="$PROFILE_DIR"
exec bun "$CLI" "$@"
