#!/usr/bin/env bash
# remote-verify-runner.sh: the script scripts/remote-verify.sh sends to a BuildBuddy remote runner
# (ADR 0040, Slice 0). It runs on the runner, in the mirrored checkout: it prepares the toolchain
# the repository pins, then runs `just $OMP_REMOTE_JUST_ARGS`.
#
# Everything the runner should keep between runs lives under $HOME, which the VM snapshot carries:
# `bb remote` runs `git clean -x -d --force` in the checkout before every run, so target/ and vendor/
# inside it would be rebuilt from scratch each time.
set -euo pipefail
# bb remote exports these to every process of the run (ADR 0040, Part H.2); drop them first.
# Exception: LIVE_REAPI_TESTS=1 preserves BUILDBUDDY_API_KEY so the live gRPC tests in
# crates/exec-reapi/tests/live_buildbuddy.rs can authenticate against BuildBuddy.
if [ "${LIVE_REAPI_TESTS-}" = "1" ]; then
	export BUILDBUDDY_API_KEY
	unset REPO_TOKEN REPO_USER
else
	unset BUILDBUDDY_API_KEY REPO_TOKEN REPO_USER
fi

stamp() { printf '\n=== %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

stamp "runner: $(uname -sm), $(nproc) cpus, $(free -g | awk '/Mem:/ {print $2 " GB"}')"
git status --short | head -20 # the local changes bb mirrored, if any

# The Cargo caches grow without bound: every run, pull requests included, resumes the omp2 snapshot
# (bb checks each one out as branch omp2), and every dependency graph a run builds leaves its
# artifacts behind. The disk is mounted noatime and cargo has no target-dir GC, so live artifacts
# cannot be told from dead ones: evict whole caches. This runs before the toolchain step, so that
# an install on a full disk still has room.
target_dir="$HOME/.cache/omp-target"
caches=("$HOME"/.cache/omp-target*) # with the justfile's omp-target-clippy
disk_gb() { df -k --output="$1" "$HOME" | awk 'NR == 2 {print int($1 / 1048576)}'; }
# The failed 16 GB-headroom run grew its target by 17 GB before exhausting disk.
need_gb=25
evict() {
	local before
	before=$(disk_gb avail)
	rm -rf "${caches[@]}"
	stamp "evicted the Cargo caches ($1): ${before} -> $(disk_gb avail) GB free"
}
stamp "disk: $(disk_gb avail) of $(disk_gb size) GB free"
# rustc's version is in every artifact's hash: another toolchain's cache is all dead weight, and
# rebuilding everything needs far more than need_gb.
toolchain_stamp="$target_dir/rust-toolchain.stamp"
if [ "$(disk_gb avail)" -lt "$need_gb" ]; then
	evict "under ${need_gb} GB free"
elif [ -f "$toolchain_stamp" ] && ! cmp -s rust-toolchain.toml "$toolchain_stamp"; then
	evict "built by another rust-toolchain.toml"
fi
avail=$(disk_gb avail)
if [ "$avail" -lt "$need_gb" ]; then
	echo "error: could not reclaim $((need_gb - avail)) GB: ${avail} GB free with the Cargo caches evicted, and a run needs ${need_gb} GB" >&2
	exit 1
fi
mkdir -p "$target_dir"
cp rust-toolchain.toml "$toolchain_stamp"

stamp "toolchain"
if ! command -v cmake >/dev/null || ! command -v ninja >/dev/null; then
	sudo apt-get update
	sudo apt-get install -y build-essential cmake ninja-build zstd curl git python3 rsync
fi
if [ ! -x "$HOME/.cargo/bin/rustup" ]; then # the runner user is the non-root `buildbuddy`
	curl --proto '=https' -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
fi
. "$HOME/.cargo/env" # rust-toolchain.toml installs the pinned nightly on first use
if command -v just >/dev/null; then
	stamp "cache just hit"
else
	stamp "cache just miss"
	cargo install --locked just
fi
# Prebuilt: building nextest pulls aws-lc-sys, which refuses older images' gcc (GCC bug 95189).
if cargo nextest --version 2>/dev/null | grep -q '0\.9\.146'; then
	stamp "cache nextest hit"
else
	stamp "cache nextest miss"
	curl -LsSf https://get.nexte.st/0.9.146/linux | tar zxf - -C "${CARGO_HOME:-$HOME/.cargo}/bin"
fi
export PATH="$HOME/.local/bin:$PATH"
if command -v uv >/dev/null; then
	stamp "cache uv hit"
else
	stamp "cache uv miss"
	curl -LsSf https://astral.sh/uv/install.sh | sh # fetch-python.sh needs uv
fi
export NEXTEST_HIDE_PROGRESS_BAR=1 # Keep failures and the summary on separate CI log lines.
export CARGO_BUILD_JOBS=4 # The 16 GB runner OOM-killed omp-envd's test compiler with unrestricted jobs. 


# The runner image reports soft=hard=16384, so there is no headroom to raise;
# record the ceiling each run was measured against instead (ADR 0040).
stamp "open files: soft=$(ulimit -Sn) hard=$(ulimit -Hn)"

 

export CARGO_TARGET_DIR="$target_dir"
mkdir -p "$HOME/.cache/omp-vendor"
[ -L vendor ] || ln -sfn "$HOME/.cache/omp-vendor" vendor
if [ -f vendor/python/pyo3-config.txt ]; then
	stamp "cache python hit"
else
	stamp "cache python miss"
	crates/py/scripts/fetch-python.sh
fi
stamp "just ${OMP_REMOTE_JUST_ARGS}"
start=$(date +%s)
status=0
(
	while sleep 60; do
		stamp "disk: $(disk_gb avail) of $(disk_gb size) GB free"
	done
) &
monitor=$!
trap 'kill "$monitor" 2>/dev/null || true; wait "$monitor" 2>/dev/null || true' EXIT
# shellcheck disable=SC2086 # the recipe and its arguments are words on purpose
just ${OMP_REMOTE_JUST_ARGS} || status=$?
stamp "exit ${status} after $(($(date +%s) - start))s; target $(du -sh "$CARGO_TARGET_DIR" | cut -f1); $(disk_gb avail) GB free"
exit "$status"
