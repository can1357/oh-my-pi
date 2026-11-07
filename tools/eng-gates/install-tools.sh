#!/usr/bin/env bash
# Install the tools eng-gates calls. Idempotent: installed tools are skipped.
#
#   install-tools.sh [--rust] [--python] [--ts] [--ub] [--all] [--dry-run]
#
# --rust    cargo-nextest cargo-deny cargo-machete cargo-semver-checks cargo-llvm-cov  (cargo binstall if present)
# --python  ruff pyright import-linter deptry  as uv tools (pipx as fallback); pytest-cov / pytest-benchmark go
#           into the project's own dev dependencies, not here
# --ts      prints the devDependencies to add to the project (installed per project, never globally)
# --ub      clones unclebob/crapper, dryer, mutator side by side into $ENG_GATES_UB_DIR
#           (default ~/.local/share/eng-gates/ub). Each creates its own .venv on first run.
#           Pin each one: ENG_GATES_CRAPPER_REF / ENG_GATES_DRYER_REF / ENG_GATES_MUTATOR_REF=<commit>.
set -euo pipefail

UB_DIR="${ENG_GATES_UB_DIR:-$HOME/.local/share/eng-gates/ub}"
DRY=0; DO_RUST=0; DO_PY=0; DO_TS=0; DO_UB=0
for a in "$@"; do
  case "$a" in
    --rust) DO_RUST=1 ;; --python) DO_PY=1 ;; --ts) DO_TS=1 ;; --ub) DO_UB=1 ;;
    --all) DO_RUST=1; DO_PY=1; DO_TS=1; DO_UB=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
if [ $((DO_RUST + DO_PY + DO_TS + DO_UB)) -eq 0 ]; then
  [ -f Cargo.toml ] && DO_RUST=1
  { [ -f pyproject.toml ] || [ -f requirements.txt ] || [ -f setup.cfg ] || [ -f setup.py ]; } && DO_PY=1
  [ -f package.json ] && DO_TS=1
  DO_UB=1
fi

run() { echo "+ $*"; [ "$DRY" = 1 ] || "$@"; }
have() { command -v "$1" >/dev/null 2>&1; }

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if [ "$DO_UB" = 1 ]; then
      echo "skip ub: crapper/dryer/mutator launchers are POSIX-only (hard-coded .venv/bin); gate.py reports them as missing on Windows"
      DO_UB=0
    fi ;;
esac

if [ "$DO_RUST" = 1 ]; then
  have cargo || { echo "cargo not found: install rustup first" >&2; exit 1; }
  for crate in cargo-nextest cargo-deny cargo-machete cargo-semver-checks cargo-llvm-cov; do
    if have "$crate"; then echo "ok   $crate"; continue; fi
    if have cargo-binstall; then run cargo binstall -y --locked "$crate"; else run cargo install --locked "$crate"; fi
  done
  have rustup && run rustup component add clippy rustfmt llvm-tools-preview
  echo "note: gungraun (Valgrind-based benchmarks) is a per-project dev-dependency;"
  echo "      its runner must match the library version: cargo binstall gungraun-runner@<version>"
fi

if [ "$DO_PY" = 1 ]; then
  for tool in ruff pyright import-linter deptry; do
    bin="$tool"; [ "$tool" = import-linter ] && bin=lint-imports
    if have "$bin"; then echo "ok   $tool"; continue; fi
    if have uv; then run uv tool install "$tool"
    elif have pipx; then run pipx install "$tool"
    else echo "need uv or pipx to install $tool" >&2; exit 1; fi
  done
  echo "project dev deps (add yourself): pytest pytest-cov pytest-benchmark   (uv add --dev ...)"
fi

if [ "$DO_TS" = 1 ]; then
  cat <<'EOF'
Add to the project (pick your package manager):
  npm i -D typescript eslint @eslint/js typescript-eslint dependency-cruiser knip vitest @vitest/coverage-v8
  # libraries / frontends only:
  npm i -D size-limit @size-limit/preset-small-lib
  # benchmarks:
  npm i -D tinybench
EOF
fi

if [ "$DO_UB" = 1 ]; then
  have git || { echo "git not found" >&2; exit 1; }
  have python3 || { echo "python3 (3.10+) needed for crapper/dryer/mutator" >&2; exit 1; }
  run mkdir -p "$UB_DIR"
  for repo in crapper dryer mutator; do
    if [ -d "$UB_DIR/$repo/.git" ]; then
      echo "ok   $repo ($UB_DIR/$repo)"
    else
      run git clone --quiet https://github.com/unclebob/$repo "$UB_DIR/$repo"
    fi
    ref_var="ENG_GATES_$(echo "$repo" | tr '[:lower:]' '[:upper:]')_REF"
    ref="${!ref_var:-}"
    if [ -n "$ref" ] && [ "$DRY" = 0 ]; then run git -C "$UB_DIR/$repo" fetch --quiet origin "$ref"; run git -C "$UB_DIR/$repo" checkout --quiet "$ref"; fi
  done
  echo "mutator reads function names from ../crapper, so keep all three in $UB_DIR."
  echo "Each tool builds .venv on first run (needs PyPI access once). Pin commits with ENG_GATES_<TOOL>_REF."
  echo "Side effects to know: crapper/mutator may install coverage, pytest or cargo-llvm-cov when missing."
fi
