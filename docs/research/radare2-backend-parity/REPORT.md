# radare2 backend parity for oh-my-pi `dsm`

**Answer:** Full parity is feasible for most operations with r2pipe 2.1.0 + radare2 6.2.x: every view, rename, comment, set_type, make_function, save/close, and project persistence maps to an exact command. Three IDA behaviors have **no** radare2 equivalent over the NDJSON command surface: repeatable comments, true per-command cancellation, and a readable dirty bit; use a worker-side mutation ledger, one `CC` per address, and process-level cancellation. C-quality pseudocode needs the optional r2ghidra plugin (`pdg`); core ships only `pdc` pseudo-C.

**Confidence:** high for command surface and JSON shapes (official source + local r2 6.2.2 probes), medium for version-sensitive defaults (`pdc.structured` flipped between 6.2.2 and master) and Windows decompiler support.

## Parity matrix

| Required op | radare2 mechanism | Parity | Caveat |
|---|---|---|---|
| open / persist project | `Ps <name>`, `P <name>` / `Po <name>`, `r2 -p <name>`, `Pc`, `Pl` | yes | project stores binary **path**, not contents; source file must still exist unless `prj.files=true` [9][10][12] |
| overview | `ij`, `iIj`, `iSj`, `iej`, `iMj`, `e asm.arch` | yes | no analysis needed [16][53] |
| imports | `iij` | yes | `iE` is exports, not imports [16] |
| exports | `iEj` | yes | `paddr` may be `ut64 -1` for dynamic exports [16][53] |
| strings | `izzj` / `izj` | yes | min-length var is `bin.str.min`, not `e strings.*` [16][53] |
| functions | `aflj`, `afij`, `afsj` | yes | empty before `aa`/`aaa` [17][20][53] |
| pseudocode | `pdcj` (core) or `pdgj` (r2ghidra) | partial | `pdc` is pseudo-C; `pdg` is optional plugin [24][26] |
| asm | `pdfj`, `pdj`, `p8j` | yes | `pdf` needs a function; `pd` works linearly [18][53] |
| xrefs | `axtj`, `axfj` | yes | empty without analysis; `axtg`/`axfg` are graph scripts, not JSON [17][21] |
| exec, persistent namespace | Python worker dict + r2pipe object | yes | r2 commands serialized by internal lock [2][4] |
| rename | `afn <name> @ <addr>` | yes | also renames/creates flag [17][35][53] |
| comment (repeatable) | `CC <text> @ <addr>` | **no repeatable flag** | closest: one `CC` per address from `axtj`/`axfj` [31][39] |
| set_type (C decl) | `afs <sig> @ <addr>`, `td`, `tl`, `to`, `afsr` | yes, awkward | pass signature **unquoted**; custom types rejected [17][33][38][53] |
| make_function | `af @ <addr>` / `af+ <addr> <name>` | yes | `af+` second token is name, not size [17][53] |
| save / close | `Ps`, `P+`, `Pc`, `r2pipe.quit()` | yes | `P+` is identical to `Ps` in current source [9][10] |
| dirty tracking | worker-side mutation ledger | **no command** | C API exists but is name-inverted and not exposed to r2pipe [10][37] |
| cancel long command | kill/terminate r2 process | **no in-command cancel** | async r2pipe `shield`s in-flight commands; session lost on kill [2][4] |

## Why

One r2pipe object per worker is the correct shape. Sync `r2pipe.open()` spawns `radare2 -q0 <flags> <target>` and holds a `threading.Lock` around the whole command exchange, so commands on one object are serialized, never interleavable; `cmd()` reads to a NUL terminator, `cmdj()` returns `{}` for empty output and `None` on JSON parse failure, and `quit()` terminates the process (it deliberately does not send `q!!`) [2][3]. Async r2pipe exists, but `asyncio.shield` means a cancelled caller does not interrupt a started command, and there is no user-facing `timeout=` on `cmd`/`cmdj` [1][4]. No r2-side cancel command was found in primary sources; cancellation is process-level (SIGINT/external kill), which discards the in-memory session [2][4][53].

