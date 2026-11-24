# 0054. Port the missing upstream utility builtins onto the host seam, opt-in per name

Status: Proposed 2026-11-13
Date: 2026-11-13
Area: tools

## Context

- OMPv1 ships in-process utilities in the crate `pi-builtins` (`upstream:crates/pi-builtins/Cargo.toml:11`), one module and one cargo feature per utility (`upstream:crates/pi-builtins/Cargo.toml:208` `util.cp`, `:262` `util.rsync`, `:278` `util.tar`). A macro table registers them (`upstream:crates/pi-builtins/src/extras.rs:48` `cp`, `:86` `rsync`, `:102` `tar`, `:110` `uptime`, `:122` `lsof`), enumerated by `upstream:crates/pi-shell/src/extras.rs:69`. Pinned at `c308970263` (v18.20.0).
- omp2's in-process shell (ADR 0028) registers its utilities in `utility_builtins()` (`crates/shell-builtins/src/factory.rs:29`). Nineteen upstream utilities are missing: cp, chmod, tar, rsync, du, df, dd, env, id, sd, shasum, strings, od, nl, fold, rmdir, lsof, uptime, md5. For each, no `crates/shell-builtins/src/<name>.rs` and no registration exists (`docs/research/shell-builtins.md` §2).
- A missing builtin is not a missing capability: the command runs as an external process under the OS sandbox (ADR 0028 §4, lines 44-47). A builtin is **not** a second layer on top of that. In-process builtins are not under the OS sandbox: policy for them is the in-process path check and nothing else (ADR 0028 §4: "the interpreter's in-process path policy for redirections and builtins, the OS sandbox for spawned processes"). What a builtin changes is which single control applies: the in-process path policy (typed denial that feeds the approval rerun, cancellation, the same behaviour on hosts without the binary) in place of kernel containment of a spawned process. That trade is worth making only where the in-process check is the stronger or more useful one, which is the **path-changing set** (cp, dd, chmod, rmdir, tar, sd). For pure filters and read-only reporters it buys little.
- A builtin shadows the system command of the same name, so enabling one changes what existing commands do (option sets, output, exit statuses, and which control applies). The change must be additive, so it must be opt-in.
- Registration sites (this tree, `grep utility_builtins(`): `crates/envd/src/exec.rs:834` (agent bash sessions), `crates/envd/src/shell_child.rs:51` (detached process scripts re-entering `omp`, see its header), `crates/app/src/shell_cmd.rs:41` (the interactive CLI shell) and `crates/shell-builtins/src/bin/omp-sh.rs:83` (standalone `omp-sh`). Every `default_builtins()` site outside those four is a test (`crates/shell/src/commands.rs:1316, :1457`, `crates/shell/src/shell.rs:772`, `crates/shell-builtins/tests/dyn.rs:144`). The comment at `factory.rs:22-27` says an embedder "may withhold destructive utilities"; none does.
- `sv_shell_embedded_builtins` (`crates/envd/src/exec_settings/shell.rs:95`) does not suppress registration today: its only consumer is the prompt text `enabled/disabled` (`crates/tools/src/shell.rs:460`, fed from `crates/envd/src/tools/registry.rs:1322`), while `exec.rs:832-842` installs the utility set unconditionally.
- Research: `docs/research/shell-builtins.md` (per-builtin table, upstream sizes, platform and sandbox concerns, license).

## Decision

**D1. Port 18 of the 19; do not port `rsync`.** Each port copies the upstream module and replaces its filesystem seam (`pi_vfs` and `uucore` calls) with the omp2 host: reads through `Host::open_read` (`host.rs:273`), spawns through `Host::command` (`host.rs:345`), pid visibility through `may_observe` (`host.rs:322`), and **writes through a new fd-relative seam (D4), not `ensure_writable` alone**.

