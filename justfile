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

# Check `.proto` wire compatibility against omp2 (buf.yaml `breaking`).
[group('format & lint')]
proto-breaking:
    buf breaking crates/proto --against '.git#branch=omp2,subdir=crates/proto'

# Lint the Rust workspace with clippy (CI flags; own target dir so the
# RUSTC_WORKSPACE_WRAPPER fingerprint never ping-pongs check/test artifacts).
# `--all-targets` holds tests, examples and benches to the same policy as
# library code (e.g. clippy.toml's `std::sync::Mutex` ban).
[group('format & lint')]
clippy:
    CARGO_TARGET_DIR=target/clippy cargo clippy --workspace --all-targets --locked

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

# Error-formatting ratchet (ADR 0035): fail when a crate has more bare-`Str`/`String` error variants
# (`error-str-payload`) or formatted error values (`error-format`) than tools/lintx/baselines/error-formatting.toml.
[group('format & lint')]
lintx-ratchet:
    cargo run --quiet --release --locked --manifest-path tools/lintx/Cargo.toml -- --ratchet tools/lintx/baselines/error-formatting.toml crates

# Lower the error-formatting baseline after migrating sites. Refuses (writes nothing) if any count rose.
[group('format & lint')]
lintx-ratchet-update:
    cargo run --quiet --release --locked --manifest-path tools/lintx/Cargo.toml -- --ratchet-update tools/lintx/baselines/error-formatting.toml crates

# lintx's own unit tests (a separate Cargo workspace, so `just test` does not run them).
[group('test')]
lintx-test:
    cargo test --locked --manifest-path tools/lintx/Cargo.toml

# The `.omp/tools` agent tools' Bun contract tests (local only: CI is the Cargo gate, so neither CI nor `just test` runs them).
[group('test')]
tools-test:
    cd .omp/tools && bun install --frozen-lockfile && bun test

# Run a `just` recipe on a BuildBuddy remote Linux runner over this checkout, uncommitted changes included (ADR 0040 Slice 0; optional: needs `bb` and a BuildBuddy API key, see scripts/remote-verify.sh).
[group('remote')]
remote +recipe:
    scripts/remote-verify.sh {{ recipe }}

# `just test-pkg <pkg>` on a BuildBuddy remote Linux runner (see `remote`).
[group('remote')]
remote-test-pkg pkg:
    scripts/remote-verify.sh test-pkg {{ pkg }}


# Print every nextest result so remote test evidence includes its Summary line.
[group('remote')]
remote-plain-test pkg:
    NEXTEST_HIDE_PROGRESS_BAR=1 cargo nextest run -p {{ pkg }} --locked --no-fail-fast --status-level all --final-status-level all 2>&1 | cat
# Save the BuildBuddy runner snapshot from the `omp2` base branch. The seed must not follow `origin/HEAD`.
[group('remote')]
remote-seed:
    OMP_REMOTE_DEFAULT_BRANCH=omp2 scripts/remote-verify.sh --seed test-pkg omp-envd

## Fast connectivity/auth probe; no Cargo work.
[group('remote')]
remote-probe:
    printf 'buildbuddy remote probe ok\\n'

# Run the Linux-valid Cargo verification set in one remote runner so the
# runner-home Cargo target and Python cache are reused between phases. Protobuf
# checks remain in the GitHub gate because they need the repository's `buf`.
# Clippy keeps its own target under $HOME: a checkout-relative target/ is wiped by every
# `bb remote` run, which made clippy cold each time. No separate `cargo check`: clippy
# type-checks the whole workspace.
[group('remote')]
remote-heavy:
    cargo nextest run --workspace --exclude omp-e2e --locked
    cargo test --doc --workspace --exclude omp-e2e --locked
    CARGO_TARGET_DIR="$HOME/.cache/omp-target-clippy" cargo clippy --workspace --all-targets --locked

# The Cargo bodies of the Linux CI jobs, for `vars.CI_LINUX_MODE` = `remote`: the job then runs
# on the self-hosted Mac and hands these commands to `scripts/remote-verify.sh <recipe>`
# (docs/research/ci-macos-runner-fallback.md). Each runs the commands of that job's
# github-hosted steps; keep the two in sync. The runner script prepares vendor/python first.
# ci.yml wires ci-lintx-ratchet and ci-runtime-spec (both proven on BuildBuddy). ci-lint-linux,
# ci-p9-p10-linux and ci-p7-linux are not wired yet: their jobs stay on ubuntu-24.04 until proven.

# `lintx_ratchet` in CI: lintx's own tests, then the error-formatting ratchet.
[group('remote')]
ci-lintx-ratchet: lintx-test lintx-ratchet

# `runtime_spec` in CI: generate and validate the runtime symbol specification.
[group('remote')]
ci-runtime-spec:
    cargo -Zscript scripts/check-spec.rs -- target/runtime-symbol-spec.json

# `lint_linux` in CI: clippy with --keep-going (in the runner-home target `remote-heavy` uses), then both cap profiles.
[group('remote')]
ci-lint-linux:
    test -f vendor/python/pyo3-config.txt
    CARGO_TARGET_DIR="$HOME/.cache/omp-target-clippy" cargo clippy --workspace --all-targets --locked --keep-going
    just check-minimal-caps

