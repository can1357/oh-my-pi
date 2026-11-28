#!/bin/sh
set -e

# OMP Coding Agent Installer
# Usage: curl -fsSL https://omp.sh/install | sh
#        curl -fsSL https://omp.sh/install | sh -s -- --binary --ref v18.8.9
#        curl -fsSL https://omp.sh/install | sh -s -- --uninstall
#
# Options:
#   --source       Install via bun (installs bun if needed)
#   --binary       Install the prebuilt binary (default)
#   --ref <ref>    Install specific tag/commit/branch (source mode); binary
#                  mode takes a release tag (v<version>)
#   -r <ref>       Shorthand for --ref
#   --uninstall    Remove omp: the binary this script installs, or the bun/npm
#                  global package. Keeps omp's state directory (~/.omp) unless
#                  you confirm at the prompt (interactive runs only)
#   --purge        Uninstall and also delete omp's state directory (~/.omp, or
#                  $HOME/$PI_CONFIG_DIR) without asking
#
# Prebuilt binaries come from the build service (PI_BUILD_URL, default
# https://build.stencil.so) and are checked against its sha256 before install.

REPO="can1357/oh-my-pi"
PACKAGE="@oh-my-pi/pi-coding-agent"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
BUILD_URL="${PI_BUILD_URL:-https://build.stencil.so}"
while [ "${BUILD_URL%/}" != "$BUILD_URL" ]; do
    BUILD_URL="${BUILD_URL%/}"
done
MIN_BUN_VERSION="1.4.4"

# Parse arguments
MODE=""
REF=""
UNINSTALL=""
PURGE=""
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
        --uninstall)
            UNINSTALL=1
            shift
            ;;
        --purge)
            UNINSTALL=1
            PURGE=1
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

if [ -n "$UNINSTALL" ] && { [ -n "$MODE" ] || [ -n "$REF" ]; }; then
    echo "--uninstall and --purge do not combine with --source, --binary or --ref"
    exit 1
fi

# The prebuilt binary is the default: it updates itself with delta patches,
# which a bun package install cannot. A ref can name a branch or commit, which
# only a source install can build, so a bare --ref selects source.
if [ -z "$MODE" ]; then
    if [ -n "$REF" ]; then
        MODE="source"
    else
        MODE="binary"
    fi
fi

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

# Normalized host architecture (x64|arm64). On macOS this uses
# `sysctl hw.optional.arm64` so it stays correct inside a Rosetta session,
# where `uname -m` reports the translated x86_64.
host_arch() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
            echo "arm64"
        else
            echo "x64"
        fi
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

# Bun's own architecture (x64|arm64), or empty when it can't be determined.
bun_arch() {
    bun -e 'process.stdout.write(process.arch)' 2>/dev/null
}

# True when Bun's architecture matches the host. If Bun's arch can't be read,
# assume a match rather than block the install.
bun_arch_matches_host() {
    ba="$(bun_arch)"
    [ -z "$ba" ] && return 0
    [ "$ba" = "$(host_arch)" ]
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
    echo "✓ Installed omp via bun"
    echo "Run 'omp' to get started!"
}

# The string value of field "$1" in the one-line JSON on stdin (last
# occurrence). Escaped quotes inside JSON strings never end in `"<key>"`, so
# string contents cannot fake a key.
json_string() {
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

# The members of the build service answer's top-level `file` object (the
# requested target's file). `build.files[]` lists every target's file under the
# `files` key, so its sha256s never match here.
json_file_object() {
    sed -n 's/.*"file"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p'
}

# Hex sha256 of file "$1".
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d ' ' -f 1
    else
        shasum -a 256 "$1" | cut -d ' ' -f 1
    fi
}

