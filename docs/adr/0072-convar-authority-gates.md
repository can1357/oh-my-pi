# 0072. Convar authority gates: gate the model's writes by provenance and protect the config root; do not flag the security settings

Status: proposed
Date: 2026-11-15
Area: control-plane

Research: answers ADR 0058 open question O6 (`docs/adr/0058-context-url-schemes.md:104`; context at `:46`, `:71`, `:83`) and the unverified half of O7 (`:105`). Read against `omp2` at `bf873e3f53b4` on 2026-11-15.

**Review status.** Proposed. Not owner-approved. Machine-reviewed in one round by three read-only audits (completeness, boundary claims, engine semantics). All three returned. Their high and medium findings are applied (one medium finding, a missing References section, was wrong: the section exists), and most of their low findings on wording and structure are not. The corrections made in response were checked against the code by script and by reading, and no audit saw them. No test or build was run: every statement comes from reading the tree with searches and line reads, and every factual claim cites `path:line`. A claim the code does not settle is marked **not verified**; a conclusion drawn from reading rather than from running is marked **inference**. The tests named below are proposals; none exists yet. Accepting this record changes no code, test or other record.

## Answer in brief

- **O6: yes to gates that bind, no to `READONLY` or `UNSAFE` on these variables.** The engine evaluates both flags only for `SetSource::Script` (`crates/con/src/ctx.rs:1421-1428`), and `Script` is the provenance of the user's own console, composer commands, settings panel, `exec <file>`, key binds and agent-class cfgs (`crates/con/src/ctx.rs:87-98`, `:2280-2288`). Flagging the variables would block those user paths, one of them pinned by tests, and would not touch the routes the model has today: `omp config set` run from its shell tool and a direct rewrite of `config.cfg` by its `write` tool, which reaches the config root outside the Environment root through a direct branch (`crates/envd/src/tool_document.rs:1885-1886`), or by its `edit` tool where the Environment root contains it. The first writes `config.cfg` as `Source::Config`, which is `SetSource::Code`, and `Code` bypasses both flags (`crates/app/src/config_cmd.rs:666-671`; `crates/con/src/ctx.rs:2286`). The second never reaches the convar engine. A user configuring the sandbox in `config.cfg` is a `Code` write too (matrix row 1) and keeps working under every option; what the flags would break is the console, `exec`, the settings panel and agent-class cfgs.
- **What binds instead.**
  1. For the first in-process model caller, a model provenance, `SetSource::Model`, and an opt-in flag, `VarFlags::MODEL_WRITABLE`. A model-attributed write is refused for every variable that does not carry the flag. This is a deferred contract, not a gate on today's shell and file-tool writes. S1 and S2 MUST ship with their first production caller, ADR 0058 C2, never as dormant engine code. This mirrors `PROJECT`, the existing opt-in door for repository content (`crates/con/src/spec.rs:30-36`).
  2. The live fix is boundary protection: write-deny the user config root to the sandboxed shell and to every model `write` and `edit` path. The direct `write` branch skips the document host outside the Environment root (`crates/envd/src/tool_document.rs:1885-1886`), so the guard must precede that branch. An unsandboxed shell can still rewrite configuration with the user's permissions. No protected-path admission rule was established by this research; Q2 is an acceptance dependency, not a claim that approval already closes this route.
  3. `sv_cheats` stays as it is. No `UNSAFE` variable ships until a test proves that neither the model nor repository content can enable it.
  4. `sv_approval_mode` is not an approval control, because nothing enforces it. The live ones are `sv_tools_approval_mode` and `sv_tools_approval`.
- **Behaviour change if this record is accepted: none.** The slices change behaviour only as listed under "Behaviour changes".
- **Corrections to the brief.** One starting fact is wrong (a production `READONLY` variable exists), two named things do not exist (`+set` and a production `autoexec`), and one named variable is unenforced (`sv_approval_mode`). See "Corrections to the starting facts".

## Context

### The question

ADR 0058 left it open: "Should `sv_cheats`, `sv_approval_mode`, `sv_sandbox_*`, `sv_exec_remote_*` and `sv_browser_cdp_url` get real gates (`READONLY` or `UNSAFE` plus a gated `sv_cheats`)? The shell route (`omp config set`) can already persist them. Recommendation: yes, in a separate record, because it changes existing behaviour." (`docs/adr/0058-context-url-schemes.md:104`). The same record rejected changing the flags inside itself ("Right in spirit but an existing-behaviour change", `:71`), found that the gates "protect almost nothing" (`:70`, `:83`), and called its device free of new authority because the shell route already exists (`:46`). Its never-allowed list for the device is `sv_cheats`, every `sv_sandbox_*`, `sv_approval_mode`, every `sv_exec_*` and `sv_browser_cdp_url` (`:41`). It says the device writes with `SetSource::Script` "so `READONLY` and `UNSAFE` still apply as defence in depth" (`:41`). For the five families that sentence is empty today, because none of them carries either flag (table below).

### What the gates are and when they fire (verified)

- **Flags.** `READONLY`: "Scripts can read but never write; host code still can." `UNSAFE`: "Script writes require the `sv_cheats` gate to be enabled." `REPLICATED`: "Authority-owned: mirrored to replicas, locally immutable on them." `PROJECT`: a project cfg overlay may `set` and `reset` the variable, and "a variable that does not opt in is unreachable from it" (`crates/con/src/spec.rs:30-44`). `ARCHIVE` marks what `dump` persists (`crates/con/src/spec.rs:24-25`).
- **Provenance.** `SetSource` has three values: `Code` (trusted host code, "bypasses `READONLY`/`UNSAFE` gates"), `Script` ("Console input / cfg script; all gates apply") and `Replication` ("bypasses gates and `validate`") (`crates/con/src/ctx.rs:51-61`).
- **Evaluation.** `check_value` type-checks, clamps, calls `check_gates`, and skips `validate` only for `Replication` (`crates/con/src/ctx.rs:1392-1410`). `check_gates` refuses a replicated write on a replica from anything but replication (`:1415-1420`). Then, only `if source == SetSource::Script` (`:1421`), it refuses `READONLY` with `ConError::ReadOnly` (`:1422-1424`) and `UNSAFE` without `sv_cheats` with `ConError::UnsafeGated` (`:1425-1427`; the variants are at `crates/con/src/error.rs:112` and `:118`). `Ctx::unset` runs the same gates with a provenance it derives from the origin (`crates/con/src/ctx.rs:868-875`). A variable statement commits through `commit_layer_source` with `statement_source(origin)` (`crates/con/src/ctx.rs:1857-1875`; dynamic variables at `:1817-1835`). `Ctx::set` with an explicit origin takes the narrower `commit_layer` mapping, where only `Origin::Script` is `Script` (`crates/con/src/ctx.rs:1315-1322`), so host writes with `Origin::Class` or `Origin::Project` are `Code`.
- **Which streams are `Script`.** `statement_source` says it: "console input, agent-class cfgs, and project overlays pass the script gates; the user's own cfgs, replay, and host writes do not" (`crates/con/src/ctx.rs:2280-2288`). `Origin::Script`, `Origin::Class` and `Origin::Project` are `Script`; everything else is `Code`. `Source::origin` maps `Config` to `Archive` (`Code`), `Session` to `Session` (`Code`), `Console` to `Script("console")`, the four class streams to `Class` and `Project` to `Project` (`crates/con/src/ctx.rs:87-98`). Typed host writes are `Code` (`CVar::set` at `crates/con/src/handle.rs:54-57`; `Ctx::set_typed` at `crates/con/src/ctx.rs:824-827`).
- **`PROJECT` is a separate, earlier door.** A project overlay runs with project authority and may only `set` or `reset` a variable that carries `PROJECT` (`crates/con/src/ctx.rs:108-119`, `:1691-1721`, `:1725-1732`). The script gates still apply on top of it (`crates/con/tests/project.rs:24-28`, `:122-127`).
- **`sv_cheats`.** Registered name `"sv_cheats"` (`crates/con/src/ctx.rs:26`); spec flags `REPLICATED` and `NOTIFY` only (`crates/con/src/builtins.rs:21-28`); read by `unsafe_enabled` (`crates/con/src/ctx.rs:1056-1057`). A console write enables it: `ctx.run("sv_cheats true").unwrap()` (`crates/con/tests/console.rs:276`, inside `:272-279`).
- **Replication is inert in production.** `Role` defaults to `Standalone`, where "replicated vars behave like plain vars" (`crates/con/src/repl.rs:19-27`); the replica refusal needs `Role::Replica` (`crates/con/src/ctx.rs:1415-1418`). The only replica constructor is `Replica::new` (`crates/con/src/repl.rs:37-39`). I found no `Role::Authority`, `Role::Replica`, `Replica::new` or context-role setter outside `crates/con` (grep over `crates`, 2026-11-15; the `.role(` hits are unrelated collaboration roles). So `REPLICATED` on `sv_cheats` and `sv_approval_mode` has no effect today (**inference** from that absence).

### Corrections to the starting facts

| Brief | Finding | Evidence |
|---|---|---|
| Flag meanings at `spec.rs:28-48` | The constants are `:24-44`; `:46-56` are `with` and `contains`. `PROJECT` is opt-in and deny-by-default, which "project overlay may set" omits. | `crates/con/src/spec.rs:24-56` |
| `sv_cheats` spec at `builtins.rs:21-35`, `REPLICATED, NOTIFY` only | Confirmed. The registered name comes from `UNSAFE_NAME`; the comment at `builtins.rs:9-10` still says `con::unsafe`. | `crates/con/src/builtins.rs:9-10`, `:21-35`; `crates/con/src/ctx.rs:26` |
| Enforcement at `ctx.rs:1422-1425`; host bypass at `ctx.rs:55`, `handle.rs:54` | Confirmed: `READONLY` at `:1422-1424`, `UNSAFE` at `:1425-1427`, both inside the `Script`-only branch at `:1421`. `Replication` also bypasses (`ctx.rs:59-60`). | `crates/con/src/ctx.rs:54-60`, `:1421-1427`; `crates/con/src/handle.rs:54-57` |
| "No production var carries UNSAFE or READONLY" | **Half wrong.** No production variable carries `UNSAFE`; the only `flags: unsafe` is the test fixture at `console.rs:46`. One production variable carries `READONLY`: `sv_tools_read_only`, documented "Scripts, cfgs, and the console cannot write it". None of the five families carries either flag. ADR 0058 already says so (`:17`). | `crates/agent/src/vars.rs:260-268`; `crates/con/tests/console.rs:46` |
| CLI `+set` | There is no such syntax: grep of `crates` and of the other records under `docs` for `"+set"` and `+set <name>` matches nothing. CLI flags write typed variables as host code, for example `--add-dir` writing the sandbox roots. | `crates/app/src/chat_cmd.rs:976-993` |
| "user config.cfg / autoexec" | `autoexec` exists only in a test loader and a doc comment. The production loader reads `config.cfg`, `subagent.cfg` and `<agent>.cfg`. | `crates/con/tests/console.rs:597-606`; `crates/con/src/dump.rs:9`; `crates/con/src/ctx.rs:1498`, `:1517`, `:1523` |
| `sv_approval_mode` as an approval gate | Declared and displayed, never read for a decision. See the variables section. | `crates/agent/src/vars.rs:244-248` |

### The variables in scope (verified)

