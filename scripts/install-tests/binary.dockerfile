# A local --build-context bun-kits=<directory> can preseed the pinned archives.
# With an empty cache the release driver downloads them from OMP_BUN_KIT_BASE_URL.
FROM scratch AS bun-kits
FROM oven/bun:1.4.5 AS stock-bun
FROM debian:trixie-slim AS link-tools
COPY --from=stock-bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential python3 unzip xz-utils zstd && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -fsS https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
ENV PATH="/root/.cargo/bin:/opt/llvm/bin:$PATH" CARGO_BUILD_JOBS=2 CMAKE_BUILD_PARALLEL_LEVEL=2
# These four recipe files specify the release compiler and target sysroot. No Bun sources or build graph.
RUN set -eu; base=https://raw.githubusercontent.com/oven-sh/bun/a7733435cf40429e3b35c36072769df2052b80f1; \
    for f in scripts/agent.ts scripts/build/error.ts scripts/build/xmac.mjs scripts/build/ci-images/spec.ts; do \
      mkdir -p "ci-bun/$(dirname "$f")"; curl -fsSL "$base/$f" -o "ci-bun/$f"; \
    done
COPY scripts/ci-linked-runtime-linux.sh scripts/ci-linked-runtime-linux.sh
RUN set -eu; \
    case "$(uname -m)" in x86_64) target=linux-x64;; aarch64) target=linux-arm64;; *) exit 1;; esac; \
    export RUNNER_TEMP=/tmp/runtime GITHUB_PATH=/tmp/runtime/path GITHUB_ENV=/tmp/runtime/env; \
    mkdir -p "$RUNNER_TEMP"; \
    bash scripts/ci-linked-runtime-linux.sh "$target"

FROM link-tools AS build-cli
COPY . .
COPY --from=bun-kits / /repo/target/linked-natives/kits/
ARG OMP_BUN_KIT_BASE_URL
RUN set -eu; \
    set -a; . /tmp/runtime/env; set +a; \
    export RUSTUP_TOOLCHAIN="$(bun -p 'Bun.TOML.parse(await Bun.file("rust-toolchain.toml").text()).toolchain.channel')"; \
    rustup toolchain install "$RUSTUP_TOOLCHAIN" --profile minimal; \
    bun install --frozen-lockfile; \
    bun --cwd=packages/coding-agent run build

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY --from=build-cli /repo/packages/coding-agent/dist/omp /usr/local/bin/omp
COPY scripts/ci-smoke-release.py /tmp/ci-smoke-release.py
RUN python3 /tmp/ci-smoke-release.py /usr/local/bin/omp
