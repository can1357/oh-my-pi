# Fork maintenance

This repository is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
carrying the agent-networking work (A2A bridge, Agent Teams, workflow VM, ingress
guards) on top of upstream.

- **Overview and live results**: [README.md](README.md) ([Русская версия](README-RU.md))
- **Feature reference**: [README-EN.md](README-EN.md), [full settings guide (RU)](FORK-RU.md)
- **Contributor rules**: [AGENTS.md](AGENTS.md)

## Build from source

Requirements: Bun ≥ 1.4.4 first on `PATH` (with Bun 1.3.x the type check breaks
and the test suite runs into its timeout), and a Rust toolchain for the native addon.

```sh
bun install
bun --cwd=packages/natives run build          # native addon for this machine
bun run --cwd packages/coding-agent build     # self-contained binary
./packages/coding-agent/dist/omp --version    # dist/omp.exe on Windows
./packages/coding-agent/dist/omp --smoke-test
```

The binary embeds the addon variants present in `packages/natives/native/`. A
local build produces only the variant for the build machine's CPU, so copy the
binary only to machines of the same class.

Do not run `bun run setup` on a machine with a production `omp`: it links the
checkout over the global `omp` command.

## Run beside a production omp

Keep the fork in its own profile and native cache so its sessions, A2A bridges,
tokens and teams never mix with the main install. Two variables do it:

| Variable | Value | Effect |
|---|---|---|
| `OMP_PROFILE` | `agents` | Profile root `~/.omp/profiles/agents/` (sessions, config, `a2a.token`, `a2a-bridges/`) |
| `PI_NATIVES_DIR` | a directory of your choice | Native addon cache apart from the main `omp` |

Windows wrapper (`omp-agents.cmd` in a directory on `PATH`):

```bat
@echo off
setlocal
set "OMP_PROFILE=agents"
set "PI_NATIVES_DIR=%LOCALAPPDATA%\omp-agents\natives"
"%LOCALAPPDATA%\omp-agents\omp.exe" %*
exit /b %ERRORLEVEL%
```

POSIX wrapper (`omp-agents`, executable, on `PATH`):

```sh
#!/usr/bin/env sh
root="$HOME/.local/lib/omp-agents"
OMP_PROFILE=agents PI_NATIVES_DIR="$root/natives" exec "$root/omp" "$@"
```

Bring credentials and settings into the new profile:

```sh
omp auth export | omp-agents auth import -    # provider keys and OAuth logins
omp-agents config path                        # copy config.yml / models.yml here
omp-agents config set team.enabled true       # Agent Teams are off by default
```

OAuth refresh tokens are then shared by two profiles; a provider that rotates
refresh tokens may sign one of them out, after which `/login` in that profile
fixes it.

On Windows a running `omp.exe` cannot be overwritten. To update while sessions are
open, rename the old binary aside (`omp.exe` → `omp.old.exe`) and copy the new one
in; new terminals pick it up.

## Upstream sync

Upstream `main` is merged into this fork's `main`; all fork work lands on `main`
directly.

```sh
git remote add upstream https://github.com/can1357/oh-my-pi.git   # once
git fetch upstream
git merge upstream/main
bun install && bun run --cwd packages/coding-agent build
```

After a merge, run the mechanism suites listed in [README.md](README.md#verified-live)
and the repository gates (`gates.toml`).

## Upstream-PR candidates

Ingress guard, session spawn limiter, `pi.spawnSubagent`, the A2A module, modern
MCP transport (PR #14172 lineage).
