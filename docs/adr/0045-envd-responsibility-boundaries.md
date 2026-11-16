# 0045. Proposed envd responsibility boundaries: preserve the authority core, shed the periphery

Status: accepted 2026-10-28; Alternative F selected
Date: 2026-10-11
Area: runtime/environment

## Context

`omp-envd` was created in `768749cf01` and split into its own crate in `8e3f027aae`. Its job: be "the single owner of project environment resources" (README v1). It provides:
- the daemon transport;
- filesystem, process, document and tool authorities;
- Python extension-host, worker and eval supervision (AGENTS.md:39-44; ADRs 0006, 0011, 0036; the document-authority Locked Deviation, AGENTS.md:500).

On `omp2` (`bc1e12d21b`) the crate has grown large:
- 199,669 lines in 179 files;
- it depends on 31 of 48 workspace crates;
- it exposes about 1,595 `pub` functions;
- it took part in 79 of 185 crate-touching commits in the last 400-commit window.

The research audit is `docs/research/envd-responsibility-audit.md`. It finds:

- **The core is legitimate, required centralization.** Single per-project document authority (flock + CAS + rebase), effect-token admission at the effecting process, exec/sandbox/egress with the TERM → grace → KILL boundary, blobs, workspace generations, and Python supervision. The document authority and the durable detached-process lease are the two invariants that strictly require an out-of-process singular owner.
- **About 36k lines (~18%) are a periphery assigned by no governing document.** Browser, computer, GitHub, media/TTS, security scan, report_issue, SSH, vault, schedules, model discovery, MCP config/OAuth, a duplicate VCS substrate, and the absorbed `grep` crate. They arrived through three omnibus commits and account for most of the dependency fan-out.
- **Most cross-crate co-change is the designed cost of the typed boundary.** Features cross `tool → proto → env → envd → driver → app`. envd causes two coupling sources itself:
  - the periphery;
  - a vocabulary inversion: envd depends on `omp-agent` approval and hook types, while driver imports envd-internal posture and eval-bridge types.
- **Client-side failure containment is weak.** The partition router leaves pending remote streams without an error when the daemon closes. A later remote-bound send ends the whole router, including the Local backend. `EnvClient` does not reconnect.
- **Hot-path costs are identified from code but not measured.** Each remote environment call costs 2 awaited round trips, a per-frame flush and a dual CAS write; a single-file edit costs about 5 docserver round trips.

## Decision (proposed)

Adopt Alternative F (hybrid) from the audit:

1. **Preserve** envd's authority core and the current process topology:
   - the attached daemon over UDS;
   - the in-process session host behind `PartitionedEnvTransport`;
   - the embedded and isolated fallbacks.

   Do not split the core into more processes, do not thin envd into a supervisor, and do not introduce an event bus.
2. **Optimize internally.** Split `server.rs`, `tools.rs` and `mcp/` into focused modules with no behavior change.
3. **Decouple** shared vocabulary into a contract crate below `omp-agent`, `omp-envd` and `omp-driver`:
   - approval and hook types;
   - approval posture and mode;
   - the eval parent-bridge types.

   Move `vcs/` into `omp-vcs`, restore `grep` as its own crate, and move `managed_skills_domain` and `ssh` out of envd.
4. **Extract** peripheral integrations behind the existing `RegistryBridges` / `DynamicToolFactory` / `ContentResolver` seams, one integration per change. envd keeps only their admission and supervision hook.
5. **Fix containment** in `omp-env`:
   - fail pending routes of a closed backend with a typed error;
   - keep the Local backend alive when Remote closes;
   - decide on reconnect.
6. **Change the hot path only after measurement.** Candidates are a pipelined invoke/commit, fewer docserver round trips, per-frame flush, and the dual CAS write. Each requires the P8-recorded baseline and the relative thresholds in audit §12. Nothing becomes a hard gate.
7. **Defer, pending owner decisions:**
   - admission placement when envd runs on untrusted workers (ADR 0006 vs 0039);
   - whether the approval and reflection relays are exceptions to ADR 0006's duplex prohibition;
   - the MCP process locus;
   - per-subagent daemon sharing;
   - the future of `schedules`.

## Alternatives considered

