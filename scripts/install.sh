#!/bin/sh
set -e

# oh-my-pk installer
# Usage: curl -fsSL https://oh-my-pk.pkking.computer/install.sh | sh
#
# Options:
#   --source       Install via bun (installs bun if needed)
#   --binary       Always install prebuilt binary
#   --ref <ref>    Install specific tag/commit/branch
#   -r <ref>       Shorthand for --ref

REPO="kingkillery/oh-my-pk"
DIST_BASE="${OMP_DIST_BASE:-https://oh-my-pk.pkking.computer}"
PACKAGE="@pk-nerdsaver-ai/pi-coding-agent"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
MIN_BUN_VERSION="1.3.14"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# If a ref is provided, default to source install
if [ -n "$REF" ] && [ -z "$MODE" ]; then
    MODE="source"
fi

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Install bun
install_bun() {
    echo "Installing bun..."
    if command -v bash >/dev/null 2>&1; then
        curl -fsSL https://bun.sh/install | bash
    else
        echo "bash not found; attempting install with sh..."
        curl -fsSL https://bun.sh/install | sh
    fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

# Install via bun
install_via_bun() {
    echo "Installing via bun..."
    if [ -n "$REF" ]; then
        if ! has_git; then
            echo "git is required for --ref when installing from source"
            exit 1
        fi

        TMP_DIR="$(mktemp -d)"
        trap 'rm -rf "$TMP_DIR"' EXIT

        if git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$TMP_DIR" >/dev/null 2>&1; then
            :
        else
            git clone "https://github.com/${REPO}.git" "$TMP_DIR"
            (cd "$TMP_DIR" && git checkout "$REF")
        fi

        # Pull LFS files
        if has_git_lfs; then
            (cd "$TMP_DIR" && git lfs pull)
        fi

        if [ ! -d "$TMP_DIR/packages/coding-agent" ]; then
            echo "Expected package at ${TMP_DIR}/packages/coding-agent"
            exit 1
        fi

        bun install -g "$TMP_DIR/packages/coding-agent" || {
            echo "Failed to install from source"
            exit 1
        }
    else
        bun install -g "$PACKAGE" || {
            echo "Failed to install $PACKAGE"
            exit 1
        }
    fi
    echo ""
    echo "✓ Installed oh-my-pk via bun"
    echo "Run 'oh-my-pk' (or 'ompk') to get started!"
}

# Install prebuilt binary from the distribution endpoint (Cloudflare Worker ->
# private Hugging Face repo); no GitHub Releases dependency.
install_binary() {
    # Detect platform
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    BINARY="omp-${PLATFORM}-${ARCH}"
    # Resolve version: an explicit --ref pins the tag; otherwise ask the
    # distribution endpoint (Cloudflare Worker -> private Hugging Face repo) for
    # the latest tag. No GitHub dependency.
    if [ -n "$REF" ]; then
        LATEST="$REF"
    else
        echo "Fetching latest version..."
        LATEST=$(curl -fsSL "${DIST_BASE}/version" | tr -d '[:space:]')
    fi

    if [ -z "$LATEST" ]; then
        echo "Failed to resolve version"
        exit 1
    fi
    echo "Using version: $LATEST"

    mkdir -p "$INSTALL_DIR"
    # Download binary from the distribution endpoint.
    BINARY_URL="${DIST_BASE}/bin/${LATEST}/${BINARY}"
    echo "Downloading ${BINARY}..."
    curl -fsSL "$BINARY_URL" -o "${INSTALL_DIR}/oh-my-pk"
    chmod +x "${INSTALL_DIR}/oh-my-pk"
    # Keep `omp` and `ompk` as launch aliases for the renamed command.
    cp "${INSTALL_DIR}/oh-my-pk" "${INSTALL_DIR}/omp"
    chmod +x "${INSTALL_DIR}/omp"
    cp "${INSTALL_DIR}/oh-my-pk" "${INSTALL_DIR}/ompk"
    chmod +x "${INSTALL_DIR}/ompk"
    echo ""
    echo "✓ Installed oh-my-pk to ${INSTALL_DIR}/oh-my-pk (aliases: omp, ompk)"

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'oh-my-pk' (or 'ompk') to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'oh-my-pk' or 'ompk'" ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        install_via_bun
        ;;
    binary)
        install_binary
        ;;
    *)
        # Default: install/validate bun (if needed) and use the npm package.
        # Pass --binary explicitly to always fetch the prebuilt binary instead.
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        install_via_bun
        ;;
esac
