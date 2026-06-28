# Filesystem Scan Cache Architecture Contract

This document defines the current contract for the shared filesystem scan cache implemented in Rust (`crates/pi-natives/src/fs_cache.rs`) and consumed by native discovery/search APIs exposed to `packages/coding-agent`.

## What this cache is

The cache stores full directory-scan entry lists (`GlobMatch[]`) keyed by scan scope, traversal policy, and requested metadata detail. Higher-level operations (`glob` filtering, `fuzzyFind` scoring, and cached `grep` candidate selection) run against those cached entries.

Primary goals:

- avoid repeated filesystem walks for repeated discovery/search calls
- keep consistency across native discovery/search flows when they share the same scan policy
- allow explicit staleness recovery for empty results and explicit invalidation after file mutations

## Ownership and public surface

- Cache implementation and policy: `crates/pi-natives/src/fs_cache.rs`
- Native consumers:
  - `crates/pi-natives/src/glob.rs`
  - `crates/pi-natives/src/fd.rs` (`fuzzyFind`)
  - `crates/pi-natives/src/grep.rs` (cached directory mode only)
  - `crates/pi-natives/src/ast.rs` (`astGrep`/`astEdit` file discovery; always cached)
- JS binding/export:
  - `packages/natives/native/index.d.ts` (`invalidateFsScanCache`)
  - `packages/natives/native/index.js`
