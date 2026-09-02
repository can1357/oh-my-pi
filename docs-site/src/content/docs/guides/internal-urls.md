---
title: Internal URLs
description: Reference for the scheme:// URLs the read and write tools resolve — agent outputs, GitHub items, memory, skills, SSH hosts, Obsidian vaults, and system stores.
coverage: A
---

Internal URLs are `scheme://` addresses the agent resolves like file paths. Pass one as the `path` argument to the read tool: a single string that selects a file, a GitHub issue, a skill, a remote SSH file, or a tool device. The schemes cover fifteen built-in protocols, grouped below by what they reach.

## How internal URLs work

The read tool detects a registered scheme and dispatches the URL to the matching handler in the internal URL router (`packages/coding-agent/src/internal-urls/router.ts`). Each scheme has exactly one handler; handlers are stateless and pull their data from the active session, registry, or store on every resolve.

- Most schemes accept read selectors on the URL, e.g. `:50-100`, `:raw`, or `:5-16,960-973`, and the resolved text is paginated like a file read.
- The write tool dispatches through the same router, so schemes that back real files accept writes: `local://`, `ssh://`, `vault://`, and `xd://` (writing to an `xd://` device executes it — see below).
- Two schemes are feature-gated and off by default: `security://` (setting `security.enabled`) and `vault://` (setting `vault.enabled`).
- Schemes the router does not own — anything other than `file://`, `http://`, and `https://` — fall back to MCP server resources when a connected server advertises them (see the `mcp://` section below).

## Agents and sessions

These four schemes read data produced by agents: subagent outputs, transcripts, spilled tool output, and per-session scratch files. See [Subagents](/oh-my-pi/features/subagents/) for how agent outputs are produced.

### agent:// — subagent output

```text
agent://<id>            Full output content
agent://<id>/<child>    Nested subagent output
agent://<id>/<path>     JSON extraction from the output
agent://<id>?q=<query>  JSON extraction from the output
```

Reads subagent output artifacts (`.md` files) from the artifacts directories of every active session. Parents and subagents share outputs, so a subagent can read its parent's output IDs. The slash form is tried first as a hierarchy hop — `agent://Parent/Child` resolves the nested output `Parent.Child` — and only falls back to jq-style JSON extraction when no nested output matches. The query form is always extraction. Path extraction and `?q=` cannot be combined, and extraction returns the JSON directly without pagination.

`agent://` is immutable: reads never modify the source, and line anchors are suppressed.

### history:// — agent transcripts

```text
history://            Index of all agents
history://<agentId>   Markdown transcript of one agent
```

Serves agent transcripts as concise markdown. The bare form lists every registered and on-disk agent with id, status, kind, and last activity. A named form reads the transcript of a live agent, a parked agent (session disposed but retained on disk), or an unregistered agent whose session file still exists — so transcripts remain readable after a resume or release. Lookup is case-insensitive; advisor transcripts are hidden from the index.

### artifact:// — spilled tool output

```text
artifact://<id>   Full artifact content (id is numeric)
```

Reads raw tool-output artifacts: when a tool's output exceeds the in-memory buffer, the full sanitized output is spilled to a session artifact file (`<id>.<toolType>.log`) and referenced as `artifact://<id>`. IDs are per-session counters pinned to the calling session, so `artifact://3` means *this* session's artifact #3. Content is raw text — no JSON extraction — with pagination via read selectors. Inline materialization is capped at 8 MiB; larger artifacts report their backing file path for search/copy workflows. See [Code execution](/oh-my-pi/features/code-execution/) for when artifacts are produced.

### local:// — session scratch (writable)

```text
local://            List all files in the session scratch root
local://<file>      Read a file in the session scratch root
```

Session-scoped scratch space shared by the main agent and all subagents: `local://plan.md` reads or writes the file `plan.md` under the session's local root (an on-disk directory derived from the session, under the session artifacts directory or the system temp dir). Use it for large intermediate data, subagent handoffs, and reusable planning artifacts — the read tool even recovers a `local://` plan file by basename from the session cwd. Bare `local://` lists files recursively.

