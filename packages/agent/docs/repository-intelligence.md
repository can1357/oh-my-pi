# Repository Intelligence Engine

The Repository Intelligence Engine gives OMP Ultra a deterministic, incremental model of the current repository. It exists to answer basic repository questions once, cache the answers, and expose only task-relevant facts to the rest of the harness.

## Runtime path

```text
prompt
  -> cheap Task Router classification
  -> index only when complexity/confidence warrants it
  -> RepositoryProfile + git state
  -> repository signals in Task Router async context
  -> compact repository facts in Context Intelligence
  -> cached workspace scripts for Verification
  -> existing OMP agent loop
```

No LLM call is used for repository discovery. Trivial/high-confidence SIMPLE tasks bypass repository indexing entirely.

## Profile

The profile can contain:

- languages
- strong-evidence frameworks
- package manager
- build and test systems
- entry points with confidence/evidence
- source and test roots
- generated/dependency/build/documentation/ignored classifications
- important subsystem directories
- workspace packages and their scripts/dependencies
- git branch, dirty/changed/staged/untracked state, and merge/rebase state
- last indexed revision and invalidation information

Unknown facts remain unknown rather than being guessed.

## Indexing

Cold indexing uses `git ls-files -co --exclude-standard`, which respects Git's actual ignore rules. Source files are then parsed only for lightweight local import relations and a small declaration-level fallback symbol index.

Warm clean reads use the persistent repository cache without rescanning the file tree. Small dirty changes update only files reported by Git. Package/workspace/lock/build configuration changes, or unusually large change sets, trigger a broader rebuild.

The cache is stored under the user's OS cache directory in:

```text
omp-ultra/repositories/<repo-hash>/repository-index.json
```

No repository-local cache directory is created.

## Queries

The public query surface includes:

```text
findProjectFacts()
findFileOwners()
findWorkspaceForFile()
findLikelyEntryPoints()
findRelevantTests()
findDependencies()
findDependents()
findSymbolDefinition()
findSymbolReferences()
getTaskRepositorySignals()
getRelevantFacts()
```

A symbol provider can be injected by hosts that already have an LSP/indexer. The core package deliberately does not import coding-agent LSP code, avoiding a dependency cycle. Without a provider, the engine uses a conservative TypeScript/JavaScript declaration fallback.

## Integration

Task Router consumes repository size, project type, framework, test presence, relevant file count, subsystem count, and cross-subsystem signals via `AsyncLocalStorage`. Existing classifier logic remains the authority for complexity decisions.

Context Intelligence receives a compact `[Repository Intelligence]` assistant projection at model-call time. It is not persisted into the session and is therefore only provider context, not conversation history.

Verification reuses the existing `readWorkspacePackageScripts()` seam. When a repository profile is registered, Task 03 reads root and workspace scripts from the repository intelligence cache instead of rediscovering package manifests.

## Failure behavior

Repository indexing is best-effort. Git/cache/filesystem failures produce fallback telemetry and leave the normal agent/search tools available. Repository text is treated as data: the engine extracts metadata and never executes instructions found in source files.

## Telemetry

`RepositoryIntelligenceTelemetry` records cache hits/misses, cold/incremental indexing time, files indexed, symbols indexed, dependency-edge count, invalidations, fallbacks, query count, query latency, and the selected indexing mode.

These metrics are intended for later baseline-vs-Ultra benchmarks. No performance improvement is claimed by the first implementation.

## Runtime controls

```text
PI_REPOSITORY_INTELLIGENCE=0
PI_REPOSITORY_CACHE=0
PI_REPOSITORY_MAX_FILES=<count>
PI_REPOSITORY_CONFIDENCE_THRESHOLD=<0..1>
```
