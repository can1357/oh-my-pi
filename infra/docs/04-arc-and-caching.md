# 04 - ARC runners, shared caches, and egress policy

This is the last setup step. By now the node runs k3s with the `kata-qemu`
RuntimeClass ([02-kata-runtime.md](02-kata-runtime.md)) and the preloaded runner
image has been imported into the cluster containerd ([03-runner-image.md](03-runner-image.md)).
Here we install **actions-runner-controller (ARC)**, register an ephemeral
**scale set** whose pods each boot inside their own Kata microVM, stand up the
in-cluster **bazel-remote** Bazel cache and the runner cache PVC, and lock
down runner egress with a NetworkPolicy. See [README.md](README.md) for the
architecture overview.

Everything below is read against the live cluster; set the kubeconfig once:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
```

ARC's `gha-runner-scale-set` flavour has three moving parts:

- **Controller** (`arc` release, ns `arc-systems`) - watches `AutoscalingRunnerSet`
  custom resources and reconciles them.
- **Listener** (one pod per scale set, ns `arc-systems`) - long-polls the GitHub
  Actions service for jobs targeting the scale set's `runs-on` label.
- **Scale set** (`omp-kata` release, ns `arc-runners`) - the `AutoscalingRunnerSet`
  plus the pod template; the controller turns assigned jobs into ephemeral runner
  pods here.

---

## 1. GitHub App and the `arc-github` secret

The listener authenticates to GitHub. The durable option is a **GitHub App**
(no expiring user token, scoped to exactly the repos you install it on).

1. Create the App at **GitHub - Settings - Developer settings - GitHub Apps - New GitHub App**.
   - **Repository permissions**: `Administration: Read and write` (register/remove
     self-hosted runners) and `Metadata: Read-only` (granted automatically).
   - No webhook is needed for the scale-set flavour; uncheck **Active** under Webhook.
   - Generate and download a **private key** (`.pem`).
2. **Install** the App on the target repo or org (App page - **Install App** -
   pick `<OWNER>/<REPO>` or "All repositories"). Note the **App ID** and the
   **Installation ID** (the trailing number in the install settings URL,
   `.../installations/<id>`).
3. Create the secret in the runners namespace. The three key names below are
   exactly what the chart reads:

   ```bash
   kubectl create namespace arc-runners

   kubectl -n arc-runners create secret generic arc-github \
     --from-literal=github_app_id=<GITHUB_APP_ID> \
     --from-literal=github_app_installation_id=<GITHUB_APP_INSTALLATION_ID> \
     --from-literal=github_app_private_key=<GITHUB_APP_PRIVATE_KEY>
   ```

   `<GITHUB_APP_PRIVATE_KEY>` is the full PEM body (use `--from-file=github_app_private_key=key.pem`
   to avoid shell-quoting the multi-line value).

Verify the live secret carries those three keys (names only - never print values):

```bash
kubectl -n arc-runners get secret arc-github \
  -o go-template='{{range $k,$v := .data}}{{$k}}{{"\n"}}{{end}}'
# github_app_id
# github_app_installation_id
# github_app_private_key
```

**Token alternative.** ARC also accepts a single-key secret with a classic PAT
(scope `repo`) or a fine-grained PAT (`Administration: RW` + `Metadata: R`):

```bash
kubectl -n arc-runners create secret generic arc-github \
  --from-literal=github_token=<GITHUB_PAT>
```

The App is preferred: it does not expire, it is scoped per-installation, and one
installation covers every repo you grant it (useful for [adding another repo](#7-operate)).
Whichever you choose, the `githubConfigSecret` value in step 3's chart points at
this secret by name.

---

## 2. Install ARC (controller + scale set)

ARC ships as OCI Helm charts; no `helm repo add` is required. Both the controller
and the scale set are pinned to the same chart version, **0.14.2** (matches the
live `helm list -A`).

**Controller** (installed with chart defaults - `helm get values arc` is empty):

```bash
helm install arc \
  --namespace arc-systems --create-namespace \
  --version 0.14.2 \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller
