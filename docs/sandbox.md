# OS Sandbox

The OS sandbox runs the commands the agent executes inside an operating-system container, built on Microsoft's [MXC](https://github.com/microsoft/mxc) (`mxc-sdk`, linked into the `pi_natives` addon). Contained processes can write only to the workspace, a private temp directory, and paths you grant; omp's credential store and common secret stores are unreadable; network access is off, unrestricted, or limited to a hostname allowlist enforced by an omp-run egress proxy.

It is off by default.

## What is contained

| Contained (when enabled)                                                                                                                       | Scope   |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| The `bash` tool: the embedded shell, its in-process builtins (`cat`, `rm`, `sed`, redirects, …), child processes, background (`async`) runs, and interactive PTY runs | `bash`  |
| Python eval kernels and JavaScript eval cells (contained JS eval runs in a separate process instead of an in-process worker), including commands a cell runs through `sh()` and the git hooks run by the `commit` helper | `eval`  |
| Commands run through the `exec()` API of extensions, hooks, custom tools, and custom commands                                                    | `exec`  |
| MCP stdio servers whose config sets `sandbox: true` (see [MCP servers](#mcp-servers))                                                            | per server |
| Language servers, Biome, SwiftLint and the workspace diagnostics checkers (`cargo check`, `tsc`, `go build`, `pyright`) omp starts for the `lsp` tool and diagnostics | always (not part of `sandbox.scope`) |

In-process file tools (`read`, `write`, `edit` including deletes and moves, `ast_edit`, `grep`, `glob`, `find`, `ast_grep`, the `lsp` tool's file and `rename_file` destination, an IDA `.i64`/`.idb` opened in place through `read` or eval's `dsm`, the `tts` tool's `output_path`, and the same tools called from an eval cell as `tool.write`, `tool.edit`, …) run inside omp. While the sandbox is active, omp checks every local path such a call names against the same filesystem policy before the tool runs, in every approval mode. Workspace edits an LSP server sends (rename, code actions, `workspace/applyEdit`) are checked file by file before any is applied.

A language server is bound to the policy it started under: when the sandbox is enabled, or its effective policy changes (a session path grant included), the next use stops the old server before starting a new one under the current policy. While the sandbox applies, servers start privately in the session process, never through omp's daemon. A server already shared through the daemon's `lsp` module is only detached from this session: it stays idle, uncontained, in the daemon until its idle policy stops it, but omp sends it nothing more. Under `fallback: block` without a backend, servers, Biome, SwiftLint and the diagnostics checkers are refused; under `warn` they run uncontained after the one-time warning. While the sandbox is on, omp does not run a workspace `tsc --version` to detect TypeScript 7, so `typescript-native` is not picked automatically.

The file tools' filesystem work is contained as well, in a sandbox host of the session (a contained omp process started on first use, without network access), so the OS refuses an access the path check did not catch, such as one through a symlink or junction swapped in after the check:

- **Writes:** the writes, deletes, moves, mode changes and directory creation of `write` (including archive members and SQLite rows), `edit` (and `apply_patch`), an applied `ast_edit`, the `lsp` tool's workspace edits and `rename_file` moves (server-sent `workspace/applyEdit` included), and the audio file `tts` saves run in the host. An applied `ast_edit` and a SQLite row write run whole there.
- **Searches and listings:** `grep`, `glob`, `find`, `ast_grep`, the `ast_edit` preview and `read`'s directory listings walk the tree in the host; only their results reach omp. URL paths in them are served by omp, outside the container; web URLs there follow `sandbox.network.mode`. The ovnfs search daemon is not used while the sandbox is active.
- **Single-file reads** (`read`, the files the search tools read for hashline tags, the files `lsp` edits, the input images `generate_image` names, the archive a `write` to one of its members rewrites): the host opens the file inside the container first, then omp opens it and reads it only if it is the very file the container opened (same device and file id); a refused open fails the call, and a file swapped in between is refused. The bytes are then read in omp through that handle. Helpers that read the file themselves get the handle, not the path: `ffprobe`/`ffmpeg` (video and HEIF stills) read it as their stdin (ffmpeg older than 6.0 gets one private temp copy per operation, written from it); a `?q=` JSON query and the PDF page screenshot run on a private temp copy written from it. An `.asar` archive's unpacked members (`app.asar.unpacked/`) cannot be read contained. SQLite reads run whole in the host, since SQLite opens the database's `-wal`/`-shm` files itself.
- **Disassembler (IDA, Ghidra, Binary Ninja):** the backend's Python worker, which opens and saves databases for `read`'s analysis selectors and eval's `dsm` and runs `exec` code, starts inside the container, and omp hosts such a database in its own process instead of in the omp daemon's shared `disasm` unit (so it is not listed in `omp ps`); while the sandbox is active `dsm` sees only these databases, and a `dsm` reference taken before the sandbox applied (or while it applied, once it is off) is dropped at its next use with a message to reopen the database. The worker can read its interpreter and the backend install (`IDADIR` and `IDAUSR`; `GHIDRA_INSTALL_DIR` and `JAVA_HOME`; `BN_INSTALL_DIR`, its Python API directory and the Binary Ninja user folder, `$BN_USER_DIRECTORY` from your launch environment, else the default), and write the database's store directory (`<agentDir>/idbs/<id>`, `<agentDir>/ghidra-projects/<id>`); each install root is resolved first, and one that is missing, the filesystem root, your home or an ancestor of it is not granted (`PYTHONPATH` grants nothing). An `.i64`/`.idb` opened in place must lie under a writable root, or IDA's open and save fail. It listens on a socket (Windows: a port file) in a directory of its own that omp creates outside every root contained processes may write (the system temp directory, else the agent directory; when contained processes may write both, the database is refused), and its output stays in omp's memory for error messages, never in a file. omp hashes a binary and copies it into the store through a verified handle, and an explicit `ida.python`/`ghidra.python` interpreter (and every Binary Ninja interpreter candidate) is probed inside the container. The worker keeps the policy it started with: a `sandbox_request` grant applies to it once the database is reopened.

- A write (any call that modifies: write, edit, delete, move, `ast_edit`) must land under a writable root: the workspace, the private temp directory, `allowWrite`, or a `sandbox_request` write grant. In `read-only` mode only the temp directory and the session's `local://` directory.
- A read must lie under a readable root contained commands get for the current [read scope](#read-scope) (so `readScope: all` still excludes device and virtual trees, Linux `/tmp`, and anything outside the profile on Windows), or under a writable root, `allowRead` or a read grant, and must not touch a `denyRead` path. A recursive search rooted above a `denyRead` path is refused; name a narrower path.
- A refused call fails with a sandbox message naming the exact `sandbox_request` (kind and target) that would allow it; a granted request then covers the file tools as well as contained commands. A `denyRead` path cannot be requested.
- Internal URLs (`local://`, `skill://`, `artifact://`, …) are omp's own storage and are not checked. A destructive tool's write to a file-backed URL still runs contained: the session's `local://` directory is writable there in both modes (omp chooses its location, and `local://` paths cannot climb out of it), a `vault://` note outside the writable roots needs a `sandbox_request` grant.
- Web URLs read by `read`, `grep` and `ast_grep` follow `sandbox.network.mode` while the sandbox is active: the URL's host is checked before the call runs (`deny` refuses it before any request; `allowlist` allows a host on `allowedHosts` or granted with `sandbox_request` kind `host`; `allow` allows all). Every host the read then contacts, the URL's own included, is checked the same way as each request is made: redirects, alternates, feeds and document links the page names, `llms.txt` probes, reader backends (Jina, Parallel, Firecrawl) and site-handler APIs (for example `api.github.com`). In `allowlist` mode omp also resolves a host that is allowed by name and refuses the request when an address is not allowed for how the name was allowed, as the egress proxy does (see [How the allowlist works](#how-the-allowlist-works)); no `sandbox_request` lifts that refusal. A name that does not resolve, or whose check does not finish within the request's time limit, fails the request like a network error and is not a refusal. A refused request on the page's own chain fails the read with the sandbox's refusal; a refused secondary request is skipped and the read says so in a note. Reader tools that fetch on their own (trafilatura, lynx) do not run in `deny` or `allowlist` mode.

The eval helpers that write directly (`write()` in Python, the JS prelude's `write`) run inside the eval kernel, so they are contained with it.

One gate runs these checks: the tool wrapper (every tool, and eval `tool.*` calls), eval helper calls (for what a helper declares), Cursor's native delete and download frames, and LSP workspace edits. A tool or eval helper can declare what a call does on the host (paths it reads or writes, hosts it reaches, and `exec` actions omp performs outside the sandbox). A tool without a declaration has the paths its call names checked; an eval helper without one is not checked. Nothing is checked inside a tool's own handler.

Not contained:

- `debug` launches and attaches and `computer` calls, once you allow them (see [Host actions](#host-actions)): the debugger adapter and the program it launches, or the desktop control, run on the host uncontained; the agent can then drive them freely (a debugger's `evaluate`, gdb's `shell`), and a contained command can rewrite a granted workspace program, so an `exec` grant amounts to running code on your machine for the rest of the session.
- The lock file omp writes next to an `.i64`/`.idb` opened in place (`<name>.i64.lock`).
- The `ask` tool's form images: a local `<img src>` is read on the host to show it to you (it is not returned to the model).
- SSH and the host helpers omp runs itself (git/VCS operations, updates, clipboard). omp's own Chromium for the `browser` helper runs on the host but is restricted as described under [Browser](#browser); a browser omp cannot restrict needs a [host action](#host-actions) grant.
- Git hooks of the other commit paths (`/commit`, the CLI, worktree and autoresearch commits) run on the host. The eval `commit` helper writes commits in-process on the host (objects, refs and index under `.git`), but the hooks it runs (`pre-commit`, `commit-msg`, `post-commit`) run contained under the eval policy whenever the sandbox applies to `eval`. A `pre-commit` or `commit-msg` hook the sandbox blocks fails the commit with the sandbox notice; with the backend unavailable, hooks follow `sandbox.fallback` (`warn`: on the host after the warning; `block`: the commit is refused).
- The files omp's own git writes in `.git` itself (`COMMIT_EDITMSG`, `HEAD` on a branch switch, reset or new branch, a linked worktree's admin files, the files copied when a git dir is detached) are replaced, not written through, so a symlink or hard link a contained command planted there is not followed. The files it reads there for those operations (the commit message a `commit-msg` hook leaves, `HEAD` before a reset, a worktree's `gitdir`) must each be a single regular file: a symlink, a FIFO or any other non-regular file is refused (the commit message must also have no other hard link and be at most 4 MiB). omp's own lookups of `HEAD`, refs, `packed-refs` and a worktree's `gitdir` outside gix (branch, status and worktree listings) refuse a link in place of the file, and a ref resolves only to an object that exists in the repository; worktree and submodule entries reached through links are skipped. Repository discovery follows links to the `.git` pointer file, `commondir` and `config` (as git does), but refuses a FIFO or other non-regular file there, or one too large, instead of blocking on it. When an isolated task's objects are copied back, symlinked objects, packs or `objects` directories are skipped. omp also refuses a `.git/worktrees`, or an admin directory under it, that is not a real directory inside the repository. The rest of omp's git goes through the gix library, which follows links (see [Known limits](#known-limits)).
- `ssh://`, `pr://`, `issue://`, `mr://` (fetched through `gh`/`glab`) and `mcp://` reads are not checked against `sandbox.network.mode`. For X/Twitter reads the URL's own host is checked, and Grok fetches the post from the configured xAI endpoint, whose host is checked as well. With no backend under `fallback: warn`, web reads are not checked.
- JS eval `%packages`: `bun add --ignore-scripts` runs in the parent (network access and writes to omp's package cache; no lifecycle scripts).
- URL paths in bash commands (`skill://`, `pr://`, `mcp://`, …): the parent resolves them. File-backed schemes return a host path the contained shell then opens under the sandbox policy; virtual and remote schemes are rendered by the parent with the same reach as the `read` tool.
- Your own commands: `!` / `!!`, `/loop` conditions, and the RPC `bash` command run unsandboxed in your shell.
- Processes an extension starts on its own (for example with `Bun.spawn`) instead of through `exec()`.
- MCP stdio servers without `sandbox: true`, and HTTP/SSE MCP servers.
- Command-backed config values (a `!command` API key, header or MCP `env` value in `models.yml`, MCP config or the auth broker settings): they run on the host by design, so credential helpers such as `op` or `security` can reach your keychain.
- Tools that write only to omp's own storage: memories (`retain`, `memory_edit`, `learn`), managed skills (`manage_skill`) and the images `generate_image` creates (saved under a temp name omp picks). The agent does not choose where these land.

While the sandbox applies to `bash`, a `bash` call with `name` (a managed service) is refused, since services run under omp's daemon outside any sandbox; use `async: true` instead. A sandboxed command never runs in an ACP client's terminal.

Contained `bash` commands and eval cells can also write the session's `local://` directory, in both modes, so `local://` artifacts keep working.

Environment of contained commands:

- They receive omp's process environment without the variables omp loaded from its own `.env` files (the agent directory's, the config root's, and `~/.env`): API keys kept there stay out of the sandbox. Variables your shell exported, project `.env` variables, and values set for the child itself (an MCP server's `env`, a bash call's `env`) are passed. MCP servers, language servers, LSP tools and `exec()` children also do not inherit the git repository location variables omp was started with (`GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`), which would point their git at another repository; the child's own `env` may still set them.
- Contained bash commands do not load direnv/devenv environments (`.envrc`): the load would run files the contained agent can write, on the host, outside the sandbox.
- In `allowlist` mode, contained processes (bash shells and PTY runs, eval kernels, `exec()` children, MCP servers, language servers and LSP tools, the disassembler worker) do not inherit your `HTTP_PROXY`, `HTTPS_PROXY`, `FTP_PROXY`, `ALL_PROXY` or `NO_PROXY`: MXC points the proxy variables at omp's egress proxy, which cannot chain to an upstream proxy, so on a network that requires a corporate HTTP proxy, `allowlist` mode cannot reach the internet. In `allow` and `deny` modes they pass through. A `bash` call in `allowlist` mode gets `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` (and their lower-case forms; `FTP_PROXY` on Linux) set again for that command, so a command's own `unset` or `export` of them does not last into the next call; `NO_PROXY` is not set again and persists.

While the sandbox applies, nothing that project-layer settings choose runs on the host for a contained call:

- The bash rc snapshot (your shell's aliases and functions, captured on the host) uses the shell from your own config layers; when a project config sets a different `shellPath`, contained shells run without a snapshot.
- The Python interpreter probe (which picks the interpreter, including a workspace `.venv`) runs contained, like the kernel.
- A virtual environment the workspace controls (a `.venv` in it, or one its `.env` names) that resolves outside the workspace is not readable by the contained interpreter.

### Host actions

While the sandbox is active, omp refuses an action it would perform on the host outside the sandbox until you allow that exact action for the session through `sandbox_request` (kind `exec`):

- `debug` `launch`: `debug:launch <program>`, the program's real path resolved against the call's `cwd` (its plain resolved path when it does not exist).
- `debug` `attach`: `debug:attach` followed by every field the call sends, in this order: ` adapter <name>`, ` pid <n>`, ` <host>:<port>` (` port <n>` without a host, ` host <host>` without a port), for example `debug:attach pid 42` or `debug:attach adapter dlv pid 42 box:9`. A grant for one form does not cover another. Other debug actions on a started session need nothing.
- every `computer` call: `computer`.
- `browser`: `browser:run` for code a `tab.run`, a function argument or an element's `evaluate` string runs in omp's process; `browser:relay`, `browser:cdp`, `browser:cmux`, `browser:tern`, `browser:webkit` or `browser:spawned <path>` for a browser omp cannot contain (`app: "webkit"` asks even before its engine is installed); `browser:chromium-network-allow` to open omp's Chromium while the effective network mode is `deny` (`deny`, or a mode this host cannot enforce); `browser:chromium-workspace <path>`, `browser:chromium-network-<mode>`, `browser:shared` or `browser:chromium-unsandboxed` for a tab opened under another workspace or containment, or while the sandbox was off (close it to contain it again).

An IDA database (`.i64`/`.idb`) opened in place, whose directory contained commands may not write, is refused with the same sandbox message, naming the `sandbox_request` write for that directory.

### Browser

While the sandbox is active, omp's Chromium for the `browser` helper runs as its own process for each workspace and network containment, never as the shared daemon:

- In `allowlist` mode every request, loopback included, goes through the egress proxy and its host approval, and WebRTC sends no UDP outside the proxy. In `allow` mode it runs without the proxy. In `deny` mode (or a mode this host cannot enforce) opening it asks for `browser:chromium-network-allow`; once granted it runs with open network and the same file checks.
- A `file:` page cannot read other files from script; its frames, images, scripts and navigations load only files the sandbox lets omp read.
- Page downloads are denied unless the tab was opened with a `downloads` folder or waits for a download (omp's own temp folder); one Chromium saves after such a tab closed lands in the browser's own profile, never your Downloads folder.
- Where an open would pick omp's own browser (no `app`, `app: "own"` or `"auto"`), it picks omp's Chromium, never its WebKit host, while `sandbox.enabled` is on, even when no backend is available; only `app: "webkit"` opens WebKit (and asks for `browser:webkit`).

Whatever the browser, paths a call names (the `downloads` folder, uploads, saved and loaded state, screenshots and screenshot diffs, PDFs, traces, profiles, HARs, recordings, `init_scripts` files, `file:` URLs) are checked like the file tools.

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
| `sandbox.scope`                 | array of `bash`, `eval`, `exec`    | `[bash, eval, exec]`                     | Which executors run contained. MCP servers opt in per server instead; what the LSP subsystem runs is contained whatever this lists.                                          |
| `sandbox.fallback`              | `warn` \| `block`                  | `warn`                                   | What happens when the sandbox is enabled but this host has no usable backend (see [Unavailable backend](#unavailable-backend)).                                              |
| `sandbox.filesystem.readScope`  | `all` \| `workspace`               | `all`                                    | What contained commands may read (see [Read scope](#read-scope)). Denied paths stay unreadable either way.                                                                    |
| `sandbox.filesystem.allowWrite` | array of paths                     | `[]`                                     | Extra writable paths in `workspace-write` mode.                                                                                                                               |
| `sandbox.filesystem.allowRead`  | array of paths                     | `[]`                                     | Extra readable paths, in either read scope.                                                                                                                                   |
| `sandbox.filesystem.denyRead`   | array of paths                     | [secret stores](#default-denied-paths)   | Paths contained commands can neither read nor write; outranks every other list.                                                                                               |
| `sandbox.filesystem.windowsListDrives` | boolean                     | `false`                                  | Windows: let contained commands list directories and read file metadata on every drive holding a sandbox path; Node, npm, npx, `cmd dir` need it (see [Windows](#windows)). |
| `sandbox.network.mode`          | `allowlist` \| `deny` \| `allow`   | `allowlist`                              | Network access of contained commands (see [Network](#network)).                                                                                                               |
| `sandbox.network.allowedHosts`  | array of host names                | [registries and forges](#default-allowed-hosts) | Hosts reachable in `allowlist` mode. `*.example.com` matches subdomains of `example.com`, not `example.com` itself. Entries and hosts compare after IDNA normalization (case, trailing dots and `bücher.example` / `xn--bcher-kva.example` are the same); an entry with a port or that is not a valid host matches nothing, and a wildcard never matches an IP address. |
| `sandbox.network.windowsLoopback` | boolean                          | `false`                                  | Windows: let contained commands connect to `127.0.0.1` in `allowlist` and `deny` modes, their own sockets and every service on this machine's loopback; the Python eval kernel needs it (see [Windows](#windows)). |

### Path entries

Path lists accept:

| Form           | Expands to                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `~`, `~/…`     | Your home directory (`~\…` on Windows only). `~name` (another user's home) is rejected; give that path absolutely. |
| `${home}`      | Your home directory                                                                              |
| `${workspace}` | The session's workspace (project directory)                                                      |
| `${tmp}`       | The sandbox's private temp directory (what contained processes see as `TMPDIR`)                  |
| `${authDb}`    | omp's credential database (`agent.db` in the agent directory, XDG-aware)                         |
| `${agentDir}`  | omp's agent directory (normally `~/.omp/agent`)                                                  |
| `${configRoot}` | omp's config root (normally `~/.omp`)                                                         |
| relative path  | Resolved against the workspace                                                                   |

Any other `${…}` token is rejected when the setting is written, so a typo such as `${HOME}` fails instead of matching nothing. Paths are resolved through symlinks before they reach the backend (on macOS `/tmp` becomes `/private/tmp`). Entries that do not exist when a process starts are dropped from its policy, and so are readable or writable entries you cannot access yourself (for example `/root`; bubblewrap would refuse the whole request).

A config file that sets an invalid `sandbox.*` value (an unknown `${…}` token, a value outside a setting's choices, or a value of the wrong type) fails config load with one `Error:` line naming the file at fault and the setting (`Validate(<setting id>)`); omp exits 1 without starting, under any subcommand and in every mode (`--mode rpc` included), until it is fixed. Each config layer (your config, the `--config` overlays, the project config; files within one layer are merged first) is checked on its own, so an invalid value fails even when a higher layer overrides it. The panel and `/settings` refuse an invalid value when written.

### Default denied paths

`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/.env`, `${configRoot}/.env`, `~/.config/gh`, `${authDb}`, `${authDb}-wal`, `${authDb}-shm`, `${agentDir}/.env`, `${agentDir}/models.yml`, `${agentDir}/mcp.json`, `${agentDir}/.mcp.json`.

Setting `sandbox.filesystem.denyRead` replaces this list; include the defaults you want to keep.

### Default allowed hosts

`github.com`, `*.github.com`, `*.githubusercontent.com`, `gitlab.com`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `crates.io`, `*.crates.io`, `proxy.golang.org`, `sum.golang.org`.

## Modes

| Mode              | Writable                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `workspace-write` | The workspace, the private temp directory, `allowWrite`, and the git metadata commits write to when it lies outside the workspace: in a linked worktree, the worktree's own `worktrees/<name>` and the common dir's `objects`, `refs`, `logs` and `reftable` (its `hooks/`, `config` and other worktrees stay read-only, so git operations that rewrite `packed-refs` or `config`, such as `branch -d` of a packed branch, `fetch --prune` or `push -u`, fail contained); the enclosing repository's `.git` when omp starts in a subdirectory of an ordinary checkout |
| `read-only`       | The private temp directory and the session's `local://` directory                                                              |

Each sandbox runtime gets its own private temp directory, exposed to contained processes as `TMPDIR`, `TMP` and `TEMP`. The system temp directory is not writable for them: it holds files omp later runs on the host and other programs' control sockets (editor, tmux, ssh-agent).

Everything else readable is read-only. `denyRead` entries are neither readable nor writable. On Linux (bubblewrap), a write outside the readable binds or into a denied directory succeeds inside the sandbox but lands in a private in-memory layer that is discarded when the sandbox ends; host files are never changed (see [Known limits](#known-limits)).

Writable roots are pinned to the real path they first resolved to: the workspace, session grants, and `allowWrite` entries. A root later replaced by a symlink is not followed: a session grant is dropped, an `allowWrite` entry is skipped with a warning, and a replaced workspace makes contained commands fail. A session-granted directory that is merely deleted (a `cargo clean`, an `rm -rf build`) keeps its grant and is recreated empty for the next contained command; a granted file (any path that is not a directory, a socket or FIFO included) that is later deleted stays inert and is not recreated.

### Protected paths

Inside the writable roots, omp keeps read-only the paths it later runs or loads on the host:

- **Git:** in the workspace's git dir and its common dir: `config`, `config.worktree`, `hooks/`, `commondir` and `gitdir`; `commondir`, `gitdir` and `config.worktree` of every linked worktree; the same entries, existing or not, in every submodule git dir under `modules/` (nested and slash-named ones included); each populated submodule's `.git` pointer file (found through the `core.worktree` git writes into the submodule's config); the workspace `.git` file of a linked worktree or submodule checkout; the workspace `.git` itself while missing, when the workspace has no repository or lies below its repository's root; the resolved `core.hooksPath` when it lies in a writable root.
- **Project config** at the workspace root: `.omp/`, `.claude/`, `.codex/`, `.gemini/`, `.cursor/`, `.vscode/`, `.windsurf/`, `.opencode/`, `mcp.json`, `.mcp.json`, `opencode.json`, `opencode.jsonc`, and the `lsp`/`dap` config files (`.json`, `.yaml`, `.yml`, with or without a leading dot).

Contained commands cannot write the ones that exist; the file tools refuse writes to all of them, existing or not. On Linux each directory between a writable root and a protected path is its own mount, so it cannot be renamed or replaced (`mv .git .git-old` fails). A protected entry that is a symlink is protected at the link and at its target. A `denyRead` entry wins: nothing under a denied path is carved out or made writable.

A `sandbox_request` write for a protected path (or one below it) lifts the protection for exactly that path; its dialog warns that omp runs git or loads project config from it outside the sandbox. A `sandbox.filesystem.allowWrite` entry in your own config that names an existing protected path does the same. A grant of an ancestor (the workspace, `.git`) never lifts it. In `read-only` mode a write refusal cannot be requested; only you can switch modes.

### Paths created by sandboxed commands

A protected path that does not exist yet cannot be mounted read-only, and on macOS and Windows a directory holding one can be replaced. omp therefore watches them, from the first contained command of a workspace on: it notes the identity of every protected path and of each directory between it and its writable root, and compares after every tool call settles, before discovery loads project config, before every host git operation, and when a contained process starts or exits. A protected path that appeared, a symlink re-pointed, or a parent directory replaced is recorded in `sandbox-created.json` in the agent directory (`~/.omp/agent` by default) and stays protected from then on (an existing protected file or directory replaced, even through a rename as your own `git config` does with `.git/config`, is not reported unless it is a symlink or holds another protected path):

- omp does not load project configuration under it: capability discovery skips it with a warning; project custom commands, plugin overrides, `lsp`/`dap` config files, the project plugin root (`.omp/plugins`) and individual project plugins under it, the project `installed_plugins.json` and any install path it names under a recorded path, and the `enabledPlugins` of `.claude/settings.json`/`settings.local.json` skip it with a log line.
- omp's own git (status line, commits, worktrees, `omp git`, `omp worktree`) refuses a repository when a recorded path is its `.git` entry, git dir or common dir, lies inside or above one of them (a re-created `.git/hooks`, a replaced `.git`), or is its `core.hooksPath`. The status line keeps rendering when its git reads are refused: it shows no branch for the repository (reading `HEAD` is refused too), and a branch it showed before the refusal keeps the default branch at its `main` seed.
- In a workspace without its own git repository (none, or a subdirectory of one), `.git` is protected while missing, so a contained `git init` is recorded too.

omp also watches the `worktrees` directory of the common git dir and of every submodule git dir, whether or not a linked worktree exists yet. It is not protected (contained `git worktree add` creates it as a real directory), but a symlink created there, or replacing it, is recorded like a protected path, and omp's git then refuses the repository.

When someone can answer access requests, omp asks right away whether to trust the path; allowing it removes the record and lets contained commands write it (for the session, or always if you choose **Always**). Otherwise use `/sandbox` → **Filesystem** → **Created by sandboxed commands**: **Trust**, or **Remove** once the path no longer exists. `/sandbox status` lists them. A record is listed, and can be trusted or removed, only from a session in the workspace whose command created it; it is enforced everywhere. The record file is changed under a file lock and, once it exists, is read-only to contained commands when a writable root covers it.

A recorded path that is, or lies under, a symlink between it and the workspace cannot be trusted: trust is refused, naming the link to delete or replace with the real directory; a path that now resolves elsewhere is refused too. The automatic trust prompt is not shown for it. Only a granted answer removes a record; an `already-allowed` answer leaves it in place.

## Read scope

| `readScope` | Readable                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `all`       | macOS/Linux: every top-level directory except device and virtual trees (`/dev` on macOS, plus hidden root entries; `/dev`, `/proc`, `/sys`, `/run` on Linux, which the backend mounts as needed) and, on Linux, the host's `/tmp` (contained processes see an empty private one). Windows: the tool, profile and temp directories MXC discovers, plus your user profile. |
| `workspace` | The workspace, the tool directories MXC discovers from `PATH`, omp's own runtime files, what the symlinked tools in those `PATH` directories need to start (Homebrew: the whole `Cellar`; otherwise the tool's install prefix — never the filesystem root, a root child, your home, a home ancestor, or a home-level directory other than `bin`/`sbin`/`libexec`), and your global git configuration files when they exist: `~/.gitconfig`, `config`/`ignore`/`attributes` in `$XDG_CONFIG_HOME/git` (or `~/.config/git`), `$GIT_CONFIG_GLOBAL`, the files their `[include]`/`[includeIf]` `path =` lines name (up to 5 levels), and Homebrew git's `<prefix>/etc/gitconfig`. Never the git config directory itself (it holds `credentials`). `denyRead` still wins. |

In both scopes the workspace, `allowRead`, and the files omp needs to start inside the sandbox (its executable's directory, the native addon, the source checkout when run from source) stay readable. MXC's backends add their own baseline on top (on macOS: `/bin`, `/usr`, `/System`, `/Library`, `/private/etc` and device nodes).

When it adds these tool and git-config roots, omp never follows a link whose chain passes through the workspace or the private temp dir (compared case-insensitively on macOS and Windows): a contained process could re-point it. Tool roots are added on Linux and macOS only; on Windows only the git configuration files are added. Read-only entries at or under a `denyRead` path are dropped from the policy.

## Build tools and caches

Execution is not restricted: a contained command can run any readable program (`cargo`, `git`, `node`, compilers under `/usr`, Homebrew, `~/.cargo/bin`). What fails is a write outside the writable roots, so tools that populate a cache in your home directory need that cache granted:

```yaml
sandbox:
  filesystem:
    allowWrite: ["~/.cargo/registry", "~/.cargo/git", "~/.npm", "~/.bun/install/cache"]
```

- Builds and installs that stay inside the workspace (`target/`, `node_modules/`, `.venv/`) need nothing; `cargo build` works with already-downloaded dependencies.
- A writable cache can be tampered with by a contained command and is later used by uncontained builds; grant caches deliberately, never a directory of executables such as `~/.cargo/bin`.
- With `readScope: workspace`, symlinked tools in `PATH` directories get their install prefix readable (Homebrew tools their whole `Cellar`) and start without extra grants. A tool outside the `PATH` directories MXC discovers, or one whose runtime data lies elsewhere (TeX Live texmf, uv-managed interpreters, Nix store), needs `allowRead` (for Rust: `~/.rustup`, `~/.cargo`).
- The agent can also ask for a cache directory it needs with [`sandbox_request`](#access-requests); you decide per request.

## Network

| `network.mode` | Behaviour                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `allowlist`    | Only `allowedHosts` (plus hosts you approve), through omp's egress proxy                                           |
| `deny`         | No network                                                                                                        |
| `allow`        | Unrestricted network (on Linux, not the host's loopback; see [Per-OS behaviour](#per-os-behaviour))               |

`deny` works everywhere. `allowlist` and `allow` need host support (see [Per-OS behaviour](#per-os-behaviour)); on Linux that means these packages:

| Package       | Commands MXC runs                                                |
| ------------- | ---------------------------------------------------------------- |
| `slirp4netns` | `slirp4netns`                                                    |
| `util-linux`  | `nsenter`, `unshare`                                             |
| `iproute2`    | `ip`                                                             |
| `iptables`    | `iptables`, `ip6tables`, `iptables-restore`, `ip6tables-restore` |

A mode this host cannot enforce cannot be turned on. `/settings` and the `/sandbox` panel list it as `<Label> (unavailable)`, disabled, and show the reason (`/settings` also appends it to the row's description, so the missing packages stay readable in a narrow terminal); choosing it changes nothing. The panel, `cfg://sandbox.network.mode` and RPC `set_sandbox_setting` refuse it with that reason, e.g. `Network mode "allow" is unavailable on this host: packages slirp4netns, iproute2 are missing (commands: slirp4netns, ip). Install them to use this mode.` Without missing commands (private network namespaces blocked, an unusable iptables backend, a Windows tier lacking the loopback proxy capability) the reason is the backend's own. A mode named in a config file is not refused: network is **denied** instead, and `/sandbox status` and the panel's Overview say why. A per-call setting (an MCP server's `sandboxNetwork`) that names such a mode also runs as `deny`, with a log warning.

### How the allowlist works

- On the first contained `allowlist` spawn, omp starts an HTTP proxy on `127.0.0.1` (a random port) inside the omp process. It handles `CONNECT host:port` tunnels and absolute-URI `http://` requests and checks each destination name against the allowlist.
- The backend confines the contained process's egress to that loopback port in the kernel: a process cannot bypass the proxy by connecting elsewhere.
- Proxy use is cooperative: on macOS MXC sets `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` (and their lower-case forms) to the proxy URL; the Linux backend also sets `FTP_PROXY`; MXC removes any `NO_PROXY`. Tools that honour these variables (curl, git over HTTPS, npm, pip, cargo, Go, …) work; tools that ignore them get no network at all rather than filtered network.
- A refused request gets HTTP `403` with `X-Omp-Sandbox: blocked`; the host is recorded as blocked for this session.
- A plain HTTP request whose upstream closes before sending any response gets `502 Bad Gateway` (body `<host>:<port> closed the connection without a response`); a CONNECT tunnel already answered `200` just closes.
- Requests from `bash` commands, eval cells and PTYs carry an identity, so a refusal is attributed to the call that made it. A `bash` command's proxy URL holds per-command credentials (`http://omp:<token>@…`), and the proxy never forwards them. Each eval kernel and eval `sh()` host gets its own proxy port, and each PTY has its own; the eval ports share the `eval` tag. Other requests are attributed by time, git in a `bash` command included: it sends proxy credentials only after a `407` challenge, which the proxy never sends. MCP servers, language servers, `exec()` children, the eval `commit` helper's hooks and the file-access host carry no identity. A request without one is allowed or refused as before.
- The proxy resolves the name itself and connects to the address it checked:
  - an exact (non-wildcard) DNS-name entry may resolve to public and private addresses, never to loopback, link-local (including cloud metadata `169.254.169.254`) or unspecified ones, IPv6 forms that wrap them included;
  - a name matched only by a wildcard must resolve to public addresses;
  - IP literals, `localhost` and `*.localhost` are allowed only when listed verbatim; wildcards and prompts never reach them.
- The in-process web reads of `read`, `grep` and `ast_grep` apply the same address rule (see [What is contained](#what-is-contained)).

### Approving hosts

In the interactive TUI, a connection to a host that is not on the list asks: **Approve Once** (this connection), **Allow `<host>` for this session**, or **Deny**. Ticking **Remember across sessions** turns the allow option into **Always allow `<host>`**, which is appended to the global `sandbox.network.allowedHosts`. Dismissing the prompt refuses the connection.

| Grant | Addresses the host may resolve to |
| --- | --- |
| **once**, **for this session** | Public and private ranges (intranet services); never loopback, link-local or unspecified addresses, on every connection; a session grant never covers an IP literal or `localhost`/`*.localhost` |
| `allowedHosts` entry, including **Always allow `<host>`** answers and the panel's **Allow** | The same for a DNS name; only an IP literal or `localhost` / `*.localhost` listed verbatim reaches host-local addresses |

Approving a host does not restart shells or kernels: the proxy reads the allowlist and session grants live. A running process only ever narrows, though: it reaches a listed host only while the list still has it and it was listed when the process started, or you added it to your own list since. A host that a project switch (`/move`, a resumed session in another directory) puts back on the effective list is not reachable from processes started before the switch.

Without an approver unknown hosts are refused: print mode and subagents without a UI never ask. An RPC client can opt in to answering host requests (`set_sandbox_host_prompts`, then `sandbox_host_request` / `respond_sandbox_host`; an unanswered request is denied after 2 minutes). The RPC interface also reads and edits the sandbox (`get_sandbox`, `set_sandbox_setting`, `reset_sandbox_setting`, `edit_sandbox_list`, `grant_sandbox_host`, `revoke_sandbox_host`) and pushes `sandbox_update` on every change; see [RPC: Sandbox](./rpc.md#sandbox).

The `/sandbox` panel's **Network** page lists **Blocked this session** with an **Allow** action, which adds the host to the global allowlist (an exact entry, like answering **Always allow `<host>`**).

## Access requests

When a contained command needs a path or host it does not have, the agent asks with the `sandbox_request` tool instead of failing or working around the denial. The tool exists only while `sandbox.enabled` is on and someone can answer: the TUI, an RPC host (the tool is offered from boot, but requests are refused until the client opts in with `set_sandbox_access_prompts`), or an approver an SDK host installed; print mode and ACP never offer it. The agent can never grant itself anything: only your answer in the dialog does. Typical case: a build redirected outside the workspace (`CARGO_TARGET_DIR=/Volumes/fast/target cargo build`).

A request names one target: a path to **write** (a single file, or a directory and everything under it), a path to **read**, a **host** to connect to (exact hostname, no wildcard, scheme or port), or an **exec** target: an action omp performs on the host outside the sandbox, named by a sandbox refusal (for example `debug:launch /usr/bin/node` or `computer`), shown and compared verbatim (surrounding whitespace trimmed). Paths are resolved (`~` expanded, relative to the session cwd, symlinks followed, dangling ones included, `..` applied after each link as the kernel does) before you see them.

A file tool refused for an existing file outside the writable roots names that file as the request target, which is a single-file grant. For a path that does not exist yet, the target is its directory and the refusal says the grant covers the whole directory. On Linux (bubblewrap) a single-file grant is a bind mount: contained processes can change the file in place but not delete or replace it (`Read-only file system`, or `Device or resource busy` where its directory is writable), so grant the directory when the task needs that.

The dialog (`Sandbox request: write to <target>`, `read <target>`, `connect to <host>`, or `perform <target>`) shows:

| Field | Content |
| --- | --- |
| Intent | What the agent is doing and why it needs this exact target, in its words |
| Command | The command that needs the access, when given |
| Effect | omp's own statement of the consequence, e.g. "Contained commands will be able to create, change and delete every file in the whole directory /Volumes/fast/target and its subdirectories, not just one file." For a file target it names the file instead. |
| If denied | What the agent says it will do instead, when given |

Actions:

- **Allow for this session**: exactly the requested path, host or exec target, not saved. Path grants are listed under `/sandbox` → **Filesystem** → **Allowed this session** and exec grants under **Overview** → **Host actions allowed this session**, where you can remove them. A write path that does not exist yet is created as an empty directory, unless it is a [protected path](#protected-paths).
- Exec targets are allowed for this session only; **Always allow** is not offered for them.
- **Always allow (saved to global config)**: appends the target to `sandbox.filesystem.allowWrite`, `allowRead` or `network.allowedHosts`. Not offered when that list comes from another layer (environment, a session override, a `--config` file, or project config), since a global write would be shadowed.
- **Deny** (also Esc): nothing is granted; the agent is told not to retry or work around it.
- **Reply with instructions…**: nothing is granted; your text goes back to the agent.

The dialog appears in every approval mode, `yolo` included. A granted path changes the policy, so the sandboxed shell and eval kernels restart on their next call (`cd` and exported variables reset); a granted host applies live.

Removing a session grant takes effect on the next sandboxed call, which restarts the shell and kernels. A command still running, background jobs of a shell no later call replaces, and opted-in MCP servers keep the policy they started with.

Host requests follow `sandbox.network.mode`: with `deny` they are refused (only you can change the mode); with `allow` every host is already reachable.

Refused without asking (the agent gets the reason):

- a filesystem root, or a path at or under a `denyRead` entry;
- a host that is an IP address, `localhost` or `*.localhost` (only you can list it verbatim in `sandbox.network.allowedHosts`);
- a path that reaches a protected path through a dangling symlink;
- a write while `sandbox.mode` is `read-only`, or a host while `network.mode` is `deny`;
- a target that is already allowed (reported as already allowed, no dialog);
- the sandbox off or unavailable, an empty intent, or a target with control characters;
- no one to ask: an RPC client that has not opted in with `set_sandbox_access_prompts` (see [RPC: Access requests](./rpc.md#access-requests)), or a worker-thread subagent whose main session has ended. Subagents share the main session's dialog, on the main thread or on worker threads: their requests are shown to you.

An approved path that resolves elsewhere by the time you answer is refused, not granted; so is one that changed between a file and a directory (a removed file included) while the dialog was open.

One request is shown at a time; identical concurrent requests share one dialog. Session grants (paths and hosts) belong to the omp process, not to a workspace or session: every session and subagent shares them. A grant answered for a worker-thread subagent reaches it before its call returns.

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

A project list replaces yours: a `denyRead` or `scope` list that repeats none of your entries is taken as additions only and is not reported, unless it is the default list (a reset, reported as the removal of your entries). An empty list, a `null`, or one that repeats some of your entries but omits others is reported as an attempted removal of the entries it drops.

Ignored values are reported by `/sandbox status` (`Ignored project value <id>: <reason>`) and on the panel's **Overview** page under **Ignored project values**. In `/settings`, the `enabled`, `mode`, `fallback`, `readScope`, `windowsListDrives`, `network.mode` and `windowsLoopback` rows show the effective value, so an ignored project value never shows as set. `/settings` hides the list editors for `scope`, `allowWrite`, `allowRead`, `denyRead` and `allowedHosts` while the project layer sets them, so a project list is never promoted to your global config.

While the sandbox is enabled, omp's global settings files are protected from the in-process file tools: `config.yml` / `config.yaml` and `.env` in the agent directory, `.env` in omp's config root (normally `~/.omp/.env`), and `~/.env` are treated like `tools.restrictedFolders` entries. Every `read`, `write`, `edit` or search call that targets them asks Approve/Deny in every approval mode (see [approval mode](./approval-mode.md#restricted-folders)) and is refused without a UI. Contained commands cannot write them anyway.

Agent writes to `cfg://sandbox.*` settings always ask while the sandbox is enabled, in every approval mode; a "for this session" answer to another `cfg://` write does not cover them, and without a UI they are refused.

## Per-OS behaviour

| | macOS | Linux | Windows |
| ------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend | seatbelt | bubblewrap | processcontainer |
| Requires | macOS 15 or newer | A working `bwrap` (MXC requires 0.5.0 or newer) and usable unprivileged user namespaces, checked by actually starting a probe sandbox (Ubuntu 24.04's AppArmor restriction or a container's seccomp profile can block them) | The native processcontainer tier: Windows 11 24H2, build 26100.9278 / 26200.9278 or newer. Older builds report the sandbox as unavailable; omp does not use MXC's AppContainer fallback, which would rewrite ACLs of host directories |
| `allowlist`  | Proxy, kernel-confined     | Needs MXC's proxy confinement tooling: the `slirp4netns`, `util-linux` (`nsenter`, `unshare`), `iproute2` (`ip`) and `iptables` packages and private network namespaces; otherwise unavailable (see [Network](#network))    | Proxy, confined to loopback by the OS when the backend tier supports an identity-less loopback proxy; otherwise unavailable                                                                                                           |
| `allow`      | Unrestricted               | Needs the same tooling, otherwise unavailable; never reaches the host's loopback (private network namespace)                                                                                                                | Unrestricted                                                                                                                                                                                                                          |
| Verification | Exercised on this platform; macOS 26 live QA (release build, seatbelt): contained bash/eval/MCP/LSP, file tools, network modes, access requests, panel | Exercised on Ubuntu 24.04 under WSL2 (bwrap 0.9.0, slirp4netns 1.2.1, iptables 1.8.10): smoke probe, contained bash, JS/Python eval, MCP, access grants, `allowlist` through the proxy | Exercised on Windows 11 build 26100 (smoke probe, contained bash, JS eval, Node, git) |

A configured network mode that cannot be enforced runs as `deny` (stricter), with the reason shown by `/sandbox status` and the panel; the interactive setters refuse it (see [Network](#network)). The requirement rows come from MXC's documentation; omp reports MXC's own reason string when a backend is missing.

On macOS the seatbelt profile also allows the Mach service `com.apple.system.opendirectoryd.libinfo`, so user and group lookups (`whoami`, `id -un`, ssh) work contained.

`omp --smoke-test` includes a sandbox probe: where a backend is available it starts the sandbox host contained, runs `echo`, and checks that a write outside the workspace fails; where none is available it prints the reason and passes. On a CI runner without a usable backend the probe therefore only confirms that omp starts and reports the reason.

### Windows

The processcontainer backend starts every contained process with Windows' **Mandatory ASLR** mitigation (`ForceRelocateImages`), which Windows applies to the container itself. Neither MXC nor omp can turn it off. Consequences:

- **Some programs cannot start contained.** A program whose runtime needs a fixed load address fails before it runs any code, with exit code `0xC0000142` (`STATUS_DLL_INIT_FAILED`, `-1073741502` in a shell's `$?`). This includes Git Bash and every MSYS2 or Cygwin program: `bash.exe`, `sh.exe` and everything else in Git for Windows' `usr\bin` (`ssh`, `gpg`, `perl`, `vim`, `less`, `awk`, …). A program can instead start and abort with the MSYS runtime's `fatal error … 0xC0000022` when it cannot create its named objects, as Git's `sh.exe` does for hooks (see Upstream work below).
- **Git works, but not the parts of git that call those programs:**
  - Hooks (`pre-commit`, husky, …) run under Git's `sh.exe`, so a commit in a repository with hooks fails contained: the hook prints `*** fatal error - NtCreateDirectoryObject(\BaseNamedObjects\msys-…): 0xC0000022` and git exits 1.
  - The eval `commit` helper's hooks fail the same way while the sandbox applies to `eval`.
  - Signed commits (`gpg`) and git's default editor (`vim`) fail. Use `git commit -m` or point `core.editor` at a native editor.
  - SSH remotes go through Windows OpenSSH, which starts contained: when `%SystemRoot%\System32\OpenSSH\ssh.exe` exists (the OpenSSH Client optional feature), contained processes get `GIT_SSH` set to it unless `GIT_SSH` is already set; `GIT_SSH_COMMAND` and `core.sshCommand` still take precedence. The network mode must allow the host; SSH does not work in `allowlist` mode. The default `denyRead` hides `~/.ssh`, so `known_hosts`, `config` and keys are unreadable and host-key verification fails: grant what SSH needs (or drop `~/.ssh` from `denyRead`) to use SSH remotes contained.
- **What works:** native Windows programs (`git.exe`, `cmd`, PowerShell, Windows OpenSSH, Bun), and the `bash` tool's built-in commands (`ls`, `sed`, `grep`, `find`, `sort`, …), which run inside omp's own shell instead of Git's. `cmd` itself runs; its `dir` needs the opt-in in the next bullet.
- **Node and `cmd`'s `dir` need drive listing (opt-in).** Windows grants a contained process nothing on a drive root no policy path names, so `lstat("C:\")` fails, and with it Node, which resolves every script path from the drive root (`node app.js`, npm, npx and the tools built on them), and `cmd`'s `dir`, which reads the root and fails with `Access is denied.`. `sandbox.filesystem.windowsListDrives: true` grants PSEC `enumeratePaths` on the volume roots (`C:\`, `\\server\share\`) of the policy's paths, where the native tier supports it. PSEC applies that grant to the whole volume: contained processes can then list every directory and read every entry's metadata (names, sizes, times) on those drives, including paths the policy does not name, though no file contents. Off by default for that reason; a project config cannot turn it on.
- **Bun cannot open directories under read-only roots.** Under a read-only grant, the container's filesystem filter (`bfs.sys`) admits a directory open (`FILE_DIRECTORY_FILE`) only for `FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE`; a request that adds `FILE_READ_EA` or `FILE_TRAVERSE` is denied, though both are allowed on the same path when the open does not say it is a directory. Bun opens every directory with both rights, so its `readdir`, `opendir` and module resolver fail there with `EPERM`. Native tools (`cmd`'s `dir`, PowerShell, Node) request only `FILE_LIST_DIRECTORY | SYNCHRONIZE` and list them; `Bun.Glob`, `stat` and `realpath` work. Writable roots such as the workspace are unaffected. The same filter rule makes changing directory into a read-only directory (`SetCurrentDirectoryW`, which opens with `FILE_TRAVERSE`) fail. The policy cannot express access rights, so omp cannot work around it. Reported upstream: [microsoft/mxc#1467](https://github.com/microsoft/mxc/issues/1467) (Microsoft plans a Windows update that allows `FILE_TRAVERSE`; `FILE_READ_EA` is raised in [this comment](https://github.com/microsoft/mxc/issues/1467#issuecomment-6796133392)) and [oven-sh/bun#48581](https://github.com/oven-sh/bun/issues/48581) (Bun requesting neither right fixes it without a Windows update).
- **Running omp from a source checkout:** contained commands, the file tools and the disassembler fail (`Module not found …\cli.ts`, `Cannot read directory …: EPERM`) unless the workspace is the checkout itself, because Bun cannot open the read-only source directories (previous item). MXC's `enumeratePaths` does not help: a path that is both read-only and enumerable becomes list-only, and its files stop being readable. The standalone binary is unaffected; a bun package install (`--source`) was not tested and may hit the same limit. The contained tests under `packages/coding-agent/test/sandbox/` that re-enter omp's sources are therefore skipped on Windows (`CONTAINED_SOURCE_RUNS` in `test/helpers/sandbox-test-state.ts`) until one of the upstream fixes lands.
- **Loopback is closed in `deny` and `allowlist` modes (opt-in).** The container blocks loopback connections there, a process's connection to itself included, so `socket.socketpair()` and with it Python's asyncio hang. The Python eval kernel needs loopback too (its tool bridge is a TCP socket on the host's loopback), so in those modes it refuses to start at once, with an error naming the setting, instead of timing out. `sandbox.network.windowsLoopback: true` opens loopback (`127.0.0.0/8`, `::1`) where the native tier supports host loopback: contained processes can then connect to their own listeners and to every service on this machine's `127.0.0.1` (development servers, databases, container engine APIs, browser debugging ports, local proxies that reach the internet), whatever the allowlist says. In `allowlist` mode that replaces the backend's native proxy confinement with an egress rule: egress stays denied except to loopback, and omp sets `HTTP_PROXY` and `HTTPS_PROXY` to its proxy (and clears `NO_PROXY` and `ALL_PROXY`), so tools that honour them are filtered as before and programs that only use the WinHTTP system proxy get no network. Off by default for that reason; a project config cannot turn it on. In `allow` mode loopback is open whenever the native tier supports it.
- **Interactive PTY runs** start a shell process of omp's own build (the embedded shell, seeded from the session's contained shell) inside the container, so they fail like contained commands when omp runs from a source checkout (see above); the standalone binary is unaffected.
- **UI access:** contained processes may make Win32k calls (without them every program that loads `user32.dll`, including `git` and PowerShell, fails to start), but they cannot read or write the clipboard or inject keyboard and mouse input.

When a contained `bash` command or eval cell fails with `0xC0000142` or with an MSYS runtime fatal error, the result carries a notice telling the agent the program cannot start in the sandbox and not to retry it. `/sandbox on`, `/sandbox status` and the panel's Overview page show the limitation as a warning. To run such a command anyway, run it yourself with `!` (your own commands run unsandboxed) or turn the sandbox off with `/sandbox off`.

Upstream work that would lift this: MSYS2 building its runtime and packages relocatable ([msys2-runtime#381](https://github.com/msys2/msys2-runtime/pull/381), [MSYS2-packages#6789](https://github.com/msys2/MSYS2-packages/pull/6789)); even then the MSYS runtime must create its shared named objects inside the container's object namespace ([microsoft/mxc#1061](https://github.com/microsoft/mxc/issues/1061)).

### Unavailable backend

When the sandbox is enabled but no backend can contain processes on this host:

- `fallback: warn` (default): one warning (a startup notification in the TUI, a log warning otherwise), and commands, the file tools' filesystem work and the disassembler worker run **unsandboxed**.
- `fallback: block`: every call that should run contained, the file tools and the disassembler included, fails with the reason, until a backend is available or you run `/sandbox off`.

## What the agent sees

- While the sandbox is active, the system prompt gains a block naming what runs contained, the backend, the writable and unreadable paths, and the network mode. It tells the model that denials are expected and never to retry or work around them; when `sandbox_request` is available, to call it themselves (narrowest target, clear intent) rather than ask in chat first, otherwise to tell you the path or host it needs. It also says that protected paths inside the workspace are sandbox policy; in read-only mode only the listed writable paths accept writes and only reads can be requested; `denyRead` paths and IP or local-name hosts cannot be requested.
- When a contained `bash` result or a failed eval cell looks like a filesystem denial (a non-zero exit with `Operation not permitted`, `Permission denied`, `Access is denied`, `Read-only file system`, `EPERM`, `EACCES`, `EROFS`, sqlite's `authorization denied` or dyld's `file system sandbox blocked` in the output), the proxy refused one of the call's own requests (named even when the command succeeds) or refused a request it cannot attribute while a failed call ran, or (on Windows) a program failed to start with `0xC0000142` or with an MSYS runtime fatal error (an output line with `*** fatal error - ` and either `NtCreateDirectoryObject` or a `\BaseNamedObjects\msys-…` object name, as a git hook under Git's `sh.exe` prints it, with git exiting 1), a sandbox notice is appended to the result. The denial and host notices tell the agent to call `sandbox_request` itself rather than ask in chat first, when it is available; the start-failure notice, for either form, tells the agent to use an equivalent that runs contained or to hand the command to you.
- The network-off notice: while the effective network mode is `deny`, a non-zero exit whose output shows a failed name resolution (`Could not resolve host`, `Temporary failure in name resolution`, `getaddrinfo`, `nodename nor servname provided`, `ENOTFOUND`) or a refused connection (`Couldn't connect to server`, `Connection refused`, `ECONNREFUSED`) gets a notice that the network is off and that only you can change `sandbox.network.mode`. The notice never suggests `sandbox_request`. A refused connection is hedged: it is not blamed on the sandbox when it was to a server the command itself started. On Windows with `sandbox.network.windowsLoopback` on, refused connections are not flagged, only name-resolution failures.
- The host notice offers a request only for requestable hosts; a refused IP address, `localhost` or `*.localhost` is described as listable only by you, verbatim, in `sandbox.network.allowedHosts`. The filesystem notice in `workspace-write` mode names protected paths inside the workspace as policy; in `read-only` mode it says writes cannot be requested and offers only read requests; `denyRead` paths are never offered.
- A failed `pre-commit` or `commit-msg` hook of the eval `commit` helper carries the same sandbox notice in the commit's error when its output shows one.
- A `sandbox_request` call shows as a tool card with the kind, target and intent, and, once answered, the decision (with your instructions or the refusal reason); a call that failed to run shows as an error.
- Contained `bash` and eval results carry a `sandboxed` badge on their tool card (its tooltip names backend, mode and network), plus a warning note: `blocked by sandbox: host …`, `possible sandbox denial`, or `cannot start in the Windows sandbox`. A `bash` card shows the badge from the moment the command starts; an eval card when the cell finishes.

Contained processes see `OMP_SANDBOX=1` in their environment.

## The `/sandbox` panel

Four pages:

- **Overview**: status line (Active · backend / Unavailable · reason / Off), **Enabled**, **Mode**, **Applies to**, **If unavailable**, backend warnings, ignored project values, and **Host actions allowed this session** (`exec` grants, each with **Revoke**).
- **Filesystem**: **Read scope**, the **Writable**, **Readable** and **Denied** lists, one editable row per entry with an **Add** action, **Allowed this session** (paths granted through access requests, each with a remove action), and **Created by sandboxed commands** (each with **Trust**, and **Remove** once the path no longer exists).
- **Network**: **Mode**, the allowed hosts, and **Blocked this session** with **Allow**. A mode this host cannot enforce is labelled "(unavailable)" with the reason; choosing it is refused and the reason is shown.
- **Effective policy**: the resolved writable, readable and denied paths for the current workspace (read-only).

In Tern the panel renders as a native preferences sheet docked beside the transcript, like `/settings`; in a plain terminal the same sheet is drawn fullscreen, with the status and the last refusal as rows at the top. Rows another layer decides are locked and show the reason: `Set by $PI_SANDBOX`, `Set by a session override`, `Set by the --config file`, or `Tightened by project config`. Edits there would be shadowed, so they are refused (RPC refuses them with `sandbox_locked`).

A freshly opened panel selects its first row. The panel keeps the selection on a row that cannot widen access or change a setting: after Trust or Remove of a created-path record it moves to a Remove row or the list's Add row, never to a Trust row; after Allow on a blocked host it moves to the Add row; after revoking the last host-action grant, a page switch, or a setting row becoming locked, nothing is selected until you press ↑/↓ (Enter acts only on a selected row). A list row (a path or host) that becomes locked moves the selection to its list's Add row when that is enabled, else nothing is selected.

## MCP servers

MCP stdio servers opt in per server with `sandbox: true` and choose their network with `sandboxNetwork` (`allow` by default, independent of `sandbox.network.mode`); see [MCP configuration](./mcp-config.md#stdio-transport). An opted-in server runs contained only while `sandbox.enabled` is on; `sandbox.scope` does not apply to it. An opted-in server is always hosted in the session's own process, never shared through the daemon (`mcp.shared`), since only the session holds its sandbox.

Containment is decided when a server connects. After toggling the sandbox or changing its policy, an already-running server keeps its state until `/mcp reconnect <name>`. When the sandbox is enabled but no backend is available, `sandbox.fallback: warn` starts the server uncontained after the one sandbox warning, and `block` fails the connection with the reason. The project-may-only-tighten rule does not cover MCP: a server defined in a project's MCP config runs uncontained unless it sets `sandbox: true` itself. On Windows, a `sandbox: true` server whose command resolves to a `.cmd`/`.bat` shim that is not an npm node shim is refused; point `command` at `node` or `bun` and pass the script.

## Telemetry

MXC can emit telemetry, on Windows only, as ETW events. omp turns it off at both ends: `mxc-sdk` is built without a Microsoft telemetry route (`MXC_TELEMETRY_COMPONENT_PATH` empty in `.cargo/config.toml`, mirrored for Bazel in `MODULE.bazel`; `mxc-sdk` 1.0.1 routes only when built with `MXC_TELEMETRY_PROVIDER_GROUP_GUID`), and every contained process is spawned with MXC telemetry explicitly disabled, so the ETW provider is never registered. omp sends no sandbox telemetry anywhere.

## Known limits

- **Proxy use is cooperative.** Tools that ignore `HTTP_PROXY`/`HTTPS_PROXY` get no network in `allowlist` mode. SSH (including `git` over `ssh://`) does not work in `allowlist` mode.
- **The proxy has no authentication.** While it runs, any local process on the machine can use it to reach allowed hosts.
- **No TLS interception.** The proxy sees only the name on the `CONNECT` line; an allowed name on shared hosting or a CDN can front for other tenants.
- **Listed and approved names can point at private addresses.** A listed or approved DNS name may resolve to private ranges, so a name whose DNS an attacker controls could be re-pointed at internal services (DNS rebinding); host-local addresses stay refused for every name except IP literals and `localhost` names listed verbatim. The in-process web reads (`read`, `grep`, `ast_grep`) resolve the name again when they connect, so a DNS answer that changes after omp's address check is not caught there. Answering **Always allow `<host>`** at the prompt (or **Allow** in the panel) is a persistent grant: give it only to names you trust.
- **Worker-thread subagents ask through the main session.** Their `sandbox_request` calls are forwarded to the main session's approver through the sandbox thread service: the dialog appears in the main session, aborting the subagent's call closes it, and a session grant reaches the worker before its call returns. Their refused hosts appear under **Blocked this session**.
- **Blocked hosts are attributed by origin where possible.** A refusal is reported on the call whose credentials or proxy port it came from, even when that call succeeded. A request without that identity is attributed by time: git sends proxy credentials only after a `407` challenge, which the proxy never sends, so git refusals in a `bash` command are attributed by time, as are those of a tool that drops proxy credentials, of a background job outliving its command, and of the MCP, LSP, `exec()` and commit-hook processes. The agent's notice names a time-attributed host only on a failed call that was running. A refusal from any eval kernel or `sh()` shell is attributed to the eval call that is running, so concurrent eval calls can show each other's refused hosts. Credential attribution is best-effort against other contained processes running at the same time (they may read each other's environment); the proxy's decisions never depend on it.
- **Filesystem denials are reported heuristically and after the fact.** There is no live "allow this path?" prompt; the kernel answers synchronously. The denial notice is a match on the output of a failed command and can miss or misattribute.
- **The workspace is a trust root.** It is writable, so files a contained command writes there take effect uncontained later. The [protected paths](#protected-paths) and the [record of paths sandboxed commands create](#paths-created-by-sandboxed-commands) cover what omp itself loads or runs, but not everything: hook frameworks (husky, pre-commit, lint-staged) run workspace scripts that contained code can edit, an `[include] path` in `.git/config` can point into the workspace, and a submodule whose `.git` is a directory inside the workspace (not absorbed into `.git/modules`) keeps its config and hooks writable. Review the workspace diff, including `.omp/`, `.mcp.json`, `.env` and git hooks, before restarting omp or running project tooling outside the sandbox. A project `.env` cannot set the names that choose omp's own config (`PI_CONFIG_FILES`, the agent and config directories, the profile, the XDG roots, the natives dir; see [environment variables](./environment-variables.md#resolution-model-and-precedence)), so it cannot load a config that turns the sandbox off.
- **Host git follows planted links in `.git`.** The gix library behind omp's own git follows symlinks, parent directories included, when it updates refs and reflogs, writes objects, and reads the index, refs and objects. In `workspace-write` mode a contained command can replace a `.git` path with a symlink to a file or directory you can write. A ref or object update through a linked directory creates or replaces a file in the directory the link points to (a ref file then holds just a commit id); a reflog gets a line appended: two commit ids, your git identity and a fixed message such as `commit` or `reset: moving to target`. The next ref update omp makes on the host (the eval `commit` helper, `/commit`, creating or merging an isolated task's worktree, a reset or a new branch through omp) triggers it. `read-only` mode is not affected, nor are git commands the agent runs inside the sandbox (the write never reaches the host file). Use `read-only` mode for untrusted repositories, or check `.git` for symlinks before letting omp commit on the host after untrusted code ran.
- **The record of created paths is attributed by time.** A protected path you or omp create on the host while the session runs (your editor creating `.vscode`, a `git init` on the host, omp creating `.omp/`) is recorded as sandbox-created and asked about once. A contained command still running while omp polls git can race the check. A repository already recorded when omp starts has its `core.hooksPath` unread, so a hooks path outside `.git` is not protected, until you trust it (host git refuses the repository meanwhile).
- **Chrome-branded builds contact Google on their own.** In `allowlist` mode their `accounts.google.com` and `www.google.com` requests go through the egress proxy and ask for approval like any host.
- **Protected git paths block some contained git commands.** On Linux the directories holding protected paths are mount points and the protected files are read-only mounts: `git rm` of a submodule, `git submodule deinit -f`, `rm -rf <submodule>` and `rm -rf .git` fail with `Device or resource busy`, and so do `git remote add`, `git config`, `push -u` and other config writes (git renames `config.lock` over the mounted `.git/config`) until a `sandbox_request` lifts `.git/config`. A submodule's `.git` pointer is found only through a plain `core.worktree` value in its config; an unusual form (include, quotes or escapes inside the value, continuation lines, several values) leaves that pointer unprotected.
- **A repository rooted at your home directory (or above it) never gets its `.git` granted.** A session started in a subdirectory of such a repository (a dotfiles repository at `~`) cannot `git add`/`commit` contained; add that `.git` to `sandbox.filesystem.allowWrite` if you want it.
- **Denied paths that do not exist when a process starts are not protected** for that process.
- **Pinned roots leave a short window.** omp checks that a writable root is still the directory it pinned just before starting a contained process; a swap between that check and the backend applying the policy is not caught.
- **Path probes run in omp.** Whether a path a file tool names exists, and whether it is a file or a directory, is looked up by omp, not the container: that reveals metadata of a path the policy hides, never its contents. A path an extension's own code opens is neither checked nor contained.
- **Exported secrets still reach contained processes.** Only variables from omp's own `.env` files are withheld. An API key exported by your shell or its rc files is in the contained environment, and with allowlisted hosts that remains a way to send it out. A variable from omp's `.env` can also reach contained bash when a function in your shell rc references it, unless its name looks like a secret (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`, `*PRIVATE_KEY*`, `*ACCESS_KEY*`, `*CREDENTIAL*`, `*SESSION_KEY*`).
- **Linux: the environment is visible on the host.** bubblewrap receives the environment as arguments of the host-side `bwrap` process, so other local users can read it (API keys included) from `/proc/<pid>/cmdline` while a contained process runs.
- **Linux: no host loopback.** Contained processes cannot reach services on the host's `127.0.0.1`, even in `allow` mode.
- **Linux: a contained command cannot remove a granted directory itself.** Write grants are bind mounts, so `rm -rf` of one empties it but fails on the directory with `Read-only file system`. A granted single file is bind-mounted too: it can be changed in place but not deleted or replaced (`Read-only file system`, or `Device or resource busy` where its directory is writable); grant its directory for that.
- **Linux: writes can report success and vanish.** MXC's bubblewrap backend starts from a writable tmpfs root and mounts an empty writable tmpfs over each denied directory. A write to a path no bind covers, or into a denied directory such as `~/.ssh`, exits 0 inside the sandbox but never reaches the host and is discarded when the sandbox ends. Within one session's persistent shell, a command can see files it planted there, such as under `~/.ssh`.
- **Windows: the Python eval kernel needs loopback**: in `deny` and `allowlist` modes it refuses to start unless `sandbox.network.windowsLoopback` is on, which also exposes this machine's loopback services; see [Windows](#windows).
- **Windows: programs that cannot run contained fail to start**, Git Bash and MSYS2/Cygwin tools included. Mandatory ASLR causes the `0xC0000142` failures; git hooks fail through the MSYS runtime's named-object error (`0xC0000022`) instead. See [Windows](#windows).
- **Windows: `curl.exe` (Schannel) checks certificate revocation over plain HTTP.** In `allowlist` mode it asks for or is refused CRL hosts such as `crls.ssl.com`; allow them or pass `--ssl-no-revoke`.
- **The `sandboxed` badge of an eval cell appears when it finishes**, not while it runs.
- **PTY on macOS:** a contained PTY works, but `tty` prints `not a tty`; programs that only check `isatty()` are unaffected.
- **macOS: `allow` network mode cannot resolve host names under the default `readScope: all`.** MXC's seatbelt profile strips socket access to `/private/var/run/mDNSResponder` with the read-only `/private` subtree; raw IP addresses work. The fix needs an MXC change. Use `allowlist` with the hosts instead (omp's proxy resolves the names); `readScope: workspace` is not verified as a workaround.
- **macOS: pip (and `%pip`) in a contained process may fail TLS verification (`OSStatus -26276`) while curl works.** The cause is not verified. Use `--use-deprecated=legacy-certs`, or run pip yourself.
- **macOS: `/usr/bin/git` (the Xcode shim) prints an `xcodebuild … DVTDeveloperPaths: Failed to get length of DARWIN_USER_CACHE_DIR` line under the sandbox.** It is harmless.
- **macOS: contained processes can list user and group records.** Local records, and directory records on a directory-bound Mac, are listable: the Mach service above that makes lookups work also allows listing them.
- **A `PATH` directory made writable (`allowWrite` or a session grant) is still scanned** for tool links, so a contained process can plant one that the next gather follows. Git config reached only through `core.excludesFile`/`core.attributesFile` or a non-plain include form needs `allowRead`.
- **A disassembler worker's socket directory is checked when the worker starts.** A later write grant that covers the system temp directory or the agent directory lets contained commands reach a running worker's socket until the database is reopened.
- **Linux** was exercised on Ubuntu 24.04 under WSL2 (smoke probe and the sandbox, eval and MCP test suites) and is covered by the CI smoke probe. Windows was exercised on Windows 11 build 26100 (smoke probe, contained `bash`, JS eval and git); the rest of the runtime behaviour described here was exercised on macOS (macOS 26 live QA, release build, seatbelt: contained bash/eval/MCP/LSP, file tools, network modes, access requests, panel).

## Implementation files

- `packages/coding-agent/src/sandbox/settings.ts` -- `sandbox.*` settings, defaults, path tokens
- `packages/coding-agent/src/sandbox/policy.ts` -- effective config (project-may-only-tighten rule), filesystem policy, host matching
- `packages/coding-agent/src/sandbox/platform.ts` -- per-OS read roots
- `packages/coding-agent/src/sandbox/runtime.ts` -- per-workspace runtime: availability, fallback, network degradation, contained spawns
- `packages/coding-agent/src/sandbox/context.ts` -- filesystem probing for the policy context (omp runtime paths, git metadata grants, protected paths, the mount-point carve-outs)
- `packages/coding-agent/src/sandbox/gate.ts` -- the one sandbox gate (declared subjects, refusal) used by the tool wrapper, eval preludes, Cursor's direct file frames and LSP edits
- `packages/coding-agent/src/sandbox/grants.ts` -- per-realm session host, path and exec grants, blocked-host log with refusal attribution (`EgressCall`, `egressOwners`), thread replication hooks, host approval
- `packages/coding-agent/src/sandbox/ledger.ts` -- the record of protected paths sandboxed commands created or replaced: identity watch, locked record file, the host git guard
- `packages/coding-agent/src/sandbox/access.ts` -- access-request routing: approver, one-dialog queue, worker forwarding
- `packages/coding-agent/src/sandbox/egress-proxy.ts` -- allowlist egress proxy
- `packages/coding-agent/src/sandbox/host.ts`, `host-protocol.ts`, `shell-client.ts` -- in-sandbox shell/PTY host, its client, the smoke probe
- `packages/coding-agent/src/sandbox/file-access.ts`, `file-mutation-ops.ts` -- the file tools' contained writes, searches and verified reads (`tools/file-write-fallback.ts` routes the write and delete primitives)
- `packages/coding-agent/src/disasm/contained.ts` -- the contained disassembler worker spawn
- `packages/coding-agent/src/disasm/client.ts`, `packages/coding-agent/src/daemon/modules/disasm.ts` -- in-process disassembler units while the sandbox is active
- `packages/coding-agent/src/sandbox/process.ts` -- adapter from the native process to a Bun-like child
- `packages/coding-agent/src/exec/bash-executor.ts`, `tools/bash.ts`, `tools/bash-interactive.ts` -- bash integration
- `packages/coding-agent/src/eval/py/kernel.ts`, `eval/js/context-manager.ts`, `eval/shell-bridge.ts` -- contained eval and its `sh()`
- `packages/coding-agent/src/commit/selective/prelude-definition.ts` -- the eval `commit` helper's hooks, run contained
- `packages/coding-agent/src/exec/exec.ts` -- contained extension/hook/custom-tool `exec()`
- `packages/coding-agent/src/mcp/host/stdio-upstream.ts`, `mcp/host/contained-child.ts`, `mcp/host/access.ts` -- contained MCP stdio servers, hosted in-process
- `packages/coding-agent/src/lsp/client.ts`, `lsp/workspace-diagnostics.ts`, `lsp/clients/biome-client.ts`, `lsp/clients/swiftlint-client.ts` -- contained language servers and LSP tools (through `execContained` in `exec/exec.ts`)
- `packages/coding-agent/src/slash-commands/builtin-collaboration.ts` -- `/sandbox`
- `packages/coding-agent/src/modes/sandbox-panel.ts` -- `/sandbox` panel data, lock reasons, writes
- `packages/coding-agent/src/modes/rpc/rpc-sandbox.ts` -- RPC sandbox commands, host and access requests
- `packages/coding-agent/src/tools/sandbox-request.ts` -- `sandbox_request` tool
- `packages/coding-agent/src/tools/browser/sandbox.ts` -- the `browser` helper's sandbox subjects, Chromium containment and `file:` load check
- `packages/coding-agent/src/tools/web-url-subjects.ts` -- sandbox subjects of the web URLs `read`, `grep` and `ast_grep` fetch, the early refusal; `packages/coding-agent/src/tools/fetch.ts` (`sandboxHostGuard`) and `packages/coding-agent/src/web/scrapers/types.ts` (`withRequestHostGuard`) -- the host guard on every host a web read contacts, the URL's own included, and the address rule on the names it resolves
- `packages/coding-agent/src/tools/approval.ts` -- protection of omp's settings files while the sandbox is enabled
- `packages/coding-agent/src/prompts/system/sandbox.md`, `prompts/tools/sandbox-denial.md`, `prompts/tools/sandbox-call-denial.md`, `prompts/tools/sandbox-request.md`, `prompts/tools/sandbox-request-result.md` -- model-facing text
- `packages/coding-agent/src/modes/view-model/overlays/sandbox-config.ts`, `src/ui/overlays/sandbox/sandbox-config.tsx` -- `/sandbox` panel model and sheet (Tern and terminal)
- `packages/coding-agent/src/tools/details/sandbox.ts`, `src/ui/tools/sandbox-meta.tsx`, `src/ui/styles/tools/sandbox.ts` -- `sandboxed` badge and notes on tool cards
- `packages/coding-agent/src/modes/view-model/overlays/sandbox-access-dialog.ts`, `src/ui/overlays/panels/sandbox-access-dialog.tsx`, `src/ui/tools/sandbox-request.tsx` (+ terminal looks under `src/ui/styles/`) -- access-request dialog and tool card
- `crates/natives/src/sandbox.rs` -- MXC binding (`sandboxSupport`, `sandboxDiscoverPaths`, `SandboxProcess`); see the [natives changelog](../packages/natives/CHANGELOG.md)
