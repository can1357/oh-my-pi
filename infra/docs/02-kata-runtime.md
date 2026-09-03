# 02 — Kata Containers runtime for k3s

This guide installs **Kata Containers 3.31.0** and wires it into the k3s-bundled
containerd as a named runtime, `kata-qemu`, so that any pod carrying
`runtimeClassName: kata-qemu` boots inside its own QEMU/KVM microVM with a
**separate guest kernel** from the host.

- **Previous:** [`01-host-and-cluster.md`](./01-host-and-cluster.md) — host prep, k3s install, networking. You need a working single-node k3s, KVM enabled (`/dev/kvm` present), and nested-virt off (this is bare metal).
- **Next:** [`03-runner-image.md`](./03-runner-image.md) — the preloaded GitHub Actions runner image that runs inside these microVMs.

Why a microVM per pod: the CI jobs run untrusted code (third-party deps, fork
PRs). A `runc` container shares the host kernel; a Kata pod gets its own guest
kernel and a hardware-virtualization boundary (Intel VT-x / AMD-V), so a kernel
exploit inside a job does not reach the host. On `<CI_HOST>` the host runs the
CentOS Stream 10 kernel `7.0.10-1.el10.elrepo.x86_64`, while every Kata guest
runs `6.18.28-194` — the verification in the last section turns that gap into a
one-line proof.

All host paths and commands below were taken from the live host (read-only) and
redacted per the doc-set redaction map. Run them on **your** reproduction host;
on the live host only the read-only inspections (`kata-runtime check`,
`kata-runtime env`, `kubectl get …`) are safe.

---

## Step 1 — Install the Kata static release into `/opt/kata`

Kata ships a self-contained **static tarball**: a pinned QEMU, the guest kernel,
the guest rootfs image, virtiofsd, the runtime, and the containerd shim, all
rooted at `/opt/kata`. Nothing links against host libraries, so it coexists
cleanly with the host's own QEMU/libvirt and survives OS upgrades.

```bash
# amd64 host; pin the exact version so the kernel/image/QEMU triple is reproducible.
KATA_VER=3.31.0
curl -fsSL -o kata-static.tar.xz \
  "https://github.com/kata-containers/kata-containers/releases/download/${KATA_VER}/kata-static-${KATA_VER}-amd64.tar.xz"

# The archive is rooted at ./opt/kata, so extracting at / lands everything in /opt/kata.
sudo tar -xf kata-static.tar.xz -C /
```

Put the **shim** and the **CLI** on `PATH`. The shim symlink is what containerd
resolves at launch time (see Step 2); the `kata-runtime` symlink is for
host-side inspection and `kata-runtime check`/`env`:

```bash
sudo ln -sf /opt/kata/bin/containerd-shim-kata-v2 /usr/local/bin/containerd-shim-kata-v2
sudo ln -sf /opt/kata/bin/kata-runtime            /usr/local/bin/kata-runtime
```

On the live host both symlinks are in place:

```text
/usr/local/bin/containerd-shim-kata-v2 -> /opt/kata/bin/containerd-shim-kata-v2
/usr/local/bin/kata-runtime            -> /opt/kata/bin/kata-runtime
```

### Inspect the install layout

```text
/opt/kata
├── VERSION                      # "3.31.0"
├── versions.yaml                # pinned component versions (QEMU, kernel, rootfs)
├── bin/                         # qemu-system-x86_64, containerd-shim-kata-v2, kata-runtime, ...
├── libexec/                     # virtiofsd
└── share/
    ├── defaults/kata-containers/
    │   ├── configuration-qemu.toml      # the active config for the kata-qemu runtime
    │   └── configuration.toml -> configuration-qemu.toml
    └── kata-containers/
        ├── vmlinux.container -> vmlinux-6.18.28-194   # guest kernel
        └── kata-containers.img -> kata-ubuntu-noble.image  # guest rootfs
```

`bin/` ships several hypervisors (`qemu-system-x86_64`, `cloud-hypervisor`,
`firecracker`, `jailer`) and the QEMU confidential-computing variants
(`-snp-experimental`, `-tdx-experimental`); this setup uses plain
`qemu-system-x86_64`. `share/defaults/kata-containers/` also carries
`configuration-clh.toml`, `configuration-fc.toml`, etc. — one per hypervisor.
We only use `configuration-qemu.toml`.

