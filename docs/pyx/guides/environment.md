# Work with the project Environment

Extension code reaches project files, commands, long-running processes, HTTP endpoints, document watches, blobs, and workspace search through `omp.env`. The Environment is invocation-scoped authority: it keeps workspace identity, capability checks, sandboxing, quotas, and remote placement on the host side instead of letting your extension guess where the project lives.

Use [the complete `omp.env` reference](../reference/omp.env.md) when you need every option or value type.

## Start with the current scope

```python
import omp
from omp import env

root = env.info().root
env.require(env.Capability.DOC_READ)
readme = root.join("README.md")
text = await readme.read_text()
```

`env.info()` is local: it returns the cached handshake receipt and performs no I/O. `env.has()` lets you choose an optional path; `env.require()` fails immediately with `Denied` when an operation cannot proceed.

```python
if env.has(env.Capability.SEARCH):
    Python_files = await env.find.files(glob="*.py", limit=100)
```

> **Warning** A scope is not process-global authority. Do not retain Environment handles and assume they remain valid in a later invocation. Stale generations, closed leases, and disconnected transports are explicit failures.

## Understand `EnvPath`

An `omp.EnvPath` names a location in the Environment filesystem namespace. Construct it once from a workspace-relative string, or derive children with `join()`.

```python
config = omp.EnvPath("config").join("extension.toml")
print(config.uri)  # absolute file URI owned by the Environment
```

Environment operations reject `ClientPath`; the two types deliberately prevent you from confusing the user's machine with the workspace host. `EnvPath` is also not an `os.PathLike` value. That matters when an extension is running remotely or inside a sandbox.

Most code should use the awaitable convenience methods:

```python
raw = await config.read_bytes()
text = await config.read_text("utf-8")
```

`local_path()` is an exceptional placement conversion. It succeeds only when the extension body is colocated with the Environment filesystem and the sandbox covers the path. Portable extensions should not build their design around it.

The separate `env.direct_filesystem` object is not a shortcut around this model. It works only for an extension with a declared, durable trusted grant and accepts absolute native paths for a small audited operation set.

## Read and change documents through the authority

Use a document lease when the file may be edited, watched, summarized, or read at a pinned revision. The Environment owns the current head and mediates concurrent changes.

```python
from omp import EnvPath
from omp import env

async with await env.docs.open(EnvPath("src/settings.py")) as doc:
    original = await doc.read()
    await doc.write(original.replace("DEBUG = True", "DEBUG = False"))
```

A lease exposes its `path`, `uri`, and current `revision`. Reads can name a revision. `lines(start, end)` uses a zero-based, half-open range, unlike URL read selectors, which are one-based and inclusive.

For byte-precise changes, pass ordered, non-overlapping edits:

```python
async with await env.docs.open(EnvPath("src/version.py")) as doc:
    result = await doc.edit([
        env.Edit(start=10, end=15, replacement=b'"2.0"'),
    ])
```

Use `dry_run()` when you need the resolved preview before commit. Use `env.docs.transaction()` to group edits, creates, writes, moves, and deletes under one transaction commit.

```python
async with await env.docs.open(EnvPath("src/app.py")) as app:
    txn = env.docs.transaction()
    txn.edit(app, [env.Edit(0, 0, b"# generated header\n")])
    txn.create(EnvPath("src/generated.py"), "VALUE = 1\n")
    outcome = await txn.commit()
```

Conflicting revisioned changes raise `Conflict`; a transaction that made at least one durable edit before failing raises `Partial`. Choose stale and formatting policy where the operation's `**options` accepts it; `OnStale` and `Format` carry the public vocabulary.

## Watch a document

`Doc.events()` is the document watch surface. It returns an async iterator immediately; each `DocEvent` carries ordered revisions and a `DocEventKind`.

```python
async with await env.docs.open(EnvPath("pyproject.toml")) as doc:
    async for event in doc.events():
        if event.kind is env.DocEventKind.WATCH_RESCANNED:
            # Re-read the head because the native watcher had to rescan.
            await doc.refresh()
        elif event.kind is env.DocEventKind.EXTERNAL_MODIFIED:
            latest = await doc.read(revision=event.revision)
```

Treat `WATCH_RESCANNED` as broad invalidation rather than a precise edit. `StreamLost` means event continuity was lost; reopen or re-establish state instead of assuming skipped changes did not matter.

Language-server notifications have a parallel connection-wide stream at `env.lsp.events()`. Query `lsp.bindings(path)` first, and attach a `Doc` to revision-sensitive requests.

## Inspect the raw filesystem

The `env.fs` namespace handles metadata and namespace operations that do not belong to document editing: directory creation and listing, links, permissions, copies, renames, and removal.

```python
assets = EnvPath("assets")
await env.fs.mkdir(assets, parents=True, exist_ok=True)
for child in await env.fs.list_dir(assets):
    print(child.name, child.meta.kind, child.meta.byte_length)
```

