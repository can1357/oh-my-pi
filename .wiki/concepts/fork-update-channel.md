---
type: Concept
title: Fork update channel
description: How oh-my-pk/omp installers and self-updates resolve fork releases, binaries, package-manager paths, and fallback sources.
tags: [updates, installers, release, fork, binaries]
timestamp: 2026-07-01T00:00:00Z
---

# Fork update channel

To ensure the fork receives its updates directly as they are pushed, the CLI update mechanism and installers are pointed to our dedicated distribution endpoint rather than the upstream OMP endpoints.

## Distribution endpoint

The canonical distribution endpoint is:
- **Base URL (`DIST_BASE`)**: `https://oh-my-pk.pkking.computer` (Overridable via `OMP_DIST_BASE` environment variable)
- **Version Endpoint**: `GET /version` -> returns the latest tag (e.g., `v16.1.11`)
- **Binary Endpoint**: `GET /bin/vX.Y.Z/<binary-name>` -> downloads the platform-specific compiled binary

## Update resolution policy

When `omp update` is run:
1. **Endpoint check (Primary)**: The CLI queries `https://oh-my-pk.pkking.computer/version` to get the latest tag.
2. **Registry check (Fallback)**: If the distribution endpoint is unreachable, the CLI falls back to querying npm registry metadata at `https://registry.npmjs.org/@pk-nerdsaver-ai/pi-coding-agent/latest`.
   
This dual-source strategy ensures pushed binary builds are visible immediately once the distribution `VERSION` pointer flips, while package-manager installs remain resilient to distribution outages by falling back to npm.

## Installers (`scripts/install.sh`, `scripts/install.ps1`)

The installer scripts fetch release info from the fork's distribution endpoint:
- **Repository**: `kingkillery/oh-my-pi`
- **NPM Package**: `@pk-nerdsaver-ai/pi-coding-agent`
- **Natives**: `@pk-nerdsaver-ai/pi-natives`
- **Aliases (Windows)**: Installs `oh-my-pk.exe`, `omp.exe`, and `ompk.exe`.

## Update targets

Self-update detects the active binary path and updates accordingly:

| Install method | Update target |
|---|---|
| Binary install | Atomic download and replacement from the fork's Hugging Face distribution endpoint. |
| Bun global install | Runs `bun install -g` pinning `@pk-nerdsaver-ai/pi-coding-agent`, `@pk-nerdsaver-ai/pi-natives`, and the platform leaf package from the NPM registry. |
| Homebrew | Runs `brew upgrade` or `brew reinstall` on `kingkillery/tap/omp`. |
| mise | Runs `mise upgrade` or `mise install --force` on `github:kingkillery/oh-my-pi`. |
