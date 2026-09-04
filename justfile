# omp workspace command runner — the source of truth for workspace commands.
# `just` or `just --list` shows every recipe; `just <recipe>` runs one.
# Keep in sync with .github/workflows/ci.yml and each crate's README.

set shell := ["bash", "-euo", "pipefail", "-c"]

# List available recipes.
default:
    @just --list

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

# One-time embedded-Python fetch crates/py needs before it builds; re-run freely, skips work once the stamp matches crates/py/requirements.txt.
[group('setup')]
setup-python:
    crates/py/scripts/fetch-python.sh

# ---------------------------------------------------------------------------
# Format & lint
# ---------------------------------------------------------------------------

# Format the whole repo in place: Rust (rustfmt) + Protobuf (buf).
[group('format & lint')]
fmt: fmt-rust fmt-streams proto-fmt

# Format every Rust source in place (hard tabs, see rustfmt.toml).
[group('format & lint')]
fmt-rust:
    cargo fmt --all

# Reindent stream!/try_stream! macro bodies that rustfmt cannot parse (yield).
[group('format & lint')]
fmt-streams *paths='crates':
    python3 scripts/fmt-stream.py {{ paths }}

# Check the whole repo's formatting without writing (CI gate).
[group('format & lint')]
fmt-check: fmt-check-rust proto-fmt-check

[group('format & lint')]
fmt-check-rust:
    cargo fmt --all -- --check

# Format every `.proto` schema under crates/proto in place (buf.yaml).
[group('format & lint')]
proto-fmt:
    cd crates/proto && buf format -w

# Check `.proto` formatting under crates/proto without writing.
[group('format & lint')]
proto-fmt-check:
    cd crates/proto && buf format -d --exit-code

# Lint every `.proto` schema under crates/proto (buf.yaml rules).
[group('format & lint')]
proto-lint:
    cd crates/proto && buf lint

# Lint the Rust workspace with clippy (CI flags; own target dir so the
# RUSTC_WORKSPACE_WRAPPER fingerprint never ping-pongs check/test artifacts).
[group('format & lint')]
clippy:
    CARGO_TARGET_DIR=target/clippy cargo clippy --workspace --locked

# Warn (never fails) on lock-wrapped map/set state (`Mutex<HashMap<…>>` etc.); prefer
# `dashmap::DashMap`/`DashSet` or another concurrent structure. clippy's `disallowed-types`
# matches type paths only (no generic args), so this can't live in clippy.toml.
[group('format & lint')]
lint-locked-maps:
    #!/usr/bin/env bash
    set -euo pipefail
    matches=$(grep -rnE --include='*.rs' \
        '(Mutex|RwLock)<[[:space:]]*((std|indexmap|im|omp_core)::([a-z_]+::)*)?((Fx)?Hash|BTree|Index|Sparse)(Map|Set)<' \
        crates || true)
    if [[ -n "$matches" ]]; then
        echo "warning: lock-wrapped map/set state — prefer dashmap::DashMap/DashSet or another concurrent structure:"
        echo "$matches"
    fi

# Scan for banned inline qualified paths (`std::sync::atomic::AtomicU32`, `crate::`/`super::`),
# mostly-Arc-wrapped structs, and `Mutex<Arc<…>>`-style locks, plus model-name
# hardcoding in crates/inference (see tools/lintx).
[group('format & lint')]
lintx *paths='crates':
    cargo run --quiet --release --locked --manifest-path tools/lintx/Cargo.toml -- {{ paths }}

# Autofix banned inline paths in place (conservative: ambiguous cases stay diagnostics). Run `just fmt` afterwards.
[group('format & lint')]
lintx-fix *paths='crates':
    cargo run --quiet --release --locked --manifest-path tools/lintx/Cargo.toml -- --fix {{ paths }}

# Run every formatter-check and linter this repo defines.
[group('format & lint')]
lint: fmt-check clippy proto-lint lint-locked-maps

# ---------------------------------------------------------------------------
# Build & check
# ---------------------------------------------------------------------------

# Typecheck the whole workspace.
[group('build & check')]
check:
    cargo check --workspace --locked

# Typecheck a single crate, e.g. `just check-pkg omp-agent`.
[group('build & check')]
check-pkg pkg:
    cargo check -p {{ pkg }} --locked

# Build the `omp` CLI/daemon binary (dev profile).
[group('build & check')]
build:
    cargo build -p omp-app --bin omp --locked

# Build the `omp` CLI/daemon binary (release profile; macOS needs vendored release Python + Homebrew LLD, see AGENTS.md "Embedded Python").
[group('build & check')]
build-release:
    PYO3_CONFIG_FILE="{{ justfile_directory() }}/vendor/python-release/pyo3-config.txt" \
        cargo build -p omp-app --bin omp --release --locked

# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------
# Generate the tracked native Python type stub from PyO3 metadata embedded in
# the statically linked demo executable.
[group('build & check')]
gen-py-stubs:
    cargo build -p omp-py --bin omp-demo --features inspect --locked
    cargo run -p omp-py --bin stubgen --features inspect --locked -- \
        "${CARGO_TARGET_DIR:-target}/debug/omp-demo" crates/py/python

