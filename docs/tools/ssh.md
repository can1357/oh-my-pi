# ssh

> Execute one remote command on a discovered SSH host.

## Source
- Entry: `packages/coding-agent/src/tools/ssh.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ssh.md`
- Key collaborators:
  - `packages/coding-agent/src/ssh/ssh-executor.ts` — runs `ssh`, captures output
  - `packages/coding-agent/src/ssh/connection-manager.ts` — master-connection reuse, host probing
  - `packages/coding-agent/src/ssh/sshfs-mount.ts` — optional `sshfs` mount side effect
  - `packages/coding-agent/src/discovery/ssh.ts` — discovers host configs
  - `packages/coding-agent/src/capability/ssh.ts` — canonical host shape
  - `packages/coding-agent/src/session/streaming-output.ts` — tail streaming, truncation, artifacts
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — timeout clamp rules
  - `packages/utils/src/dirs.ts` — user/project ssh config paths

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `host` | `string` | Yes | Host name key from discovered SSH config entries, not an arbitrary hostname/IP. |
| `command` | `string` | Yes | Remote command string passed to `ssh` as the remote command. |
| `cwd` | `string` | No | Remote working directory. The tool prepends a shell-specific `cd`/`Set-Location` wrapper. |
| `timeout` | `number` | No | Timeout in seconds. Default `60`; clamped to `1..3600`. |

## Outputs
The tool returns a standard text tool result built in `packages/coding-agent/src/tools/ssh.ts`:

- `content`: one text block containing combined remote stdout+stderr, or `"(no output)"` when empty.
- `details.meta.truncation`: present when output exceeded the in-memory tail window; derived from the executor summary.

Streaming behavior:

- While the command runs, `onUpdate` receives tail-only text snapshots built from `TailBuffer` in `packages/coding-agent/src/session/streaming-output.ts`.
- Final output is single-shot after process exit.

Side-channel artifacts:

- When session artifact allocation is available and output exceeds the spill threshold, full output is written to a session artifact file and the returned summary carries its `artifactId` internally.
- The ssh tool itself does not print the `artifact://...` URI into the result text.

Failure behavior:

- Unknown host, missing host config, timeout, cancellation, SSH startup failure, key validation failure, or non-zero remote exit all surface as thrown `ToolError`s.
- Non-zero remote exit includes captured output plus `Command exited with code N`.

## Flow
1. `loadSshTool()` in `packages/coding-agent/src/tools/ssh.ts` calls `loadCapability(sshCapability.id, { cwd: session.cwd })` to discover hosts.
2. `packages/coding-agent/src/discovery/ssh.ts` loads host entries from, in this order: project managed ssh config, user managed ssh config, `ssh.json` in the repo root, `.ssh.json` in the repo root.
3. `getSSHConfigPath("project")` and `getSSHConfigPath("user")` in `packages/utils/src/dirs.ts` resolve those managed files to `.ompk/ssh.json` in the project and `~/.ompk/agent/ssh.json` in the user config dir. This tool does not read `~/.ssh/config`.
4. Capability loading deduplicates by host name with first item winning; provider order is priority-sorted and the SSH JSON provider registers at priority `5`.
5. `loadHosts()` in `packages/coding-agent/src/tools/ssh.ts` builds `hostsByName` and drops later duplicates again with `if (!hostsByName.has(host.name))`.
6. Tool description text is built from `packages/coding-agent/src/prompts/tools/ssh.md` plus an `Available hosts:` list. Each host entry calls `getCachedHostInfoSync()` to show detected shell/OS when cached; otherwise it renders `detecting...`.
7. On execute, `SshTool.execute()` rejects any `host` not in the discovered host-name set.
8. `ensureHostInfo()` in `packages/coding-agent/src/ssh/connection-manager.ts` ensures an SSH master connection exists, loads cached host info from disk if present, and probes remote OS/shell when cache is missing or stale.
9. `buildRemoteCommand()` in `packages/coding-agent/src/tools/ssh.ts` prepends a cwd change when `cwd` is provided:
   - Unix-like or Windows compat shells: `cd -- '<cwd>' && <command>`
   - Windows PowerShell: `Set-Location -Path '<cwd>'; <command>`
   - Windows cmd: `cd /d "<cwd>" && <command>`
10. `clampTimeout("ssh", rawTimeout)` applies the `1..3600` second clamp from `packages/coding-agent/src/tools/tool-timeouts.ts`.
11. `executeSSH()` in `packages/coding-agent/src/ssh/ssh-executor.ts` calls `ensureConnection(host)` again, opportunistically mounts the remote host root with `sshfs` if available, optionally wraps the command in `bash -c` or `sh -c` for Windows compat mode, then spawns `ssh` with `ptree.spawn`.
12. Output from both stdout and stderr is piped into one `OutputSink`; chunks are sanitized and forwarded to streaming updates through `streamTailUpdates()`.
13. On normal exit, the sink returns combined output plus truncation counters. On timeout or abort, `executeSSH()` returns `cancelled: true` and prefixes the output with a notice line such as `[SSH: ...]` or `[Command aborted: ...]`.
14. `SshTool.execute()` converts `cancelled: true` into `ToolError`, converts non-zero exit codes into `ToolError`, otherwise returns the text result with truncation metadata.

