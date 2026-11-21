# 02 — The `omp-ci` template

`omp-ci` is the vmon template every vmon CI job of this repo boots (`runs-on: vmon-large/from=omp-ci`). It is defined in [`infra/vmon/omp_ci_template.py`](../vmon/omp_ci_template.py) (Python, PEP 723 inline dependencies, run with `uv run`) and derives from vmon's public `ci` template (`Template().from_template("ci")`), so the runner layout is vmon's:

- Ubuntu 24.04, systemd, Docker; user `user` (uid 1000, passwordless sudo, groups `docker`, `kvm`); `/dev/kvm` usable when the node offers nested virtualization;
- GitHub actions/runner at `/home/user/actions-runner`, started by vmon with a JIT config; jobs run in `/home/user/actions-runner/_work/<repo>/<repo>`;
- the runner's `.env` exports `VMON_CI=1`, `ImageOS=ubuntu24`, the tool cache `/opt/hostedtoolcache`, `LANG=C.UTF-8`;
- git, git-lfs, gh, curl, jq, unzip, zip, xz-utils, zstd, python3, build-essential, pkg-config.

## 1. What `omp-ci` adds

| What | Where (owner `user` unless noted) | Source of the version |
| --- | --- | --- |
| clang, lld, llvm, cairo/pango/jpeg/gif/rsvg dev headers, fd-find, ripgrep, imagemagick (+ `fd`, `magick` shims) | apt, `/usr/local/bin` (root) | Ubuntu 24.04 |
| sccache, zig, cmake (+ ctest), ninja, bazelisk (+ `bazel`) | `/usr/local/bin`, `/opt` (root) | constants in the template script |
| bun | `/usr/local/bin/bun` (root) | floor of `package.json` `packageManager` |
| rustup, the `rust-toolchain.toml` toolchain with its components and targets (default toolchain) + `aarch64-unknown-linux-gnu`, cargo-nextest, cargo-zigbuild, cargo-xwin | `~/.rustup`, `~/.cargo`; every `~/.cargo/bin` entry linked into `/usr/local/bin` | `rust-toolchain.toml`; cargo tools latest at build time |
| bun package store | `~/.bun/install/cache` | `bun install --frozen-lockfile` (root + `.omp/tools`) |
| Cargo registry (index + crate archives) | `~/.cargo/registry` | `cargo fetch --locked` |
| Bazel binary | `~/.cache/bazelisk` | `.bazelversion` |
| Bazel install base + an output base with every external repo `//:natives-all` and `//crates/...` need | `~/.cache/bazel` | `MODULE.bazel`, `MODULE.bazel.lock` |
| Bazel repository cache (+ repo contents cache) and the xwin MSVC/SDK download cache | `/opt/bazel-repo-cache`, `/opt/bazel-repo-cache/xwin` | same |
| `RUSTUP_HOME`, `CARGO_HOME` | appended to the runner `.env` | — |

All warm caches come from one **pinned checkout** of `can1357/oh-my-pi` (`--ref`, default `main`, resolved to a SHA when the build starts), cloned at the exact path actions/checkout uses (`/home/user/actions-runner/_work/oh-my-pi/oh-my-pi`) so the Bazel output base — keyed by workspace path — is the one jobs reuse. The checkout is deleted afterwards; jobs check out their own commit into an empty workspace.

The Bazel warm-up runs `bazelisk build --nobuild --config=ci --repository_cache=/opt/bazel-repo-cache --repo_env=OMP_XWIN_CACHE_DIR=/opt/bazel-repo-cache/xwin //:natives-all //crates/...`. These are exactly the cache flags `.github/actions/bazel-cache` emits on vmon runners; keep the two in sync, or the repo-contents-cache keys (the xwin repo declares `OMP_XWIN_CACHE_DIR` as an input) stop matching and jobs refetch.

## 2. Freshness

Caches are content-addressed, so a template older than the commit under test is never wrong, only slower: `bun install` downloads packages added since, `cargo fetch` new crates, Bazel new or changed external repos, and a toolchain bump downloads the new toolchain per job. Rebuild `omp-ci` after merging a change to any of:

- `rust-toolchain.toml`, `.bazelversion`, the bun pin in `package.json`;
- `MODULE.bazel` / `MODULE.bazel.lock` / `bazel/**` toolchain repos (LLVM, Swift, macOS SDK, xwin);
- `Cargo.lock`, `bun.lock` (large dependency churn);
- the helper pins at the top of the template script.

## 3. Build and publish

Requirements: [uv](https://docs.astral.sh/uv/), git, network access to the vmon API, and an **API key of the vmon CI team** (the team the GitHub installation is linked to; [01-vmon-runners.md](01-vmon-runners.md#3-one-time-vmon-setup-for-this-repo)). The team's `max_disk_mb` sets the template disk size; keep it ≥ 65536.

```bash
E2B_API_URL=<VMON_API_URL> E2B_API_KEY=<CI team API key> \
  uv run infra/vmon/omp_ci_template.py              # warm from main
# or: … uv run infra/vmon/omp_ci_template.py --ref <sha|branch|tag> [--skip-cache]
```

The script resolves `--ref`, builds `omp-ci` in the CI team at **8 vCPU / 16384 MB** (the `vmon-large` size, so `vmon-large/from=omp-ci` forks the snapshot), and tags the build `default` and `omp-<sha12>`. The template stays private to the CI team; its name resolves only there, which is where vmon creates the CI sandboxes. Layers before the checkout (apt, helper binaries, rustup) are cached between builds; everything from the checkout on reruns for a new SHA (expect the `cargo install` of the three cargo tools and the Bazel fetch to dominate).

**Rollback.** Point a job at a previous build with `runs-on: vmon-large/from=omp-ci:omp-<sha12>`, or move the `default` tag back (`POST /templates/tags` `{"target": "omp-ci:omp-<sha12>", "tags": ["default"]}` with the CI team key).

## 4. Verify

From a job log on main after the rebuild:

- `bun-install` prints `bun present: <version> (satisfies >=…)` and `bun cache backend: omp-ci template store (/home/user/.bun/install/cache)`, and `bun install` reports few or no downloads;
- `bazel-cache` emits the repository-cache lines (with `--announce_rc` the rc shows them), and the Bazel jobs' "Bazel build summary" notice shows remote cache hits;
- `check`'s `cargo fetch --locked` downloads nothing (or only crates added since the template).

Interactively, create a `vmon-large`-sized sandbox from `omp-ci` with the CI team key and check, as `user`: `bun --version`, `cargo --version` (pinned nightly), `bazel version`, `ls /opt/bazel-repo-cache`, `du -sh ~/.bun/install/cache ~/.cargo/registry ~/.cache/bazel`, `grep -E 'VMON_CI|RUSTUP_HOME' ~/actions-runner/.env`.
