# Placement and packaging

Placement answers two questions that should be decided together:

1. Where should this code execute?
2. Which verified Python environment will exist there?

Start with [Installation](../getting-started/installation.md) if you only need to install and load an extension. This guide covers the execution boundary, named-worker state, wheel constraints, lockfiles, install layers, and the registry trust chain in detail.

## Choose a placement

A device declaration records a `Place`. The supported spellings are:

| Declaration | Parsed value | Use it when |
|---|---|---|
| `"host"` | `Place.HOST` | The body primarily coordinates omp APIs and does not need persistent worker state. |
| `"env"` | `Place.ENV` | The body should execute in Environment placement. |
| `"worker:<name>"` | `Place.worker(name)` | Calls need a named, supervised generation or reusable process state. |

`Place.parse()` is the parser used by the declaration surface. Named workers accept letters, digits, `.`, `_`, and `-`.

```python
import omp

host = omp.Place.parse("host")
environment = omp.Place.parse("env")
index = omp.Place.worker("code-index")

assert str(index) == "worker:code-index"
```

A `Place` describes call locality. A `Site` answers a different question: where a **named worker process** is realized.

| Site | Meaning |
|---|---|
| `Site.ENV` | Environment-owned worker site. This is the `WorkerSpec` default. |
| `Site.LOCAL` | Local worker site. |
| `Site.attached(process, ready=...)` | Worker carried by an attached named process, with optional readiness data. |

Do not use `Site` as a `place=` value. A device uses `place="worker:index"`; the `WorkerSpec` named `index` separately chooses `Site.ENV`, `Site.LOCAL`, or an attached process.

## Understand the scopes

It is useful to distinguish four scopes, even though only three `PlaceKind` values exist.

### Host scope

`Place.HOST` executes through the host that loaded the extension. This is the right scope for orchestration: reading host-managed state, calling control-backed APIs, and deciding which lower-level operation to perform.

Host placement does not create a named worker generation. State in ordinary module globals therefore belongs to the extension host's lifetime and concurrency model, not to a `WorkerSpec`.

### Environment scope

`Place.ENV` selects Environment placement without naming a persistent generation. Use it when locality to the Environment is the primary requirement and the work does not need a declared named-worker lifecycle.

Placement is not a serialization exemption: arguments and results still cross the boundary. Keep inputs compact and return compact values or explicit `Spill` buffers.

### Named-worker generation scope

`Place.WORKER` is always paired with a name. The corresponding `WorkerSpec` declares lifecycle and process properties:

```python
import omp

omp.workers.declare(
    omp.WorkerSpec(
        name="index",
        site=omp.Site.ENV,
        idle_ttl=omp.Duration("7m"),
        max_concurrency=2,
        max_calls=10_000,
        restart=omp.Restart.ON_FAILURE,
        resources=omp.WorkerResources(
            memory_bytes=2 * 1024**3,
            cpu_shares=2.0,
        ),
        warm=True,
    )
)
```

The supervisor identifies a live process by both `name` and `generation`. `workers.get("index")` succeeds only for a `READY` observation and returns a `WorkerHandle` fenced to that generation. If the generation changes, operations fail with `WorkerEvicted` rather than silently switching a held handle to a replacement process.

This fence is what makes persistent state predictable:

- State may persist across calls to the same generation.
- A restart, eviction, or replacement creates a boundary; reacquire the handle.
- `WorkerInfo` reports the current generation, state, call counts, in-flight count, cached-code count, enforced resource fields, and an optional fault.

```python
worker = await omp.workers.get("index")
try:
    result = await worker.call(query_index, "WorkerSpec")
except omp.WorkerEvicted:
    worker = await omp.workers.get("index")
    result = await worker.call(query_index, "WorkerSpec")
```

### Raw session scope

A raw worker session is not a fourth placement kind. It is a borrowed connection to one named worker generation:

```python
worker = await omp.workers.get("index")
async with worker.session() as session:
    # omp_remote.Session.call is blocking.
    result = await asyncio.to_thread(session.call, query_index, "SiteTree")
```

Entering the context asks the supervisor for a generation-specific endpoint. The client validates the endpoint generation, connects over Unix or TCP, decodes the optional base64 authentication key, and constructs `omp_remote.Session`. Exiting closes the session in a thread.

Prefer `await worker.call(...)` unless you specifically need direct session semantics; it performs the thread handoff for you.