**D2. Opt-in per name; nothing changes by default.** A new convar `sv_shell_builtins_extra: Vec<Str>`, default empty, `flags: archive` only (declared beside `SV_SHELL_EMBEDDED_BUILTINS`; the vector form and `validate` hook have precedent at `crates/envd/src/exec_settings/sandbox.rs:254`). It lists the names to register; the keyword `all` means every name `extra_builtins` offers in that build. A new factory function `extra_builtins(enabled)` returns only those. `utility_builtins()` and every existing registration are untouched.
- **No `PROJECT` flag.** A repository's `.omp/<name>.cfg` runs with project authority (ADR 0012, `docs/adr/0012-convars.md:77`: "a convar without [`PROJECT`] is unreachable from a project cfg"). A project must not be able to change whether `cp`, `dd` or `chmod` is shadowed.
- **Precedence.** `sv_shell_embedded_builtins = false` suppresses the extras. This ADR makes the extras honour that convar; making the existing utilities honour it is a behaviour change and stays out of scope.
- **Timing.** The value is read once, when a shell is constructed (`crates/envd/src/exec.rs:827` builder); a change applies to shells built afterwards.
- **Entry points.** Agent bash sessions (`exec.rs:834`) and detached process scripts (`shell_child.rs:51`, which must be handed the enabled set by its parent) get the extras. The interactive CLI shell (`app/src/shell_cmd.rs:41`) and `omp-sh` (`omp-sh.rs:83`) do not: they are human shells on the user's own PATH.

**D3. Scope order.** The path-changing set (cp, dd, chmod, rmdir, tar, sd) comes first. The rest (md5, shasum, fold, nl, od, strings, uptime, id, lsof, du, df, env) is gated on usage evidence (see slices 7-10 and O1): no work starts for a name without it.

**D4. Writes use an fd-relative, no-follow path before any destructive builtin lands.** Today a builtin write checks a path and then opens it by name: `Host::ensure_writable` resolves the path lexically and returns it (`host.rs:300-307`); callers then open that string (`find.rs:4068`, `ln.rs:479`, `mv.rs:1075`). Nothing pins the file between check and open, so a symlink swapped in between redirects the write. The sandbox has the right primitive: `PathPolicy::open` (`crates/shell/src/interp.rs:111`, request `OpenRequest{access, create_mode}` with `PathAccess::{CreateNew, Truncate, Append, ReadWrite, Write}`) is implemented by `FilePolicy::open` (`crates/envd/src/exec_sandbox.rs:1002`), which admits once, then opens the judged physical path with `O_NOFOLLOW` on every component and refuses a walk that followed a link. The new builtins write only through a new `Host::open_write(path, access)` built on that call (mirroring `open_read`, `host.rs:273`). Directory work (`rmdir`, recursive `cp` and `chmod -R`, `tar` extraction) uses `support/safe_traversal.rs` after it is fixed: `DirFd::open` ignores its `symlink_behavior` argument (`safe_traversal.rs:38-40`, `let _ = symlink_behavior`) and applies `NOFOLLOW` to the final component only, so new directory work walks per component through a new `DirFd::open_walk` instead. `DirFd::open` and `open_subdir` are left as they are: `rm` already consumes them (`crates/shell-builtins/src/rm.rs`, three `DirFd::open` calls and one `open_subdir` call, all passing `Follow`) and has always received a single `O_NOFOLLOW` open, so honouring `symlink_behavior` there would change `rm`. Re-pointing `rm` at the walk is its own slice, with its own tests.

