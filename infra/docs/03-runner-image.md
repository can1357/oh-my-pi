# 03 - Preloaded runner image

Each ephemeral CI job boots a fresh Kata microVM and runs inside a single
runner container. To keep that cold microVM **warm** (no per-job dependency
fetches), the container does not use the stock GitHub Actions runner image
directly: it uses a locally built image that bakes every dependency CI installs
on every job into the snapshot. This document covers building that image,
importing it into k3s containerd, pointing ARC at it, and verifying it.

Navigation: previous - [02-kata-runtime.md](./02-kata-runtime.md) (Kata +
containerd + RuntimeClass) | next - [04-arc-and-caching.md](./04-arc-and-caching.md)
(ARC runners, shared caches, egress policy).

> The image built here is referenced by the ARC runner pod template
> (`template.spec.containers[0].image` + `imagePullPolicy: IfNotPresent`),
> documented in [04-arc-and-caching.md](./04-arc-and-caching.md). The pinned
> `runtimeClassName: kata-qemu` on that same template comes from
> [02-kata-runtime.md](./02-kata-runtime.md).

All host commands below run on `<CI_HOST>` (the single k3s node) as root.

---

## 1. Why a preloaded image

The base `ghcr.io/actions/actions-runner:latest` is a clean Ubuntu 24.04 runner.
On a normal (GitHub-hosted-style) runner, the CI workflow installs its system
dependencies at the start of every job: the cairo/pango native stack for canvas
builds, `fd`/`ripgrep`/`imagemagick`, `bun`, `sccache`, Zig, the cargo-native
helper CLIs (`cargo-nextest`, `cargo-zigbuild`, `cargo-xwin`), `bazelisk` with a
pre-warmed pinned Bazel for the Bazel native pipeline, and a pinned Rust
nightly with the cross targets/components. Inside a Kata microVM that is
destroyed after a single job, paying that apt/bun/rustup/tool-download cost on
**every** job is pure latency - the microVM starts cold each time.

The preloaded image moves that work to build time. Every ephemeral runner then
starts with the toolchain already present: apt deps are not re-fetched, `bun`,
`cargo`/`rustc`, `sccache`, `zig`, `bazel`(isk), and the cargo helper CLIs are
on `PATH`, and
the pinned Rust toolchain is already the default so target/component installs in
CI become no-ops.

### Stay in sync with `setup-system-deps`

The apt set baked into the image **must** match the repo's
`.github/actions/setup-system-deps` composite action. That action is the
self-healing counterpart: it probes for the baked tools and skips the apt
round-trip when they are present (preloaded image), but installs the exact same
set on a stock runner so CI still works anywhere. Its detection probes are:

```bash
command -v fd && command -v rg && command -v magick \
  && pkg-config --exists cairo pango
```

If you add a dependency that the action probes for, add it in **both** the
Dockerfile apt line and `setup-system-deps`. If they drift, either the action
re-installs deps the image already has (slow) or CI breaks on a tool the image
forgot to bake.

---

## 2. The Dockerfile

Build context lives at `/root/omp-kata-runner-image/`. The Dockerfile below is
reproduced verbatim (it contains no secrets or redactable host identifiers; the
`ARG` pins, the full apt set, and the toolchain steps are real).

> The canonical copy of this Dockerfile is version-controlled at
> [`infra/runner.Dockerfile`](../runner.Dockerfile);
> the `/root/omp-kata-runner-image/` copy is overwritten from it by the
> repo-driven reload script (see section 3 below).

