# Internal URL Schemes

Oh My Pi uses URL-shaped paths for resources managed by the harness rather than the workspace filesystem. The `read` tool accepts these paths directly, so an agent can open a plan, artifact, transcript, skill, or other resource without first finding its backing file on disk.

An internal URL is a handle the harness resolves, not a shell path: `cat local://plan.md` will not work, and neither will an editor that receives the literal string. Most schemes (`agent://`, `history://`, `omp://`, …) are harness state with no standalone file to open, so you read them through the agent or the `read` tool via the SDK or RPC interface. `local://` is the exception worth calling out — it is backed by ordinary files on your own disk, so you can open a plan directly without any model round-trip (see [Opening a local file directly](#opening-a-local-file-directly)).

## Reading a `local://` plan

When a response references a plan such as `local://auth-token-refresh-plan.md`, enter this in the chat:

```text
Read local://auth-token-refresh-plan.md and show me the plan.
```

If the filename is unknown, ask the agent to list the session's local files first:

```text
Read local:// and list the available files.
```

The bare `local://` URL returns a recursive listing with links. Reading a file URL returns its contents through the normal `read` pipeline, including document conversion, image handling, and line selectors:

```text
local://auth-token-refresh-plan.md
local://auth-token-refresh-plan.md:40-80
local://auth-token-refresh-plan.md:raw
```

### Opening a local file directly

`local://` files are real files on the local disk, so you do not need the agent — or any tokens — to read one you already have. They live under the session's artifacts directory in a `local/` subdirectory, falling back to `<tmpdir>/omp-local/<session-id>/` when no artifacts directory is set. The bare `local://` listing prints the resolved absolute path on its `Root:` line; open that path with any editor or `cat`:

```text
cat "$TMPDIR/omp-local/<session-id>/auth-token-refresh-plan.md"
```

`local://` is session-scoped scratch space. Plans, large intermediate data, and subagent handoff files live there instead of changing the working tree. Parent agents and their subagents share the same local root. The files remain associated with the session when it is resumed, but they are not project files or a replacement for durable documentation that belongs in the repository.

Agents can create or replace a local file with `write`, and can update a previously read text file with `edit`. Every resolved path is kept lexically within the session root, so `..` traversal is rejected. Read resolution additionally follows symlinks and rejects any that resolve outside the root; write and edit resolution is lexical only, so an existing in-root symlink can still redirect a mutation elsewhere.

## URL syntax

Internal URLs use `scheme://target`. Pass the complete URL anywhere a tool accepts a readable path. The `read` tool supports its normal selectors on most built-in schemes:

| Form | Effect |
| --- | --- |
| `scheme://` | List or describe the scheme's root when that scheme provides an index |
| `scheme://name` | Read a named resource |
| `scheme://name:50-100` | Read an inclusive line range |
| `scheme://name:raw` | Read the resource without document conversion |

Selectors are not parsed for `mcp://`, server-native MCP resource URIs, or `xd://`. A suffix such as `:50-100` or `:raw` remains part of the resource URI or device name and usually causes lookup to fail. Use the exact MCP resource URI or `xd://<name>` instead.

For selector-capable schemes, percent-encode a literal `:`, `?`, or `#` in a resource name as `%3A`, `%3F`, or `%23`; otherwise it can be interpreted as a selector or URL delimiter. MCP resource URIs are opaque and matched verbatim, so use the exact URI advertised by the server. Availability is session-dependent: for example, `mcp://` needs a connected MCP server, `ssh://` needs a configured host, and `vault://` needs Obsidian integration.

## Built-in schemes

| Scheme | Resource |
| --- | --- |
| `local://` | Session scratch files, plans, and subagent handoffs. Bare `local://` lists the files. |
| `artifact://<id>` | Full output spilled from a tool result. Line selectors can recover only the needed section. |
| `agent://<id>` | A subagent's final output. `agent://<id>/<child>` addresses nested output; JSON outputs also support path or `?q=` extraction. |
| `history://` | Agent transcript index. `history://<id>` reads a live, parked, or persisted agent transcript. |
| `omp://` | Documentation bundled with OMP. Bare `omp://` lists the available documents. |
| `issue://` and `pr://` | GitHub issues and pull requests for the current or named repository. Add a number for one item, such as `issue://10389`. |
| `skill://<name>` | An active skill's `SKILL.md`; append a relative path for another file in the skill directory. |
| `rule://<name>` | The content of an active rule. |
| `memory://root` | Project memory files. `memory://<id>` reads a full Mnemopi row when that backend is active. |
| `mcp://<resource-uri>` | A resource advertised by a connected MCP server. Server-native resource schemes can also be read directly. |
| `ssh://<host>/<path>` | A remote UTF-8 file or directory on a configured OpenSSH destination. Bare `ssh://` lists configured hosts. |
| `vault://` | Obsidian vaults, notes, and vault queries when the integration is available. |
| `security://` | Stored security scans and findings when security tools are enabled. |
| `xd://` | Mounted tool devices. Bare `xd://` lists devices; `xd://<name>` documents one device's input. |

Most internal resources are read-only. Use the resource's dedicated tool or documented write path rather than assuming that a `write` call is supported. Important exceptions include session-local files through `local://`, remote files through `ssh://`, configured Obsidian resources through `vault://`, and device dispatch through `xd://`.

## Related references

- [`read` tool runtime](./tools/read.md) — selectors, conversion, limits, and routing details
- [`write` tool runtime](./tools/write.md) — writable internal resources and tool devices
- [Memory](./memory.md) — memory backends and `memory://` forms
- [MCP configuration](./mcp-config.md) — connecting servers that advertise resources
- [Agent Hub](./agent-hub.md) — subagent outputs and transcript lifecycle
