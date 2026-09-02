---
title: The ~/.omp Directory
description: Every path omp creates under the config root — the recursive layout of ~/.omp, what each entry stores, and its retention.
coverage: A
---

Every path omp creates at runtime resolves through a single cached `DirResolver` rooted at the config root: `~/.omp` by default, `$HOME/<PI_CONFIG_DIR>` when `PI_CONFIG_DIR` is set (its default value is `.omp`). Named profiles (`--profile <name>`, or `OMP_PROFILE`/`PI_PROFILE`) pin the whole tree under `~/.omp/profiles/<name>/`, including a dedicated `agent/` directory inside the profile root. `PI_CODING_AGENT_DIR` overrides the agent directory outright.

On Linux and macOS installs where `omp config migrate` / `init-xdg` has run and the XDG variables are set, the `data`, `state`, and `cache` categories redirect to `$XDG_DATA_HOME/omp`, `$XDG_STATE_HOME/omp`, and `$XDG_CACHE_HOME/omp`. This applies to the default profile only — named profiles pin those categories under `profiles/<name>/` within the redirected roots. The trees below mark each entry's category with `[data]`, `[state]`, or `[cache]`. A few agent subdirectories — `themes`, `tools`, `commands`, `prompts`, `modules` — never redirect (marked `[no-xdg]`) and always live under `~/.omp/agent`.

`~/.omp/.env` and `~/.omp/agent/.env` are parsed eagerly at startup (with `<cwd>/.env` and `$HOME/.env`, in ascending precedence). A `.env` file can set `XDG_*` or `PI_CODING_AGENT_DIR`; after applying them omp calls `refreshDirsFromEnv()` and rebuilds every resolved path, so directory variables from a `.env` file take effect process-wide.

## Layout

```text
~/.omp/                                  # config root ($HOME/.omp; $PI_CONFIG_DIR override)
├── config.yml / config.yaml             # main settings (also consulted by auth-broker discovery)
├── .env                                 # eagerly loaded dotenv (project < agent < root < $HOME precedence)
├── install-id                           # per-install UUID, 0600; anchored to base root, never profile-scoped
├── stats.db                             # usage stats SQLite (messages, tool calls, file offsets)
├── gpu_cache.json                       # GPU info cache for the system prompt
├── marketplaces.json                    # registry of user-added plugin marketplaces
├── autoqa.db                            # auto-QA grievance SQLite
├── auth-broker.token                    # auth-broker bearer token
├── auth-gateway.token                   # auth-gateway bearer token
├── profiles/                            # per-profile roots: profiles/<name>/ (+ own agent/)
├── reports/                    [state]  # bug-report bundles (omp-report-<timestamp>.tar.gz)
├── logs/                       [state]  # rotating process logs omp.YYYY-MM-DD.PID.log
│   └── http-400-requests/               # JSON dumps of HTTP 400 response payloads
├── plugins/                    [data]   # plugin install root
│   ├── package.json                     # plugin manifest
│   ├── omp-plugins.lock.json            # runtime plugin pins
│   ├── node_modules/                    # bun install output
│   ├── installed_plugins.json           # installed-plugin registry (user scope)
│   └── cache/
│       ├── marketplaces/                # cloned marketplace catalogs (<name>/marketplace.json)
│       └── plugins/                     # downloaded sources (<mkt>___<plugin>___<ver>/)
├── cache/                      [cache]  # shared cache root
│   ├── github-cache.db                  # GitHub tool cache
│   ├── auth-broker-snapshot.enc         # encrypted auth snapshot cache (TTL 60 min)
│   ├── fastembed/                       # FastEmbed model cache
│   └── fastembed-runtime/               # on-demand fastembed runtime installs
├── natives/                    [cache]  # native binaries (fd, rg, ...), versioned <version>/
├── puppeteer/                  [cache]  # Chromium download cache + sandbox cwd
├── browser-relay/              [data]   # browser-relay Chrome extension (extension/)
├── remote/                     [data]   # sshfs remote mount root
├── python-env/                 [data]   # managed Python venv
├── webcache/                   [cache]  # docs.rs rustdoc cache (docsrs_<crate>_<version>/)
├── ssh-control/                [state]  # OpenSSH ControlMaster sockets (%C.sock)
├── remote-host/                [data]   # per-host probe info (<sanitized-host>.json)
├── security/                   [state]  # security-analysis store, per project
│   └── <project-key>/                   # index.json, scans/<scanId>/, plans/<planId>.json
├── collab/                              # collab room replicas (<roomId>.jsonl)
├── wt/                        [data]    # agent-managed git worktrees (<segment>/)
├── run/
│   ├── daemons/               [state]   # per-project broker runtime (<hash>/) + global/<service>/
│   └── provider-inflight/     [state]   # per-provider in-flight request locks
├── autoresearch/              [state]   # per-project <encoded>/ dirs, .db, runs/<NNNN>/ artifacts
└── .dev-cwd                             # dev-only launch cwd (Bun preload shim)

~/.omp/agent/                            # agent config root (PI_CODING_AGENT_DIR / profiles/<name>/agent)
├── config.yml / config.yaml             # main settings (canonical write target)
├── settings.json                        # native user settings (read by discovery)
├── .env                                 # eagerly loaded dotenv; may set XDG_*/PI_CODING_AGENT_DIR
├── agent.db                   [data]    # SQLite: settings, auth credentials, memory threads
├── history.db                 [data]    # session history SQLite
├── models.db                  [data]    # model cache SQLite
├── sessions/                  [data]    # session transcripts
│   └── <encoded-cwd>/                   # <timestamp>_<id>.jsonl + artifact dirs <id>/
├── archive/
│   └── sessions/                        # gc archive of cold sessions (<rel>.jsonl.gz)
├── blobs/                     [data]    # content-addressed image blobs (<sha256-hex>)
├── terminal-sessions/         [state]   # per-terminal breadcrumbs for --continue
├── cache/                     [cache]
│   ├── tiny-models/                     # HF model cache for STT/TTS/tiny-title
│   ├── stt-runtime/                     # on-demand STT runtime installs
│   ├── tts-runtime/                     # on-demand TTS runtime installs
│   ├── tiny-title-runtime/              # on-demand tiny-title runtime installs
│   └── document-conversions/            # markit/doc conversion cache (<key>.json)
├── extensions/                          # user extension modules
├── skills/                              # user skills
├── managed-skills/                      # autolearn-managed skills (isolated root)
├── agents/                              # user-defined subagents (markdown)
├── rules/                               # user rules
├── instructions/                        # user instructions
├── prompts/                   [no-xdg]  # custom prompts
├── commands/                  [no-xdg]  # custom slash commands
├── tools/                     [no-xdg]  # custom tools + managed tool binaries
├── themes/                    [no-xdg]  # custom JSON themes
├── modules/                   [no-xdg]  # agent modules
├── memories/                  [state]   # memory files per project (<encoded-cwd>/)
├── mcp.json                             # user-scope MCP server config
├── ssh.json                             # user-scope SSH host config
├── last-changelog-version     [state]   # marker suppressing repeat "What's New"
├── secret-placeholder.key     [state]   # secret-redaction key
├── omp-crash.log              [state]   # crash log
├── omp-debug.log              [state]   # TUI render/commit debug log (debug mode only)
└── python-gateway/            [state]   # shared Python gateway state
```

