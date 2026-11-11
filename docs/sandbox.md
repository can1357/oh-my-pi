# OS Sandbox

The OS sandbox runs the commands the agent executes inside an operating-system container, built on Microsoft's [MXC](https://github.com/microsoft/mxc) (`mxc-sdk`, linked into the `pi_natives` addon). Contained processes can write only to the workspace, a private temp directory, and paths you grant; omp's credential store and common secret stores are unreadable; network access is off, unrestricted, or limited to a hostname allowlist enforced by an omp-run egress proxy.

It is off by default.

## What is contained

| Contained (when enabled)                                                                                                                       | Scope   |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| The `bash` tool: the embedded shell, its in-process builtins (`cat`, `rm`, `sed`, redirects, …), child processes, background (`async`) runs, and interactive PTY runs | `bash`  |
| Python eval kernels and JavaScript eval cells (contained JS eval runs in a separate process instead of an in-process worker), including commands a cell runs through `sh()` | `eval`  |
| Commands run through the `exec()` API of extensions, hooks, custom tools, and custom commands                                                    | `exec`  |
| MCP stdio servers whose config sets `sandbox: true` (see [MCP servers](#mcp-servers))                                                            | per server |

In-process file tools (`read`, `write`, `edit` including deletes and moves, `ast_edit`, `grep`, `glob`, `find`, `ast_grep`, the `lsp` tool's file and `rename_file` destination, an `ida` `.i64`/`.idb` opened in place, and the same tools called from an eval cell as `tool.write`, `tool.edit`, …) run inside omp, so the OS backend cannot contain them. While the sandbox is active, omp checks every local path such a call names against the same filesystem policy before the tool runs, in every approval mode. Workspace edits an LSP server sends (rename, code actions, `workspace/applyEdit`) are checked file by file before any is applied.

- A write (any call that modifies: write, edit, delete, move, `ast_edit`) must land under a writable root: the workspace, the private temp directory, `allowWrite`, or a `sandbox_request` write grant. In `read-only` mode only the temp directory.
- A read must lie under a readable root contained commands get for the current [read scope](#read-scope) (so `readScope: all` still excludes device and virtual trees, Linux `/tmp`, and anything outside the profile on Windows), or under a writable root, `allowRead` or a read grant, and must not touch a `denyRead` path. A recursive search rooted above a `denyRead` path is refused; name a narrower path.
- A refused call fails with a sandbox message that points the agent at `sandbox_request`; a granted request then covers the file tools as well as contained commands. A `denyRead` path cannot be requested.
- Internal URLs (`local://`, `skill://`, `artifact://`, …) are omp's own storage and are not checked.

The eval helpers that write directly (`write()` in Python, the JS prelude's `write`) run inside the eval kernel, so they are contained with it.

Not contained:

- LSP servers and `debug` launches. LSP server binaries resolve from the workspace's `node_modules/.bin` and `.venv/bin` first, and `debug` runs the program the agent names, so a contained command can plant a binary the parent then runs uncontained.
- The `ida` tool's IDA worker. It runs on the host: `ida` with `action: "exec"` runs the Python the agent writes there, with your user's full filesystem and network access, and the structured actions (rename, comment, set_type, make_function, save) write the database it opened. Only an `.i64`/`.idb` named by path is policy-checked (see above); a binary is read from wherever it is and its database lives in omp's store (`<agentDir>/idbs`). Turn `ida.enabled` off, or set `tools.approval.ida: prompt` (honored in every approval mode, yolo included), when the sandbox must bound everything the agent runs.
- The `ask` tool's form images: a local `<img src>` is read on the host to show it to you (it is not returned to the model).
- The browser, SSH, and host helpers omp runs itself (git/VCS operations, updates, clipboard).
- JS eval `%packages`: `bun add --ignore-scripts` runs in the parent (network access and writes to omp's package cache; no lifecycle scripts).
- URL paths in bash commands (`skill://`, `pr://`, `mcp://`, …): the parent resolves them. File-backed schemes return a host path the contained shell then opens under the sandbox policy; virtual and remote schemes are rendered by the parent with the same reach as the `read` tool.
- Your own commands: `!` / `!!`, `/loop` conditions, and the RPC `bash` command run unsandboxed in your shell.
- Processes an extension starts on its own (for example with `Bun.spawn`) instead of through `exec()`.
- MCP stdio servers without `sandbox: true`, and HTTP/SSE MCP servers.

While the sandbox applies to `bash`, a `bash` call with `name` (a managed service) is refused, since services run under the launch broker outside any sandbox; use `async: true` instead. A sandboxed command never runs in an ACP client's terminal.

Contained `bash` commands and eval cells can also write the session's `local://` directory (in `workspace-write` mode), so `local://` artifacts keep working.

Environment of contained commands:

- They receive omp's process environment without the variables omp loaded from its own `.env` files (the agent directory's, the config root's, and `~/.env`): API keys kept there stay out of the sandbox. Variables your shell exported, project `.env` variables, and values set for the child itself (an MCP server's `env`, a bash call's `env`) are passed.
- Contained bash commands do not load direnv/devenv environments (`.envrc`): the load would run files the contained agent can write, on the host, outside the sandbox.
- Contained bash shells (including PTY runs) do not inherit your `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` or `NO_PROXY`. In `allowlist` mode MXC points the proxy variables at omp's egress proxy, which cannot chain to an upstream proxy: on a network that requires a corporate HTTP proxy, `allowlist` mode cannot reach the internet.

While the sandbox applies, nothing that project-layer settings choose runs on the host for a contained call:

- The bash rc snapshot (your shell's aliases and functions, captured on the host) uses the shell from your own config layers; when a project config sets a different `shellPath`, contained shells run without a snapshot.
- The Python interpreter probe (which picks the interpreter, including a workspace `.venv`) runs contained, like the kernel.

## Enabling

- `/sandbox` opens the sandbox panel (interactive TUI only).
- `/sandbox on`, `/sandbox off`, `/sandbox status` are quick forms. `on`/`off` write `sandbox.enabled` to the global config and say so when another layer keeps the effective state different. `status` prints the state (`off`, `active (<backend>) · <mode> · network <mode> · applies to …`, or `unavailable — <reason>`), backend warnings, hosts blocked this session, and ignored project values.
- `/settings` → **Tools** → **Sandbox** lists every `sandbox.*` setting.
- `config.yml`:

```yaml
sandbox:
   enabled: true
   mode: workspace-write
   fallback: warn
   filesystem:
      readScope: all
      allowWrite: ["~/.cache"]
   network:
      mode: allowlist
      allowedHosts:
         - github.com
         - "*.github.com"
         - registry.npmjs.org
```

- `PI_SANDBOX=1` (any of `1`, `y`, `true`, `yes`, `on`, upper- or lower-case) turns it on for the process. Any other value is ignored; the variable can never turn the sandbox off.

The `/sandbox` panel and `/settings` write the global config only. Changes apply to the next contained command. A persistent bash shell or eval context started under an older filesystem or network-mode policy is replaced, so shell state such as `cd` and exported variables starts fresh after such a change. Allowlist changes, including host approvals, apply live and do not restart anything.

## Settings

| Key                             | Type                               | Default                                  | Meaning                                                                                                                                                                       |
| ------------------------------- | ---------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.enabled`               | boolean                            | `false`                                  | Run agent commands contained. `PI_SANDBOX` can only turn it on.                                                                                                               |
| `sandbox.mode`                  | `workspace-write` \| `read-only`   | `workspace-write`                        | What contained commands may write (see [Modes](#modes)).                                                                                                                      |
| `sandbox.scope`                 | array of `bash`, `eval`, `exec`    | `[bash, eval, exec]`                     | Which executors run contained. MCP servers opt in per server instead.                                                                                                        |
| `sandbox.fallback`              | `warn` \| `block`                  | `warn`                                   | What happens when the sandbox is enabled but this host has no usable backend (see [Unavailable backend](#unavailable-backend)).                                              |
| `sandbox.filesystem.readScope`  | `all` \| `workspace`               | `all`                                    | What contained commands may read (see [Read scope](#read-scope)). Denied paths stay unreadable either way.                                                                    |
| `sandbox.filesystem.allowWrite` | array of paths                     | `[]`                                     | Extra writable paths in `workspace-write` mode.                                                                                                                               |
| `sandbox.filesystem.allowRead`  | array of paths                     | `[]`                                     | Extra readable paths, in either read scope.                                                                                                                                   |
| `sandbox.filesystem.denyRead`   | array of paths                     | [secret stores](#default-denied-paths)   | Paths contained commands can neither read nor write; outranks every other list.                                                                                               |
| `sandbox.filesystem.windowsListDrives` | boolean                     | `false`                                  | Windows: let contained commands list directories and read file metadata on every drive holding a sandbox path; Node, npm and npx need it (see [Windows](#windows)).          |
| `sandbox.network.mode`          | `allowlist` \| `deny` \| `allow`   | `allowlist`                              | Network access of contained commands (see [Network](#network)).                                                                                                               |
| `sandbox.network.allowedHosts`  | array of host names                | [registries and forges](#default-allowed-hosts) | Hosts reachable in `allowlist` mode. `*.example.com` matches subdomains of `example.com`, not `example.com` itself; case and a trailing dot are ignored.            |
| `sandbox.network.windowsLoopback` | boolean                          | `false`                                  | Windows: let contained commands connect to `127.0.0.1` in `allowlist` and `deny` modes, their own sockets and every service on this machine's loopback; the Python eval kernel needs it (see [Windows](#windows)). |

### Path entries

Path lists accept:

| Form           | Expands to                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `~`, `~/…`     | Your home directory                                                                              |
| `${home}`      | Your home directory                                                                              |
| `${workspace}` | The session's workspace (project directory)                                                      |
| `${tmp}`       | The sandbox's private temp directory (what contained processes see as `TMPDIR`)                  |
| `${authDb}`    | omp's credential database (`agent.db` in the agent directory, XDG-aware)                         |
| `${agentDir}`  | omp's agent directory (normally `~/.omp/agent`)                                                  |
| relative path  | Resolved against the workspace                                                                   |

Any other `${…}` token is rejected when the setting is written, so a typo such as `${HOME}` fails instead of matching nothing. Paths are resolved through symlinks before they reach the backend (on macOS `/tmp` becomes `/private/tmp`). Entries that do not exist when a process starts are dropped from its policy, and so are readable or writable entries you cannot access yourself (for example `/root`; bubblewrap would refuse the whole request).

### Default denied paths

`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.config/gh`, `${authDb}`, `${authDb}-wal`, `${authDb}-shm`, `${agentDir}/.env`, `${agentDir}/models.yml`, `${agentDir}/mcp.json`, `${agentDir}/.mcp.json`.

Setting `sandbox.filesystem.denyRead` replaces this list; include the defaults you want to keep.

### Default allowed hosts

`github.com`, `*.github.com`, `*.githubusercontent.com`, `gitlab.com`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `crates.io`, `*.crates.io`, `proxy.golang.org`, `sum.golang.org`.

## Modes

| Mode              | Writable                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `workspace-write` | The workspace, the private temp directory, `allowWrite`, and the git metadata commits write to when it lies outside the workspace: in a linked worktree, the worktree's own `worktrees/<name>` and the common dir's `objects`, `refs`, `logs` and `reftable` (its `hooks/`, `config` and other worktrees stay read-only, so git operations that rewrite `packed-refs` or `config`, such as `branch -d` of a packed branch, `fetch --prune` or `push -u`, fail contained); the enclosing repository's `.git` when omp starts in a subdirectory of an ordinary checkout |
| `read-only`       | The private temp directory only                                                              |

Each sandbox runtime gets its own private temp directory, exposed to contained processes as `TMPDIR`, `TMP` and `TEMP`. The system temp directory is not writable for them: it holds files omp later runs on the host and other programs' control sockets (editor, tmux, ssh-agent).

Everything else readable is read-only. `denyRead` entries are neither readable nor writable.

Writable roots are pinned to the real path they first resolved to: the workspace, session grants, and `allowWrite` entries. A root later replaced by a symlink is not followed: a session grant is dropped, an `allowWrite` entry is skipped with a warning, and a replaced workspace makes contained commands fail. A session-granted directory that is merely deleted (a `cargo clean`, an `rm -rf build`) keeps its grant and is recreated empty for the next contained command.

## Read scope

| `readScope` | Readable                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `all`       | macOS/Linux: every top-level directory except device and virtual trees (`/dev` on macOS, plus hidden root entries; `/dev`, `/proc`, `/sys`, `/run` on Linux, which the backend mounts as needed) and, on Linux, the host's `/tmp` (contained processes see an empty private one). Windows: the tool, profile and temp directories MXC discovers, plus your user profile. |
| `workspace` | The workspace, the tool directories MXC discovers from `PATH`, and omp's own runtime files                                                                                                 |

In both scopes the workspace, `allowRead`, and the files omp needs to start inside the sandbox (its executable's directory, the native addon, the source checkout when run from source) stay readable. MXC's backends add their own baseline on top (on macOS: `/bin`, `/usr`, `/System`, `/Library`, `/private/etc` and device nodes).

## Build tools and caches

Execution is not restricted: a contained command can run any readable program (`cargo`, `git`, `node`, compilers under `/usr`, Homebrew, `~/.cargo/bin`). What fails is a write outside the writable roots, so tools that populate a cache in your home directory need that cache granted:

```yaml
sandbox:
  filesystem:
    allowWrite: ["~/.cargo/registry", "~/.cargo/git", "~/.npm", "~/.bun/install/cache"]
```

- Builds and installs that stay inside the workspace (`target/`, `node_modules/`, `.venv/`) need nothing; `cargo build` works with already-downloaded dependencies.
- A writable cache can be tampered with by a contained command and is later used by uncontained builds; grant caches deliberately, never a directory of executables such as `~/.cargo/bin`.
- With `readScope: workspace`, add the tool's own files to `allowRead` when they are not on `PATH` (for Rust: `~/.rustup`, `~/.cargo`).
- The agent can also ask for a cache directory it needs with [`sandbox_request`](#access-requests); you decide per request.

## Network

| `network.mode` | Behaviour                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `allowlist`    | Only `allowedHosts` (plus hosts you approve), through omp's egress proxy                                           |
| `deny`         | No network                                                                                                        |
| `allow`        | Unrestricted network (on Linux, not the host's loopback; see [Per-OS behaviour](#per-os-behaviour))               |

### How the allowlist works

- On the first contained `allowlist` spawn, omp starts an HTTP proxy on `127.0.0.1` (a random port) inside the omp process. It handles `CONNECT host:port` tunnels and absolute-URI `http://` requests and checks each destination name against the allowlist.
- The backend confines the contained process's egress to that loopback port in the kernel: a process cannot bypass the proxy by connecting elsewhere.
- Proxy use is cooperative: MXC sets `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `FTP_PROXY` (and their lower-case forms) to the proxy URL and removes any `NO_PROXY`. Tools that honour these variables (curl, git over HTTPS, npm, pip, cargo, Go, …) work; tools that ignore them get no network at all rather than filtered network.
- A refused request gets HTTP `403` with `X-Omp-Sandbox: blocked`; the host is recorded as blocked for this session.
- The proxy resolves the name itself and connects to the address it checked:
  - an exact (non-wildcard) entry may resolve to any address, including private and loopback ones;
  - a name matched only by a wildcard must resolve to public addresses;
  - IP literals, `localhost` and `*.localhost` are allowed only when listed verbatim; wildcards and prompts never reach them.

### Approving hosts

In the interactive TUI, a connection to a host that is not on the list asks: allow **once** (this connection), **for this session**, or **always** (appended to the global `sandbox.network.allowedHosts`). Dismissing the prompt refuses the connection.

| Grant | Addresses the host may resolve to |
| --- | --- |
| **once**, **for this session** | Public and private ranges (intranet services); never loopback, link-local or unspecified addresses, on every connection |
| `allowedHosts` entry, including **always** answers and the panel's **Allow** | Any address (exact entry, no restriction) |

Approving a host does not restart shells or kernels: the proxy reads the allowlist and session grants live. A running process only ever narrows, though: it reaches a listed host only while the list still has it and it was listed when the process started, or you added it to your own list since. A host that a project switch (`/move`, a resumed session in another directory) puts back on the effective list is not reachable from processes started before the switch.

Without an approver unknown hosts are refused: print mode and subagents without a UI never ask. An RPC client can opt in to answering host requests (`set_sandbox_host_prompts`, then `sandbox_host_request` / `respond_sandbox_host`; an unanswered request is denied after 2 minutes). The RPC interface also reads and edits the sandbox (`get_sandbox`, `set_sandbox_setting`, `reset_sandbox_setting`, `edit_sandbox_list`, `grant_sandbox_host`, `revoke_sandbox_host`) and pushes `sandbox_update` on every change; see [RPC: Sandbox](./rpc.md#sandbox).

The `/sandbox` panel's **Network** page lists **Blocked this session** with an **Allow** action, which adds the host to the global allowlist (an exact, unrestricted entry, like answering **always**).

## Access requests

When a contained command needs a path or host it does not have, the agent asks with the `sandbox_request` tool instead of failing or working around the denial. The tool exists only while `sandbox.enabled` is on. The agent can never grant itself anything: only your answer in the dialog does. Typical case: a build redirected outside the workspace (`CARGO_TARGET_DIR=/Volumes/fast/target cargo build`).

A request names one target: a path to **write** (create, change and delete files under it), a path to **read**, or a **host** to connect to (exact hostname, no wildcard, scheme or port). Paths are resolved (`~` expanded, relative to the session cwd, symlinks followed) before you see them.

The dialog (`Sandbox request: write to <target>`, `read <target>`, or `connect to <host>`) shows:

| Field | Content |
| --- | --- |
| Intent | What the agent is doing and why it needs this exact target, in its words |
| Command | The command that needs the access, when given |
| Effect | omp's own statement of the consequence, e.g. "Contained commands will be able to create, change and delete files under /Volumes/fast/target." |
| If denied | What the agent says it will do instead, when given |

Actions:

- **Allow for this session**: exactly the requested path or host, not saved. Path grants are listed under `/sandbox` → **Filesystem** → **Allowed this session**, where you can remove them. A write path that does not exist yet is created as an empty directory.
- **Always allow (saved to global config)**: appends the target to `sandbox.filesystem.allowWrite`, `allowRead` or `network.allowedHosts`. Not offered when that list comes from another layer (environment, a session override, a `--config` file, or project config), since a global write would be shadowed.
- **Deny** (also Esc): nothing is granted; the agent is told not to retry or work around it.
- **Reply with instructions…**: nothing is granted; your text goes back to the agent.

The dialog appears in every approval mode, `yolo` included. A granted path changes the policy, so the sandboxed shell and eval kernels restart on their next call (`cd` and exported variables reset); a granted host applies live.

Removing a session grant takes effect on the next sandboxed call, which restarts the shell and kernels. A command still running, background jobs of a shell no later call replaces, and opted-in MCP servers keep the policy they started with.

Host requests follow `sandbox.network.mode`: with `deny` they are refused (only you can change the mode); with `allow` every host is already reachable.

Refused without asking (the agent gets the reason):

- a filesystem root, or a path at or under a `denyRead` entry;
- a write while `sandbox.mode` is `read-only`, or a host while `network.mode` is `deny`;
- a target that is already allowed (reported as already allowed, no dialog);
- the sandbox off or unavailable, an empty intent, or a target with control characters;
- no one to ask: print mode, subagents running on worker threads, or an RPC client that has not opted in with `set_sandbox_access_prompts` (see [RPC: Access requests](./rpc.md#access-requests)). Subagents running on the main thread share the dialog: their requests are shown to you.

One request is shown at a time; identical concurrent requests share one dialog. Session grants (paths and hosts) belong to the omp process, not to a workspace or session: every session and subagent shares them. Subagents on worker threads follow the grants and revocations you make, but cannot ask for access themselves.

## Project config may only tighten

A cloned repository's `.omp/config.yml` (and a repository `.env`) must not be able to weaken containment. Every `sandbox.*` value is compared with what your own layers (global config, `--config` overlays, environment) produce, and the project layer is honoured only where it is at least as strict:

| Setting                                         | The project may                                                  | Ignored                         |
| ----------------------------------------------- | ---------------------------------------------------------------- | ------------------------------- |
| `enabled`                                       | turn it on                                                       | turning it off                  |
| `mode`                                          | set `read-only`                                                  | `workspace-write` over your `read-only` |
| `fallback`                                      | set `block`                                                      | `warn` over your `block`        |
| `filesystem.readScope`                          | set `workspace`                                                  | `all` over your `workspace`     |
| `filesystem.windowsListDrives`, `network.windowsLoopback` | set `false`                                  | `true` over your `false`        |
| `network.mode`                                  | move toward `deny` (`allow` → `allowlist` → `deny`)              | anything looser                 |
| `filesystem.denyRead`, `scope`                  | add entries                                                      | removing entries                |
| `filesystem.allowWrite`, `allowRead`, `network.allowedHosts` | drop entries                                        | adding entries                  |

A project `null` cannot reset a value to its default either. `PI_SANDBOX` can only enable, so a repository `.env` cannot disable the sandbox through it.

Ignored values are reported by `/sandbox status` (`Ignored project value <id>: <reason>`) and on the panel's **Overview** page under **Ignored project values**. In `/settings`, the `enabled`, `mode`, `fallback`, `readScope`, `windowsListDrives`, `network.mode` and `windowsLoopback` rows show the effective value, so an ignored project value never shows as set. `/settings` hides the list editors for `scope`, `allowWrite`, `allowRead`, `denyRead` and `allowedHosts` while the project layer sets them, so a project list is never promoted to your global config.

While the sandbox is enabled, omp's global settings files are protected from the in-process file tools: `config.yml` / `config.yaml` and `.env` in the agent directory, and `.env` in omp's config root (normally `~/.omp/.env`) are treated like `tools.restrictedFolders` entries. Every `read`, `write`, `edit` or search call that targets them asks Approve/Deny in every approval mode (see [approval mode](./approval-mode.md#restricted-folders)) and is refused without a UI. Contained commands cannot write them anyway.

Agent writes to `cfg://sandbox.*` settings always ask while the sandbox is enabled, in every approval mode; a "for this session" answer to another `cfg://` write does not cover them, and without a UI they are refused.

## Per-OS behaviour

| | macOS | Linux | Windows |
|---|---|---|---|
| Backend | seatbelt | bubblewrap | processcontainer |
| Requires | macOS 15 or newer | A working `bwrap` (MXC requires 0.5.0 or newer) and usable unprivileged user namespaces, checked by actually starting a probe sandbox (Ubuntu 24.04's AppArmor restriction or a container's seccomp profile can block them) | The native processcontainer tier: Windows 11 24H2, build 26100.9278 / 26200.9278 or newer. Older builds report the sandbox as unavailable; omp does not use MXC's AppContainer fallback, which would rewrite ACLs of host directories |
| `allowlist` | Proxy, kernel-confined | Needs the host networking tools MXC uses for proxy confinement (`slirp4netns`, `unshare`, `nsenter`, `ip`, `iptables`/`iptables-restore`); without them network is **denied** | Proxy, confined to loopback by the OS when the backend tier supports an identity-less loopback proxy; otherwise network is **denied** |
| `allow` | Unrestricted | Needs the same networking tools, otherwise **denied**; never reaches the host's loopback (private network namespace) | Unrestricted |
| Verification | Exercised on this platform | Exercised on Ubuntu 24.04 under WSL2 (bwrap 0.9.0, slirp4netns 1.2.1, iptables 1.8.10): smoke probe, contained bash, JS/Python eval, MCP, access grants, `allowlist` through the proxy | Exercised on Windows 11 build 26100 (smoke probe, contained bash, JS eval, Node, git) |

When a configured network mode cannot be enforced, the sandbox runs with `deny` (stricter), and `/sandbox status` and the panel show a warning. The requirement rows come from MXC's documentation; omp reports MXC's own reason string when a backend is missing.

`omp --smoke-test` includes a sandbox probe: where a backend is available it starts the sandbox host contained, runs `echo`, and checks that a write outside the workspace fails; where none is available it prints the reason and passes. On a CI runner without a usable backend the probe therefore only confirms that omp starts and reports the reason.

### Windows

The processcontainer backend starts every contained process with Windows' **Mandatory ASLR** mitigation (`ForceRelocateImages`), which Windows applies to the container itself. Neither MXC nor omp can turn it off. Consequences:

- **Some programs cannot start contained.** A program whose runtime needs a fixed load address fails before it runs any code, with exit code `0xC0000142` (`STATUS_DLL_INIT_FAILED`, `-1073741502` in a shell's `$?`). This includes Git Bash and every MSYS2 or Cygwin program: `bash.exe`, `sh.exe` and everything else in Git for Windows' `usr\bin` (`ssh`, `gpg`, `perl`, `vim`, `less`, `awk`, …).
- **Git works, but not the parts of git that call those programs:**
  - Hooks (`pre-commit`, husky, …) run under Git's `sh.exe`, so a commit in a repository with hooks fails contained.
  - Signed commits (`gpg`) and git's default editor (`vim`) fail. Use `git commit -m` or point `core.editor` at a native editor.
  - SSH remotes go through Windows OpenSSH, which starts contained: when `%SystemRoot%\System32\OpenSSH\ssh.exe` exists (the OpenSSH Client optional feature), contained processes get `GIT_SSH` set to it unless `GIT_SSH` is already set; `GIT_SSH_COMMAND` and `core.sshCommand` still take precedence. The network mode must allow the host; SSH does not work in `allowlist` mode. The default `denyRead` hides `~/.ssh`, so `known_hosts`, `config` and keys are unreadable and host-key verification fails: grant what SSH needs (or drop `~/.ssh` from `denyRead`) to use SSH remotes contained.
- **What works:** native Windows programs (`git.exe`, `cmd`, PowerShell, Windows OpenSSH, Bun), and the `bash` tool's built-in commands (`ls`, `sed`, `grep`, `find`, `sort`, …), which run inside omp's own shell instead of Git's.
- **Node needs drive listing (opt-in).** Windows grants a contained process nothing on a drive root no policy path names, so `lstat("C:\")` fails, and with it Node, which resolves every script path from the drive root (`node app.js`, npm, npx and the tools built on them). `sandbox.filesystem.windowsListDrives: true` grants PSEC `enumeratePaths` on the volume roots (`C:\`, `\\server\share\`) of the policy's paths, where the native tier supports it. PSEC applies that grant to the whole volume: contained processes can then list every directory and read every entry's metadata (names, sizes, times) on those drives, including paths the policy does not name, though no file contents. Off by default for that reason; a project config cannot turn it on.
- **Bun cannot open directories under read-only roots.** Under a read-only grant, the container's filesystem filter (`bfs.sys`) admits a directory open (`FILE_DIRECTORY_FILE`) only for `FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE`; a request that adds `FILE_READ_EA` or `FILE_TRAVERSE` is denied, though both are allowed on the same path when the open does not say it is a directory. Bun opens every directory with both rights, so its `readdir`, `opendir` and module resolver fail there with `EPERM`. Native tools (`cmd`'s `dir`, PowerShell, Node) request only `FILE_LIST_DIRECTORY | SYNCHRONIZE` and list them; `Bun.Glob`, `stat` and `realpath` work. Writable roots such as the workspace are unaffected. The same filter rule makes changing directory into a read-only directory (`SetCurrentDirectoryW`, which opens with `FILE_TRAVERSE`) fail. The policy cannot express access rights, so omp cannot work around it. Reported upstream: [microsoft/mxc#1467](https://github.com/microsoft/mxc/issues/1467) (Microsoft plans a Windows update that allows `FILE_TRAVERSE`; `FILE_READ_EA` is raised in [this comment](https://github.com/microsoft/mxc/issues/1467#issuecomment-6796133392)) and [oven-sh/bun#48581](https://github.com/oven-sh/bun/issues/48581) (Bun requesting neither right fixes it without a Windows update).
- **Running omp from a source checkout:** contained commands fail to start (`Module not found …\cli.ts`, `Cannot read directory …: EPERM`) unless the workspace is the checkout itself, because Bun cannot open the read-only source directories (previous item). MXC's `enumeratePaths` does not help: a path that is both read-only and enumerable becomes list-only, and its files stop being readable. The standalone binary is unaffected; a bun package install (`--source`) was not tested and may hit the same limit. The contained tests under `packages/coding-agent/test/sandbox/` that re-enter omp's sources are therefore skipped on Windows (`CONTAINED_SOURCE_RUNS` in `test/helpers/sandbox-test-state.ts`) until one of the upstream fixes lands.
- **Loopback is closed in `deny` and `allowlist` modes (opt-in).** The container blocks loopback connections there, a process's connection to itself included, so `socket.socketpair()` and with it Python's asyncio hang. The Python eval kernel needs loopback too (its tool bridge is a TCP socket on the host's loopback), so in those modes it refuses to start at once, with an error naming the setting, instead of timing out. `sandbox.network.windowsLoopback: true` opens loopback (`127.0.0.0/8`, `::1`) where the native tier supports host loopback: contained processes can then connect to their own listeners and to every service on this machine's `127.0.0.1` (development servers, databases, container engine APIs, browser debugging ports, local proxies that reach the internet), whatever the allowlist says. In `allowlist` mode that replaces the backend's native proxy confinement with an egress rule: egress stays denied except to loopback, and omp sets `HTTP_PROXY` and `HTTPS_PROXY` to its proxy (and clears `NO_PROXY` and `ALL_PROXY`), so tools that honour them are filtered as before and programs that only use the WinHTTP system proxy get no network. Off by default for that reason; a project config cannot turn it on. In `allow` mode loopback is open whenever the native tier supports it.
- **Interactive PTY runs** start their command through the configured shell (`<shell> -lc`, plain `sh` when none is configured), which on Windows is usually Git Bash (MSYS), so they fail contained.
- **UI access:** contained processes may make Win32k calls (without them every program that loads `user32.dll`, including `git` and PowerShell, fails to start), but they cannot read or write the clipboard or inject keyboard and mouse input.

When a contained `bash` command fails with `0xC0000142`, the result carries a notice telling the agent the program cannot start in the sandbox and not to retry it. `/sandbox on`, `/sandbox status` and the panel's Overview page show the limitation as a warning. To run such a command anyway, run it yourself with `!` (your own commands run unsandboxed) or turn the sandbox off with `/sandbox off`.

Upstream work that would lift this: MSYS2 building its runtime and packages relocatable ([msys2-runtime#381](https://github.com/msys2/msys2-runtime/pull/381), [MSYS2-packages#6789](https://github.com/msys2/MSYS2-packages/pull/6789)); even then the MSYS runtime must create its shared named objects inside the container's object namespace ([microsoft/mxc#1061](https://github.com/microsoft/mxc/issues/1061)).

### Unavailable backend

When the sandbox is enabled but no backend can contain processes on this host:

- `fallback: warn` (default): one warning (a startup notification in the TUI, a log warning otherwise), and commands run **unsandboxed**.
- `fallback: block`: every call that should run contained fails with the reason, until a backend is available or you run `/sandbox off`.

## What the agent sees

- While the sandbox is active, the system prompt gains a block naming what runs contained, the backend, the writable and unreadable paths, and the network mode. It tells the model that denials are expected and never to retry or work around them; when `sandbox_request` is available, to ask with it (narrowest target, clear intent), otherwise to tell you the path or host it needs.
- When a contained `bash` result looks like a filesystem denial (a non-zero exit with `Operation not permitted`, `Permission denied`, `Read-only file system`, `EPERM`, `EACCES` or `EROFS` in the output), the proxy refused a host during the call, or (on Windows) a program failed to start with `0xC0000142`, a sandbox notice is appended to the result. The denial and host notices point at `sandbox_request` when it is available; the `0xC0000142` notice tells the agent to use an equivalent that runs contained or to hand the command to you.
- A `sandbox_request` call shows as a tool card with the kind, target and intent, and, once answered, the decision (with your instructions or the refusal reason).
- Contained `bash` and eval results carry a `sandboxed` badge on their tool card (its tooltip names backend, mode and network), plus a warning note: `blocked by sandbox: host …`, `possible sandbox denial`, or `cannot start in the Windows sandbox (0xC0000142)`. A `bash` card shows the badge from the moment the command starts; an eval card when the cell finishes.

Contained processes see `OMP_SANDBOX=1` in their environment.

## The `/sandbox` panel

Four pages:

- **Overview**: status line (Active · backend / Unavailable · reason / Off), **Enabled**, **Mode**, **Applies to**, **If unavailable**, backend warnings, ignored project values.
- **Filesystem**: **Read scope**, the **Writable**, **Readable** and **Denied** lists, one editable row per entry with an **Add** action, and **Allowed this session** (paths granted through access requests, each with a remove action).
- **Network**: **Mode**, the allowed hosts, and **Blocked this session** with **Allow**.
- **Effective policy**: the resolved writable, readable and denied paths for the current workspace (read-only).

In Tern the panel renders as a native preferences sheet docked beside the transcript, like `/settings`; in a plain terminal it is the same content as a fullscreen ANSI panel. Rows another layer decides are locked and show the reason: `Set by $PI_SANDBOX`, `Set by a session override`, `Set by the --config file`, or `Tightened by project config`. Edits there would be shadowed, so they are refused (RPC refuses them with `sandbox_locked`).

## MCP servers

MCP stdio servers opt in per server with `sandbox: true` and choose their network with `sandboxNetwork` (`allow` by default, independent of `sandbox.network.mode`); see [MCP configuration](./mcp-config.md#stdio-transport). An opted-in server runs contained only while `sandbox.enabled` is on; `sandbox.scope` does not apply to it.

Containment is decided when a server connects. After toggling the sandbox or changing its policy, an already-running server keeps its state until `/mcp reconnect <name>`. The project-may-only-tighten rule does not cover MCP: a server defined in a project's MCP config runs uncontained unless it sets `sandbox: true` itself. On Windows, a `sandbox: true` server whose command launches through `cmd.exe` (a `.cmd`/`.bat` shim such as a bare `npx`, or a command not found on `PATH`) is refused; point `command` at `node` or `bun` and pass the script.

## Telemetry

MXC can emit telemetry, on Windows only, as ETW events. omp turns it off at both ends: `mxc-sdk` is built without a Microsoft telemetry route (`MXC_TELEMETRY_COMPONENT_PATH` empty in `.cargo/config.toml`, mirrored for Bazel in `MODULE.bazel`; `mxc-sdk` 1.0.1 routes only when built with `MXC_TELEMETRY_PROVIDER_GROUP_GUID`), and every contained process is spawned with MXC telemetry explicitly disabled, so the ETW provider is never registered. omp sends no sandbox telemetry anywhere.

## Known limits

- **Proxy use is cooperative.** Tools that ignore `HTTP_PROXY`/`HTTPS_PROXY` get no network in `allowlist` mode. SSH (including `git` over `ssh://`) does not work in `allowlist` mode.
- **The proxy has no authentication.** While it runs, any local process on the machine can use it to reach allowed hosts.
- **No TLS interception.** The proxy sees only the name on the `CONNECT` line; an allowed name on shared hosting or a CDN can front for other tenants.
- **Listed and approved names can point at private addresses.** An exact `allowedHosts` entry may resolve to any address, loopback included; a host approved once or for the session may resolve to private ranges. A name whose DNS an attacker controls could therefore be re-pointed at internal or host-local services (DNS rebinding). Answering **always** at the prompt (or **Allow** in the panel) is a persistent, unrestricted grant: give it only to names you trust.
- **Worker-thread subagents cannot ask.** They follow your session grants and their refused hosts appear under **Blocked this session**, but a host or path nobody granted is refused there without a prompt.
- **Blocked hosts are attributed by time.** A refusal is reported on whichever contained results were running when it happened, so concurrent jobs can show each other's blocked hosts.
- **Filesystem denials are reported heuristically and after the fact.** There is no live "allow this path?" prompt; the kernel answers synchronously. The denial notice is a match on the output of a failed command and can miss or misattribute.
- **The workspace is a trust root.** It is writable, so files a contained command writes there take effect uncontained later: project extensions, hooks, custom tools and commands (loaded into omp at the next start), `.mcp.json` / `.omp/mcp.json` server commands, and `.git/hooks` (run by git on the host). Review the workspace diff, including `.omp/`, `.mcp.json`, `.env` and git hooks, before restarting omp or running project tooling outside the sandbox. A project `.env` cannot set `PI_CONFIG_FILES` (omp ignores it there), so it cannot load a config overlay that turns the sandbox off.
- **`.git/config` is writable** too in `workspace-write` mode, as part of the workspace.
- **A repository rooted at your home directory (or above it) never gets its `.git` granted.** A session started in a subdirectory of such a repository (a dotfiles repository at `~`) cannot `git add`/`commit` contained; add that `.git` to `sandbox.filesystem.allowWrite` if you want it.
- **Denied paths that do not exist when a process starts are not protected** for that process.
- **Pinned roots leave a short window.** omp checks that a writable root is still the directory it pinned just before starting a contained process; a swap between that check and the backend applying the policy is not caught.
- **In-process file tools are policy-checked, not OS-contained** (see [What is contained](#what-is-contained)): omp checks the paths a call names before it runs, resolving symlinks at that moment; a symlink swapped in between the check and the write is not caught, and a path a tool reaches without naming it (an edit's auto-repair, an extension's own file access) is not checked.
- **Exported secrets still reach contained processes.** Only variables from omp's own `.env` files are withheld. An API key exported by your shell or its rc files is in the contained environment, and with allowlisted hosts that remains a way to send it out. A variable from omp's `.env` can also reach contained bash when a function in your shell rc references it, unless its name looks like a secret (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`, `*PRIVATE_KEY*`, `*ACCESS_KEY*`, `*CREDENTIAL*`, `*SESSION_KEY*`).
- **Linux: the environment is visible on the host.** bubblewrap receives the environment as arguments of the host-side `bwrap` process, so other local users can read it (API keys included) from `/proc/<pid>/cmdline` while a contained process runs.
- **Linux: no host loopback.** Contained processes cannot reach services on the host's `127.0.0.1`, even in `allow` mode.
- **Linux: a contained command cannot remove a granted directory itself.** Write grants are bind mounts, so `rm -rf` of one empties it but fails on the directory with `Read-only file system`.
- **Contained JS eval and stdin.** Child processes a JS eval cell starts inherit the evaluator's protocol stdin; a child that reads stdin can stall the cell.
- **Windows: the Python eval kernel needs loopback**: in `deny` and `allowlist` modes it refuses to start unless `sandbox.network.windowsLoopback` is on, which also exposes this machine's loopback services; see [Windows](#windows).
- **Windows: programs that cannot run under Mandatory ASLR fail to start**, Git Bash, MSYS2/Cygwin tools and git hooks included; see [Windows](#windows).
- **The `sandboxed` badge of an eval cell appears when it finishes**, not while it runs.
- **PTY on macOS:** a contained PTY works, but `tty` prints `not a tty`; programs that only check `isatty()` are unaffected.
- **Linux** was exercised on Ubuntu 24.04 under WSL2 (smoke probe and the sandbox, eval and MCP test suites) and is covered by the CI smoke probe. Windows was exercised on Windows 11 build 26100 (smoke probe, contained `bash`, JS eval and git); the rest of the runtime behaviour described here was exercised on macOS.

## Implementation files

- `packages/coding-agent/src/sandbox/settings.ts` -- `sandbox.*` settings, defaults, path tokens
- `packages/coding-agent/src/sandbox/policy.ts` -- effective config (project-may-only-tighten rule), filesystem policy, host matching
- `packages/coding-agent/src/sandbox/platform.ts` -- per-OS read roots and omp runtime paths
- `packages/coding-agent/src/sandbox/runtime.ts` -- per-workspace runtime: availability, fallback, network degradation, host grants, contained spawns
- `packages/coding-agent/src/sandbox/egress-proxy.ts` -- allowlist egress proxy
- `packages/coding-agent/src/sandbox/host.ts`, `host-protocol.ts`, `shell-client.ts` -- in-sandbox shell/PTY host, its client, the smoke probe
- `packages/coding-agent/src/sandbox/process.ts` -- adapter from the native process to a Bun-like child
- `packages/coding-agent/src/exec/bash-executor.ts`, `tools/bash.ts`, `tools/bash-interactive.ts` -- bash integration
- `packages/coding-agent/src/eval/py/kernel.ts`, `eval/js/context-manager.ts`, `eval/shell-bridge.ts` -- contained eval and its `sh()`
- `packages/coding-agent/src/exec/exec.ts` -- contained extension/hook/custom-tool `exec()`
- `packages/coding-agent/src/mcp/transports/stdio.ts` -- contained MCP stdio servers
- `packages/coding-agent/src/slash-commands/builtin-collaboration.ts` -- `/sandbox`
- `packages/coding-agent/src/modes/sandbox-panel.ts` -- `/sandbox` panel data, lock reasons, writes
- `packages/coding-agent/src/modes/rpc/rpc-sandbox.ts` -- RPC sandbox commands, host and access requests
- `packages/coding-agent/src/tools/sandbox-request.ts` -- `sandbox_request` tool
- `packages/coding-agent/src/tools/approval.ts` -- protection of omp's settings files while the sandbox is enabled
- `packages/coding-agent/src/prompts/system/sandbox.md`, `prompts/tools/sandbox-denial.md`, `prompts/tools/sandbox-request.md`, `prompts/tools/sandbox-request-result.md` -- model-facing text
- `packages/tui/src/overlays/sandbox-config.ts` -- `/sandbox` panel (ANSI and Tern)
- `packages/tui/src/tools/sandbox-meta.ts` -- `sandboxed` badge and notes on tool cards
- `packages/tui/src/overlays/sandbox-access-dialog.ts`, `tools/sandbox-request.ts` -- access-request dialog and tool card
- `crates/pi-natives/src/sandbox.rs` -- MXC binding (`sandboxSupport`, `sandboxDiscoverPaths`, `SandboxProcess`); see the [natives changelog](../packages/natives/CHANGELOG.md)
