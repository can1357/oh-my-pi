# Releasing this fork

A complete OMPK release has three independent publication gates. Finishing one
gate does not finish either of the others:

| Gate | Published artifact | Used by |
| --- | --- | --- |
| **GitHub** | the `vX.Y.Z` tag and GitHub Release assets | release history and direct GitHub asset consumers |
| **Hugging Face** | five standalone binaries in the private model repository, plus its `VERSION` pointer | explicit `--binary` / `-Binary` installs |
| **npm** | the selected 13-package core/workspace graph and all five native leaf packages | the default installer mode and direct `bun install -g` |

`bun scripts/release.ts X.Y.Z` creates the tag and drives the GitHub gate. It
does not publish the private Hugging Face channel, and a GitHub Release is not
evidence that either installer mode has moved to the same version. In
particular, npm is an independent, required gate: the default installers cannot
receive `X.Y.Z` until the complete npm package graph for `X.Y.Z` is available.

## Installer behavior

The canonical installer endpoints serve the installer scripts, not a
preselected binary:

```sh
# Default on macOS and Linux: install/validate Bun, then install the npm package.
curl -fsSL https://oh-my-pk.pkking.computer/install.sh | sh

# Explicit standalone binary mode.
curl -fsSL https://oh-my-pk.pkking.computer/install.sh | sh -s -- --binary
```

```powershell
# Default on Windows: install/validate Bun, then install the npm package.
irm https://oh-my-pk.pkking.computer/install.ps1 | iex

# Explicit standalone binary mode.
& ([scriptblock]::Create((irm https://oh-my-pk.pkking.computer/install.ps1))) -Binary
```

Default mode installs `@pk-nerdsaver-ai/pi-coding-agent` from npm. Explicit
binary mode supports macOS x64/arm64, Linux x64/arm64, and Windows x64. The two
modes have separate publication gates even though a complete release should use
the same `X.Y.Z` version in both.

Passing `--ref` / `-Ref` without the binary flag selects the source-install
path. Passing it together with the binary flag selects that exact binary tag.

## Hugging Face binary-channel contract

The standalone binaries live in the private Hugging Face **model** repository
`pkkidking/oh-my-pi-binaries` by default. `HF_REPO` can select another private
repository. The Cloudflare Worker holds the read token; installer clients never
receive a Hugging Face credential.

The repository layout for a complete release is:

```text
VERSION                         # exactly: vX.Y.Z plus a newline
vX.Y.Z/omp-darwin-arm64
vX.Y.Z/omp-darwin-x64
vX.Y.Z/omp-linux-arm64
vX.Y.Z/omp-linux-x64
vX.Y.Z/omp-windows-x64.exe
```

The public install endpoint exposes those private objects as:

```text
https://oh-my-pk.pkking.computer/version
https://oh-my-pk.pkking.computer/bin/vX.Y.Z/<filename>
```

`VERSION` must contain the **V-prefixed tag**, such as `v16.4.6`, never the bare
package version. The Unix and PowerShell installers use `/version` only in
explicit binary mode, then request `/bin/<tag>/<filename>`.

[`publish-binaries-hf.ts`](../scripts/publish-binaries-hf.ts) checks the five
filenames above across the requested build and files already present under the
tag. It flips `VERSION` only after the tag is complete. Partial uploads remain
addressable by their versioned `/bin/vX.Y.Z/...` paths, but unpinned binary
installs continue resolving the previous complete tag.

`--force-version` bypasses the completeness guard and can expose 404s on missing
platforms; reserve it for a deliberately partial channel. `--no-version`
uploads without changing the live pointer. `--force-build` rebuilds and
re-uploads requested files that already exist.

## Prerequisites

- `bun`, `sd`, `git`, and the Rust/Cargo toolchain used by the release and
  native-build scripts.
- The native toolchain and prebuilt native addon required by every binary target
  requested on a build host.
- The Hugging Face `hf` CLI and a write-scoped `HF_TOKEN` for the private model
  repository.
- A configured npm publication identity. CI publication should use the
  repository's trusted-publishing/token route rather than treating a local
  login on one build host as cross-platform completion.

Never place either Hugging Face or npm credentials in commands committed to the
repository, release notes, or logs.

## Release procedure

Use an unprefixed semantic version (`X.Y.Z`) with `release.ts`; it creates the
V-prefixed Git tag (`vX.Y.Z`).

### 1. GitHub gate

```sh
bun scripts/release.ts X.Y.Z
```

The script performs preflight checks, updates public package/workspace versions
and changelogs, commits, tags, pushes, and waits for the enabled GitHub Actions
release run. The GitHub result is one gate only.

### 2. Hugging Face binary gate