```

**Scale set** (`omp-kata`), using the runner cache PVC and values file from step 3:
```bash
helm install omp-kata \
  --namespace arc-runners --create-namespace \
  --version 0.14.2 \
  -f arc-omp-values.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

Confirm both releases and the running controller image:

```bash
helm list -A
# arc       arc-systems   deployed  gha-runner-scale-set-controller-0.14.2  0.14.2
# omp-kata  arc-runners   deployed  gha-runner-scale-set-0.14.2             0.14.2

kubectl -n arc-systems get deploy arc-gha-rs-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
# ghcr.io/actions/gha-runner-scale-set-controller:0.14.2
```

Within a few seconds the controller spawns the listener in `arc-systems`:

```bash
kubectl -n arc-systems get pods
# arc-gha-rs-controller-xxxxxxxxxx-xxxxx   1/1   Running
# omp-kata-<hash>-listener                 1/1   Running
```

---

## 3. Scale-set values (`arc-omp-values.yaml`)

Create the namespace-local PVC before installing or upgrading the scale set. This
is the shared mutable filesystem cache for data whose tools already validate
against the lockfile: Bun's global package store and Cargo's registry cache.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: runner-cache
  namespace: arc-runners
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: local-path
  resources:
    requests:
      storage: 100Gi
```

Apply it once:

```bash
kubectl apply -f runner-cache-pvc.yaml
```

This is the live `arc-omp-values.yaml` verbatim, with only the repo owner/name in
`githubConfigUrl` redacted:

```yaml
githubConfigUrl: "https://github.com/<OWNER>/<REPO>"
githubConfigSecret: arc-github
runnerScaleSetName: omp-kata
minRunners: 0
maxRunners: 8
# none: each job runs inside the runner container, which itself lives in a Kata microVM
containerMode:
  type: ""
template:
  spec:
    runtimeClassName: kata-qemu
    securityContext:
      fsGroup: 1001
      fsGroupChangePolicy: OnRootMismatch
    containers:
      - name: runner
        image: omp-kata-runner:2026-07-27-072222
        imagePullPolicy: IfNotPresent
        command: ["/home/runner/run.sh"]
        envFrom:
          - secretRef:
              name: bazel-remote-ci
          - secretRef:
              name: sccache-s3   # legacy - removed together with the cargo CI pipeline
        volumeMounts:
          - name: runner-cache
            mountPath: /home/runner/.bun/install/cache
            subPath: bun-store
          - name: runner-cache
            mountPath: /home/runner/.cargo/registry/cache
            subPath: cargo-registry/cache
          - name: runner-cache
            mountPath: /home/runner/.cargo/registry/index
            subPath: cargo-registry/index
          # Shared Bazel repository cache: pods are ephemeral, so without it
          # every job re-downloads toolchains and crate archives. Content-
          # addressed and written atomically, safe to share across pods.
          # Deliberately OUTSIDE $HOME: kubelet creates missing mountpoint
          # parents root-owned, and a root-owned ~/.cache breaks bazel's
          # default output root and zig's wrapper cache.
          - name: runner-cache
            mountPath: /opt/bazel-repo-cache
            subPath: bazel-repo-cache
        resources:
          # Burstable on purpose: requests bin-pack 8 runners onto the
          # 32-vCPU / 125 GiB host; limits are each Kata VM's hotplug
          # ceiling. Keep sum(memory limits) under host RAM.
          requests:
            cpu: "3"
            memory: "10Gi"
          limits:
            cpu: "8"
            memory: "14Gi"
    volumes:
      - name: runner-cache
        persistentVolumeClaim:
          claimName: runner-cache