## Modes / Variants
- **Tool unavailable**: `loadSshTool()` returns `null` when discovery finds no hosts, so the tool is not registered for that session.
- **Unix-like target**: remote command is passed through directly, with optional `cd -- ... &&` prefix.
- **Windows native shell**: cwd wrapper uses PowerShell `Set-Location` or cmd `cd /d`; command otherwise runs in the remote default Windows shell.
- **Windows compat shell**: if host probing finds `bash` or `sh` on Windows, `executeSSH()` wraps the remote command as `bash -c '...'` or `sh -c '...'`. Host config can force compat on/off with `compat`.
- **Cached vs probed host info**: shell/OS detection comes from in-memory cache, persisted JSON under the remote-host dir, or a fresh probe over SSH.
- **Truncated vs untruncated output**: small output stays in memory; large output keeps only the last 50 KiB in memory and may spill full output to an artifact file.

## Side Effects
- Filesystem
  - Reads managed SSH config JSON plus legacy `ssh.json` / `.ssh.json`.
  - Validates private-key path existence and permissions before connecting.
  - Persists probed host info as JSON under the remote-host cache dir via `persistHostInfo()`.
  - May create the SSH control socket dir and, when `sshfs` exists, remote mount dirs.
  - May write full command output to a session artifact file.
- Network
  - Opens SSH connections to the selected host.
  - May issue extra probe commands to detect OS/shell and compat shells.
- Subprocesses / native bindings
  - Requires `ssh` on `PATH`; spawns it for connection checks, master startup, probing, and command execution.
  - May call `sshfs`, `mountpoint`, `fusermount`/`fusermount3`, or `umount`.
  - Sanitizes streamed text with `@pk-nerdsaver-ai/pi-natives` text sanitization.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Uses session artifact allocation when available.
  - Registers postmortem cleanup hooks for SSH master connections and sshfs mounts.
  - Tool concurrency is `exclusive`, so the agent scheduler should not run multiple ssh tool calls concurrently.
- Background work / cancellation
  - Process spawn receives the tool `AbortSignal`.
  - Cancellation/timeout ends the running ssh process and returns a cancelled result that the tool turns into an error.

## Limits & Caps
- Timeout defaults/clamps: `default=60`, `min=1`, `max=3600` in `packages/coding-agent/src/tools/tool-timeouts.ts`.
- Output tail window: `DEFAULT_MAX_BYTES = 50 * 1024` in `packages/coding-agent/src/session/streaming-output.ts`.
- Output sink spill threshold defaults to the same `50 KiB`; once exceeded, only the tail remains in memory.
- SSH master reuse persistence: `ControlPersist=3600` in `packages/coding-agent/src/ssh/connection-manager.ts` and `packages/coding-agent/src/ssh/sshfs-mount.ts`.
- SSH host info schema version: `HOST_INFO_VERSION = 2` in `packages/coding-agent/src/ssh/connection-manager.ts`; stale cache entries are reprobed.
- Streaming tail buffer compacts after more than `10` pending chunks (`MAX_PENDING`) before trimming.

## Errors
- `Unknown SSH host: ... Available hosts: ...` when the model passes a host name not present in discovery.
- `SSH host not loaded: ...` if the discovered-name set and `hostsByName` map diverge.
- `ssh binary not found on PATH` when `ssh` is unavailable.
- `SSH key not found: ...`, `SSH key is not a file: ...`, or `SSH key permissions must be 600 or stricter: ...` from key validation.
- `Failed to start SSH master for <target>: <stderr>` when control-master startup fails.
- Non-zero remote command exit becomes `ToolError` with captured output and `Command exited with code N`.
- Timeout becomes a cancelled result with output notice `[SSH: <timeout message>]`, then `ToolError`.
- Abort becomes a cancelled result with output notice `[Command aborted: <message>]`, then `ToolError`.
- `sshfs` mount failures are logged and ignored in `executeSSH()`; they do not fail the tool call.
- Discovery parse problems do not fail tool loading; they become capability warnings. If all sources are empty/invalid, the tool simply does not load.

## Notes
- Host discovery is JSON-based only. The tool does not parse OpenSSH config files.
- Discovery expands environment variables recursively in the parsed JSON and expands `~` in `key`/`keyPath`.
- Host names are capability keys; the model must pass the config key, not the raw hostname.
- Commands run without a PTY. `executeSSH()` uses `ptree.spawn(..., { stdin: "pipe", stderr: "full" })` and does not request an interactive terminal.
- The tool exposes `cwd` but no `env`, `pty`, upload, download, or explicit file-transfer fields.
- Lower layers support an `artifactId` for full output and a `remotePath` mount target, but `SshTool.execute()` does not expose those knobs.
- Both stdout and stderr are merged into one output stream; ordering is whatever arrives through the two streams.
- `StrictHostKeyChecking=accept-new` and `BatchMode=yes` are always set for connection checks, master startup, and command runs.
- Connection reuse is keyed by discovered host name, not by raw target tuple alone.
- `closeAllConnections()` and sshfs unmount cleanup run through postmortem hooks, not per-call teardown.