```dockerfile
# syntax=docker/dockerfile:1
# Preloaded omp-kata runner image.
#
# Stock GitHub Actions runner (Ubuntu 24.04) with the dependencies CI installs
# on every job baked in, so each ephemeral Kata microVM boots with them already
# present instead of re-fetching them per job:
#   - APT system deps (canvas/cairo stack + fd/ripgrep/imagemagick) + fd/magick shims
#   - GitHub CLI (gh) — present on GitHub-hosted runners; the coding-agent github
#     tool and release workflows expect it
#   - C/build toolchain the native + canvas builds need
#   - bun (system-wide, on PATH)
#   - sccache + Zig + cargo-nextest/cargo-zigbuild/cargo-xwin for native builds
#   - rust nightly (pinned) + clippy/rustfmt/rust-analyzer + linux-arm64/windows-msvc targets
#
# Rebuild + reimport (see /root/omp-kata-runner.md) after bumping the ARGs below
# or the apt set. Keep the apt set in sync with .github/actions/setup-system-deps.
FROM ghcr.io/actions/actions-runner:latest

ARG RUST_NIGHTLY=nightly-2026-04-29
ARG BUN_VERSION=1.4.0
ARG SCCACHE_VERSION=0.15.0
ARG ZIG_VERSION=0.16.0

USER root
ENV DEBIAN_FRONTEND=noninteractive

# Mirrors the "Install system deps" block in .github/workflows/ci.yml plus the
# native/cross toolchain (clang/lld/llvm), the baked cache/tooling binaries, and
# the GitHub CLI. The gh apt repo is added first so `gh` installs in the same apt
# transaction.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y \
      build-essential pkg-config curl ca-certificates git unzip xz-utils gh \
      clang lld llvm \
      libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
      fd-find ripgrep imagemagick \
 && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
 && ln -sf /usr/bin/convert /usr/local/bin/magick \
 && rm -rf /var/lib/apt/lists/*

# bun, system-wide (BUN_INSTALL/bin == /usr/local/bin, already on PATH).
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && bun --version

# Pinned native-build helpers, system-wide.
RUN curl -fsSL "https://github.com/mozilla/sccache/releases/download/v${SCCACHE_VERSION}/sccache-v${SCCACHE_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
      | tar -xz -C /tmp \
 && install -m755 "/tmp/sccache-v${SCCACHE_VERSION}-x86_64-unknown-linux-musl/sccache" /usr/local/bin/sccache \
 && rm -rf "/tmp/sccache-v${SCCACHE_VERSION}-x86_64-unknown-linux-musl"
RUN curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz" -o /tmp/zig.tar.xz \
 && tar -xJf /tmp/zig.tar.xz -C /opt \
 && ln -sf "/opt/zig-x86_64-linux-${ZIG_VERSION}/zig" /usr/local/bin/zig \
 && rm -f /tmp/zig.tar.xz

# rust toolchain + cargo helpers for the runner user; rustup default == pinned
# nightly so Rust setup becomes a no-op on the preloaded image.
USER runner
ENV RUSTUP_HOME=/home/runner/.rustup \
    CARGO_HOME=/home/runner/.cargo \
    PATH=/home/runner/.cargo/bin:/usr/local/bin:${PATH}
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain "${RUST_NIGHTLY}" --profile minimal \
 && rustup component add clippy rustfmt rust-analyzer \
 && rustup target add aarch64-unknown-linux-gnu x86_64-pc-windows-msvc \
 && cargo install --locked cargo-nextest cargo-zigbuild cargo-xwin \
 && cargo --version \
 && rustc --version \
 && sccache --version \
 && zig version \
 && cargo-nextest --version \
 && cargo-zigbuild --help >/dev/null \
 && cargo-xwin --help >/dev/null
```

### Stage-by-stage annotation

**`# syntax=docker/dockerfile:1` + `FROM ghcr.io/actions/actions-runner:latest`.**
BuildKit frontend pin, then the stock Actions runner base (Ubuntu 24.04). The
base already ships the runner agent and its `/home/runner/run.sh` entrypoint, the
non-root `runner` user, and `sudo`. Everything below layers onto that base; the
runner agent itself is never modified.

**`ARG RUST_NIGHTLY` / `ARG BUN_VERSION`.** The two version knobs you bump. They
are build args so you can also override them ad hoc with
`docker build --build-arg RUST_NIGHTLY=... --build-arg BUN_VERSION=...` without
editing the file. `RUST_NIGHTLY` must match what the repo's
`dtolnay/rust-toolchain@nightly` step expects so the toolchain install in CI is a
no-op (see step 4 below).