**D5. Devices are refused explicitly.** `FilePolicy::admit_write` (`exec_sandbox.rs:970`) excepts only `/dev/null` (`:976`; `grep` for `/dev` in the file finds only `/dev/null` at :940, :976, :1031 and a `curl` argument at :2109`). Refusal of any other device is implicit and has no test. A write-deny test naming a device path, and an explicit refusal if that test does not already pass, is a precondition of the `dd` slice (O4 answered: refuse unless the policy lists the path).

**D6. Static analysis learns the enabled set; the old entry point stays.** `analyze(program, cwd, root)` (`crates/shell/src/analysis.rs:21`) takes no enabled set and keys its arms by command name, so an unconditional arm for `chmod`, `tar` or `sd` would change approvals for people running the external command. Add a new function, `analyze_with(program, cwd, root, enabled)`, and keep `analyze` delegating to it with an empty set; the arms for `chmod`, `tar`, `sd` apply only when the name is enabled. The one production caller (`crates/envd/src/admission.rs:768`) passes the session's enabled set. Existing defect, out of scope: the `cp` arm drops operands that start with `-` (`analysis.rs:516`), so `cp -t /etc src` records no write.

**D7. Where builtins live.** Builtins run in the environment host's in-process shell, which is the sandbox (stub) side of the ADR 0006 boundary; they never call into host authority. They reach policy only through `Host` policy objects (`PathPolicy`, the spawn wrapper, the process scope) that the environment host installs from the `sv_sandbox_*` convars, and they are not under the OS sandbox (ADR 0028 §4). Output is bounded by the transport (ADR 0009, `0009-bound-output-once.md`); builtins only honour cancellation. No new tool, role or roster entry (ADR 0024), no vendor code (ADR 0049), no new language runtime (ADR 0035, ADR 0036).

**D8. `tar`'s crates are behind `cap-shell-archive`.** `tar`, `bzip2` and `lzma-rust2` are not in the workspace. `omp-shell-builtins` has no `[features]` table today (`crates/shell-builtins/Cargo.toml`); this is its first. The feature must be forwarded through `omp-envd` (`crates/envd/Cargo.toml:17-22` style) and `omp-app` (`crates/app/Cargo.toml:36-43` style), or a build of `omp-app` cannot turn it on. Without the feature, naming `tar` in the convar is a validation error.

**D9. `rsync` is not shadowed (class b).** A system `rsync` runs as a spawned process under the OS sandbox and, in `scoped` network mode, the egress broker (ADR 0028 §4). The upstream implementation is a clean-room protocol 29-33 client, server and daemon (`upstream:crates/pi-builtins/src/rsync.rs:1`), 2144097 B over 67 files, with raw sockets that would bypass the broker. Local copies are served by `cp -a` once slice 4 lands.

**D10. Destructive builtins are opt-in like the rest.** There is no "withheld" mechanism to copy: `rm`, `mv` and `ln` are installed everywhere today. Moving any name to on-by-default is a later amendment, per name, after its write-deny and symlink-race tests have run in a release (O2 answered).

**D11. Shared helpers are ported with the first slice that needs them,** into `src/support/`: `bre`, `locale`, `block_size`, `quoting_style`, `time_zone`, `atomic_write`, `file_backup`, `progress`, `openfile`. `nl` needs upstream's `bre::bre_to_ere(&str, Backrefs) -> Result<String, BreError>` (`upstream:crates/pi-builtins/src/bre.rs:51`, called at `nl.rs:217`). omp2's `sed.rs:1139` has `fn bre_to_ere(pattern: &str) -> String`; the signatures differ, so the two are not interchangeable. `support/bre.rs` is added with the upstream signature and `sed.rs` keeps its own converter.

**D12. No `pi` identity in ported code.** Crate, feature, convar and message names use `omp-*`, `cap-*`, `sv_*`; strings such as upstream's "not a pi extra" are renamed. Errors follow ADR 0035.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Depend on `pi-vfs` and `uucore` and port unchanged | omp2 has neither (`crates/shell-builtins/Cargo.toml`). A second filesystem seam beside the path policy lets a builtin skip the policy, and `pi` names enter omp2. |
| Compose the commands from existing builtins | Would not reach GNU/uutils option sets, exit statuses and diagnostics, which is the product. |
| Leave all 19 external | Correct for `rsync` and, until usage evidence says otherwise, for the evidence-gated set. For the path-changing set it forgoes the typed in-process denial and the approval rerun it enables (ADR 0028 §4). |
| Register all 18 by default | Changes the behaviour of commands users already run, and none of the path-changing builtins has yet had a release under write-deny and race tests. Not additive. |
| Register each only when no system binary exists on `PATH` | Rejected as the rule. The same command line would behave differently per host, and per `PATH`, which makes tests and bug reports non-reproducible; the lookup is itself a probe of the host. It also removes the builtin exactly where the in-process check matters (a real `cp` is on every Unix `PATH`). Its useful part, covering hosts that lack a binary, is served by naming the command in the convar on such hosts. |
| Per-utility cargo features, like upstream `util.<name>` | A build-time control with no stated user in omp2; the convar gives the same control at run time. Only `tar`'s crates earn a feature (D8). |
| Ship them as an extension | Extensions are Python (ADR 0036) and these are core shell commands with no vendor involved (ADR 0049). |
| Reuse `sv_shell_embedded_builtins` as the switch | It is a bool, default true (`shell.rs:95`); reusing it to mean "also the new ones" would change behaviour for everyone who has it on. It is kept as a master off switch instead (D2). |
| A `PROJECT`-flagged convar | A repository could then decide whether `cp` is in-process (ADR 0012 project authority). |

## Slices

Each slice is one PR. Every slice after 1 is gated by the convar (default empty); slice 6 also by `cap-shell-archive`. Acceptance command: `just test-pkg omp-shell-builtins` (`justfile:294`). ADR 0040 (still `Status: proposed`, line 3) classes `just test-pkg <crate>` as `RemotePreferred` (line 632); until its router exists the Linux run is `just remote-test-pkg omp-shell-builtins` (`justfile:129`, a plain recipe over `scripts/remote-verify.sh`), not an ADR 0040 placement. Windows: no workflow under `.github/workflows/` mentions Windows, so there is nowhere to run Windows tests today; see O2.

| # | Contents | Acceptance tests |
|---|---|---|
| 1 | Gate: convar (archive only), `extra_builtins(enabled)`, wiring at `exec.rs:834` and `shell_child.rs:51` (parent passes the set to the child), `analyze_with` with no new arms | A test enumerates the registered names of `utility_builtins()` against a checked-in list, so an added or dropped name fails it (not a count). With the default convar, `extra_builtins(&[])` is empty and no extra name collides with a `utility_builtins()` name. `sv_shell_embedded_builtins=false` yields no extras. An unknown name fails validation. `analyze` output is unchanged for every input in the existing analysis tests. |
| 2 | Write seam: `Host::open_write` over `PathPolicy::open`; a new `DirFd::open_walk` walks per component with no-follow (the final component follows `symlink_behavior`) and the existing `DirFd::open` and `open_subdir` stay as they are because `rm` uses them; device-write test (and explicit refusal in `admit_write` only if the test fails today) | A symlink-swap race test: a link replaced between admission and open makes the open fail and the target outside the root stays untouched. A directory-walk race test on `DirFd`. A write to a device path other than `/dev/null` is denied under the default policy. No builtin is registered by this slice. |
| 3 | rmdir, chmod (unix), sd; `support/atomic_write.rs`; `analysis.rs` arms for chmod and sd, enabled-only | One write-deny test per command, modelled on `sed_r_files_honour_the_read_policy` (`read_policy_tests.rs:159`; the `:1-5` lines are only a doc comment). `chmod -R` and `rmdir --parents` stay inside the root through a swapped link. `sd -i` replaces atomically. `analyze_with` records chmod and sd writes only when enabled, and `analyze` does not. |
| 4 | cp; `support/{file_backup,progress}.rs`; uses `support/backup.rs` and `xattr.rs` | Write-deny on the destination; a link swapped during `-r` stays inside the root (slice 2 seam); backup and xattr options pass. |
| 5 | dd; `support/openfile.rs` | The slice-2 device test passes. `of=` under a write-deny root fails; `if=` goes through `open_read`; cancellation stops the copy. |
| 6 | tar (`cap-shell-archive`, forwarded through omp-envd and omp-app); `analysis.rs` arm, enabled-only | Members `../x`, absolute names and symlink-then-file chains are refused through the slice-2 seam. Round-trip create, list and extract for gz, bz2, xz, zst. `cargo deny` passes with the new crates. Naming `tar` without the feature fails validation. |
| 7 | Evidence-gated: nl, fold, od, strings, shasum, md5; `support/{bre,locale}.rs` | Golden tests per option group. One read-deny case per command in the `sed_r_files_honour_the_read_policy` style. `sed` tests unchanged. |
| 8 | Evidence-gated: id (unix), env, uptime; `support/{time_zone,quoting_style}.rs` | `env cmd` launches through the spawn wrapper (`set_test_spawn_wrapper`, `host.rs:1641`). uptime with utmp unreadable by policy still prints. |
| 9 | Evidence-gated: du, df; `support/block_size.rs` | du refuses or skips a read-denied root. df lists no mount outside the policy's readable view. |
| 10 | Evidence-gated: lsof | Pids rejected by `may_observe` are never listed. A Linux `/proc` fixture test. |

## Consequences

- No behaviour changes until a user or user profile sets the convar. The slice-1 enumeration test pins that.
- With names enabled, those commands run under the in-process path policy only. A mistake in that policy is not caught by kernel containment, as it would be for the external command. This is why slices 2-6 are ordered first and why D4 and D5 are preconditions, not follow-ups.
- The port is large: cp 124650 B, dd 83897 B, tar 80327 B (upstream sizes, `docs/research/shell-builtins.md` §1). Slice 2 is small but sets the safety of 3-6.
- The existing writers (`mv`, `ln`, `mkdir`, `mktemp`, `find`) have the same check-then-open shape. Migrating them to `Host::open_write` is not done here (O3).
- Nine helper modules join `support/`; `sed` keeps its own BRE converter.
- Linux runs remotely; macOS locally; Windows has no runner (O2).
- `rsync` stays external. The evidence-gated names stay external until evidence exists.

## Decisions taken from the review (formerly open)

- **Convar scope and shape** (formerly O5, and the EGM item on flags): archive only, no `PROJECT`; names plus `all`; `sv_shell_embedded_builtins=false` suppresses; read at shell construction (D2).
- **Shadow `rsync`?** (formerly O1): no (D9).
- **cp, dd, tar unconditional or withheld?** (formerly O2): opt-in per name; later default-on per name by amendment (D10). The code cannot "withhold" as `rm`/`mv`/`ln` are not withheld today.
- **`analysis.rs` arms** (formerly O3): pass the enabled set through a new `analyze_with`, keep `analyze` (D6).
- **Devices under `dd`** (formerly O4): refuse unless the policy lists the path, with an explicit test first (D5).

## Open questions for the owner

- **O1. What is the usage evidence that opens slices 7-10, and where does it come from?** Neither the code nor the existing ADRs name a source or a threshold; whether session journals record shell command names is not established. Recommendation: count external invocations of each name in recorded Bash tool calls across the owner's sessions, and open a slice for a name once it appears in a stated number of distinct sessions the owner picks.
- **O2. Who owns Windows verification?** No workflow mentions Windows (`.github/workflows/`: `ci.yml`, `codeql.yml`, `p8-baseline.yml`, `package-macos.yml`, `pr-labels.yml`, `semantic-index-eval.yml`). Recommendation: register the extras on unix only (`cfg(unix)`) until the owner adds a Windows job and names who maintains it; `chmod` and `id` are unix-only upstream already.
- **O3. Migrate the existing writers to `Host::open_write`?** It hardens `mv`, `ln`, `mkdir`, `mktemp` and `find` against the same race but touches shipped commands. Recommendation: yes, as a separate ADR or PR after slice 2, one command per PR, each with the race test.

## Review (EGM, 2026-11-13)

Three fresh-context reviewers (readiness, zoom-out, design critic) read the first draft. Verdict: accept the mechanism, amend the scope.

- **Accepted unchanged:** the `sv_shell_builtins_extra` convar with an empty default (`sandbox.rs:254` precedent); porting by module onto the host seam; `rsync` external; `cap-shell-archive` for `tar`.
- **Scope amended:** the first draft ordered slices by effort and treated all 18 alike. The gain over the OS-sandboxed external command is the typed in-process denial for commands that change paths, so cp, dd, chmod, rmdir, tar, sd moved first and the rest are gated on usage evidence (D3). Reviewers' wording "a second in-process path check" is corrected here: in-process builtins are not under the OS sandbox (ADR 0028 §4), so the in-process check is their only control, not an additional one (Context, Consequences).
- **Security finding, verified in this tree:** builtin writes are check-then-open by name (`host.rs:300-307`; `find.rs:4068`, `ln.rs:479`, `mv.rs:1075`); `DirFd::open` discards `symlink_behavior` and uses `NOFOLLOW` on the final component only (`safe_traversal.rs:38-40`); race protection would be check-time only. Resolved by D4 and slice 2 before cp, dd, tar. Device refusal in `admit_write` is implicit (`exec_sandbox.rs:970-976`) and untested; resolved by D5 and the slice-2 test.
- **Analysis finding, verified:** `analyze` has no enabled-set parameter and its only production caller is `crates/envd/src/admission.rs:768`; resolved by D6. The `cp -t` operand defect (`analysis.rs:516`) is recorded as existing and out of scope.
- **Call sites, corrected against this tree:** the reviewers reported two `utility_builtins()` sites in `crates/driver` and `crates/envd`. In this tree there are four: `crates/envd/src/exec.rs:834`, `crates/envd/src/shell_child.rs:51`, `crates/app/src/shell_cmd.rs:41` and `crates/shell-builtins/src/bin/omp-sh.rs:83`; there is no `crates/driver/src/shell_cmd.rs`. The `shell_child` entry does call `utility_builtins()` (it is not a `default_builtins()`-only site); the only `default_builtins()`-only sites found are tests. Entry points: D2.
- **Other fixes made:** `sv_shell_embedded_builtins` was found to gate only the prompt text today, so "suppresses the extras" is a new rule, stated as such (D2); D7 now says which side of the boundary builtins live on; the read-deny test to copy is `sed_r_files_honour_the_read_policy` at `read_policy_tests.rs:159`, not the `:1-5` doc comment; the `bre_to_ere` signature mismatch is recorded (D11); `cap-shell-archive` is named as the crate's first `[features]` table and must forward through omp-envd and omp-app (D8); `just remote-test-pkg` is no longer presented as the ADR 0040 router; the slice-1 test enumerates registrations instead of counting them.
- **Not settled by the reviewers or the code:** the usage-evidence source (O1), the Windows owner (O2), migrating existing writers (O3).

## Acceptance tests

1. With `sv_shell_builtins_extra` empty, the enumerated registered name set equals the checked-in list, and `extra_builtins(&[])` is empty (slice 1).
2. `sv_shell_embedded_builtins=false` yields no extras; naming a name the build does not offer (`tar` without `cap-shell-archive`, `rsync`) is a validation error.
3. A symlink swapped between admission and open fails the open for `Host::open_write` and for a `DirFd` walk (slice 2).
4. A write to a device other than `/dev/null` is denied under the default policy (slice 2, before `dd`).
5. Every writing new builtin fails on a write-denied destination; every reading new builtin fails on a read-denied file and prints nothing from it.
6. `tar` extraction refuses `..`, absolute and symlink-chain members; `cp -r`, `chmod -R` and `rmdir --parents` stay inside their root when a link is swapped mid-walk.
7. `analyze` output is unchanged; `analyze_with` adds chmod, tar, sd arms only for enabled names.
8. `env cmd` runs through the installed spawn wrapper; `lsof` never lists a pid `may_observe` rejects.
9. No identifier, message or convar in the ported code uses `pi` as a product name (grep check).

## Status in omp

**Status: Slices 1-2 landed (the gate and the write seam); no builtin is added yet.**

- Convar `SV_SHELL_BUILTINS_EXTRA` (`sv_shell_builtins_extra: Vec<Str>`, default empty, `archive` only, no `PROJECT`) in `crates/envd/src/exec_settings/shell.rs`, validated by `omp_shell_builtins::validate_extra_names`; `ShellSettings::builtins_extra` and `ShellSettings::extra_builtins()` (empty when `sv_shell_embedded_builtins` is false).
- Factory: `extra_builtins(enabled)`, `validate_extra_names`, `ExtraBuiltinError`, `ALL_EXTRAS`, `OFFERED_EXTRAS` (empty) in `crates/shell-builtins/src/factory.rs`. `utility_builtins()` is untouched and pinned by name by `crates/shell-builtins/tests/factory.rs` against `tests/utility_builtins.txt`.
- Wiring: `ExecHost::configure_shell` (called from `ShellExecHost::new`, `crates/envd/src/tool_shell.rs`) feeds the agent shell builder in `crates/envd/src/exec.rs`; for detached scripts the parent passes the set as an optional third argument (`shell_child::child_args` / `decode_extra_builtins`), present only when non-empty. The interactive CLI shell and `omp-sh` are not wired, by design.
- Analysis: `analyze_with(program, cwd, root, enabled)` in `crates/shell/src/analysis.rs`, `analyze` delegating with an empty set; no arm reads the set yet. Not yet done: passing the session's enabled set from `crates/envd/src/admission.rs` (`bash_ir`) to `analyze_with`; it has no effect until the first enabled-only arm, so it lands with slice 3.

- Write seam: `Host::open_write` over `PathPolicy::open` in `crates/shell-builtins/src/host.rs`. a new `DirFd::open_walk` in `crates/shell-builtins/src/support/safe_traversal.rs` walks each component with no-follow (only the final component follows `symlink_behavior`). `DirFd::open` and `DirFd::open_subdir` are unchanged: `rm` already uses them with `Follow` and relies on their single `O_NOFOLLOW` open, which `open_and_open_subdir_keep_the_contract_rm_depends_on` pins. No builtin is registered and `factory.rs` is unchanged. A device write other than `/dev/null` is denied by the default workspace policy.

Still open: none of the 19 exists (`docs/research/shell-builtins.md` §2). `support/{mounts,human,entries,mode,backup,checksum,xattr}` exist; `backup` has no consumer yet. Migrating existing writers onto `Host::open_write` is O3, not this slice.

## Upstream origin and license

Draws from `upstream:crates/pi-builtins/src/{nl,fold,od,strings,shasum,md5,id,env,uptime,du,df,rmdir,chmod,sd,cp,dd,tar,lsof}.rs` (with `dd/` and `lsof/`) and the helpers named in D11. License: MIT (`upstream:crates/pi-builtins/LICENSE-MIT`; `upstream:Cargo.toml:33`). `upstream:crates/pi-builtins/LICENSE` carries the lineage:

- uutils coreutils, MIT, "Copyright (c) uutils developers" (LICENSE lines 8-16): its list names `cp` and `nl`. It does not name od, du, df, dd, env, id, chmod, fold, rmdir, uptime or shasum, although those module headers cite uutils or `uucore`: each slice reads the headers of the files it ports and carries the notices they name.
- sd (https://github.com/chmln/sd), MIT: `sd` (LICENSE lines 149-155).
- libproc-rs (https://github.com/andrewdavidmackenzie/libproc-rs), MIT: macOS `proc_info.h` layouts in `lsof/macos.rs` (LICENSE lines 203-209).
- Original work under the workspace MIT license: lsof, tar, shasum, md5, strings (LICENSE lines 230-236).

omp2 already keeps this lineage in `crates/shell-builtins/NOTICE` and `LICENSE`; each slice appends its lines to `NOTICE`.

## References

ADR 0006 (policy on the host); ADR 0009 (`0009-bound-output-once.md`); ADR 0012 (convars, project authority); ADR 0024 (roster); ADR 0028 (in-process interpreter, §4 enforcement); ADR 0035 (Rust for the engine, error discipline); ADR 0036 (Python extensions); ADR 0040 (remote verification, proposed); ADR 0049 (vendor integrations in extensions); `docs/research/shell-builtins.md`; `crates/shell-builtins/src/{factory,host}.rs`; `crates/shell-builtins/src/support/safe_traversal.rs`; `crates/shell/src/interp.rs` (`PathPolicy::open`); `crates/envd/src/exec_sandbox.rs`; `crates/envd/src/exec_settings/shell.rs`; `crates/shell/src/analysis.rs`; `crates/envd/src/admission.rs`.
