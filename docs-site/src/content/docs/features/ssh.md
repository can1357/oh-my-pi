---
title: SSH Remote Hosts
description: Register SSH hosts, share ControlMaster connections, and read, search, and write remote files over the ssh:// scheme.
coverage: B
---

omp can manage a list of SSH hosts and use them to read, search, and write remote files over the `ssh://` scheme. Every operation reuses a shared OpenSSH ControlMaster connection, so the first connection to a host pays the handshake cost and later operations ride the same socket.

Hosts live in JSON config files managed by `omp ssh` or the `/ssh` slash command, and are discovered from the same files by the agent's tools.

## Adding hosts

Add a host with the `omp ssh add` CLI command or the `/ssh add` slash command:

```bash
omp ssh add myhost --host 192.0.2.10 --user ubuntu --port 2222 --key ~/.ssh/id_ed25519
```

```text
/ssh add myhost --host 192.0.2.10 --user ubuntu --port 2222 --key ~/.ssh/id_ed25519
```

The host name is the first positional argument and `--host` is required. Host names may contain letters, numbers, dash, underscore, and dot, and are limited to 100 characters. Adding a name that already exists in the same scope fails.

| Flag | Meaning | Notes |
| --- | --- | --- |
| `--host <address>` | Host address or DNS name | Required |
| `--user <user>` | Username for the connection | |
| `--port <port>` | Port number | Must be an integer between 1 and 65535; omitted ports default to 22 |
| `--key <path>` | Identity key path | Must exist and be a regular file; on non-Windows systems permissions must be `600` or stricter |
| `--desc <text>` | Host description | CLI only; shown in `omp ssh list` and host listings |
| `--compat` | Enable compatibility mode | CLI only; stored on the host entry |
| `--scope <scope>` | Config scope: `project` or `user` | Defaults to `project` |

The slash command accepts `--host`, `--user`, `--port`, `--key`, and `--scope`, but not `--desc` or `--compat`. See [Slash Commands](/oh-my-pi/reference/slash-commands/) for the full `/ssh` surface.

## Listing and removing hosts

```bash
omp ssh list            # merge project and user hosts
omp ssh list --json     # machine-readable {project, user} output
omp ssh remove myhost
```

`omp ssh list` shows project hosts first, then user hosts, and prints `No SSH hosts configured` when both scopes are empty. `omp ssh remove <name>` defaults to the project scope; pass `--scope user` to remove from the user config. The `/ssh` slash command offers the same operations: `/ssh list`, `/ssh remove <name>` (alias: `/ssh rm`), and `/ssh help`. Removing a host also deletes its cached host metadata and closes its shared connection.

## Where hosts are stored

Hosts are stored as JSON in two scopes, matching other omp config:

```text
.omp/ssh.json          # project scope (per project)
~/.omp/agent/ssh.json  # user scope (per user)
```

The shape is `{ "hosts": { "<name>": { "host": ..., "username": ..., "port": ..., "keyPath": ..., "description": ..., "compat": ... } } }`. The files are written atomically with `600` permissions in a `700` directory, so editing them by hand is safe. Values in the config support environment-variable expansion, and `~` in a key path is expanded.

Host discovery also reads two legacy locations for compatibility: `ssh.json` and `.ssh.json` in the project root. When both scopes define the same host name, the project entry wins.

## Shared connections

omp starts a single OpenSSH master connection per host and multiplexes everything over it:

- `ControlMaster=auto` with a per-host socket at `~/.omp/ssh-control/%C.sock`
- `ControlPersist=3600`, so the master stays alive for an hour after the last operation
- `BatchMode=yes` (no interactive password prompts) and `StrictHostKeyChecking=accept-new`
- ControlMaster is disabled on Windows hosts

The master is started with `ssh -M -N -f` on first use, checked with `-O check`, and closed with `-O exit`. Setup and probe helpers time out after 30 seconds, and each file transfer has a 30-second per-operation timeout. All connections are closed when omp exits. As a defense against argument injection, host addresses and usernames may not begin with `-`.