| Alternative | Weighted score (audit §10) | Disposition |
|---|---|---|
| A. Preserve as-is | 340 | Rejected. Keeps the build-weight and inversion costs that AGENTS.md:540-542 treats as defects |
| B. Modular monolith | 385 | Accepted as the base of F. F falls back to B if measurements show no material IPC overhead |
| C. Thin supervisor | 265 | Rejected. Moving document authority into the agent process breaks per-project singularity (Locked Deviation) |
| D. Capability-oriented services | 275 | Rejected. More hops on the edit path and more lifecycles, with no invariant gained |
| E. Event-driven | 225 | Rejected. A bus between the effect gate and the effect weakens ordering and cancellation proofs |
| F. Hybrid | 420 | Proposed |

The weights come from AGENTS.md priorities:
- invariants 30 (Locked Deviations, journal-first);
- hot-path performance 20 ("load-bearing … NEVER weaken");
- build weight 15 ("cold build time is a gate");
- locality 10, containment 10, reversibility 10 (clean cutovers, no shims);
- ops 5.

The performance scores are unmeasured estimates.

## Consequences

**Positive:**
- envd stops depending on `omp-agent`, `omp-webview`, `omp-desktop`, `omp-audio`, and most `omp-ai` use.
- Driver stops reaching into envd internals for vocabulary.
- envd's churn concentrates on the authorities it is meant to own.

**Unchanged:**
- The process topology and the env/v1 protocol shape, except for measured hot-path changes, which bump `SCHEMA_REV`.
- The journal-first durability model.
- ADR 0006/0011/0036 guarantees.

**Costs:**
- About 15 sequential, self-contained changes (audit §14, ENVD-01…15), each migrating every caller with no shims.
- One new contract crate and several extracted crates, each needing a `.github/labeler.yml` `area/*` entry.

**Risks:**
- Extracted integrations still need an environment-side execution locus.
- Moving vocabulary touches approval paths, which carry recent churn under ADR 0028.

## Accepted evidence and remaining measurements

- P8 baseline for audit workloads W1–W9 in attached and embedded modes on macOS arm64 and Linux.
- **DONE** W8 daemon-kill acceptance: the partition proof and the real-daemon SIGKILL proof now pass with typed remote terminal errors, local-backend survival and no collateral local termination.
- Cold build-time and envd compile-time numbers before the first extraction.
- Owner answers to the open questions in Decision item 7.

## Implementation gate

The owner accepted Alternative F on 2026-10-28. Implementation is authorized under the sequencing and evidence gates below. Each step then proceeds as one reversible change with its acceptance criterion from audit §14. Hot-path changes additionally need a recorded baseline that meets audit §12.3.

## Amendment (2026-11-09): placement and backlog under ADR 0049