## State, concurrency, and lifecycle

`WorkerSpec.max_concurrency` declares the worker's concurrency ceiling to the supervisor. That number does not make your Python state thread-safe. If functions mutate module globals, protect the invariant or leave the value at `1`.

The current `WorkerHandle.map()` implementation is deliberately serial:

```python
results = await worker.map(parse_one, paths, concurrency=4)
```

`concurrency=4` is validated as positive, but it is reserved and does not fan out calls. The method awaits each call in input order. If you need concurrent calls now, create them explicitly and stay within the declared worker limit:

```python
async with asyncio.TaskGroup() as group:
    tasks = [group.create_task(worker.call(parse_one, path)) for path in paths]
results = [task.result() for task in tasks]
```

Worker lifecycle operations have intentionally different failure behavior:

- `await handle.info()` requires a valid supervisor observation.
- `await handle.state()` returns `WorkerState.FAILED` when the host is disconnected, unwired, or the worker is unavailable.
- `await omp.workers.list()` returns `[]` for those same observation failures.
- `await omp.workers.evict(name)` returns `False` when eviction cannot reach the supervisor.
- `await handle.stop()` is a no-op for disconnected, unwired, unavailable, or already-evicted generations.
- `await omp.workers.restart(name)` is strict and wraps failure as `WorkerUnavailable`.

Cold `get()` calls are bounded by `workers.MAX_CONCURRENT_SPAWNS == 4`. The public population constant is `MAX_WORKERS == 8`.

### Return large byte buffers explicitly

`workers.RESULT_SPILL_BYTES` is 256 KiB. When a worker result is a large byte buffer intended for Environment-side blob storage, return `Spill`:

```python
def render(rows: list[dict[str, object]]) -> omp.Spill:
    body = render_html(rows).encode()
    return omp.Spill(body, media_type="text/html")
```

`Spill` is only a marker: it contains `value: bytes` and a media type. Whether and how the host materializes the blob is controlled outside the dataclass.

## Package for the embedded runtime

An omp extension is installed as a Python distribution into the embedded free-threaded CPython runtime. The resolver and lock implementation enforce these runtime facts:

- Python requirement: `==3.14.*`.
- ABI recorded by the lock: `cp314t`.
- Accepted wheel ABI components: `cp314t`, `abi3t`, and `none`.
- Resolution uses `uv pip compile` for Python 3.14 and the target platform.
- `--only-binary :all:` is mandatory in the resolver path, so an unavailable wheel is a resolution error rather than an implicit source build.
- Index selection uses `first-index`, preventing candidates for one name from being merged across indexes.
- Requirements conflicting with distributions frozen into the runtime are rejected before `uv` runs.

A pure-Python wheel normally uses a compatible `none` ABI tag. A native dependency must publish a wheel accepted by the free-threaded target. A `cp314` wheel built for the GIL-enabled ABI is not interchangeable with `cp314t`.

```toml
[project]
name = "acme-index-extension"
version = "1.0.0"
requires-python = "==3.14.*"
dependencies = [
  "msgpack>=1.0",
]
```

> **Warning** Do not assume an sdist will be built on the destination. The resolver explicitly requests binary artifacts only.

### One site tree per host resolution

Before extension code starts, the host installs a package snapshot describing one materialized site tree. `omp.packages` exposes that read-only snapshot:

```python
from omp import packages

site = packages.site()
current = packages.own()

print(site.path, site.layer, site.tier, site.resolution)
print(current.name, current.version, current.blake3)
```

The snapshot includes store-backed, frozen, and linked origins. `packages.of(module)` consults the host-provided ownership map and walks parent module names; it does not import the module. `Distribution.verify(deep=True)` invokes the verifier installed by the host and raises `IntegrityError` if verification is unavailable or fails.

A named worker inherits the environment provided at its site. Placement does not resolve undeclared dependencies. Package every imported dependency and make sure the lock contains a wheel for each materializing target.

## Read the lockfile as a security input

The current lock format is version 2. It records:

- the owning install layer;
- `requires_python = "==3.14.*"` and `abi = "cp314t"`;
- materialization targets;
- ordered indexes and `index_strategy = "first-index"`;
- each extension's exact version, selected features, tier, optional sharing pool, source, shipping level, and manifest/declaration/capability digests;
- the extension wheel's filename, tag, byte length, BLAKE3 digest, and SHA-256 digest;
- the exact dependency closure and target-specific wheels;
- distributions frozen into the runtime.

