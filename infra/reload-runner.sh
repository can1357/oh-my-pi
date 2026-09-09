#!/usr/bin/env bash
# Build + roll the preloaded omp-kata runner image onto the self-hosted CI host,
# driven over SSH from this repo. The Dockerfile next to this script is the
# source of truth: it is copied to the host, built there, and the ARC runner
# scale set is pointed at the new tag and rolled.
#
# By default the remote side prefers a direct containerd build path: bootstrap a
# pinned BuildKit + nerdctl toolchain under the remote build dir, build straight
# into the k3s containerd `k8s.io` namespace, and smoke-test from that image
# store. That avoids the old `docker save | ctr images import` tarball hop and
# cuts duplicate layer I/O on large reloads. If the direct path is unavailable
# or you set BUILD_BACKEND=docker, it falls back to the legacy Docker-daemon
# build + import path.
#
# The host is intentionally NOT hardcoded (this repo is public). Set CI_HOST to
# your ssh target; the remaining knobs default to the reference deployment.
#
# Usage:
#   CI_HOST=my-ci-host ./infra/reload-runner.sh                # tag: omp-kata-runner:YYYY-MM-DD-HHMMSS
#   CI_HOST=my-ci-host ./infra/reload-runner.sh 2026-06-20     # tag: omp-kata-runner:2026-06-20
#   CI_HOST=my-ci-host ./infra/reload-runner.sh my/repo:tag    # explicit repo:tag
#
# Env knobs (defaults match the reference deployment):
#   CI_HOST                  ssh target of the CI host                     (required)
#   REMOTE_CTX               remote build dir for the Dockerfile           [/root/omp-kata-runner-image]
#   ARC_VALUES               remote ARC scale-set helm values file         [/root/arc-omp-values.yaml]
#   ARC_RELEASE              helm release name of the runner scale set     [omp-kata]
#   ARC_NAMESPACE            namespace the runner scale set lives in       [arc-runners]
#   ARC_CHART_VERSION        gha-runner-scale-set chart version            [0.14.2]
#   KUBECONFIG_REMOTE        kubeconfig path on the host                   [/etc/rancher/k3s/k3s.yaml]
#   BUILD_BACKEND            auto | containerd | docker                    [auto]
#   CONTAINERD_SOCKET_REMOTE remote containerd socket                      [/run/k3s/containerd/containerd.sock]
#   NERDCTL_VERSION          nerdctl release to bootstrap on demand        [2.1.6]
#   BUILDKIT_VERSION         BuildKit release to bootstrap on demand       [0.25.1]
#   RUNNER_MAX_RUNNERS       maximum concurrent Kata runner pods             [8]
#   RUNNER_CPU_REQUEST       requested CPU cores per runner                   [3]
#   RUNNER_CPU_LIMIT         CPU-core limit per runner (Kata hotplug ceiling) [8]
#   RUNNER_MEMORY_REQUEST    requested memory per runner                      [10Gi]
#   RUNNER_MEMORY_LIMIT      memory limit per runner (Kata hotplug ceiling)   [14Gi]
#
# Runner pods are deliberately BURSTABLE, not guaranteed: requests size the
# scheduler's bin-packing (8 x 3 cpu / 10Gi fits the 32-vCPU / 125 GiB host
# with headroom), while limits set each Kata VM's hotplug ceiling so a lone
# native build still gets 8 vCPUs. requests==limits previously capped the
# host at 4 runners and queued every >4-job workflow fan-out for minutes.
# Worst-case sum of memory limits (8 x 14Gi = 112Gi) stays under the host's
# 125 GiB because host OOM under Kata kills VMs unpredictably — keep it that
# way when retuning.
set -euo pipefail

: "${CI_HOST:?set CI_HOST to the ssh target of your CI host, e.g. CI_HOST=my-ci-host}"
REMOTE_CTX="${REMOTE_CTX:-/root/omp-kata-runner-image}"
ARC_VALUES="${ARC_VALUES:-/root/arc-omp-values.yaml}"
ARC_RELEASE="${ARC_RELEASE:-omp-kata}"
ARC_NAMESPACE="${ARC_NAMESPACE:-arc-runners}"
ARC_CHART_VERSION="${ARC_CHART_VERSION:-0.14.2}"
KUBECONFIG_REMOTE="${KUBECONFIG_REMOTE:-/etc/rancher/k3s/k3s.yaml}"
BUILD_BACKEND="${BUILD_BACKEND:-auto}"
CONTAINERD_SOCKET_REMOTE="${CONTAINERD_SOCKET_REMOTE:-/run/k3s/containerd/containerd.sock}"
NERDCTL_VERSION="${NERDCTL_VERSION:-2.1.6}"
BUILDKIT_VERSION="${BUILDKIT_VERSION:-0.25.1}"
RUNNER_MAX_RUNNERS="${RUNNER_MAX_RUNNERS:-8}"
RUNNER_CPU_REQUEST="${RUNNER_CPU_REQUEST:-3}"
RUNNER_CPU_LIMIT="${RUNNER_CPU_LIMIT:-8}"
RUNNER_MEMORY_REQUEST="${RUNNER_MEMORY_REQUEST:-10Gi}"
RUNNER_MEMORY_LIMIT="${RUNNER_MEMORY_LIMIT:-14Gi}"

