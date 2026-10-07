# Installing omp

Two audiences: users installing a released build, and developers installing from
a local clone. Released installs are covered in [README](README.md#install);
everything below is the from-source path, including the native-addon
prerequisites that fail loudest on a fresh machine.

## Prerequisites

- [Bun](https://bun.sh) 1.3 or newer (`bun --version`) — runtime, package
  manager, and the bundler used to compile the standalone binary.
- `git`.
- A Rust toolchain (`rustup`/`cargo`) — the native addon is a Rust N-API module.
- `cmake` and `ninja` on `PATH` — required by `opusic-sys`, which builds a
  bundled Opus. See [Troubleshooting](#cmake--ninja-missing).
- Linux hosts also need a C/C++ toolchain (`cc`, `c++`) for the same build.

## Released builds

```sh
curl -fsSL https://omp.sh/install | sh     # macOS · Linux
brew install can1357/tap/omp               # Homebrew
bun install -g @oh-my-pi/pi-coding-agent   # Bun
nix profile install github:can1357/oh-my-pi
```

See [README](README.md#install) for Alpine/musl and Nix flake details.

## From a local clone

### Automated script

`scripts/install-local.sh` runs the whole chain and picks the mode with the
`--mode` flag (`wrapper` by default):

```sh
scripts/install-local.sh                    # dev wrapper (default)
scripts/install-local.sh --mode binary      # standalone binary
```

| Flag | Effect |
| --- | --- |
| `--mode wrapper\|binary` | Install mode; `wrapper` is the default. |
| `--prefix DIR` | Binary mode only: install directory (default: Bun global bin). Ignored with a note in wrapper mode — `scripts/link-omp.sh` decides there. |
| `--skip-deps` | Skip `bun install`. |
| `--skip-native` | Skip `bun run build:native` (addon already built). |
| `-h`, `--help` | Usage. |

Both modes run `bun install`, then `bun run build:native` (the script aborts
with instructions when `cargo`, `cmake`, or `ninja` is missing), then either the
launcher link pair or the standalone build. Binary mode removes a pre-existing
symlink at the target before installing, so it can replace a dev wrapper
without clobbering the file the link points at. Either way the script finishes
by running `<prefix>/omp --version` and warns when `omp` on `PATH` resolves
elsewhere.

Typical runs:

```sh
# First install, wrapper mode, addon not built yet
scripts/install-local.sh

# Rebuild only the binary after editing sources
scripts/install-local.sh --mode binary --skip-deps --skip-native
```

### Option A — dev wrapper (source-linked)

The wrapper runs `src/cli.ts` directly, so edits are live with no rebuild.
Automated: `scripts/install-local.sh` (the default mode).

```sh
git clone https://github.com/can1357/oh-my-pi
cd oh-my-pi
bun setup          # install → build:native → link coding-agent → link omp
bun dev            # or plain: omp
```

`bun setup` chains four steps (`scripts/setup.ts`):

1. `bun install` — workspace dependencies.
2. `bun run build:native` — the host Rust/N-API addon.
3. `bun link` in `packages/coding-agent`.
4. `sh scripts/link-omp.sh` — installs `packages/coding-agent/scripts/omp` as
   the global `omp` (symlink, copy fallback). The wrapper resolves Bun's global
   bin through `bun pm -g bin`, falling back to `${BUN_INSTALL:-$HOME/.bun}/bin`.

Manual equivalent, if you want each step explicit:

```sh
bun install
bun run build:native
(cd packages/coding-agent && bun link)
sh scripts/link-omp.sh
```

Re-run `bun run build:native` after touching Rust crates or `packages/natives`.

### Option B — standalone binary

Automated: `scripts/install-local.sh --mode binary`.

```sh
bun install
bun run build:native
cd packages/coding-agent
bun run build                        # → dist/omp
install -m755 dist/omp ~/.bun/bin/omp
```

If `~/.bun/bin/omp` is already a symlink to the dev wrapper, remove it first
(`rm -f ~/.bun/bin/omp`) — otherwise the copy follows the link and overwrites
the wrapper inside the repo.

Cross-compilation uses `CROSS_TARGET` (the value also selects the output name
`dist/omp-<target>`):

| `CROSS_TARGET` | Binary |
| --- | --- |
| `linux-x64` | `dist/omp-linux-x64` |
| `linux-arm64` | `dist/omp-linux-arm64` |
| `darwin-x64`, `darwin-arm64` | `dist/omp-darwin-*` |
| `win32-x64`, `win32-arm64` | `dist/omp-win32-*` |

Unset `CROSS_TARGET` builds for the host and writes `dist/omp`.

## Verify

```sh
omp --version                                     # e.g. omp/18.7.0
omp config get features.unexpectedStopMaxRetries   # config plumbing works
bun dev -- --version                              # source CLI starts
strings -a "$(command -v omp)" | grep -c unexpectedStopMaxRetries  # optional
```

For a non-interactive smoke test:

```sh
omp -p --no-session --auto-approve "Reply with exactly: hi"
```

## Troubleshooting

### `cmake` / `ninja` missing

`bun run build:native` fails with a Rust panic from the `cmake` crate:

```
cmake-0.1.58/src/lib.rs ... failed to execute command: No such file or directory
is `cmake` not installed?
build script failed, must exit now
```

Install both. Without root, unpack the official CMake tarball and prepend its
`bin` directory (Ninja is a single static binary from its GitHub releases):

```sh
mkdir -p ~/.local/opt && cd ~/.local/opt
curl -sLO https://github.com/Kitware/CMake/releases/download/v3.31.6/cmake-3.31.6-linux-x86_64.tar.gz
tar xzf cmake-3.31.6-linux-x86_64.tar.gz
export PATH="$HOME/.local/opt/cmake-3.31.6-linux-x86_64/bin:$PATH"
```

Then re-run `bun run build:native`.

`scripts/install-local.sh` performs the same `cargo`/`cmake`/`ninja` check
before building and aborts with this guidance; `--skip-native` bypasses both
the check and the build.

### Native addon lacks the version stamp

`bun run build` (standalone) embeds native addons only when they carry
`PI_NATIVES_VERSION_STAMP:<package version>`:

```
Native addon .../pi_natives.linux-x64-baseline.node does not carry the
@oh-my-pi/pi-natives@18.7.0 version stamp `PI_NATIVES_VERSION_STAMP:18.7.0`.
Rebuild it (installs stamp automatically), run
`bun scripts/stamp-native-version.ts <addon>`, or fetch
@oh-my-pi/pi-natives-linux-x64@18.7.0 before embedding.
```

Any of the three named remedies works:

```sh
bun run build:native                                          # rebuilds + stamps
bun scripts/stamp-native-version.ts <addon.node> [--version <v>]  # stamps in place
```

### Stale platform addon symlinked into `packages/natives/native`

A globally installed older platform package can be symlinked as
`packages/natives/native/pi_natives.<platform>-<variant>.node` (for example
`@oh-my-pi/pi-natives-linux-x64@17.3.2` against a 18.x checkout). The embed step
then fails the stamp check with the error above. Fix by installing the matching
platform package version, or remove the symlink — embedding succeeds with only
the locally built host variant. Portability suffers (the resulting binary needs
a CPU with the host's ISA level), which matters only if you redistribute it.

### Stale addon at runtime

A workspace addon built from an older release throws a stub naming the missing
symbol, the addon path, and the rebuild command. Run `bun run build:native`.

## Switching or removing installs

```sh
sh scripts/link-omp.sh     # go back to the source-linked dev wrapper
rm -f ~/.bun/bin/omp       # remove the installed omp entirely
```

## Where state lives

- Global config: `~/.omp/agent/config.yml` (settings, model roles, extensions).
- Sessions: `~/.omp/agent/sessions/`.
- Extensions: `~/.omp/agent/extensions/`.

Project inputs (settings, extensions, hooks, tools, commands, skills, rules,
MCP config) load from the repository you open — see
[README](README.md#project-inputs-and-trust) for the trust model and the flags
that narrow it.