# Run every workspace unit/integration test except the e2e suite.
[group('test')]
test:
    cargo nextest run --workspace --exclude omp-e2e --locked
    cargo test --doc --workspace --exclude omp-e2e --locked

# Run every workspace test, e2e included (slow; prefer `just e2e` alone so failures are easy to attribute).
[group('test')]
test-all:
    cargo nextest run --workspace --locked
    cargo test --doc --workspace --locked

# Run tests for a single crate, e.g. `just test-pkg omp-edit`.
[group('test')]
test-pkg pkg:
    cargo nextest run -p {{ pkg }} --locked
    cargo test --doc -p {{ pkg }} --locked

# ---------------------------------------------------------------------------
# E2E acceptance suite (crates/e2e, joined-system proofs P1-P10)
# ---------------------------------------------------------------------------

# Compile every acceptance proof without running them.
[group('e2e')]
e2e-build:
    cargo nextest run -p omp-e2e --tests --no-run --locked

# Run proofs P1-P6: doc race, cancel matrix, detached jobs, schema isolation, prefix stability, crash/resume.
[group('e2e')]
e2e-core:
    cargo nextest run -p omp-e2e --locked \
        --test p1_doc_race \
        --test p2_cancel_matrix \
        --test p3_detached_jobs \
        --test p4_schema_isolation \
        --test p5_prefix_stability \
        --test p6_crash_resume

# Run proof P7: real-PTY terminal UI lifecycle.
[group('e2e')]
e2e-p7:
    TERM=xterm-256color cargo nextest run -p omp-e2e --test p7_tui --locked

# Validate the P8 performance-baseline metric schema/contract (non-gating).
[group('e2e')]
e2e-p8:
    cargo nextest run -p omp-e2e --test p8_baselines --locked

# Run proof P9: isolated environment and extension control registration.
[group('e2e')]
e2e-p9:
    cargo nextest run -p omp-e2e --locked \
        --test p9_isolation \
        --test p9_extension_control

# Run proof P10: idempotent historical tool lift through live dispatch.
[group('e2e')]
e2e-p10:
    cargo nextest run -p omp-e2e --test p10_lift_idempotence --locked

# Record a fresh P8 performance-baseline artifact.
[group('e2e')]
e2e-baseline:
    cargo run -p omp-e2e --bin baseline --locked -- \
        --artifact target/e2e-artifacts/p8-baselines.json

# Run every P1-P10 proof plus the tool-sources check, in CI order.
[group('e2e')]
e2e: e2e-build e2e-core e2e-p7 e2e-p9 e2e-p10
    cargo nextest run -p omp-e2e --test tool_sources --locked
    cargo nextest run -p omp-e2e --test p8_baselines --locked

# ---------------------------------------------------------------------------
# LLM catalog & compat cascade (crates/llm-catalog)
# ---------------------------------------------------------------------------

# Run the taxonomy and compat-cascade test suites.
[group('catalog')]
catalog-test:
    cargo nextest run -p omp-llm-catalog --lib taxonomy
    cargo nextest run -p omp-llm-catalog --test compat_cascade

# ---------------------------------------------------------------------------
# Run & explore
# ---------------------------------------------------------------------------

# Run the `omp` CLI, e.g. `just run -- --help`.
[group('run')]
run *args:
    cargo run -p omp-app --bin omp --locked -- {{ args }}

# Run the standalone `omp-sh` shell (shell-engine composed with builtins).
[group('run')]
run-shell *args:
    cargo run -p omp-shell-builtins --bin omp-sh --locked -- {{ args }}

# ---------------------------------------------------------------------------
# Example galleries (visual smoke tests for tui/gui/webview/ar/inference)
# ---------------------------------------------------------------------------

# Run an omp-tui example: gallery (default), chat, companies, footers, tml.
[group('examples')]
tui example="gallery":
    cargo run -p omp-tui --example {{ example }}

# Run an omp-gui example: chat (default), browser. Extra args pass through, e.g. `just gui chat -- --shot welcome /tmp/welcome.png`.
[group('examples')]
gui example="chat" *args:
    cargo run -p omp-gui --example {{ example }} -- {{ args }}

# Run an omp-webview example: child (default), frames, ipc, window. Most take a URL, e.g. `just webview frames -- https://example.com`.
[group('examples')]
webview example="child" *args:
    cargo run -p omp-webview --example {{ example }} -- {{ args }}

[group('examples')]
ar-roundtrip:
    cargo run -p omp-ar --example roundtrip

[group('examples')]
inference-smoke:
    cargo run -p omp-llm-inference --example applefm_smoke

# ---------------------------------------------------------------------------
# Licensing & release packaging
# ---------------------------------------------------------------------------

# Verify locked Rust dependency licenses and sources with standard cargo-deny tooling.
[group('release')]
license-check:
    cargo deny --locked check licenses sources

# Assemble npm publish packages from built release binaries.
[group('release')]
npm-package version binaries out="dist/npm":
    python3 scripts/gen-npm-packages.py --version {{ version }} --binaries {{ binaries }} --out {{ out }}

# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------

[group('housekeeping')]
clean:
    cargo clean

# Reproduce the CI "format" + "rust" jobs locally before pushing (skips macOS/Linux-only Python-toolchain verification steps).
[group('housekeeping')]
ci: fmt-check-rust clippy test e2e