- Coding-agent mutation invalidation helpers:
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts`

## Cache key partitioning (hard contract)

Each entry is keyed by:

- canonicalized `root` directory path
- `include_hidden` boolean
- `use_gitignore` boolean
- `skip_node_modules` boolean
- `detail` (`ScanDetail::Minimal` or `ScanDetail::Full`)

Implications:

- Hidden and non-hidden scans do **not** share entries.
- Gitignore-respecting and ignore-disabled scans do **not** share entries.
- Scans that prune `node_modules` do **not** share entries with scans that include it.
- Minimal scans (path + file type only) do **not** share entries with full scans (mtime + regular-file size metadata).
- `follow_links` is part of `ScanOptions` used to build the walker, but is not currently part of `CacheKey`; calls that differ only by `follow_links` can share a cache entry.

Consumers must pass stable semantics for hidden/gitignore/node_modules/detail behavior; changing any keyed flag creates a different cache partition.

## Scan collection behavior

Cache population uses `ignore::WalkBuilder` configured by `include_hidden`, `use_gitignore`, `skip_node_modules`, and `follow_links`:

- sorted by file path
- `.git` is always pruned
- `node_modules` is pruned at traversal time when `skip_node_modules=true`
- cancellation is checked before the walk and every 128 visited entries per parallel visitor
- `ScanDetail::Minimal` records normalized relative path and file type only
- `ScanDetail::Full` also records mtime and regular-file size

Search roots for cache scans are resolved by `fs_cache::resolve_search_path`:

- relative paths are resolved against current cwd
- target must be an existing directory
- root is canonicalized when possible

## Freshness and eviction policy

Global policy (environment-overridable):

- `FS_SCAN_CACHE_TTL_MS` (default `1000`)
- `FS_SCAN_EMPTY_RECHECK_MS` (default `200`)
- `FS_SCAN_CACHE_MAX_ENTRIES` (default `16`)

Behavior:

- `get_or_scan(...)`
  - if TTL is `0`: bypass cache entirely, always fresh scan (`cache_age_ms = 0`)
  - on cache hit within TTL: return cloned cached entries + non-zero `cache_age_ms`
  - on expired hit: evict key, rescan, store fresh entry
- `force_rescan(..., store=false)`: remove any matching key, scan fresh, and do not repopulate cache
- `force_rescan(..., store=true)`: remove any matching key, scan fresh, then store the new entry
- max entry enforcement is oldest-first eviction by `created_at` after insert

## Empty-result fast recheck (separate from normal hits)

Normal cache hit:

- a cache hit inside TTL returns cached entries and does nothing else.

Empty-result fast recheck:

- this is a **caller-side** policy using `ScanResult.cache_age_ms`
- if filtered/query result is empty and cached scan age is at least `empty_recheck_ms()`, caller performs one `force_rescan(..., store=true)` and retries
- intended to reduce stale-negative results when files were added while the cache is still inside TTL

Current consumers:

- `glob`: rechecks when filtered matches are empty and scan age exceeds threshold
- `fuzzyFind` (`fd.rs`): rechecks only when query is non-empty and scored matches are empty
- `grep`: rechecks when cached directory candidate file list is empty
- `astGrep`/`astEdit` (`ast.rs`): recheck when the candidate file list is empty

## Consumer defaults and cache usage

Cache is opt-in on `glob`/`fuzzyFind`/`grep` (`cache?: boolean`, default `false`). `astGrep`/`astEdit` file discovery always uses the cache (there is no opt-in flag).

Current defaults in native APIs:

- `glob`: `hidden=false`, `gitignore=true`, `cache=false`; `node_modules` is included only when `includeNodeModules=true` or the pattern mentions `node_modules`; full detail is used only when `sortByMtime=true`
- `fuzzyFind`: `hidden=false`, `gitignore=true`, `cache=false`, `node_modules` is skipped, `follow_links=true`, minimal detail
- `grep`: `hidden=true`, `gitignore=true`, `cache=false`; cached directory mode skips `node_modules` unless the glob mentions `node_modules`; minimal detail
- `astGrep`/`astEdit` (file discovery): `hidden=true`, `gitignore=true`, always cached; `node_modules` is skipped unless the glob mentions `node_modules`; `follow_links=false`; minimal detail

Current callers:

- `@`-mention fuzzy file autocomplete enables cache (`fuzzyFind` with `cache: true`):
  - `packages/tui/src/autocomplete.ts`
- Mutation flows invalidate through `packages/coding-agent/src/tools/fs-cache-invalidation.ts`.
- Tool-level grep integration (`packages/coding-agent/src/tools/grep.ts`) currently calls native `grep` with `cache: false`.

## Invalidation contract

Native invalidation entrypoint:

- `invalidateFsScanCache(path?: string)`
  - with `path`: remove cache entries whose root is a prefix of the target path
  - without path: clear all scan cache entries

Path handling details:

- relative invalidation paths are resolved against cwd
- invalidation attempts canonicalization
- if target does not exist (for example after delete), fallback canonicalizes the parent and reattaches the filename when possible
- this preserves invalidation behavior for create/delete/rename where one side may not exist

## Coding-agent mutation flow responsibilities

Coding-agent code must invalidate after successful filesystem mutations.

Central helpers:

- `invalidateFsScanAfterWrite(path)`
- `invalidateFsScanAfterDelete(path)`
- `invalidateFsScanAfterRename(oldPath, newPath)` (invalidates both sides when paths differ)

Current mutation callsites include:

- `packages/coding-agent/src/tools/write.ts`
- `packages/coding-agent/src/edit/hashline/filesystem.ts`
- `packages/coding-agent/src/edit/modes/patch.ts`
- `packages/coding-agent/src/edit/modes/replace.ts`

Rule: if a flow mutates filesystem content or location and bypasses these helpers, cache staleness bugs are expected.

## Adding a new cache consumer safely

When introducing cache use in a new scanner/search path:

1. **Use stable scan policy inputs**
   - decide hidden/gitignore/node_modules/detail semantics first
   - pass them consistently to `get_or_scan`/`force_rescan` so cache partitions are intentional

2. **Treat cache data as pre-filtered only by traversal policy**
   - apply tool-specific filtering (glob patterns, type filters, scoring) after retrieval
   - never assume cached entries already reflect your higher-level filters

3. **Implement empty-result fast recheck only for stale-negative risk**
   - use `scan.cache_age_ms >= empty_recheck_ms()`
   - retry once with `force_rescan(..., store=true, ...)`
   - keep this path separate from normal cache-hit logic

4. **Respect no-cache mode explicitly**
   - when caller disables cache, call `force_rescan(..., store=false, ...)` or use an uncached streaming walker
   - do not populate shared cache in a no-cache request path

5. **Wire mutation invalidation for any new write path**
   - after successful write/edit/delete/rename, call the coding-agent invalidation helper
   - for rename/move, invalidate both old and new paths

6. **Do not add per-call TTL knobs**
   - current contract is global policy only (env-configured), no per-request TTL override

## Known boundaries

- Cache scope is process-local in-memory (`DashMap`), not persisted across process restarts.
- Cache stores scan entries, not final tool results.
- `glob`/`fuzzyFind`/cached `grep`/`astGrep` share scan entries only when key dimensions (`root`, `hidden`, `gitignore`, `skip_node_modules`, `detail`) match.
- `.git` is always excluded at scan collection time regardless of caller options.