**`USER root` + `ENV DEBIAN_FRONTEND=noninteractive`.** Switch to root for the
apt and bun system installs; `noninteractive` suppresses debconf/tzdata prompts
during `apt-get install`.

**The apt `RUN` block.** This is the set that must mirror `setup-system-deps`.
In order:
- The first three lines add the **GitHub CLI apt repository** (keyring + signed
  source list) *before* `apt-get update`, so `gh` resolves and installs in the
  same apt transaction as everything else. `gh` is present on GitHub-hosted
  runners and is expected by the release workflows and the coding-agent `github`
  tool.
- `apt-get install` pulls three groups:
  - **build toolchain / utilities:** `build-essential pkg-config curl
    ca-certificates git unzip xz-utils gh clang lld llvm`.
    `build-essential` + `pkg-config` are needed by the native and canvas builds;
    `gh` is used by release workflows and the coding-agent GitHub tool; `clang
    lld llvm` are the MSVC-cross prerequisites that used to be apt-installed per
    job.
  - **canvas / cairo native stack:** `libcairo2-dev libpango1.0-dev libjpeg-dev
    libgif-dev librsvg2-dev` - the `-dev` headers the canvas/rsvg native modules
    compile against.
  - **CLI tools:** `fd-find ripgrep imagemagick`, used by the agent and tests.
- **The two shims** normalize Debian's binary names to what callers expect:
  Debian ships `fd` as `fdfind`, so `ln -sf "$(command -v fdfind)"
  /usr/local/bin/fd` exposes it as `fd`; ImageMagick installs `convert`, so
  `ln -sf /usr/bin/convert /usr/local/bin/magick` exposes the v7-style `magick`
  name. These two shims are exactly what `setup-system-deps` recreates on a stock
  runner.
- `rm -rf /var/lib/apt/lists/*` drops the apt index to keep the layer smaller.

**bun (`ENV BUN_INSTALL=/usr/local` + install `RUN`).** Setting
`BUN_INSTALL=/usr/local` makes the official installer drop the binary at
`/usr/local/bin/bun`, which is already on `PATH` for every user - so bun is
**system-wide** with no per-user shell init. The version is pinned via
`bun-v${BUN_VERSION}`, and `bun --version` fails the build if the install is
broken.

**Pinned native-build helpers (two root `RUN`s).** `sccache` is downloaded as a
version-pinned GitHub release tarball and installed to `/usr/local/bin`; Zig is
downloaded as the pinned release archive, unpacked under `/opt`, and symlinked
into `/usr/local/bin/zig`. Baking these two removes the per-job
`mozilla-actions/sccache-action` and `mlugg/setup-zig` downloads from the
self-hosted path.

**Rust toolchain (`USER runner` + rustup `RUN`).** The toolchain is installed as
the **`runner` user** - the UID jobs execute as - so cargo/rustc are owned by and
visible to the job without sudo. `RUSTUP_HOME`/`CARGO_HOME` are pinned under
`/home/runner`, and `~/.cargo/bin` is prepended to `PATH`. rustup installs the
pinned nightly as the **default toolchain** (`--profile minimal`), then adds the
`clippy`, `rustfmt`, and `rust-analyzer` components plus the
`aarch64-unknown-linux-gnu` (Linux arm64) and `x86_64-pc-windows-msvc` (Windows
cross) targets. The same layer also `cargo install`s the Rust-native helper CLIs
`cargo-nextest`, `cargo-zigbuild`, and `cargo-xwin`, so the self-hosted native
build path no longer fetches those tools job-by-job. Because the default toolchain
already *is* the pinned nightly with these components/targets, the corresponding
Rust setup steps in CI become no-ops - the warm-start payoff.

---

## 3. Build, import, and roll out (`reload.sh`)