# `p9_p10_linux` in CI: proofs P9, P10, P11 and P14, then the tool source routing check.
[group('remote')]
ci-p9-p10-linux:
    test -f vendor/python/pyo3-config.txt
    test -x vendor/python/install/bin/python3.14td
    cargo nextest run --profile ci -p omp-e2e --locked \
        --test p9_isolation \
        --test p9_extension_control \
        --test p9_agent_settled \
        --test p9_continuation_grants \
        --test p10_lift_idempotence \
        --test p11_collab_spectator \
        --test p14_session_attach
    cargo nextest run --profile ci -p omp-e2e --test tool_sources --locked

# `p7_linux` in CI: terminal proof P7 on a Linux PTY.
[group('remote')]
ci-p7-linux:
    test -f vendor/python/pyo3-config.txt
    test -x vendor/python/install/bin/python3.14td
    TERM=xterm-256color cargo nextest run --profile ci -p omp-e2e --test p7_tui --test p7_tsp --locked

# Fail when a repo text surface (AGENTS.md, docs, .omp, crate READMEs) teaches a patch-script
# recipe. AGENTS.md "Editing Discipline" binds every prompt and skill body authored here.
[group('format & lint')]
lint-editing-discipline:
    python3 scripts/check-editing-discipline.py

# Run every formatter-check and linter this repo defines.
[group('format & lint')]
lint: fmt-check clippy proto-lint lint-locked-maps lintx-ratchet lint-editing-discipline

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

# ADR 0049 Phase 3: default `omp` (`omp-app`, every `cap-*` on) and the
# minimal profile (`local` only). Selected unification is required so the
# workspace resolver cannot turn a cap back on through another member.
# Each capability crate must be absent from `omp-envd` (cargo exit 101,
# "did not match any packages"). Any other cargo failure fails the recipe.
[group('build & check')]
check-minimal-caps:
    #!/usr/bin/env bash
    set -euo pipefail
    selected=(--locked --no-default-features --config 'resolver.feature-unification="selected"')
    # Forge/CI contract crates are optional on omp-tools as well as envd, so
    # selected unification leaves them (and the delegated routers) out of the
    # envd graph when the caps are off. Family variants stay either way; the
    # forge/ci modules and chat cards compile with the matching cap features
    # (on by default in omp-app).
    for pkg in omp-desktop omp-webview omp-audio omp-ssh omp-forge omp-forge-delegated omp-ci omp-ci-delegated; do
        status=0
        out=$(cargo tree -p omp-envd -i "$pkg" "${selected[@]}" 2>&1) || status=$?
        if [[ "$status" -eq 0 ]]; then
            printf 'error: %s is in the omp-envd graph with cap features off\n%s\n' "$pkg" "$out" >&2
            exit 1
        fi
        if [[ "$status" -ne 101 || "$out" != *"did not match any packages"* ]]; then
            printf 'error: unexpected cargo tree result for %s (exit %s)\n%s\n' "$pkg" "$status" "$out" >&2
            exit 1
        fi
        printf 'absent from omp-envd (caps off): %s\n' "$pkg"
    done
    cargo check -p omp-app --locked
    cargo check -p omp-app --no-default-features --features local --locked \
        --config 'resolver.feature-unification="selected"'

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

# Run the macOS SSH backend loopback fixture with an ephemeral sshd and agent.
[group('test')]
test-ssh:
    scripts/ssh-loopback-fixture.sh cargo nextest run -p omp-exec-ssh --locked --run-ignored all

# ADR 0049 D5: first-party extension conformance (manifests, unittests, frozen API smoke).
[group('test')]
test-extensions:
    python3 scripts/check-extension-conformance.py

# ADR 0049 D5: alias for the full extension conformance gate.
[group('build & check')]
check-extensions:
    python3 scripts/check-extension-conformance.py

# ---------------------------------------------------------------------------
# E2E acceptance suite (crates/e2e, joined-system proofs P1-P12, P14)
# ---------------------------------------------------------------------------

# Compile every acceptance proof without running them.
[group('e2e')]
e2e-build:
    cargo nextest run -p omp-e2e --tests --no-run --locked

# Run harness unit tests and proofs P1-P6: doc race, cancel matrix, detached jobs, schema isolation, prefix stability, crash/resume.
[group('e2e')]
e2e-core:
    cargo nextest run -p omp-e2e --locked \
        --lib \
        --test p1_doc_race \
        --test p2_cancel_matrix \
        --test p3_detached_jobs \
        --test p4_schema_isolation \
        --test p5_prefix_stability \
        --test p6_crash_resume

# Run proof P7: real-PTY terminal UI lifecycle, and native Tern surfaces.
[group('e2e')]
e2e-p7:
    TERM=xterm-256color cargo nextest run -p omp-e2e --test p7_tui --test p7_tsp --locked

