# Filesystem listing cache architecture contract

This document defines the shared directory-listing cache implemented by `crates/pi-walker` and consumed by native discovery APIs exposed to `packages/coding-agent`.

## Ownership and data model

The cache lives in `crates/pi-walker/src/walk/cache.rs` (`pi_walker::walk::cache`). It is process-wide and stores **per-directory listings**: the entries of one directory as read from the filesystem, plus the stamps of that directory's ignore files. It does not store per-root entry lists, walk results, or final glob, fuzzy, grep, or AST results. The walker (`pi_walker::walk::walk` / `walk::collect`) consults the cache for each directory it visits and still applies hidden/ignore policy, pruning, filters, ordering, and limits on every walk, so differently configured walks share the same listings.

A directory that has not changed costs one metadata call instead of open + list + close.

Current native consumers:

- `crates/pi-natives/src/glob.rs` — opt-in with `GlobOptions.cache`
- `crates/pi-natives/src/fd.rs` (`fuzzyFind`) — opt-in with `FuzzyFindOptions.cache`
- `crates/pi-natives/src/ast.rs` (`astGrep` / `astEdit` discovery) — always requests caching for directory operands

`crates/pi-natives/src/grep.rs` does not request caching; the public `GrepOptions` has no cache field.

`pi-walker` owns traversal, search-root resolution (`pi_walker::fs::resolve_dir`), and cache policy; the N-API modules only convert options and results. The cache is private to `pi-walker` and exposes no invalidation API.

## Validity rules

Validity rests on the kernel's own change tracking: adding, removing, or renaming an entry moves the directory's mtime and ctime, and replacing it changes its inode.

- A cached listing is reused only while the directory's stamp (device, inode, mtime, ctime) is unchanged.
- The directory's ignore files are revalidated the same way; a changed ignore-file stamp discards the listing.
- A listing whose directory stamp is younger than a 50 ms racy window is never cached (git's "racily clean" rule), so a change landing in the same timestamp tick as the listing cannot be missed. Such directories are listed again.

Because every reuse is checked against the live stamp, the cache is correct without explicit invalidation, and none exists. There is no TTL and no empty-result revalidation.

## Eligibility

A directory listing is read from or written to the cache only when all of these hold:

- the walk runs on the native filesystem (`Fs::Native`); providers (`Fs::Provider(pi_vfs::Fs)`, including `scheme://` roots and any host-injected `ShellFilesystem`) are never cached, even when they redirect to a host path;
- the filesystem reports stable stamps: APFS on macOS; ext4, XFS, Btrfs, tmpfs, F2FS, ZFS, and bcachefs on Linux; NTFS and ReFS on Windows. Network, FUSE, overlay, and other mounts are always listed;
- the walk uses `Detail::Minimal` (file sizes and mtimes change without touching their directory's stamp, so `Detail::Full` walks are never cached);
- the walk's `walk::Options::cache` is `true`.

## Capacity and eviction

The cache is split into 64 shards behind read/write locks. It retains at most about 64 MiB of listings (entry payloads plus a fixed per-entry overhead estimate). When an insertion would exceed the budget, whole shards are dropped. There is no background expiration thread.

## Walk parallelism

`walk::walk` and `walk::collect` use a fixed pool of long-lived workers on the current tokio runtime; pi-walker has no runtime of its own. Workers share a directory queue and retain their sessions and buffers. Dropping the future sets the halt flag and aborts registered tasks, including startup. `walk::walk` returns a `Stream` of `Batch<T> { dir, items }`; unbounded grep scans files on these same workers before sending results. `walk::Tree` is a serial async cursor that spends tokio's coop budget per entry. `PI_WALK_WORKERS` (or `Fs::workers`) sets the worker count:

- a positive `N` uses `N` workers;
- unset or `0` uses the per-filesystem default: 4 on macOS, 8 on Linux, 4 elsewhere and for providers;
- the result is capped by available parallelism.

## Native fast paths

Native walks open child directories with `openat` relative to the parent handle and read listings in bulk: `__getdirentries64` (with its EOF flag) on macOS, plus `getattrlistbulk` for `Detail::Full`; `getdents64` plus `statx` on Linux; `NtQueryDirectoryFile` on Windows. Native syscalls run inline in the async `fs::Session` methods; providers are read by awaiting the async `pi_vfs::Fs`.

## Adding a cache consumer

1. Set `walk::Options::cache = true` and use `Detail::Minimal`; there is nothing else to configure.
2. Do not add per-call TTLs or freshness controls; stamps decide reuse.
3. Mutation paths may call the invalidation helpers to free memory early; they are not required for correctness.

## Boundaries

- The cache is process-local and is not persisted.
- Entries are directory listings, not tool results.
- Sharing occurs only on the native filesystem with stable stamps, across every walk that enables caching, regardless of root or traversal options.

## Measuring

`crates/pi-walker/examples/bench.rs` (walk/glob timing) and `crates/pi-walker/examples/search_bench.rs` (content-search timing) are the timing harnesses; run them with `cargo run --release -p pi-walker --example bench` / `--example search_bench`. Neither modifies the tree it measures.