Prefer document leases for text mutation. Raw filesystem operations do not provide the document authority's revisioned edit model. Where supported, pass `Revision` fences to mutations such as `remove()`, `rename()`, `copy()`, or `chmod()`.

Symlink operations never perform ambient conversion:

```python
await env.fs.symlink(
    EnvPath("shared/schema.json"),
    EnvPath("config/schema.json"),
    relative=True,
    overwrite=env.Overwrite.REPLACE_FILE,
)
```

## Run a command and stream output

Use `env.sh.run()` when bounded collected output is sufficient. For live output or stdin control, open a session and start a `Run`.

```python
session = env.sh.session(cwd=EnvPath("."))
try:
    run = await session.run("python -m compileall src")
    async for event in run:
        if isinstance(event, env.Output):
            print(event.data.decode("utf-8", errors="replace"), end="")
        else:
            completion = event.status
            print("exit:", completion.exit_code)
finally:
    await session.close()
```

`Run` is an ordered async stream of `Output` frames followed by `Exit`. You can also `await run.wait()` to drain output into a bounded `Completed` receipt. For interactive commands, use `stdin()`, `eof()`, `signal()`, and `resize()`; `cancel()` only requests non-blocking teardown.

```python
completed = await env.sh.run("git status --short", cwd=EnvPath("."))
if completed.outcome is env.Outcome.EXITED:
    print(completed.text())
```

For daemons and servers, use `env.proc`. A named `Process` has a generation fence, retained output, lifecycle states, restart support, and readiness probes.

```python
server = await env.proc.ensure(
    "docs-preview",
    "python -m http.server 8123",
    cwd=EnvPath("site"),
    ready=env.ReadyTcp(8123),
)
print(server.endpoint)
```

## Make scoped HTTP requests

HTTP egress is capability-gated by `Capability.NET` and bounded by the Environment. The response body is bytes; decode it directly or call `json()`.

```python
response = await env.http_get(
    "https://example.test/api/status",
    headers={"accept": "application/json"},
    redirects=3,
)
data = response.json()
```

`redirects` is an integer from zero through ten. Zero returns the first redirect response without following it. The response's `final_url` records the URL that produced it.

## Store an artifact and hand back its URL

Raw Environment blobs are content-addressed and useful for moving bytes between DATA-plane operations. Artifacts add addressability, metadata, and retention.

```python
from omp import artifacts

report = await artifacts.put(
    "# Analysis\n\nNo conflicts found.\n",
    media_type="text/markdown",
    description="Workspace analysis",
)
address = artifacts.url(report)
return {"report": str(address)}
```

For large content, stream bytes through `artifacts.open_write()`:

```python
writer = await artifacts.open_write(
    media_type="application/x-ndjson",
    description="Search matches",
)
async with writer:
    async for match in env.find.search(b"TODO", root=EnvPath("src")):
        await writer.write(match.line_bytes + b"\n")
address = writer.ref.url
```

An `artifact://` address can include a read selector:

```python
from omp import urls

excerpt = await urls.read(address, "1-25:raw")
```

See [artifacts](../reference/omp.artifacts.md) for retention and integrity checks, and [typed URLs](../reference/omp.urls.md) for the complete selector grammar.

## Search the workspace index

`env.find` uses the Environment's workspace walker rather than recursively opening files in Python.

```python
entries = await env.find.files(
    root=EnvPath("src"),
    glob="*.py",
    hidden=False,
    gitignore=True,
    limit=200,
    rank=env.Rank.PATH,
)

async for match in env.find.search(
    "deprecated_api",
    root=EnvPath("src"),
    case=True,
    limit=50,
):
    print(match.path, match.line)
```

Choose `files()` or `grep()` for a bounded collected result and `walk()` or `search()` for streaming. `Follow` controls symbolic-link traversal; leave it at `NEVER` unless crossing links is an intentional part of the task.

`omp.index` serves a different kind of index: static extension catalogs, PEP 691 project metadata, and resolved lock fragments. Its parsers are pure, while `IndexClient` makes network transport explicit. See [the workspace index reference](../reference/omp.index.md).

## Handle failures by category

Environment errors are typed. Catch only the failures your operation can recover from:

```python
try:
    async with await env.docs.open(EnvPath("optional.toml")) as doc:
        return await doc.read()
except env.NotFound:
    return ""
except env.Denied:
    raise  # The extension manifest or current scope does not authorize the read.
```

`QuotaExceeded` carries `quota` and `limit`; `Io` may carry `errno`; `StreamLost` carries `skipped` and `reason`; `Partial` carries committed receipts and `failed_index`. `TimedOut`, `Cancelled`, `Disconnected`, `Stale`, and `StaleGeneration` should not be collapsed into `NotFound` or an empty result.