`[data]`, `[state]`, and `[cache]` mark the XDG category; `[no-xdg]` entries always stay under `~/.omp` / `~/.omp/agent` even when XDG redirection is active. Most entries above are created on demand and may not exist until first use.

## Per-entry detail

The writer/reader column names the primary omp component; retention is the only automatic cleanup — anything marked *none* grows until `omp gc` or manual deletion.

### Config-root files

| Path | Purpose | Writer / reader | Retention |
| --- | --- | --- | --- |
| `config.yml` / `config.yaml` | Main settings; also consulted by auth-broker config discovery | Settings (canonical write target: `agent/config.yml`) | None |
| `.env` | Startup dotenv; may set `XDG_*` / `PI_CODING_AGENT_DIR` | `utils/env.ts` (read-only) | None |
| `install-id` | Per-install UUID (Claude `device_id`, grievance pushes, provider sessions) | Created 0600 with `O_CREAT|O_EXCL`; anchored to the base root regardless of profile | None |
| `stats.db` | Usage stats SQLite (messages, user messages, tool calls, file offsets) | `omp stats` (sync from session files); model-perf backfill | Rows for archived sessions removed by `omp gc` |
| `gpu_cache.json` | GPU info cache for the system prompt | system-prompt builder (read + write) | None |
| `marketplaces.json` | Registry of user-added marketplaces (legacy file adopted on XDG) | MarketplaceManager | None |
| `autoqa.db` | Auto-QA grievance SQLite | report-tool-issue tool | None |
| `auth-broker.token` | Auth-broker bearer token | `omp auth-broker token`; broker discovery reads | None (manual delete) |
| `auth-gateway.token` | Auth-gateway bearer token | `omp auth-gateway token` | None (manual delete) |
| `profiles/<name>/` | Isolated per-profile config root, incl. its own `agent/` | `omp --profile` bootstrap | None |

### Config-root subdirectories

