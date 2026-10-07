#!/usr/bin/env bash
# Install omp from a local checkout.
#
#   scripts/install-local.sh [--mode wrapper|binary] [--prefix DIR]
#                            [--skip-deps] [--skip-native]
#
#   wrapper  (default) source-linked dev launcher; repo edits are live, no rebuild.
#   binary             compiled standalone binary (packages/coding-agent/dist/omp)
#                      copied into the Bun global bin directory.
#
# Run from anywhere; the script locates the repository through its own path.
# See INSTALL.md for prerequisites and troubleshooting.
set -euo pipefail

MODE=wrapper
PREFIX=""
PREFIX_SET=0
SKIP_DEPS=0
SKIP_NATIVE=0

usage() {
	cat <<'EOF'
Install omp from this repository.

Usage: scripts/install-local.sh [options]

Options:
  --mode wrapper|binary   Install mode (default: wrapper).
  --prefix DIR            Binary mode: install directory (default: Bun global bin).
  --skip-deps             Skip `bun install`.
  --skip-native           Skip `bun run build:native` (addon already built).
  -h, --help              Show this help.

Modes:
  wrapper   Installs the source-linked launcher as `omp`. Edits under
            packages/coding-agent/src take effect immediately.
  binary    Builds a standalone binary and installs it. Self-contained, but
            requires a rebuild per change.
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--mode)
			MODE="${2:-}"
			shift 2
			;;
		--mode=*)
			MODE="${1#*=}"
			shift
			;;
		--prefix)
			PREFIX="${2:-}"
			PREFIX_SET=1
			shift 2
			;;
		--prefix=*)
			PREFIX="${1#*=}"
			PREFIX_SET=1
			shift
			;;
		--skip-deps)
			SKIP_DEPS=1
			shift
			;;
		--skip-native)
			SKIP_NATIVE=1
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			printf 'install-local: unknown argument: %s\n\n' "$1" >&2
			usage >&2
			exit 2
			;;
	esac
done

case "$MODE" in
	wrapper | binary) ;;
	*)
		printf 'install-local: --mode must be "wrapper" or "binary", got "%s"\n' "$MODE" >&2
		exit 2
		;;
esac

step() { printf '\n▶ %s\n' "$1"; }
done_step() { printf '✓ %s\n' "$1"; }

command -v bun >/dev/null 2>&1 || {
	printf 'install-local: bun not found on PATH; install it from https://bun.sh\n' >&2
	exit 1
}

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$REPO_ROOT"

# Bun's global bin, resolved the same way scripts/link-omp.sh does: `bun pm -g
# bin` can fail on hosts whose global install is not initialized yet.
resolve_global_bin() {
	local bin
	bin=$(bun pm -g bin 2>/dev/null || true)
	[ -n "$bin" ] || bin="${BUN_INSTALL:-$HOME/.bun}/bin"
	printf '%s' "$bin"
}

if [ "$PREFIX_SET" -eq 0 ]; then
	PREFIX=$(resolve_global_bin)
elif [ "$MODE" = wrapper ]; then
	printf 'install-local: note: --prefix is ignored in wrapper mode; scripts/link-omp.sh installs into %s\n' "$(resolve_global_bin)" >&2
fi

if [ "$SKIP_DEPS" -eq 0 ]; then
	step "bun install"
	bun install
fi

if [ "$SKIP_NATIVE" -eq 0 ]; then
	for tool in cargo cmake ninja; do
		command -v "$tool" >/dev/null 2>&1 || {
			printf "install-local: '%s' not found on PATH; required to build the native addon.\n" "$tool" >&2
			printf '  See INSTALL.md → Troubleshooting → cmake / ninja missing for a no-root cmake install,\n' >&2
			printf '  or re-run with --skip-native when the addon is already built.\n' >&2
			exit 1
		}
	done
	step "bun run build:native"
	bun run build:native
fi

case "$MODE" in
	wrapper)
		# `bun link` registers the package globally, but the launcher installed
		# below runs src/cli.ts directly and works without it; a failure here is
		# not fatal.
		step "link coding-agent package"
		bun --cwd=packages/coding-agent link || printf 'install-local: warning: "bun link" failed; the dev launcher does not require it\n' >&2

		step "install dev launcher"
		sh scripts/link-omp.sh
		;;
	binary)
		step "build standalone binary"
		(cd packages/coding-agent && bun run build)

		built="$REPO_ROOT/packages/coding-agent/dist/omp"
		[ -f "$built" ] || {
			printf 'install-local: build finished but %s is missing\n' "$built" >&2
			exit 1
		}

		step "install binary into $PREFIX"
		mkdir -p "$PREFIX"
		# Remove first: a dev launcher symlink at the target would make `install`
		# overwrite the file it points at instead of replacing the link.
		rm -f "$PREFIX/omp"
		install -m 755 "$built" "$PREFIX/omp"
		;;
esac

step "verify"
if command -v omp >/dev/null 2>&1; then
	found=$(command -v omp)
	if [ "$found" != "$PREFIX/omp" ]; then
		printf 'install-local: note: "omp" on PATH resolves to %s, not %s (check PATH order)\n' "$found" "$PREFIX/omp" >&2
	fi
fi
"$PREFIX/omp" --version

done_step "installed ($MODE) → $PREFIX/omp"
