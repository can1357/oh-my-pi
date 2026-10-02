# Filesystem scan cache architecture contract

This document defines the shared Rust filesystem scan cache implemented by `crates/pi-walker` and consumed by native discovery APIs exposed to `packages/coding-agent`.

## Ownership and data model

The cache lives in `crates/pi-walker/src/cache.rs`. It stores owned `CollectedEntry` lists from a directory walk, not final glob, fuzzy, grep, or AST results. `WalkRequest` in `crates/pi-walker/src/lib.rs` applies static filters, ranking, limits, and optional empty-result revalidation around that collection layer.

Current native consumers:

- `crates/pi-natives/src/glob.rs` — opt-in with `GlobOptions.cache`
- `crates/pi-natives/src/fd.rs` (`fuzzyFind`) — opt-in with `FuzzyFindOptions.cache`
- `crates/pi-natives/src/ast.rs` (`astGrep` / `astEdit` discovery) — requests caching for directory operands on the native filesystem

`crates/pi-natives/src/grep.rs` uses `WalkRequest` for candidate discovery but explicitly sets `.cache(false)`; the current public `GrepOptions` has no cache field.

The N-API DTO layer and native/provider search-root resolution live in `crates/pi-natives/src/iofs.rs`; `pi-walker` owns traversal and cache policy. The public invalidation binding is `invalidateFsScanCache(path?)`, declared in `iofs.rs` (forwarding to `pi_walker::invalidate_path_string` / `pi_walker::invalidate_all`) and exported in `packages/natives/native/index.d.ts` / `index.js`. Coding-agent mutation helpers live in `packages/coding-agent/src/tools/fs-cache-invalidation.ts`.

`glob`, `grep`, `astGrep`, and `astEdit` accept a host-injected `ShellFilesystem`. Any filesystem with a provider bypasses the shared cache, even if the provider redirects the root to a native host path: ignore files, repository markers, and symlink targets outside the root can still differ. `fuzzyFind` remains native-filesystem-only.

## Cache key partitioning

Each cache key is:

- the root path supplied to collection (native discovery callers canonicalize it when possible)
- the complete effective `WalkOptions` value, with only its `cache` bit cleared

Consequently all traversal-affecting options partition entries: hidden and ignore policy, `.git` and `node_modules` pruning, symlink policy, metadata detail, per-directory order, root emission, min/max depth, contents-first traversal, directory-error policy, and same-filesystem policy. Calls that differ in any of those fields do not share a scan. In particular, `follow_links` **is** part of the current key.

High-level `WalkRequest` filters, ranking, result limits, empty-recheck policy, and size-hint policy are not stored directly in the key. Before collection, size-hint policy, mtime ranking, and max-file-size filtering can change effective metadata detail, which then partitions the underlying scan.

## Collection behavior

Native discovery resolves relative roots against cwd, requires an existing directory for directory scans, and canonicalizes it when possible. Provider-aware APIs resolve and inspect roots through the injected filesystem; absolute `scheme://` roots retain their URL spelling. Low-level collection uses its supplied root verbatim. `WalkOptions` controls traversal; consumers explicitly choose their policies rather than inheriting every walker default.

Collected entries contain normalized forward-slash relative paths and file types. `WalkDetail::Full` additionally requests mtime and regular-file size. Cancellation is delivered through the caller-supplied heartbeat.

Traversal-adjacent parallel work uses a shared Rayon pool:

- `PI_WALK_WORKERS` defaults to `4`
- `0` auto-detects available parallelism
- `1` forces serial work
- helper operations parallelize only at 256 or more items

## Freshness and eviction

Global environment-overridable policy (read once on first use):

- `FS_SCAN_CACHE_TTL_MS` — default `1000`
- `FS_SCAN_EMPTY_RECHECK_MS` — default `200`
- `FS_SCAN_CACHE_MAX_ENTRIES` — default `16`
- `FS_SCAN_CACHE_MAX_BYTES` — default `67108864` (64 MiB of retained vector and path-string allocations)

With caching enabled:

- TTL, entry limit, or byte limit `0` bypasses the cache and returns a fresh scan with `cache_age_ms = 0`.
- A hit younger than TTL clones the stored entries outside the cache lock and reports its age. Cancellation is checked before and after copying.
- Each lookup or insertion removes all expired entries. Idle processes retain at most the configured payload budget until the next cache operation; there is no background expiration thread.
- Insertion evicts oldest entries until both limits are satisfied. The byte budget counts vector capacity and string capacity; it excludes allocator overhead, bounded map metadata, and caller-owned results.
- An oversized scan or one already older than TTL is returned without retaining another copy. Concurrent scans cannot replace a newer scan with an older result.

