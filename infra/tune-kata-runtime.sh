#!/usr/bin/env bash
# Patch the live Kata QEMU config: set the guest BOOT floor (default_vcpus /
# default_memory), raise guest and host open-file limits, and enlarge the
# virtiofsd worker pool. Runner pods are burstable (see reload-runner.sh):
# the boot floor stays deliberately at or below the pod's CPU/memory REQUEST
# so VMs boot small and fast, and Kata hotplugs each guest toward the pod
# LIMIT under load. Keep BOOT_VCPUS/BOOT_MEMORY_MIB <= the request when
# retuning either side.
# The script runs over SSH, which keeps the desired values version-controlled.
# It then smoke-tests a new kata-qemu pod.
#
# Usage:
#   CI_HOST=my-ci-host ./infra/tune-kata-runtime.sh
#
# Env knobs:
#   CI_HOST                ssh target of the CI host                     (required)
#   KATA_CONFIG_REMOTE     remote Kata config file                       [/opt/kata/share/defaults/kata-containers/configuration-qemu.toml]
#   KUBECONFIG_REMOTE      kubeconfig path on the host                   [/etc/rancher/k3s/k3s.yaml]
#   ARC_RELEASE            runner scale set name                         [omp-kata]
#   ARC_NAMESPACE          runner namespace                              [arc-runners]
#   BOOT_VCPUS             Kata default_vcpus                            [2]
#   BOOT_MEMORY_MIB        Kata default_memory (MiB)                     [4096]
#   VIRTIOFSD_THREAD_POOL  virtiofsd --thread-pool-size                  [4]
#   OPEN_FILE_LIMIT        guest and virtiofsd open-file limit            [8388608]
set -euo pipefail

: "${CI_HOST:?set CI_HOST to the ssh target of your CI host, e.g. CI_HOST=my-ci-host}"
KATA_CONFIG_REMOTE="${KATA_CONFIG_REMOTE:-/opt/kata/share/defaults/kata-containers/configuration-qemu.toml}"
KUBECONFIG_REMOTE="${KUBECONFIG_REMOTE:-/etc/rancher/k3s/k3s.yaml}"
ARC_RELEASE="${ARC_RELEASE:-omp-kata}"
ARC_NAMESPACE="${ARC_NAMESPACE:-arc-runners}"
BOOT_VCPUS="${BOOT_VCPUS:-2}"
BOOT_MEMORY_MIB="${BOOT_MEMORY_MIB:-4096}"
VIRTIOFSD_THREAD_POOL="${VIRTIOFSD_THREAD_POOL:-4}"
OPEN_FILE_LIMIT="${OPEN_FILE_LIMIT:-8388608}"

ssh "$CI_HOST" bash -s -- \
  "$KATA_CONFIG_REMOTE" "$KUBECONFIG_REMOTE" "$ARC_RELEASE" "$ARC_NAMESPACE" \
  "$BOOT_VCPUS" "$BOOT_MEMORY_MIB" "$VIRTIOFSD_THREAD_POOL" "$OPEN_FILE_LIMIT" <<'REMOTE'
set -euo pipefail
KATA_CONFIG="$1"
export KUBECONFIG="$2"
ARC_RELEASE="$3"
ARC_NAMESPACE="$4"
BOOT_VCPUS="$5"
BOOT_MEMORY_MIB="$6"
THREAD_POOL="$7"
OPEN_FILE_LIMIT="$8"

backup="${KATA_CONFIG}.bak.$(date +%Y%m%d-%H%M%S)"
cp "$KATA_CONFIG" "$backup"
echo "==> backup: $backup"

python3 - "$KATA_CONFIG" "$BOOT_VCPUS" "$BOOT_MEMORY_MIB" "$THREAD_POOL" "$OPEN_FILE_LIMIT" <<'PY'
from pathlib import Path
import re
import sys
path = Path(sys.argv[1])
boot_vcpus = sys.argv[2]
boot_mem = sys.argv[3]
thread_pool = sys.argv[4]
fd_limit_value = int(sys.argv[5])
if fd_limit_value < 1:
    raise SystemExit("OPEN_FILE_LIMIT must be positive")