```

Field by field:

- **`githubConfigUrl`** - the repo (or org) the scale set serves. Jobs reach it
  with `runs-on: omp-kata`.
- **`githubConfigSecret: arc-github`** - the auth secret from [step 1](#1-github-app-and-the-arc-github-secret).
- **`runnerScaleSetName: omp-kata`** - the runner label. This is the string that
  goes in a workflow's `runs-on:`.
- **`minRunners: 0` / `maxRunners: 8`** - **scale-to-zero**. With no queued jobs
  there are zero runner microVMs. Runner pods are **burstable**: a small
  request (3 vCPU / 10 GiB) bin-packs eight runners onto the reference host,
  while the limit (8 vCPU / 14 GiB) is each Kata VM's hotplug ceiling, so a
  lone heavy job still gets 8 vCPUs. Keep the sum of memory *limits* under
  host RAM — host OOM under Kata kills VMs unpredictably. (The original
  guaranteed sizing, 4 x 8 vCPU / 24 GiB requests=limits, reserved the whole
  host and queued every >4-job workflow fan-out for minutes.)
- **`containerMode.type: ""`** - **none**. The default chart offers `dind`
  (Docker-in-Docker sidecar) or `kubernetes` mode for job-container isolation;
  both are unnecessary here because the *whole runner pod* is already isolated in
  a microVM. The job runs directly in the runner container - no privileged dind
  sidecar, no extra attack surface.
- **`template.spec.runtimeClassName: kata-qemu`** - the critical line. It binds
  the pod to the Kata QEMU runtime ([02-kata-runtime.md](02-kata-runtime.md)), so
  every runner boots its own KVM microVM with a guest kernel distinct from the host.
- **`image` / `imagePullPolicy: IfNotPresent`** - the locally built, dependency-baked
  runner image ([03-runner-image.md](03-runner-image.md)). `IfNotPresent` uses the
  copy already imported into cluster containerd; there is no registry. Bump the tag
  here when you rebuild the image (see [Operate](#7-operate)).
- **`command: ["/home/runner/run.sh"]`** - the stock actions-runner entrypoint;
  overridden explicitly because the custom image keeps the upstream layout.
- **`envFrom.secretRef`** - injects the bazel-remote cache credentials
  (`bazel-remote-ci`, [step 5](#5-shared-caches-bazel-remote--runner-pvc)) that
  every runner needs for read-write cache access. `sccache-s3` is the legacy
  sccache wiring and disappears with it ([5e](#5e-legacy-sccacherustfs-removed)).
- **`securityContext.fsGroup: 1001`** - makes the mounted PVC writable by the
  image's `runner` user without replacing image-owned `~/.cargo/bin` or `~/.rustup`.
- **`initContainers.prepare-runner-cache`** - uses the same locally imported image
  to create the PVC subdirectories as root before the runner starts. This avoids
  relying on kubelet's subPath auto-create permissions and does not pull another
  image.
- **`volumeMounts`** - mounts the shared PVC only at `~/.bun/install/cache` and
  `~/.cargo/registry`. `node_modules`, Cargo `target/`, and Cargo git checkouts
  stay inside the throwaway VM filesystem.
- **`volumes[].persistentVolumeClaim.claimName: runner-cache`** - binds those
  mounts to the `arc-runners/runner-cache` PVC. `ReadWriteOnce` is enough on this
  single-node k3s host; use a RWX-capable storage class before spreading runners
  across nodes.
- **`resources`** - requests `3` CPU / `10Gi`, limits `8` CPU / `14Gi`
  (burstable; see the `maxRunners` bullet above). Kata sizes the guest from
  these: every VM boots at the fixed floor from the runtime config
  (`default_vcpus: 2`, `default_memory: 4096` — deliberately at or below the
  pod request so boot stays cheap) and hotplugs beyond it toward the pod
  **limits**, with `default_maxvcpus: 0` allowing up to all host CPUs.
  Effectively the **boot shape is a fixed floor**, the **requests are the
  scheduler's bin-packing unit**, and the **limits are the hotplug ceiling**.
  See [02-kata-runtime.md](02-kata-runtime.md) for the runtime knobs and
  [`infra/tune-kata-runtime.sh`](../tune-kata-runtime.sh) for the SSH-driven
  patch helper.

---

## 4. Job lifecycle and the no-permission ServiceAccount

One job runs in one fresh microVM that is destroyed afterward:

1. The **listener** (ns `arc-systems`) long-polls the GitHub Actions service for
   jobs whose `runs-on` matches `omp-kata`.
2. When jobs are assigned, the controller reconciles the `AutoscalingRunnerSet`
   and creates an **`EphemeralRunnerSet`** sized to the demand (bounded by
   `minRunners`/`maxRunners`).
3. Each replica becomes an **ephemeral runner pod** registered **just-in-time
   (JIT)** with GitHub - a per-runner registration secret is minted, not a
   long-lived token.
4. Because the pod's `runtimeClassName` is `kata-qemu`, it **boots a microVM**,
   pulls the one assigned job, runs it, and exits.
5. ARC **deletes the pod** (and its microVM); a clean VM is created for the next
   job. There is no VM templating - state never leaks between jobs.

Observe the chain live:

```bash
kubectl -n arc-runners get autoscalingrunnerset omp-kata
kubectl -n arc-runners get ephemeralrunnerset
kubectl -n arc-runners get pods -o wide      # one pod per in-flight job; empty when idle
```

**No-permission ServiceAccount.** The scale-set chart runs every runner pod under
a ServiceAccount with no RBAC bindings:

```bash
kubectl -n arc-runners get sa
# default
# omp-kata-gha-rs-no-permission
```

Job code therefore has no Kubernetes API rights - it cannot read secrets, list
pods, or touch the cluster, even though it executes inside the cluster. Combined
with microVM isolation and the egress policy ([step 6](#6-runner-egress-lockdown)),
a compromised job is boxed into a throwaway VM with no cluster reach.

---

## 5. Shared caches (bazel-remote + runner PVC)

GitHub's hosted cache backend is only reachable over the node's NAT egress, so on
a busy matrix (many concurrent jobs) it becomes the bottleneck. This setup keeps
the hot paths inside the cluster:

- **bazel-remote** serves the Bazel remote cache (CAS + action cache) for the
  native pipeline. Rust compilation, clippy, rustfmt, tests, and the final
  `.node` addons are all Bazel actions, so this one content-addressed store
  replaces the previous sccache/RustFS backend, the rolling Cargo `target/`
  snapshots, and the native-artifact PVC directory ([5e](#5e-legacy-sccacherustfs-removed)).
- **`runner-cache` PVC** is mounted into every runner for Bun's global package
  store and Cargo's crates.io registry cache.

### 5a. Deploy bazel-remote

Unlike the legacy stack, the whole deployment lives in the repo under
[`infra/bazel-remote/`](../bazel-remote/):

- [`bazel-remote.yaml`](../bazel-remote/bazel-remote.yaml) - namespace
  `bazel-cache`, a 100Gi `local-path` PVC (`bazel-remote-data`), a
  single-replica `Recreate` Deployment pinned to
  `buchgr/bazel-remote-cache:v2.6.2` (`--max_size 90` GiB LRU, gRPC `:9092`,
  HTTP `:8080`, TLS + htpasswd from secret mounts,
  `--allow_unauthenticated_reads`), and the ClusterIP Service `bazel-remote`
  (9092 grpc + 8080 http). There is deliberately **no public exposure**: the
  cache is reachable only inside the cluster.
- [`setup.sh`](../bazel-remote/setup.sh) - the idempotent bootstrap, run **on
  the CI host** as root:

  ```bash
  ./setup.sh   # from a checkout of infra/bazel-remote/ on the host
  ```

  It generates a self-signed CA + server certificate (SANs:
  `bazel-remote.bazel-cache.svc.cluster.local`, `bazel-remote.bazel-cache.svc`,
  plus a private admin name via `ADMIN_SAN`), creates the secrets
  ([5b](#5b-endpoints-tls-and-auth)), applies `bazel-remote.yaml`, patches the
  egress policy ([step 6](#6-runner-egress-lockdown)), and removes any retired
  public exposure (NodePort service, firewalld `30992/tcp`) from earlier
  iterations.
  Re-running is safe: the CA, server cert, and `ci` password persist under
  `/root/bazel-remote-cache`, and every kubectl step is `apply`-based or
  guarded by a presence check.

Verify:

```bash
kubectl -n bazel-cache get deploy,svc,pvc
# deployment.apps/bazel-remote      1/1
# service/bazel-remote              ClusterIP   10.43.x.x   9092/TCP,8080/TCP
# (no public/NodePort service: the cache is cluster-internal only)
# persistentvolumeclaim/bazel-remote-data   Bound   100Gi   local-path

