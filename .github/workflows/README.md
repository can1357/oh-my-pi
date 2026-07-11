# GitHub Actions

This fork runs its CI and releases on **standard GitHub-hosted runners**. Because
the repository is public, GitHub-hosted runners are free and unlimited, so there
is **no Actions billing** and no self-hosted infrastructure to maintain.

## Active workflow: `ci.yml`

The CI/release pipeline lives in a single workflow, `ci.yml`, which handles three things:

- **Main / PR checks** — on every push to `main` and every pull request it lints,
  type-checks, builds the web bundle, compiles the native Rust/N-API addons, and
  runs the TS test buckets plus the install-method smoke tests.
- **Version releases** — `bun scripts/release.ts <version>` bumps the version,
  updates changelogs, then atomically pushes the release commit **and** its `v*`
  tag to `main` in one push. That single branch push is the authoritative release
  trigger: `release_metadata` detects the `v*` tag at HEAD and runs the full
  build → publish pipeline. There is deliberately **no separate tag trigger**
  (it would duplicate the release run).
- **Manual dispatch** — `workflow_dispatch` with the **`publish_npm`** input.

## Release flow (automatic)

When `release.ts` pushes the atomic commit + tag, the main-branch run resolves
the tag and, since HEAD carries it, builds and publishes:

1. Native addons for every target (Linux x64/arm64, macOS x64/arm64, Windows x64).
2. **Five release binaries**, uploaded to a GitHub Release for the `v*` tag:
   - `omp-linux-x64`
   - `omp-linux-arm64`
   - `omp-darwin-x64`
   - `omp-darwin-arm64`
   - `omp-windows-x64.exe`
3. The GitHub Release itself (with generated notes) and, optionally, the Homebrew
   tap formula.

This is fully automatic and needs only the default `GITHUB_TOKEN`. macOS signing
and npm are **opt-in**.

## Optional secrets

- **macOS signing / notarization** — auto-skipped unless every `APPLE_*` secret
  is set (`APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER_ID`, `APPLE_API_KEY`). Without them, macOS binaries ship with
  an ad-hoc signature.
- **npm publishing** — opt-in. The automatic release does **not** publish to npm,
  so no `NPM_TOKEN` or OIDC trusted-publisher setup is required to cut a release.
  To publish, run the workflow manually (`workflow_dispatch`) from the release
  tag with **`publish_npm`** enabled; npm then uses trusted publishing (OIDC) with
  `NPM_TOKEN` as the fallback / first-publish auth.

## Manual dispatch & `publish_npm`

Trigger `ci.yml` by hand from a `v*` tag (or a `main` HEAD that carries one) and
it is treated as a release run, re-running the release pipeline. Enable
**`publish_npm`** (default `false`) to also publish the npm packages and the
per-platform native addon leaves in that same run. A plain tag/main push carries
no input, so `publish_npm` is `false` there and npm never runs automatically —
this is what keeps the automatic release free of any npm-secret requirement.

## Runners & cost

All jobs run on public GitHub-hosted runners (`ubuntu-22.04`, `ubuntu-24.04-arm`,
`macos-15-intel`, `macos-15`). Public-repository minutes are free and unlimited,
so there is no billing concern. The composite actions under `.github/actions/`
still carry a dormant self-hosted (`omp-kata`) optimization path that simply
never activates on GitHub-hosted runners.

See the repo-root `AGENTS.md` for package/release conventions. For the separate
Hugging Face installer distribution channel, see
[`docs/RELEASING-FORK.md`](../../docs/RELEASING-FORK.md).