fd_limit = str(fd_limit_value)
text = path.read_text()
replacements = [
    (r'(^\s*default_vcpus\s*=\s*)\d+', rf'\g<1>{boot_vcpus}'),
    (r'(^\s*default_memory\s*=\s*)\d+', rf'\g<1>{boot_mem}'),
    (r'(^\s*virtio_fs_extra_args\s*=\s*)\[[^\]]*\]', rf'\g<1>["--thread-pool-size={thread_pool}", "--announce-submounts", "--rlimit-nofile={fd_limit}"]'),
]
for pattern, replacement in replacements:
    text, n = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if n != 1:
        raise SystemExit(f"failed to patch {pattern}")
kernel_pattern = r'^(\s*kernel_params\s*=\s*")([^"]*)(".*)$'
def update_kernel_params(match):
    params = [
        param
        for param in match.group(2).split()
        if not param.startswith("sysctl.fs.nr_open=")
    ]
    params.append(f"sysctl.fs.nr_open={fd_limit}")
    return f'{match.group(1)}{" ".join(params)}{match.group(3)}'
text, n = re.subn(
    kernel_pattern,
    update_kernel_params,
    text,
    count=1,
    flags=re.MULTILINE,
)
if n != 1:
    raise SystemExit("failed to patch kernel_params")
path.write_text(text)
PY

echo "==> active Kata knobs"
grep -nE 'kernel_params|default_vcpus|default_memory|virtio_fs_extra_args' "$KATA_CONFIG"

image="$(kubectl get autoscalingrunnerset "$ARC_RELEASE" -n "$ARC_NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].image}')"
pod="kata-runtime-smoke-$(date +%H%M%S)"
trap 'kubectl delete pod "$pod" -n "$ARC_NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true' EXIT

echo "==> smoke boot via kata-qemu using $image"
kubectl run "$pod" -n "$ARC_NAMESPACE" --restart=Never --image="$image" \
  --overrides='{"spec":{"runtimeClassName":"kata-qemu"}}' \
  --command -- bash -lc 'sleep 120' >/dev/null
kubectl wait --for=condition=Ready "pod/$pod" -n "$ARC_NAMESPACE" --timeout=120s >/dev/null
kubectl exec -n "$ARC_NAMESPACE" "$pod" -- bash -lc 'bun --version; rustc --version | head -1'
fd_probe="$(kubectl exec -n "$ARC_NAMESPACE" "$pod" -- bash -lc \
  'printf "%s %s %s" "$(cat /proc/sys/fs/nr_open)" "$(ulimit -Sn)" "$(ulimit -Hn)"')"
read -r guest_nr_open soft_limit hard_limit <<<"$fd_probe"
if [[ "$guest_nr_open" != "$OPEN_FILE_LIMIT" ||
      "$soft_limit" != "$OPEN_FILE_LIMIT" ||
      "$hard_limit" != "$OPEN_FILE_LIMIT" ]]; then
  echo "fd limit mismatch: nr_open=$guest_nr_open soft=$soft_limit hard=$hard_limit expected=$OPEN_FILE_LIMIT" >&2
  exit 1
fi
echo "guest fd limits: nr_open=$guest_nr_open soft=$soft_limit hard=$hard_limit"
sandbox_id="$(k3s crictl pods --name "$pod" -q)"
virtiofsd_pid="$(pgrep -fo "/opt/kata/libexec/virtiofsd.*sandboxes/${sandbox_id}/")"
read -r virtiofsd_soft_limit virtiofsd_hard_limit < <(
  awk '/^Max open files/ { print $4, $5 }' "/proc/$virtiofsd_pid/limits"
)
if [[ "$virtiofsd_soft_limit" != "$OPEN_FILE_LIMIT" ||
      "$virtiofsd_hard_limit" != "$OPEN_FILE_LIMIT" ]]; then
  echo "virtiofsd fd limit mismatch: soft=$virtiofsd_soft_limit hard=$virtiofsd_hard_limit expected=$OPEN_FILE_LIMIT" >&2
  exit 1
fi
echo "virtiofsd fd limits: soft=$virtiofsd_soft_limit hard=$virtiofsd_hard_limit"
echo "OK: kata-qemu still boots after tuning"
REMOTE