# Status endpoint (TLS is on, so use https; -k or --cacert the committed CA):
curl -sk "https://$(kubectl -n bazel-cache get pod -l app=bazel-remote \
  -o jsonpath='{.items[0].status.podIP}'):8080/status"
# {"CurrSize": ..., "MaxSize": 96636764160, "NumFiles": ..., ...}
```

### 5b. Endpoints, TLS, and auth

One endpoint, one auth model — **reads are unauthenticated, writes require the
`ci` credentials**, and only in-cluster clients can reach it at all:

| Client | Endpoint | Writes |
| --- | --- | --- |
| omp-kata runner pods (trusted `push`/main + release) | `grpcs://bazel-remote.bazel-cache.svc.cluster.local:9092` | yes - `ci` credentials injected via the `bazel-remote-ci` secret |
| GitHub-hosted runners (PRs, macOS, release) | — never touch this infrastructure; they persist a local `--disk_cache`/`--repository_cache` via `actions/cache` (`.github/actions/bazel-cache`) | n/a |

- **TLS.** The server certificate is signed by a self-signed CA committed at
  [`infra/bazel-remote/ca.crt`](../bazel-remote/ca.crt); every client passes
  `--tls_certificate=infra/bazel-remote/ca.crt`. Only the CA *key* stays on the
  host (`/root/bazel-remote-cache/ca.key`). `setup.sh` echoes the CA cert so
  the operator can commit it (the script cannot commit).