Every variable named in the question, with the flags it has today. Defaults appear where the declaration shows them. Lists are enumerated from the declarations, not from the question's wildcards.

**Singletons**

| Variable | Type | Default | Flags | Declared | Notes |
|---|---|---|---|---|---|
| `sv_cheats` | bool | `false` | `replicated`, `notify` | `crates/con/src/builtins.rs:21-28` | Gate for `UNSAFE` variables. |
| `sv_approval_mode` | Str | `on-request` | `archive`, `session`, `replicated` | `crates/agent/src/vars.rs:244-248` | No enforcing reader (below). Not in the settings UI. |
| `sv_browser_cdp_url` | Str | empty | `archive` | `crates/envd/src/lib.rs:301-313` | Exists only with feature `cap-browser` (`:301`). Read at `crates/envd/src/browser_daemon.rs:110`. In the settings UI (`crates/envd/src/lib.rs:308`). |

**`sv_sandbox_*`: 24 variables, all `archive` only, none with `ui.tab` metadata.** All are declared in `crates/envd/src/exec_settings/sandbox.rs` (the declaration block is `:180-326`).

| Variable | Type | Line | Default or doc |
|---|---|---|---|
| `sv_sandbox_mode` | ExecSandboxMode | `:184` | `workspace-write` (`:185`); "Choose the filesystem sandbox posture for agent commands" (`:181`) |
| `sv_sandbox_network_mode` | SandboxNetworkMode | `:193` | `scoped` (`:194`); `disabled` and `open` "confine nothing" while the sandbox is off (`:190-192`) |
| `sv_sandbox_cpu_cores` | f64 | `:198` | 0 is unlimited (`:197`) |
| `sv_sandbox_memory_bytes` | i64 | `:204` | |
| `sv_sandbox_pids` | u32 | `:210` | |
| `sv_sandbox_allow_domains` | `Vec<Str>` | `:215` | admitted by the egress broker (`:188-190`) |
| `sv_sandbox_deny_domains` | `Vec<Str>` | `:222` | |
| `sv_sandbox_network_session_reruns` | u32 | `:231` | |
| `sv_sandbox_allow_ports` | `Vec<u16>` | `:237` | |
| `sv_sandbox_allow_localhost` | bool | `:243` | |
| `sv_sandbox_allow_unix_sockets` | `Vec<Str>` | `:248` | |
| `sv_sandbox_writable_roots` | `Vec<Str>` | `:254` | empty (`:255`); "Absolute paths that workspace-write mode may modify" (`:253`) |
| `sv_sandbox_unscoped_writes` | UnscopedWrites | `:260` | `deny` (`:261`) |
| `sv_sandbox_env_deny` | `Vec<Str>` | `:265` | |
| `sv_sandbox_env_inherit` | EnvironmentInheritance | `:271` | `all` (`:272`) |
| `sv_sandbox_env_include_only` | `Vec<Str>` | `:276` | |
| `sv_sandbox_env_set` | Kv | `:282` | |
| `sv_sandbox_exclude_tmpdir` | bool | `:288` | `false` (`:289`) |
| `sv_sandbox_exclude_slash_tmp` | bool | `:293` | `false` (`:294`) |
| `sv_sandbox_read_deny` | `Vec<Str>` | `:298` | |
| `sv_sandbox_read_mode` | ReadMode | `:304` | `host` (`:305`) |
| `sv_sandbox_readable_roots` | `Vec<Str>` | `:309` | |
| `sv_sandbox_read_deny_globs` | `Vec<Str>` | `:315` | |
| `sv_sandbox_write_deny` | `Vec<Str>` | `:321` | |

**`sv_exec_remote_*`: 9 variables, all `archive` only, none with `ui.tab` metadata**, all declared in `crates/driver/src/exec_composer.rs`.

| Variable | Type | Line | Default or doc |
|---|---|---|---|
| `sv_exec_remote_endpoint` | Str | `:41` | empty; "Remote REAPI address. Empty disables remote execution." (`:40`) |
| `sv_exec_remote_cache` | Str | `:45` | `off` (`:46`); `off`, `read` or `read-write` (`:44`) |
| `sv_exec_remote_profile` | Str | `:50` | `reapi` (`:51`) |
| `sv_exec_remote_credential_header` | Str | `:54` | empty; "Metadata header that carries the remote credential" (`:53`) |
| `sv_exec_remote_arch_spelling` | Str | `:59` | `reapi` (`:60`) |
| `sv_exec_remote_fixed_properties` | Str | `:64` | empty |
| `sv_exec_remote_refuse_action_cache` | bool | `:70` | `false` (`:71`) |
| `sv_exec_remote_credential` | Str | `:74` | empty; "Command credential source, prefixed with `!`; never the key itself." (`:73`) |
| `sv_exec_remote_image` | Str | `:78` | empty; "Digest-pinned remote image for the repository's Cargo/just toolchain." (`:77`) |

The tables come from a scan of the declaration blocks in those two files (every `pub static SV_SANDBOX_*` and `SV_EXEC_REMOTE_*`, with the `flags:` line of each block); the scan found 24 and 9 declarations, 33 in total, and no `ui.tab` key in any of them.

**Adjacent variables the question does not name.** They were found while enumerating and are not decided here.

- `sv_tools_approval_mode`: ApprovalMode, default `yolo`, `archive`, in the settings UI (`crates/envd/src/tool_settings.rs:96-111`). It is the live approval control. Its documented coupling: "The default `yolo` auto-approves every tier only for the tools an active sandbox (`sv_sandbox_mode`) confines (`bash`, `hub`); every other tool follows `write`, and without an active sandbox `write` is in force for all of them. Setting `yolo` yourself (or `--yolo`) is respected for every tool, sandbox or not." (`crates/envd/src/tool_settings.rs:92-95`).
- `sv_tools_approval`: per-tool allow, prompt or deny overrides, `archive`, in the settings UI (`crates/envd/src/tool_settings.rs:112-123`).
- `sv_shell_command_prefix`: "Wrapper placed before every admitted shell command", `archive` (`crates/envd/src/exec_settings/shell.rs:89-93`).
- The other `sv_exec_*` variables, all `archive` only. `sv_exec_upload_exclude`, "Extra operator-approved upload deny patterns" (`crates/driver/src/exec_composer.rs:81-84`). `sv_exec_upload_allow`, "Paths exempted by the operator from upload denial" (`crates/driver/src/exec_composer.rs:85-88`). `sv_exec_policy`, ADW execution placement, "always operator-controlled, never project cfg", default `AdwExecPolicy::LocalOnly` (`crates/driver/src/adw/remote.rs:68-73`). `sv_exec_fallback_local`, default off (`crates/driver/src/adw/remote.rs:74-79`). `sv_exec_agent_runs`, the switch that gives the model the `remote_build` tool, default off (`crates/driver/src/remote_build.rs:39-47`). ADR 0058 names "every `sv_exec_*`" (`docs/adr/0058-context-url-schemes.md:41`), so the S2 security set uses the `sv_exec_` prefix.
- `sv_tools`: `archive`, `session`, `replicated`, `project` (`crates/agent/src/vars.rs:256-259`). An existing `PROJECT` opt-in, the precedent for the flag proposed below.
- `sv_tools_read_only`: `readonly` only (`crates/agent/src/vars.rs:265-268`); the host sets it at spawn with host provenance (`crates/driver/src/subagent/spawn.rs:1160`).

**`sv_approval_mode` is unenforced.** Its only references in the tree are the declaration (`crates/agent/src/vars.rs:245`), the `/security` display (`crates/chat/src/commands/misc.rs:173`), a QA smoke assertion (`scripts/qa/smoke-commands-b.ts:111`) and documents (a grep of every text file outside `.git`, `target` and `node_modules`, 2026-11-15). No Rust code reads the `SV_APPROVAL_MODE` static. The environment daemon digests `sv_tools_approval_mode` and `sv_tools_approval` as its approval posture (`crates/envd/src/daemon_policy.rs:58-61`).

### What each family guards

| Family | What a write changes | Threat if the model or a repository controls the write | Legitimate use of the same write |
|---|---|---|---|
| `sv_cheats` | "Enables writes to unsafe-gated variables" (`crates/con/src/builtins.rs:23-24`) | A script enables it, then writes any `UNSAFE` variable. Vacuous today: no production variable is `UNSAFE`. Real the day the first one ships. | The human at the console (`crates/con/tests/console.rs:272-279`) |
| Posture: `sv_sandbox_mode`, `_network_mode`, `_unscoped_writes`, `_read_mode` | Filesystem and network confinement of agent commands (`crates/envd/src/exec_settings/sandbox.rs:181-196`, `:259-263`, `:303-307`) | Turns confinement off or open. With an explicit `sv_tools_approval_mode yolo`, "respected for every tool, sandbox or not" (`crates/envd/src/tool_settings.rs:95`), the result is unconfined, auto-approved commands (**inference** from the two doc comments). | The user's `config.cfg`. Agent-class cfgs tighten it: `reviewer.cfg` with `sv_sandbox_mode read-only` (`crates/driver/src/headless/con_journal.rs:896`, `:956`, `:1023`) |
| Reach lists: `allow_domains`, `allow_ports`, `allow_localhost`, `allow_unix_sockets`, `writable_roots`, `readable_roots`, and the deny, env and ceiling variables | Egress and filesystem reach (`crates/envd/src/exec_settings/sandbox.rs:188-190`, `:253`). A write replaces the whole value: a statement commits the coerced argument list as the layer's value (`crates/con/src/ctx.rs:1857-1875`), and `--add-dir` reads, appends and writes the whole list back (`crates/app/src/chat_cmd.rs:984-991`). A deny list can therefore be replaced by a shorter one. | Widen reach, or clear a deny list or ceiling | `--add-dir` appends to both roots as host code (`crates/app/src/chat_cmd.rs:976-993`) |
| `sv_exec_remote_*` | Where the working tree is uploaded and with which credential (detail below the table) | Upload of the working tree, and of a credential, to an endpoint the attacker controls. Mitigated on the model's route by a human prompt (below). | Operator configuration through `config.cfg` or `omp config set`. No settings-UI entry. |
| `sv_browser_cdp_url` | "Default HTTP CDP discovery endpoint used when no tool-call endpoint is provided" (`crates/envd/src/lib.rs:303`) | A "redirected endpoint", the `PROJECT` doc's own example of what a hostile repository must never reach (`crates/con/src/spec.rs:33-35`) | The settings UI (`crates/envd/src/lib.rs:308`), which applies a setting as a console line (`crates/chat/src/host.rs:3678`) |
| `sv_approval_mode` | Nothing | None through this variable | none |

**`sv_exec_remote_*` in detail.** This is the one family whose writes can send files and secrets off the machine, so it has the most controls to account for.