## Host probing

The first time a host is used, omp connects and probes the remote to classify it:

- OS and login shell via `$OSTYPE`, `$SHELL`, and `$BASH_VERSION` (with a `%OS%`/`%COMSPEC%` fallback for Windows)
- A verified POSIX transfer shell by round-tripping a marker through `sh -lc`, `bash -lc`, then `zsh -lc` against the remote
- On Windows hosts, a compat shell (`bash` or `sh`) when the host entry has compatibility mode enabled

Results are cached in `~/.omp/remote-host/<name>.json` and re-probed when stale, so the remote is only classified once per host.

## Remote files over ssh://

Configured hosts are exposed to the agent's tools through the `ssh://` scheme — the same internal-URL mechanism as `skill://` and `memory://`, described in [Internal URLs](/oh-my-pi/guides/internal-urls/):

```text
ssh://myhost/etc/hosts            # read a remote file
ssh://myhost/home/ubuntu/         # one-level directory listing
ssh://                             # list configured hosts
ssh://user@192.0.2.20/tmp/x.txt   # unconfigured OpenSSH destination
```

- A remote path resolves to a UTF-8 text file or, for a directory, a one-level listing (`ls -1Ap`, directories first, then by name). Files are capped at 1 MiB; larger or binary/non-UTF-8 files are rejected with an explicit error.
- The authority may be a configured host name (percent-encoded aliases resolve too) or any destination OpenSSH itself can resolve, such as a `~/.ssh/config` alias with an explicit `user@`/`:port` override. Password authentication is not supported — only keys and the agent.
- Literal `:`, `?`, or `#` in a remote path must be percent-encoded (`%3A`, `%3F`, `%23`); query strings and fragments are rejected.
- Writes are byte-exact: content is staged into a temp file on the remote, then committed. An existing regular file is rewritten in place (preserving its permissions); a directory, symlink-to-directory, or special file is refused; a new path is committed with an atomic rename.
- `ssh://` requires a verified POSIX remote shell — hosts detected as Windows, or remotes where none of `sh`/`bash`/`zsh` round-tripped a probe, are refused for `ssh://` operations.
- The host segment of `ssh://` URLs is autocompleted from the configured hosts.

The agent uses these URLs with the read, search, and write tools. Read and search on an `ssh://` path are treated as execution and require approval. Search refuses remote directory listings — it would only grep the listing text, not the directory's real contents — and the glob tool rejects `ssh://` paths because remote trees have no local backing path. See [Tools](/oh-my-pi/features/tools/) for the tool surface.

## sshfs mounts

When the `sshfs` binary is available on PATH, remote trees can be mounted under `~/.omp/remote/<host-name>` (host names are sanitized for the mount path). Mounts use the same shared connection options — `reconnect`, `ServerAliveInterval=15`, `ServerAliveCountMax=3`, `BatchMode=yes`, ControlMaster reuse — plus the host's port and identity key. They are unmounted with `fusermount -u` (or `fusermount3 -u`, falling back to `umount`) and all mounts are cleaned up when omp exits. Because a hung remote mount must not stall tool calls, the read tool skips fuzzy path matching under the remote mount directory.

## Limits

| Limit | Value |
| --- | --- |
| Remote file size (`ssh://` reads) | 1 MiB; larger files need an sshfs mount |
| Encoding | UTF-8 text only; binary files are rejected |
| Remote shell | POSIX only (`sh`, `bash`, or `zsh` verified by probe); Windows hosts are refused for `ssh://` |
| Connection setup / probe timeout | 30 seconds |
| Per-transfer timeout | 30 seconds |
| Port range | 1–65535 |
| Host name | 1–100 characters, `[a-zA-Z0-9_.-]` only |
| ControlMaster | Disabled on Windows hosts; connection persists 3600 seconds after last use |

For the `omp ssh` command reference, see [CLI Reference](/oh-my-pi/reference/cli/).