### Confirm version and capability

```console
$ /opt/kata/bin/kata-runtime --version
kata-runtime  : 3.31.0
   commit   : ddb8a5de89891f12e1ce0013eb066a330b2988b9
   OCI specs: 1.2.1
```

The component pins live in `/opt/kata/versions.yaml`. The two that matter for
the guest are the QEMU and kernel versions:

```yaml
assets:
  hypervisor:
    qemu:
      version: "v10.2.1"
  kernel:
    version: "v6.18.28"
```

`kata-runtime check` confirms the host can actually start a microVM (KVM
present, CPU virtualization usable). Run it as a host-side smoke test before
touching k3s:

```console
$ /opt/kata/bin/kata-runtime check
level=warning msg="Not running network checks as super user" arch=amd64 ...
System is capable of running Kata Containers
System can currently create Kata Containers
```

`kata-runtime env` cross-checks the resolved kernel/image/hypervisor and the
host kernel — note the guest kernel (`6.18.28-194`) versus the host kernel
(`7.0.10`):

```console
$ /opt/kata/bin/kata-runtime env | grep -iE 'Kernel|Image|MachineType|Path|Hypervisor'
[Kernel]
  Path = "/opt/kata/share/kata-containers/vmlinux-6.18.28-194"
[Image]
  Path = "/opt/kata/share/kata-containers/kata-ubuntu-noble.image"
[Hypervisor]
  MachineType = "q35"
  Version = "QEMU emulator version 10.2.1 (kata-static) ..."
  Path = "/opt/kata/bin/qemu-system-x86_64"
[Host]
  Kernel = "7.0.10-1.el10.elrepo.x86_64"
```

---

## Step 2 — Register `kata-qemu` with k3s's containerd

k3s embeds its **own** containerd (v2 here) — not the host's. On every start it
**regenerates** `/var/lib/rancher/k3s/agent/etc/containerd/config.toml` from a
template; the header says so:

```toml
# File generated by k3s. DO NOT EDIT. Use config-v3.toml.tmpl instead.
version = 3
imports = ["/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/*.toml"]
root = "/var/lib/rancher/k3s/agent/containerd"
state = "/run/k3s/containerd"
...
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runc]
  runtime_type = "io.containerd.runc.v2"
```

Editing `config.toml` directly is pointless — k3s overwrites it on the next
restart. The durable hook is the generated `imports` line: k3s merges any
`*.toml` under `config-v3.toml.d/` into the final config. That directory is the
**supported drop-in path** and survives k3s upgrades.

> k3s picks the drop-in directory from the containerd config schema version. With
> the generated `version = 3` config the path is `config-v3.toml.d/`. (On older
> k3s that emitted a v2 config it was `config.toml.d/`.) Match whatever your
> generated `config.toml` declares.

Create the drop-in. This is the real file from the host, verbatim:

```toml
# /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/kata.toml
# Kata Containers (QEMU/KVM microVM) runtime for k3s containerd.
# Added out-of-band; merged via the generated config's `imports`.
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.kata-qemu]
  runtime_type = "io.containerd.kata.v2"
  runtime_path = "/opt/kata/bin/containerd-shim-kata-v2"
  [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.kata-qemu.options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-qemu.toml"
```

What each line does:

- The table key `…runtimes.kata-qemu` defines a CRI runtime **named**
  `kata-qemu`. A RuntimeClass whose `handler` is `kata-qemu` (Step 3) selects
  exactly this entry.
- `runtime_type = "io.containerd.kata.v2"` tells containerd this is a v2 (shim)
  runtime. By the v2 naming convention containerd would look for
  `containerd-shim-kata-v2` on `PATH` — which is why we symlinked it in Step 1.
- `runtime_path = "/opt/kata/bin/containerd-shim-kata-v2"` pins the **exact**
  shim binary regardless of `PATH`, so the runtime is unambiguous even if the
  symlink is missing or another shim shadows it.
- `options.ConfigPath` points the shim at the hypervisor configuration analyzed
  in Step 4. This is how a single shim binary can back multiple runtimes (e.g. a
  second `kata-clh` runtime pointing at `configuration-clh.toml`).

Restart k3s so the bundled containerd reloads and merges the drop-in:

```bash
sudo systemctl restart k3s
```

Verify containerd now knows the runtime (CRI reports the registered runtime
handlers):