- *What the variables decide.* The endpoint (`crates/driver/src/exec_composer.rs:40-41`). The credential, which is either `env:NAME`, read from the omp process environment (`crates/driver/src/exec_composer.rs:566-572`), or `!command`, which the host runs as an environment `exec` Script (`crates/driver/src/exec_composer.rs:554-562`; `crates/driver/src/auth_backend.rs:1351-1364`). The header that carries it (`crates/driver/src/exec_composer.rs:53-54`). Which files are captured, untracked ones included, under the rules in `sv_exec_upload_exclude` and `sv_exec_upload_allow` (`crates/driver/src/exec_composer.rs:602-609`).
- *The human check on the model's route.* `remote_build` asks before every upload: a once-only network requirement that defaults to deny, requires a human and denies when no one can answer, whose body says it "uploads the working tree to {endpoint}" (`crates/driver/src/remote_build.rs:324-352`). Only a `User` or `External` answer authorizes it (`crates/driver/src/remote_build.rs:392-396`), and one snapshot fixes the destination so a later cfg change cannot redirect an approved call (`crates/driver/src/remote_build.rs:198-199`).
- *The capability switch.* `sv_exec_agent_runs` decides whether the model has the `remote_build` tool at all. It is off by default, and a session composed while it is off has no such tool (`crates/driver/src/remote_build.rs:39-47`). It is `archive` only, so a model with the shell route could turn it on for a later session (**inference** from the flag table and matrix rows 9 and 18).
- *Invariants the code already states.* "No project cfg can choose a remote endpoint or credential" (`crates/driver/src/adw/remote.rs:3-4`), and `sv_exec_policy` is "always operator-controlled, never project cfg" (`crates/driver/src/adw/remote.rs:69`). They hold only because none of these variables carries `PROJECT`. T7 pins them.
- *Gaps.* The prompt names the endpoint and the command but not the credential source, so an `env:NAME` credential would leave with the upload under an approval that shows only the endpoint and the command (**inference** from the text at `crates/driver/src/remote_build.rs:327-351`). The `omp jobs` resume resolves a command credential in a project Environment with no new prompt, but only for a job whose journaled destination matches the configured one (`crates/driver/src/exec_composer.rs:743-750`, `:798-800`; caller `crates/app/src/jobs_cmd.rs:91`).

### Every write path and its provenance

Provenance is the `SetSource` the engine evaluates. "Flag gate would block it" asks: if the variable carried `READONLY` or `UNSAFE` (with `sv_cheats` off), would the existing gates stop this path? Rows 1 to 17 are writes through the convar engine; rows 18 to 20 are the routes the model has or would have; row 21 is the remote-participant route.