With caching disabled, or with an injected filesystem provider, collection scans fresh and neither reads nor populates the shared cache. It does not evict an existing cached entry for the same key.

## Empty-result revalidation

`WalkRequest` owns the recheck policy. `EmptyRecheck::Configured` retries once when:

1. the first collection was a nonzero-age cache hit,
2. the result is empty after the request's high-level filter, and
3. cache age is at least `FS_SCAN_EMPTY_RECHECK_MS` (a configured threshold of `0` disables this mode).

The retry runs uncached and does not replace or evict the existing cached entry. `EmptyRecheck::Never` disables it; `AfterMillis(n)` supplies a request-specific age threshold.

Current effects:

- `glob` integrates its compiled glob and node-module policy into `WalkFilter`, so an empty walker-filtered match set can trigger revalidation. Its symlink-aware file-type filter runs afterward and cannot trigger that recheck.
- AST discovery integrates files-only, optional glob, and node-module filtering, so an empty candidate set can trigger revalidation.
- `fuzzyFind` collects with the default all-entry filter and scores afterward. Revalidation therefore covers an empty underlying walk, not a non-empty walk whose entries all score zero.
- `grep` is uncached, so no cache-age recheck applies.

## Consumer policies

- `glob`: `hidden=false`, `gitignore=true`, `cache=false`; skips `.git`; `includeNodeModules` explicitly controls node-module inclusion, defaulting to whether the pattern mentions it; never follows symlinks; uses path order and pattern-bounded depth; uses full detail for mtime sorting.
- `fuzzyFind`: `hidden=false`, `gitignore=true`, `cache=false`; skips `.git` and `node_modules`; follows symlinks always; uses minimal detail and path order.
- `astGrep` / `astEdit` directory discovery: `hidden=true`, `gitignore=true`, cache requested (native-only); skips `.git`; excludes `node_modules` unless the supplied glob mentions it; never follows symlinks; uses minimal detail and path order.
- `grep`: candidate walks skip `.git`, never follow symlinks, and are uncached. They start with minimal detail and request size hints when cheap, promoting native walks to full detail where supported.

The TUI `@`-mention autocomplete opts into cached `fuzzyFind`. Coding-agent's grep tool does not populate this cache.

## Invalidation

`invalidateFsScanCache(path?)`:

- with no path, clears all entries
- with a path, removes every entry whose cached root is a prefix of the target

Invalidation also prevents scans already in flight from repopulating the cache. A path-specific invalidation conservatively prevents admission of other concurrent scans, while preserving existing unrelated entries.

Relative paths resolve against cwd. Invalidation canonicalizes the target; when it no longer exists, it attempts to canonicalize the parent and reattach the filename. This supports create, delete, and rename invalidation.

Coding-agent helpers:

- `invalidateFsScanAfterWrite(path)`
- `invalidateFsScanAfterDelete(path)`
- `invalidateFsScanAfterRename(oldPath, newPath)` — invalidates both sides when different

Current write, edit, auto-repair, conflict-resolution, and ACP-bridge mutation paths call these helpers after successful changes. Any new native-filesystem mutation path must do the same.

Direct native `astEdit` applications do not call these JavaScript helpers or invalidate the walker cache themselves. Their host must invalidate successfully written native paths; provider-backed AST discovery is uncached.

## Adding a cache consumer

1. Choose stable traversal options and reuse `WalkRequest`; every effective `WalkOptions` difference creates a partition.
2. Put stable candidate filtering in `WalkFilter` when empty-result revalidation should observe it. Post-collection scoring cannot trigger the request's recheck.
3. Use `.cache(false)` for a genuinely fresh request; it bypasses rather than clearing shared state.
4. Select `EmptyRecheck` deliberately. Do not add per-call TTL controls; TTL and default recheck age are global.
5. Invalidate after every successful write, delete, or move; invalidate both sides of a rename.

## Boundaries

- The cache is process-local and is not persisted. A mutex makes admission, eviction, expiration, and invalidation atomic; reference-counted payloads allow copying outside that lock.
- Entries are full owned scan results, not final tool results.
- Cache hits clone the stored entry vector.
- Sharing occurs only on a provider-free native filesystem, for the same root spelling and complete effective traversal options. Native discovery callers normally supply a canonical root.

## Measuring the budget

Run `FS_SCAN_CACHE_TTL_MS=60000 cargo run -p pi-walker --example scan-cache-bench -- /path/to/tree` to measure scan allocation bytes, owned-vector copying, and cache hits across 16 traversal-option partitions. Set `FS_SCAN_CACHE_MAX_BYTES` to compare budgets. The example leaves the supplied tree unchanged; use an optimized Cargo profile for timing comparisons.