```bash
sudo k3s crictl info | grep -A2 '"kata-qemu"'
```

The `runc` default is untouched: pods without a `runtimeClassName` keep running
as ordinary host-kernel containers. Only pods that opt into the RuntimeClass
below get a microVM.

---

## Step 3 — Create the `kata-qemu` RuntimeClass

A Kubernetes [RuntimeClass](https://kubernetes.io/docs/concepts/containers/runtime-class/)
maps a friendly name a pod can request to the containerd runtime handler
registered in Step 2. The `handler` value **must** equal the runtime name in the
drop-in (`kata-qemu`).

```yaml
# kata-qemu-runtimeclass.yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-qemu
handler: kata-qemu
```

```bash
kubectl apply -f kata-qemu-runtimeclass.yaml
```

Confirm it exists (live host, read-only):

```console
$ kubectl get runtimeclass kata-qemu -o yaml
apiVersion: node.k8s.io/v1
handler: kata-qemu
kind: RuntimeClass
metadata:
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: |
      {"apiVersion":"node.k8s.io/v1","handler":"kata-qemu","kind":"RuntimeClass","metadata":{"annotations":{},"name":"kata-qemu"}}
  creationTimestamp: "2026-06-14T19:18:16Z"
  name: kata-qemu
  resourceVersion: "580"
  uid: 50a199ac-3936-4ae8-9deb-be389ce9f042
```

From here, any pod with `spec.runtimeClassName: kata-qemu` is scheduled onto the
Kata shim. The ARC runner pod template sets exactly this — see
[`04-arc-and-caching.md`](./04-arc-and-caching.md).

---

## Step 4 — Kata hypervisor configuration (`configuration-qemu.toml`)

The shim reads `/opt/kata/share/defaults/kata-containers/configuration-qemu.toml`
(via `ConfigPath`). The file is long and mostly defaults; below are the **active
settings that shape this deployment**, copied from the host with the noise
stripped. Each is explained afterward.

```toml
[hypervisor.qemu]
path   = "/opt/kata/bin/qemu-system-x86_64"
kernel = "/opt/kata/share/kata-containers/vmlinux.container"
image  = "/opt/kata/share/kata-containers/kata-containers.img"
machine_type = "q35"
rootfs_type  = "ext4"
cpu_features  = "pmu=off"
kernel_params = "cgroup_no_v1=all systemd.unified_cgroup_hierarchy=1 sysctl.fs.nr_open=8388608"

default_vcpus    = 2
default_maxvcpus = 0
default_memory   = 4096
default_maxmemory = 0
memory_slots     = 10

shared_fs        = "virtio-fs"
virtio_fs_daemon = "/opt/kata/libexec/virtiofsd"
virtio_fs_cache  = "auto"
virtio_fs_extra_args = ["--thread-pool-size=4", "--announce-submounts", "--rlimit-nofile=8388608"]

disable_block_device_use = true
block_device_driver = "virtio-scsi"
block_device_aio    = "io_uring"

[factory]
enable_template = false
vm_cache_number = 0

[runtime]
internetworking_model = "tcfilter"
emptydir_mode = "shared-fs"
static_sandbox_resource_mgmt = false
sandbox_cgroup_only = false
```

### Boot artifacts: `path` / `kernel` / `image`

`path` is the bundled QEMU 10.2.1; `kernel` is the guest kernel
(`vmlinux.container -> vmlinux-6.18.28-194`); `image` is the guest rootfs
(`kata-containers.img -> kata-ubuntu-noble.image`, an Ubuntu Noble rootfs with
`kata-agent` baked in as PID 1's manager). These three are the entire guest —
none of them is the host kernel, which is the whole point. `machine_type =
"q35"` is the modern PCIe QEMU machine (needed for PCIe hotplug);
`cpu_features = "pmu=off"` disables the virtual perf-monitoring unit and avoids
spurious PMU passthrough issues. The first two `kernel_params` entries force
cgroup v2-only in the guest, matching a modern systemd userspace.

### Open-file ceilings — Bazel sandbox headroom

Two limits protect each runner. `sysctl.fs.nr_open=8388608` raises the guest
open-file ceiling from 1,048,576. New runner containers inherit this value for
both soft and hard open-file resource limits (`RLIMIT_NOFILE`).

`--rlimit-nofile=8388608` raises the host `virtiofsd` process ceiling.
Virtiofsd otherwise caps itself at 1,000,000 descriptors. Cold Bazel builds
index large Zig and xwin trees through this daemon. The daemon exhausted its old
ceiling and returned `EMFILE` to Bazel. Linux grows descriptor tables on demand,
so unused headroom has no fixed allocation.

### vCPU / memory sizing — hotplug from pod requests/limits

This is the most important block to understand for a CI runner.

- `default_vcpus = 2` and `default_memory = 4096` (MiB) are the **boot-time**
  size. Runner microVMs now start at the runner pod's guaranteed request: 2 vCPU,
  4 GiB, rather than booting tiny and immediately hotplugging to that floor.
- `default_maxvcpus = 0` means "no fixed ceiling — use the host's physical CPU
  count" (32 on this box). `default_maxmemory = 0` likewise means "host total
  RAM". `memory_slots = 10` is the number of ACPI DIMM hotplug slots, i.e. how
  many memory-grow operations the guest can accept.
- `static_sandbox_resource_mgmt = false` still enables **dynamic** sizing: Kata
  reads the pod's CPU/memory **limits** that the kubelet/CRI hands the shim and
  hotplugs beyond the boot floor as needed. So a runner pod requesting `2 CPU /
  4Gi` with limits `8 CPU / 12Gi` now boots at 2 vCPU/4 GiB and grows toward
  8 vCPU / 12 GiB. If a pod sets no limits, the VM stays at the defaults.

The practical rule here is simple: align the defaults to the runner pod's
requests when every job creates a fresh VM and immediately needs that baseline
anyway; let `resources.limits` remain the hotplug ceiling. The repo ships
[`infra/tune-kata-runtime.sh`](../tune-kata-runtime.sh) to apply exactly this
change (plus the virtiofsd worker-pool tuning below) over SSH to the host.

### `shared_fs = "virtio-fs"` — sharing the container rootfs into the VM

The container's rootfs is prepared on the **host** by containerd's overlayfs
snapshotter (see below). Rather than repackaging it as a virtual disk, Kata runs
**virtiofsd** (`/opt/kata/libexec/virtiofsd`) on the host to export that
directory over **virtio-fs**, and the guest mounts it as the container root.
This is why `disable_block_device_use = true`: the rootfs travels in over the
shared filesystem, not as a block device. Benefits: no image-to-block
conversion, near-instant rootfs availability, and host/guest can both see the
files. `virtio_fs_cache = "auto"` keeps the conservative page-cache behavior, but
the active worker pool is now `--thread-pool-size=4` rather than `1` so
metadata-heavy mounted-cache and dependency-install paths have a few host workers
to fan out across. `--announce-submounts` keeps nested mounts visible to the guest.

`emptydir_mode = "shared-fs"` extends the same mechanism to Kubernetes
`emptyDir` volumes — they are shared into the guest over virtio-fs instead of
being block devices.

### `block_device_driver = "virtio-scsi"` — for the volumes that *are* blocks

Even with `disable_block_device_use = true` for the rootfs, any genuine block
volume (e.g. a `local-path` PVC presented as a device) is attached over a
**virtio-scsi** controller, with `block_device_aio = "io_uring"` for efficient
async I/O. virtio-scsi (vs virtio-blk) supports more disks per controller and
hotplug, which matters when volumes attach after boot.

### vsock agent channel

The shim on the host talks to `kata-agent` inside the guest over a
**VIRTIO-VSOCK** channel — a host↔guest socket transport that needs no guest IP
or network. All container lifecycle operations (create/start/exec/IO/metrics)
are ttRPC calls over that vsock link. In Kata 3.x vsock is the default and only
agent transport, so there is no `use_vsock` toggle to set; the config instead
shows `use_legacy_serial = false`, confirming the guest console/agent path is on
the modern virtio channel rather than a legacy serial port. The upshot: the
agent control plane is isolated from the pod's data-plane networking entirely.

### Networking into the guest

`internetworking_model = "tcfilter"` is how the pod's CNI veth reaches the VM:
Kata creates a TAP device for the guest NIC and installs a TC (traffic-control)
filter that mirrors packets between the CNI-provided veth and the TAP. The pod
keeps the IP Flannel assigned it; the VM transparently sits behind it. Egress
restrictions are enforced one layer up by a NetworkPolicy — see
[`04-arc-and-caching.md`](./04-arc-and-caching.md).

### `factory.enable_template = false` — a fresh VM per job, deliberately

Kata's **VM factory/templating** can pre-create a paused "template" VM and fork
new microVMs from it via copy-on-write memory, shaving boot time. It is **off**
here (`enable_template = false`, `vm_cache_number = 0`) on purpose: CI jobs must
be mutually isolated and reproducible, so each job gets a **pristine VM built
from scratch** with no memory state inherited from a previous job. The boot cost
(a second or two) is an acceptable price for clean isolation, and the preloaded
runner image ([`03-runner-image.md`](./03-runner-image.md)) is what removes the
*real* per-job cost (dependency installs), not VM templating.

### Interaction with the overlayfs snapshotter

k3s's containerd uses the default **overlayfs** snapshotter. For a `runc` pod
that overlay mount *is* the container root. For a Kata pod, containerd still
builds the same overlayfs rootfs on the host, but because `shared_fs =
"virtio-fs"` it is **exported into the guest by virtiofsd** rather than used
directly. So the two cooperate cleanly: the snapshotter assembles image layers
on the host (image pulls, layer caching, dedup all work normally), and virtio-fs
projects the result into the microVM. No special snapshotter (devmapper /
blockfile) is needed — that would only be required if you wanted the rootfs
delivered as a block device instead of a shared filesystem.

---

## Step 5 — Verify microVM isolation

The defining test: a pod under `kata-qemu` must report a **different kernel**
than the host. Run a throwaway pod with `--rm` so nothing is left behind. On
your reproduction host:

```bash
# Inside the microVM (Kata): guest kernel.
kubectl run kata-smoke --rm -it --restart=Never \
  --image=busybox \
  --overrides='{"spec":{"runtimeClassName":"kata-qemu"}}' \
  -- uname -r
```

Expected — the **guest** kernel:

```text
6.18.28-194
```

Compare with the host kernel:

```console
$ uname -r
7.0.10-1.el10.elrepo.x86_64
```

Different kernel string == the workload is genuinely inside a separate guest
kernel, not a namespaced host process. As a control, the same pod **without**
the RuntimeClass runs on `runc` and prints the **host** kernel
(`7.0.10-1.el10.elrepo.x86_64`) — proving the difference comes from Kata, not
the image.

For a closer look at the VM's resources (confirming the hotplug sizing from Step
4), use an image with more tools:

```bash
kubectl run kata-smoke --rm -it --restart=Never \
  --image=ubuntu:24.04 \
  --overrides='{"spec":{"runtimeClassName":"kata-qemu"}}' \
  -- bash -lc 'uname -r; nproc; grep MemTotal /proc/meminfo'
```

This prints the guest kernel, the hotplugged vCPU count, and guest RAM (MiB) —
which track the pod's `resources.limits`, not the host's 32c/125G.

> **On the live host, do not run throwaway pods.** It is production CI. Use the
> read-only host checks instead: `kata-runtime check` and `kata-runtime env`
> (Step 1) prove the runtime is healthy without scheduling anything. The
> equivalent VM-boot proof for the actual runner image is the `preload-verify`
> recipe documented in [`03-runner-image.md`](./03-runner-image.md).

---

## Recap

1. Static tarball extracted to `/opt/kata` (QEMU + guest kernel + rootfs +
   virtiofsd + shim), shim and CLI symlinked onto `PATH`.
2. Drop-in `config-v3.toml.d/kata.toml` registers the `kata-qemu` runtime
   (`io.containerd.kata.v2`, pinned `runtime_path`, `ConfigPath`), merged via
   k3s's generated `imports`; picked up on `systemctl restart k3s`.
3. `RuntimeClass/kata-qemu` (`handler: kata-qemu`) lets pods opt in.
4. `configuration-qemu.toml` boots a small QEMU q35 VM (1 vCPU / 2 GiB) that
   hotplugs up to the pod's limits, shares the container rootfs in over
   virtio-fs, talks to the agent over vsock, and builds a fresh VM per job
   (templating off).
5. A `kata-qemu` pod reports guest kernel `6.18.28-194` vs host
   `7.0.10-1.el10.elrepo.x86_64` — isolation confirmed.

Continue to [`03-runner-image.md`](./03-runner-image.md) to build the runner
image that boots inside these microVMs.