The write tool persists files here with `local://<file>`, so large intermediate artifacts survive across turns. Files must be UTF-8 text up to 1 MiB; known binary extensions and non-text content are rejected.

## GitHub

These two schemes read GitHub issues and pull requests through the `gh` CLI and a SQLite-backed cache. Single-item reads share rendered markdown across sessions through the cache; bare and repo-scoped reads issue a live `gh` list. See [GitHub](/oh-my-pi/features/github/) for the broader workflow.

### issue://

```text
issue://                      List recent issues (default repo)
issue://<owner>/<repo>        List issues for a repo
issue://123                   Single issue (repo from session cwd)
issue://<owner>/<repo>/123    Single issue, fully qualified
issue://<owner>/<repo>/123?comments=0    Single issue, comments suppressed
```

List reads accept `?state=` (`open`, `closed`, or `all`), `?limit=` (default 30, max 100), `?author=`, and `?label=`, passed through to `gh`. Unknown items and invalid options produce errors that name the available values.

### pr://

```text
pr://                      List recent PRs (default repo)
pr://<owner>/<repo>        List PRs for a repo
pr://123                   Single PR (repo from session cwd)
pr://123/diff              Changed files for the PR
pr://123/diff/all          Full unified diff
pr://123/diff/<i>          Diff of one file (1-indexed)
```

List reads accept the same options as `issue://`, with `?state=` extended by `merged`. Single reads accept `?comments=0` to suppress comments. The diff family works on the short form and on fully qualified URLs (`pr://<owner>/<repo>/123/diff`). Issues have no diff — `issue://` rejects diff paths.

## Memory and knowledge

### memory://

```text
memory://root               The memory summary file
memory://root/<path>        A file under the memory root
memory://root/<glob>        Glob match under the memory root
memory://<memory-id>        A mnemopi memory row
```

Reads memory files from the project memory root; the bare `root` namespace resolves `memory_summary.md`. Wildcards in the path (`*`, `?`, `[`, `{`) turn the read into a glob. Any other host is treated as a mnemopi memory id when `memory.backend = mnemopi` is active, returning the full stored row with its metadata (bank, store, timestamps, importance) as YAML frontmatter. See [Memory](/oh-my-pi/features/memory/).

### rule://

```text
rule://<name>   Read an active rule's content
```

Reads the content of a currently active rule by name. Unknown names error with the list of available rules. The active rule set is maintained by the capability registry (`packages/coding-agent/src/capability/`), which compiles context and rule files into the agent's always-apply buckets.

### skill://

```text
skill://<name>                 Reads the skill's SKILL.md
skill://<name>/<relative-path> Reads a file in the skill directory
```

Resolves a discovered skill by name to its `SKILL.md`, or to a relative path inside the skill's base directory. Directories resolve as listings. Path traversal is rejected. Skill text ignores the normal default line limit, so the full skill is returned unless you page it with a selector. See [Skills](/oh-my-pi/extending/skills/).

## External access

### ssh:// — remote files (writable)

```text
ssh://                    List configured SSH hosts
ssh://<host>/<path>       Read a remote file or directory
ssh://<user>@<host>/<path>   Override user (unconfigured hosts only)
```

Reads a remote UTF-8 text file (up to 1 MiB) or a one-level directory listing over the shared ControlMaster connections. Hosts come from the `ssh` capability (`ssh.json`); any destination OpenSSH can resolve, such as a `~/.ssh/config` alias, also works. Password auth is not supported. The write tool writes files with the same syntax.

Remote paths must be absolute. Query strings and fragments are rejected — percent-encode a literal `:`, `?`, or `#` in a filename (`%3A`, `%3F`, `%23`). Binary, non-UTF-8, oversized, and special files (FIFOs, sockets, devices) are rejected with explicit errors; larger files need an sshfs mount. See [SSH remote hosts](/oh-my-pi/features/ssh/).