[ADR 0049](0049-tiered-integration-architecture.md) sets the placement rule for the periphery that this record extracts. The owner also ruled that the 2026-11-05 vendor rule (ADR 0040 amendment) applies to forge and CI vendors.
- **ENVD-07 widened (landed).** `ssh` is `omp-ssh`. `omp-exec-ssh` does not depend on `omp-envd`. envd's `ssh://` reads stay behind `cap-ssh` (default-on in `omp-app`, off when that feature is absent). `russh` and `russh-sftp` are not dependencies of `omp-envd`.
- **ENVD-05 (landed).** `crates/envd/src/grep.rs` moved byte-identically to the new `omp-grep` crate (`crates/grep`); its 18 unit tests moved with it and `omp-envd` depends on `omp-grep`. The three `error-str-payload` sites moved with the code, so the `tools/lintx/baselines/error-formatting.toml` ratchet moves 3 from `envd` (51 to 48) to `grep` (0 to 3); the total stays 82 and migrating them is follow-up.
- **ENVD-06 (landed).** envd's duplicate `StatusCounts` and `ResetMode` types and the git helper code behind them are replaced by `omp_vcs::StatusSummary` and `omp_vcs::ResetMode`; the fields, derives and variant order are identical, so no behavior changes.
- **ENVD-07 managed-skills remainder (landed).** `managed_skills_domain` is now `omp_contract::managed_skills`: `PROVIDER_ID`, `MAX_SKILL_BYTES`, `MAX_NAME_BYTES`, `is_valid_name`, `sanitize_description`, `ManagedSkillCandidate`, and `CandidateError`. The module needs only `omp-core` and `thiserror`, both already dependencies of `omp-contract`, and `omp-contract` is already a dependency of `omp-envd` and `omp-driver`. The move adds no dependency edge and no cycle; a new crate would have added four (`omp-core`, `thiserror`, `omp-envd`, `omp-driver`). `omp-vocab` (presentation markup) and `omp-ext` (extension config and trust) do not fit the content. `omp-envd` keeps `managed_skills.rs`, the containment and publication authority (filesystem and hook admission), and imports the vocabulary from `omp-contract`. `omp-driver` discovery no longer imports `omp_envd::managed_skills_domain`.
- **ENVD-16 (landed).** The `ExecHost` contract (`ExecError`, `ExecEvent`, and the `ExecHost` / `ExecRun` traits) is in `omp-exec`. envd implements the traits; the concrete session host stays in `crates/envd/src/exec.rs`. `omp-exec-local` does not depend on `omp-envd`.
- **ENVD-08/09 realized as generic capability crates behind `cap-*` features.** The `github`/`github_url` item is not moved as a crate. Phase 4 PR5 replaces `github@3` with `forge@1` and `ci@1`, served from envd through `Delegated` adapters that still call `GithubService`. `cap-forge` and `cap-ci` are not added. Deleting `github.rs` and `github_url.rs` waits on GitLab T2 (ADR 0049 D2.8).
- **ENVD-08 computer half (Phase 3 PR1).** `omp-desktop` is optional on `omp-envd` behind `cap-computer` (default-on in `omp-app`, off in envd's default features). The Computer construction-table row, `install_computer`, and the declare arm compile only with that feature. `omp_tools::computer` stays for chat cards.
- **ENVD-08 browser half (Phase 3 PR2).** `omp-webview` is optional on `omp-envd` behind `cap-browser` (default-on in `omp-app`, off in envd's default features), together with `tokio-tungstenite`, which the relay is the only envd user of. The Browser construction-table row, `install_browser`, the declare arm, and the browser daemon, fetch, and relay modules compile only with that feature. `omp_tools::browser` stays for chat cards. `SV_BROWSER_ENABLED` exists only with the feature.
- **ENVD-09 media/TTS half (Phase 3 PR3).** `omp-audio` is optional on `omp-envd` behind `cap-media` (default-on in `omp-app`, off in envd's default features). The ImageGen and Tts construction-table rows, `image_tool`, `speech_tool`, `ask_vocalizer`, and `media_devices` / `media_tts` compile only with that feature. Ask still registers without playback. `Family::ImageGen` and `Family::Tts` stay for chat cards. `omp-ai` links `omp-audio` only through `speech` (included by `realtime`); envd enables neither, so a selected envd build has no `omp-audio` edge. `local-tts` does not compile the envd device by itself.
- Alternative F, the item-7 rulings and the evidence gates are unchanged.

## Status in omp

**Status: Partially implemented.** Alternative F is accepted. P8 W1-W9 evidence is complete; vocabulary extraction (ENVD-02), the `server.rs` split (ENVD-03), and the `tools.rs` / `mcp/` split (ENVD-04) landed. ENVD-03 moved `crates/envd/src/server.rs` to `crates/envd/src/server/` (`dispatch`, `control_factories`, `devices`, `diagnostics`, `connection`, `forward`, `runtime`, `session`, `identity`, `error`) with no public API change and each file under 5k lines. ENVD-04 moved `crates/envd/src/tools.rs` to `crates/envd/src/tools/` (`bridges`, `hooks`, `registry`, `roster_host`) and grouped `crates/envd/src/mcp/` into `transport/` and `config/`, re-exporting the previous `mcp::` paths. No public API change, no roster-table change, and each new module is under 5k lines. Phase 3 PR1 gates the computer host: `omp-desktop` is optional on `omp-envd` behind `cap-computer`, default-on in `omp-app`. Selected unification omits `omp-desktop` from the `omp-envd` graph. Phase 3 PR2 gates the browser host: `omp-webview` is optional on `omp-envd` behind `cap-browser`, default-on in `omp-app`. Selected unification omits `omp-webview` from the `omp-envd` graph. Phase 3 PR3 gates media: `omp-audio` is optional on `omp-envd` behind `cap-media`, default-on in `omp-app`. Selected unification omits `omp-audio` from the `omp-envd` graph. The rest of the periphery remains. Containment is implemented and accepted by the W8 proofs.

- ENVD-02 residue (2026-11-11, PR from `refactor/adr0045-envd02-residue`): the driver's posture-vocabulary imports (`ApprovalMode`, `ApprovalPosture`, `Provenance`, `SandboxState`, `SandboxUnavailable` in `headless/kernel.rs` tests, `delegated_policy.rs`, and `tests/subagent_cfg.rs`) now name `omp_contract::posture` instead of envd's `admission` re-export. The driver names no `omp_envd::eval` item. **Still open:** the driver still calls `omp_envd::admission::probe_sandbox` (envd's sandbox compiler, an authority item that needs a contract seam) and uses `omp_envd::tool_settings::{ToolSettings, SV_TOOLS_OUTPUT_SPILL_BYTES, SV_TOOLS_APPROVAL}` (pure data, but `omp-contract` cannot take it without an `omp-tools` edge). envd's `pub use` re-exports of `omp_contract::posture` (in `admission.rs`, `tool_settings.rs`) and `omp_contract::eval_bridge` (in `eval/bridge.rs`, `eval/mod.rs`) remain. So the ENVD-02 driver acceptance ("driver imports no `omp_envd::{admission,tool_settings,eval}` vocabulary") is met for the posture types only.
- W8 containment is implemented and verified by the partition and real-daemon proofs:
  - `w8_probe_remote_close_leaves_stream_pending_then_drops_local_stream` passes in `omp-env`.
  - `w8_sigkill_daemon_leaves_remote_pending_then_drops_local` passes against the production daemon on macOS.
- Owner answers in decision item 7 are recorded: host-side admission with envd enforcement, issuing-connection-only approval relay, bounded reflection relay, envd-owned MCP, digest-matched daemon sharing, deferred reconnect and deferred schedules. P8 W1-W9 baselines are complete through PR #450 and workflow run 41070076113.
- `adr0045-slice-b.md` remains supporting investigation evidence.

## Build-weight baseline (ADR 0049 Phase 0)

P8 W1–W9 evidence in this record is the runtime baseline (PR #450, workflow run 41070076113; the recorder is `crates/e2e/tests/p8_baselines.rs`). ADR 0049 Phase 0 adds the build-weight baseline audit §12.3 rule 5 asks for. HTML reports from `cargo build --timings` are not committed. Each cold build used a fresh `CARGO_TARGET_DIR`. The incremental build reused the cold `omp` directory after one added line in `crates/envd/src/lib.rs` (`//! Phase 0 incremental fingerprint.`), then that line was removed. No code change remains.

Measured 2026-11-09 03:36–04:02 America/Santo_Domingo on this Linux host: Intel Xeon, 4 vCPU (`nproc` 4), kernel 6.12.113+, `x86_64-unknown-linux-gnu`. Toolchain: rustc 1.99.0-nightly (1a98b1e13 2026-08-07), cargo 1.99.0-nightly (c79e8f894 2026-08-04). Profile `dev` (workspace members use the Cranelift backend; `debug = false`). Max concurrency reported by cargo: 6, with `jobs=4` and `ncpu=4`.

| Build | Wall time | Total units | Fresh | Dirty |
|---|---|---|---|---|
| `cargo build --timings --bin omp --locked`, cold | 282.2s | 1433 | 0 | 1433 |
| same, after the one-line `omp-envd` edit | 90.8s | 1433 | 1428 | 5 |
| `cargo build --timings -p omp-envd --locked`, cold | 259.8s | 1398 | 0 | 1398 |
| `cargo build --timings -p omp-exec-local --locked`, cold | 251.9s | 1399 | 0 | 1399 |
| `cargo build --timings -p omp-exec-ssh --locked`, cold | 252.5s | 1399 | 0 | 1399 |

The five dirty units in the incremental build, slowest first: `omp-envd` 53.10s, `omp-app` lib 23.02s, `omp-driver` 21.37s, `omp-app` bin `omp` 4.68s, `omp-exec-local` 0.74s.

Ten slowest units, cold `omp` (1433 units): `omp-envd` 53.04s, `omp-ai` 51.10s, `omp-proto` 27.77s, `omp-app` 22.09s, `omp-driver` 20.93s, `omp-tools` 19.93s, `jj-lib` 17.59s, `tree-sitter-ocaml` build-script run 10.48s, `omp-catalog` 10.27s, `omp-tui` 10.24s.

Ten slowest units, cold `omp-envd` (1398): `omp-ai` 53.18s, `omp-envd` 52.89s, `omp-proto` 29.17s, `jj-lib` 19.05s, `omp-tools` 18.54s, `tree-sitter-ocaml` build-script run 11.29s, `omp-catalog` 11.12s, `omp-shell-builtins` 10.79s, `x11rb-protocol` 8.00s, `anydoc` 7.97s.

Ten slowest units, cold `omp-exec-local` (1399): `omp-ai` 51.51s, `omp-envd` 51.38s, `omp-proto` 27.61s, `jj-lib` 18.68s, `omp-tools` 17.48s, `omp-catalog` 10.67s, `tree-sitter-ocaml` build-script run 10.49s, `omp-shell-builtins` 10.47s, `anydoc` 7.75s, `x11rb-protocol` 7.69s.

Ten slowest units, cold `omp-exec-ssh` (1399): `omp-ai` 51.63s, `omp-envd` 51.18s, `omp-proto` 27.28s, `jj-lib` 18.46s, `omp-tools` 17.50s, `omp-catalog` 10.81s, `tree-sitter-ocaml` build-script run 10.50s, `omp-shell-builtins` 10.32s, `x11rb-protocol` 7.83s, `anydoc` 7.79s.

Closure counts are `cargo tree -p <crate> -e normal --prefix none --locked | sort -u | wc -l`. There is no package `omp`; the `omp` binary is package `omp-app`, and `-p omp` fails with "did not match any packages". On this cargo (1.99 nightly) the workspace `[resolver] feature-unification = "workspace"` makes `cargo tree -p <crate>` print every workspace member, so the command as written returns one number per target for all four crates: 1420 with no `--target`, 1428 with `--target x86_64-unknown-linux-gnu`, 1372 with `--target aarch64-apple-darwin`. The per-crate numbers below pass `--config 'resolver.feature-unification="selected"'` so `-p` selects one crate. This machine is Linux, not macOS. `aarch64-apple-darwin` is not installed; that column is cargo's resolution for the triple, not a count taken on a Mac.

| Crate | Host, no `--target` | `--target x86_64-unknown-linux-gnu` | `--target aarch64-apple-darwin` (resolved, not a Mac) |
|---|---|---|---|
| `omp-app` (bin `omp`) | 1327 | 1335 | 1303 |
| `omp-envd` | 1144 | 1152 | 1120 |
| `omp-exec-local` | 1146 | 1154 | 1122 |
| `omp-exec-ssh` | 1146 | 1154 | 1122 |
| `omp-exec-local`, after ENVD-16, ENVD-07, and the Phase 1 closure change | 173 | 173 | 167 |
| `omp-exec-ssh`, after ENVD-16, ENVD-07, and the Phase 1 closure change | 322 | 322 | 318 |

ENVD-02 remeasured the host column with the same selected-unification command after `omp-contract` landed. `omp-app` is 1332 (was 1327). `omp-envd` is 1031 (was 1144) and has no normal-edge `omp-agent` dependency. The other two rows and the target columns were not remeasured. Cold and incremental timings were not re-run. The `omp-exec-ssh` 456-crate miss and the ≤300 budget are unchanged. The Phase 1 closure change remeasured the `omp-exec-local` and `omp-exec-ssh` rows on a Linux runner with the same command (`-e normal`, `selected` unification); the two rows labelled with it are those counts, and the Phase 0 rows stay as the baseline. `sort -u` counts a crate once expanded and again as a `(*)` repeat; with the `(*)` suffix removed first, the same trees hold 140 (`omp-exec-local`) and 235 (`omp-exec-ssh`) distinct packages on the Linux resolution. With `-e normal,build` the counts are 221 lines and 178 distinct packages for `omp-exec-local`, and 371 lines and 273 distinct packages for `omp-exec-ssh`. The 456-crate figure recorded when ENVD-07 landed used default edge kinds (normal, build, dev), not `-e normal`. The workspace-unified resolve is unchanged by that change, so these are per-crate closures, not what `cargo check -p <crate>` builds under `[resolver] feature-unification = "workspace"`.