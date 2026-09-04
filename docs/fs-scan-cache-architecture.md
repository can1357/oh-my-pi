# Filesystem scan cache architecture contract

This document defines the shared Rust filesystem scan cache implemented by `crates/pi-walker` and consumed by native discovery APIs exposed to `packages/coding-agent`.

## Ownership and data model

The cache lives in `crates/pi-walker/src/cache.rs`. It stores owned `CollectedEntry` lists from a directory walk, not final glob, fuzzy, grep, or AST results. `WalkRequest` in `crates/pi-walker/src/lib.rs` applies static filters, ranking, limits, and optional empty-result revalidation around that collection layer.

Current native consumers:

- `crates/pi-natives/src/glob.rs` — opt-in with `GlobOptions.cache`
- `crates/pi-natives/src/fd.rs` (`fuzzyFind`) — opt-in with `FuzzyFindOptions.cache`
- `crates/pi-natives/src/ast.rs` (`astGrep` / `astEdit` discovery) — always cached for directory operands

`crates/pi-natives/src/grep.rs` uses `WalkRequest` for candidate discovery but explicitly sets `.cache(false)`; the current public `GrepOptions` has no cache field.

The N-API DTO layer that bridges walker results to JavaScript lives in `crates/pi-natives/src/iofs.rs`; per its own header, "`pi-walker` owns traversal and cache policy" and `iofs.rs` keeps only the JS-facing shapes and conversions. The public invalidation binding remains `invalidateFsScanCache(path?)` — declared in `iofs.rs` (forwarding to `pi_walker::invalidate_path_string` / `pi_walker::invalidate_all`) and exported in `packages/natives/native/index.d.ts` / `index.js`. Coding-agent mutation helpers live in `packages/coding-agent/src/tools/fs-cache-invalidation.ts`.

## Cache key partitioning

Each cache key is:

- canonicalized root directory
- the complete effective `WalkOptions` value, with only its `cache` bit cleared

Consequently all traversal-affecting options partition entries: hidden and ignore policy, `.git` and `node_modules` pruning, symlink policy, metadata detail, per-directory order, root emission, min/max depth, contents-first traversal, directory-error policy, and same-filesystem policy. Calls that differ in any of those fields do not share a scan. In particular, `follow_links` **is** part of the current key.

High-level `WalkRequest` filters, ranking, result limits, empty-recheck policy, and size-hint policy are not stored directly in the key. Before collection, size-hint policy and max-file-size filtering can promote effective metadata detail to `Full`, which then partitions the underlying scan.

## Collection behavior

`pi-walker` resolves relative roots against current cwd, requires an existing directory, and canonicalizes it when possible. `WalkOptions` controls traversal; consumers explicitly choose their policies rather than inheriting every walker default.

Collected entries contain normalized forward-slash relative paths and file types. `WalkDetail::Full` additionally requests mtime and regular-file size. Cancellation is delivered through the caller-supplied heartbeat.

Traversal-adjacent parallel work uses a shared Rayon pool:

- `PI_WALK_WORKERS` defaults to `4`
- `0` auto-detects available parallelism
- `1` forces serial work
- helper operations parallelize only at 256 or more items

## Freshness and eviction

Global environment-overridable policy:

- `FS_SCAN_CACHE_TTL_MS` — default `1000`
- `FS_SCAN_EMPTY_RECHECK_MS` — default `200`
- `FS_SCAN_CACHE_MAX_ENTRIES` — default `16`

With caching enabled:

- TTL `0` bypasses cache and returns a fresh scan with `cache_age_ms = 0`.
- A hit younger than TTL clones the stored entries and reports its age.
- An expired entry is removed and replaced by a fresh scan.
- After insertion, entries above the configured maximum are evicted oldest-first by creation time.

With caching disabled, collection scans fresh and neither reads nor populates the shared cache. It does not evict an existing cached entry for the same key.

## Empty-result revalidation

`WalkRequest` owns the recheck policy. `EmptyRecheck::Configured` retries once when:

1. the first collection was a nonzero-age cache hit,
2. the result is empty after the request's high-level filter, and
3. cache age is at least `FS_SCAN_EMPTY_RECHECK_MS` (a configured threshold of `0` disables this mode).

The retry runs uncached and does not replace or evict the existing cached entry. `EmptyRecheck::Never` disables it; `AfterMillis(n)` supplies a request-specific age threshold.

Current effects:

- `glob` integrates its compiled glob and node-module policy into `WalkFilter`, so an empty filtered match set can trigger revalidation.
- AST discovery integrates files-only, optional glob, and node-module filtering, so an empty candidate set can trigger revalidation.
- `fuzzyFind` collects with the default all-entry filter and scores afterward. Revalidation therefore covers an empty underlying walk, not a non-empty walk whose entries all score zero.
- `grep` is uncached, so no cache-age recheck applies.

## Consumer policies

- `glob`: `hidden=false`, `gitignore=true`, `cache=false`; skips `.git`; skips `node_modules` unless the pattern mentions it; never follows symlinks; uses path order and pattern-bounded depth; uses full detail only for mtime sorting.
- `fuzzyFind`: `hidden=false`, `gitignore=true`, `cache=false`; skips `.git` and `node_modules`; follows symlinks always; uses minimal detail and path order.
- `astGrep` / `astEdit` directory discovery: `hidden=true`, `gitignore=true`, cache always enabled; skips `.git`; excludes `node_modules` unless the supplied glob mentions it; never follows symlinks; uses minimal detail and path order.
- `grep`: candidate walks skip `.git`, never follow symlinks, use minimal detail, and are uncached.

The TUI `@`-mention autocomplete opts into cached `fuzzyFind`. Coding-agent's grep tool does not populate this cache.

## Invalidation

`invalidateFsScanCache(path?)`:

- with no path, clears all entries
- with a path, removes every entry whose cached root is a prefix of the target

Relative paths resolve against cwd. Invalidation canonicalizes the target; when it no longer exists, it attempts to canonicalize the parent and reattach the filename. This supports create, delete, and rename invalidation.

Coding-agent helpers:

- `invalidateFsScanAfterWrite(path)`
- `invalidateFsScanAfterDelete(path)`
- `invalidateFsScanAfterRename(oldPath, newPath)` — invalidates both sides when different

Current write, hashline, patch, replace, auto-repair, sloppy-edit, and ACP-bridge mutation paths call these helpers after successful changes. Any new filesystem mutation path must do the same.

## Adding a cache consumer

1. Choose stable traversal options and reuse `WalkRequest`; every effective `WalkOptions` difference creates a partition.
2. Put stable candidate filtering in `WalkFilter` when empty-result revalidation should observe it. Post-collection scoring cannot trigger the request's recheck.
3. Use `.cache(false)` for a genuinely fresh request; it bypasses rather than clearing shared state.
4. Select `EmptyRecheck` deliberately. Do not add per-call TTL controls; TTL and default recheck age are global.
5. Invalidate after every successful write, delete, or move; invalidate both sides of a rename.

## Boundaries

- The `DashMap` cache is process-local and is not persisted.
- Entries are full owned scan results, not final tool results.
- Cache hits clone the stored entry vector.
- Sharing occurs only for the same canonical root and complete effective traversal options.
