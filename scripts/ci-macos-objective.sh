#!/usr/bin/env bash
# Native commands shared by direct CI and the reviewed worker release.
set -euo pipefail
AFFECTED_SCOPE=${AFFECTED_SCOPE:-full}
AFFECTED_ARGS=${AFFECTED_ARGS:-}
case "${1:?objective required}" in
  lint_macos)
    cargo clippy --workspace --all-targets --locked
    ;;
  rust)
(
scripts/ssh-loopback-fixture.sh cargo nextest run --profile ci -p omp-exec-ssh --locked --run-ignored all
)
(
set -euo pipefail
if cargo nextest run --profile ci --workspace --no-run --locked; then
  exit 0
fi
if [ -z "${CARGO_TARGET_DIR:-}" ] || [ ! -d "${CARGO_TARGET_DIR}" ]; then
  exit 1
fi
echo "::warning::Warm target failed to link; discarding ${CARGO_TARGET_DIR} and retrying once"
rm -rf "${CARGO_TARGET_DIR}"
mkdir -p "${CARGO_TARGET_DIR}"
cargo nextest run --profile ci --workspace --no-run --locked
)
# Test workspace
(
set -euo pipefail
case "$AFFECTED_SCOPE" in
  subset)
    if [ -z "$AFFECTED_ARGS" ]; then
      cargo nextest run --profile ci --workspace --exclude omp-e2e --locked
    else
      read -r -a args <<< "$AFFECTED_ARGS"
      cargo nextest run --profile ci "${args[@]}" --locked
    fi
    ;;
  none) echo "No tested crate is affected; skipping the workspace tests" ;;
  *) cargo nextest run --profile ci --workspace --exclude omp-e2e --locked ;;
esac
)
# Test doctests
(
AFFECTED_ARGS="${AFFECTED_DOC_ARGS:-}"
set -euo pipefail
case "$AFFECTED_SCOPE" in
  subset)
    if [ -z "$AFFECTED_ARGS" ]; then
      echo "No selected crate has a library target; skipping the doctests"
    else
      read -r -a args <<< "$AFFECTED_ARGS"
      cargo test --doc "${args[@]}" --locked
    fi
    ;;
  none) echo "No tested crate is affected; skipping the doctests" ;;
  *) cargo test --doc --workspace --exclude omp-e2e --locked ;;
esac
)
# Gate frozen Python examples
(
python3 scripts/check-python-examples.py
)
(
cargo nextest run --profile ci -p omp-e2e --locked \
  --lib \
  --test p1_doc_race \
  --test p2_cancel_matrix \
  --test p3_detached_jobs \
  --test p4_schema_isolation \
  --test p5_prefix_stability \
  --test p6_crash_resume
)
(
TERM=xterm-256color cargo nextest run --profile ci -p omp-e2e --test p7_tui --test p7_tsp --locked
)
(
cargo nextest run --profile ci -p omp-e2e --test p12_daemon_approvals --test p9_continuation_grants --locked
)
(
cargo nextest run --profile ci -p omp-e2e --test p8_baselines --locked
)
    if [ "${MACOS_WORKER:-false}" != true ] && [ "${AFFECTED_SCOPE:-full}" != subset ] && [ "${AFFECTED_SCOPE:-full}" != none ]; then
      echo "::notice title=proved-tree::$(git rev-parse 'HEAD^{tree}')"
    fi
    ;;
  *) echo "Unknown native objective" >&2; exit 2 ;;
esac
