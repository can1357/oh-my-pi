#!/bin/sh
set -e

# Pi Coding Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh | sh
#
# Options:
#   --source  Install via bun (installs bun if needed)
#   --binary  Always install prebuilt binary

REPO="can1357/oh-my-pi"
PACKAGE="@oh-my-pi/pi-coding-agent"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"

# Parse arguments
MODE=""
for arg in "$@"; do
    case "$arg" in
        --source) MODE="source" ;;
        --binary) MODE="binary" ;;
    esac
done

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

# Install bun
install_bun() {
    echo "Installing bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
}

# Install via bun
install_via_bun() {
    echo "Installing via bun..."
    bun install -g "$PACKAGE"
    echo ""
    echo "✓ Installed pi via bun"
    echo "Run 'pi' to get started!"
}

# Install binary from GitHub releases
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

    BINARY="pi-${PLATFORM}-${ARCH}"

    # Get latest release tag
    echo "Fetching latest release..."
    LATEST=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    if [ -z "$LATEST" ]; then
        echo "Failed to fetch latest release"
        exit 1
    fi
    echo "Latest version: $LATEST"

    # Download binary
    URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    echo "Downloading ${BINARY}..."

    mkdir -p "$INSTALL_DIR"
    curl -fsSL "$URL" -o "${INSTALL_DIR}/pi"
    chmod +x "${INSTALL_DIR}/pi"

    echo ""
    echo "✓ Installed pi to ${INSTALL_DIR}/pi"

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'pi' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'pi'" ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        install_via_bun
        ;;
    binary)
        install_binary
        ;;
    *)
        # Default: use bun if available, otherwise binary
        if has_bun; then
            install_via_bun
        else
            install_binary
        fi
        ;;
esac
