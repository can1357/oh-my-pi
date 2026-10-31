# 03 — Caching

vmon sandboxes share no filesystem: every job forks the same `omp-ci` snapshot and its writes die with it. CI caches therefore come from three places: the `omp-ci` template, the vmon node's Actions cache, and the vmon node's Bazel cache. There is no cache infrastructure of this repo's own.

| Cache | Where | Written by | Read by |
| --- | --- | --- | --- |
| Bazel action cache + CAS (Rust compiles, clippy, rustfmt, tests, `.node` addons) | vmon node Bazel cache, `$VMON_CACHE_URL/bazel` | branch and tag jobs on vmon | all vmon jobs (pull requests read-only) |
| Bazel repository cache, repo contents cache, xwin download cache | `/opt/bazel-repo-cache` in the `omp-ci` template | template build | vmon jobs (`.github/actions/bazel-cache`) |
| Bazel install base + fetched output base, bazelisk's Bazel | `~/.cache/bazel`, `~/.cache/bazelisk` in the template | template build | vmon jobs |
| bun package store | `~/.bun/install/cache` in the template; `bun-<os>-<lockhash>` Actions cache entry | template build; main's GitHub-hosted jobs (`bun-cache-warm.yml`, release jobs) | vmon jobs (template); GitHub-hosted jobs (Actions cache) |
| Cargo registry | `~/.cargo/registry` in the template | template build | `check` (`cargo fetch --locked`, then offline `cargo deny`) |
| linux-x64 addon pair | Actions cache `natives-linux-x64-v1-<native inputs hash>` | main's `native_addons` | PR `native_addons` |
| Addons within a run | workflow artifacts `natives-linux-x64`, `native-addons` (1 day) | `native_addons`, `native_addons_cross` | test and release jobs (`.github/actions/native-artifacts`) |

Template caches are refreshed by rebuilding `omp-ci` ([02-omp-ci-template.md](02-omp-ci-template.md#2-freshness)).

## 1. Actions cache

Workflows use the GitHub Actions cache unchanged (`actions/cache`, `Swatinem/rust-cache`, the `cache:` options of `setup-*`). On a vmon runner the `ci` template's runner sends those requests to the node the sandbox runs on, which stores the archives on vmon nodes instead of at GitHub; artifact uploads and downloads still go to GitHub. Scopes follow GitHub's rules (a job saves to its own ref and restores from its own ref, then the base branch, then the default branch). GitHub-hosted jobs keep using GitHub's cache, so entries saved on vmon runners and on GitHub-hosted runners are separate stores with the same keys.

Inspect or drop entries with `vmon admin ci caches --repo <OWNER>/<REPO>` and `vmon admin ci caches delete <OWNER>/<REPO> --key-prefix <prefix>`, or on the vmon dashboard's CI page.

## 2. Bazel cache

When the node serves it, the vmon runner exports `VMON_CACHE_URL` to every step; the node then serves a per-repository Bazel HTTP cache at `$VMON_CACHE_URL/bazel`. [`.github/actions/bazel-cache`](../../.github/actions/bazel-cache/action.yml) writes a bazelrc fragment (`rc` output) for `bazelisk --bazelrc=…`:

- not a vmon runner (`VMON_CI` unset): `--config=ci` only, uncached;
- vmon runner: `--config=ci`, `--repository_cache=/opt/bazel-repo-cache`, `--repo_env=OMP_XWIN_CACHE_DIR=/opt/bazel-repo-cache/xwin` (template-baked, [02-omp-ci-template.md](02-omp-ci-template.md#1-what-omp-ci-adds));
- plus, with `VMON_CACHE_URL` set: `--remote_cache=$VMON_CACHE_URL/bazel` with `--config=cache-rw` on branch and tag events or `--config=cache-ro` on `pull_request*` events (the node answers 403 to uploads from pull request jobs). Without `VMON_CACHE_URL` the step warns and builds without a remote cache.

`.bazelrc` carries only the policies: `cache-rw` (upload local results) and `cache-ro` (no uploads), both with `--remote_local_fallback`, 2 retries and a 60 s timeout, so a cache outage degrades to local execution instead of failing the build. Outputs are downloaded in full (no `--remote_download_toplevel`): an entry evicted from the node cannot be refetched later in the build.

Entries belong to the repository and stay on the node that stored them; a miss asks the other vmon nodes and keeps a copy. The node evicts least recently used entries beyond its Bazel cache size (`vmon serve --ci-bazel-cache-mb`).

## 3. Poisoning boundary

Both node caches accept writes only from jobs saving to a branch or tag, i.e. trusted pushes, dispatches and releases; pull request jobs can read but not write the Bazel cache, and save Actions cache entries only to their own `refs/pull/<n>/merge` scope. Pull requests of `ci.yml` run on GitHub-hosted runners and build nothing with Bazel anyway, and vmon refuses jobs from actors outside the public-repo allow-list ([01-vmon-runners.md](01-vmon-runners.md#4-trust-split)). Nothing else is shared between jobs: `node_modules`, Cargo `target/` and Bazel outputs live and die inside each sandbox, and the template caches are written only at template build time.

## 4. Operate

- **Hit rates.** Each Bazel job posts a "Bazel build summary" notice with its process counts; a warm build is dominated by `remote cache hit`. The bazel-cache step's notice says which policy (`cache-rw`/`cache-ro`) it used.
- **Cold node.** A node that never served this repository fetches misses from the other nodes; a fully cold cluster rebuilds once and repopulates.
- **Reset the Bazel cache.** The Bazel cache has no admin listing; stop the node and delete `<data-dir>/ci-cache/bazel/<repo id>/` (vmon operator task).
