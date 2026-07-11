# Releasing this fork

The **primary** release path is automatic: `bun scripts/release.ts <version>`
pushes the release commit and its `v*` tag, and GitHub Actions — running on free,
unlimited, public-repository GitHub-hosted runners — builds the five platform
binaries and publishes a GitHub Release. npm is **opt-in** (manual dispatch with
`publish_npm`); see [`.github/workflows/README.md`](../.github/workflows/README.md).

This document covers the **installer distribution channel** and the local
fallback used when Actions is unavailable. It builds binaries on local hosts and
serves them from a **private Hugging Face repo** behind the install endpoint.
The current install scripts use this channel; it is independent of GitHub Releases.

## Primary vs. fallback

| Path | Trigger | Binaries | npm |
|---|---|---|---|
| **Primary — GitHub Actions** | `bun scripts/release.ts <v>` pushes commit + `v*` tag; Actions detects the tag at HEAD and builds all five targets on GitHub-hosted runners | GitHub Release (automatic) | opt-in via manual `publish_npm` dispatch |
| **Fallback — local (below)** | `bun scripts/release-local.ts <v>` on one or two hosts | private Hugging Face repo behind the install endpoint | local `npm publish` (`--npm`, opt-in) |

The two paths are independent; either can ship a release.

## Installer distribution model (Hugging Face)

- Installers (`scripts/install.ps1`, `scripts/install.sh`) download the compiled
  `omp` binary from a Cloudflare Worker (`oh-my-pk.pkking.computer`) that serves a
  **private Hugging Face repo** (`pkkidking/oh-my-pi-binaries`, override with
  `HF_REPO`).
- The repo layout is `VERSION` (a single line, e.g. `v16.1.10`) plus
  `<tag>/omp-<platform>` for each platform. Installs resolve whatever tag
  `VERSION` points at, so **`VERSION` must only point at a tag that has all
  platform binaries**, or the missing platforms 404.
- Required platform binaries (all five): `omp-darwin-arm64`, `omp-darwin-x64`,
  `omp-linux-arm64`, `omp-linux-x64`, `omp-windows-x64.exe`.
- npm packages publish to `registry.npmjs.org` under `@pk-nerdsaver-ai/*`
  (`npm whoami` should be `pk-nerdsaver-ai`).

## Prerequisites