arg="${1:-$(date +%Y-%m-%d-%H%M%S)}"
case "$arg" in *:*) IMAGE="$arg";; *) IMAGE="omp-kata-runner:$arg";; esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$here/runner.Dockerfile" ] || { echo "no runner.Dockerfile next to $0" >&2; exit 1; }

echo "==> [0/5] copying Dockerfile to ${CI_HOST}:${REMOTE_CTX}"
ssh "$CI_HOST" bash -s -- "$REMOTE_CTX" <<'REMOTE'
mkdir -p "$1"
REMOTE
scp -q "$here/runner.Dockerfile" "${CI_HOST}:${REMOTE_CTX}/Dockerfile"

# All build/import/rollout steps run on the host. Config is passed as positional
# args (no secrets, no spaces) so it survives the ssh command-string re-parse
# regardless of the host's login shell.
ssh "$CI_HOST" bash -s -- \
   "$IMAGE" "$REMOTE_CTX" "$ARC_VALUES" "$ARC_RELEASE" "$ARC_NAMESPACE" "$ARC_CHART_VERSION" \
   "$KUBECONFIG_REMOTE" "$BUILD_BACKEND" "$CONTAINERD_SOCKET_REMOTE" "$NERDCTL_VERSION" "$BUILDKIT_VERSION" \
   "$RUNNER_MAX_RUNNERS" "$RUNNER_CPU_REQUEST" "$RUNNER_CPU_LIMIT" "$RUNNER_MEMORY_REQUEST" "$RUNNER_MEMORY_LIMIT" <<'REMOTE'
set -euo pipefail
IMAGE="$1"; REMOTE_CTX="$2"; ARC_VALUES="$3"; ARC_RELEASE="$4"; ARC_NAMESPACE="$5"; ARC_CHART_VERSION="$6"
export KUBECONFIG="$7"
BUILD_BACKEND="$8"; CONTAINERD_SOCKET="$9"; NERDCTL_VERSION="${10}"; BUILDKIT_VERSION="${11}"
RUNNER_MAX_RUNNERS="${12}"; RUNNER_CPU_REQUEST="${13}"; RUNNER_CPU_LIMIT="${14}"; RUNNER_MEMORY_REQUEST="${15}"; RUNNER_MEMORY_LIMIT="${16}"
cd "$REMOTE_CTX"

TOOLS_DIR="$REMOTE_CTX/.containerd-build-tools"
BIN_DIR="$TOOLS_DIR/bin"
RUN_DIR="$TOOLS_DIR/run"
ROOT_DIR="$TOOLS_DIR/root"
LOG_DIR="$TOOLS_DIR/log"
NERDCTL_BIN="$BIN_DIR/nerdctl"
BUILDKITD_BIN="$BIN_DIR/buildkitd"
BUILDKITCTL_BIN="$BIN_DIR/buildctl"
BUILDKIT_ADDR="unix://$RUN_DIR/buildkitd.sock"

BUILDKITD_PID=""
cleanup_buildkitd() {
  if [ -n "${BUILDKITD_PID:-}" ]; then
    kill "$BUILDKITD_PID" >/dev/null 2>&1 || true
    wait "$BUILDKITD_PID" >/dev/null 2>&1 || true
    rm -f "$RUN_DIR/buildkitd.sock"
  fi
}
trap cleanup_buildkitd EXIT
extract_bin() {
  local archive="$1" needle="$2" out="$3" tmp
  tmp="$(mktemp -d)"
  tar -C "$tmp" -xf "$archive"
  cp "$(find "$tmp" -type f -name "$needle" | head -1)" "$out"
  chmod +x "$out"
  rm -rf "$tmp"
}

