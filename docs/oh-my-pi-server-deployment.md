# Oh My Pi (omp) — Shared Linux Server Deployment Guide

Deployment guide for making [omp](https://omp.sh) available to all users on a
shared Linux server. Every command marked **[verified]** was actually executed
on a clean Ubuntu-class Linux x86_64 box (Node 24 / npm 11 present, **no Bun,
no Rust toolchain**) against omp 18.1.11. Steps marked **[upstream]** come
straight from the repository docs and were not fully exercised here.

---

## 1. Overview

**omp** (`@oh-my-pi/pi-coding-agent`, binary name `omp`) is an open-source
(MIT) terminal coding agent — a fork of Pi by Mario Zechner. It ships 60+
LLM providers, 31 built-in tools (read/edit/bash/LSP/DAP/eval/subagents/…),
and four entry points around one engine:

| Entry point | Command | Purpose |
|---|---|---|
| Interactive TUI | `omp` | Normal use in a terminal / over SSH |
| Headless one-shot | `omp -p "prompt"` | Scripting; `--mode json` for machines |
| RPC | `omp --mode rpc` | NDJSON request/response over stdio for embedders |
| ACP | `omp acp` | Agent Client Protocol (JSON-RPC stdio) for editors like Zed |

### Architecture in one paragraph

The repo is a Bun/TypeScript monorepo (`packages/coding-agent` is the CLI,
plus `ai`, `agent`, `catalog`, `tui`, `natives`, …) with ~80k lines of Rust
compiled into a single N-API addon (`crates/pi-natives`: embedded bash engine,
in-process grep/glob/find/coreutils, AST, PTY). Two distribution shapes
matter for deployment:

- **Standalone binary** — a self-contained compiled Bun executable (~200 MB
  ELF on x86_64). No Node, no Bun, no Python needed at runtime. This is what
  the official installer downloads from GitHub Releases.
- **npm package** — `@oh-my-pi/pi-coding-agent` on npm. Its CLI shim is
  `#!/usr/bin/env bun`, so it **requires the Bun runtime (≥ 1.3.14)** at run
  time. It does **not** run under plain Node.js.

Configuration lives per-user under `~/.omp/` and per-project under
`<repo>/.omp/`; logs under `~/.omp/logs/`. Details in §5.

### Verification summary (this environment)

| Check | Result |
|---|---|
| Existing binary at `~/.local/bin/omp --version` → `omp/18.1.11` | **[verified]** |
| `omp --smoke-test` (official CI probe: workers + stats assets) | **[verified]** exit 0 |
| `omp --help`, `omp models list`, `omp update --help` | **[verified]** |
| `printf '' \| omp --mode rpc --no-session` → ready frame on stdout, exit 0 | **[verified]** |
| `omp completions bash` / `zsh` → generated scripts | **[verified]** |
| `omp acp --help` | **[verified]** |
| curl installer with `PI_INSTALL_DIR=/tmp/omp-srvtest` → downloads `omp-linux-x64` v18.1.11 from GitHub Releases, smoke-runs it | **[verified]** |
| `npm install -g @oh-my-pi/pi-coding-agent` (controlled prefix) → installs, but `omp` fails under plain Node: `/usr/bin/env: 'bun': No such file or directory` | **[verified]** — JS installs need Bun |
| End-to-end headless run against a **local Ollama** (auto-discovered, zero config): agent session, provider streaming, tool-call dispatch (a weak local model miscalled `read`; the tool executed and its error was returned to the model), clean exit. One model without tool support produced a clean 400 with a request dump in `~/.omp/logs/http-400-requests/` | **[verified]** |
| `omp auth-broker serve` → structured JSON logs, bearer token at `~/.omp/auth-broker.token` (0600); `GET /v1/healthz` → `{"ok":true,"version":"18.1.11"}`; `/v1/snapshot` → 401 without token, 200 with token | **[verified]** |
| Build from source (`bun setup`, `bun run build`) | **[upstream]** — not exercised here (no Bun/Rust on this box) |

---

## 2. Prerequisites and environment

**Target assumptions** (matching upstream docs): modern glibc-based Linux
(Ubuntu/Debian/RHEL class), `x86_64` or `arm64`. Windows and macOS builds
exist but are out of scope here.

### Per install method

| Method | Runtime needed on server | Notes |
|---|---|---|
| **Binary installer** (recommended) | **None.** Single static-ish ELF (needs glibc; on Alpine/musl: `apk add libstdc++ libgcc`) | Downloads from GitHub Releases; ~200 MB on disk |
| `bun install -g` / npm | **Bun ≥ 1.3.14** (the npm shim is `#!/usr/bin/env bun`) | Verified: fails under plain Node 24 |
| Build from source | Bun ≥ 1.3.14 + Rust toolchain (for `pi-natives`) | `bun setup` installs workspaces and builds the native addon |
| Nix | Nix | Pinned Bun/Rust toolchains via flake; `nix run github:can1357/oh-my-pi` |
| Homebrew / mise | brew / mise | Convenience wrappers around the same artifacts |

Other server prerequisites: `git` (omp reads your repos), a terminal with
256-color support over SSH (standard), and outbound HTTPS to your chosen LLM
providers. Optional: a local [Ollama](https://ollama.com) for keyless models —
omp auto-discovers it (verified: `omp models list` showed 12 local models with
zero configuration).

Disk/CPU: the binary is ~200 MB; sessions/logs accumulate per user under
`~/.omp` (plan a few GB for an active team). No database or root daemon is
required for normal use.

---

## 3. Build and installation methods

### 3.1 Shell installer (curl) — what it actually does **[verified: script read + executed]**

```sh
curl -fsSL https://omp.sh/install | sh
```

The URL serves the repo's `scripts/install.sh`. Behavior:

- Default install dir: `$PI_INSTALL_DIR` if set, else `~/.local/bin`.
- Default mode: if a matching-arch Bun ≥ 1.3.14 is present → `bun install -g
  @oh-my-pi/pi-coding-agent`; otherwise → download the prebuilt binary.
- Binary mode picks `omp-linux-x64` / `omp-linux-arm64` (`linux-musl-*` on
  Alpine/musl) from the **latest GitHub Release** of `can1357/oh-my-pi`,
  `chmod +x`, then runs `omp --version` as a smoke check and refuses to claim
  success if the binary can't start (e.g. missing `libstdc++` on musl).
- Flags: `--binary` (force prebuilt), `--source` (bun from source; installs
  Bun if missing), `--ref <tag>` / `-r <tag>` (pin a version; source mode).

**Security note on `curl … | sh`:** you are executing whatever the endpoint
serves today, as your user (or root, if piped to sudo). Safer pattern for a
shared server — download, inspect, then run pinned to a known dir:

```sh
# [verified variant: download + run with explicit install dir]
curl -fsSL https://omp.sh/install -o /tmp/omp-install.sh
less /tmp/omp-install.sh                      # review what you're about to run
sudo env PI_INSTALL_DIR=/usr/local/bin sh /tmp/omp-install.sh
```

(`sudo env VAR=…` passes the variable regardless of sudoers `env_keep`;
verified equivalent with a user-writable `PI_INSTALL_DIR`.)

### 3.2 Bun / npm global **[verified failure mode; upstream-recommended with Bun]**

```sh
bun install -g @oh-my-pi/pi-coding-agent    # needs Bun >= 1.3.14
# or: npm install -g @oh-my-pi/pi-coding-agent   (still needs the bun binary at runtime)
```

Installed shim resolves to the package's `dist/cli.js` whose shebang is
`#!/usr/bin/env bun`. Verified on a Bun-less box: npm install succeeds, then
`omp` fails with `/usr/bin/env: 'bun': No such file or directory`. Only choose
this path if you manage Bun server-wide (e.g. via Nix or a pinned installer).

### 3.3 Nix **[upstream]**

```sh
nix run github:can1357/oh-my-pi            # try without installing
nix profile install github:can1357/oh-my-pi
```

Flake exposes `packages.<system>.omp`, an overlay, NixOS and Home-Manager
modules (`programs.omp.enable = true;`). Most reproducible option if your org
already runs Nix.

### 3.4 Build from source **[upstream]**

```sh
git clone https://github.com/can1357/oh-my-pi.git && cd oh-my-pi
bun setup                    # bun install workspaces + build Rust pi-natives
bun --cwd=packages/coding-agent run build   # produces packages/coding-agent/dist/omp
```

`bun run build:native` rebuilds the Rust addon after crate changes. Use this
when you need to patch omp itself; otherwise prefer the release binary — CI
also smoke-tests binary, source, and npm-tarball install shapes
(`scripts/install-tests/run-ci.sh`), so release binaries are the best-tested
artifact.

### 3.5 Comparison for a shared server

| Method | Isolation | Updates | Security posture | Fit for multi-user |
|---|---|---|---|---|
| Binary → `/usr/local/bin` | None needed (self-contained) | `omp update` or re-run installer | One reviewed script + GitHub Release downloads | **Best**: zero runtime deps, one file for all users |
| Bun global | Needs shared Bun runtime | `bun update -g` | Two supply chains (bun + npm tree) | OK only if Bun already standardized |
| Nix | Excellent | `nix profile` / flake pin | Best reproducibility | Best if Nix exists on the host |
| Source | You own the build | git pull + rebuild | You review every change | Only for omp developers |

---

## 4. Recommended deployment strategy for our shared server

**Primary: prebuilt binary into `/usr/local/bin`** — one self-contained file
on the default PATH of every user; no Bun/Node/Rust on the server at all.

```sh
# As root (or via your config-management tool):
curl -fsSL https://omp.sh/install -o /tmp/omp-install.sh
sudo env PI_INSTALL_DIR=/usr/local/bin sh /tmp/omp-install.sh
omp --version        # → omp/18.x.y   [verified pattern; version varies]
```

To pin a version instead of "latest", download the asset directly:

```sh
# Upstream release layout [verified: installer uses these URLs]
curl -fsSL -o /usr/local/bin/omp \
  https://github.com/can1357/oh-my-pi/releases/download/v18.1.11/omp-linux-x64
chmod 0755 /usr/local/bin/omp
```

(arm64: `omp-linux-arm64`; Alpine: `omp-linux-musl-x64` + `apk add libstdc++
libgcc`.)

### 4.0 Ready-made deployment kit (preferred handoff)

For handing off to a production/deployment team, use the self-contained kit
in [`deployment/`](../deployment/): `deployment/pack.sh` builds a single offline tarball
containing the checksum-verified binary, `install.sh`/`verify.sh`/
`uninstall.sh`, shell completions, an optional auth-broker systemd unit, and
config templates. The deployment-team runbook (`deployment/README.md`) ships
inside the bundle. Build and test it from this repo:

```sh
./deployment/pack.sh --version v18.1.11 --arch x64   # → deployment/dist/*.tar.gz + .sha256
```

The server-side steps in §4.1 onward remain the reference for what the kit
automates.

### 4.1 PATH and shell completions for all users

`/usr/local/bin` is on the default PATH everywhere; nothing to configure.
Completions are **generated by the binary itself** from live CLI metadata
`[verified]`, so they can't drift from the installed version. Wire them
system-wide:

```sh
# bash — one file for all users
sudo tee /etc/profile.d/omp-completions.sh >/dev/null <<'EOF'
# bash completion for omp (generated by the installed binary)
command -v omp >/dev/null 2>&1 && source <(omp completions bash)
EOF

# zsh — drop into the global fpath (adjust if your zsh uses another dir)
sudo sh -c 'omp completions zsh > /usr/local/share/zsh/site-functions/_omp'

# fish
sudo sh -c 'omp completions fish > /etc/fish/completions/omp.fish'
```

`/etc/profile.d` is inherited by every login shell; no per-user setup needed.
`[verified: `omp completions bash|zsh` output; the /etc wiring is standard
distro convention.]`

### 4.2 Persistent modes & systemd — what actually applies

Honest finding from the repo docs: **omp has no single shared server daemon.**
RPC and ACP are *per-session stdio protocols* — each user's `omp` (or their
editor's ACP client) spawns its own process. Don't build a multi-user "omp
service"; it's not the upstream design and each session must run with the
invoking user's credentials and filesystem permissions anyway.

The one upstream-supported, daemon-shaped component that makes sense on a
shared host is the **auth broker** (optional, for §5.3): a small HTTP vault
that holds provider OAuth refresh tokens centrally so individual hosts/users
never store them.

Example unit (drop-in, matches the verified startup behavior):

```ini
# /etc/systemd/system/omp-auth-broker.service
[Unit]
Description=omp auth-broker (credential vault)
After=network-online.target

[Service]
# Dedicated, unprivileged account; own home keeps ~/.omp isolated
User=omp-broker
Group=omp-broker
ExecStart=/usr/local/bin/omp auth-broker serve --bind=127.0.0.1:8765
Restart=on-failure
RestartSec=5
# Broker serves only loopback by default; expose via Tailscale/WireGuard or
# an authenticating reverse proxy if remote teams need it (upstream guidance:
# transport security is the operator's responsibility).
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin omp-broker
sudo systemctl daemon-reload && sudo systemctl enable --now omp-auth-broker
systemctl status omp-auth-broker
curl -s http://127.0.0.1:8765/v1/healthz      # → {"ok":true,...}  [verified endpoint]
journalctl -u omp-auth-broker -f              # structured JSON logs [verified on stdout]
```

Restart policy `on-failure` + `RestartSec=5` is appropriate (verified the
process exits cleanly on SIGTERM; it is stateless except its SQLite file).
Logs go to journald because the broker logs JSON to stdout
`[verified]`; journald handles rotation. Per-user agent logs (§7) rotate
automatically by date.

tmux/supervisord work too, but systemd gives you the restart policy, sandboxing,
and `journalctl` for free.

---

## 5. Configuration and secrets management

### 5.1 Where config lives

Two roots per the upstream config model `[upstream: docs/config-usage.md,
verified paths on disk]`:

| Scope | Path | Contents |
|---|---|---|
| User | `~/.omp/agent/` | `config.yml` (settings), `models.yml` (custom providers), `mcp.json` (MCP servers), `secrets.yml`, `skills/*/SKILL.md`, `rules/`, `commands/`, `extensions/`, plus state: `agent.db` (credentials/sessions DB), `sessions/` |
| Project | `<repo>/.omp/` | Same shape, versioned with the repo; overrides user-level per directory |
| Logs/state | `~/.omp/logs/`, `~/.omp/run/`, `~/.omp/cache/` | date-rotated logs, runtime files |

Precedence: `defaults ← global (~/.omp) ← project (<repo>/.omp) ← PI_CONFIG_FILES ← --config overlays ← runtime`. omp also *reads* existing
`.claude/`, `.cursor/`, `.codex/`, `.gemini/` configs — teams migrating keep
their old files working.

Per-user isolation is the default: each account gets its own `~/.omp`, its own
credential DB, sessions, and logs. Named profiles (`omp --profile work`) give
a user additional isolated sandboxes under `~/.omp/profiles/<name>/`.

### 5.2 Provider credentials (the main per-user secret)

Three layers, in resolution order:

1. **Environment variables** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   `GEMINI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`,
   … (60+; full table in `docs/environment-variables.md`).
2. **Dotenv files** — omp loads, in order: process env → `<repo>/.env` →
   `~/.omp/agent/.env` → `~/.omp/.env` → `~/.env` (first non-empty value
   wins). `[upstream: docs/environment-variables.md]`
3. **`/login` OAuth** — interactive provider sign-in (Anthropic, OpenAI
   Codex, Copilot, …); tokens stored in `~/.omp/agent/agent.db`.
   Retrieve non-interactively with `omp token <provider>`.
4. Local servers (Ollama, LM Studio, llama.cpp, vLLM) need **no key** —
   verified: local Ollama auto-discovered.

**Shared-server recommendation:** per-user keys in `~/.omp/agent/.env`
(`chmod 600`), *not* `/etc/environment` (don't leak one org key into every
user's env) and *not* committed to any repo. Set restrictive umask for dotenv
files. Example:

```bash
# ~rabie/.omp/agent/.env   (mode 0600)
ANTHROPIC_API_KEY=sk-ant-...
# or a custom OpenAI-compatible endpoint:
#   configure provider in ~/.omp/agent/models.yml instead (below)
```

### 5.3 Hardening options for shared hosts **[upstream, endpoints verified]**

- **Secret obfuscation** — `secrets.enabled: true` in `config.yml` scrubs
  configured + credential-shaped values out of provider-visible text
  (`~/.omp/agent/secrets.yml` / `<repo>/.omp/secrets.yml`). Off by default.
- **Auth broker / gateway** — run `omp auth-broker serve` (systemd unit in
  §4.2) on one hardened host; users point at it with `OMP_AUTH_BROKER_URL` +
  `OMP_AUTH_BROKER_TOKEN`, and OAuth refresh tokens never live on the dev
  box (verified: snapshot endpoint returns 401 without the 0600 bearer
  token). This is the upstream pattern for exactly the "shared team
  credentials" problem.
- **Approval modes** — interactive sessions ask before writes by default;
  headless scripts should use explicit `--approval-mode` / `--yolo` choices
  and scoped `--tools` lists. On a shared box, prefer defaults (ask) for
  interactive use.

### 5.4 Example configuration set

Custom internal provider (`~/.omp/agent/models.yml`) — upstream example
shape; useful for an org LLM gateway:

```yaml
providers:
  spark:
    baseUrl: http://192.168.10.223:8000/v1
    api: openai-completions
    apiKey: dummy
    models:
      - id: minimax-m3
        name: MiniMax M3
        contextWindow: 100000
        maxTokens: 32000
```

Default-model without the picker (`~/.omp/agent/config.yml`):

```yaml
modelRoles:
  default: spark/minimax-m3
```

MCP servers (`~/.omp/agent/mcp.json` or `<repo>/.omp/mcp.json`):

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "server-name": { "type": "stdio", "command": "npx", "args": ["-y", "some-mcp-server"] }
  }
}
```

Shared-team assets that *should* be committed per repo (project scope,
versioned): `<repo>/.omp/skills/`, `<repo>/.omp/rules/`, `<repo>/.omp/mcp.json`,
`<repo>/AGENTS.md`. Secrets never go in these.

---

## 6. Multi-user usage guide

Typical engineer workflow (all verified surfaces):

```sh
ssh server
cd ~/projects/myrepo
omp                      # interactive TUI session in this repo
omp "fix the flaky test" # same, with an initial prompt
```

- **Headless/scripting:** `omp -p "summarize last commit"`;
  machine-readable: `omp -p --mode json "…" > out.json`; bound runtime:
  `--max-time 10m`.
- **Sessions:** `omp --continue` (previous), `omp --resume` (picker), `--fork`,
  `--export`. Sessions live in `~/.omp/agent/sessions/` (per user).
- **Editors:** point Zed (or any ACP client) at `omp acp`; embedders speak
  NDJSON to `omp --mode rpc` (first stdout frame is a `ready` object —
  verified). These are per-user, per-session processes; nothing to share.
- **Model choice:** `omp models list|search` (verified); `/model` slash
  command in-session; role flags `--smol/--slow/--plan`; provider login via
  `/login`. Local Ollama models appear automatically if present.
- **Profiles:** `omp --profile client-x` for isolated auth/sessions/config.
- **Isolation expectation:** each user's agent runs as that user — it can
  read what the user can read, and its `bash` tool executes with the user's
  permissions. Treat an omp session like an SSH session, not a sandbox.

Per-user setup checklist: add API key to `~/.omp/agent/.env` (0600) or run
`/login`; optionally `config.yml` for default model; optionally broker env
vars if the org runs an auth broker.

---

## 7. Operations

### Update

```sh
omp update            # self-update to latest stable   [verified: command surface]
omp update --check    # check only
omp update --canary   # switch to canary channel; --stable to return
GITHUB_TOKEN=… omp update   # if release metadata gets rate-limited
```

System-wide installs: either give the install dir group-write with a
controlled updater account, or re-run the pinned installer
(`PI_INSTALL_DIR=/usr/local/bin sh /tmp/omp-install.sh`) from config
management. Version pinning = download a specific release asset (§4).

### Logs

| What | Where |
|---|---|
| Per-user agent logs (auto-rotated by date) | `~/.omp/logs/omp.YYYY-MM-DD.*.log` `[verified]` |
| Failed provider request dumps | `~/.omp/logs/http-400-requests/` `[verified: 400 during e2e test landed here]` |
| auth-broker under systemd | `journalctl -u omp-auth-broker` (JSON lines on stdout) `[verified: stdout JSON]` |
| Sessions / usage DB | `~/.omp/agent/sessions/`, `~/.omp/agent/agent.db` |

### Health checks

```sh
omp --version && omp --smoke-test    # official CI-grade probe [verified: exit 0]
printf '' | omp --mode rpc --no-session | head -1   # ready frame [verified]
curl -s http://127.0.0.1:8765/v1/healthz            # broker, if deployed [verified]
```

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/usr/bin/env: 'bun': No such file or directory` | npm-installed omp without Bun runtime — install Bun ≥ 1.3.14 or switch to the binary **[verified]** |
| Binary exits with relocation errors on Alpine | musl build needs `apk add libstdc++ libgcc` (installer detects and says so) |
| "does not support tools" provider 400 | Model lacks tool-calling (e.g. `gemma3:1b` via Ollama); pick a tools-capable model **[verified]** |
| Provider 429/403 on OAuth refresh behind region block | Set `PI_PROXY` / `HTTPS_PROXY` (docs/environment-variables.md) |
| GitHub rate limit during update | `GITHUB_TOKEN=… omp update` |
| Completions stale after update | They're generated from the live binary; re-source or regenerate the global files once per update |

---

## TL;DR

```sh
# Install system-wide (all users), reviewed-download variant:
curl -fsSL https://omp.sh/install -o /tmp/omp-install.sh
sudo env PI_INSTALL_DIR=/usr/local/bin sh /tmp/omp-install.sh

# Per user, once:
mkdir -p ~/.omp/agent && chmod 700 ~/.omp/agent
echo 'ANTHROPIC_API_KEY=sk-ant-…' > ~/.omp/agent/.env && chmod 600 ~/.omp/agent/.env
# (or just run `omp` and use /login; local Ollama needs nothing)

# Start, as any user, inside a project:
cd ~/projects/myrepo && omp
```

Health: `omp --version && omp --smoke-test` → both exit 0.
