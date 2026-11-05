# /// script
# requires-python = ">=3.10"
# dependencies = ["e2b>=2.20.3,<3"]
# ///
"""Build the `omp-ci` vmon template: the sandbox every non-PR CI job boots.

Workflows select it with `runs-on: vmon-large/from=omp-ci`; see
infra/docs/02-omp-ci-template.md (and 01-vmon-runners.md for the runner side).
It derives from vmon's public `ci` runner template (Ubuntu 24.04, systemd,
Docker, `user` with passwordless sudo, GitHub actions/runner unpacked at
/home/user/actions-runner, `VMON_CI=1` in the runner's `.env`) and bakes in
what CI would otherwise fetch on every job:

- apt: clang/lld/llvm, the canvas/cairo stack, fd/ripgrep/imagemagick (+ `fd`
  and `magick` shims);
- sccache, zig, cmake, ninja, bazelisk (also as `bazel`), all in /usr/local/bin;
- bun, system-wide at the floor of the repo pin (package.json `packageManager`);
- rustup + the rust-toolchain.toml toolchain (components and targets) as the
  default, plus aarch64-unknown-linux-gnu and cargo-nextest/zigbuild/xwin;
  every ~/.cargo/bin entry is linked into /usr/local/bin;
- warm caches from the pinned checkout, all owned by `user`:
  bun store (~/.bun/install/cache), Cargo registry (~/.cargo/registry),
  bazelisk's Bazel download (~/.cache/bazelisk), Bazel's install base and an
  output base fetched for //:natives-all + //crates/... (~/.cache/bazel), and
  the Bazel repository cache + xwin splat (/opt/bazel-repo-cache, the paths
  .github/actions/bazel-cache passes). The checkout itself is removed.

Toolchain pins are read from the pinned checkout, so one `--ref` decides
what the template carries. Rebuild after bumping rust-toolchain.toml,
.bazelversion, the bun pin, or MODULE.bazel(.lock)/Cargo.lock/bun.lock
(caches only go stale: jobs fetch the difference, slower but correct):

    E2B_API_URL=<vmon API URL> E2B_API_KEY=<CI team API key> \\
        uv run infra/vmon/omp_ci_template.py [--ref main|<sha>] [--skip-cache]

The build runs at 8 vCPU / 16384 MB, the `vmon-large` size, so
`vmon-large/from=omp-ci` jobs fork its snapshot. It is tagged `default` and
`omp-<sha12>`; roll back with `vmon-large/from=omp-ci:omp-<sha12>` or by
pointing `default` at an older build (`POST /templates/tags`).
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
import urllib.request

REPO_URL = "https://github.com/can1357/oh-my-pi"
RAW_URL = "https://raw.githubusercontent.com/can1357/oh-my-pi"
NAME = "omp-ci"
CPU_COUNT = 8
MEMORY_MB = 16384

# Pinned helper versions (bump together with a template rebuild).
SCCACHE_VERSION = "0.18.0"
ZIG_VERSION = "0.16.0"
CMAKE_VERSION = "4.4.3"
NINJA_VERSION = "1.13.2"
BAZELISK_VERSION = "1.29.0"

# actions/checkout's workspace for this repo. Warming Bazel here makes the
# output base (keyed by the workspace path) the one CI jobs reuse.
WORKSPACE = "/home/user/actions-runner/_work/oh-my-pi/oh-my-pi"
# Read by .github/actions/bazel-cache; keep the two in sync.
REPO_CACHE = "/opt/bazel-repo-cache"

APT_PACKAGES = [
    "clang",
    "lld",
    "llvm",
    "libcairo2-dev",
    "libpango1.0-dev",
    "libjpeg-dev",
    "libgif-dev",
    "librsvg2-dev",
    "fd-find",
    "ripgrep",
    "imagemagick",
]

INSTALL_TOOLS = f"""set -eux
[ "$(uname -m)" = x86_64 ] || {{ echo "omp-ci needs an x86_64 builder (linux-x64 addons are smoke-loaded on the runner)" >&2; exit 1; }}
rm -rf /var/lib/apt/lists/*
ln -sf "$(command -v fdfind)" /usr/local/bin/fd
ln -sf /usr/bin/convert /usr/local/bin/magick
tmp="$(mktemp -d)"
curl -fsSL "https://github.com/mozilla/sccache/releases/download/v{SCCACHE_VERSION}/sccache-v{SCCACHE_VERSION}-x86_64-unknown-linux-musl.tar.gz" | tar -xz -C "$tmp"
install -m 0755 "$tmp/sccache-v{SCCACHE_VERSION}-x86_64-unknown-linux-musl/sccache" /usr/local/bin/sccache
curl -fsSL "https://ziglang.org/download/{ZIG_VERSION}/zig-x86_64-linux-{ZIG_VERSION}.tar.xz" | tar -xJ -C /opt
ln -sf "/opt/zig-x86_64-linux-{ZIG_VERSION}/zig" /usr/local/bin/zig
curl -fsSL "https://github.com/Kitware/CMake/releases/download/v{CMAKE_VERSION}/cmake-{CMAKE_VERSION}-linux-x86_64.tar.gz" | tar -xz -C /opt
ln -sf "/opt/cmake-{CMAKE_VERSION}-linux-x86_64/bin/cmake" /usr/local/bin/cmake
ln -sf "/opt/cmake-{CMAKE_VERSION}-linux-x86_64/bin/ctest" /usr/local/bin/ctest
curl -fsSL -o "$tmp/ninja.zip" "https://github.com/ninja-build/ninja/releases/download/v{NINJA_VERSION}/ninja-linux.zip"
unzip -o "$tmp/ninja.zip" -d /usr/local/bin
chmod 0755 /usr/local/bin/ninja
curl -fsSL -o /usr/local/bin/bazelisk "https://github.com/bazelbuild/bazelisk/releases/download/v{BAZELISK_VERSION}/bazelisk-linux-amd64"
chmod 0755 /usr/local/bin/bazelisk
ln -sf /usr/local/bin/bazelisk /usr/local/bin/bazel
rm -rf "$tmp"
install -d -o user -g user -m 0755 {REPO_CACHE}
"""

# Retries a flaky download (the Microsoft CDN cuts bodies short now and then).
RETRY = 'retry() { for i in 1 2 3 4; do "$@" && return 0; sleep $((i * 15)); done; return 1; }'


def xwin_download(sha: str) -> str:
    """User: fill `OMP_XWIN_CACHE_DIR` with the MSVC CRT + Windows SDK payloads
    (~1 GiB from the Microsoft CDN) that the pinned commit's xwin sysroot
    repositories splat, before the checkout. The script only names the xwin
    pins, so vmon's step cache keeps this layer across template rebuilds
    until bazel/toolchains/msvc/sysroot.bzl or MODULE.bazel change them; the
    Bazel warm-up below then splats from the cache without the CDN."""
    bzl = fetch(f"{RAW_URL}/{sha}/bazel/toolchains/msvc/sysroot.bzl")
    module = fetch(f"{RAW_URL}/{sha}/MODULE.bazel")
    version = pin(r'_XWIN_VERSION = "([^"]+)"', bzl)
    manifest = pin(r'_XWIN_MANIFEST_VERSION = "([^"]+)"', bzl)
    triple = "x86_64-unknown-linux-musl"
    digest = pin(rf'"linux-x64": \("{triple}", "([0-9a-f]{{64}})"\)', bzl)
    downloads = []
    for call in re.findall(r"\bxwin_sysroot\((.*?)\)", module, re.S):
        arch = re.search(r'arch = "([^"]+)"', call)
        sdk = re.search(r'sdk_version = "([^"]+)"', call)
        downloads.append(
            f"retry xwin --accept-license --arch {arch[1] if arch else 'x86_64'}"
            f" --variant desktop --manifest-version {manifest}"
            + (f" --sdk-version {sdk[1]}" if sdk else "")
            + f" --cache-dir {REPO_CACHE}/xwin download"
        )
    if not downloads:
        sys.exit("omp_ci_template.py: no xwin_sysroot repositories in MODULE.bazel")
    lines = "\n".join(downloads)
    return f"""set -eux
{RETRY}
tmp="$(mktemp -d)"
retry curl -fsSL -o "$tmp/xwin.tar.gz" "https://github.com/Jake-Shadle/xwin/releases/download/{version}/xwin-{version}-{triple}.tar.gz"
echo "{digest}  $tmp/xwin.tar.gz" | sha256sum -c -
tar -xzf "$tmp/xwin.tar.gz" -C "$tmp"
PATH="$tmp/xwin-{version}-{triple}:$PATH"
mkdir -p {REPO_CACHE}/xwin
{lines}
rm -rf "$tmp"
du -sh {REPO_CACHE}/xwin
"""


def fetch(url: str) -> str:
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read().decode()


def pin(pattern: str, text: str) -> str:
    found = re.search(pattern, text)
    if not found:
        sys.exit(
            f"omp_ci_template.py: xwin pin {pattern!r} not found in the pinned commit"
        )
    return found[1]


INSTALL_RUSTUP = """set -eux
curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none
"""


def checkout(sha: str) -> str:
    return f"""set -eux
rm -rf {WORKSPACE}
mkdir -p {WORKSPACE}
cd {WORKSPACE}
git init -q
git remote add origin {REPO_URL}
git fetch -q --depth 1 origin {sha}
git checkout -q --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = {sha}
"""


# Root: bun at the floor of package.json's `packageManager` pin, so
# .github/actions/bun-install accepts it (an exact pin must equal it).
INSTALL_BUN = f"""set -eux
want="$(sed -n 's/.*"packageManager": *"bun@\\([^"]*\\)".*/\\1/p' {WORKSPACE}/package.json)"
version="${{want#>=}}"
[ -n "$version" ]
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s -- "bun-v$version"
rm -rf /root/.bun
/usr/local/bin/bun --version
"""

# User: the toolchain rust-toolchain.toml names (components and targets
# included) becomes the default, so cargo outside the checkout matches CI.
INSTALL_RUST = f"""set -eux
export PATH="$HOME/.cargo/bin:$PATH"
cd {WORKSPACE}
rustup toolchain install
channel="$(sed -n 's/^channel *= *"\\(.*\\)"/\\1/p' rust-toolchain.toml)"
rustup default "$channel"
rustup target add --toolchain "$channel" aarch64-unknown-linux-gnu
cd "$HOME"
# cargo-nextest and cargo-zigbuild come with the `ci` image.
cargo install --locked cargo-xwin
rm -rf "$HOME/.cargo/registry/src"
"""

LINK_CARGO_BINS = """set -eux
for bin in /home/user/.cargo/bin/*; do ln -sf "$bin" /usr/local/bin/; done
"""

# User: warm every per-job download from the pinned checkout, then drop it.
# The Bazel flags mirror .github/actions/bazel-cache so the fetched repos
# (and their repo-contents-cache keys) match what jobs ask for.
WARM_CACHES = f"""set -eux
{RETRY}
cd {WORKSPACE}
bun install --frozen-lockfile
bun install --cwd .omp/tools --frozen-lockfile
cargo fetch --locked
bazelisk version
retry bazelisk build --nobuild --config=ci \\
  --repository_cache={REPO_CACHE} \\
  --repo_env=OMP_XWIN_CACHE_DIR={REPO_CACHE}/xwin \\
  //:natives-all //crates/...
bazelisk shutdown
cd /home/user
rm -rf /home/user/actions-runner/_work/oh-my-pi "$HOME/.cargo/registry/src"
du -sh "$HOME/.bun/install/cache" "$HOME/.cargo/registry" "$HOME/.cache/bazel" {REPO_CACHE} || true
"""

# The runner exports `.env` into every job; rustup proxies on PATH (linked
# into /usr/local/bin) need their homes regardless of the job's HOME.
RUNNER_ENV = """set -eux
env=/home/user/actions-runner/.env
sed -i -e '$a\\' "$env"
printf '%s\\n' RUSTUP_HOME=/home/user/.rustup CARGO_HOME=/home/user/.cargo >> "$env"
"""


def make_template(sha: str):
    from e2b import Template

    return (
        Template()
        .from_template("ci")
        .apt_install(APT_PACKAGES)
        .run_cmd(INSTALL_TOOLS, user="root")
        .run_cmd(INSTALL_RUSTUP, user="user")
        .run_cmd(xwin_download(sha), user="user")
        .run_cmd(checkout(sha), user="user")
        .run_cmd(INSTALL_BUN, user="root")
        .run_cmd(INSTALL_RUST, user="user")
        .run_cmd(LINK_CARGO_BINS, user="root")
        .run_cmd(WARM_CACHES, user="user")
        .run_cmd(RUNNER_ENV, user="user")
        # Same as `ci`: snapshot with dockerd up, so forks start ready.
        .set_start_cmd(
            "sudo systemctl start docker.service", "sudo docker info >/dev/null 2>&1"
        )
    )


def resolve(ref: str) -> str:
    """Commit SHA of `ref` (branch, tag, or SHA) on the public repo."""
    if len(ref) == 40 and all(c in "0123456789abcdef" for c in ref):
        return ref
    out = subprocess.run(
        ["git", "ls-remote", REPO_URL, ref, f"refs/heads/{ref}", f"refs/tags/{ref}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split()
    if not out:
        sys.exit(f"omp_ci_template.py: {ref!r} not found on {REPO_URL}")
    return out[0]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--ref",
        default="main",
        help="branch, tag, or commit to warm from (default: main)",
    )
    parser.add_argument("--skip-cache", action="store_true", help="rebuild every layer")
    args = parser.parse_args()

    for var in ("E2B_API_URL", "E2B_API_KEY"):
        if not os.environ.get(var):
            sys.exit(
                f"omp_ci_template.py: set {var} (vmon API URL / API key of the CI team)"
            )

    from e2b import Template

    sha = resolve(args.ref)
    tag = f"omp-{sha[:12]}"
    print(f"building {NAME} from {REPO_URL}@{sha} (tags: default, {tag})", flush=True)
    started = time.monotonic()
    info = Template.build(
        make_template(sha),
        NAME,
        tags=[tag],
        cpu_count=CPU_COUNT,
        memory_mb=MEMORY_MB,
        skip_cache=args.skip_cache,
        on_build_logs=lambda entry: print(entry, flush=True),
    )
    print(
        f"{NAME} ready in {time.monotonic() - started:.0f}s: template {info.template_id}, "
        f"build {info.build_id}, tags default + {tag}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