| Path | Purpose | Writer / reader | Retention |
| --- | --- | --- | --- |
| `reports/` | Bug-report bundles `omp-report-<timestamp>.tar.gz` | debug report bundle | None found |
| `logs/` | Rotating process logs `omp.YYYY-MM-DD.PID.log` + `.omp.<pid>-audit.json` | logger file transport | 10 MiB × 5 files; dead-process logs pruned |
| `logs/http-400-requests/` | JSON dumps of HTTP 400 response payloads | http inspector | None |
| `plugins/` | Plugin install root: `package.json`, `omp-plugins.lock.json`, `node_modules/`, `installed_plugins.json` | PluginManager, plugin CLI | None |
| `plugins/cache/marketplaces/` | Cloned marketplace catalogs `<name>/marketplace.json` | marketplace fetcher (staged, atomically promoted) | None |
| `plugins/cache/plugins/` | Downloaded plugin sources `<mkt>___<plugin>___<ver>/` | `cachePlugin()` | Orphan sweep on install/uninstall |
| `cache/github-cache.db` | GitHub tool cache | github-cache tool | None (no TTL) |
| `cache/auth-broker-snapshot.enc` | Encrypted auth snapshot cache | auth-broker discovery | TTL 60 min (`OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`) |
| `cache/fastembed/` | FastEmbed model cache | embeddings (self-heals corrupt models) | None |
| `cache/fastembed-runtime/` | On-demand fastembed runtime installs | fastembed runtime | None |
| `natives/` | Native binaries (fd, rg, …), versioned `<version>/` | native loader | None |
| `puppeteer/` | Chromium download cache + sandbox cwd | browser tool | None |
| `browser-relay/` | Browser-relay Chrome extension (`extension/`) | `omp browser-relay install` | None |
| `remote/` | sshfs remote mount root | sshfs mount | None |
| `python-env/` | Managed Python venv | python setup / eval runtime | None |
| `webcache/` | docs.rs rustdoc cache `docsrs_<crate>_<version>/` | docs-rs tool | None (no TTL) |
| `ssh-control/` | OpenSSH ControlMaster sockets `%C.sock` (0700) | ssh connection manager | Sockets governed by ssh; `ControlPersist=3600` |
| `remote-host/` | Per-host probe info `<sanitized-host>.json` | ssh connection manager | Deleted on host removal |
| `security/` | Security store per project: `index.json`, `scans/<scanId>/`, `plans/<planId>.json` (0700/0600) | security store | None |
| `collab/` | Collab room replicas `<roomId>.jsonl` | collab guest | None found |
| `wt/` | Agent-managed git worktrees `<segment>/` | PR checkout, task isolation | `omp worktree` scan/cleanup |
| `run/daemons/` | Per-project broker runtime `<hash>/` (0700) + `global/<service>/` | daemon launcher / client | None |
| `run/provider-inflight/` | Per-provider in-flight locks: `info.json` leases, `.wakeup`, `.lock` | ai stream | Lease stale 30 s, lock 10 s, heartbeat 5 s |
| `autoresearch/` | Per-project `<encoded>/` dirs, `<encoded>.db`, `runs/<NNNN>/` artifacts | autoresearch storage | None |
| `.dev-cwd` | Dev-only launch cwd for the Bun preload shim | dev launcher | None |

### Agent directory