### mcp:// — MCP server resources

```text
mcp://<resource-uri>   Legacy wrapper for a server resource URI
<foreign-scheme>://…   Any non-file/http(s) scheme falls back to MCP
```

MCP servers advertise resources with URIs of any scheme, including opaque forms like `urn:example:document`. The router matches the URI against every connected server's concrete resources and URI templates, then serves the resource's content. The `mcp://` form wraps a resource URI for backward compatibility; a foreign-scheme URI (say `catalog://root/`) resolves directly without the wrapper. Errors list the available resources and templates across servers. See [MCP](/oh-my-pi/extending/mcp/).

### vault:// — Obsidian vaults (gated)

```text
vault://                  List Obsidian vaults
vault://_                 The active vault
vault://<vault>           Vault info
vault://<vault>/<path>    Read a note or directory
vault://<vault>/<path>?op=<file-op>    Run a file op
vault://<vault>?op=<vault-op>          Run a vault op
```

Reads Obsidian vault content through the Obsidian CLI. `vault://` is gated by the `vault.enabled` setting (default `false`; Settings → Tools → Obsidian Vault) and requires the Obsidian CLI binary. File ops run on a note path:

| Op | Meaning |
| --- | --- |
| `outline` | Section outline of the note |
| `backlinks`, `links` | Notes linking to / linked from the note |
| `tags`, `properties`, `tasks` | Note metadata and task list |
| `wordcount` | Word counts |
| `history` | Edit history |
| `base` | Base note without metadata |

Vault ops run without a path:

| Op | Meaning |
| --- | --- |
| `search` | Full-text search |
| `daily`, `daily-path` | Daily note for today |
| `tags`, `tag` | Tag index and tag search |
| `tasks`, `orphans`, `unresolved`, `deadends` | Task and link-structure reports |
| `bases`, `bookmarks`, `recents`, `templates`, `aliases`, `properties`, `property` | Vault-wide indexes |

The write tool writes plain notes with `vault://<vault>/<path>` (no op); ops are read-only views. Unknown vaults and unsupported ops error with the available values.

## System

### security:// — security scan store (gated)

```text
security://                                   Index
security://scans                              List stored scans
security://scans/<scan-id>                    Scan overview
security://scans/<scan-id>/manifest           Scan plan and metadata
security://scans/<scan-id>/findings           Finding list
security://scans/<scan-id>/findings/<id>      One finding
security://scans/<scan-id>/coverage           Coverage data
security://scans/<scan-id>/report             Report (markdown)
security://scans/<scan-id>/sarif              SARIF export
security://scans/<scan-id>/provenance         Provenance record
```

Reads the OMP-owned, read-only security-analysis store for the current project. It is gated by the `security.enabled` setting (default `false`; Settings → Tools → Security) and is populated by the security scanning subsystem — scans are created through security commands or tools, never through this URL. See [Security scanning](/oh-my-pi/features/security/).

### xd:// — virtual tool devices

```text
xd://            List mounted tool devices
xd://<device>    Read a device's input documentation
```

Virtual tool devices are mounted as `xd://` URLs in the session. Reading the bare URL lists the mounted devices; reading `xd://<device>` returns that device's input documentation (its argument schema and instructions). Writing a JSON arguments object as the content of `xd://<device>` dispatches the device — this is how discoverable tools execute. Unknown devices and unwritable targets error with the available options.

### omp:// — bundled documentation

```text
omp://            List all available documentation files
omp://<file>.md   Read a bundled documentation file
```

Reads the statically embedded documentation files bundled with the build. The bare form lists every available file; a named form reads one. Path traversal is rejected, and unknown files error with a suggestion list. This scheme is the agent's way to consult harness docs; `omp://` is reserved for the harness itself.