- **Secrets** (all maintained by `setup.sh`):
  - `bazel-cache/bazel-remote-tls` - server cert + key, mounted at `/tls`;
  - `bazel-cache/bazel-remote-auth` - bcrypt htpasswd with the single user
    `ci`, mounted at `/auth` (`--allow_unauthenticated_reads` keeps reads open);
  - `arc-runners/bazel-remote-ci` - `BAZEL_REMOTE_USER` / `BAZEL_REMOTE_PASSWORD`,
    injected into every runner pod via `envFrom`
    ([step 3](#3-scale-set-values-arc-omp-valuesyaml); `infra/reload-runner.sh`
    inserts the `envFrom` entry into `arc-omp-values.yaml` idempotently on the
    next image reload).
- **No GitHub secrets.** Nothing outside the cluster holds cache credentials;
  the public repo carries only the CA *certificate*.

### 5c. The cache consumers

**(a) Bazel remote cache** - `.bazelrc` carries the cache *policy* configs
(`cache-rw` / `cache-ro`); CI composes the endpoint and credentials per
environment:

```bash
bazel build \
  --config=cache-rw \
  --remote_cache=grpcs://bazel-remote.bazel-cache.svc.cluster.local:9092 \
  --tls_certificate=infra/bazel-remote/ca.crt \
  --remote_header="authorization=Basic $(printf %s "$BAZEL_REMOTE_USER:$BAZEL_REMOTE_PASSWORD" | base64 -w0)" \
  //:natives-linux-all
```

On omp-kata the credentials come from the injected pod env
(`bazel-remote-ci` secret) and `.github/actions/bazel-cache` composes the rc
fragment. GitHub-hosted jobs get the disk-cache branch of the same action —
no remote endpoint, no credentials, no infrastructure knowledge. The bridge
between the two worlds is the **disk-cache export**: main-push rust jobs
write a bazel disk cache alongside the remote cache and save it to the
GitHub Actions cache (once per lockfile change, `linux` scope). GitHub only
shares caches from the default branch across pull requests, so this export
is what keeps PR builds warm; kata jobs otherwise skip artifact downloads
entirely (`--remote_download_toplevel`), and the xwin MSVC splat persists on
the runner-cache PVC (`OMP_XWIN_CACHE_DIR`).

**(b) Cargo registry cache** - the scale-set pod template mounts only the
immutable download cache and sparse index at
`/home/runner/.cargo/registry/cache` and `/home/runner/.cargo/registry/index`.
Source extraction, lock files, Cargo git checkouts, and `target/` remain
job-local; virtio-fs does not propagate Cargo's file locks safely across VMs.

**(c) Bun package store** -
[`.github/actions/bun-install`](../../.github/actions/bun-install/action.yml)
wraps `bun install --frozen-lockfile`. On omp-kata, the pod template mounts
`runner-cache:/bun-store` at Bun's default store path
(`/home/runner/.bun/install/cache`), so the action only ensures the directory
exists before running Bun. Off-infra it still uses stock `actions/cache@v4` for
the same store path.

`node_modules` is deliberately not shared. It is lockfile-, platform-, script-,
and workspace-state-sensitive, and concurrent jobs would write through the same
tree. The clean VM still runs `bun install --frozen-lockfile`; it just reuses the
package tarball/extract store.

### 5d. Poisoning boundary and pressure

The bazel-remote store is content-addressed and **writes require the `ci`
credentials**, so the poisoning surface is exactly the set of jobs holding those
credentials. The primary defense is to keep untrusted code away from them:

- `ci.yml` routes every pull-request job to GitHub-hosted runners
  (`runs-on` resolves to `omp-kata` only for `push`/main, manual dispatch, and
  release). That expression lives in the base workflow, which GitHub uses
  verbatim for `pull_request` events, so a fork cannot override it. PR jobs
  never talk to the cluster at all — they build against a local
  `actions/cache`-backed disk cache — and fork code never sees
  `bazel-remote-ci` (the cache has no publicly reachable endpoint to attack).
- As defense in depth, set the repo's **Settings -> Actions -> Fork pull request
  workflows** policy to *Require approval for all outside collaborators* (or all
  forks). GitHub's public-repo default only gates first-time contributors.

The mounted-cache design still narrows the blast radius of trusted runs: no
shared `node_modules`, no shared Cargo `target/`, Bun installs from `bun.lock`,
and Cargo registry entries are checked against lockfile/source checksums.

Pressure is mostly self-managing:

- `bazel-cache/bazel-remote-data` - bazel-remote evicts LRU at `--max_size 90`
  GiB on its own; watch `CurrSize` on `/status` and grow the PVC/flag together
  if hit rates drop.
- `arc-runners/runner-cache` - coarse manual cleanup: scale `omp-kata` to zero,
  delete `bun-store/` or `cargo-registry/` from the bound local-path volume,
  let the next jobs repopulate it.

### 5e. Legacy: sccache/RustFS (removed)

The previous cache stack - RustFS (S3) in the `sccache` namespace backing
sccache, rolling Cargo `target/` snapshots via `scripts/ci-target-cache.ts`,
and source-hash-addressed `.node` artifacts on the runner PVC - is superseded
by the Bazel pipeline above. Once no workflow references remain, tear it down:

```bash
kubectl -n arc-runners delete secret sccache-s3
kubectl delete namespace sccache        # removes RustFS and the rustfs-data PVC
# then: drop the sccache tcp/9000 rule from runner-egress-lockdown, and remove
# the sccache-s3 envFrom entry, the native-artifacts subPath mount, and
# OMP_NATIVE_CACHE_DIR from arc-omp-values.yaml (+ helm upgrade).
```

---

## 6. Runner egress lockdown

Runner pods reach the public internet (GitHub, package registries, crates.io,
npm) but must **not** reach the host's own services, the LAN, the tailnet, or
arbitrary cluster workloads. A single NetworkPolicy in `arc-runners` enforces
this. Because the pod template sets no special labels, the policy uses
`podSelector: {}` to cover **every** pod in the namespace.

> k3s ships a built-in NetworkPolicy controller (kube-router based) that enforces
> policies even though the CNI is Flannel - so this policy actually takes effect.
> Do not start k3s with `--disable-network-policy` ([01-host-and-cluster.md](01-host-and-cluster.md)),
> or the lockdown silently becomes a no-op.

Live spec (captured with `kubectl get networkpolicy -n arc-runners runner-egress-lockdown -o yaml`;
server-managed metadata omitted, host public IP redacted):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: runner-egress-lockdown
  namespace: arc-runners
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  egress:
    # 1. Cluster DNS only (CoreDNS + kube-system).
    - to:
        - ipBlock:
            cidr: 10.43.0.10/32
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # 2. Public internet, MINUS all private/infra ranges and the host's own public IP.
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
              - 169.254.0.0/16
              - 100.64.0.0/10
              - <PUBLIC_IP>/32
    # 3. RustFS shared cache (S3) - legacy, removed together with sccache.
    - to:
        - ipBlock:
            cidr: 10.43.0.0/16
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: sccache
      ports:
        - port: 9000
          protocol: TCP
    # 4. bazel-remote shared cache (gRPC) over the cluster network.
    - to:
        - ipBlock:
            cidr: 10.43.0.0/16
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: bazel-cache
      ports:
        - port: 9092
          protocol: TCP
```

The allow-list, rule by rule:

- **Rule 1 - DNS.** UDP/TCP 53 to CoreDNS (`10.43.0.10/32`) and the `kube-system`
  namespace. Without this, name resolution breaks and rule 2 is useless.
- **Rule 2 - public internet only.** `0.0.0.0/0` with an `except` list that
  carves out every range a job has no business reaching: RFC1918 private space
  (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`), the CGNAT range
  used by the **tailnet** (`100.64.0.0/10`), and the **host's own public IP**
  (`<PUBLIC_IP>/32`). Note `10.0.0.0/8` covers the pod CIDR (`10.42.0.0/16`) and
  service CIDR (`10.43.0.0/16`), so this rule alone gives a job **zero** in-cluster
  reach - the remaining rules punch the only holes the job legitimately needs.
