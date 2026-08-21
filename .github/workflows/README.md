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
3. The GitHub Release itself (with generated notes), its macOS verification, and,
   optionally, the Homebrew tap formula.
4. Only when a manual dispatch enables **`publish_npm`**, five native npm leaves
   and then the 13 workspace/core packages.

The binary jobs have no npm setup or OIDC permission. They always upload their
artifacts before npm starts, so an npm authentication or registry failure cannot
undo or block the GitHub Release. The default release path needs only the default
`GITHUB_TOKEN`; macOS signing and npm remain opt-in.

## Optional secrets

- **macOS signing / notarization** — auto-skipped unless every `APPLE_*` secret
  is set (`APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER_ID`, `APPLE_API_KEY`). Without them, macOS binaries ship with
  an ad-hoc signature.
- **npm publishing** — uses GitHub OIDC only. `NPM_TOKEN` is neither required nor
  read by `ci.yml`, and there is deliberately no empty or long-lived token
  fallback.

## External npm trusted-publisher prerequisites

Before enabling `publish_npm`, every one of the five native leaf packages and
all 13 workspace/core packages must already exist on npm and have its own
**Trusted Publisher** configured with these exact values:

- Provider: **GitHub Actions**
- Organization or user: **`kingkillery`**
- Repository: **`oh-my-pk`**
- Workflow filename: **`ci.yml`**
- Environment: **none** (leave it blank)

This is 18 separate per-package configurations, not one configuration for the
scope or repository:

- Native leaves: `@pk-nerdsaver-ai/pi-natives-linux-x64`,
  `@pk-nerdsaver-ai/pi-natives-linux-arm64`,
  `@pk-nerdsaver-ai/pi-natives-darwin-x64`,
  `@pk-nerdsaver-ai/pi-natives-darwin-arm64`, and
  `@pk-nerdsaver-ai/pi-natives-win32-x64`.
- Workspace/core: `@pk-nerdsaver-ai/pi-utils`, `@pk-nerdsaver-ai/pi-wire`,
  `@pk-nerdsaver-ai/pi-catalog`, `@pk-nerdsaver-ai/pi-ai`,
  `@pk-nerdsaver-ai/pi-natives`, `@pk-nerdsaver-ai/pi-tui`,
  `@pk-nerdsaver-ai/hashline`, `@pk-nerdsaver-ai/pi-mnemopi`,
  `@pk-nerdsaver-ai/snapcompact`, `@pk-nerdsaver-ai/omp-stats`,
  `@pk-nerdsaver-ai/pi-agent-core`, `@pk-nerdsaver-ai/pi-deep-research`, and
  `@pk-nerdsaver-ai/pi-coding-agent`.

npm does not permit adding a trusted publisher until a package exists. Seed any
never-published package once outside this workflow with conventional
authentication, then configure the publisher before opting in. An `ENEEDAUTH`
failure in Actions means the per-package publisher is absent or mismatched; do
not add a workflow token fallback. Published manifests use the repository URL
`git+https://github.com/kingkillery/oh-my-pk.git`.

The two npm jobs pin Bun **1.3.14**, Node.js **24.19.0**, and npm **11.19.0**
(rather than `npm@latest`). npm 11.19.0 supports trusted publishing and its Node
engine range includes Node 24.

## Manual dispatch, ordering, and retries

Trigger `ci.yml` by hand from a `v*` tag (or from a `main` HEAD that carries one)
and enable **`publish_npm`** (default `false`). A plain tag/main push has no input,
so npm remains disabled on automatic releases.

Publication is strictly ordered:

1. `release_binary` uploads all five binary artifacts.
2. `release_github` publishes the release and `release_github_verify` verifies it.
3. `release_npm_native` runs five Ubuntu matrix children. Each downloads the
   matching same-run native artifact and publishes one of `linux-x64`,
   `linux-arm64`, `darwin-x64`, `darwin-arm64`, or `win32-x64`.
4. `release_npm` can publish the 13 workspace/core packages only after the whole
   native matrix succeeds, so all five leaves exist first.

If npm fails, the GitHub Release and binary artifacts remain successful. Choose
**Re-run failed jobs** on that same workflow run: successful binary/release jobs
are retained, failed npm work reuses the run's native artifacts, and already
published package versions are treated as successful skips. Do not start a new
manual run merely to retry npm; a new run rebuilds version-specific binaries and
native artifacts. If the original run's artifacts have expired, a new run is
required.

## Runners & cost

All jobs run on public GitHub-hosted runners (`ubuntu-22.04`, `ubuntu-24.04-arm`,
`macos-15-intel`, `macos-15`). Public-repository minutes are free and unlimited,
so there is no billing concern. The composite actions under `.github/actions/`
still carry a dormant self-hosted (`omp-kata`) optimization path that simply
never activates on GitHub-hosted runners.

See the repo-root `AGENTS.md` for package/release conventions. For the separate
Hugging Face installer distribution channel, see
[`docs/RELEASING-FORK.md`](../../docs/RELEASING-FORK.md).