| # | Path | Entry point | Stream, origin, provenance | Reaches the five families? | Flag gate would block it? |
|---|---|---|---|---|---|
| 1 | User `config.cfg` at startup | `crates/app/src/lib.rs:154-169` calls `exec_configs`; `crates/con/src/ctx.rs:1498-1500` | `Source::Config`, `Origin::Archive` (`ctx.rs:90`), **`Code`** (`:2286`) | Yes, any variable | **No**: `Code` bypasses |
| 2 | Project overlay of `config.cfg` | `crates/con/src/ctx.rs:1501-1505` | `Source::Project`, `Origin::Project` (`:96`), project authority (`:100-103`), `Script` (`:2285`) | **No.** No in-scope variable has `PROJECT`, so `vet_project_statement` refuses it (`sv_tools` is outside the five families and does carry it, Q11) (`:1714`, `:1725-1731`). Pinned for `sv_sandbox_mode` by `crates/app/tests/config.rs:330-357`. | Never reached; the flags would stack on `PROJECT` (`crates/con/tests/project.rs:24-28`) |
| 3 | `subagent.cfg`, `<agent>.cfg` (the user's text) | `exec_spawn_configs`, `crates/con/src/ctx.rs:1515-1529` | `Source::Subagent` or `Source::Agent`, `Origin::Class` (`:93-95`), **`Script`** (`:2285`) | **Yes**, and tested: `sv_sandbox_mode read-only` in `reviewer.cfg` (`crates/driver/src/headless/con_journal.rs:896`, `:956`, `:1023`) | **Yes: blocks it** |
| 4 | Project overlays of the class cfgs | `crates/con/src/ctx.rs:1520`, `:1526-1527` | `ProjectSubagent`, `ProjectAgent`, `Class` with project authority, `Script` | No (same `PROJECT` refusal as row 2) | n/a |
| 5 | Composer commands, console, settings panel | `crates/chat/src/host.rs:2791-2793` (`run_console`); composer `:2514-2536`; panel events `:3675-3703`; `set_var` at `crates/chat/src/commands/misc.rs:107-113` | `Source::Console`, `Origin::Script("console")` (`crates/con/src/ctx.rs:92`), **`Script`** | Yes, any typed name. The settings UI lists only `sv_browser_cdp_url` among the five families, plus the two approval variables. | **Yes: blocks it** |
| 6 | `exec <name>` | `run_named`, `crates/con/src/ctx.rs:1621-1644` (callers `:1603`, `:1923`) | `Origin::Script(name)` with user authority, **`Script`**; its project half as row 2 | Yes, if the user's own cfg holds it | **Yes: blocks it** |
| 7 | Key binds | `exec_key`, `crates/con/src/ctx.rs:2083` | `Source::Console`, **`Script`** | Yes | **Yes: blocks it** |
| 8 | `toggle` builtin | `crates/con/src/builtins.rs:189-220` | Always `SetSource::Script` (`:220`), whatever stream called it | The bool and enum variables | **Yes: blocks it**, even when called from `config.cfg` |
| 9 | **`omp config set`, global scope** | `crates/app/src/config_cmd.rs:39`, `:657-671`; throwaway context `:540-571` | `Source::Config("config.cfg")`, `Archive`, **`Code`** | Yes, any variable. Rewrites the file; nothing reaches a running session (below). | **No: bypasses** |
| 10 | `omp config set --scope project` | `crates/app/src/config_cmd.rs:672-678`, `:589-602` | `Source::Project` after `require_project_scoped` | **No**: refused for any name without `PROJECT` | n/a |
| 11 | `omp config unset` | `crates/app/src/config_cmd.rs:40-62` | Global: `ctx.set(.., Origin::Default)`, `Code`. Project: `ctx.unset(.., &Origin::Project)`, `Script` (`crates/con/src/ctx.rs:872-875`) | Global: yes | Global: **No**. Project: n/a |
| 12 | CLI flags | Typed host writes at `crates/app/src/chat_cmd.rs:936-974`. `--add-dir` (`crates/app/src/cli.rs:1946`) writes `sv_sandbox_readable_roots` and `sv_sandbox_writable_roots` at `crates/app/src/chat_cmd.rs:984-992`. There is no `+set`. | `Ctx::set_typed`, `Origin::Host`, **`Code`** (`crates/con/src/ctx.rs:824-827`) | Yes: the two roots | **No: bypasses** |
| 13 | RPC mode | `set_con`, `crates/app/src/rpc_mode.rs`, typed since merged PR #657 (`1469b1dd70`). Fixed callers set only `ai_fastmode`, `ai_model` and `ai_thinking`; commands arrive on the RPC client pipe, not a model channel | `Source::Session`, `Origin::Session`, **`Code`** | **No** since #657: fixed names and one typed set per call (`origin/omp2` `crates/app/src/rpc_mode.rs:3861`, `:3892`). Before #657, **yes**: a value could inject a second statement (Q9) | **No**: `Code` bypasses `READONLY` and `UNSAFE` |
| 14 | Subagent spawn and inheritance | `crates/driver/src/subagent/spawn.rs:1156-1224`; `crates/driver/src/subagent/settings.rs:557-575` | `Origin::Class` and `Origin::Inherited` host writes, **`Code`** | The spawn path names only `sv_task_recursion_depth`, `sv_tools_read_only`, `ai_thinking`, `ai_model`; the child otherwise receives the parent's effective values (`crates/driver/src/subagent/settings.rs:567-569`). It copies the parent's posture and never widens it. | **No: bypasses** |
| 15 | Session replay | Replay of a session-tree convar (`crates/con/src/ctx.rs:74-75`) | `Source::Session`, `Origin::Session` (`:91`), **`Code`** (`:2286`) | Only `sv_approval_mode` carries `session` (`crates/agent/src/vars.rs:247`), and it is unenforced | **No: bypasses** |
| 16 | Replica or remote | `crates/con/src/repl.rs:108`; gates and `validate` skipped (`crates/con/src/ctx.rs:59-60`, `:1404-1408`) | `SetSource::Replication` | Latent: no production authority or replica context (above) | **No: bypasses** by design |
| 17 | Host code | `CVar::set` and `set_in`, `crates/con/src/handle.rs:54-65` | **`Code`** | No production `CVar::set` or `set_in` writer found: every typed `.set(` of these variables is inside a test module (`crates/envd/src/exec_settings/sandbox.rs:672` on, `crates/driver/src/exec_composer.rs:820` on, `crates/driver/src/adw/remote.rs:10` on). The one production writer is by name, not typed: `Ctx::set_typed` for `--add-dir` (row 12, `crates/app/src/chat_cmd.rs:991`) | **No: bypasses** |
| 18 | **The model's shell and file tools** | Shell: a subprocess in the sandbox; the convar writer I found it can run is `omp config` (rows 9 to 11). File tools: `write` and `edit` normalise the target lexically and expand `~` from `HOME` (`crates/tools/src/path.rs:171-190`, `:351-370`). `edit`, and a `write` whose target is inside the Environment root, reach the disk through the document host, whose only ambient capability is the Environment root (`crates/envd/src/docserver/fs.rs:495`, `:2042-2052`). A `write` whose target is outside the root is not refused: it resolves with `use_document_host` false (`crates/envd/src/tool_document.rs:2111-2146`, `:2142`), and `write_plain` creates the parent directories and writes the file directly with `atomic_write_plain` (`:1878-1886`, `:2210`); the test at `:2627` pins that resolution. | Not an in-process convar path: no provenance applies | Yes. Shell: through row 9. File tools: by rewriting `config.cfg` directly. `write` reaches it wherever it is (outside the Environment root through the direct branch, inside it through the document host); `edit` only where the Environment root contains it. | **No.** The sandbox confines the shell subprocess, not the direct write (**inference**: the daemon process is not itself sandboxed). `LocalFs` never sees an outside-root `write`. The only check before the direct branch is the plan-mode and read-only-subagent scope (`crates/envd/src/write_scope.rs:137`, called at `crates/envd/src/tool_document.rs:1855`). Approval does not read the target path (below). Nothing names the config root. |
| 19 | Extensions | `omp.convars` exposes `declare`, `get`, `observe` (`crates/py/python/omp/convars.py:40`, `:85`, `:120`); `declare` makes extension-owned variables (`:49-53`) | n/a | No | n/a |
| 20 | The `config` device (proposed) | ADR 0058 C2 (`docs/adr/0058-context-url-schemes.md:41`, `:91-92`). No `cfg://` scheme exists in non-test code on the research baseline. | Required by D2/D3: `SetSource::Model`, not the older C2 proposal's `SetSource::Script` | Not built; cannot ship without the model gate and reviewed opt-in names in the same caller bundle | The first intended model-attributed writer; not a gate on today's shell or file writes |
| 21 | A remote collaboration guest | `GuestAction::admit`, `crates/driver/src/collab/admission.rs:128`, applied at `crates/app/src/chat_control.rs:1210-1220` | Not a convar stream: a guest mutation is admitted only as `Prompt`, `Interrupt` or `Agent` with `Chat`, `Kill` or `Revive` (`crates/driver/src/collab/admission.rs:82-105`) | **No** | n/a |

What the matrix shows:

1. **The flags can only stop `Script` writes, and the only `Script` text that reaches these variables is the user's own**: console, settings panel, `exec`, key binds and agent-class cfgs (rows 3, 5, 6, 7, 8). Repository text is refused earlier by `PROJECT` (rows 2, 4, 10). That is the door the flag proposed below reuses for the model.
2. **The model has no in-process route today.** RPC has fixed setter names and no model channel; its separate statement-injection finding was fixed by merged #657 (row 13, resolved Q9). A remote collaboration guest can only prompt, interrupt or control agents (row 21). The Python extension API has no setter for core variables (row 19; `docs/adr/0058-context-url-schemes.md:69`). ADR 0058's device is not built; it would add session setting reads and selected writes without a shell call (`:81`). Today's model routes remain row 18: the shell ends in `Code` (row 9); `write` can rewrite `config.cfg` even outside the Environment root through its direct branch (`crates/envd/src/tool_document.rs:1885-1886`), and `edit` can do so where the Environment root contains it.
3. **A model write to the session layer would be persisted** (**inference**: each step was read, the path was not run). `Layers::persisted` is engagement, then session, then archive (`crates/con/src/layers.rs:193-198`). `dump` records that value for `archive` variables (`crates/con/src/dump.rs:126`, with `include_session_defaults` for `writecfg` at `:33-35`). `writecfg` runs after unrelated user actions, for example the model picker (`crates/chat/src/host.rs:3869`). ADR 0058 says the device never persists (`docs/adr/0058-context-url-schemes.md:48`) and names the session layer as the mechanism (`:41`). As drafted that mechanism does not hold, so D2 makes non-persistence a tested requirement.
4. **`toggle` ignores the calling stream's provenance** (row 8). The first Model caller bundle MUST preserve effective `Model` provenance through this builtin or refuse it, and test that an unflagged target is denied. User console and `config.cfg` toggles keep their existing `Script` gate; this rule MUST NOT promote those writes to `Code`.

### The config root, the sandbox and the file tools (O7, from code)

- **Where.** User configuration lives in `~/.o2`, or `~/.o2/profiles/<name>` under a profile: "user configuration (`config.cfg`, agent assets, cfg scripts) lives in `~/.o2`" (`crates/core/src/dirs.rs:87-91`, `:204-210`, `:218-221`). `OMP_CONFIG_DIR` overrides it when set and non-empty (`crates/core/src/dirs.rs:95-101`; `AGENTS.md:658`), which is how the tests redirect it (`crates/app/tests/config.rs:299`).
- **What the default sandbox can write.** In `workspace-write`, the default (`crates/envd/src/exec_settings/sandbox.rs:185`): the workspace root, `sv_sandbox_writable_roots`, the platform temp directory and `/tmp` (`crates/envd/src/exec_sandbox.rs:1356-1370`). The config root is outside that set unless the workspace root or a configured root contains it (**inference**: read, not exercised).
- **What protects a root.** Under the workspace root and each configured writable root (the temp directories are added unprotected, `crates/envd/src/exec_sandbox.rs:1358-1370`) the sandbox denies writes to `CARVE_OUTS`, which is `.git`, `.omp`, `.agents` (`crates/envd/src/exec_sandbox.rs:37`, applied at `:1386-1397`). That protects the project overlay directory `.omp`. It does not name `.o2`, and `exec_sandbox.rs` has no other rule for the config root (grep for `.o2`, `user_config_root`, `config_dir`, `profile_config_dir`: no match). The user-set deny list `sv_sandbox_write_deny` can name it (`crates/envd/src/exec_settings/sandbox.rs:321`, applied at `crates/envd/src/exec_sandbox.rs:1404`), but it is user text, so D5 must not rely on it. So if the workspace root is the home directory, or the user adds the config root to `sv_sandbox_writable_roots`, a sandboxed `omp config set` can rewrite `config.cfg` (**inference**).
- **The model's file tools.** `write` and `edit` normalise the authored path lexically and expand `~` (`crates/tools/src/path.rs:166-190`). `edit`, and a `write` whose target is inside the Environment root, then reach the disk through the document host, which "opens the configured Environment root as the sole ambient capability" (`crates/envd/src/docserver/fs.rs:495`) and rejects an absolute target outside it with "target escapes the Environment root" (`crates/envd/src/docserver/fs.rs:2042-2052`, used by `canonicalize` at `:531-536` and `resolve_entry` at `:1616-1622`). That check binds `edit` and an in-root `write`. It does not bind a `write` whose target lies outside the Environment root: `resolve_plain_write_from_root` accepts an absolute or `../` target after expanding `~` (`crates/envd/src/tool_document.rs:2111-2146`) and sets `use_document_host` only when the target is inside the root (`:2142`), and `write_plain` then creates the parent directories and writes the file with `atomic_write_plain`, without the document host (`:1878-1886`, `:2210`). The test `plain_write_resolution_accepts_absolute_and_parent_relative_targets` pins that resolution (`:2627`), and the only check before the direct branch is the plan-mode and read-only-subagent scope (`crates/envd/src/write_scope.rs:137`, called at `tool_document.rs:1855`). So `write` reaches the config root wherever the workspace does not contain it, which is the usual layout (**inference**), and `edit` reaches it only where the Environment root contains it, the same condition as the sandboxed shell. I found no protected-name list in the document host or the file tools (grep for `.git`, `.omp`, `.agents` and `protected` in `crates/envd/src/docserver/fs.rs`, `crates/tools/src/write.rs`, `crates/tools/src/edit.rs` and `crates/edit/src/path_policy.rs`, 2026-11-15; **inference** from the absence). Under the default posture write-tier tools are auto-approved: `write` mode "Auto-approve read-only and write tools" and the default `yolo` follows `write` for tools no sandbox confines (`crates/envd/src/tool_settings.rs:104-108`). The tier depends only on whether the call declares any document write glob, never on the target path (`crates/contract/src/posture.rs:382-409`).
- **When there is no sandbox.** "Where the platform cannot construct it, commands run unsandboxed under `write` approval; a sandbox you set yourself fails instead" (`crates/envd/src/exec_settings/sandbox.rs:181-183`). With `sv_sandbox_mode off` the shell has the user's file permissions, and no convar gate can help.
- **Does a persisted value take effect in the running session?** `omp config set` builds a throwaway context from the file, applies the assignment and atomically rewrites the whole file (`crates/app/src/config_cmd.rs:540-571`); it never reaches a running session. I found no file watcher or reload of `config.cfg` (grep of `crates/app`, `crates/driver`, `crates/con` and `crates/chat`: only git and notification watchers). **Inference**: the value takes effect at the next start or at an explicit `exec`. The environment daemon compiles its sandbox, egress broker and approval posture once, at start, and clients with a different policy digest reach a different daemon (`crates/envd/src/daemon_policy.rs:4-6`, `:17-23`).

## Decision

Answer to O6: protect the live shell and file-tool boundaries first, without blanket `READONLY` or `UNSAFE` flags. User-authored paths keep working. The deferred provenance gate applies only when a real model caller ships with it. O6 is **not fully mitigated with the sandbox off**: an unsandboxed shell still has the user's file permissions. Q2, the owner's protected-path admission decision and its enforceable acceptance conditions, MUST be resolved before accepting this record as a complete O6 closure. PR #657 closes the separate RPC statement-injection finding; it does not close the unsandboxed shell route.

**D1. No blanket `READONLY` or `UNSAFE`.** The five families, the other `sv_exec_*` variables, `sv_tools_approval_mode`, `sv_tools_approval` and `sv_shell_command_prefix` MUST NOT be flagged `READONLY` or `UNSAFE` as a measure against the model or a repository (Options B and C).

**D2. A model provenance, closed by default, deferred until its first caller.** S1 and S2 MUST land in the same PR as ADR 0058 C2's first production caller. The rules below are that bundle's contract, not permission to ship an unused provenance path.

- `SetSource` MUST gain `Model`: a write made on behalf of the model through a tool call. The name avoids `Source::Agent(Str)`, which already means an agent-class cfg (`crates/con/src/ctx.rs:72-73`).
- `VarFlags` MUST gain `MODEL_WRITABLE`, with macro keyword `model_writable` beside the existing keywords (`crates/con/src/macros.rs:21-46`). It mirrors `PROJECT`: opt-in, and a variable without it is unreachable.
- `check_gates` MUST refuse a `Model` write to a variable without `MODEL_WRITABLE` with a new `ConError::ModelVarDenied { name }`, and MUST then apply the `READONLY` and `UNSAFE` gates to `Model` exactly as to `Script`.
- A builtin invoked with effective `Model` provenance MUST retain that provenance or refuse the operation. In particular, `toggle` MUST NOT convert it to `Script` before the `MODEL_WRITABLE` check (`crates/con/src/builtins.rs:189-220`). The bundle MUST test a model-origin toggle of an unflagged variable. Existing user console and `config.cfg` toggles keep their current `Script` gate; this change MUST NOT widen them.
- `Model` writes MUST map to `Origin::Session` and report the existing session layer. Preserve `set_value -> ConResult<()>`; add `set_value_report -> ConResult<SetReport>` for callers and T2 that need the report. Track model-authored session keys and exclude them from `Layers::persisted`, `dump` and `writecfg`. A later user write must replace that model-only tag under the existing user persistence rules. Do not add a dedicated non-session layer: it would contradict T2's `committed_to` contract (`crates/con/src/ctx.rs:836-844`, `:1366-1368`; `crates/con/src/layers.rs:62-64`, `:193-197`; `crates/con/src/dump.rs:52-53`, `:126-131`).
- `Ctx::unset` already takes an `Origin`; it does not take an independent `SetSource`. Add one sibling, `unset_with_source(name, source: SetSource)`, for the Model caller. Keep `unset(name, origin)` unchanged, and do not infer Model from `Origin::Session`. The builtin unset, `Ctx::reset` and `config_cmd` keep their current origins (`crates/con/src/ctx.rs:850`, `:868-875`; `crates/con/src/builtins.rs:230`; `crates/app/src/config_cmd.rs:53`).
- No existing variable gains `MODEL_WRITABLE` from this record.
- Variables that extensions declare carry no flag, because `omp.convars.declare` takes none (`crates/py/python/omp/convars.py:40-48`), and dynamic variables commit with their declared flags (`crates/con/src/ctx.rs:1817-1835`). They are therefore closed to the model by default; opening one is a decision for its owner, not a side effect of this record.

**D3. The `config` device writes as `Model`.** ADR 0058 C2 MUST write with `SetSource::Model`, never `SetSource::Script`. Its allowlist is the set of variables carrying `MODEL_WRITABLE`, grown "by reviewed PR, one name at a time" (`docs/adr/0058-context-url-schemes.md:41`). This record flags no existing variable, so that allowlist starts empty. ADR 0058's three initial members, `ai_default_thinking`, `cl_status_line_preset` and `cl_display_show_token_usage` (`:41`), are withdrawn as automatic grants: each joins only if the caller bundle flags it by name, with its own test. That bundle MUST amend ADR 0058 in the same PR, and MUST NOT ship an unwired engine slice or keep the old allowlist silently.

**D4. `sv_cheats` is unchanged, and it is a precondition for any future `UNSAFE` variable.** It stays console-settable, `replicated` and `notify`. No production variable may be flagged `UNSAFE` until the same change (a) adds a registry test proving that `Model` and `Project` provenance cannot set `sv_cheats`, and (b) records the owner's decision on whether the human console may enable it (`crates/con/tests/console.rs:276` pins that it can).

**D5. Protect the config root at each live write boundary.** Resolve the user config root from non-empty `OMP_CONFIG_DIR` or `~/.o2`, including the profile directory (`crates/core/src/dirs.rs:95-101`, `:204-210`). The protected set holds canonical absolute paths. The guard must resolve the target, including an existing ancestor when the leaf is new, before containment comparison; lexical `~`/`..` normalization alone is not a symlink proof. S3b MUST name that canonicalization step and test a symlink alias to the config root, not substitute an unrelated Environment-root escape test. Apply the protected set (a) in the production sandbox policy builder, even under a writable root, and (b) to every file-tool write, whether or not its Environment root contains the target. In `write_plain`, run the guard beside the existing `write_scope::admit_path` call after `resolve_plain_write` and before `create_dir_all` or the document-host/direct branch (`crates/envd/src/tool_document.rs:1852-1886`). Keep task-scope admission: the protected-root check is a different, unconditional boundary and MUST run even when `write_scope::current()` is `None` (`crates/envd/src/write_scope.rs:137-138`). Apply it also in the document-host prepare path used by `edit` (`crates/envd/src/docserver/fs.rs:564`). `CARVE_OUTS` is relative to each root (`crates/envd/src/exec_sandbox.rs:37`); this is a shared absolute protected-path set, not another carve-out name. The built-in rule MUST NOT be a default of the user-editable `sv_sandbox_write_deny` list (`crates/envd/src/exec_settings/sandbox.rs:321`), which a rewritten config could lift. An unsandboxed shell remains outside this filesystem boundary; Q2 is still required.

**D6. `sv_approval_mode` is not an approval control.** Code and policy MUST NOT rely on it as enforced approval. Approval policy is `sv_tools_approval_mode` and `sv_tools_approval` (`crates/envd/src/tool_settings.rs:92-123`). Deleting `sv_approval_mode` is an owner decision (Q3); no slice here depends on it.

**D7. A registry invariant test pins the result.** For the security set named in slice S2 the test MUST assert that `MODEL_WRITABLE` and `PROJECT` are absent, that `Model` writes fail, and that the user paths still write.

Here, the security set means the explicit S2 registry list, not every setting that can affect security. `sv_tools` is an explicit exception: it remains project-writable and can widen the tool surface. Q11 is an unresolved owner scope decision, not evidence that repository-controlled tool selection is closed by this record. Do not silently remove `PROJECT` or claim full closure while that decision is open.

**What each decided gate stops, and what it can break.**

| Gate | Threat it stops | Legitimate use it could break | Where |
|---|---|---|---|
| D2 model provenance, closed by default | A future model-attributed in-process write, through the `config` device or a later caller, to an unflagged variable including `sv_cheats`; not today's shell or file writes | A future model write to a name not explicitly flagged is refused by design. No production caller exists today. | Matrix row 20 (deferred); row 18 is stopped only by D5 where its boundary holds |
| D5 config root protected from the sandboxed shell and the file tools | The model persisting a weaker posture by running `omp config set`, or by editing `~/.o2/config.cfg` from the sandboxed shell or with its `write` and `edit` tools | Any agent edit of the config root with the `write` tool from a workspace that does not contain it, which succeeds today through the direct branch (`crates/envd/src/tool_document.rs:1885-1886`); a user who runs with the workspace at `$HOME`, or lists the config root in `sv_sandbox_writable_roots`, and has the agent edit configuration through the shell or `edit` | Rows 9, 18; `crates/envd/src/exec_sandbox.rs:37`; `crates/envd/src/docserver/fs.rs:495`; `crates/envd/src/tool_document.rs:1852-1886` |
| D4 precondition on `UNSAFE` | A future `UNSAFE` variable guarded by an `sv_cheats` that a script can flip | None today | `crates/con/tests/console.rs:276` |
| `PROJECT` opt-in (existing; pinned by T7) | A repository's `.omp/*.cfg` setting a security variable | A project that wants to set a security variable: refused by design | Rows 2, 4, 10 |
| Rejected: `READONLY` on the families (B) | `Script` writes | The console, `exec`, the settings panel (`sv_browser_cdp_url`), `toggle`, agent-class cfgs such as `reviewer.cfg` | Rows 3, 5 to 8 |
| Rejected: `UNSAFE` plus a gated `sv_cheats` (C) | `Script` writes unless cheats are on | As B, plus the premise of `unsafe_gate_blocks_until_enabled` | `crates/con/tests/console.rs:272-279` |

## Options considered

**A. Do nothing.** Stops nothing new and breaks nothing. ADR 0058's "defence in depth" sentence stays empty for the five families (`docs/adr/0058-context-url-schemes.md:41`), the `sv_cheats` self-enable stays latent, and the device's only protection is its allowlist. Rejected as the end state; kept as the fallback if the owner declines D2.

**B. `READONLY` on the five families (the first branch of O6).**

- *Stops:* `Script` writes. Nothing the model or a repository can reach today: repositories are already refused by `PROJECT` (rows 2, 4, 10) and the model has no `Script` route (row 18 ends in `Code`).
- *Fit:* `READONLY` is the contract for state that only host code writes. Its one production user says so: `sv_tools_read_only` is "Scripts, cfgs, and the console cannot write it" and the host sets it at spawn (`crates/agent/src/vars.rs:260-268`, `crates/driver/src/subagent/spawn.rs:1160`). The five families are user-configured settings that the user writes through the console, cfgs and `omp config`, so the flag's contract does not fit them.
- *Breaks (inference from the paths above):*
  - Agent-class cfgs (row 3). Cfg streams run leniently (`crates/con/src/ctx.rs:1531-1535`), so the refused statement is skipped with a reported error and the asserted value is never set. `the_journaled_class_is_presented_before_the_environment_starts` (`crates/driver/src/headless/con_journal.rs:889-904`), `switching_to_a_class_of_another_policy_is_reported_once` (`:951`) and `a_resumed_child_never_joins_the_main_configurations_daemon` (`:1004`) would fail.
  - The console, `exec` and key binds (rows 5 to 7). `READONLY` is documented "Scripts can read but never write" (`crates/con/src/spec.rs:37`), and the human console is a script for this purpose (`crates/con/src/ctx.rs:57-58`).
  - The settings-UI edit of `sv_browser_cdp_url` (its error path is `crates/chat/src/host.rs:3687-3698`), and `toggle` on the bool and enum variables (row 8).
- *Misses:* rows 9, 11, 12 and 14, all `Code`.
- *Least-breaking subset:* `sv_exec_remote_*` alone has no settings-UI entry and no `Script`-provenance test (**inference**: no `ui.tab` key, and the only typed `.set(` calls are in test modules). It still protects nothing live.
- Rejected.

**C. `UNSAFE` on the five families plus a gated `sv_cheats`.**

- *Stops:* the same `Script` writes as B, unless cheats are on.
- *Why the gate has to move first:* for `UNSAFE` to mean anything, `sv_cheats` must stop being `Script`-writable, for example by becoming `READONLY` (today a console line enables it, `crates/con/tests/console.rs:276`). Then no `Script` stream can enable cheats and `UNSAFE` degenerates into `READONLY` for scripts, except for a user who persists `sv_cheats true` in `config.cfg` (`Code`). That one line turns the gate off for every `Script` writer at once: the console, class cfgs and any future model writer. The switch has no notion of who is writing.
- *Breaks:* everything B breaks unless cheats are on, plus the premise of `unsafe_gate_blocks_until_enabled` (`crates/con/tests/console.rs:272-279`) and the doc at `crates/con/src/builtins.rs:23-24`.
- *Misses:* the same `Code` rows as B.
- Rejected for these variables. The mechanism stays for a future variable under D4.

**D. A provenance gate for the model (chosen, with E).**

- *Stops:* any model-attributed write to a variable that has not opted in: `sv_cheats`, the five families, the adjacent approval and prefix variables, and every future security variable, with no per-variable edit. Policy is declared with the variable, as ADR 0012 requires (`docs/adr/0012-convars.md:72-77`).
- *Breaks:* nothing today, because no caller of `Model` exists. API additions only (see "Behaviour changes").
- *Misses:* out-of-process writes and `Code` (rows 9 to 12, 18). That is E.

**E. Close the shell and file-tool routes at their boundaries (chosen, with D).** Protect the config root from the sandboxed shell and from every file-tool write, including the direct branch of the `write` tool (D5). It stops the file-tool route in the default posture only if the check runs before `atomic_write_plain` (`crates/envd/src/tool_document.rs:1885-1886`), which T12 pins. It stops the shell route only where the sandbox confines the shell, and whether the default writable set already leaves `~/.o2` out is **inference** (read, not exercised; T10). It does not ask the convar engine to tell a model from a user. It does not help when the sandbox is off or cannot be constructed.

**F. A marker or TTY check inside `omp config set`.** Rejected. The model composes its own command line and environment, so a refusal it can bypass is not a boundary and invites false confidence (**inference**). Whether the shell tool sets any environment marker for children was not examined.

**G. Direction-aware gating: allow tightening, refuse loosening.** Deferred. It would let `reviewer.cfg` stay under a script gate, because `read-only` is a tightening, but it needs a per-type comparator across 33 variables and is not needed once user-authored `Script` streams stay allowed (D2).

**H. Land the live boundary protection first; defer model provenance to its first caller (adopted).** S3a and S3b ship first, followed by S4's documentation. They close the sandboxed shell and file-tool paths, not an unsandboxed shell; Q2 remains an acceptance dependency. D2, S1 and S2 MUST land together with ADR 0058 C2's first production caller, its reviewed initial allowlist, and a test proving a device write to an unflagged variable is refused with `ModelVarDenied`. Neither C2 with `Script` provenance nor dormant S1/S2 code may ship separately.

## Slices

Identifiers stay S1-S5. This list is the execution order. It replaces both "one PR each, in order" (which put S1 first) and "S3 alone and first" (Option H, outside this section). Those two sentences are not both in force.

1. Live protection first: S3a, then S3b. These are the only slices with a user-visible effect today.
2. Then the documentation of that close and of what it does not close (S4's boundary note). It does not amend ADR 0058.
3. S1 and S2 are deferred, and inseparable from their first real caller, ADR 0058 C2. They land only in that same PR. A test, or `omp config list` showing a flag, is not a caller. The ADR 0058 amendment travels with that PR, not before it; it is not part of S4.

Owner decisions that block a safety claim are gates, not slices to append after S3 ships. Q2 blocks any claim that the shell route is closed. Q3 does not (D6). S3 may merge while Q2 is open only if the record still says the unsandboxed shell is open.

"Red today" says why a test fails on `omp2` now; "Red after step 0" says why it fails once S1 step 0 adds the symbols. "Pin" means it passes now and must keep passing.

Sandbox-off residual stays explicit. S3a stops the shell only where a sandbox policy confines it. `ExecSandbox::compile` returns `Ok(None)` when mode is `Off` and the rest of the policy is default (`crates/envd/src/exec_sandbox.rs:357-364`). When `Off` still builds a spec, that spec preserves the host filesystem view (`:411-414`). An unsandboxed shell keeps the user's file permissions and can rewrite `config.cfg`. Sandbox-only rules do not stop it. Q2 is the acceptance dependency for that residual, and for write-tier auto-approval of a config-root write. A green S3 does not satisfy Q2.

### S0. Pins that must stay green

- `crates/con/tests/console.rs:272` `unsafe_gate_blocks_until_enabled`
- `crates/con/tests/console.rs:311` `readonly_blocks_scripts_but_not_host_code`
- `crates/con/tests/project.rs:69` `a_project_may_set_only_convars_that_opt_in`
- `crates/con/tests/project.rs:123` `script_gates_still_apply_to_a_project`
- `crates/driver/src/headless/con_journal.rs:889` `the_journaled_class_is_presented_before_the_environment_starts`, `:951` `switching_to_a_class_of_another_policy_is_reported_once` and `:1004` `a_resumed_child_never_joins_the_main_configurations_daemon` (class cfgs that set `sv_sandbox_mode`)
- `crates/driver/src/cfg.rs:638` `the_spawned_daemon_policy_comes_from_the_configuration_files_alone` and `:675` `spawn_configs_run_user_then_project_subagent_and_agent_cfgs`
- `crates/app/tests/config.rs:235` `config_set_persists_and_get_reads_back`, `:296` `project_scope_writes_only_project_scoped_convars_as_a_bare_overlay` and `:330` `a_hostile_project_overlay_cannot_reach_the_process_context`
- `crates/envd/src/docserver/fs.rs:3301` `symbolic_link_escape_is_confined`

These stay green through S3a and S3b, and again when S1 and S2 land with C2. S1 and S2 are not in the first wave, so this list is the S3 regression set.

### S1. Engine: model provenance and opt-in flag (D2)

Deferred. No production caller exists. `SetSource` is `Code | Script | Replication` (`crates/con/src/ctx.rs:53-60`). Adding `SetSource::Model` in this wave would be provenance with no production caller, which the house rule forbids (`AGENTS.md:567`: done means compiles, wired, exercised). Tests in `crates/con`, and `flag_names` so `omp config list` shows the flag (`crates/app/src/config_cmd.rs:642-655`), do not count as a caller.

Lands only in the same PR as S2 and the first real ADR 0058 C2 caller. C2 MUST NOT ship before that PR. That PR MUST include a test that a device write to an unflagged variable is refused with `ModelVarDenied`. Until then T1 to T5 are not an exit gate.

Files, when the caller bundle is cut: `crates/con/src/ctx.rs` (`SetSource` at `:51-61`, `set_value` at `:836-845`, `check_gates` at `:1413-1430`, `unset` at `:872`), `crates/con/src/spec.rs` (flag), `crates/con/src/macros.rs` (keyword), `crates/con/src/error.rs` (denial), `crates/con/src/layers.rs` and `crates/con/src/dump.rs` (model-tagged session persistence), and the C2 production caller. `crates/app/src/config_cmd.rs:642-655` only displays flag names and is not that caller. Tests in `crates/con/tests/console.rs` need three separate fixtures: `archive, model_writable`; `readonly, model_writable`; and `unsafe, model_writable`. Existing unflagged fixtures pin the default denial.

Step 0 of that bundle adds only the symbols, with no gate: `SetSource::Model`, `VarFlags::MODEL_WRITABLE` with its `model_writable` keyword, `ConError::ModelVarDenied`, `set_value_report` and `unset_with_source`. T1 to T5 then compile and fail on their assertions until `check_gates` gains its `Model` arm and the dump exclusion lands. Step 0 never ships on its own.

| Test | Asserts | Red after step 0 because |
|---|---|---|
| T1 `model_writes_are_refused_unless_the_variable_opts_in` | `set_value_report(.., SetSource::Model)` on `test::difficulty` gives `ModelVarDenied` and leaves the value; the same call on the `model_writable` fixture succeeds | `check_gates` has no `Model` arm yet, so the write to the unflagged fixture succeeds |
| T2 `model_writes_are_never_dumped` | A permitted Model write uses `set_value_report -> ConResult<SetReport>`, reports the session layer in `committed_to`, and is absent from `dump()`, `dump_with_options(DumpOptions { include_session_defaults: true, .. })` and `writecfg`. Preserve `set_value -> ConResult<()>` for its existing callers; T1, T2 and T5 use the report-bearing sibling. Exclude model-tagged session keys from persistence; no dedicated layer | These are future caller-bundle tests, not runnable proof in today's tree. A naive session-layer commit persists through `Layers::persisted` (`crates/con/src/layers.rs:193-198`, `crates/con/src/dump.rs:126`) and must fail the regression |
| T3 `model_writes_still_honour_readonly_and_unsafe` | A `model_writable, readonly` fixture refuses with `ReadOnly`; a `model_writable, unsafe` fixture refuses with `UnsafeGated` until `sv_cheats` is set with `SetSource::Code` | `check_gates` applies `READONLY` and `UNSAFE` only to `Script` (`crates/con/src/ctx.rs:1421-1428`), so both Model writes succeed |
| T4 `model_unset_is_gated_like_model_set` | `unset_with_source(.., SetSource::Model)` on an unflagged variable is refused; a console `unset` still works | `unset_with_source` has no Model check yet, so the unset succeeds. Today `unset` takes `Origin` and derives `SetSource` through `statement_source` (`crates/con/src/ctx.rs:872-875`), with no `Model` arm |
| T5 `the_model_cannot_enable_sv_cheats` | `set_value_report("sv_cheats", Bool(true), SetSource::Model)` gives `ModelVarDenied` and `unsafe_enabled()` stays false; `ctx.run("sv_cheats true")` still enables it | No `Model` arm, so the write enables `sv_cheats` |

Sketch of T5 (names indicative):

```rust
#[test]
fn the_model_cannot_enable_sv_cheats() {
	let ctx = Ctx::new();
	let err = ctx
		.set_value("sv_cheats", Value::Bool(true), SetSource::Model)
		.unwrap_err();
	assert!(matches!(err, ConError::ModelVarDenied { .. }), "{err:?}");
	assert!(!ctx.unsafe_enabled());
	ctx.run("sv_cheats true").unwrap(); // the human console is unchanged (D4)
	assert!(ctx.unsafe_enabled());
}
```

Exit gate: T1 to T5 and the S0 pins, in the C2 PR only. Not a gate for S3.

### S2. Registry invariant on the full context (D7)

Deferred with S1. Same PR as the first C2 caller. T6 needs the symbols S1 adds, so S2 cannot land earlier. Not an exit gate for S3.

File: `crates/app/tests/config.rs`. Fixture: `omp_app::process_ctx(project.path())` (`crates/app/tests/config.rs:184`), with the config directory redirected as `crates/app/tests/config.rs:299` does. Security set: `sv_cheats`, `sv_approval_mode`, `sv_tools_approval_mode`, `sv_tools_approval`, `sv_shell_command_prefix`, `sv_browser_cdp_url`, and every variable whose name starts `sv_sandbox_` or `sv_exec_`.

T13 and T14 are this slice's boundary checks. Their producer is S2. Their exit gate is the C2 PR, not S3.

| Test | Asserts | Status today |
|---|---|---|
| T6 `no_security_convar_is_model_writable_or_project_scoped` | For each name: `MODEL_WRITABLE` and `PROJECT` are absent, and `set_value(name, default, SetSource::Model)` gives `ModelVarDenied`. The default value is used so the type check, which runs first (`crates/con/src/ctx.rs:1394-1403`), cannot mask the gate. | Red (compile) until S1; afterwards it guards every future edit |
| T7 `a_hostile_project_overlay_cannot_set_any_security_convar` | Generalises `crates/app/tests/config.rs:330-357` (one name) to the whole set through `Source::Project`: every statement is denied and `ctx.get(name)` is unchanged | **Pin**: expected green today (not run) |
| T8 `user_paths_still_write_the_security_set` | `Source::Config`, `Source::Console`, `Source::Agent("reviewer")` and `set_persisted(.., ConfigScope::Global, ..)` each set `sv_sandbox_mode read-only` | **Pin**: expected green today and after S1 (not run) |
| T13 `security_names_carry_no_readonly_or_unsafe` | For every name in the five families and the other `sv_exec_*`, approval and prefix variables, the declared flags contain neither `READONLY` nor `UNSAFE` (D1, D4) | **Pin**: expected green (not run) |
| T14 `user_paths_still_write_each_security_family` | Through each user path that T8 uses, one name from each family (`sv_sandbox_mode`, `sv_exec_remote_endpoint`, `sv_browser_cdp_url`, `sv_tools_approval_mode`, `sv_shell_command_prefix`) is written and read back (D7) | **Pin**: expected green (not run) |

T7 turns two invariants the code already states into a test: "No project cfg can choose a remote endpoint or credential" (`crates/driver/src/adw/remote.rs:3-4`) and `sv_exec_policy` "always operator-controlled, never project cfg" (`crates/driver/src/adw/remote.rs:69`).

Exit gate: T6 to T8 and T13 to T14, plus the S0 pins, in the C2 PR only.

### S3. Protect the config root (D5)

Two PRs, S3a then S3b, before S4 and before any Model work. This is the live fix: the user config root is write-denied to the sandboxed shell and to every file-tool write, including the direct outside-root branch of `write`.

**S3a. Sandbox policy.** The production builder is `policy_parts_with_approved_scope` (`crates/envd/src/exec_sandbox.rs:1223-1231`). `ExecSandbox::compile` (`:321`) calls `compile_amended` (`:327`, defined `:337`), which calls the builder (`:368`, `:418`). The builder takes no config-root argument. Writable roots are assembled at `:1356-1370`. `CARVE_OUTS` is `.git`, `.omp`, `.agents` (`:37`). The `#[cfg(test)]` wrapper `policy_parts` (`:1204-1221`) only forwards to the builder; S3a grows a parameter on that wrapper only to pass the protected root through. The root is added in `policy_parts_with_approved_scope`, not only in the test wrapper.

S3a and S3b both call one shared function this record adds, `protected_config_roots` (D5's protected-path set; not in the tree). It returns the user config root and the profile directory. It is not another `CARVE_OUTS` name, and it is not a default of `sv_sandbox_write_deny`.

Tests sit beside `default_workspace_policy_has_roots_carve_outs_network_and_env_scrubbing` (`crates/envd/src/exec_sandbox.rs:2264`). Fixture pattern: `policy_parts(...)` then `parts.file_policy.check_write(..)` (`:2269-2295`). That test says the workspace root and the temp directory are writable and that `CARVE_OUTS` are denied. It says nothing about a config root.

S3a does not stop an unsandboxed shell. See the residual above. T9 and T10 are S3a's exit gate. They do not satisfy Q2.

**S3b. File-tool writes, including the direct outside-root branch.** `DocumentHost::write_plain` (`crates/envd/src/tool_document.rs:1848`) resolves the path (`:1852`), then `write_scope::admit_path` (`:1855`, plan-mode and read-only admission, a different gate), then `create_dir_all` (`:1878`). If `!resolved.use_document_host` it takes the direct branch and calls `atomic_write_plain` (`:1885-1886`). `use_document_host` is false for a target outside the Environment root (`:2088`, pinned at `:2641`). S3b calls `protected_config_roots` in `write_plain` after `resolve_plain_write` and before `create_dir_all`, so the direct outside-root branch is refused before any directory is created, not only the document-host branch. The same function runs on the prepare path `edit` uses (`crates/envd/src/docserver/fs.rs:564`, commit at `:682`).

Tests sit beside `plain_write_resolution_accepts_absolute_and_parent_relative_targets` (`crates/envd/src/tool_document.rs:2627`) and `symbolic_link_escape_is_confined` (`crates/envd/src/docserver/fs.rs:3301`; fixture alias `create_filesystem` at `:2932`).

Each of T9 to T12 also runs once with `OMP_CONFIG_DIR` set and once with a profile directory (`crates/core/src/dirs.rs:95-101`, `:204-210`). One test asserts that `policy_parts_with_approved_scope` and `write_plain` (both branches) call `protected_config_roots`.

S3 exit gate: T9 to T12, plus the S0 pins. T13, T14 and T15 are not this gate. Q2 is not this gate.

| Test | Asserts | Status today |
|---|---|---|
| T9 `config_root_under_a_writable_root_is_write_denied` (S3a) | With the workspace root containing the config root, `check_write` of `<config root>/config.cfg` is an error and the path is in `write_denied`, while `check_write` of a sibling source file under the workspace still succeeds | **Red**. `policy_parts_with_approved_scope` takes no config-root argument (`crates/envd/src/exec_sandbox.rs:1223-1231`); the `#[cfg(test)]` wrapper `policy_parts` (`:1204-1221`) only forwards. S3a adds the root in the production function. `CARVE_OUTS` (`:37`) is `.git`, `.omp`, `.agents` and no other rule names the config root |
| T10 `config_root_outside_writable_roots_stays_unwritable` (S3a) | With the config root outside every writable root, `check_write` of its `config.cfg` is an error | **Pin**: expected green (not run), only if the fixture puts the config root outside `std::env::temp_dir()` and `/tmp`, which the writable set adds unless `exclude_tmpdir` and `exclude_slash_tmp` are set (`crates/envd/src/exec_sandbox.rs:1356-1370`; both default to false, `crates/envd/src/exec_settings/sandbox.rs:289`, `:294`) |
| T11 `config_root_inside_the_environment_root_is_not_writable_through_the_document_host` (S3b) | With the config root inside the Environment root, `prepare_write` then `commit_prepared` on a file under it (`crates/envd/src/docserver/fs.rs:564`, `:682`) is refused and the bytes on disk are unchanged; the same write elsewhere in the root succeeds | **Red**: the document host has no protected-path rule (grep for protected names, 2026-11-15) |
| T12 `write_outside_the_environment_root_cannot_reach_the_config_root` (S3b) | With the config root outside the Environment root, `DocumentHost::write_plain` refuses absolute, `../`, `~` (fixture-controlled `HOME`), and symlink-alias spellings before `create_dir_all` or the direct write. Resolve the alias to the protected canonical root; exercise this with `write_scope::current() == None` too. No directory is created and protected bytes stay unchanged. An unprotected outside-root write still succeeds through the direct branch. An Environment-root read/canonicalize refusal alone does not prove this guard | Expected pre-change failure from the unguarded direct branch (`crates/envd/src/tool_document.rs:1885-1886`); not run here. The existing `:2627` test pins path resolution, not protected-root refusal |

### Boundary checks (not an S3 exit gate)

T13 and T14 are specified under S2. T15 is not a slice of this record.

| Checks | Producer | Exit gate |
|---|---|---|
| T9, T10 | S3a, in `policy_parts_with_approved_scope` | S3a merged. Does not close an unsandboxed shell. |
| T11, T12 | S3b, in `write_plain`, direct outside-root branch included | S3b merged, with T9 and T10 still green. |
| T13, T14 | S2 | The C2 PR that also contains S1 and S2. Not required to merge S3. |
| T15 | Merged PR #657, commit `1469b1dd70` on `origin/omp2` | Already satisfied there. Not a prerequisite for S3, and not work to reimplement in this tree. |

T15 (Q9) is the regression proof of merged #657 (`1469b1dd70`), not new work: `set_con_does_not_run_a_second_statement_from_the_value` (`crates/app/src/rpc_mode.rs:3861`) and `set_thinking_level_accepts_only_the_listed_levels` (`:3892`). `set_con` now takes a typed `omp_con::Value` and calls `con.set(name, value, omp_con::Origin::Session)` (`:952-959`), and `known_thinking_level` (`:961`) rejects `high;sv_sandbox_mode off` and the same text with a newline. Before #657, `set_con` ran `con.exec(&format!("{name} {value}"), omp_con::Source::Session)`, the splice that row 13 records. Do not rebuild T15 to exit S3. `rpc_set_host_tools_is_accepted_only_between_turns` (`crates/app/tests/rpc_spine.rs:352`) is historical context only.

### S4. Documentation after the live close

Ships after S3b and before any Model work. Records what S3 closed and what it did not: the sandboxed shell, and every file-tool write including the direct outside-root branch, are write-denied at the config root; an unsandboxed shell is unchanged until Q2 is accepted. Does not claim sandbox-only rules stop an unsandboxed shell. Does not amend ADR 0058. No code.

The ADR 0058 amendment is not this step. It lands only in the same PR as S1, S2, and the first real C2 caller: C2 writes as `SetSource::Model`; the allowlist is the `MODEL_WRITABLE` set; the acceptance list at `docs/adr/0058-context-url-schemes.md:112` gains "refused by default, not by denylist". No code in that step either.

### S5. Owner decisions are gates, not trailing work

Q2 (admission classification of `omp config set`, `omp config unset`, and any write under the config root, by shell or by `write` and `edit`, including write-tier auto-approval) blocks the safety claim that those routes are closed. It is a gate on that claim. It is not a slice to append after S3 ships, and it is not implied by a green S3.

Q3 (`sv_approval_mode`) does not block S3 or S4. No slice here depends on it (D6).

Q11 (`sv_tools`) does not block S3 or S4. It is an open scope gate: `sv_tools` joins the S2 security list only if the owner adds it by name. Until then this record names the residual and does not claim the tool surface is closed.

## Behaviour changes

Accepting this record changes nothing in the tree. If S1 to S3 are built, the changes are exactly these:

| # | Change | Who notices | Slice |
|---|---|---|---|
| 1 | `SetSource` gains `Model`. The enum is exhaustive (`crates/con/src/ctx.rs:52-53` has no `non_exhaustive`), so an external exhaustive `match` would stop compiling. None exists: `SetSource` appears only in `crates/con` (`console.rs`, `repl.rs`, `handle.rs`, `builtins.rs`, `lib.rs`, `ctx.rs`). | Crate API only | S1 |
| 2 | `VarFlags` gains `MODEL_WRITABLE` and `var!` accepts `model_writable`. `omp config list` and its JSON print the flag for flagged variables (`crates/app/src/config_cmd.rs:615`, `:628`, `:642-655`). No variable carries it until the `config` device ships. | Readers of `omp config list --json` see a new flag string; additive | S1 |
| 3 | `ConError` gains `ModelVarDenied` | Reachable only through `Model` provenance | S1 |
| 4 | `Ctx::unset` gains the sibling `unset_with_source(name, source)`. `unset(name, origin)` and every existing caller keep their current provenance. | Internal | S1 |
| 5 | Model-provenance writes are excluded from `dump` and `writecfg` | Nobody today | S1 |
| 6 | The sandboxed shell and the `write` and `edit` tools of the model can no longer write the user config root. The shell is covered even when a writable root contains it, `edit` and an in-root `write` even when the Environment root contains it, and a `write` outside the Environment root, which succeeds today, is refused too | Users whose agent writes `config.cfg` with the `write` tool from a workspace that does not contain it, users who run with the workspace at `$HOME`, and users who add the config root to `sv_sandbox_writable_roots`, who rely on the agent editing configuration through the shell or the file tools. They must edit the file themselves. With the sandbox off, or where it cannot be constructed, the shell stays open: no shipped gate covers it, and whether a protected-path approval rule should is the open Q2. | S3 |
| 7 | When ADR 0058 C2 ships, the device refuses every variable without `MODEL_WRITABLE` | Agents | S1+S2+C2 caller bundle |

**Explicitly unchanged by this proposal:** the existing variable types, defaults and flags; `config.cfg`; the implementation of `omp config set` and `unset` (S3 confines their sandboxed use against the config root, not unsandboxed use); the console, composer, settings UI, `exec`, key binds and agent-class cfgs. `--add-dir` is still accepted and still adds its readable/writable root; S3 denies subsequent model writes beneath the protected config root even when that root was added. RPC has the independent merged #657 fix and needs no new S3 change. Spawn inheritance, project overlays (including the explicit `sv_tools`/Q11 residual), `sv_cheats`, and the test at `crates/con/tests/console.rs:272-279` are not changed here.

## Migration and compatibility

- **Persisted data.** `config.cfg` is a diff-from-default dump of `ARCHIVE` variables (`crates/con/src/dump.rs:1-10`). The new flag is not persisted and no cfg line changes. Existing `config.cfg`, `subagent.cfg` and `<agent>.cfg` files run unchanged.
- **Tests.** Under D no existing test changes. Under the rejected options these would: B breaks the three class-cfg tests; C also breaks the premise of `crates/con/tests/console.rs:272-279` and of `crates/con/src/builtins.rs:23-24`.
- **Rollout.** S3a and S3b protect the live boundaries first; S4 records the user-visible restriction and sandbox-off residual. S1 and S2 are deferred and MUST ship together with ADR 0058 C2's first production caller, not as dormant code. Q2 is a gate on accepting a complete O6 closure. Q9/T15 are a merged dependency supplied by #657, not a new optional implementation slice.
- **Rollback.** Delete the variant and the flag; nothing persisted depends on either. S3 reverts by removing the protected path.
- **Running daemons.** A daemon started by the build before S3 keeps the old rules until it restarts (Q8).
- **ADR 0058.** Its C2 test list (`docs/adr/0058-context-url-schemes.md:92`) already expects each of `sv_cheats`, `sv_sandbox_allow_domains`, `sv_approval_mode`, `sv_exec_remote_endpoint` and `sv_browser_cdp_url` to be refused. Under D3 that refusal comes from the engine rather than from the device's own list.

## Consequences

- **Easier.** A new security-relevant variable is closed to the model by default, with no per-variable edit. The device's defence in depth becomes real instead of resting on flags nobody carries. T6 fails the day someone opens a security variable to the model or to repository content.
- **Prohibited.** A model-attributed write to any variable that has not opted in, and any model write that reaches `config.cfg`.
- **Costs accepted.** One more provenance and one more flag in the engine, and an allow flag whose default is the opposite of `READONLY` and `UNSAFE` (it mirrors `PROJECT`, so there is precedent). A config-root rule in the sandbox and in the file-tool write path (both branches of `write_plain` and the prepare path of the document host) that a user can lift only by editing the file themselves.
- **Not solved.**
  - With `sv_sandbox_mode off`, or where the sandbox cannot be constructed, the shell has the user's file permissions and can rewrite `config.cfg`. No convar gate stops that, and no shipped approval rule is known to. Whether a protected-path approval rule should is the open Q2.
  - A file-writing tool other than `write` and `edit` could reach the config root; I read only those two, so every writer should consult the protected-path set (not verified).
  - A user-authored `Script` stream can still loosen any variable. That is the intended trust boundary: the user.
  - `sv_exec_remote_credential` is a command-valued variable: the host runs its text as an environment `exec` Script (`crates/driver/src/auth_backend.rs:1351-1364`) in a session that gets the host's compiled sandbox like any other (`crates/envd/src/exec.rs:552-554`, `:829`), so it is confined by the same posture and by none when the sandbox is off (**inference**: read, not exercised).

## Open questions for the owner

Numbered Q so they do not collide with ADR 0058's O1 to O7.

- **Q1.** Accept that O6 is answered by D1 to D7 rather than by flagging the variables? Recommendation: yes. B and C break a tested class-cfg path and the settings UI, and stop nothing the model can reach.
- **Q2.** Should the admission layer treat `omp config set`, `omp config unset` and any write under the config root, by shell or by `write` and `edit`, as a protected operation that needs approval even in `write` and `yolo` modes? Today write-tier tools are auto-approved in both (`crates/envd/src/tool_settings.rs:104-108`). The tier comes from the call's declared effects: any non-empty document `write_globs` is `Write`, and any command, network, subagent, inference or desktop effect is `Exec` (`crates/contract/src/posture.rs:382-409`). Nothing in that function looks at the target path, and `crates/envd/src/admission.rs` has no rule naming the config root (grep for `.o2`, `config.cfg`, `config_dir`, `user_config_root` and `outside_workspace`: no match). `tool_settings.rs:108` adds that "User policy can still prompt or block"; whether a shipped or user policy covers the config root was not examined, nor how `bash_ir` classifies an `omp config` command. Recommendation: yes for any model write under the config root, as a protected-path rule that shares its path set with D5, because approval is the only control that still works when the sandbox is off.
- **Q3.** `sv_approval_mode` has no enforcing reader. Delete it, or point `/security` at `sv_tools_approval_mode`? Recommendation: delete at the next convar cleanup and fix `scripts/qa/smoke-commands-b.ts:111`.
- **Q4.** Is direction-aware gating (Option G) wanted later? Recommendation: defer until a model writer exists that needs it.
- **Q5.** May the human console keep enabling `sv_cheats`? It matters only when the first `UNSAFE` variable is proposed (D4). Recommendation: yes.
- **Q6.** Should model session writes ever persist? ADR 0058 D3 says never (`docs/adr/0058-context-url-schemes.md:48`). Recommendation: never; T2 enforces it.
- **Q7.** Should the `remote_build` prompt show the credential source? It names the endpoint and the command but not an `env:NAME` or `!command` credential that leaves with the upload (see "`sv_exec_remote_*` in detail"). Recommendation: yes, show the source verbatim; it is a one-line change in `crates/driver/src/remote_build.rs` and sits outside this record's slices.
- **Q8 — resolved by `docs/design/continuation-authority.md`, Amendments 3 (2026-11-18).** The daemon policy digest now covers the protected paths, and `DOMAIN` is not bumped. That amendment records that `SandboxSettings::from_con` derives the host-protected paths (`<data>/ext` and `<config>/agent/extensions`) for every local session, so session digests change versus pre-change builds, and that the socket name is the build generation plus the keyed digest while stale owners are retired. The recommendation to bump `DOMAIN` in S3a is superseded.
- **Q9 — resolved by merged PR #657 (`1469b1dd70`).** RPC `set_con` no longer splices client strings into statement text: it uses typed `Ctx::set` with `Origin::Session`, and thinking levels are validated. T15 is the regression requirement of that merged fix, not an optional owner decision or an unimplemented S3 prerequisite. This removes the demonstrated parser injection without changing the RPC peer trust boundary or mitigating unsandboxed model shell writes.
- **Q10.** Is the whole config root the right protected scope? `~/.o2` also holds agent assets and cfg scripts, not only `config.cfg` (`crates/core/src/dirs.rs:89-90`), so D5 stops the model from writing those through the shell or the file tools too. Recommendation: protect the whole root (one path, no list to maintain); the cost is that only the user can author agent assets and cfg scripts there.
- **Q11.** Is `sv_tools` a security variable? It carries `PROJECT` (`crates/agent/src/vars.rs:258`) and an empty value allows every registered tool (`:249-255`), so a repository overlay could widen the tool allowlist (**inference** from the flags and the doc comment; not run). It is outside the five families, so this record leaves it alone. Recommendation: decide it as an S5 scope gate, independent of S3 and of the deferred S2: either add `sv_tools` to the S2 list by name and drop `PROJECT` from it, or record why repository widening is acceptable.

## Acceptance tests

S3a owns T9-T10; S3b owns T11-T12, including the direct outside-root branch, symlink spelling, and no-invocation cases; both retain the S0 pins. The future S1+S2+C2 caller bundle owns T1-T8 and T13-T14, including a model-origin `toggle` denial and all three flag-combination fixtures. These are proposed bundle tests, not passing tests in today's tree. T15 belongs to merged #657 and is not optional. Record acceptance additionally requires a source-backed matrix review and an explicit Q2 decision with enforceable protected-path acceptance checks. Q11 must either resolve the `sv_tools` scope or remain an explicit residual; this proposal does not claim complete O6 mitigation while those owner gates are open.

## Status in omp

**Status: Not started; proposal, not a complete O6 closure.** The live S3 protection and future Model caller bundle are not implemented. Q2 remains an acceptance dependency and Q11 remains an explicit scope decision. The independent RPC parser-injection fix is already merged as #657 (`1469b1dd70`).

- No `SetSource::Model` (the enum has three values, `crates/con/src/ctx.rs:51-61`), no `MODEL_WRITABLE` (`crates/con/src/spec.rs:24-44`), no config-root rule in the sandbox (`crates/envd/src/exec_sandbox.rs:37`) or the document host (`crates/envd/src/docserver/fs.rs:495`), and no `cfg://` device (grep of non-test code, 2026-11-15).
- Divergences: the brief's starting facts needed the corrections listed above; the comment at `crates/con/src/builtins.rs:9-10` names `con::unsafe` where the registered name is `sv_cheats`. The first draft of this record said the file tools reach the config root only where the Environment root contains it; an independent audit found that the `write` tool has a direct branch outside it (`crates/envd/src/tool_document.rs:1885-1886`), and the record now says so.
- **Not verified:** any runtime behaviour (no test or build was run); whether the sandboxed shell can write `~/.o2` in practice (neither `CARVE_OUTS`, `crates/envd/src/exec_sandbox.rs:37`, nor the writable set, `:1356-1370`, names it); whether the `write` tool writes `~/.o2` in practice (code reading says yes through the direct branch, `crates/envd/src/tool_document.rs:1885-1886`; T12 is the proof); whether a file-writing tool other than `write` and `edit` reaches the config root; whether a shipped or user approval policy already prompts for writes under the config root; how `bash_ir` classifies an `omp config` command; the credential `exec`'s confinement in practice (read, not exercised).
- Ledgers: `docs/adr/README.md:40-42` asks for `STATUS.md` and `TASKS.md` updates in the change that moves code; this record moves none. It adds a `STATUS.md` row, as ADRs 0062 to 0071 have, and, like them, no README index entry or `TASKS.md` row.

## Round 1 review resolution

The saved `crit`, `impl`, `zoom` and `comp` reviews were reconciled against the cited source and merged changes, not accepted by vote. Duplicate findings are grouped below; open owner decisions are not counted as implemented fixes. No new runtime proof is claimed. A scoped re-review of that revision (`b392f70258..2966d8d0b2`) found eight findings only partly addressed and four new defects: the identity of S4, the approval wording for an unsandboxed shell, the Q11 gate, and the T15 test names. The rows and sections below include those fixes.

| Review findings | Disposition |
|---|---|
| crit M1; zoom m2 | Summary, Decision, rollout, behaviour row 6 and Consequences distinguish the sandboxed boundary from an unsandboxed shell, and none claims approval covers the latter. Q2 blocks a complete O6 acceptance claim. |
| crit M2, m7; comp m5 | Row 13, Q9 and T15 describe merged #657, not optional or unimplemented parser hardening. Row 13 answers reach (No since #657; Yes before it, through injection) and the flag gate (No: `Code` bypasses) in their own cells. T15 cites the merged tests. RPC is not a model route. |
| crit M3; zoom M1; comp M1 | Row 20 and D3 require future Model provenance. D3 names ADR 0058's three initial members as withdrawn grants; the device allowlist starts empty until names are reviewed and flagged one at a time. D2 does not stop row 18. |
| crit M4; comp M2 | D2 and the matrix require a Model-origin toggle to retain its provenance or be refused, with a denial test; existing Script toggles are not widened. |
| crit M5; comp m3 | The security set is the explicit S2 list. `sv_tools` remains a project-writable exception. S5 and Q11 make it an open owner scope gate that does not block S3; it joins the S2 list only if the owner adds it by name. |
| crit m6; zoom m3 | D5 distinguishes unconditional config-root protection from task-scope `admit_path`, which is a no-op without an invocation. |
| crit m8; impl M3 | S3 names the production policy builder and covers the direct outside-root file-write branch. |
| impl M1; zoom M2, M3 | S3a/S3b and their documentation ship first. S1/S2 are deferred and inseparable from the first real C2 caller; no dormant engine code ships. zoom M2 and M3 are accepted in part by design: D2 stays normative as the contract that caller must meet, because without it the device would write with ungated provenance (Option H). |
| impl M2 | D2 preserves the existing `set_value` return type, adds a report-bearing sibling, maps Model to the session layer, and excludes model-tagged session keys from persistence. No dedicated layer is allowed. |
| impl m1; zoom m1 | D2 and behaviour row 4 name one API: the sibling `unset_with_source`. `unset(name, origin)` and its existing callers keep their provenance; Model is never inferred from `Origin::Session`. |
| impl m2 | Caller-bundle acceptance requires separate archive/model-writable, readonly/model-writable and unsafe/model-writable fixtures. |
| impl m3; zoom M4; comp m1 | S3a and S3b have their own exit gates. T13/T14 belong to the future caller bundle; T15 belongs to #657. |
| impl m4 | S1 step 0 adds the symbols with no gate, so T1-T5 compile and then fail on their assertions until the gate and the dump exclusion land. No red or green run is claimed in today's tree. |
| comp M3 | D5 and S3b acceptance require canonical target resolution and a symlink-to-config-root write case, distinct from an Environment-root read refusal. |
| comp m2 | D6 uses MUST NOT for relying on an unenforced approval setting. |
| comp m4 | `--add-dir` remains accepted and adds its root; S3 restricts later writes beneath the protected config root, not parsing of the flag. |


## References

- ADR 0012 (`docs/adr/0012-convars.md`): policy declared with the variable, and the `PROJECT` opt-in (`:77`).
- ADR 0013 (`docs/adr/0013-inheritance-by-seeding-and-cfg.md`): children seed from the parent; class cfgs. ADR 0014 (`docs/adr/0014-command-stream-binds-and-aliases.md`): the command stream.
- ADR 0058 (`docs/adr/0058-context-url-schemes.md`): O6, O7 and C2. Research: `docs/research/context-tools.md:66`.
- Code: `crates/con/src/spec.rs`, `crates/con/src/ctx.rs`, `crates/con/src/builtins.rs`, `crates/con/src/handle.rs`, `crates/con/src/repl.rs`, `crates/con/src/layers.rs`, `crates/con/src/dump.rs`, `crates/con/src/macros.rs`, `crates/con/src/error.rs`, `crates/app/src/config_cmd.rs`, `crates/envd/src/exec_sandbox.rs`, `crates/envd/src/exec_settings/sandbox.rs`, `crates/driver/src/exec_composer.rs`, `crates/agent/src/vars.rs`, `crates/core/src/dirs.rs`.
