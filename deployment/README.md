# omp Deployment Kit — Runbook for the Deployment Team

Everything needed to install the [omp](https://omp.sh) coding agent on a
shared Linux production server is inside this bundle, including the binary.
**No network access to GitHub, npm, or Bun is required on the target
machine.** This runbook is self-contained.

---

## 1. What's in the kit

| Path | Purpose |
|---|---|
| `install.sh` | Server-side installer (binary + shell completions, optional systemd service) |
| `verify.sh` | Post-install health check |
| `uninstall.sh` | Clean removal (never touches per-user `~/.omp` data) |
| `bin/omp` | The omp binary, self-contained (no Bun/Node/Rust needed at runtime) |
| `MANIFEST.txt` | Version, architecture, binary SHA-256, pack date |
| `SHA256SUMS.txt` | Checksums of every file in this bundle |
| `SHA256SUMS-upstream.txt` | Upstream release checksums (independent verification) |
| `THIRD-PARTY-NOTICES.txt` | License attribution for shipped components |
| `systemd/omp-auth-broker.service` | Optional credential-vault service unit |
| `config/*.example` | Config templates (provider keys, custom models, MCP, secrets) |
| `README.md` | This runbook |

Integrity: `install.sh` refuses to install unless `bin/omp` matches the
SHA-256 recorded in `MANIFEST.txt`. Verify the tarball itself with the
shipped `.sha256` file before unpacking.

## 2. Requirements

- Linux x86_64 or arm64, glibc-based (Ubuntu/Debian/RHEL). For
  Alpine/musl use a `linux-musl` kit and `apk add libstdc++ libgcc`.
- `sha256sum`, `install`/`cp`, `tar` (present on every mainstream distro).
- Root (sudo) for the standard install location.
- No other runtime dependencies — the binary is self-contained.

## 3. Install

```sh
# On the server, as root, from the unpacked kit directory:
sudo ./install.sh
```

What it does:

1. Verifies the binary checksum.
2. Installs the binary to `/usr/local/bin/omp` (0755). Any previous binary
   is kept as `omp.prev` for rollback.
3. Generates shell completions **from the installed binary** into:
   - bash: `/etc/profile.d/omp-completions.sh` (picked up by every login shell)
   - zsh: `/usr/local/share/zsh/site-functions/_omp` (if the directory exists)
   - fish: `/etc/fish/completions/omp.fish` (if the directory exists)
4. (No services are installed or started by default.)

Options: `--prefix DIR` (install under a different prefix, adds a PATH shim),
`--no-completions`, `--with-broker` (§5), `--destroot DIR` (staging/image
builds — never touches the live system, skips systemctl).

## 4. Verify

```sh
sudo ./verify.sh              # or: ./verify.sh --with-broker if §5 was installed
```

Checks: binary runs, `omp --smoke-test` (the project's own CI-grade probe:
worker spawn + stats assets), completions present, and broker health when
`--with-broker` is passed. Exit code 0 = all green.

## 5. Optional: shared credential vault (auth-broker)

Only needed if the org wants provider OAuth tokens held centrally instead of
in each user's `~/.omp`:

```sh
sudo ./install.sh --with-broker
```

- Creates an unprivileged `omp-broker` system user (its home holds the
  SQLite credential store).
- Installs and starts `omp-auth-broker.service` (binds `127.0.0.1:8765`,
  `Restart=on-failure`, hardened unit).
- Bearer token: `/home/omp-broker/.omp/auth-broker.token` (mode 0600).
  Every API endpoint except `/v1/healthz` requires it.

Exposing it beyond loopback is the operator's responsibility — keep it on
loopback, Tailscale/WireGuard, or behind an authenticating reverse proxy.
Client setup per user: set `OMP_AUTH_BROKER_URL` and `OMP_AUTH_BROKER_TOKEN`
(see `config/agent.env.example`). Load credentials onto the broker with
`sudo -u omp-broker omp auth-broker login <provider>` (run where a browser
or SSH forward is available) or `omp auth-broker import`.

## 6. Per-user configuration (each engineer, one time)

```sh
mkdir -p ~/.omp/agent && chmod 700 ~/.omp/agent
cp <kit>/config/agent.env.example ~/.omp/agent/.env   # then edit: add their API key
chmod 600 ~/.omp/agent/.env
```

Or run `omp` once inside a project and use the `/login` slash command
(interactive provider OAuth — no env file needed). Local model servers
(Ollama/LM Studio/vLLM) need no key at all and are auto-discovered.

Recommended per-repo (versioned, no secrets): `<repo>/.omp/skills/`,
`<repo>/.omp/rules/`, `<repo>/.omp/mcp.json`, `<repo>/AGENTS.md` — templates
in `config/`. Full configuration reference ships in the oh-my-pi repository
docs (`docs/oh-my-pi-server-deployment.md` is the accompanying deployment
analysis; upstream docs are the canonical source).

## 7. Update

1. Obtain a new kit tarball (built by the same `deployment/pack.sh` process) and
   verify its `.sha256`.
2. Re-run `sudo ./install.sh` — idempotent; current binary is backed up to
   `omp.prev` first.
3. `sudo ./verify.sh`.

## 8. Rollback

```sh
sudo /path/to/kit/install.sh --rollback   # restores omp.prev
```

(Keep the kit directory around, or re-point `--prefix` at the same location
used during install.)

## 9. Uninstall

```sh
sudo ./uninstall.sh               # binary + completions
sudo ./uninstall.sh --with-broker # also the systemd service
sudo ./uninstall.sh --purge-broker # ...AND destroy the broker credential store
```

Per-user `~/.omp` data (sessions, keys) is never removed by the kit.

## 10. Operations

| What | Where |
|---|---|
| Per-user agent logs (date-rotated) | `~/.omp/logs/omp.YYYY-MM-DD.*.log` |
| Failed provider request dumps | `~/.omp/logs/http-400-requests/` |
| auth-broker logs | `journalctl -u omp-auth-broker` (JSON lines) |
| Sessions / credential DB | `~/.omp/agent/sessions/`, `~/.omp/agent/agent.db` |

Health one-liner (any user): `omp --version && omp --smoke-test`
Broker: `curl -s http://127.0.0.1:8765/v1/healthz`

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `verify.sh` fails at binary start on Alpine | Install `libstdc++ libgcc` (`apk add ...`), then re-run |
| Completions missing after install | zsh/fish dirs didn't exist at install time; re-run installer after installing those shells, or per user: `eval "$(omp completions bash)"` in `~/.bashrc` |
| `install.sh` checksum mismatch | Bundle corrupted in transit — re-transfer and re-check the tarball `.sha256` |
| Provider 401/403 | Wrong/expired key in `~/.omp/agent/.env`, or broker env vars unset; `omp models list` shows what's authenticated |
| Model errors "does not support tools" | The chosen model can't do tool calls — pick a tools-capable model |

## 12. Security notes

- The only secrets on the box (standard install) are per-user provider keys
  in `~/.omp/agent/.env` (0600) or OAuth tokens in each user's `agent.db`.
- With `--with-broker`, OAuth refresh tokens live only in the broker's
  store; the broker never exposes refresh tokens to clients.
- Enable `secrets.enabled: true` (+ `secrets.yml`) to scrub credential-shaped
  text before it reaches any provider.
- omp sessions run with the invoking user's full permissions — treat them
  like SSH sessions. Keep interactive approval defaults ("always-ask");
  automation should opt into `--approval-mode` explicitly.
- Never put API keys in `/etc/environment`, project repos, or the kit.