bootstrap_containerd_tools() {
  mkdir -p "$BIN_DIR" "$RUN_DIR" "$ROOT_DIR" "$LOG_DIR"
  if [ ! -S "$CONTAINERD_SOCKET" ]; then
    echo "containerd socket missing: $CONTAINERD_SOCKET" >&2
    return 1
  fi
  if [ ! -x "$NERDCTL_BIN" ]; then
    local archive="$TOOLS_DIR/nerdctl-${NERDCTL_VERSION}.tar.gz"
    echo "==> [1/5] bootstrapping nerdctl ${NERDCTL_VERSION}"
    curl -fsSL "https://github.com/containerd/nerdctl/releases/download/v${NERDCTL_VERSION}/nerdctl-${NERDCTL_VERSION}-linux-amd64.tar.gz" -o "$archive"
    extract_bin "$archive" nerdctl "$NERDCTL_BIN"
  fi
  if [ ! -x "$BUILDKITD_BIN" ] || [ ! -x "$BUILDKITCTL_BIN" ]; then
    local archive="$TOOLS_DIR/buildkit-v${BUILDKIT_VERSION}.tar.gz"
    echo "==> [1/5] bootstrapping BuildKit ${BUILDKIT_VERSION}"
    curl -fsSL "https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.linux-amd64.tar.gz" -o "$archive"
    extract_bin "$archive" buildkitd "$BUILDKITD_BIN"
    extract_bin "$archive" buildctl "$BUILDKITCTL_BIN"
  fi
}

start_buildkitd() {
  if [ -S "$RUN_DIR/buildkitd.sock" ]; then
    if "$BUILDKITCTL_BIN" --addr "$BUILDKIT_ADDR" debug workers >/dev/null 2>&1; then
      echo "==> reusing running BuildKit daemon"
      return 0
    fi
    rm -f "$RUN_DIR/buildkitd.sock"
  fi
  "$BUILDKITD_BIN" \
    --addr "$BUILDKIT_ADDR" \
    --root "$ROOT_DIR" \
    --containerd-worker=true \
    --containerd-worker-namespace k8s.io \
    --containerd-worker-addr "$CONTAINERD_SOCKET" \
    --oci-worker=false >"$LOG_DIR/buildkitd.log" 2>&1 &
  BUILDKITD_PID="$!"
  for _ in $(seq 1 120); do
    [ -S "$RUN_DIR/buildkitd.sock" ] && return 0
    sleep 0.25
  done
  echo "buildkitd did not create $RUN_DIR/buildkitd.sock" >&2
  sed -n '1,120p' "$LOG_DIR/buildkitd.log" >&2 || true
  return 1
}

verify_baked_tools() {
  local runner="$1"
  "$runner" --namespace k8s.io run --rm --entrypoint bash "$IMAGE" -lc '
    set -e
    for b in gh fd rg magick bun cargo rustc pkg-config clang lld sccache zstd zig cmake ninja cargo-nextest cargo-zigbuild cargo-xwin bazelisk bazel; do
      command -v "$b" >/dev/null || { echo "MISSING: $b"; exit 1; }
    done
    echo "tools OK | bun $(bun --version) | rust $(rustc --version) | sccache $(set -- $(sccache --version); echo "$2") | zstd $(zstd --version) | zig $(zig version) | cmake $(set -- $(cmake --version | head -1); echo "$3") | ninja $(ninja --version) | gh $(set -- $(gh --version | head -1); echo "$3")"
  '
}

build_with_containerd() {
  bootstrap_containerd_tools
  start_buildkitd

  echo "==> [2/5] building $IMAGE directly into k3s containerd (k8s.io namespace)"
  "$BUILDKITCTL_BIN" --addr "$BUILDKIT_ADDR" build \
    --progress=plain \
    --frontend dockerfile.v0 \
    --local context=. \
    --local dockerfile=. \
    --opt filename=Dockerfile \
    --output "type=image,name=$IMAGE,store=true"
  k3s ctr -n k8s.io images tag "$IMAGE" omp-kata-runner:preloaded >/dev/null 2>&1 || true

  echo "==> [3/5] verifying baked tools from k3s containerd"
  verify_baked_tools "$NERDCTL_BIN"
}

build_with_docker() {
  echo "==> [1/5] building $IMAGE with docker"
  DOCKER_BUILDKIT=1 docker build -t "$IMAGE" -t omp-kata-runner:preloaded .

  echo "==> [2/5] verifying baked tools"
  docker run --rm --entrypoint bash "$IMAGE" -lc '
    set -e
    for b in gh fd rg magick bun cargo rustc pkg-config clang lld sccache zstd zig cmake ninja cargo-nextest cargo-zigbuild cargo-xwin bazelisk bazel; do
      command -v "$b" >/dev/null || { echo "MISSING: $b"; exit 1; }
    done
    echo "tools OK | bun $(bun --version) | rust $(rustc --version) | sccache $(set -- $(sccache --version); echo "$2") | zstd $(zstd --version) | zig $(zig version) | cmake $(set -- $(cmake --version | head -1); echo "$3") | ninja $(ninja --version) | gh $(set -- $(gh --version | head -1); echo "$3")"
  '

  echo "==> [3/5] importing into k3s containerd (k8s.io namespace)"
  docker save "$IMAGE" | k3s ctr -n k8s.io images import --platform linux/amd64 -
}

