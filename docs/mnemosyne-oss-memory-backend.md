# Mnemosyne OSS memory backend

`memory.backend: mnemosyne-oss` runs a user-installed Mnemosyne 4.x Python SDK behind an OMP-owned JSON-RPC worker. It uses ordinary Mnemosyne SQLite stores and banks, so another Mnemosyne client can read the same selected data directory and resolved bank.

This backend is separate from [Mnemopi](./mnemosyne-memory-backend.md). Legacy `memory.backend: mnemosyne` and the top-level `mnemosyne:` object still migrate one way to `mnemopi`; they never select this backend.

## Install

Use Python 3.10 or newer. This backend requires Mnemosyne SDK **major 4**. Current PyPI `mnemosyne-memory` (3.15.1) is rejected on purpose; install 4.x from upstream git into the interpreter selected by `mnemosyne-oss.executable`, your project virtual environment, or `PATH`:

```sh
python -m pip install 'mnemosyne-memory @ git+https://github.com/mnemosyne-oss/mnemosyne.git'
python -m pip install 'mnemosyne-memory[embeddings] @ git+https://github.com/mnemosyne-oss/mnemosyne.git'
```

Upstream `main` currently reports `4.0.0b1`. Pin a commit or tag once you have a known-good 4.x revision. The base package supports lexical recall. The embeddings extra permits local semantic recall. OMP does not install Python packages, parse an SDK CLI, use MCP, or fall back to another memory backend. A missing interpreter, package, supported method, or SDK major version leaves the backend inert with an actionable diagnostic. Tools and `/memory` commands then report that the backend is not initialised; OMP does not pretend the worker is live.

## Configuration

```yaml
memory:
  backend: mnemosyne-oss
mnemosyne-oss:
  executable: /absolute/path/to/python # optional; blank resolves the existing Python runtime
  dataDir: ~/.hermes/mnemosyne/data
  bank: omp-team
  scoping: per-project
  ownership: shared
  autoRecall: true
  autoRetain: true
  localEmbeddings: true
  embeddingModel: null
  localConsolidation: false
  localLlmRepo: null
  localLlmFile: null
  autoMigrate: false
  retainEveryNTurns: 4
  recallLimit: 8
  recallContextTurns: 3
  recallMaxQueryChars: 4000
  injectionTokenLimit: 5000
  requestTimeoutMs: 30000
  sleepTimeoutMs: 120000
  shutdownTimeoutMs: 1500
  debug: false
```

`dataDir` wins over `MNEMOSYNE_DATA_DIR`, which wins over `~/.hermes/mnemosyne/data`. OMP expands `~` and resolves relative data directories against the session working directory. It does not create a replacement store after an invalid path or bank.

`bank` is optional. Unset resolves to `default` for global scope. Explicit names must start with an alphanumeric character and contain only letters, numbers, underscores, and hyphens. Project names are deterministic: OMP sanitizes the cwd basename and adds a stable hash of the absolute cwd; changing an enclosing Git layout does not change the bank.

`scoping` defaults to `per-project`. Use `per-project-tagged` when project-local writes should also recall the configured shared bank.

## Store and bank semantics

- **Store data directory**: the shared Mnemosyne data directory. Its default-bank database is `<dataDir>/mnemosyne.db`; named banks use `<dataDir>/banks/<bank>/mnemosyne.db`.
- **Temporary runtime config**: an OMP-owned temporary directory assigned to `MNEMOSYNE_DATA_DIR` only inside the worker. Mnemosyne's generated runtime config never modifies the shared store configuration.
- **Bank**: a Mnemosyne namespace within one store.
- **Retain bank**: the only bank that receives automatic and explicit OMP writes.
- **Recall banks**: the initialized banks queried by recall, exact reads, and edits.
- **Shared bank**: a bank another client may use. It is never implicitly migrated or deleted.
- **OMP-owned bank**: an explicitly selected non-default retain bank whose `ownership` is `omp`; only this can be cleared by OMP.

Scoping is deterministic:

| `scoping` | Writes | Recall |
| --- | --- | --- |
| `global` | configured shared bank | configured shared bank |
| `per-project` (default) | project bank | project bank |
| `per-project-tagged` | project bank | project bank, then configured shared bank |

Run `/memory status` to see the resolved retain and recall banks. For cross-agent sharing, configure each client with the same data directory and either the same `global` bank or the same resolved project bank. Do not point unrelated writers at an OMP-owned bank.

## Lifecycle

The root session owns one worker. Subagents alias the root worker and may perform explicit memory operations, but never auto-recall, auto-retain, sleep, clear, or shut it down.

- First-turn recall composes the configured recent conversation context, queries every recall bank, and injects an untrusted `<memories>` block. Recall failure or timeout returns no block and never blocks generation.
- Automatic retention writes only the completed root-session suffix. It stores a deterministic source ID and no extraction flags, so assistant prose cannot be converted into instructions.
- OMP persists a hidden `mnemosyne-oss-retention-cursor` custom session entry only after the worker acknowledges a write. Resumed sessions continue after that cursor.
- Pre-compaction recall uses the same fail-open behavior.
- `/memory enqueue` force-retains, then requests Mnemosyne sleep for the retain bank only. Sleep does not consolidate every session in a shared store. Normal disposal retains the final suffix but does not run sleep.

`recall`, `retain`, `reflect`, `memory_edit`, and `learn` call the root session's worker. `read memory://<id>` fetches a full exact record. If an ID exists in more than one recall bank, OMP reports ambiguity rather than choosing a bank. Edits use SDK authorization; OMP does not write SQLite tables directly.

## Local-only execution

The worker starts from a narrow OS/runtime environment allowlist. It drops every inherited `MNEMOSYNE_*` variable (so no hosted embedding or LLM URL or key reaches the SDK) and provider credentials, then sets only variables Mnemosyne 4.0 reads:

- `MNEMOSYNE_NO_EMBEDDINGS` / `MNEMOSYNE_SKIP_EMBEDDINGS` / `MNEMOSYNE_EMBEDDINGS_OFF` for lexical-only recall when `localEmbeddings: false`; otherwise `MNEMOSYNE_EMBEDDING_MODEL` (blank = SDK default local model);
- `MNEMOSYNE_LLM_ENABLED=false` for heuristic/no-LLM consolidation (the default);
- `MNEMOSYNE_LLM_ENABLED=true` with `MNEMOSYNE_LLM_REPO` and `MNEMOSYNE_LLM_FILE` only when `localConsolidation: true` and both `localLlmRepo` and `localLlmFile` are set — the SDK ignores a lone selector and would fall back to its default model;
- `MNEMOSYNE_FORCE_LOCAL=1`, `MNEMOSYNE_AUTO_MIGRATE` from `autoMigrate`, and `MNEMOSYNE_DATA_DIR` pointing at the private runtime config directory.

Local embedding models may download model artifacts through the SDK's local loader. Memory or query content must not be sent to a hosted embedding, LLM, modality, or sync endpoint.

## Worker failure behavior

The worker uses line-delimited JSON-RPC with immutable initialization context. Every request is serialized. Invalid JSON, unexpected output, EOF, or child exit rejects current work and clears the child. Read-only operations may restart once; mutations never replay after an uncertain exit and report an unknown outcome. Cancellation sends `$/cancelRequest`, waits briefly, then terminates an uncooperative synchronous SDK worker. Shutdown closes stdin, escalates TERM/KILL within `shutdownTimeoutMs`, and removes the temporary runtime config directory.

## Clear policy

`/memory clear` fails closed when ownership is `shared`, the retain bank is `default`, or the retain bank intersects `sharedBanks`:

```text
Mnemosyne OSS clear refused: the active bank is shared; configure a non-default bank with mnemosyne-oss.ownership=omp before clearing.
```

For an explicitly OMP-owned non-default bank, the worker closes SDK handles and calls `BankManager.delete_bank(name, force=False)`. It never deletes SQLite files from Bun and never touches another recall bank.