Project persistence works but is path-based. `Ps <name>` writes `<dir.projects>/<name>/rc.r2` containing `# eval`, `o*` (binary path), `afl*`, `f*`, comments, `t*`, `ax*`, `ah*`, seek, and related state; `P <name>` / `r2 -p <name>` reopen it [9][10][13]. `prj.files=false` by default, so the stored `o "<path>"` must still resolve; missing binary produces `File associated with the project is missing: %s` [10][11][12]. Set `e prj.files=true` before `Ps` to copy the binary into the project `bin/` dir, and `e prj.new=true` to also write `prj.bin` [10][11][13]. `R2_PROJECTS`, `R2_HOME`, `R2_CFG`, `cfg.project`, `cfg.write` do **not** exist in current radare2; override with `e dir.projects=/abs/path`, `XDG_DATA_HOME`, or `R2_RCFILE` [6][7][11][12][14]. `Pn` is project **notes**, not project-new; `P.` prints `e prj.name` [9][10].

View commands are uniform and JSON-capable. Header views (`ij`, `iij`, `iEj`, `izzj`, `pdj`, `p8j`) work with no analysis; `aflj`, `afij`, `afsj`, `pdfj`, `axtj`, `axfj` are empty or error until `aa`/`aaa` runs (`r2 -A` = `aaa`) [16][17][18][6][20][53]. `pdcj` returns `{"code": ..., "annotations": [{"start", "end", "offset", "type"}]}`, giving char-range-to-address mapping without a plugin [25][53]. `pdgj` (r2ghidra) uses the same RCodeMeta shape plus `pcode_ops`, richer variable/parameter annotations, and `e r2ghidra.timeout=N` as a decompile-specific kill switch [26][27]. Set `e scr.color=0` and avoid `~` filters on JSON output [18][19][11].

Mutations map cleanly except comments and dirty state. `afn` renames function and flag via `on_fcn_rename` [17][35][53]. `CC`/`CC+` append with a space, `CCa+` with a newline, `CCu` deduplicates, `base64:` carries multi-line text, and `CCj` emits `{"offset", "type": "CCu", "name"}` [31][53]. A full-tree scan found no `CCr` or repeatable-comment flag; the `repeat` argument belongs to `Cd` (data arrays) [31][39]. `afs <sig> @ <addr>` sets a C signature but must be passed **unquoted** through r2pipe — `afs 'int f(char *p)' @ main` fails with `ERROR: at line 1: Cannot find ( in function definition` (and still renames the function before failing); custom/struct types are rejected by cparse [17][38][53]. Dirty state is C-only (`r_core_project_is_dirty()`), and its body returns **true when all three dirty bits are clean**, so a worker must track its own mutations and clear them after `Ps` [10][37][53].

## What would change this

- r2pipe adds a user-facing per-command timeout/cancel, or radare2 exposes dirty state through `P`/`e`. Both would remove the two largest parity gaps.
- The next released radare2 adopts master's `pdc.structured=true` default; shipped 6.2.2 emits `goto`/labels, master emits structured `if/else` [25][53][24].
- r2ghidra becomes bundled or its Windows/SLEIGH install stabilizes; current guidance is r2pm install plus explicit `e r2ghidra.sleighhome` [26][49][50].

## Considered and rejected

- **HTTP/TCP r2pipe transports** — they have fixed transport read timeouts, but no command cancel; TCP regex accepts numeric IPv4 only, not DNS names [1][2][4].
- **r2dec (`pdd`) as decompiler** — separate plugin with a different JSON shape (`lines/errors/log` for `pddj`; string offsets in `pddA`) and no timeout flag [29].
- **`r2 -A` on every open** — whole-program `aaa`; no primary source quantifies runtime cost. Prefer `aa` or targeted `af`/`afl` when latency matters [6][20][53].
- **Dirty state via `Pi j`** — `modified` is `rc.r2` mtime (last save), not unsaved-change state; literal `Pi j` is invalid (`ERROR: Unknown project 'j'`), use `Pij <name>` [10][53].
- **`P+` as "save without check"** — help text says so, but source falls through to `Ps` with no check [9][10].
- **`af+ <addr> <size> <name>`** — wrong grammar; `af+` takes `[addr] [name [type [diff]]]`, with basic blocks added via `afb+` [17][53].

## Findings

### 1. Worker lifecycle, API, cancellation