`/root/omp-kata-runner-image/reload.sh` does the whole cycle: build, in-image
smoke test, import into k3s containerd, point ARC at the new tag, and verify the
rollout. It is idempotent and cache-fast on an unchanged rebuild. Reproduced
verbatim (no secrets; the `/root` and kubeconfig paths are the real host paths):

```bash
#!/usr/bin/env bash
# Rebuild the preloaded omp-kata runner image, import it into k3s containerd,
# point the ARC runner scale set at it, and roll it out. Idempotent: safe to
# re-run after editing ./Dockerfile. Docker layer cache makes an unchanged
# rebuild near-instant.
#
#   ./reload.sh              # build tag omp-kata-runner:YYYY-MM-DD-HHMMSS
#   ./reload.sh 2026-06-20   # build tag omp-kata-runner:2026-06-20
#   ./reload.sh foo:bar      # build an explicit repo:tag
set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
cd "$(dirname "$0")"

arg="${1:-$(date +%Y-%m-%d-%H%M%S)}"
case "$arg" in *:*) IMAGE="$arg";; *) IMAGE="omp-kata-runner:$arg";; esac

echo "==> [1/5] building $IMAGE"
DOCKER_BUILDKIT=1 docker build -t "$IMAGE" -t omp-kata-runner:preloaded .

echo "==> [2/5] verifying baked tools"
docker run --rm --entrypoint bash "$IMAGE" -lc '
  set -e
  for b in gh fd rg magick bun cargo rustc pkg-config clang lld sccache zig cargo-nextest cargo-zigbuild cargo-xwin; do
    command -v "$b" >/dev/null || { echo "MISSING: $b"; exit 1; }
  done
  echo "tools OK | bun $(bun --version) | rust $(rustc --version) | sccache $(sccache --version | awk '\''{print $2}'\'') | zig $(zig version) | gh $(gh --version | head -1 | cut -d\" \" -f3)"
'

echo "==> [3/5] importing into k3s containerd (k8s.io namespace)"
docker save "$IMAGE" | k3s ctr -n k8s.io images import --platform linux/amd64 -

echo "==> [4/5] pointing ARC runner scale set at $IMAGE"
sed -i "s#image: omp-kata-runner:.*#image: $IMAGE#" /root/arc-omp-values.yaml
helm upgrade omp-kata --namespace arc-runners --version 0.14.2 \
  -f /root/arc-omp-values.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set >/dev/null

echo "==> [5/5] verifying rollout"
live="$(kubectl get autoscalingrunnerset omp-kata -n arc-runners -o jsonpath='{.spec.template.spec.containers[0].image}')"
echo "ARC runner image is now: $live"
[ "$live" = "$IMAGE" ] && echo "OK: reloaded $IMAGE" || { echo "MISMATCH: expected $IMAGE"; exit 1; }
```

Run it with no argument for an auto-dated tag:

```bash
cd /root/omp-kata-runner-image
./reload.sh
```

### What each step does

**Preamble.** `set -euo pipefail` aborts on the first error; `KUBECONFIG` points
at the k3s admin config; `cd` into the build context. The tag is resolved from
`$1`: no arg gives a timestamped `omp-kata-runner:YYYY-MM-DD-HHMMSS`; an argument
containing a colon (`foo:bar`) is used as an explicit `repo:tag`; anything else
is treated as a tag suffix on `omp-kata-runner:`.

**[1/5] build.** `DOCKER_BUILDKIT=1 docker build` tags the result twice: the
immutable `$IMAGE` (dated) and the moving `omp-kata-runner:preloaded` alias.
BuildKit + the docker layer cache make an unchanged rebuild near-instant.

**[2/5] verify baked tools.** Runs the freshly built image with a bash entrypoint
and asserts every expected binary is on `PATH`
(`gh fd rg magick bun cargo rustc pkg-config clang lld sccache zig cargo-nextest cargo-zigbuild cargo-xwin`),
failing the whole script if any is missing, then prints the key version tuple
(bun / rust / sccache / zig / gh). This catches a broken apt set, missing shim,
or bad toolchain pin **before** anything touches the cluster.