| Path | Purpose | Writer / reader | Retention |
| --- | --- | --- | --- |
| `agent/config.yml` | Main settings (canonical write target) | Settings | None |
| `agent/settings.json` | Native user settings | Discovery (read); user-edited | None |
| `agent/.env` | Agent dotenv; may rewire `XDG_*` / `PI_CODING_AGENT_DIR` | env loader → `refreshDirsFromEnv()` | None |
| `agent/agent.db` | SQLite: settings, auth credentials, memory threads | AgentStorage, credential store, memories | WAL checkpoint via `omp gc` |
| `agent/history.db` | Session history SQLite | HistoryStorage | WAL checkpoint via `omp gc` |
| `agent/models.db` | Model cache SQLite | model cache | WAL checkpoint via `omp gc` |
| `agent/sessions/` | Transcripts `<encoded-cwd>/<timestamp>_<id>.jsonl` + artifact dirs | FileSessionStorage | `omp gc`: archive after 30 days cold; keep newest 20 global / 10 per cwd |
| `agent/archive/sessions/` | gz-compressed cold-session archive | `omp gc` | Grows with archived sessions |
| `agent/blobs/` | Content-addressed image blobs `<sha256-hex>` (+ `<hash>.<ext>` sidecar) | session persistence, BlobStore | `omp gc --blobs`: unreferenced blobs older than 5 min write grace |
| `agent/terminal-sessions/` | Per-terminal breadcrumbs (cwd + last session for `--continue`) | session paths | Overwritten per session |
| `agent/cache/tiny-models/` | HF transformers cache for STT/TTS/tiny-title | workers, downloaders | None |
| `agent/cache/stt-runtime/` + `tts-runtime/` + `tiny-title-runtime/` | On-demand runtime installs | workers | None |
| `agent/cache/document-conversions/` | markit/doc conversion cache `<key>.json` | markit cache | None |
| `agent/extensions/` | User extension modules | extension discovery | None |
| `agent/skills/` | User skills | skill discovery | None |
| `agent/managed-skills/` | Autolearn-managed skills (isolated root) | autolearn, manage-skill tool | None |
| `agent/agents/` | User-defined subagents (markdown) | task discovery, `omp agents` | None |
| `agent/rules/` | User rules | rules discovery | None |
| `agent/instructions/` | User instructions | discovery | None |
| `agent/prompts/` | Custom prompts | prompt templates | None |
| `agent/commands/` | Custom slash commands | builtin registry | None |
| `agent/tools/` | Custom tools + managed tool binaries | tool discovery, tools manager | None |
| `agent/themes/` | Custom JSON themes | theme loader | None |
| `agent/modules/` | Agent modules | module loader | None |
| `agent/memories/` | Memory files per project `<encoded-cwd>/` (incl. mnemopi bank db) | memories | None |
| `agent/mcp.json` | User-scope MCP server config | MCP config reader/writer | None |
| `agent/ssh.json` | User-scope SSH host config | SSH config reader/writer | None |
| `agent/last-changelog-version` | Marker suppressing repeat "What's New" | settings | None |
| `agent/secret-placeholder.key` | Secret-redaction key (legacy file adopted on XDG) | secrets | None |
| `agent/omp-crash.log` | Crash log | external crash handler | None found |
| `agent/omp-debug.log` | TUI render/commit debug log (debug mode only) | TUI | None (no rotation) |
| `agent/python-gateway/` | Shared Python gateway state | Python gateway daemon | None |

## Code-created vs user-created

Everything in the trees above is created by omp on demand, with these exceptions:

- **`~/.omp/agent/skills-bak/`** — not referenced anywhere in omp's code; it is a user-created backup of `agent/skills/` (for example from before omp took over that directory).
- **Local share scripts** (`share.ts`, `share.js`, `share.mjs` in `~/.omp/agent`) — user-created. When present, one takes over `/share` entirely: the session is written to a temporary HTML file and handed to your script, which decides what happens next.
- **The built-in `/share` flow** (no local script) writes nothing to `~/.omp` beyond the session itself: the session snapshot is encrypted locally and uploaded to a remote share server (or a secret gist when `share.store: "gist"` is configured).

## Project-local surface

Projects can carry their own `<cwd>/.omp/` directory, read per project:

```text
<cwd>/.omp/
├── modules/                  # project agent modules
├── prompts/                  # project prompts
├── plugin-overrides.json     # per-project plugin pins
├── installed_plugins.json    # project-scope installed-plugin registry
├── mcp.json                  # project MCP server config
├── ssh.json                  # project SSH host config
├── agents/                   # project subagents (omp agents unpack --project)
└── skills/  commands/  rules/  extensions/  instructions/  settings.json
                              # discovery subdirs, loaded only when present
```

## Retention summary

| Policy | Scope | Behavior |
| --- | --- | --- |
| Log rotation | `logs/` | 10 MiB per file × 5 files; dead-process logs pruned |
| Session GC | `agent/sessions/` → `agent/archive/sessions/` | Archive after 30 days cold; keep newest 20 global / 10 per cwd (`gc.coldArchiveAfterDays`, `gc.retainNewestGlobal`, `gc.retainNewestPerCwd`) |
| Blob GC | `agent/blobs/` | Unreferenced blobs older than 5 min write grace deleted (`omp gc --blobs`) |
| In-flight lease reaping | `run/provider-inflight/` | Lease stale 30 s, lock stale 10 s, heartbeat 5 s |
| Auth snapshot TTL | `cache/auth-broker-snapshot.enc` | 60 min (`OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`) |
| SSH control sockets | `ssh-control/` | `ControlPersist=3600`; lifetime governed by ssh |
| Plugin cache sweep | `plugins/cache/plugins/` | Orphans removed on install/uninstall |
| Stats rows | `stats.db` | Rows for archived sessions removed by `omp gc` |
| WAL checkpoints | `agent/agent.db`, `history.db`, `models.db` | Checkpointed by `omp gc` |
| Everything else | all other entries | Unbounded until `omp gc` or manual cleanup |

## Related

- [Session Logs](/oh-my-pi/reference/session-logs/)
- [Sessions](/oh-my-pi/features/sessions/)
- [Security Scanning](/oh-my-pi/features/security/)
- [Stats](/oh-my-pi/features/stats/)
