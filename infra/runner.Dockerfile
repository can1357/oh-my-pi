# syntax=docker/dockerfile:1
# Preloaded omp-kata runner image.
#
# Stock GitHub Actions runner (Ubuntu 24.04) with the dependencies CI installs
# on every job baked in, so each ephemeral Kata microVM boots with them already
# present instead of re-fetching them per job:
#   - APT system deps (canvas/cairo stack + fd/ripgrep/imagemagick) + fd/magick shims
#   - GitHub CLI (gh) — present on GitHub-hosted runners; the coding-agent github
#     tool and release workflows expect it
#   - C/build toolchain the native + canvas builds need
#   - bun (system-wide, on PATH)
#   - sccache + Zig + cmake/ninja + cargo-nextest/cargo-zigbuild/cargo-xwin for native builds
#   - bazelisk (+ pre-warmed bazel 9.2.0) for the Bazel native pipeline
#   - rust nightly (pinned) + clippy/rustfmt/rust-analyzer + linux-arm64/windows-msvc targets
#
# Rebuild + reimport (see /root/omp-kata-runner.md) after bumping the ARGs below
# or the apt set. Keep the apt set in sync with .github/actions/setup-system-deps.
FROM ghcr.io/actions/actions-runner:latest

ARG RUST_NIGHTLY=nightly-2026-04-29
ARG BUN_VERSION=1.4.0
ARG SCCACHE_VERSION=0.15.0
ARG ZIG_VERSION=0.16.0
ARG CMAKE_VERSION=4.1.2
ARG NINJA_VERSION=1.13.1
ARG BAZELISK_VERSION=1.29.0
ARG BAZEL_VERSION=9.2.0

USER root
ENV DEBIAN_FRONTEND=noninteractive

# Mirrors the "Install system deps" block in .github/workflows/ci.yml plus the
# native/cross toolchain (clang/lld/llvm), the baked cache/tooling binaries, and
# the GitHub CLI. The gh apt repo is added first so `gh` installs in the same apt
# transaction.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y \
      build-essential pkg-config curl ca-certificates git unzip xz-utils zstd gh \
      clang lld llvm \
      libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
      fd-find ripgrep imagemagick \
 && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
 && ln -sf /usr/bin/convert /usr/local/bin/magick \
 && rm -rf /var/lib/apt/lists/*

# bun, system-wide (BUN_INSTALL/bin == /usr/local/bin, already on PATH).
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && bun --version

# Pinned native-build helpers, system-wide.
RUN curl -fsSL "https://github.com/mozilla/sccache/releases/download/v${SCCACHE_VERSION}/sccache-v${SCCACHE_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
      | tar -xz -C /tmp \
 && install -m755 "/tmp/sccache-v${SCCACHE_VERSION}-x86_64-unknown-linux-musl/sccache" /usr/local/bin/sccache \
 && rm -rf "/tmp/sccache-v${SCCACHE_VERSION}-x86_64-unknown-linux-musl"
RUN curl -fsSL "https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz" -o /tmp/zig.tar.xz \
 && tar -xJf /tmp/zig.tar.xz -C /opt \
 && ln -sf "/opt/zig-x86_64-linux-${ZIG_VERSION}/zig" /usr/local/bin/zig \
 && rm -f /tmp/zig.tar.xz
# cmake + ninja for native C deps (audiopus_sys builds bundled libopus via
# CMake; MSVC cross builds generate with Ninja). Pinned to the same versions as
# .github/actions/ensure-cmake, which no-ops when these are present.
RUN curl -fsSL "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz" -o /tmp/cmake.tar.gz \
 && tar -xzf /tmp/cmake.tar.gz -C /opt \
 && ln -sf "/opt/cmake-${CMAKE_VERSION}-linux-x86_64/bin/cmake" /usr/local/bin/cmake \
 && ln -sf "/opt/cmake-${CMAKE_VERSION}-linux-x86_64/bin/ctest" /usr/local/bin/ctest \
 && rm -f /tmp/cmake.tar.gz
RUN curl -fsSL "https://github.com/ninja-build/ninja/releases/download/v${NINJA_VERSION}/ninja-linux.zip" -o /tmp/ninja.zip \
 && unzip -o /tmp/ninja.zip -d /usr/local/bin \
 && chmod +x /usr/local/bin/ninja \
 && rm -f /tmp/ninja.zip

# bazelisk + pre-warmed bazel for the Bazel native pipeline. The prewarm run
# downloads the pinned bazel into BAZELISK_HOME at build time so runner jobs
# never fetch it; /opt/bazelisk is world-readable so the runner user reuses it.
ENV BAZELISK_HOME=/opt/bazelisk
RUN arch="$(dpkg --print-architecture)" \
 && curl -fsSL "https://github.com/bazelbuild/bazelisk/releases/download/v${BAZELISK_VERSION}/bazelisk-linux-${arch}" \
      -o /usr/local/bin/bazelisk \
 && chmod +x /usr/local/bin/bazelisk \
 && ln -sf /usr/local/bin/bazelisk /usr/local/bin/bazel \
 && mkdir -p "$BAZELISK_HOME" \
 && USE_BAZEL_VERSION="${BAZEL_VERSION}" bazelisk version
RUN chmod -R a+rX "$BAZELISK_HOME" \
 && rm -rf /root/.cache/bazel /root/.bazelrc
# Pre-own ~/.cache for the runner user: kubelet otherwise creates it root-owned
# as the parent of the omp-bazel-repo subPath mountpoint, breaking sibling dirs
# like bazel's default output_user_root.
RUN install -d -o 1001 -g 1001 -m 0755 /home/runner/.cache

# rust toolchain + cargo helpers for the runner user; rustup default == pinned
# nightly so Rust setup becomes a no-op on the preloaded image.
USER runner
ENV RUSTUP_HOME=/home/runner/.rustup \
    CARGO_HOME=/home/runner/.cargo \
    PATH=/home/runner/.cargo/bin:/usr/local/bin:${PATH}
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain "${RUST_NIGHTLY}" --profile minimal \
 && rustup component add clippy rustfmt rust-analyzer \
 && rustup target add aarch64-unknown-linux-gnu x86_64-pc-windows-msvc \
 && cargo install --locked cargo-nextest cargo-zigbuild cargo-xwin \
 && cargo --version \
 && rustc --version \
 && sccache --version \
 && zig version \
 && cargo-nextest --version \
 && cargo-zigbuild --help >/dev/null \
 && cargo-xwin --help >/dev/null