**[3/5] import into k3s containerd.**
`docker save "$IMAGE" | k3s ctr -n k8s.io images import --platform linux/amd64 -`
streams the image tarball straight from the docker daemon into k3s's **own**
containerd, in the `k8s.io` namespace - the namespace the kubelet pulls from.
`--platform linux/amd64` matches the host architecture. Note `docker save` is
given only the dated `$IMAGE`, so **only the dated tag is imported**; the
`:preloaded` alias stays a docker-local convenience and is never imported or
referenced by ARC.

**[4/5] point ARC at the new tag.** `sed -i` rewrites the single
`image: omp-kata-runner:...` line in `/root/arc-omp-values.yaml` to the new tag,
then `helm upgrade` re-renders the runner scale set with the chart pinned to
`0.14.2`. (That values file is the runner pod template, documented in
[04-arc-and-caching.md](./04-arc-and-caching.md).)

**[5/5] verify rollout.** Reads the image back off the live
`autoscalingrunnerset` via `kubectl ... jsonpath` and asserts it equals `$IMAGE`,
printing `OK` or exiting non-zero with `MISMATCH`. New ephemeral runner pods
created after this point boot from the new image; in-flight jobs finish on the
old one (the scale set is scale-to-zero, so this drains quickly).

### Running it from the repo (over SSH)

You do not have to keep `reload.sh` on the host. The repo ships the version-
controlled Dockerfile plus an SSH-driven wrapper that performs the rollout
remotely from a checkout:

- [`infra/runner.Dockerfile`](../runner.Dockerfile) - the image definition (source of truth).
- [`infra/reload-runner.sh`](../reload-runner.sh) - copies that Dockerfile to the host, then prefers a **direct containerd build path**: bootstrap pinned `buildkitd` + `buildctl` + `nerdctl` under the remote build dir if needed, build straight into the k3s `k8s.io` namespace, smoke-test from that image store, then `helm upgrade` ARC. Set `BUILD_BACKEND=docker` to force the legacy `docker build` + `docker save | ctr images import` path.

The host is never hardcoded; point it at your node with `CI_HOST`:

```bash
CI_HOST=<CI_HOST> ./infra/reload-runner.sh            # dated tag
CI_HOST=<CI_HOST> ./infra/reload-runner.sh 2026-06-20 # explicit tag
```

It honors the same defaults as the host script (remote build dir, ARC values
path, release name, namespace, chart version), each overridable via the
environment variables documented in the script header.

---

## 4. Why import into k3s containerd instead of using a registry

This is a single-node cluster, and the **only** consumer of the runner image is
the kubelet/containerd on that same node. A registry would add a service to run,
secure, and authenticate against, for zero benefit. Instead:

- `docker save | k3s ctr -n k8s.io images import` places the image directly into
  the containerd instance k3s schedules from. containerd normalizes the short
  reference `omp-kata-runner:<tag>` to `docker.io/library/omp-kata-runner:<tag>`
  in its store (verified: the imported tags appear under that prefix).
- The ARC pod template sets `imagePullPolicy: IfNotPresent`. Because the image is
  already present locally, the kubelet **uses the local copy and never attempts a
  pull** - no registry, no pull credentials, no registry egress (which the
  runner egress lockdown in [04-arc-and-caching.md](./04-arc-and-caching.md)
  would block anyway).

Trade-off: the image must be (re-)imported on every node that schedules runners.
Here that is exactly one node, so a re-roll is simply rebuild + re-import, and the
next job's microVM starts cold but with warm dependencies from the local store.

---

## 5. Tag conventions

| Tag | Mutability | Imported into containerd? | Referenced by ARC? | Purpose |
| --- | --- | --- | --- | --- |
| `omp-kata-runner:YYYY-MM-DD-HHMMSS` | immutable | yes | yes | the build of record; what runners actually boot |
| `omp-kata-runner:preloaded` | moving | no | no | docker-local alias to the most recent build |