- Install: `pip install r2pipe`; current version `2.1.0`; `requires-python = ">=3.6"`, classifiers through 3.12 (3.13+ unverified) [1][5].
- Open: `r2pipe.open(path, flags=["-N", "-e", "scr.color=0"])`; spawn form is `radare2 -q0 <flags> <target>` (do not re-pass `-q0`). Project open: `r2pipe.open("-", flags=["-p", "<name>"])` or `r2 -p <name>`; `P`/`Po` in-session [2][6][9].
- Targets: file path, `http://host:port`, `tcp://IPv4:port`, `#!pipe`; `-` is `malloc://512`, not stdin [1][2][3].
- `cmd()`/`cmdj()`/`cmdJ()`/`call()`/`cmd2()`/`cmd2j()`/`syscmd()` exist; no `cmdv` [1][3].
- Async client: `from r2pipe.open_async import open as async_open`; commands serialized with `asyncio.Lock`; cancellation drains the response and may still mutate r2 state [1][4].
- No `timeout=` parameter; sync `_cmd_process` has no timeout or signal handling; only `quit()`/`terminate()` and external OS signals [2][4].
- Headless flags: `-q` quiet, `-qq`/`-Q` quit variants, `-2` close stderr, `-0` NUL framing, `-c` command, `-e k=v`, `-n`/`-nn` bin loading levels, `-N` no user rc, `-NN` disable plugins, `-A` = `aaa`, `-AA` = `aaaa`, `-w` write mode [6][7].

### 2. Project persistence

- Canonical help is `P?`; there is no `Ps?`/`Po?` help. `P` open, `P+`/`Ps` save, `P-` delete, `Pc` close, `Pl`/`Pj` list, `Pij` info, `P*` r2 script, `Pn` notes, `Pze`/`Pzi` zip export/import, `Pd [N]` git diff [9][10].
- Names: `[a-z0-9_]`, <64 chars, absolute paths bypass validation; `P-` refuses paths outside `dir.projects` [10].
- `dir.projects` default is XDG data home (`~/.local/share/radare2/projects`); callback converts to absolute [11][14][12]. Historical docs used `~/.config/radare2/projects` and `.sdb` files; master writes `rc.r2` as the portable artifact [10][54].
- Reopen without passing a binary: `P <name>` / `r2 -p <name>` work, but the file at the stored path must exist [10][12]. `prj.sandbox=true` strips `o` lines to reuse an already-open binary [10].
- Save fails on debug targets (`radare2 does not support projects on debugged bins`) and with no open IO desc [10].
- Projects have a documented maturity warning; treat as a caution, not proof of current breakage [51][52].

### 3. Views

| View | Command | JSON fields to consume | Prereq |
|---|---|---|---|
| overview | `ij`, `iIj`, `iSj`, `iej`, `iMj` | `bin.arch/bits/baddr/os/bintype/class/endian`; sections `name,size,vaddr,perm`; entries `vaddr,paddr,baddr,type` [16][53] | none |
| imports | `iij` | `name,ordinal,bind,type` [16][53] | none |
| exports | `iEj` | `name,flagname,bind,size,type,vaddr,is_imported` [16][53] | none |
| strings | `izzj`, `izj` | `vaddr,paddr,size,length,section,type,string`; `bin.str.min` [16][53] | none |
| functions | `aflj`, `afij`, `afsj` | `addr,name,size,nbbs,ninstrs,signature` [17][53] | `aa`/`aaa` |
| asm | `pdfj`, `pdj`, `p8j` | `ops[].addr/opcode/disasm/bytes/type`; `p8j` byte array [18][53] | `pdf` needs function |
| xrefs | `axtj <addr>`, `axfj <addr>` | `from,to,type,perm,opcode,fcn_addr,fcn_name,refname` [17][21][53] | `aa`/`aaa` |

- `aflj` fields include `ratbbins`; invalid `-nan` JSON was fixed upstream after issue #23471, so `cmdj` must tolerate parse failure [48][3].
- `pd 5 @ 0x...` uses temporary seek; `@@` is foreach; `!` in `~` negates [19][53].
- `iMj` works via generic `j` suffix though undocumented in `i?` [16][53].
- `aflj~{.name}` was unreliable on 6.2.2 (returned only `entry0`); filter in Python [19][53].

### 4. Pseudocode

