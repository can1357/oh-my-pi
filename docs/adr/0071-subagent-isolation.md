# 0071. `/wt` may clone ignored cache directories into new worktrees; subagent isolation is unchanged; ovnfs is not adopted

Status: Proposed 2026-11-14; machine-reviewed (EGM, 3 rounds), not owner-approved
Date: 2026-11-13 (revised 2026-11-14 after three EGM rounds)
Area: runtime

Research: [docs/research/subagent-isolation.md](../research/subagent-isolation.md), Gap 1 of the upstream gap closure ([ledger](../research/upstream-gap-closure.md)). Upstream pin `c308970263` (v18.20.0); omp2 base `origin/omp2 9cb6fd6389`. Citations: `upstream:` is the OMPv1 pin; `ovnfs@c43f05a:` is `stencil-hq/ovnfs` at `c43f05a517`, read from a fresh clone on 2026-11-14; bare paths are omp2. Everything below comes from reading, except one `git ls-files` run (D2). Nothing was built or timed; inference is marked [INFERENCE].

**Review status.** This design was machine-reviewed in three Elephant-Goldfish (EGM) rounds and is **not owner-approved**. Implementation is behind the convar `sv_worktree_clone`, default off. The implementing slice S1 starts only after the measurement S0 meets the threshold in "Slices", and is withdrawn if the owner answers O1 "yes". Review ids (B1, M1, S-01, …) are explained in "What the review changed".

Terms. Classes come from the gap ledger (`docs/research/upstream-gap-closure.md:8`): **a** already covered, **b** not needed, **c** port, **d** propose. An EGM round is one review by four fresh-context reviewer agents and a synthesizer that see only this file and what it cites; the author checks every finding against source before accepting or rejecting it. A **convar** is a typed setting declared in code (ADR 0012); `sv_*` is host or environment policy; `flags: archive` saves a non-default value (`crates/con/src/spec.rs:24-25`); the `PROJECT` flag would let a repository's own cfg set it (`:30-36`). **Cache carry** (this record) means cloning ignored cache directories into a new worktree; it is separate from the existing "uncommitted changes carried over" step of `/wt`. **lintx** is the error-formatting ratchet (`docs/adr/0035-rust-for-the-engine.md:89-90`).

## Context

### The omp2 problem

`/wt [branch]` is a chat command that forks the current checkout into a new git worktree on a new branch and moves the session there: `git stash create`, `git worktree add -b <branch> <path> HEAD`, replay the stash, then copy untracked files git does not ignore (`crates/app/src/chat_services/workspace.rs:26-92`; notice `crates/chat/src/commands/run.rs:307-326`). Ignored dependency and build directories (`node_modules/`, `target/`) are not copied, so the first install or build in the new worktree starts from nothing. On this project's own machines a `target/` holds 17-22 GB per worktree (`docs/adr/0040-remote-build-and-test-execution.md:147-149`). No omp2 user report and no `/wt` timing are recorded; the benefit is measured first (S0).

### What OMPv1 does

- `pi-iso` puts eight copy-on-write backends behind one trait (`upstream:crates/pi-iso/src/lib.rs:8-13`, `:51-71`). On APFS one `clonefile(2)` call clones a whole directory tree, sharing blocks until either side writes (`upstream:crates/pi-iso/src/apfs.rs:1-8`).
- Isolated subagents get a whole-tree copy-on-write view, chosen by `isolation.backend` (`upstream:packages/coding-agent/src/task/settings.ts:41-44`, `upstream:packages/coding-agent/src/task/worktree.ts:629-674`).
- New worktrees are clone-first copies of the source checkout "so ignored build artifacts (node_modules, target) carry over", on by default (`upstream:packages/coding-agent/src/task/settings.ts:83-94`). Callers: `/wt` (`upstream:packages/coding-agent/src/session/session-worktree.ts:149-155`), `omp worktree` (`upstream:packages/coding-agent/src/cli/worktree-cli.ts:153-157`), PR checkout and bash `git worktree add` (`upstream:crates/pi-shell/src/git/mod.rs:17-22`). After cloning, upstream removes every directory at any depth that holds `pyvenv.cfg` or `CMakeCache.txt`; those files record absolute paths and break when moved (`upstream:crates/pi-vcs/src/git/mutate.rs:1842-1872`).
- ovnfs is the external Go daemon `stencil-hq/ovnfs` (`ovnfs@c43f05a:go.mod:1-3`), used by isolated subagents when found on PATH (`upstream:packages/coding-agent/src/task/structured-subagent.ts:907-911`, `upstream:packages/coding-agent/src/task/ovnfs.ts:1-3`). `pi-vfs` is the shell's injectable filesystem and is unrelated to it (`upstream:crates/pi-vfs/src/lib.rs:1-17`).

### What omp2 has