Run the publisher on hosts with the required native artifacts and toolchains.
Always pass the intended V-prefixed tag explicitly:

```powershell
# Windows x64 host
$env:HF_TOKEN = "<write-scoped-token>"
bun scripts/publish-binaries-hf.ts --tag vX.Y.Z --targets win32-x64
```

```sh
# Linux build host
HF_TOKEN="<write-scoped-token>" bun scripts/publish-binaries-hf.ts \
  --tag vX.Y.Z --targets linux-x64,linux-arm64

# macOS build host
HF_TOKEN="<write-scoped-token>" bun scripts/publish-binaries-hf.ts \
  --tag vX.Y.Z --targets darwin-x64,darwin-arm64
```

Requested cross-target builds still need that target's native addon and
toolchain; the binary publisher does not manufacture a missing cross-platform
native build. Reruns are idempotent unless `--force-build` is supplied. The last
run that makes all five filenames present flips `VERSION` to `vX.Y.Z`.

For local recovery,
[`release-local.ts`](../scripts/release-local.ts) composes the tag step and the
Hugging Face publisher:

```sh
bun scripts/release-local.ts X.Y.Z
bun scripts/release-local.ts X.Y.Z --skip-tag --targets darwin-x64,darwin-arm64
bun scripts/release-local.ts X.Y.Z --dry-run
```

It builds the host target by default. Its `--npm` option invokes the general npm
publish command, but that alone is not evidence that all five generated native
leaf packages were published; use the complete npm publication route below.

### 3. npm gate

The npm release must publish the same `X.Y.Z` across:

- the selected 13-package core/workspace graph published by
  [`ci-release-publish.ts`](../scripts/ci-release-publish.ts), including
  `@pk-nerdsaver-ai/pi-coding-agent` and `@pk-nerdsaver-ai/pi-natives`; and
- `@pk-nerdsaver-ai/pi-natives-linux-x64`,
  `@pk-nerdsaver-ai/pi-natives-linux-arm64`,
  `@pk-nerdsaver-ai/pi-natives-darwin-x64`,
  `@pk-nerdsaver-ai/pi-natives-darwin-arm64`, and
  `@pk-nerdsaver-ai/pi-natives-win32-x64`.

[`ci-release-publish.ts`](../scripts/ci-release-publish.ts) deliberately splits
this work. Its default mode publishes the selected 13-package core/workspace
graph, including the native core package. After the GitHub release is verified,
the dedicated `release_npm_native` matrix downloads each target's matching
`.node` artifacts and invokes the native-leaf mode before `release_npm` can
publish the core/workspace graph.

Trusted publishing must be configured for all 18 npm packages with repository
`kingkillery/oh-my-pk`, workflow `ci.yml`, and no npm environment restriction.
A package that has never been published cannot yet have that trusted publisher
configured; seed it once with a short-lived granular token, configure the
trusted publisher, then revoke the bootstrap token. For this remediation,
`@pk-nerdsaver-ai/pi-deep-research` is the only package requiring that one-time
seed.

For a new shared version, publish all five native leaves successfully before
publishing the workspace/core graph:

```text
bun scripts/ci-release-publish.ts --native-leaf linux-x64
bun scripts/ci-release-publish.ts --native-leaf linux-arm64
bun scripts/ci-release-publish.ts --native-leaf darwin-x64
bun scripts/ci-release-publish.ts --native-leaf darwin-arm64
bun scripts/ci-release-publish.ts --native-leaf win32-x64
bun scripts/ci-release-publish.ts
```

These are CI publication interfaces, not a claim that one local host has all
native artifacts. Use the repository's release publication job so every
native-leaf invocation receives the artifact produced for its platform. Do not
publish the workspace/core graph first: it would make the default package
version visible before its complete cross-platform native dependency set.

The npm gate is complete only when the registry contains the workspace/core
packages and all five native leaf packages at `X.Y.Z`. Until then, do not
describe the release as available through the default installers, regardless of
the GitHub Release or Hugging Face `VERSION` value.

## Completion checklist

- [ ] GitHub has the intended `vX.Y.Z` tag and completed GitHub Release.
- [ ] The private Hugging Face model repository contains all five binaries under
      `vX.Y.Z/`.
- [ ] Hugging Face `VERSION` contains exactly `vX.Y.Z`.
- [ ] `/bin/vX.Y.Z/<filename>` maps to each expected platform asset through the
      Worker.
- [ ] npm has the selected 13-package core/workspace graph and all five native
      leaf packages at `X.Y.Z`.
- [ ] The default installer resolves the npm release; explicit binary mode
      resolves the Hugging Face release.

See [the install-redirect guide](../infra/install-redirect/README.md) for Worker
route and secret configuration.