- Core `pdc`: `pdc`, `pdcj`, `pdco` (offsets), `pdca` (asm side-by-side), `pdc*` (CCu comments), `pdct` (AST) [24][25].
- Shipped 6.2.2: `pdc.structured=false` (experimental opt-in), only `pdc.trycatch=true` otherwise; default output is `if (!v) goto loc_0x...` + labels. Master defaults `pdc.structured=true` plus `optimize`/`inline`. Both primary; version skew, not a contradiction [25][53][24].
- `pdc` requires a function: `ERROR: Cannot find function in 0x00008000` [25][53].
- r2ghidra: `r2pm -U && r2pm -ci r2ghidra`; `pdg`, `pdgj`, `pdgo`, `pdga`, `pdgt/j`, `pdgw` (write recovered names/types back), `pdgs`; `e r2ghidra.timeout=N` forks and SIGKILLs on timeout (UNIX only); requires a function at seek (`af` first, no full `aaa`) [26][27][28].
- r2dec: `r2pm -i r2dec`, `pdd`/`pddj`/`pddA`; no timeout; different JSON shape [29].
- No universal `decompiler.plugin` config; it was an unimplemented proposal [30].

### 5. Mutations

- Rename: `afn <name> @ <addr>`; `base64:` names accepted; failure `Cannot find function at 0x...`; flags updated through `on_fcn_rename` [17][34][35][53].
- Comments: `CC <text> @ <addr>` (append), `CC+`, `CCa+` (newline append), `CCu` (unique), `CC- @ <addr>`, `CCj`, `CC*`; variable comments are `Cv*`, not `CCv`; no repeatable variant [31][36][39][53].
- Types: `afs <sig> @ <addr>` **unquoted**; `afsj` readback; `afsr <fn> <type>`; `td "<C decl>"`, `to <header>`, `tl <type> = <addr>`, `t*`; custom types rejected (issue #17432, behavior on master unverified at runtime) [17][33][40][38][53].
- Functions: `af @ <addr>` analyzes; `af+ <addr> <name>` hand-crafts (size via `afb+`); `af-` undefines [17][53].
- Save/close: `Ps`, `P+`, `Pc`; `r2pipe.quit()` terminates r2 — save first [9][10][2].
- Dirty: C API `r_core_project_is_dirty()` returns true when clean; no `P`/`e` command; `Pi j` `modified` is mtime. Recommended: worker-side `bool dirty` set on any mutation, cleared after successful `Ps` [10][37][53].
- Source binary is never modified by these commands: default perms are `R_PERM_RX`, `-w` enables write, and only `w*` commands write the target [6][7].

### 6. Address and symbol resolution

- Accepted: `0x`/`0X` hex, `0b`/`0o`/`0t`, suffixes `h/o/b/t`, leading-zero octal, decimal, `10K`/`10M`, arithmetic, `$$`, flags (`sym.*`, `fcn.000057a0`, `section..text`, `entry0`), registers as flags [41][42][43][53].
- `@` is temporary seek (restored), `@@` foreach [19].
- Unknown symbol: stderr `ERROR: Invalid tmpseek address '<name>'`, empty stdout, `cmdj()` → `{}`; `?v <unknown>` → stderr `ERROR: unknown symbol`, stdout `0x0` [47][41][3][53]. Malformed numeric can silently resolve to 0 rather than error [53].
- Mutation commands on unknown targets log `Cannot find function ...` variants [17][31].

### 7. Adapter-design constraints

- Set `e scr.color=0`, `e scr.utf8=false`, `e scr.interactive=false` at open; r2pipe decodes with `errors="ignore"` [3][11][53].
- `r2 -A` runs `aaa`; lighter `aa` = `af @@ sym.*; af@entry0; afva`; no primary source quantifies cost [6][20][53].
- Windows: r2pipe appends `.exe`, reads initial NUL twice, uses named pipe when embedded inside r2 (`r2pipe_path`); radare2 builds via Meson/VS; r2ghidra Windows install historically fragile, closed 2026-09-22 after PR #300 — verify on target [2][3][45][49][50].
- Installation: `pip install r2pipe`; radare2 via release binaries, `sys/install.sh`, or `r2env`; no official r2pipe↔r2 compatibility matrix [1][46].
- JSON coverage is uneven (`afllj` status unverified post-2018); design `cmdj` fallback to `cmd()` plus explicit parse [48][3].

## Open questions

- `R2_PROJECTS`/`R2_HOME` absent from current source — older radare2 versions may differ; not verified.
- `e anal.timeout` unverified; do not rely on it for cancellation.
- `afllj` current status after issue #7339 closure; `CCj` type field confirmed on 6.2.2 only.
- `Pij` JSON field shapes remain source-only (reading them needs a saved project).
- `pdc.structured` flip commit not bisected; exact behavior in the next release unknown.
- No measured `-A`/`aaa`, `izz`, or decompiler timing numbers in primary sources; all performance claims here are qualitative.
- No official r2pipe↔radare2 version compatibility matrix; Windows r2ghidra should be re-verified on the deployment version.

## Sources

All accessed 2026-11-17. Tags mark authority: [primary] official docs/source/official issue tracker/official binary observation; [historical] older official material kept for version drift.

1. https://raw.githubusercontent.com/radareorg/radare2-r2pipe/master/python/README.md — r2pipe install, targets, async, JSON guidance. [primary]
2. https://raw.githubusercontent.com/radareorg/radare2-r2pipe/master/python/r2pipe/open_sync.py — spawn form, lock, quit, NUL framing, Windows quirks. [primary]
3. https://raw.githubusercontent.com/radareorg/radare2-r2pipe/master/python/r2pipe/open_base.py — `cmd`/`cmdj`/`cmdJ`, empty→`{}`, parse errors, named pipes, target normalization. [primary]
4. https://raw.githubusercontent.com/radareorg/radare2-r2pipe/master/python/r2pipe/open_async.py — `asyncio.shield`, serialization, close/kill. [primary]
5. https://pypi.org/pypi/r2pipe/json — version and Python metadata. [primary]
6. https://raw.githubusercontent.com/radareorg/radare2/master/libr/main/radare2.c — `-p`, `-A`, `-q`, `-N`, `-w`, env vars, RCore permissions. [primary]
7. https://github.com/radareorg/radare2/blob/master/man/radare2.1 — official CLI flags and environment. [primary]
8. https://book.rada.re/config/files.html — RC files and env var list. [primary]
9. https://raw.githubusercontent.com/radareorg/radare2/master/libr/core/cmd_project.inc.c — `P?` help, `P`/`Po`/`Ps`/`P+`/`Pn`/`Pi`, fallthrough. [primary]
10. https://raw.githubusercontent.com/radareorg/radare2/master/libr/core/project.c — project file layout, `prj.files`, missing-binary error, dirty API, save preconditions. [primary]
11. https://raw.githubusercontent.com/radareorg/radare2/master/libr/core/cconfig.c — `dir.projects`, `prj.*`, `scr.color`, `bin.str.*` defaults. [primary]
12. https://book.rada.re/projects/usage.html — project open without specifying binary; config keys. [primary]
13. https://raw.githubusercontent.com/radareorg/radare2/master/libr/core/cmd_open.inc.c — `o*` path vs `prj.files` pushd/popd. [primary]
14. https://raw.githubusercontent.com/radareorg/radare2/master/libr/util/xdg.c — XDG data directory resolution. [primary]
15. https://raw.githubusercontent.com/radareorg/radare2/master/test/db/tools/r2 — per-process `dir.projects` override order. [primary]
16. https://raw.githubusercontent.com/radareorg/radare2/master/libr/core/cmd_info.inc.c — `i*` help and fields. [primary]
17. https://raw.githubusercontent.com/radareorg/radare2/master/libr/core/cmd_anal.inc.c — `afl`, `axt`/`axf`, `afn`, `afs`, `af`, `af+`, `aa` help and behavior. [primary]
18. https://raw.githubusercontent.com/radareorg/radare2/master/libr/core/cmd_print.inc.c — `pd`, `pdf`, `p8` help. [primary]
19. https://book.rada.re/first_steps/syntax.html — `@`, `@@`, `~`, `j` command grammar. [primary]
20. https://book.rada.re/analysis/code_analysis.html — `aa`/`aaa` stages and prerequisites. [primary]
21. https://rada.re/advent/06.html — xref analysis requirements. [primary]
22. https://book.rada.re/scripting/r2pipe.html — official r2pipe usage examples. [primary]
23. https://raw.githubusercontent.com/radareorg/radare2/master/man/rabin2.1 — `i`/`ii`/`iE`/`izz` correspondence. [primary]
24. https://book.rada.re/arch/decompile.html — `pdc` limitations, `pdg`/`pdd`, plugin install, subcommand convention. [primary]
25. https://raw.githubusercontent.com/radareorg/radare2/master/libr/core/p/pseudo/plugin.c — `pdc*` help, config defaults on master. [primary]
26. https://github.com/radareorg/r2ghidra — `pdg*` help, install, SLEIGH, timeout, `pdgw`. [primary]
27. https://raw.githubusercontent.com/radareorg/r2ghidra/df21ab245c186ca3075c98e8abe5d266293a5c23/src/core_ghidra.cpp — `pdgj` annotations, timeout kill, error text. [primary]
28. https://raw.githubusercontent.com/radareorg/radare2-pm/master/db/r2ghidra — r2pm package entry. [primary]
29. https://raw.githubusercontent.com/wargio/r2dec-js/master/c/r2dec-plugin.c — `pdd` help and flags. [primary]
30. https://github.com/radareorg/radare2/discussions/24070 — `decompiler.plugin` is an unimplemented proposal. [primary]
31. https://raw.githubusercontent.com/radareorg/radare2/master/libr/core/cmd_meta.inc.c — `CC*` help, append/unique semantics, no repeatable flag, `Cv`. [primary]
32. https://raw.githubusercontent.com/radareorg/radare2/master/libr/core/cmd_flag.inc.c — `f`, `fr`, `fs` help. [primary]
33. https://raw.githubusercontent.com/radareorg/radare2/master/libr/core/cmd_type.inc.c — `td`, `to`, `tl`, `t*` help. [primary]
34. https://raw.githubusercontent.com/radareorg/radare2/master/libr/anal/function.c — function rename callback. [primary]
35. https://raw.githubusercontent.com/radareorg/radare2/master/libr/core/core.c — `on_fcn_rename` flag update. [primary]
36. https://raw.githubusercontent.com/radareorg/radare2/master/libr/anal/meta.c — `CCj` type tags, meta dirty-bit set. [primary]
37. https://raw.githubusercontent.com/radareorg/radare2/master/libr/include/r_types_base.h — `R_DIRTY_*` macros. [primary]
38. https://github.com/radareorg/radare2/issues/17432 — `afs` custom-type rejection report. [primary]
39. https://book.rada.re/arch/metadata.html — full `C?` help, `CF`, `Ct` caveat. [primary]
40. https://book.rada.re/analysis/types.html — `td`/`tl` C declaration workflow. [primary]
41. https://github.com/radareorg/radare2/blob/master/libr/util/unum.c — numeric parsing, `unknown symbol`. [primary]
42. https://book.rada.re/first_steps/expressions.html — numeric forms and variables. [primary]
43. https://book.rada.re/commandline/seeking.html — seek expressions. [primary]
44. https://book.rada.re/first_steps/commandline_flags.html — `-q`/`-c` examples. [primary]
45. https://book.rada.re/install/windows.html — Windows build support. [primary]
46. https://book.rada.re/install/download.html — radare2 install methods. [primary]
47. https://github.com/radareorg/radare2/blob/master/libr/core/cmd.c — `Invalid tmpseek address`, `Invalid command`. [primary]
48. https://github.com/radareorg/radare2/issues/23471 — invalid `-nan` JSON from `aflj`. [primary]
49. https://github.com/radareorg/r2ghidra/issues/141 — Windows install failures. [primary]
50. https://github.com/radareorg/r2ghidra/issues/192 — Windows r2ghidra status through 2026-09. [primary]
51. https://github.com/radareorg/radare2/issues/17034 — maintainer caution on project maturity. [primary]
52. https://book.rada.re/refcard/intro.html — "Saving (Broken)" note. [primary]
53. Local radare2 6.2.2 probes (commit ad27058, 2026-10-03), read-only `r2 -N -q -c '...' /bin/true` and small ELF; findings F3/F6/F8. [primary observation, no URL]
54. https://radareorg.github.io/blog/posts/project-files/ — historical project file layout. [historical]