Locks fail closed on reader-critical drift. A newer lock version, wrong layer, wrong Python/ABI, non-first-index strategy, duplicate extension id, incomplete digest set, or non-reproducible link source is rejected. Feature lists must be non-empty, trimmed, unique, and lexically sorted. One host resolution cannot contain two versions of the same normalized distribution.

Development `link` and `path` selections belong to the local install record and intentionally do not produce the verified package snapshot used for reproducible installed extensions.

## Follow the artifact trust chain

The registry path uses separate publisher and registry authorities. The checked-in verifier implements the following chain:

1. **Signed index snapshot.** The registry snapshot is canonical JSON signed with the configured index Ed25519 key. Verification checks the index format, issuance and expiry window, sorted unique identities, release structure, canonical capability-graph digest, and complete artifact hash fields.
2. **Target artifact selection.** An index artifact records target, filename, wheel tag, exact byte length, `b3:` BLAKE3-256, `sha256:` SHA-256, and a publisher signature.
3. **Lock pin.** The chosen artifact and its security metadata are copied into `omp.lock`; later operations compare all pinned fields rather than trusting a mutable URL.
4. **Dual-hash verification.** Integrity verification checks byte length, computes BLAKE3, computes SHA-256, and requires both values to match the lock.
5. **Publisher Ed25519 signature.** The publisher signature covers the decoded bytes of `blake3 || sha256 || manifest_capability_digest`. Binding the complete capability graph prevents the artifact's signed identity from being separated from the authority it declares.
6. **Publisher continuity.** The first publisher key is pinned locally. A changed key is refused unless a rotation record names the new key and verifies under the old pinned key.
7. **Revocation.** A signed revocation snapshot is checked against the exact locked version. Stale snapshots warn in ordinary offline mode and reject in strict offline mode.

The index's `attested` release flag is part of the signed registry snapshot. It is distinct from the publisher signature: the publisher authenticates the artifact and declared capability graph, while the signed index authenticates registry metadata and review state.

> **Note** The signature message concatenates the decoded digest bytes, not their textual `b3:` and `sha256:` prefixes.

The Python package snapshot exposes the selected BLAKE3 value as `Distribution.blake3`. SHA-256 remains a lock and verifier concern and is not a `Distribution` field.

## Understand install layers

The extension domain has two layers:

| Layer | Owner | Typical role |
|---|---|---|
| `client` | Operator-owned client layer | Extensions selected by the operator and resolved for the client host. |
| `workspace` | Workspace-owned layer | Extensions selected with the workspace and resolved for the workspace host. |

Each lock belongs to exactly one layer; loading it as the other layer is rejected. Layer is also part of the package snapshot (`SiteTree.layer`) and local grant matching.

Trust tier is independent of layer:

- `sandboxed` is the default, policy-mediated tier.
- `trusted` requires operator approval.

Grants match extension id, publisher, layer, workspace specificity when applicable, capability digest, tier, and shipping level. A broader or older grant does not silently authorize a changed publisher, changed capability set, higher tier, or different shipping level. Persistent grants are written atomically; session-only grants are never serialized as durable authority.

An optional `pool` groups otherwise separate extension resolutions. `SiteTree.pool is None` means no explicit sharing pool. Treat a pool as a concurrency and dependency decision: members share one resolution and therefore must agree on one distribution version per name.

## Put it together

A robust extension separates coordination from persistent computation and checks its installed identity before sensitive work:

```python
import omp
from omp import packages

omp.workers.declare(
    omp.WorkerSpec(
        name="index",
        site=omp.Site.ENV,
        restart=omp.Restart.ON_FAILURE,
        max_concurrency=1,
        resources=omp.WorkerResources(memory_bytes=1024**3),
    )
)

async def run_query(term: str) -> object:
    distribution = packages.own()
    distribution.verify()

    worker = await omp.workers.get("index")
    return await worker.call(query_index, term)
```

The boundaries are explicit:

- the wheel and lock determine which code and dependencies are available;
- the layer and tier determine which host snapshot is active;
- the `Place` determines call locality;
- the `WorkerSpec` determines named-worker lifecycle and requested limits;
- the generation fence determines whether a held handle still identifies the same state.

See [`omp.placement`](../reference/omp.placement.md) for the complete worker API and [`omp.packages`](../reference/omp.packages.md) for every snapshot type and query.
