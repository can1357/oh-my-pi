# Self-hosted CI on vmon

Every trusted CI job of `.github/workflows/ci.yml` (pushes to `main`, manual dispatches, releases) runs on **[vibemon](https://github.com/stencil-hq/vibemon) (vmon)**: a job with `runs-on: vmon-large/from=omp-ci` gets its own fresh KVM microVM sandbox, forked from the snapshot of the repo's `omp-ci` template, which runs one ephemeral just-in-time (JIT) GitHub runner and is killed when the job ends. Pull requests run on GitHub-hosted runners, so untrusted PR code never reaches vmon or writes a shared cache. This repo operates no infrastructure of its own: caches are baked into the template or served by the vmon node.

## Architecture

```mermaid
flowchart LR
    GH["GitHub Actions<br/>&lt;OWNER&gt;/&lt;REPO&gt; + vmon GitHub App"]
    RELAY["build.stencil.so<br/>webhook relay (HMAC check)"]

    subgraph VMON["vmon cluster (cherry, horse, xeon)"]
      DRV["driver (leader)<br/>CI controller"]
      subgraph NODE["vmon node"]
        CACHE["node cache service<br/>Actions cache + Bazel cache ($VMON_CACHE_URL/bazel)"]
        subgraph SB["sandbox per job: vmon-large (8 vCPU / 16 GiB)"]
          JOB["omp-ci fork<br/>actions/runner --jitconfig<br/>one job's steps"]
        end
      end
    end

    GH -->|"workflow_job webhook"| RELAY
    RELAY -->|"tailnet"| DRV
    DRV -->|"JIT config, create/kill"| SB
    DRV <-->|"API: jitconfig, runners, deliveries"| GH
    JOB <-->|"runner protocol, checkout, artifacts"| GH
    JOB -->|"actions/cache, Bazel remote cache"| CACHE
```

Key properties:

- **One job = one VM.** Each job forks a clean snapshot of `omp-ci`; nothing survives into the next job. A failed job keeps its sandbox for 30 min only when its label carries `/debug`.
- **Warm from the first second.** Toolchains (Rust nightly, bun, bazelisk + Bazel, zig, cmake, ninja, sccache), the bun store, the Cargo registry, Bazel's install base, a fetched output base and the Bazel repository cache (with the xwin splat) are baked into the template from a pinned checkout ([02-omp-ci-template.md](02-omp-ci-template.md)).
- **Node-served caches.** The vmon node serves the GitHub Actions cache (`actions/cache` and friends, unchanged) and a per-repository Bazel HTTP cache; branch and tag jobs write, pull request jobs only read ([03-caching.md](03-caching.md)).
- **Capacity is vmon's.** There is no fixed runner pool: each job holds a `vmon-large` sandbox against the CI team's vmon limits, and jobs over the limit wait in vmon's queue (state `waiting`).

## End-to-end job lifecycle

1. A workflow job with `runs-on: vmon-large/from=omp-ci` is **queued**; GitHub sends a `workflow_job` webhook to the vmon GitHub App's webhook URL, the relay on build.stencil.so.
2. The relay verifies `X-Hub-Signature-256` and forwards the delivery unchanged to the vmon driver over the tailnet.
3. The driver's CI controller checks the label (size `vmon-large`, template `omp-ci`), the repo's installation link (team) and the public-repo policy, then **creates a sandbox** from `omp-ci` in the linked team.
4. It asks GitHub for a **repo-level JIT runner config** with the job's labels and starts `/home/user/actions-runner/run.sh --jitconfig …` as `user` inside the sandbox.
5. The runner picks up the job. Steps run in `/home/user/actions-runner/_work/oh-my-pi/oh-my-pi` with `VMON_CI=1` in the environment; Bazel jobs use the node's Bazel cache at `$VMON_CACHE_URL/bazel` ([03-caching.md](03-caching.md)).
6. On `completed` the driver **kills the sandbox** (and deletes the runner after an idle timeout if no job ever arrived). Missed webhooks are redelivered by the driver's reconcile loop.

## Component map

| Component | What it is | Lives in | Documented in |
| --- | --- | --- | --- |
| vmon CI runners | vmon's GitHub Actions integration: GitHub App, webhook intake, per-job sandboxes, JIT runners | vibemon (operated on cherry/horse/xeon) | [01-vmon-runners.md](01-vmon-runners.md) |
| `omp-ci` template | `ci` (vmon's public runner template) + this repo's toolchains and warm caches | [`infra/vmon/omp_ci_template.py`](../vmon/omp_ci_template.py) | [02-omp-ci-template.md](02-omp-ci-template.md) |
| Node caches | Actions cache and Bazel HTTP cache served by the vmon node a job runs on | vibemon | [03-caching.md](03-caching.md) |
| Workflow wiring | `.github/actions/{bazel-cache,bun-install,native-artifacts}` | repo | [03-caching.md](03-caching.md) |

## Placeholders

`<OWNER>/<REPO>` stands for the GitHub repository; `<VMON_API_URL>` for the vmon API the template is built against.

## Reading order

1. **[01-vmon-runners.md](01-vmon-runners.md)** — `runs-on` labels, which jobs run where, the vmon-side setup (GitHub App, team link, public-repo policy, limits), the PR trust split, and operations.
2. **[02-omp-ci-template.md](02-omp-ci-template.md)** — what the `omp-ci` template bakes, and how to build, publish, verify and roll it back.
3. **[03-caching.md](03-caching.md)** — every cache CI uses: template-baked, the node's Actions cache, and the node's Bazel cache.