- `bun`, `sd`, `git`, and (for the bump's lockfile regen) `cargo`.
- `HF_TOKEN` — a write-scoped Hugging Face token (env var) and the `hf` CLI
  (`pip install -U huggingface_hub`).
- For `--npm`: be logged in to npm as the owning org (`npm whoami`).
- The native toolchain for any non-host platform you build (see the gotcha
  below).

## One command

```sh
# Bump/tag/push + build the host binary and upload it to Hugging Face:
bun scripts/release-local.ts 16.1.10

# Also publish npm:
bun scripts/release-local.ts 16.1.10 --npm

# Dry run (prints every sub-command; HF/npm run in their own dry-run modes):
bun scripts/release-local.ts 16.1.10 --dry-run
```

`release-local.ts` runs three steps and is **idempotent** — re-running with a
version that is already bumped+tagged skips the bump and goes straight to
publishing (use `--skip-tag` to force that). Binary publishing is idempotent too:
targets already present under the release tag in Hugging Face are skipped before
local compilation.

## The cross-platform reality (two hosts cover all five)

The compiled binary embeds a native Rust/N-API addon (`@pk-nerdsaver-ai/pi-natives`),
so each target needs that target's std plus a way to link it. In practice **two
hosts build all five platforms**:

- **Windows host** — builds `win32-x64` natively.
- **Apple-Silicon Mac** — builds `darwin-arm64` natively and cross-builds
  `darwin-x64`, `linux-x64`, `linux-arm64` via `cargo-zigbuild`. (CI used an
  Intel runner for `darwin-x64`; on Apple Silicon, cross-build it with zigbuild.)

`publish-binaries-hf.ts` **only flips the `VERSION` pointer when every required
platform binary exists for the tag** (just-built ∪ already in the repo), so a
host-only run uploads its binary under `<tag>/` and leaves `VERSION` on the last
complete tag.

### Mesh recipe (tested for v16.1.10 — Windows + an Apple-Silicon Mac over Tailscale)

```sh
# --- Windows host: bump/tag/push + win binary (VERSION stays put, 1/5) ---
bun scripts/release-local.ts 16.1.10

# --- Apple-Silicon Mac, reached over Tailscale SSH (e.g. ssh k@mac2) ---
# One-time: bun + repo on MAIN (not the tag, see PITFALL) + deps
curl -fsSL https://bun.sh/install | bash
git clone --branch main https://github.com/kingkillery/oh-my-pk.git ompbuild && cd ompbuild && bun install
# Cross toolchain — rust targets MUST be added from INSIDE the repo so they land
# on the pinned rust-toolchain.toml channel, not the default:
rustup target add x86_64-apple-darwin x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu
brew install zig cargo-zigbuild
export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH" SDKROOT="$(xcrun --show-sdk-path)" HF_TOKEN=hf_xxx

# Build each native FIRST (ci-release-build-binaries only EMBEDS a prebuilt addon):
bun run build:native                                                                                        # darwin-arm64 (host)
CROSS_TARGET=x86_64-apple-darwin       TARGET_PLATFORM=darwin TARGET_ARCH=x64   TARGET_VARIANT=baseline bun --cwd=packages/natives run build
CROSS_TARGET=x86_64-unknown-linux-gnu.2.17  TARGET_PLATFORM=linux TARGET_ARCH=x64   TARGET_VARIANT=baseline bun --cwd=packages/natives run build
CROSS_TARGET=aarch64-unknown-linux-gnu.2.17 TARGET_PLATFORM=linux TARGET_ARCH=arm64                       bun --cwd=packages/natives run build

# Then the binaries + upload (darwin is ad-hoc codesigned automatically on macOS):
bun scripts/publish-binaries-hf.ts --tag v16.1.10 --targets darwin-arm64,darwin-x64
bun scripts/publish-binaries-hf.ts --tag v16.1.10 --targets linux-x64,linux-arm64   # completes 5/5 -> VERSION auto-flips
```

> **PITFALL (this caused a brief broken-linux window once):** build hosts MUST use
> the **guarded** `publish-binaries-hf.ts` from `main`. The VERSION-flip
> completeness guard was committed to `main` *after* the release tag, so a host
> that clones the *tag* gets the old script that flips `VERSION` unconditionally —
> publishing a partial set (e.g. 3/5) then silently 404s the missing platforms.
> Clone `main`, or `scp` / `git checkout` the guarded
> `scripts/publish-binaries-hf.ts` onto the host before publishing. The `.2.17`
> suffix on the linux `CROSS_TARGET`s is the glibc floor (zigbuild).

Escape hatches on `publish-binaries-hf.ts`: `--force-version` flips `VERSION`
even if platforms are missing (only when you intend a partial release);
`--no-version` uploads binaries without ever touching `VERSION`; `--force-build`
rebuilds/re-uploads requested targets even when they already exist under the tag.

## Manual installer-channel steps

```sh
# 1. Bump/tag/push (release.ts watches CI to completion now that Actions runs):
bun scripts/release.ts 16.1.10

# 2. Build + upload the host binary; VERSION flips only when all platforms exist:
HF_TOKEN=hf_xxx bun scripts/publish-binaries-hf.ts --tag v16.1.10

# 3. npm (publishes every public workspace):
bun run publish        # = bun run check && npm publish -ws --access public
```

## npm + native packages

`bun run publish` publishes every public `@pk-nerdsaver-ai/*` workspace. The
native package ships per-platform addons; a single host only produces its own,
so a cross-platform-correct npm release needs each platform built. Both the
GitHub Release built by Actions and the Hugging Face installer channel are
independent of npm. Treat `--npm` from one host as host-platform-complete only.