selected_backend="$BUILD_BACKEND"
case "$BUILD_BACKEND" in
  auto)
    if bootstrap_containerd_tools >/dev/null 2>&1; then
      selected_backend=containerd
    else
      selected_backend=docker
    fi
    ;;
  containerd|docker)
    ;;
  *)
    echo "BUILD_BACKEND must be auto, containerd, or docker (got: $BUILD_BACKEND)" >&2
    exit 2
    ;;
esac

echo "==> selected build backend: $selected_backend"
case "$selected_backend" in
  containerd)
    if ! build_with_containerd; then
      if [ "$BUILD_BACKEND" = auto ]; then
        echo "==> containerd build path failed; falling back to docker" >&2
        build_with_docker
      else
        exit 1
      fi
    fi
    ;;
  docker)
    build_with_docker
    ;;
esac

echo "==> [4/5] pointing ARC runner scale set at $IMAGE"
sed -i "s#image: omp-kata-runner:.*#image: $IMAGE#" "$ARC_VALUES"
sed -i -E "s/^maxRunners:.*/maxRunners: $RUNNER_MAX_RUNNERS/" "$ARC_VALUES"
# Ensure the bazel-remote cache credentials reach every runner pod (idempotent;
# the secret is created by infra/bazel-remote/setup.sh).
if ! grep -q 'name: bazel-remote-ci' "$ARC_VALUES"; then
  awk '1; /^        envFrom:/ { print "          - secretRef:"; print "              name: bazel-remote-ci" }' \
    "$ARC_VALUES" > "$ARC_VALUES.tmp" && mv "$ARC_VALUES.tmp" "$ARC_VALUES"
  grep -q 'name: bazel-remote-ci' "$ARC_VALUES" || { echo "failed to add bazel-remote-ci envFrom to $ARC_VALUES (no 'envFrom:' anchor?)" >&2; exit 1; }
fi
helm upgrade "$ARC_RELEASE" --namespace "$ARC_NAMESPACE" --version "$ARC_CHART_VERSION" \
  -f "$ARC_VALUES" \
  --set-string "template.spec.containers[0].resources.requests.cpu=$RUNNER_CPU_REQUEST" \
  --set-string "template.spec.containers[0].resources.limits.cpu=$RUNNER_CPU_LIMIT" \
  --set-string "template.spec.containers[0].resources.requests.memory=$RUNNER_MEMORY_REQUEST" \
  --set-string "template.spec.containers[0].resources.limits.memory=$RUNNER_MEMORY_LIMIT" \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set >/dev/null

echo "==> [5/5] verifying rollout"
live="$(kubectl get autoscalingrunnerset "$ARC_RELEASE" -n "$ARC_NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].image}')"
live_max="$(kubectl get autoscalingrunnerset "$ARC_RELEASE" -n "$ARC_NAMESPACE" -o jsonpath='{.spec.maxRunners}')"
live_resources="$(kubectl get autoscalingrunnerset "$ARC_RELEASE" -n "$ARC_NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}/{.spec.template.spec.containers[0].resources.limits.cpu} {.spec.template.spec.containers[0].resources.requests.memory}/{.spec.template.spec.containers[0].resources.limits.memory}')"
expected_resources="$RUNNER_CPU_REQUEST/$RUNNER_CPU_LIMIT $RUNNER_MEMORY_REQUEST/$RUNNER_MEMORY_LIMIT"
echo "ARC runner image/resources: $live | max=$live_max | $live_resources"
[ "$live" = "$IMAGE" ] || { echo "MISMATCH: expected image $IMAGE"; exit 1; }
[ "$live_max" = "$RUNNER_MAX_RUNNERS" ] || { echo "MISMATCH: expected maxRunners $RUNNER_MAX_RUNNERS"; exit 1; }
[ "$live_resources" = "$expected_resources" ] || { echo "MISMATCH: expected resources $expected_resources"; exit 1; }
echo "OK: reloaded $IMAGE"
REMOTE

echo "OK: $IMAGE built on ${CI_HOST}, stored in k3s containerd, and rolled out to ARC."