# Install binary from the build service
install_binary() {
    if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
        echo "sha256sum or shasum is required to verify the downloaded binary"
        exit 1
    fi

    # Detect platform
    OS="$(uname -s)"
    ARCH="$(host_arch)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="macos" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x64)   TARGET_ARCH="x86_64" ;;
        arm64) TARGET_ARCH="arm64" ;;
        *)     echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    if [ "$PLATFORM" = "linux" ]; then
        if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
            PLATFORM="linux-musl"
        fi
    fi

    TARGET="${PLATFORM}-${TARGET_ARCH}"
    if [ -n "$REF" ]; then
        if ! printf '%s\n' "$REF" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
            echo "Binary installs take a release tag (v<version>) for --ref, got: $REF"
            echo "For branch/commit installs, use --source with --ref."
            exit 1
        fi
        echo "Fetching omp ${REF#v}..."
        API_URL="${BUILD_URL}/api/products/omp/versions/${REF#v}/${TARGET}"
    else
        echo "Fetching latest release..."
        API_URL="${BUILD_URL}/api/products/omp/latest/${TARGET}?channel=stable"
    fi
    if ! BUILD_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "$API_URL"); then
        echo "Failed to resolve an omp build for ${TARGET} from ${API_URL}"
        exit 1
    fi
    BUILD_JSON=$(printf '%s' "$BUILD_JSON" | tr -d '\r\n')

    VERSION=$(printf '%s\n' "$BUILD_JSON" | json_string version)
    FILE_JSON=$(printf '%s\n' "$BUILD_JSON" | json_file_object)
    BINARY=$(printf '%s\n' "$FILE_JSON" | json_string name)
    EXPECTED_SHA256=$(printf '%s\n' "$FILE_JSON" | json_string sha256)
    # Go's JSON encoder writes `&` in the presigned URL as \u0026.
    DOWNLOAD_URL=$(printf '%s\n' "$BUILD_JSON" | json_string download | sed 's/\\u0026/\&/g')
    if [ -z "$VERSION" ] || [ -z "$BINARY" ] || [ -z "$DOWNLOAD_URL" ] ||
        ! printf '%s\n' "$EXPECTED_SHA256" | grep -Eq '^[0-9a-f]{64}$'; then
        echo "Unexpected answer from ${API_URL}"
        exit 1
    fi
    echo "Using version: $VERSION"

    mkdir -p "$INSTALL_DIR"
    # Download next to the destination and move it into place only once the
    # checksum matches, so a bad download never replaces a working omp.
    DOWNLOAD_PATH="${INSTALL_DIR}/.omp.download.$$"
    trap 'rm -f "$DOWNLOAD_PATH"' EXIT
    echo "Downloading ${BINARY}..."
    curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$DOWNLOAD_URL" -o "$DOWNLOAD_PATH"
    ACTUAL_SHA256="$(sha256_of "$DOWNLOAD_PATH")"
    if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
        echo "Checksum mismatch for ${BINARY}: expected ${EXPECTED_SHA256}, got ${ACTUAL_SHA256}"
        exit 1
    fi
    chmod +x "$DOWNLOAD_PATH"
    mv -f "$DOWNLOAD_PATH" "${INSTALL_DIR}/omp"

    # Verify the freshly installed binary can actually start before reporting
    # success. Bun's musl-target binaries link libstdc++/libgcc dynamically,
    # which stock Alpine/musl systems do not ship, so the download succeeds while
    # the binary exits 127 with relocation errors. Never claim success for a
    # binary that cannot run.
    if ! SMOKE_OUTPUT="$("${INSTALL_DIR}/omp" --version 2>&1)"; then
        echo ""
        echo "✗ omp was downloaded to ${INSTALL_DIR}/omp but cannot start:"
        echo "$SMOKE_OUTPUT" | sed 's/^/    /'
        if [ "$PLATFORM" = "linux-musl" ]; then
            echo ""
            echo "The musl build links libstdc++/libgcc dynamically. Install them, then re-run 'omp':"
            if command -v apk >/dev/null 2>&1; then
                echo "    apk add libstdc++ libgcc"
            else
                echo "    (install the libstdc++ and libgcc runtime packages for your distro)"
            fi
        fi
        exit 1
    fi

    echo ""
    echo "✓ Installed omp to ${INSTALL_DIR}/omp"

    # An omp earlier on PATH (a previous `bun install -g`, Homebrew, ...) keeps
    # winning over this install until it is removed or INSTALL_DIR moves ahead.
    ACTIVE_OMP="$(command -v omp 2>/dev/null || true)"
    if [ -n "$ACTIVE_OMP" ] && ! [ "$ACTIVE_OMP" -ef "${INSTALL_DIR}/omp" ]; then
        echo "'omp' still resolves to ${ACTIVE_OMP}; remove that install or put ${INSTALL_DIR} ahead of it on PATH."
        return
    fi

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'omp' to get started!" ;;
        *) print_path_hint ;;
    esac
}