- The default `reload.sh` tag is timestamped (`date +%Y-%m-%d-%H%M%S`). You can
  also pass a date-only tag (`./reload.sh 2026-06-20`) or an explicit `repo:tag`.
- ARC always pins the **immutable dated tag**, never `:preloaded`. That keeps a
  rollout reproducible and makes rollback trivial: `sed` the image line back to
  the prior dated tag (it is still in the local store) and `helm upgrade`.
- Live example at time of writing: the scale set references
  `omp-kata-runner:2026-06-15-002621`, held in containerd as
  `docker.io/library/omp-kata-runner:2026-06-15-002621`.

---

## 6. Bumping bun / Rust / the apt set and re-rolling

1. **bun:** edit `ARG BUN_VERSION=` in the Dockerfile (or pass
   `--build-arg BUN_VERSION=...`).
2. **Rust:** edit `ARG RUST_NIGHTLY=` to the new pinned nightly. Keep it equal to
   what the repo's `dtolnay/rust-toolchain@nightly` step resolves, so the CI
   toolchain install stays a no-op.
3. **apt set:** edit the `apt-get install` line. You **must** mirror the change in
   `.github/actions/setup-system-deps` (and, if you add a tool the action probes
   for, in its detection block - currently `fd`, `rg`, `magick`,
   `pkg-config --exists cairo pango`).
4. Re-roll:

   ```bash
   cd /root/omp-kata-runner-image
   ./reload.sh
   ```

   The rebuild is cache-fast for unchanged layers, the baked-tools check guards
   the change, and the import/helm-upgrade/verify steps roll the new tag out.
   The next job's microVM boots warm with the updated toolchain.

---

## 7. Verification

### Baked-tools check (any tag)

`reload.sh` step 2 already runs this on every build. To re-check an existing tag
standalone:

```bash
docker run --rm --entrypoint bash omp-kata-runner:preloaded -lc '
  set -e
  for b in gh fd rg magick bun cargo rustc pkg-config clang lld sccache zig cargo-nextest cargo-zigbuild cargo-xwin; do
    command -v "$b" >/dev/null || { echo "MISSING: $b"; exit 1; }
  done
  echo "tools OK | bun $(bun --version) | rust $(rustc --version) | sccache $(set -- $(sccache --version); echo "$2") | zig $(zig version) | gh $(set -- $(gh --version | head -1); echo "$3")"
'
```

Confirm the live ARC reference and that the tag exists in the k3s image store
(both read-only):

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get autoscalingrunnerset omp-kata -n arc-runners \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
k3s ctr -n k8s.io images ls | grep omp-kata-runner
```

### Kata microVM boot check

The baked-tools check above runs the image under plain docker; it does **not**
prove the image boots inside a Kata QEMU/KVM microVM. To verify that, launch a
throwaway pod with `runtimeClassName: kata-qemu` (the RuntimeClass set up in
[02-kata-runtime.md](./02-kata-runtime.md)) and confirm both the deps and the
**guest** kernel:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl run preload-verify -n arc-runners --restart=Never \
  --image=omp-kata-runner:2026-06-15-002621 \
  --overrides='{"spec":{"runtimeClassName":"kata-qemu"}}' \
  --command -- bash -lc 'uname -r; bun --version; rustc --version; magick -version | head -1'

kubectl logs preload-verify -n arc-runners
kubectl delete pod preload-verify -n arc-runners
```

Use the tag that is currently live (or any imported tag). `uname -r` should show
the Kata **guest** kernel (a 6.x `vmlinux.container` build), not the host kernel -
confirming the image really booted in its own microVM - and the `bun`/`rustc`/
`magick` lines confirm the baked toolchain is present inside the VM. This `kubectl
run` is the only step here that creates a cluster object; delete the pod
afterward as shown.

---

Continue to [04-arc-and-caching.md](./04-arc-and-caching.md) for how ARC
wires in the shared bazel-remote/Bun/Cargo cache storage, and locks down
runner egress.