- **Rule 3 - RustFS cache (legacy).** TCP 9000 to the service CIDR
  (`10.43.0.0/16`) and the `sccache` namespace - drop this rule when the legacy
  stack is torn down ([5e](#5e-legacy-sccacherustfs-removed)).
- **Rule 4 - bazel-remote cache.** TCP 9092 to the service CIDR
  (`10.43.0.0/16`) and the `bazel-cache` namespace - the Bazel remote cache
  from [step 5](#5-shared-caches-bazel-remote--runner-pvc). `setup.sh` appends
  this rule idempotently via
  [`runner-egress-patch.yaml`](../bazel-remote/runner-egress-patch.yaml):

  ```bash
  kubectl -n arc-runners get networkpolicy runner-egress-lockdown -o json \
    | jq -e '.spec.egress[].to[]? | select(.namespaceSelector.matchLabels["kubernetes.io/metadata.name"] == "bazel-cache")' >/dev/null \
    || kubectl -n arc-runners patch networkpolicy runner-egress-lockdown \
         --type=json --patch-file=infra/bazel-remote/runner-egress-patch.yaml
  ```
- **Ingress.** `policyTypes` lists `Ingress` but no ingress rule is defined, which
  is a **default-deny**: nothing can open a connection *into* a runner pod.

Egress that survives rule 2 leaves the node via the host's firewalld masquerade
(SNAT to the public IP) over the default interface - see
[01-host-and-cluster.md](01-host-and-cluster.md) for the host firewall side.

### Security model

- **Kernel isolation.** Each job runs in a Kata microVM with its own guest kernel
  (6.x), separate from the host kernel (7.0.x) - a kernel exploit hits a throwaway
  VM, not the host. See [02-kata-runtime.md](02-kata-runtime.md).
- **No cluster rights.** Jobs run under `omp-kata-gha-rs-no-permission` with no
  RBAC ([step 4](#4-job-lifecycle-and-the-no-permission-serviceaccount)).
- **Constrained network.** The policy above blocks the host, LAN, tailnet, and
  arbitrary cluster pods; only DNS, the public internet, and the shared caches
  (bazel-remote, plus legacy RustFS until torn down) are reachable.
- **Ephemeral.** One job per VM, destroyed afterward - no state, secret, or
  artifact survives into the next job.
- **Public-repo recommendation.** For a public repo, require approval for fork
  PRs so untrusted code cannot auto-run on the infra: **repo - Settings - Actions
  - General - Fork pull request workflows from outside collaborators - Require
  approval for all outside collaborators**.

---

## 7. Operate

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
```

**Status / scale**

```bash
kubectl -n arc-runners get autoscalingrunnerset omp-kata   # min/max/current runners
kubectl -n arc-runners get ephemeralrunnerset              # desired vs current replicas
kubectl -n arc-runners get pods -o wide                    # live runner VMs (empty when idle)
```

**Logs**

```bash
# Listener (job dispatch / scaling decisions)
kubectl -n arc-systems logs -l app.kubernetes.io/component=runner-scale-set-listener -f
# Controller (reconciliation)
kubectl -n arc-systems logs deploy/arc-gha-rs-controller -f
# A specific runner / its job
kubectl -n arc-runners logs <runner-pod>
```

**Verify the caches are being used.** A warm Bazel build on omp-kata logs
`remote cache hit` counts in its build summary; `curl -sk https://<pod-ip>:8080/status`
shows `CurrSize`/`NumFiles` growing ([5a](#5a-deploy-bazel-remote)). A warm job
also logs `bun cache backend: mounted PVC (...)`. To inspect the mounted
runner cache, scale to zero and check the `runner-cache` local-path volume on
the host.

**Resize a job's VM** - edit the `resources` block in `arc-omp-values.yaml`
([step 3](#3-scale-set-values-arc-omp-valuesyaml); requests = guaranteed VM size,
limits = hotplug ceiling) and roll out:

```bash
helm upgrade omp-kata \
  --namespace arc-runners --version 0.14.2 \
  -f arc-omp-values.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

**Change scale-to-zero bounds** - edit `minRunners` / `maxRunners` in the same
file and `helm upgrade` as above. (Keep `maxRunners` within the node's CPU/RAM
budget: each runner can hotplug up to its `limits`.)

**Update the runner image** - bump `template.spec.containers[0].image` to the new
tag, then `helm upgrade` as above; confirm with:

```bash
kubectl -n arc-runners get autoscalingrunnerset omp-kata \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

See [03-runner-image.md](03-runner-image.md) for building and importing the image.

**Add another repo.** Because the GitHub App installation can cover multiple repos,
reuse the same `arc-github` secret and install a second scale set with its own
`githubConfigUrl`, `runnerScaleSetName` (the new `runs-on:` label), and release
name:

```bash
helm install <release> \
  --namespace arc-runners --version 0.14.2 \
  --set githubConfigUrl=https://github.com/<OWNER>/<OTHER_REPO> \
  --set githubConfigSecret=arc-github \
  --set runnerScaleSetName=<other-repo>-kata \
  -f arc-omp-values.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

Jobs in the other repo then target `runs-on: <other-repo>-kata`. (On this host a
convenience wrapper, `omp-add-repo-runner <OWNER>/<REPO> [label]`, performs exactly
this install.)

**Uninstall** (leaves k3s/Kata in place):

```bash
helm uninstall omp-kata -n arc-runners
helm uninstall arc -n arc-systems
```

---

**Previous:** [03-runner-image.md](03-runner-image.md) - the preloaded runner image.
**Overview:** [README.md](README.md) - architecture and the full doc set.