# Print $1 in single quotes, so POSIX shells read it literally.
sh_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Print $1 in double quotes, so fish reads it literally. fish expands only $
# inside them and treats \ as an escape, so escape \, " and $.
fish_quote() {
    printf '"%s"' "$(printf '%s' "$1" | sed 's/[\\"$]/\\&/g')"
}

# Print path $1 for the user to paste: ~/<rest> when it is in the home
# directory and has no characters a shell treats specially, otherwise quoted
# with the quoting function $2.
display_path() {
    case "$1" in
        "$HOME"/*)
            rest="${1#"$HOME"/}"
            case "$rest" in
                *[!A-Za-z0-9._/+-]*) ;;
                *)
                    printf '%s/%s' "~" "$rest"
                    return
                    ;;
            esac
            ;;
    esac
    "$2" "$1"
}

# Tell the user that INSTALL_DIR is not on PATH and print one command, for
# their login shell, that adds it to the shell's startup file and loads it.
print_path_hint() {
    # The startup file each shell reads, and the command that loads it into
    # the current shell. fish needs no file: fish_add_path saves the change.
    rc_file=""
    load_cmd="source"
    case "$(basename "${SHELL:-sh}")" in
        zsh) rc_file="${ZDOTDIR:-$HOME}/.zshrc" ;;
        bash)
            if [ "$(uname -s)" = "Darwin" ]; then
                # Terminals on macOS start bash as a login shell, which reads
                # only the first of these files that exists. Creating
                # ~/.bash_profile would hide an existing ~/.profile.
                rc_file="$HOME/.bash_profile"
                for login_file in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
                    if [ -f "$login_file" ]; then
                        rc_file="$login_file"
                        break
                    fi
                done
            else
                rc_file="$HOME/.bashrc"
            fi
            ;;
        fish) ;;
        *)
            rc_file="$HOME/.profile"
            load_cmd="."
            ;;
    esac

    if [ -z "$rc_file" ]; then
        path_cmd="fish_add_path $(display_path "$INSTALL_DIR" fish_quote)"
    else
        # Write $HOME instead of the expanded home directory so the line stays
        # correct if the home directory moves. The startup file reads the path
        # inside double quotes, so escape the characters those quotes expand.
        case "$INSTALL_DIR" in
            "$HOME"/*) dir_base="\$HOME/" dir_rest="${INSTALL_DIR#"$HOME"/}" ;;
            *) dir_base="" dir_rest="$INSTALL_DIR" ;;
        esac
        dir_rest="$(printf '%s' "$dir_rest" | sed 's/[\\"$`]/\\&/g')"
        rc_line="export PATH=\"${dir_base}${dir_rest}:\$PATH\""
        # zsh's and dash's echo turn backslashes into escape sequences.
        case "$rc_line" in
            *\\*) write_cmd="printf '%s\\n'" ;;
            *) write_cmd="echo" ;;
        esac
        rc_shown="$(display_path "$rc_file" sh_quote)"
        path_cmd="${write_cmd} $(sh_quote "$rc_line") >> ${rc_shown} && ${load_cmd} ${rc_shown}"
    fi

    # printf, not echo: the echo of macOS /bin/sh turns \n in a path into a
    # line break.
    printf '\n%s is not in your PATH. To add it, run:\n\n' "$INSTALL_DIR"
    printf '  %s\n\n' "$path_cmd"
    echo "Then run 'omp' to get started!"
}

# True when $1 exists, including as a dangling symlink.
path_exists() {
    [ -e "$1" ] || [ -L "$1" ]
}

# Remove file or directory $1, saying so.
remove_path() {
    echo "Removing $1"
    rm -rf -- "$1"
}

# Remove what an update can leave beside launcher $1: omp's self-update
# temporaries and backups (<name>.<timestamp>.<pid>[.<seq>].bak|.new|.patch,
# legacy <name>.bak and <name>.new) and this script's .omp.download.<pid>.
remove_update_leftovers() {
    dir="$(dirname "$1")"
    base="$(basename "$1")"
    for leftover in "$dir/$base".* "$dir"/.omp.download.*; do
        path_exists "$leftover" || continue
        case "$leftover" in
            "$dir/.omp.download."*) ;;
            *)
                rest="${leftover#"$dir/$base".}"
                case "$rest" in
                    bak|new) ;;
                    *.bak|*.new|*.patch)
                        case "${rest%.*}" in
                            ""|*[!0-9.]*) continue ;;
                        esac
                        ;;
                    *) continue ;;
                esac
                ;;
        esac
        remove_path "$leftover"
    done
}

# After a package manager removed omp, a regular file still at launcher path $1
# is the standalone binary omp's self-update wrote over the manager's symlink.
# The managers' own launchers are symlinks, which they remove themselves.
remove_taken_over_launcher() {
    if [ -f "$1" ] && ! [ -L "$1" ]; then
        remove_path "$1"
    fi
    remove_update_leftovers "$1"
}

# Bun's executable, also when ~/.bun/bin is not on this shell's PATH.
bun_executable() {
    if has_bun; then
        command -v bun
    elif [ -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ]; then
        echo "${BUN_INSTALL:-$HOME/.bun}/bin/bun"
    fi
}

# Remove the bun global package (what --source installs). Returns 1 when it is
# not installed.
uninstall_bun_package() {
    bun_root="${BUN_INSTALL:-$HOME/.bun}"
    bun_global="${BUN_INSTALL_GLOBAL_DIR:-$bun_root/install/global}"
    path_exists "$bun_global/node_modules/$PACKAGE" || return 1
    bun_cmd="$(bun_executable)"
    if [ -z "$bun_cmd" ]; then
        echo "Found $PACKAGE in bun's global packages (${bun_global}), but bun is not available to remove it"
        exit 1
    fi
    echo "Removing the bun global package $PACKAGE..."
    "$bun_cmd" remove -g "$PACKAGE" || {
        echo "Failed to remove $PACKAGE with bun"
        exit 1
    }
    remove_taken_over_launcher "${BUN_INSTALL_BIN:-$bun_root/bin}/omp"
}

# Remove an npm global install of the package. Returns 1 when there is none.
uninstall_npm_package() {
    command -v npm >/dev/null 2>&1 || return 1
    npm_root="$(npm root -g 2>/dev/null)" || return 1
    [ -n "$npm_root" ] && path_exists "$npm_root/$PACKAGE" || return 1
    echo "Removing the npm global package $PACKAGE..."
    npm uninstall -g "$PACKAGE" || {
        echo "Failed to remove $PACKAGE with npm"
        exit 1
    }
    remove_taken_over_launcher "$(npm prefix -g)/bin/omp"
}

# Refuse to delete a state root that is the home directory, / or an ancestor of
# the home directory, as a PI_CONFIG_DIR of "." or ".." would name.
assert_safe_state_root() {
    root_real="$(cd "$1" && pwd -P)"
    home_real="$(cd "$HOME" && pwd -P)"
    case "$root_real" in
        /) unsafe=1 ;;
        *)
            case "$home_real/" in
                "$root_real"/*) unsafe=1 ;;
                *) unsafe="" ;;
            esac
            ;;
    esac
    if [ -n "$unsafe" ]; then
        echo "Refusing to delete omp's state at $1: it contains the home directory (check PI_CONFIG_DIR)"
        exit 1
    fi
}

# Delete omp's state directories with --purge, or when an interactive user
# confirms; otherwise keep them and say how to delete them. They are the config
# root ($HOME/$PI_CONFIG_DIR, default ~/.omp) and any $XDG_*_HOME/omp that
# `omp config init-xdg` moved state to.
remove_state() {
    set --
    state_root="$HOME/${PI_CONFIG_DIR:-.omp}"
    if [ -d "$state_root" ]; then
        assert_safe_state_root "$state_root"
        set -- "$state_root"
    fi
    for xdg_home in "${XDG_DATA_HOME:-}" "${XDG_STATE_HOME:-}" "${XDG_CACHE_HOME:-}"; do
        [ -n "$xdg_home" ] && [ -d "$xdg_home/omp" ] || continue
        for listed in "$@"; do
            [ "$listed" = "$xdg_home/omp" ] && continue 2
        done
        set -- "$@" "$xdg_home/omp"
    done
    [ $# -gt 0 ] || return 0

    if [ -z "$PURGE" ]; then
        confirmed=""
        # Piped runs (curl ... | sh) read the script from stdin, so they never
        # prompt and never delete state without --purge.
        if [ -t 0 ]; then
            echo ""
            echo "omp's state is stored in:"
            printf '  %s\n' "$@"
            echo "It holds your sessions, settings, credentials, caches and the git"
            echo "worktrees omp created, which may contain uncommitted work."
            printf 'Delete it too? [y/N] '
            read -r answer || answer=""
            case "$answer" in
                y|Y|yes|Yes|YES) confirmed=1 ;;
            esac
        fi
        if [ -z "$confirmed" ]; then
            echo ""
            echo "Kept omp's state (sessions, settings, credentials, caches, worktrees):"
            printf '  %s\n' "$@"
            echo "To delete it as well, re-run with --purge."
            return 0
        fi
    fi

    for state_dir in "$@"; do
        remove_path "$state_dir"
    done
    echo "✓ Deleted omp's state"
}

# Remove what this script installs (the binary in INSTALL_DIR or the bun global
# package), an npm global install, and, when confirmed, omp's state. Homebrew
# installs are left to brew.
uninstall_omp() {
    removed=""
    brewed=""
    if path_exists "${INSTALL_DIR}/omp"; then
        remove_path "${INSTALL_DIR}/omp"
        removed=1
    fi
    remove_update_leftovers "${INSTALL_DIR}/omp"
    if uninstall_bun_package; then
        removed=1
    fi
    if uninstall_npm_package; then
        removed=1
    fi
    if command -v brew >/dev/null 2>&1 && brew list --formula omp >/dev/null 2>&1; then
        brewed=1
        echo "omp is installed with Homebrew; remove it with: brew uninstall omp"
    fi

    if [ -n "$removed" ]; then
        echo ""
        echo "✓ Uninstalled omp"
    elif [ -z "$brewed" ]; then
        echo "No omp install found in ${INSTALL_DIR} or in bun's or npm's global packages."
    fi

    hash -r 2>/dev/null || true
    REMAINING_OMP="$(command -v omp 2>/dev/null || true)"
    if [ -n "$REMAINING_OMP" ] && [ -z "$brewed" ]; then
        echo "'omp' still resolves to ${REMAINING_OMP}, which this script did not install; remove it with the tool that installed it."
    fi

    remove_state
}

# Main logic
if [ -n "$UNINSTALL" ]; then
    uninstall_omp
    exit 0
fi

case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        if ! bun_arch_matches_host; then
            echo "Error: bun reports architecture '$(bun_arch)' but this host is '$(host_arch)'."
            echo "Installing from source with this bun would produce a mismatched binary"
            echo "(e.g. x86_64 under Rosetta on Apple Silicon), causing slow startup and AVX warnings."
            echo "Install a native bun for your architecture, or re-run without --source to fetch the prebuilt $(host_arch) binary."
            exit 1
        fi
        install_via_bun
        ;;
    binary)
        install_binary
        ;;
esac