- Subagent isolation (ADR 0007, "Partially implemented", `docs/adr/STATUS.md:19`). Each writing child gets a view built from a manifest, a content-addressed list of the workspace's files: every tracked file and every untracked file git does not ignore, cloned per file (`crates/envd/src/workspace/operations.rs:673-746`, `:1036-1053`). ADR 0007's owner decision of 2026-11-01: "no gitignored path is safe to copy" for that view (`docs/adr/0007-subagent-filesystem-isolation.md:89`, `:93`).
- The clone FFI and its "cannot clone" errno set are private in `operations.rs` (`crates/envd/src/workspace/operations.rs:2051-2108`); `omp-sandbox` has its own macOS copy (`crates/sandbox/src/runtime/macos.rs:176-196`). `omp-core` already depends on `libc` on Unix (`crates/core/Cargo.toml:35-37`), contains `unsafe` code (for example `crates/core/src/exclusive_sync.rs`), and is a dependency of `omp-envd`, `omp-sandbox`, `omp-shell-builtins` and `omp-app` (`crates/envd/Cargo.toml:48`, `crates/sandbox/Cargo.toml:18`, `crates/shell-builtins/Cargo.toml:51`, `crates/app/Cargo.toml:84`).
- Forge checkout checks out a change request's head fetched from the forge, possibly a fork (`crates/envd/src/forge_worktree.rs:248-249`, `:304-306`).
- The v1 importer reports a key with no `legacy.path` as "no v2 equivalent" (`crates/driver/src/v1_import/settings.rs:483-484`); `worktree.clone` has none today.
- CI runs `ubuntu-24.04` and macOS, no Windows job (`.github/workflows/ci.yml:128`, `:457`, `:654`).

### Rules that bind

- Additive only: no existing tool, skill, convar, hook, URL scheme or CLI command changes behaviour, name, schema or revision.
- ADR 0007 decides subagent views (`docs/adr/0007-subagent-filesystem-isolation.md:1`, `:26`); whether its ignored-file rule also covers user worktrees is O1, open.
- ADR 0035: `thiserror` errors with typed sources, no formatted error strings (`docs/adr/0035-rust-for-the-engine.md:55-56`). ADR 0049 D1: vendor tools are extensions; ADR 0036: extensions are Python; ADR 0024: no model-facing tool changes.
- `PHILOSOPHY.md:120-124` (no split without weight), `:140-141` (an unconsumed surface is a guess); `AGENTS.md:133-134` (move, do not copy).

## Decision

Part (a), copy-on-write backends, is class **d**: omp2 takes upstream's benefit, new worktrees that keep their caches, in a narrower shape than upstream's clone-first code. Part (b), ovnfs, is class **b**.

**D1. Subagent isolation is unchanged.** No new backend and no selector: a whole-tree clone, snapshot or overlay exposes ignored files, which ADR 0007 forbids for a subagent view (`upstream:crates/pi-iso/src/apfs.rs:3-8`, `upstream:crates/pi-iso/src/btrfs.rs:1-6`, `upstream:crates/pi-iso/src/overlayfs.rs:1-6`). Whether the D2 allowlist may later apply to subagent views is O15.

**D2. With `sv_worktree_clone` on, `/wt` adds a cache-carry step after its existing flow.** The stash, `git worktree add` and untracked copy run exactly as today, so there is one implementation of tracked, staged and untracked carry. Then:

1. **List.** Run `git ls-files --others --ignored --exclude-standard --directory -z` in the source root and split the raw stdout bytes on NUL into `OsStr` paths (not the lossy `String` helper, `crates/app/src/chat_services/workspace.rs:130-140`). Run on 2026-11-14 with git 2.43.0 in a scratch repository, it listed `node_modules/`, `packages/p/node_modules/` and `target/` as single directory entries and nothing inside a populated submodule. If git fails, the result is `NotListed` and `/wt` still succeeds.
2. **Select** (`select_caches(root, listing) -> Vec<PathBuf>`). An entry is selected when all hold:
   - it is a directory entry (ends in `/`);
   - its final component equals one of `CACHE_DIR_NAMES` = `node_modules`, `.next`, `.nuxt`, `.turbo`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache` (case-sensitive), or it directly holds a `CACHEDIR.TAG` file that begins with `Signature: 8a477f597d28d172789f06886806bc55` (the Cache Directory Tagging signature; ovnfs's `cachedir` predicate, `ovnfs@c43f05a:docs/configuration.md:102`);
   - no ancestor of it is selected.
   The names are ovnfs's `cache` directory list (`ovnfs@c43f05a:docs/configuration.md:77`) minus `.venv`, `.tox` (virtual environments), `__pycache__` (revalidated against source mtimes) and `.gradle` (not examined). Cargo is expected to write a signed tag in `target/` [INFERENCE: `~/.cargo/registry/CACHEDIR.TAG` exists on this machine; a `target/` was not observed]. Nothing else that git ignores is a candidate.
3. **Clone.** Each selected directory is cloned to the same relative path by `omp_core::cow::clone_dir` (D3). Missing parent directories are created first; if the clone fails, parents this step created are removed again. The destination itself is never removed: `clonefile` leaves it absent on error (`crates/sandbox/src/runtime/macos.rs:193-194`), and an existing destination (`EEXIST`) is left as it is. `CloneDirError::Unsupported` skips that candidate as `Unsupported`; `CloneDirError::Failed` skips it as `Failed { kind }`. The step goes on to the next candidate either way.
4. **Prune** (`prune_carried(destination, source_root)`), a walk of each cloned directory, as upstream's prune does (`upstream:crates/pi-vcs/src/git/mutate.rs:1842-1872`): any directory at any depth that holds `pyvenv.cfg` or `CMakeCache.txt` is removed from the clone (counted in `pruned`). If the walk finds a symlink with an absolute target inside the canonical source root, the whole carried directory is removed and reported `AliasesSource`, because writes through such a link would change the source checkout.
5. **Report.** `WorktreeInfo` (`crates/chat/src/overlays/services.rs:947-956`) gains `carry: Option<CacheCarry>`, `None` when the convar is off. `CacheCarry` is `NotListed` or `Done { carried: u32, pruned: u32, skipped: Vec<SkippedCache> }`; `carried` counts directories. `SkippedCache { path: PathBuf, reason: CarrySkip }` holds a path relative to the source root; `CarrySkip` is `Unsupported`, `AliasesSource` or `Failed { kind: io::ErrorKind }`. All derive `Clone, Debug, Eq, PartialEq` like `WorktreeInfo`. Each skip is also logged at debug level. The `/wt` notice (`crates/chat/src/commands/run.rs:317-322`) appends one sentence after its existing text:

| Result | Appended sentence |
|---|---|
| `None` | nothing (the notice is byte-identical to today's) |
| `Done`, `carried` ≥ 1 | `Carried N cache directories.` (`1 cache directory`), followed by ` M skipped.` when `skipped` is not empty |
| `Done`, `carried` 0, `skipped` empty | `No cache directories to carry.` |
| `Done`, `carried` 0, every skip `Unsupported` | `Cache directories were not carried: this filesystem cannot clone them.` |
| `Done`, `carried` 0, other skips | `Cache directories were not carried (M skipped).` |
| `NotListed` | `Cache directories were not carried: git could not list them.` |

What remains exposed, stated rather than hidden: a secret a user puts inside an allowlisted cache directory is carried; a relative symlink is carried as is; tracked and untracked unignored files are copied as today, whatever `sv_sandbox_read_deny` says (O13).

Contract: like the rest of `/wt` today, the step is synchronous, not cancellable and has no size budget; `/wt` already refuses to run during a turn (`crates/chat/src/commands/run.rs:308-310`). No budget is set because `clonefile` work and the prune walk scale with the number of entries, not bytes [INFERENCE]; S0 measures both on this repository's `target/`. A cache directory that another process is writing may be cloned mid-write; its tool rebuilds it.

**D3. The clone primitives move into `omp_core::cow`; nothing is copied.** `crates/core/src/cow.rs` (`pub mod cow`) receives envd's `try_clone_file_cow` and `cow_is_unsupported` as `cow::clone_file` (still `flags = 0`, `crates/envd/src/workspace/operations.rs:2059`) and `cow::is_unsupported`, and `operations.rs` calls them; envd's copy fallback stays in envd. `is_unsupported` also returns true for an error whose kind is `ErrorKind::Unsupported`, which no current envd path produces on macOS or Linux (`:2051-2085`), so envd behaviour is unchanged. New: `cow::clone_dir(source, destination) -> Result<(), CloneDirError>`; on macOS it calls `clonefile(source, destination, CLONE_NOFOLLOW)`, defining `CLONE_NOFOLLOW = 0x1` locally as the sandbox does (`crates/sandbox/src/runtime/macos.rs:178`; `libc` 0.2.191 declares `clonefile` but not the constant); elsewhere it returns `Unsupported` without a syscall. `CloneDirError` is a `thiserror` enum, `Unsupported { #[source] source: io::Error }` and `Failed { #[source] source: io::Error }`, so the app matches variants and never inspects errnos. `omp-core` is the home because every crate that clones already depends on it; the sandbox's copy and a reflinking `cp` can move onto it later (O5, O16). Cost accepted: one workspace-wide rebuild when the module lands.

**D4. Forge checkout and Linux do not carry.** Forge checkout is unchanged: the user's ignored files would sit beside change-request code whose scripts can read them; upstream does carry them there (`upstream:packages/coding-agent/src/task/settings.ts:91-92`; O11). The benefit is macOS-only: omp2 also runs on Linux (CI, cloud sessions), but no Linux CI job could prove a `FICLONE` tree walk's success path, so `clone_dir` is `Unsupported` there and `/wt` says so.

**D5. The convar.** Beside `SV_WORKTREE_BASE` (`crates/envd/src/host_settings.rs:138-148`), with its help text as the `///` doc comment, as there:
`/// Carry ignored dependency and build-cache directories into new /wt worktrees by APFS clone; does not affect forge checkout or subagents.`
`sv_worktree_clone: bool`, default `false`, `flags: archive`, meta `ui.tab: "tasks"`, `ui.group: "Isolation"`, `ui.label: "Carry Caches into New Worktrees"`. Not `PROJECT`, so a repository's own cfg cannot turn on a copy of the user's caches (`crates/con/src/spec.rs:30-36`). No `legacy.path`: v1 `worktree.clone` covered more (whole-checkout clone including `.env`, PR checkout, bash) and defaulted on, so it stays reported as "no v2 equivalent", as ADR 0007 did for `isolation.backend` (`docs/adr/0007-subagent-filesystem-isolation.md:94`). `create_worktree` reads it from `state.con`, as `worktree_base` reads its neighbour (`crates/app/src/chat_services/workspace.rs:111-118`).

**D6. ovnfs is not adopted.** ovnfs sorts paths into rule classes: `source` paths are captured at open; `cache` and `local` paths show the live folder until the checkout writes them; only `hidden` paths are absent (`ovnfs@c43f05a:docs/configuration.md:47-52`). It keeps its own copy-on-write layer behind an NFSv3 (macOS) or FUSE (Linux) mount and uses host cloning only to capture files over 1 MiB (`ovnfs@c43f05a:README.md:12-14`, `ovnfs@c43f05a:docs/internals.md:143-146`), so it is not tied to a filesystem users lack. It is class b on two grounds:
- Its built-in rules class credential names as `local` and ignored paths as `cache` or `local` (`ovnfs@c43f05a:docs/configuration.md:75-81`, `:103`), so a subagent in a default checkout reads every ignored file and secret live, which ADR 0007 forbids.
- It needs a second daemon and a mount with documented edge cases: an undocumented `mount_nfs` socket form on macOS, `fusermount3` and mount-location limits on Linux, forced stops failing in some containers, client-local NFSv3 locks and up to 60 s of stale cache (`ovnfs@c43f05a:docs/platforms.md:15-20`, `:52-54`; `ovnfs@c43f05a:docs/configuration.md:10-11`; `ovnfs@c43f05a:docs/limitations.md:28-30`, `:40-43`). It is not a sandbox (`ovnfs@c43f05a:docs/limitations.md:3`) and core has no seam for it (`crates/proto/proto/omp/env/v1/env.proto:1154-1160`).

What the user does instead: install `ovnfs`, copy its agent skill into `.omp/skills` or `<config root>/agent/skills` (`ovnfs@c43f05a:README.md:114`; `crates/driver/src/discovery/skills.rs:1-12`) and run `ovnfs new`, `diff` and `apply` through the bash tool. Re-entry triggers: a recorded subagent creation or merge time over a budget the owner sets; an owner decision that subagents may see ignored caches read-only; cross-machine isolation on the roadmap. If re-opened: a Python extension over a neutral isolation-provider seam, with `hidden` rules for credentials and ignored paths, after a macOS spike (O9).

If part (a) is withdrawn (S0 fails or O1 is "yes"), it becomes class b and the user runs the install or build in the new worktree, as today.

**D7. Out of this record.** Clone-first worktrees; forge carry (O11); bash `git worktree add` through clones (`upstream:crates/pi-shell/src/git/mod.rs:3-22`); upstream's `worktree.cleanSource` for `/wt` (`upstream:packages/coding-agent/src/task/settings.ts:96-108`); moving the sandbox copy (O16); subagent views (O15); read denials for `/wt` (O13); Windows (O7); `pi-vfs`, declined by Gap 6 (`docs/adr/0054-shell-builtins.md:19`, `:51`).

## Rejected options

| Option | Why rejected |
|---|---|
| Do nothing | Decided by S0: if carry does not meet the threshold, this is the outcome. |
| Clone-first worktrees: port upstream's clone path into `omp-vcs` (round-1 design) | A second `/wt` implementation; the API lacked a new-branch start point (B1); it needs helpers omp2's `mutate.rs` lacks and copies the index byte for byte (`upstream:crates/pi-vcs/src/git/mutate.rs:759-860`). |
| Carry every ignored path minus a credential denylist (round-1 design) | Fails open for any secret the list misses, and duplicates `crates/exec/src/deny.rs:15-38`. |
| Put the primitives in `omp-envd` (round-2 design) | `omp-sandbox` and `omp-shell-builtins` cannot depend on it (`crates/envd/Cargo.toml:69-70`), so a second move would follow (S-06). |
| A new leaf crate | No consumer needs it that `omp-core` does not already serve (`PHILOSOPHY.md:120-124`). |
| A Linux `FICLONE` tree walk | No CI job can prove it (D4). |
| Check `sv_sandbox_read_deny` in the carry step (round-2 design) | It guarded only allowlisted caches while the untracked copy beside it ignores read denials (`crates/app/src/chat_services/workspace.rs:80-90`); decided once for `/wt` in O13. |
| Port all of `pi-iso` | 5,094 lines, trait objects, four untested backends, ADR 0007 conflicts (`upstream:crates/pi-iso/Cargo.toml:13-26`; D1). |
| ovnfs as a Python extension over a new isolation seam | About 1,000 lines of Python and a macOS spike first (estimate), for an unmeasured gain (D6). |
| An `omp-*` virtual-filesystem crate for ovnfs | The brief's shape if adopted, but it reimplements a daemon or embeds Go. |

## Slices

Two slices. S0 is a measurement with no code; S1 is one PR. No slice adds a journal kind, so no golden-journal fixture. No new e2e proof: `/wt` has no joined-system seam beyond `create_worktree_at`, which `crates/app` tests drive with real git repositories.

**S0. Measure before building.** No code. Result recorded in the research note and quoted in S1's PR.
- Protocol. On one APFS Mac (the self-hosted CI Mac or a developer Mac), at one commit of this repository, after `cargo build -p omp-app` and `bun install` in `.omp/tools` in the source checkout. Two states, three runs each, a fresh branch per run:
  - *off*: `git worktree add -b s0-off-<n> <dir> HEAD`;
  - *on*: the same, then `cp -cR` (macOS `cp -c` clones with `clonefile` [INFERENCE: from cp(1), not run here]) of `target/` and `.omp/tools/node_modules/` into the new worktree, then removal of directories holding `pyvenv.cfg` or `CMakeCache.txt` inside the copies (`find -name … -execdir`).
  - In each new worktree: `touch` a marker, run `cargo build -p omp-app` and `bun install --frozen-lockfile` in `.omp/tools`, and record the wall time of (worktree creation + carry), of each first build, and the number of `Compiling` lines.
- Correctness probe: each first build succeeds, and `find <source>/target -newer <marker>` prints nothing (no writes into the source through carried links or paths).
- Threshold: the *on* median of (creation + carry + first `cargo build`) is at least 25% below the *off* median. The `bun install` leg is reported and does not gate (a warm global cache can make it near instant).
- Judge: S1's reviewer reads the recorded numbers in the PR. This is a reviewed, recorded decision, not a CI gate (`AGENTS.md:103-105`: P8-style host timings never gate CI).
- Outcome: met, S1 may start. Not met, S1 is not built and this record is amended to class b.

**S1. `omp_core::cow`, `sv_worktree_clone` and the `/wt` cache carry.** Depends on S0. Files: `crates/core/src/cow.rs` (new) and `crates/core/src/lib.rs`; `crates/envd/src/workspace/operations.rs` (call sites move to `omp_core::cow`); `crates/envd/src/host_settings.rs` (D5); `crates/app/src/chat_services/workspace.rs` (D2: `create_worktree_at(cwd, base, branch)` keeps its signature and delegates to a new `create_worktree_with(cwd, base, branch, carry: bool)`); `crates/chat/src/overlays/services.rs` (types); `crates/chat/src/commands/run.rs` (notice); `crates/chat/tests/pi_commands.rs` (the test double's `WorktreeInfo` literal at `:182` gains `carry: None`, a mechanical edit for the new field).
- Unit tests, `omp-core` (`crates/core/src/cow.rs`): `is_unsupported_accepts_the_os_errno_set_and_the_unsupported_kind` (rows under `cfg`: each OS asserts its own errnos, plus `ErrorKind::Unsupported` true and `ENOENT`, `EACCES`, `ENOSPC` false); `clone_dir_clones_a_nested_tree_and_keeps_a_symlink_a_symlink` (macOS; prints SKIP when a probe `clonefile` in the temp directory returns `Unsupported`); `clone_dir_fails_on_an_existing_destination_and_leaves_it` (macOS; `Failed` with `AlreadyExists`, content unchanged); `clone_dir_is_unsupported_off_macos` (other OSes).
- Unit tests, `omp-app` (`workspace.rs`), all OSes unless noted: `select_caches_keeps_listed_names_and_signed_tags_only` (`node_modules` yes, `Node_modules` no, `.venv` no, unsigned `CACHEDIR.TAG` no, signed yes, a selected directory's descendants not repeated); `select_caches_never_selects_an_ignored_env_file`; `prune_carried_removes_nested_pyvenv_and_cmake_directories` (on a plain tree, no clone needed); `prune_carried_drops_a_cache_with_an_absolute_symlink_into_the_source`; `cache_listing_reads_non_utf8_paths_as_bytes` (Linux); `cache_listing_skips_submodule_contents` (real git with a submodule); `worktree_cache_carry_on_carries_node_modules_and_a_signed_target` (macOS; SKIP as above); `worktree_cache_carry_on_reports_an_existing_destination_as_failed` (macOS); `worktree_cache_carry_on_reports_unsupported_off_macos` (other OSes; `/wt` succeeds). `worktree_carries_uncommitted_changes` passes unchanged (`crates/app/src/chat_services/workspace.rs:159-183`).
- Tests, `omp-chat`: the existing verbatim notice assertion passes unchanged (`crates/chat/tests/pi_commands.rs:660-668`, `carry: None`); new `worktree_notice_appends_the_cache_carry_sentence`, one row per line of the D2 table.
- Unchanged: `worktree_isolation_applies_clean_patch_and_preserves_conflict_recovery` (`crates/app/tests/it/envd_workspace.rs:215`; the macOS job exercises `clone_file` on APFS) and P9 on the Linux job (`.github/workflows/ci.yml:807`, `:882-883`), which exercises the copy fallback.
- Acceptance: with the convar off, `/wt`, its notice and forge checkout are unchanged. With it on, on APFS, the new worktree holds the source's ignored `node_modules/` and signed `target/`, no unlisted ignored directory, no ignored `.env`, no directory holding `pyvenv.cfg` or `CMakeCache.txt`, and no carried directory with an absolute link into the source; the notice matches the D2 table. Off macOS, `/wt` succeeds as today with the "cannot clone" sentence. `just test-pkg omp-core`, `omp-envd`, `omp-app` and `omp-chat` and `just e2e-p9` pass; both lint jobs are clean; no lintx baseline rises.
- Gate: `sv_worktree_clone`, default off. Preconditions: S0 met; O1 not answered "yes".

## Upstream origin and license

No upstream code is drawn on. The behaviour comes from `upstream:packages/coding-agent/src/task/settings.ts:83-94` and the prune rule from `upstream:crates/pi-vcs/src/git/mutate.rs:1842-1872`, both reimplemented; the clone FFI is omp2's own, moved from `omp-envd`; the cache names and the tag rule are conventions listed in ovnfs's documentation (`ovnfs@c43f05a:docs/configuration.md:77`, `:102`; MIT, `ovnfs@c43f05a:LICENSE:1-3`). No NOTICE or `THIRD-PARTY-NOTICES.txt` entry is needed.

## Consequences

- macOS users who turn the convar on get `/wt` worktrees with their dependency and build caches, if S0 shows it pays. With it off, the default, nothing changes.
- Forge checkout, subagents and Linux are unchanged. Subagent isolation keeps its cost; no speedup is promised there.
- `omp-core` gains a small `unsafe` FFI module and is the one owner of the clone primitives omp2 shares; the sandbox's separate copy remains until O16.
- Only the macOS job proves a successful clone; the selection, prune, listing, notice and "cannot clone" paths are proved on Linux too.
- ovnfs stays opt-in through its CLI and skill; nothing in core mentions it.
- On acceptance, ADR 0007's "future targets" sentence (`docs/adr/0007-subagent-filesystem-isolation.md:33-36`) and its OVNFS proposal (`:82-84`) are marked superseded by D1 and D6. This record does not edit ADR 0007.

## Open questions for the owner

- **O1. Open.** Does ADR 0007's "no gitignored path is safe to copy" (`docs/adr/0007-subagent-filesystem-isolation.md:93`) cover user-initiated worktrees? Default taken: no, because ADR 0007 decides subagent views (`:1`, `:26`). Under the gap-closure brief's no-owner rule (`docs/research/upstream-gap-closure-brief.md:88-96`, not yet on `omp2`), S1 may proceed behind its default-off convar; a "yes" withdraws S1 and makes part (a) class b.
- **O2.** Default of `sv_worktree_clone`. Upstream defaults its broader setting on (`upstream:packages/coding-agent/src/task/settings.ts:86`); a v1 user loses carried caches after import. Recommendation: keep it off; flipping it needs its own record after S0 and a release.
- **O4.** The isolated view omits symlinks and empty directories (`crates/envd/src/workspace/operations.rs:709-727`, `:1053`), read, not exercised. Recommendation: file it against ADR 0007 with a failing test; a fix changes the manifest (`MANIFEST_MAGIC`, `:52`).
- **O6.** Who owns `scheme://` paths inside shell commands (`upstream:packages/coding-agent/src/internal-urls/url-filesystem.ts:1-14`)? ADR 0054 declined `pi-vfs` (`docs/adr/0054-shell-builtins.md:51`) without naming one.
- **O7.** Windows: deferred until a Windows CI job exists.
- **O9.** ovnfs: no spike until a D6 trigger fires; a spike checks a Seatbelt-sandboxed (macOS kernel sandbox) child on the NFS mount, `hidden` rules via `ovnfs explain`, and admin protocol drift (`upstream:packages/coding-agent/src/ovnfs/client.ts:21`).
- **O11.** Carry into forge checkout. Recommendation: not until a rule says which of the user's ignored files may sit beside change-request code.
- **O13.** Should `/wt` honour `sv_sandbox_read_deny` (`crates/envd/src/exec_settings/sandbox.rs:297-302`)? Today its untracked copy does not (`crates/app/src/chat_services/workspace.rs:80-90`). Recommendation: decide in a separate record, for the untracked copy and the cache carry together.
- **O14.** A user-configurable carry list (a list convar defaulting to `CACHE_DIR_NAMES`). Recommendation: not before S1 has shipped.
- **O15.** May the D2 allowlist apply to subagent views, where upstream children get `node_modules` and `target` and omp2's do not (`upstream:packages/coding-agent/src/task/structured-subagent.ts:907-911`; `docs/adr/0007-subagent-filesystem-isolation.md:29-30`, `:89`)? Needs an ADR 0007 amendment; not this record's to decide.
- **O16.** Move the sandbox's macOS clone onto `omp_core::cow` (`crates/sandbox/src/runtime/macos.rs:176-196`). Recommendation: a follow-up refactor once S1 lands.
- Resolved in review: O3 (one `/wt` flow), O5 (`cp` can use `omp_core::cow`), O8 (S0), O10 (no crate), O12 (read denials moved to O13).

## What the review changed

Review ids: round 2 used B (blocker), M (major) and m (minor); round 3 used S-nn. Every finding was checked against source; the citations are below.

### Round 1 (before 2026-11-14)

Verdict "changes required". All four findings were confirmed:
- **One in-scope consumer for a new crate.** ADR 0054's `cp` slice has no reflink (`docs/adr/0054-shell-builtins.md:70`). No crate now (D3).
- **`WorktreeClone::Prefer` has no caller.** Its only caller is the napi shim (`upstream:crates/pi-natives/src/vcs.rs:886-892`). Removed with the clone-first design.
- **Ignored-file secrets in forge checkout.** Forge checkout holds fetched change-request code (`crates/envd/src/forge_worktree.rs:248-249`, `:304-306`). No forge carry (D4, O11).
- **O1 answered "No" from ADR 0007.** Confirmed as a reading of its scope (`docs/adr/0007-subagent-filesystem-isolation.md:1`, `:26`); reopened in round 2 because only the owner can answer.
- The ovnfs classification was kept after re-reading upstream and a fresh clone (`ovnfs@c43f05a:docs/configuration.md:75-81`, `:103`).

### Round 2 (2026-11-14): 1 blocker, 19 majors, 17 minors

The blocker and most majors were about the clone-first port, so part (a) was redesigned as a carry step and reclassified from c to d. Some round-2 choices were changed again in round 3 (where the primitives live, the read-deny check, `legacy.path`).
- **B1** (`worktree_add_with` cannot express new-branch-at-HEAD): confirmed (`crates/vcs/src/git/mutate.rs:447-451`; `crates/app/src/chat_services/workspace.rs:66`); resolved by keeping `/wt`'s git flow.
- **M1** withhold mechanism unspecified (`upstream:crates/pi-vcs/src/git/mutate.rs:1842-1872`), **M2** denylist fails open, **M3** duplicate of `crates/exec/src/deny.rs:15-38`: confirmed; replaced by the allowlist.
- **M4** benefit unmeasured (`crates/e2e/src/baseline/workloads.rs:795-830`): confirmed; now S0.
- **M5** O1 marked resolved without the owner: confirmed; reopened.
- **M6** read-deny matching underspecified (`crates/envd/src/exec_sandbox.rs:1337-1342`): confirmed; the check was later removed (S-07).
- **M7** untyped `omp-vcs` failures (`crates/vcs/src/error.rs:126-133`), **M9** diverged `mutate.rs` helpers, **M11** submodules and index copy (`upstream:crates/pi-vcs/src/git/mutate.rs:768-778`), **M15** public `CowError`: confirmed; moot without the clone-first port.
- **M8** chat plumbing missing (`crates/chat/src/commands/run.rs:317-322`; `crates/chat/src/overlays/services.rs:947-956`): confirmed; in S1.
- **M10** synchronous step (`crates/app/src/chat_services/workspace.rs:29-35`): confirmed; contract stated in D2.
- **M12** simplest design rejected on an inference: confirmed; adopted.
- **M13** third FFI copy (`crates/envd/src/workspace/operations.rs:2051-2108`): confirmed; moved, not copied.
- **M14** Linux tree walk unprovable: confirmed; dropped.
- **M16** invariant stronger than the rule, **M17** undefined classes, **M18** `/wt` unexplained, **M19** prune unexplained: confirmed; fixed in the text.
- Minors m1-m17: confirmed against the cited lines and fixed or made moot, except half of m12. Rejected: the review ledger stays because the brief's method requires it, and the virtual-filesystem row stays because it is the brief's own shape for ovnfs.

### Round 3 (2026-11-14): 0 blockers, 12 majors, 12 minors

- **S-01** Linux `Unsupported` path cannot work: confirmed. The Linux errno match ignores `ErrorKind` and the stub error has no raw errno (`crates/envd/src/workspace/operations.rs:2088-2104`). `clone_dir` now returns a typed `CloneDirError`, and `is_unsupported` also accepts `ErrorKind::Unsupported` (D3).
- **S-02** lossy, under-defined `Unsupported` outcome: confirmed (macOS `EXDEV` is per path, `:2093-2095`). `Unsupported` is now a per-candidate skip, the step never stops early, and every result state is listed (D2 step 5 table, `NotListed`).
- **S-03** cleanup could delete pre-existing content: confirmed (`crates/sandbox/src/runtime/macos.rs:193-194`). The destination is never removed; only parents the step created are; a test covers an existing destination (S1).
- **S-04** measurement gate has no protocol: confirmed. S0 gives repositories, runs, median, threshold (25%), correctness probe and judge; D2 states why there is no budget.
- **S-05** work sequenced backwards: confirmed for the measurement (S0 now comes first), and S1 now holds the move and the wiring in one PR. Rejected in part: making an owner answer to O1 a precondition for *starting* S1. The brief allows machine-reviewed work behind a default-off gate when no owner is present (`docs/research/upstream-gap-closure-brief.md:88-96`); a "yes" withdraws S1 (O1).
- **S-06** primitives in `omp-envd` force a second move: confirmed (`crates/core/Cargo.toml:35-37`; `crates/envd/Cargo.toml:69-70`). The round-1 reason for rejecting `omp-core`, a cost cited to `docs/adr/0049-tiered-integration-architecture.md:88-101`, is not in those lines (they are about crate edges and `cap-*` features). Moved to `omp_core::cow` (D3); O5 resolved; O16 added.
- **S-07** report and filter machinery too large: confirmed for the read-deny check, which sat beside an unguarded untracked copy (`crates/app/src/chat_services/workspace.rs:80-90`); removed and deferred to O13. The notice is one sentence; per-skip details go to the debug log. The three skip reasons stay as data for tests.
- **S-08** relocatability check weaker than upstream: confirmed (`upstream:crates/pi-vcs/src/git/mutate.rs:1842-1872` walks to any depth). D2 step 4 now prunes at any depth and drops a carried directory with an absolute link into the source; tests added.
- **S-09** notice text unspecified: confirmed (`crates/chat/tests/pi_commands.rs:660-668` asserts it verbatim). D2 step 5 table and a table-driven test.
- **S-10** selection not testable on Linux: confirmed. `select_caches` and `prune_carried` are separate functions tested on every OS.
- **S-11** the existing test calls a 3-argument `create_worktree_at` (`crates/app/src/chat_services/workspace.rs:174`, `:182`): confirmed. The signature is kept and delegates to `create_worktree_with`.
- **S-12** ovnfs classes undefined: confirmed; D6 now defines them.
- **S-13** tag accepted without its signature: confirmed; the signature is required.
- **S-14** low altitude and process mixed in: confirmed. Title shortened, unused terms (W7, P8) removed, a forward pointer to the review ids added, round entries shortened. The ledger stays (brief method step 6).
- **S-15** stale ledgers and a brief that is not in the tree: confirmed (`docs/adr/STATUS.md:83`; `docs/research/upstream-gap-closure.md:12`). Classes now cite the in-tree ledger (`:8`). The ledgers belong to the gap-closure coordinator and are not edited here.
- **S-16** `legacy.path` maps a broader v1 key: confirmed (`upstream:packages/coding-agent/src/task/settings.ts:83-94`). Mapping removed (D5); `worktree.cleanSource` placed out of scope (D7).
- **S-17** subagent caches gap: confirmed; added as O15.
- **S-18** "Linux desktops not primary" unsourced: confirmed; D4 now says the benefit is macOS-only.
- **S-19** P9 overstated, per-OS errno test: confirmed (`justfile:344-349`; `.github/workflows/ci.yml:807`). S1 now cites the macOS clone test and asserts each OS's own rows.
- **S-20** `CLONE_NOFOLLOW` is missing from `libc` 0.2.191 (checked: `clonefile` is declared at `libc-0.2.191/src/unix/bsd/apple/mod.rs:5192`, the constant nowhere): confirmed; defined locally (D3).
- **S-21** types and wiring details: confirmed (`crates/chat/src/overlays/services.rs:947-956`); D2 and D5 state them.
- **S-22** lossy UTF-8 listing (`crates/app/src/chat_services/workspace.rs:137`): confirmed; raw bytes (D2 step 1) and a test.
- **S-23** readability: confirmed. Steps split, "cache carry" defined, lintx and Seatbelt glossed, `PROJECT` reason given, manifest defined, class-b fallback stated.
- **S-24** `/wt` citation: confirmed; added `upstream:packages/coding-agent/src/session/session-worktree.ts:149-155` and `worktree-cli.ts:153-157`.

Rejected in round 3: part of S-05 (above). No blocker was raised. Machine-reviewed (EGM, 3 rounds), not owner-approved.

## Acceptance tests

1. S0's recorded medians meet the 25% threshold with a clean correctness probe; otherwise S1 is not built (S0).
2. `is_unsupported` accepts each OS's errno set and `ErrorKind::Unsupported`; envd isolation tests and P9 pass unchanged after the move (S1).
3. On macOS, `clone_dir` clones a nested tree and keeps a symlink a symlink, and fails on an existing destination without touching it; elsewhere it is `Unsupported` (S1).
4. `select_caches` keeps only listed names and signed tags, never an ignored `.env`, never a submodule's contents; `prune_carried` removes nested `pyvenv.cfg` and `CMakeCache.txt` directories and drops a cache with an absolute link into the source; all on every OS (S1).
5. With `sv_worktree_clone` off, `/wt`, its notice and forge checkout are unchanged (S1).
6. With it on, on APFS, `/wt` carries `node_modules/` and a signed `target/` and the notice matches the D2 table; off macOS it succeeds with the "cannot clone" sentence (S1).

## Status in omp

**Status: Not started.** Reusable today: the clone FFI and errno set (`crates/envd/src/workspace/operations.rs:2051-2108`), the `/wt` flow and its test (`crates/app/src/chat_services/workspace.rs:35-92`, `:159-183`), the `sv_worktree_base` convar (`crates/envd/src/host_settings.rs:138-148`). Unverified: nothing was built or timed; `clonefile` on a directory holding sockets or fifos, Cargo's signed `CACHEDIR.TAG` in `target/`, and `cp -c` behaviour were not observed.

## References

[docs/research/subagent-isolation.md](../research/subagent-isolation.md); [docs/research/upstream-gap-closure.md](../research/upstream-gap-closure.md); ADR 0007; ADR 0012; ADR 0024; ADR 0035; ADR 0036; ADR 0040; ADR 0049; ADR 0054; `PHILOSOPHY.md`; `crates/app/src/chat_services/workspace.rs`; `crates/chat/src/commands/run.rs`; `crates/chat/src/overlays/services.rs`; `crates/core/Cargo.toml`; `crates/envd/src/workspace/operations.rs`; `crates/envd/src/forge_worktree.rs`; `crates/sandbox/src/runtime/macos.rs`; upstream `crates/pi-iso`, `crates/pi-vcs/src/git/mutate.rs`, `crates/pi-vfs`, `packages/coding-agent/src/task/settings.ts`, `packages/coding-agent/src/session/session-worktree.ts`; `github.com/stencil-hq/ovnfs`.
