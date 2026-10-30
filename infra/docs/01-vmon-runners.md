# 01 — vmon runners: labels, setup, trust split, operations

CI jobs that need the self-hosted toolchain run on vmon (vibemon) sandboxes. vmon creates one sandbox per queued `workflow_job`, registers a just-in-time (JIT) runner in it for exactly that job, and kills it when the job completes. This repo only chooses labels and supplies the template ([02-omp-ci-template.md](02-omp-ci-template.md)); the runner service itself is part of vmon and is operated with the vmon cluster on cherry, horse and xeon.

## 1. `runs-on` labels

A vmon job carries exactly one label of the form `<size>[/<option>…]` (plus, optionally, `self-hosted`, `linux`, `x64`). Anything else makes vmon refuse the job with a reason shown on its dashboard; refused jobs never run.

| Label | vCPU | Memory |
| --- | --- | --- |
| `vmon-small` | 2 | 4 GiB |
| `vmon` | 4 | 8 GiB |
| `vmon-large` | 8 | 16 GiB |
| `vmon-xlarge` | 16 | 32 GiB |

Options:

- `from=<template>` — the template the sandbox starts from (default: vmon's public `ci`). This repo uses `from=omp-ci`, resolved in the CI team's namespace; pin a build with `from=omp-ci:<tag>`.
- `debug` — a failed job's sandbox is kept for 30 minutes (state `held`) instead of being killed, so it can be inspected.

`omp-ci` is built at the `vmon-large` size, and a sandbox forks the template snapshot only when the label's size equals the build size; any other size cold-boots the template disk (slower start, same contents). So every job uses **`vmon-large/from=omp-ci`**; to debug one, temporarily switch it to `vmon-large/from=omp-ci/debug`.

`.github/actionlint.yaml` lists the labels in use; add a label there before using it in a workflow.

## 2. Which jobs run where

`.github/workflows/ci.yml`:

| Job | Pull request | push `main` / dispatch / release |
| --- | --- | --- |
| `release_metadata` | `ubuntu-22.04` | `ubuntu-22.04` |
| `check` | `ubuntu-22.04` | `vmon-large/from=omp-ci` |
| `bazel_lock` | `ubuntu-22.04` | `ubuntu-22.04` |
| `rust_validate` | skipped | `vmon-large/from=omp-ci` |
| `native_addons` | `ubuntu-22.04` (restores main's addons, builds nothing) | `vmon-large/from=omp-ci` |
| `native_addons_cross` | skipped | `vmon-large/from=omp-ci` |
| `test_coding_agent_native` (3 shards on PRs, 1 on main) | `ubuntu-22.04` | `vmon-large/from=omp-ci` |
| `test_workspace`, `test_coding_agent_singleton`, `test_ts_native`, `test_coding_agent_ui`, `test_coding_agent_runtime`, `test_smoke`, `install_methods` | `ubuntu-22.04` | `vmon-large/from=omp-ci` |
| `release_gate`, `release_binary`, `release_native_leaves`, `release_github`, `release_build`, `release_npm`, `release_brew` | — | `ubuntu-22.04` |
| `release_smoke` | — | per-platform GitHub-hosted (`ubuntu-22.04`, `ubuntu-24.04-arm`, `macos-15-intel`, `macos-15`, `windows-2025`, `windows-11-arm`) |

`bun-cache-warm.yml` and `nix.yml` stay GitHub-hosted. Release jobs stay hosted because they build nothing Bazel-heavy and publish with OIDC; the `release_metadata` probe stays hosted so the release chain never waits on sandbox capacity.

Workflows detect a vmon runner by **`VMON_CI=1`** (set in the runner's `.env` by the `ci` template). `.github/actions/bun-install` and `.github/actions/bazel-cache` key their cache choices off it.

## 3. One-time vmon setup for this repo

Done by a vmon cluster admin (dashboard `/ci` pages, or `vmon admin ci …`):

1. **GitHub App.** vmon's CI GitHub App exists (created through the dashboard's manifest flow) and its webhook URL is the build.stencil.so relay route, which forwards to the vmon driver over the tailnet.
2. **Install** the app on `<OWNER>` with access to `<OWNER>/<REPO>` (the app's manifest already carries the permissions and the `workflow_job` event vmon needs).
3. **Link** the installation to the vmon **CI team** (the team whose API key builds `omp-ci`). Jobs of unlinked installations are refused.
4. **Public-repo policy.** `<OWNER>/<REPO>` is public, and vmon refuses public-repo jobs by default. Enable it for the account with an explicit allow-list, never `anyone`:

   ```
   PUT /admin/ci/accounts/<installationId>/public
   {"enabled": true, "anyone": false, "users": ["<maintainer>", …]}
   ```

   A run is accepted only when both the run's `actor` and its `triggering_actor` are listed.
5. **Team limits** (vmon team settings of the CI team):
   - concurrent sandboxes / vCPU / memory: a main push peaks at about 11 concurrent jobs (4 build/check jobs, then 8 test jobs while the long builds finish), i.e. ~88 vCPU / 176 GiB; overlapping release runs can double it. Lower limits only make jobs wait (`waiting` state);
   - `max_disk_mb` ≥ 65536: a template build's disk is the team's `max_disk_mb` at build time, and Bazel jobs need tens of GiB on top of the baked caches;
   - maximum sandbox length ≥ 6 h 10 min (vmon's CI sandbox timeout).
6. **Template.** Build `omp-ci` with the CI team's API key ([02-omp-ci-template.md](02-omp-ci-template.md)).

CI needs no repository secrets for caching: the vmon node serves both the Actions cache and the Bazel cache ([03-caching.md](03-caching.md)).

## 4. Trust split

PR code must never reach vmon or write shared caches:

- In `ci.yml` every job that can run on a PR resolves `runs-on` to `ubuntu-22.04` for `pull_request` events, and the Bazel jobs that need vmon are skipped on PRs. PR jobs build nothing with Bazel.
- That expression is not a security boundary by itself: for `pull_request` events GitHub runs the workflow file **from the PR's merge commit**, so a PR can rewrite `runs-on`. The boundaries are:
  1. vmon's public-repo allow-list (§3.4): a PR author outside the list cannot get a sandbox, even when a maintainer re-runs the job (both `actor` and `triggering_actor` must be listed);
  2. the vmon node's caches take writes only from jobs saving to a branch or tag: a pull request job, even on a vmon runner, can read the Bazel cache but not write it, and saves Actions cache entries only to its own pull request scope;
  3. **Settings → Actions → General → Fork pull request workflows: require approval for all outside collaborators**, so fork workflows do not start unattended.
- The cache poisoning surface is therefore the set of trusted branch and tag runs: pushes, dispatches and releases ([03-caching.md](03-caching.md#3-poisoning-boundary)).
- Sandboxes get no vmon credentials and no environment from vmon besides the runner's `.env` (and `VMON_CACHE_URL`); jobs see only what GitHub gives them.
- Sandbox egress follows vmon's default policy: public internet only, with private, link-local and tailnet ranges always denied.

## 5. Operations

**Where to look.** vmon's dashboard `/ci` shows the setup problems (no app, unlinked installations), the last jobs and 7-day stats; each job record has its labels, state, wait reason, sandbox and node, and (for completed jobs) the GitHub log. The same data is on the admin API (`GET /admin/ci`, `GET /admin/ci/jobs?repo=<OWNER>/<REPO>&state=failed`, `GET /admin/ci/jobs/<jobId>`).

**Job states.** `queued` (recorded) → `waiting` (team capacity or GitHub rate limit; `reason` says which, retried every 15 s) → `starting` (sandbox up, runner registering) → `running` → `completed`; `refused` (label, link or policy problem — the reason names it), `failed` (vmon-side error), `held` (debug hold).

**A job sits in "Waiting for a runner" on GitHub.** Check the job on the vmon dashboard: `refused` names the label/policy problem, `waiting` names the exhausted limit. No vmon record at all means the webhook never arrived: check the GitHub App's recent deliveries and the relay; vmon's reconcile loop redelivers failed deliveries within a minute or two once the path works.

**Debug a failing job.** Change its label to `vmon-large/from=omp-ci/debug` on a branch, dispatch, and inspect the held sandbox (id on the job record) with the usual vmon/E2B tooling before the 30-minute hold ends.

**Resize a job.** Change the size in its label. Sizes other than `vmon-large` cold-boot the template; if a different size becomes the common case, rebuild `omp-ci` at that size instead (`CPU_COUNT`/`MEMORY_MB` in the template script).

**Roll the toolchain.** Bump the pins in the repo, merge, rebuild `omp-ci` from that commit ([02-omp-ci-template.md](02-omp-ci-template.md#3-build-and-publish)). Jobs keep working against an older template build: stale caches only cost downloads.