# Validate the P8 performance-baseline metric schema/contract (non-gating).
[group('e2e')]
e2e-p8:
    cargo nextest run -p omp-e2e --test p8_baselines --locked

# Run proof P9: isolated environment and extension control registration.
[group('e2e')]
e2e-p9:
    cargo nextest run -p omp-e2e --locked \
        --test p9_isolation \
        --test p9_extension_control \
        --test p9_agent_settled \
        --test p9_continuation_grants

# Run proof P10: idempotent historical tool lift through live dispatch.
[group('e2e')]
e2e-p10:
    cargo nextest run -p omp-e2e --test p10_lift_idempotence --locked

# Run proof P11: spectator convergence through a real relay, and read-only enforcement.
[group('e2e')]
e2e-p11:
    cargo nextest run -p omp-e2e --test p11_collab_spectator --locked

# Run proof P12: the real `omp envd` relays a sandbox amendment prompt only to the issuing connection (needs Seatbelt: skips off macOS, fails on macOS without it).
[group('e2e')]
e2e-p12:
    cargo nextest run -p omp-e2e --test p12_daemon_approvals --locked

# Run proof P13: remote execution via the `omp-exec` backend.
[group('e2e')]
e2e-p13:
    cargo nextest run -p omp-e2e --test p13_remote_exec --locked

# Run proof P14: a read-only observer converges over the owner socket and cannot steer.
[group('e2e')]
e2e-p14:
    cargo nextest run -p omp-e2e --test p14_session_attach --locked

# Record a fresh P8 performance-baseline artifact.
[group('e2e')]
e2e-baseline:
    cargo build -p omp-e2e --bin baseline --bin omp_e2e_host --locked
    cargo run -p omp-e2e --bin baseline --locked -- \
        --samples 30 --mode all --daemon-state all --workload all \
        --artifact target/e2e-artifacts/p8-baselines.json

# Run the real W1-W9 matrix remotely and export its raw artifact for CI upload.
[group('remote')]
remote-p8-baseline:
    #!/usr/bin/env bash
    set -euo pipefail
    status=0
    just e2e-baseline || status=$?
    if [ -f target/e2e-artifacts/p8-baselines.json ]; then
        echo OMP_P8_ARTIFACT_BEGIN
        base64 -w0 target/e2e-artifacts/p8-baselines.json
        echo
        echo OMP_P8_ARTIFACT_END
    fi
    exit "$status"

# Run the tool-sources check: production environment source routing and shared document snapshots.
[group('e2e')]
e2e-tool-sources:
    cargo nextest run -p omp-e2e --test tool_sources --locked

# Run every P1-P14 proof plus the tool-sources check (CI runs P1-P8 and P12 on macOS, plus P7, P9-P14 and tool_sources on Linux).
[group('e2e')]
e2e: e2e-build e2e-core e2e-p7 e2e-p9 e2e-p10 e2e-p11 e2e-p12 e2e-p13 e2e-p14 e2e-tool-sources e2e-p8

# ---------------------------------------------------------------------------
# LLM catalog & compat cascade (crates/catalog)
# ---------------------------------------------------------------------------

# Run the taxonomy and compat-cascade test suites.
[group('catalog')]
catalog-test:
    cargo nextest run -p omp-catalog --lib taxonomy
    cargo nextest run -p omp-catalog --test compat_cascade

# Rebuild crates/catalog/data/{catalog.postcard,sources.lock.json} from the oracle fixtures and KDL rules (run after editing any of them). OMP_LLM_CATALOG_REGEN lets the build compile against the stale snapshot being replaced.
[group('catalog')]
catalog-snapshot:
    OMP_LLM_CATALOG_REGEN=1 cargo run -p omp-catalog --example generate_snapshot --locked -- --relock

# Refresh the model roster fixture from pi's generated models.json (e.g. `git show origin/main:packages/catalog/src/models.json > /tmp/models.json`), then rebuild the snapshot. A second argument (`sambanova,helmcode`) limits the import to those providers and keeps the rest of the roster.
[group('catalog')]
catalog-import-v1 models_json only='':
    python3 crates/catalog/scripts/import_v1_models.py --v1 {{ models_json }}{{ if only == "" { "" } else { " --only " + only } }}
    just catalog-snapshot

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

# Verify ci.yml's push paths match .github/ci-paths.txt, its pull_request trigger has no path filter, and the ruleset's required checks are ci.yml jobs.
[group('release')]
check-ci-paths:
    python3 scripts/check-ci-paths.py

# Verify locked Rust dependency licenses and sources with standard cargo-deny tooling.
[group('release')]
license-check:
    cargo deny --locked check licenses sources

# Build the release binary and package it as dist/omp-<sha>-aarch64-apple-darwin.{tar.gz,pkg,sha256} (macOS arm64).
[group('release')]
package-macos: build-release
    scripts/package-macos.sh "$(cargo metadata --no-deps --format-version 1 --locked | python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')/release/omp"

# Install the package-macos artifacts into a scratch prefix and check checksums, `omp --version` and the .pkg payload.
[group('release')]
install-smoke-macos dist="dist":
    scripts/install-smoke-macos.sh {{ dist }}

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
