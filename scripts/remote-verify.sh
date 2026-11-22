#!/usr/bin/env bash
# remote-verify.sh [--seed] <just recipe> [args...]
# Runs one `just` recipe on a BuildBuddy remote runner (Linux x86_64; ADR 0040, Slice 0) over this
# checkout as it is, uncommitted changes included, and streams its log. The machine running this
# only uploads the changes and prints the log: the build and the tests run remotely.
#
# Optional tooling: nothing in the build depends on it. Needs the `bb` CLI and a BuildBuddy API key,
# read from BUILDBUDDY_API_KEY or else from the macOS Keychain service named by
# OMP_REMOTE_KEYCHAIN_SERVICE (default `buildbuddy-omp`). The key reaches `bb` only through its
# environment and is never printed, but bb hands it to every process of the remote run (ADR 0040,
# Part H.2): use a key you can revoke.
#
# --seed runs the recipe on the default branch's head instead of this checkout and saves the
# runner snapshot later runs resume from. Run it after toolchain or dependency changes; it costs
# one snapshot upload. The test workspace exceeded the former 40 GB disk reservation.
#
# The runner properties are fixed on purpose: every property is part of BuildBuddy's snapshot key,
# so changing one makes every later run cold until a new snapshot is seeded.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

seed=false
if [ "${1-}" = --seed ]; then
    seed=true
    shift
fi
if [ "$#" -eq 0 ]; then
    echo "usage: scripts/remote-verify.sh [--seed] <just recipe> [args...]" >&2
    exit 2
fi
if ! command -v bb >/dev/null; then
    echo "error: the BuildBuddy CLI \`bb\` is not on PATH (https://github.com/buildbuddy-io/bazel/releases)" >&2
    exit 2
fi

if [ -z "${BUILDBUDDY_API_KEY-}" ]; then
    service=${OMP_REMOTE_KEYCHAIN_SERVICE:-buildbuddy-omp}
    if ! BUILDBUDDY_API_KEY=$(security find-generic-password -s "$service" -w 2>/dev/null); then
        echo "error: no BuildBuddy API key: set BUILDBUDDY_API_KEY or store one in the Keychain" \
            "service '$service' (security add-generic-password -a \"\$USER\" -s $service -w)" >&2
        exit 2
    fi
fi
export BUILDBUDDY_API_KEY

# `bb remote` refuses to start outside a Bazel workspace. The marker and the
# workspace symlinks it creates are disposable and must not enter the mirrored
# working tree.
module_created=false
had_bazel_bin=false
had_bazel_out=false
had_bazel_testlogs=false
had_bazel_workspace=false
[ -e MODULE.bazel ] || module_created=true
[ -h bazel-bin ] && had_bazel_bin=true
[ -h bazel-out ] && had_bazel_out=true
[ -h bazel-testlogs ] && had_bazel_testlogs=true
[ -h bazel-oh-my-pi ] && had_bazel_workspace=true
cleanup_remote_markers() {
	$module_created && rm -f "$REPO_ROOT/MODULE.bazel"
	! $had_bazel_bin && rm -f "$REPO_ROOT/bazel-bin"
	! $had_bazel_out && rm -f "$REPO_ROOT/bazel-out"
	! $had_bazel_testlogs && rm -f "$REPO_ROOT/bazel-testlogs"
	! $had_bazel_workspace && rm -f "$REPO_ROOT/bazel-oh-my-pi"
}
trap cleanup_remote_markers EXIT
if $module_created; then
	: >MODULE.bazel
fi

# With several git remotes bb asks which one the runner fetches from; answer once.
if [ "$(git remote | wc -l)" -gt 1 ] && [ -z "$(git config --get buildbuddy.remote-bazel-remote-name || true)" ]; then
    git config --local buildbuddy.remote-bazel-remote-name "${OMP_REMOTE_GIT_REMOTE:-origin}"
fi

# The repository's remote execution base is omp2. Allow CI or a local experiment to override it,
# but never infer it from origin/HEAD, which points at main in ordinary clones.
default_branch=${OMP_REMOTE_DEFAULT_BRANCH:-omp2}

# bb resolves the default branch as a local branch (`git rev-parse <branch>`). A pull-request
# checkout is a detached merge commit with no local branches, so fetch it shallowly when missing.
if ! git rev-parse --verify --quiet "refs/heads/$default_branch" >/dev/null; then
    git fetch --quiet --no-tags --depth=1 "${OMP_REMOTE_GIT_REMOTE:-origin}" \
        "+refs/heads/$default_branch:refs/heads/$default_branch"
fi

# The key stays out of argv (visible in `ps`): bb reads BUILDBUDDY_API_KEY, exported above, from
# its environment (ADR 0040, Findings 4).
args=(
    --os=linux
    --arch=amd64
    --container_image=docker://gcr.io/flame-public/rbe-ubuntu24-04@sha256:f7db0d4791247f032fdb4451b7c3ba90e567923a341cc6dc43abfc283436791a
    --runner_exec_properties=EstimatedCPU=8
    --runner_exec_properties=EstimatedMemory=16GB
    --runner_exec_properties=EstimatedFreeDiskBytes=60GB
    --runner_exec_properties=remote-snapshot-save-policy=none-available
    --runner_exec_properties=snapshot-read-policy=local-first
    --timeout=60m
    "--env=OMP_REMOTE_JUST_ARGS=$*"
)
if [ "$seed" = true ]; then
    args+=(
        "--run_from_branch=$default_branch"
        --remote_run_header=x-buildbuddy-platform.remote-snapshot-save-policy=always
    )
fi

# Not `exec`: the EXIT trap above must still remove the marker.
# LIVE_REAPI_TESTS=1 preserves BUILDBUDDY_API_KEY on the runner so the live gRPC tests
# in crates/exec-reapi/tests/live_buildbuddy.rs can authenticate (see runner.sh).
GIT_REPO_DEFAULT_BRANCH=$default_branch bb remote "${args[@]}" \
	"--env=LIVE_REAPI_TESTS=${LIVE_REAPI_TESTS-}" \
	--script="$(<scripts/remote-verify-runner.sh)"
