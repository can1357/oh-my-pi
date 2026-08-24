#!/usr/bin/env bash
# Real-subprocess/real-wire ACP end-to-end check: a real `omp acp` process,
# real JSON-RPC/ndjson stdio, real `AgentSideConnection`, driven through a
# separate, unpinned `acp-probe` checkout (github.com/marton78/acp-probe) --
# the process/wire fidelity `bun test acp-deterministic-phase-gate.test.ts`'s
# fake in-process connection can't exercise. See docs/acp-development.md
# rule 7.
#
# This is a thin dispatcher, not the implementation: all 8 rows (byte-exact
# meta/fenced channel checks, kill-mid-tool with a real SIGKILL) live in
# packages/coding-agent/test/acp-live-e2e.test.ts, which is a normal
# bun:test file you can also run directly (`bun test acp-live-e2e.test.ts`);
# it skips cleanly wherever the acp-probe checkout is absent. This script
# only adds fail-fast, actionable errors for a missing checkout/launcher
# before spending ~100s discovering that the hard way, plus positional-arg
# overrides -- so it's worth keeping as the documented entry point even
# though it owns no assertion logic of its own.
#
# For the deterministic, in-process, no-external-dependency route (runs as
# part of any normal `bun test`), just run:
#   bun test packages/coding-agent/test/acp-deterministic-phase-gate.test.ts
#
set -o pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
omp_root="$(cd "$script_dir/.." && pwd)"

# `--live` used to select between two modes; there's only one now, so it's
# accepted and ignored for anyone typing it out of habit.
[ "${1:-}" = "--live" ] && shift
export ACP_PROBE_DIR="${1:-$omp_root/../acp-probe}"
export ACP_OMP_CMD="${2:-$omp_root/packages/coding-agent/scripts/omp}"
if [ ! -f "$ACP_PROBE_DIR/src/acp-probe.ts" ]; then
	echo "acp-stress-matrix: no acp-probe checkout at $ACP_PROBE_DIR (pass its path as \$1)" >&2
	exit 2
fi
if [ ! -x "$ACP_OMP_CMD" ]; then
	echo "acp-stress-matrix: no omp launcher at $ACP_OMP_CMD (pass its path as \$2)" >&2
	exit 2
fi

bun test "$omp_root/packages/coding-agent/test/acp-live-e2e.test.ts"
