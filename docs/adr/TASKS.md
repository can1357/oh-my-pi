# Active ADR and deferred-work ledger

This file is the active work queue for ADR follow-ups. It is distinct from
`STATUS.md`, which records implementation status for every ADR.

## Authority

Use these sources in order:

1. Current code and tests.
2. Merged PR state on `omp2`.
3. The affected ADR's `Status in omp` and implementation gate.
4. This ledger for sequencing and owner decisions.

A historical audit is evidence. It is not an active task state unless this
ledger promotes the item after revalidation.

Status meanings:

- **DONE**: implemented and verified in the current tree.
- **OPEN**: actionable work remains.
- **BLOCKED**: an owner decision or prerequisite prevents implementation.
- **PARTIAL**: some acceptance evidence exists, but the ADR requirement is not
  complete.
- **HISTORICAL**: retained for traceability; not an active queue.

## Coordinator monitoring record

- 2026-10-28: Native GitHub `run_watch` monitored PR #449 through all terminal
  checks. The 14 required CI jobs, including BuildBuddy and macOS/Linux acceptance
  jobs, passed; PR #449 then merged. No separate BuildBuddy monitor was available.
- The coordinator now records monitor and merge evidence per PR instead of treating
  a targeted local or BuildBuddy invocation as a substitute for PR CI.
- 2026-10-28: Owner accepted ADR 0045 Alternative F and item-7 defaults. Admission remains host-decided with envd enforcement; approval relay is issuing-connection-only; reflection relay is bounded; MCP remains envd-owned; daemon sharing requires matching workspace/trust/policy digests; reconnect and schedules remain deferred.
- 2026-10-28: Owner accepted ADR 0048 with B4 full frame preflight validation, behavior-family golden fixtures including compaction/tool.update/patch, `toolhost` retained in Buf breaking scope, and the lenient B1 decode variant. B9 Variant 1 is the selected implementation direction.

- 2026-11-09: Owner accepted ADR 0049 (tiered integration architecture) and ADR 0046, with the rulings recorded in ADR 0046. The owner also ruled that the 2026-11-05 vendor rule (ADR 0040 amendment) applies to forge and CI vendors. The owner ruled that `envd/src/codex_app_server` stays as a recorded exception with two exits (ADR 0043). ADRs 0027, 0036, 0043, 0045 and 0047 were amended; ADR 0040 and ADR 0047 keep their own acceptance gates.
- 2026-11-11: Owner amended and accepted ADR 0047 with conditions. C1: credential containment (G3) is decided in its own record before any remote backend is composed by default. C2: ADR 0040 Gap 1 (`JobKind::Execution` producer) is a prerequisite of `JobOwner::RemoteExecution` stage-2 work. As built (checked 2026-11-11 on `omp2` `5b0cd838c9`): the producer exists in code (`JobBoard::start_execution`, called by the `remote_build` tool; `sv_exec_agent_runs` defaults to false) and is off by default and unaccepted. C3: acceptance creates no remote default; G8 stays open. C4: the 2026-11-05 vendor removal and the 2026-11-09 `ExecHost` move are separate changes that acceptance does not verify. Acceptance gate renamed A0 (it was G1, which ADR 0040 uses for the relief measurement).

## Decision matrix for remaining ADR work

The owner authorized the council to decide software-development questions. That authority does not
override an ADR's explicit owner-acceptance gate. The council dispatch on 2026-10-28 failed before
producing a verdict because child startup rejected the requested tool set and hit an extension-load
error. No council verdict is recorded.

- **ADR 0045 owner gate:** accept or reject Alternative F before production implementation.
- **ADR 0045 decision item 7:** decide reconnect policy; admission placement on untrusted workers;
  whether approval and reflection relays may violate ADR 0006's duplex prohibition; MCP process
  locus; per-subagent daemon sharing; and the future of schedules.
- **ADR 0045 containment:** after acceptance, authorize typed remote-route termination and local
  backend survival. Reconnect remains a separate policy decision.
- **ADR 0045 P8 evidence:** define or confirm W1-W9 workloads, attached versus embedded modes,
  macOS/Linux execution, metrics, artifact format, and comparison thresholds.
- **ADR 0048 B4:** choose validation of every HostFrame and WorkerFrame before prost decode, or
  deletion of the unused validators; identify the owning decode paths.
- **RESOLVED** **ADR 0048 B5:** the owner chose one fixture per durable behavior family with no
  redundant field permutations. Implemented and verified; see the ADR 0048 section below.
- **ADR 0048 B9:** prove the real worker launcher and WorkerHello path plus gateway Hello behavior,
  or authorize correcting stale documentation and missing production wiring.
- **RESOLVED** **ADR 0048 acceptance:** the owner confirmed the Buf ignore list with `toolhost`
  retained, and chose the lenient B1 decode variant (TASKS line 37, ADR "Required evidence").
  The code records the same choice: `journal/src/data.rs:574-579` is a hand-written lenient
  `Deserialize for ToolResult` whose `Wire` struct carries no `deny_unknown_fields`, with the
  exactly-one-of `outcome`/`fault` check keeping it fail-closed. The revision-bump alternative is
  not viable under the current revision gate: `Kind::is_known` at `journal/src/kind.rs:131-132`
  accepts only `rev == 1`, so a `tool.result@2` is refused as an unknown kind by every reader
  today. Choosing it later would require implementing and verifying revision-2 support first.
  `just proto-breaking` exits 0 on `omp2` at `e93fc4b962`.
- **ADR 0040 dimension 1, code location: DECIDED 2026-11-05.** BuildBuddy does not stay in `omp2`. Core keeps only the generic, extensible ground, and vendor integration moves outside as an extension. The [ADR 0040 amendment](0040-remote-build-and-test-execution.md#amendment-2026-11-05-vendor-integration-leaves-core) records the ruling and its grounds, and the [ADR 0047 amendment](0047-agent-build-execution-model.md#amendment-2026-11-05-vendor-clients-leave-core) records its effect there. **Dimension 2, what ships in the binary: SCOPED, not built.** The owner left its shape to engineering judgement. [docs/research/exec-out-of-core.md](../research/exec-out-of-core.md) gives the crate-by-crate verdict, costs the one in-core adapter that the static `ExecutionBackend` trait requires, recommends a poll-shaped delegate carried by a Python extension, and names the generic ground that must replace `repo_pins`. Nothing is implemented. Three product calls remain open in that note: whether the extension may be an operator-installed program, whether REAPI on BuildBuddy keeps invocation cancel through a fallback, and whether the ruling covers the repository's CI use of `bb`.
- **RESOLVED** ADR 0040 dimension 3, out-of-core integration feasibility: [Phase 0](0040-remote-build-and-test-execution.md#phase-0-out-of-core-host-feasibility) returned **STOP** (PR #496). No existing host carries an out-of-core execution backend as it stands. Python reattach failed: same-ID reinvocation on a new connection started the body twice. Cancellation was partial: synchronous bodies did not observe it and the deadline did not reach the call. Registration worked only through hidden `--trusted-extension`; PR #497 records the documented manifest tool-row mismatch. The envd named-process supervisor survived client close and reattached, but extensions cannot reach it because `Grants::from_effect_envelope` never emits `env.process`. STOP is the feasibility verdict, not an implementation failure.
- **ADR 0040 success criteria: DECIDED 2026-11-04 (PR #492).** Memory relief is warm local peak minus
  client peak. The minimum is an absolute MiB quantity, not a fraction of local peak: a heavier
  recipe could make the same unchanged client pass a fractional threshold. Set a separate minimum
  for each recipe because `omp-envd`, `omp-core`, and `clippy` have substantially different local
  peaks. When envd is shared, apply the criterion to the lower relief bound, least favourable to
  passing. After the first valid quiet-host run, the owner must set the numeric threshold per recipe
  and the repetition rule (all repetitions, median, or worst case). The §G1 data cannot establish a
  relief verdict. The harness must account for the serving envd by role, with bounds when shared.
  Warm wall time remains unjudgeable until a warm-state product backend exists, coupled to the
  producer and reattach acceptance gate.
- **ADR 0040 production gate: DECIDED 2026-11-04.** Build a product execution-job producer and a
  real reattach before acceptance; do not narrow the gate to ADW. Journal replay, crash handling
  and result persistence require that producer. ADR 0047 is the agent-build companion (accepted
  with conditions 2026-11-11; C2 makes acceptance of this producer a prerequisite of its stage-2 work;
  the producer and `reattach_execution` now exist in code, off by default and unaccepted);
  ADR 0040 "Gap to acceptance" describes the work.
- **ADR 0047 follow-up: enforce the gates in code (PROPOSED, not an owner condition; 2026-11-11).** Remote REAPI wiring already
  exists in the driver (`crates/driver/src/adw/production.rs:247`, `crates/driver/src/exec_composer.rs:641-653`).
  It is opt-in (`SV_EXEC_POLICY` defaults to `LocalOnly`; `omp adw run --exec-policy` also selects remote per process), but no code checks A0, G3 or G8. Make
  the driver refuse to compose a remote backend until the credential-containment record (C1) is
  accepted, and add a test for the refusal.
- **DONE** ADR 0040 quiet-host measurement harness (PR #490). The interleaved harness records host-pressure guards and accounts for the serving envd by role, including bounds for shared envd. Its dry run was synthetic; no real recipe measurement or relief verdict was produced. PR #494 fixed the profile/cache race, and PR #495 fixed runner cache eviction. A valid quiet-host run and the owner-set thresholds remain open.

## Output pipeline: normalizer and minimizer

The existing Rust normalizer is `crates/driver/src/cleanse`: `parse(kind, input)` returns `Result<Vec<Diagnostic>, ParseError>` after a checker runs (`Ok(non-empty)` = failures, `Ok(empty)` = zero failures, `Err(ParseError)` = could not parse with a typed reason). Settled runs retain complete stdout/stderr as `CheckLogs` blob refs cited `artifact://sha256/<hex>`. Its approximately 32 `ParserKind` variants are compiled in; extensions cannot register formats. No Python host is involved. omp2 has no minimizer. See [ADR 0040](0040-remote-build-and-test-execution.md) and [ADR 0047](0047-agent-build-execution-model.md) for execution and structured-result context.

Work is ordered below. **PENDING** means work remains, including work in flight. A row closes only when its code and tests land and pass together; dispatching work is not evidence.

1. **DONE** N1 parsers: `ParserKind::JUnit`, `ParserKind::Sarif`, and `ParserKind::Tap` normalize into `Diagnostic` under `crates/driver/src/cleanse/parsers/{junit,sarif,tap}.rs`, dispatched from `parse()` (`parsers.rs:162-167`). JUnit landed in PR #501 (`4461a80260`); SARIF 2.1.0 and TAP 14/13/12 in PR #504 (`d809a89423`). Neutral JUnit fixtures are from PR #499. Local re-verify on `cursor/cleanse-n1-junit-sarif-tap-40d3` at omp2 tip: `just check-pkg omp-driver` Finished `dev` in 1m 00s; `just test-pkg omp-driver` nextest `Summary [37.129s] 721 tests run: 721 passed, 0 skipped` (including all junit/sarif/tap unit tests) and doctests `ok`.
2. **DONE** N2 seam: `parse()` returns `Result<Vec<Diagnostic>, ParseError>` — the typed outcome equivalent of ParseOutcome — distinguishing `Ok(non-empty)` (failures), `Ok(empty)` (zero failures), and `Err(ParseError)` (could not parse; `thiserror` reasons with format errors via `#[from]`/`#[source]`, no string-payload variants). All 32 `ParserKind` variants migrate in one exhaustive `match` (PR #516, `230efc0df8`). `CheckResult` keeps `parsed` plus `logs: Option<CheckLogs>`; `unparseable` / `checker-failed` diagnostics cite retained streams as `artifact://sha256/<hex>` instead of excerpts. Defending tests: `could_not_parse_is_distinguishable_from_zero_failures_at_the_seam`, `recorded_clean_runs_read_as_zero_failures`, `recorded_failing_runs_name_every_diagnostic`, `unresolved_runs_project_one_diagnostic_citing_their_logs`, `checker_output_is_retained_whole_where_artifact_addresses_resolve`. Local re-verify on `cursor/cleanse-n2-parse-outcome-40d3` at omp2 tip: those five nextest filters `5 passed` (716 skipped).
3. **PENDING** N3 registry: queued behind the minimizer work, not blocked on an owner decision. The owner decided on 2026-11-07 that JUnit, SARIF, TAP and generic parsing remain in core, existing per-tool formats move outside core, and first-party formats ship by default so existing checks continue to work. Prefer the Python host only after confirming its required changes are already planned and feasible. Phase 0 reports the manifest mismatch, deadline cancellation gap and missing model-inaccessible route; ADR 0040 records the host work as unbuilt.

   Ordered N3 tasks:
   1. Revalidate current code and plans for manifest registration, deadline cancellation, a model-inaccessible host route and the envd entry point. Record evidence and select Python only if those prerequisites are planned and feasible; otherwise assess the remaining carriers.
   2. Record failing runs and expected diagnostics for every migrating checker, and verify mixed JSON and text diagnostics are retained.
   3. Define the format identity, trusted registration, bounded typed result and failure contract. Keep standard formats and generic parsing in core.
   4. Implement the chosen registration and dispatch seam with cancellation, validation and explicit unavailable-format diagnostics.
   5. Package first-party formats for default installation and migrate every per-tool caller without disabling existing checks.
   6. Verify recorded fixtures, malformed output, missing extensions, cancellation, default installation and end-to-end cleanse behavior before removing obsolete parser variants.
4. **PENDING** M minimizer port: port the foundation crate, resolve how `plan.rs` classifies commands using the brush parser, and port the remaining 22 filters. Carry the upstream NOTICE and RTK pytest attribution. Wire the live path only after before/after token evidence. Upstream v1 has 24 filters; the foundation and remaining filters are work to land, not evidence of completion. The four correctness defects the savings measurement found are fixed (nextest `TIMEOUT`/`SIGKILL`, truncated failed-build diagnostics, `just` truncation, `gh pr checks` token growth); the recorded corpus replay keeps all 12 failure lines of the failed `--no-run` build and cuts `gh pr checks 515` from 645 to 62 tokens. Wiring only the cargo filter at `finish_session_command` is in progress.

- **RESOLVED** format admission: the 2026-11-07 owner decision applies to existing per-tool formats; core retains the standard formats and generic parsing. See [format registry options](../research/format-registry-options.md#owner-decision-2026-11-07).

## Snapshot JSON byte preservation

- **DONE** integration merged as PR #449. The snapshot fix is `e2d0723` plus correction
  commit `c4ceb04` on `fix/snapshot-json-fixed-point`. The correction retains validated
  source bytes while preserving typed scalar `Value` compatibility. Local `omp-dom`
  verification passed 28 tests and doctests. PR CI passed all 14 jobs, including BuildBuddy,
  macOS, Linux, acceptance proofs, and format checks. The PR merged at 2026-10-28T09:30:13Z.
- The configured reviewer dispatch failed before producing a verdict. The session-model fallback
  reviewed the correction and returned READY after the scalar-compatibility issue was fixed.

## ADR 0045 — envd responsibility boundaries

ADR status: **accepted 2026-10-28**. Alternative F selected.

- **DONE** owner acceptance and decision-item-7 answers. Reconnect remains deferred.
- **DONE** W8 daemon-kill containment evidence and implementation. The partition proof and real-daemon macOS proof pass with typed remote terminal errors and local-backend survival.
- **DONE** P8 W1-W9 baseline evidence: PR #450 merged the recorder and envd descriptor fix; BuildBuddy Linux and native macOS workflow run 41070076113 completed 30-repetition attached/embedded coverage with zero failures and no EMFILE, and the local single-process W7/W9 proof also passed under the 16384 descriptor ceiling.
- **DONE** containment fixes in `crates/env/src/partition.rs`: remote pending routes receive typed terminal errors, the Local backend survives Remote closure, and the focused partition suite passes 16/16. The production daemon W8 SIGKILL proof also passes.
- **DEFERRED** reconnect implementation. It is a policy decision, not a safe
  implementation detail.

`adr0045-slice-b` remains a valid investigation report. It confirms the
containment defect and identifies the smallest fix, but it does not authorize
that fix.

## ADR 0049 — tiered integration architecture (with ADR 0046)

ADR status: **accepted 2026-11-09**; implementation gated by Phase 0.

- **DONE** Phase 0: `cargo build --timings` (cold and one-line incremental) for `omp`, `omp-envd`, `omp-exec-local`, `omp-exec-ssh`; per-platform closure counts. Recorded in ADR 0045, section "Build-weight baseline (ADR 0049 Phase 0)". PR #542.
- **DONE** Phase 1 ENVD-16: `ExecError`, `ExecEvent`, and the `ExecHost` / `ExecRun` traits live in `omp-exec`. envd implements the traits; the concrete session host stays in `crates/envd/src/exec.rs`. `omp-exec-local` does not depend on `omp-envd`. PR #543.
- **DONE** Phase 1 ENVD-07: `SshService` and the configured-host authority live in `omp-ssh`. `omp-exec-ssh` does not depend on `omp-envd`. envd `ssh://` reads are behind `cap-ssh` (default-on in `omp-app`). `russh` left `crates/envd/Cargo.toml`. Measured `omp-exec-ssh` closure is 456 crates (selected unification, default edges), above the ≤300 exit. PR #544.
- **DONE** Phase 1 ENVD-02: shared approval, hook, director, session, posture, and eval-bridge vocabulary lives in `omp-contract`. `omp-envd` does not depend on `omp-agent`. Driver and app import posture and eval-bridge types from `omp-contract`. Selected-unification closures after the split: `omp-app` 1332, `omp-envd` 1031. The `omp-exec-ssh` 456-crate miss and the ≤300 budget are unchanged. Timings not re-run. PR #545.
- **OPEN** ENVD-02 residue (ADR 0045): the driver's posture imports now name `omp_contract::posture` (PR from `refactor/adr0045-envd02-residue`). Still open: the driver calls `omp_envd::admission::probe_sandbox` (authority; needs a contract seam) and imports `omp_envd::tool_settings::{ToolSettings, SV_TOOLS_OUTPUT_SPILL_BYTES, SV_TOOLS_APPROVAL}` (pure data; `omp-contract` would need `omp-tools`, so it needs a home). envd's `pub use` re-exports of `omp_contract::posture` and `omp_contract::eval_bridge` also remain. The ENVD-02 line above overstated the driver side.
- **OPEN** Phase 1 closure exit, not met under the repo's `[resolver] feature-unification = "workspace"` (`.cargo/config.toml:61-62`): `omp-exec-ssh` is 363 distinct packages and `omp-exec-local` 262 before and after the closure change (`-e normal,build`, Linux target), so built binaries and `cargo check -p` are unchanged. Under per-crate `selected` unification only, `omp-exec-ssh` went from 456 to 369 `sort -u` lines on the host resolution (458 to 371 on the Linux target) and from 339 to 273 distinct packages, default edge kinds, against ≤300; the owner settles the counting method, and ranked options are in the closure PR. The vocabulary task ENVD-02 is done. Phases 2–5 follow.
- **DONE** Phase 2 roster (0046 item 1): `crates/tools/src/roster.rs` is the static construction table. `compose_kernel` selects `SelectedRoster` and puts it on `RegistryBridges`. envd iterates that selection for protect, ensure, session install, environment declare, and environment construct. `task` and `hub` stay composer rows. Exit proof: `cargo test -p omp-roster-probe --locked` registers `roster_probe` through `SelectedRoster::with_extension` and edits no `crates/envd` file. PR #546.
- **DONE** Phase 2 ENVD-03: `crates/envd/src/server.rs` is `crates/envd/src/server/` (dispatch, control factories, devices, diagnostics, connection, forward, runtime, session, identity, error). No public API change. Each file is under 5k lines. `tools.rs` and `mcp/` were not moved. PR #547.
- **DONE** Phase 2 ENVD-04: `crates/envd/src/tools.rs` is `crates/envd/src/tools/` (`bridges`, `hooks`, `registry`, `roster_host`). `crates/envd/src/mcp/` is grouped into `transport/` and `config/`, and the previous `mcp::` module paths stay re-exported. No public API change and no roster-table change. Each new module is under 5k lines. PR #548.
- **DONE** Phase 2 locality exit: roster (#546) + ENVD-03 (#547) + ENVD-04 (#548). Phase 3 is complete. Phases 4–5 follow.
- **OPEN** Phase 2S (after Phase 2, before Phase 3): extension-declared URL schemes. Tracked under ADR 0050, accepted by the owner 2026-11-11 with conditions; S1 may start.
- **DONE** Phase 3 PR1 (`cap-computer`, ENVD-08 half) — PR #549: `omp-desktop` is optional on `omp-envd` (`cap-computer = ["dep:omp-desktop", "omp-tools/cap-computer"]`). `omp-app` defaults are `local`, `cap-ssh`, and `cap-computer`; `cap-computer` forwards `omp-envd/cap-computer`. With the feature off, the Computer row is absent from `ROSTER`, and `install_computer` plus the declare arm are compiled out. `omp_tools::computer` stays for chat cards. `ToolSettings` still defaults `computer` off; that setting cannot reinstall a row the table does not contain. Selected unification (`--locked --config 'resolver.feature-unification="selected"'`) on this host: `cargo tree -p omp-envd -i omp-desktop` exits 101 (`omp-desktop` matched no package). The same tree under the repo's workspace unification still shows `omp-desktop`, because `omp-app`'s default enables the feature. `cargo check -p omp-envd` passes. `cargo check -p omp-envd --features cap-computer` passes and links `omp-desktop`. `cargo tree -p omp-app -i omp-desktop -e normal` shows `omp-desktop` through `omp-envd`. Under that selected unification, `cargo nextest run -p omp-tools --lib` passes 559 tests with the feature off and again with `--features cap-computer`. `only_sandbox_spawning_tools_are_exec_sandboxed` passes both ways, and the eight `computer` / read-only host tests pass with `--features cap-computer`.
- **DONE** Phase 3 PR2 (`cap-browser`, ENVD-08 half) — PR #550: `omp-webview` and `tokio-tungstenite` are optional on `omp-envd` (`cap-browser = ["dep:omp-webview", "dep:tokio-tungstenite", "omp-tools/cap-browser"]`). The relay is envd's only `tokio-tungstenite` user; with the feature off that crate stays reachable through `omp-ai`, not as an envd edge. `omp-app` defaults add `cap-browser`, forwarding `omp-envd/cap-browser` and `omp-driver/cap-browser`. With the feature off, `browser_daemon`, `browser_fetch`, and `browser_relay` are compiled out, the Browser row is absent from `ROSTER`, and `install_browser`, `browser_enabled`, and the declare arm are compiled out. `SV_BROWSER_ENABLED` and the CDP/relay convars exist only with the feature, so a setting cannot reinstall the row. `omp_tools::browser` stays for chat cards. Driver attaches `BrowserFetchAdapter` only with `cap-browser`. `omp browser-relay` reports that the relay is not compiled into the build when the feature is off. Selected unification (`--locked --config 'resolver.feature-unification="selected"'`) on this host: `cargo tree -p omp-envd -i omp-webview` exits 101 (`omp-webview` matched no package). With `--features cap-browser`, that tree shows `omp-webview` and `tokio-tungstenite` as direct edges of `omp-envd`. `cargo tree -p omp-app -i omp-webview -e normal` shows `omp-webview` through `omp-envd`. `cargo check -p omp-envd` passes. `cargo check -p omp-envd --features cap-browser,cap-computer` passes. `cargo check -p omp-app` passes. `cargo check -p omp-app --no-default-features --features local` passes. `cargo nextest run -p omp-tools --lib` passes 559 tests with the feature off and again with `--features cap-browser,cap-computer`. envd's `only_sandbox_spawning_tools_are_exec_sandboxed` and `default_roster_has_exactly_five_slots_and_keeps_long_tail_devices_live` pass both ways. With the features on, `browser_settings_project_from_con`, `relay_kind_resolution_honors_both_override_directions`, and all 46 `browser_relay_contract` tests pass. Without the feature, that test target is not built (`requires the features: cap-browser`). Media remains.
- **DONE** Phase 3 PR3 (`cap-media`, ENVD-09 media/TTS; the ADR names this `cap-tts`/media) — PR #551: `omp-audio` is optional on `omp-envd` (`cap-media = ["dep:omp-audio", "omp-tools/cap-media"]`). `omp-app` defaults add `cap-media`, forwarding `omp-envd/cap-media`. App and chat keep their own `omp-audio` edges for say and voice. `omp-ai` links `omp-audio` only through `speech`, which `realtime` includes, because `rewrite_for_speech` was the other edge reachable from envd. envd enables neither `speech` nor `realtime`. With `cap-media` off, `media_devices` and `media_tts` are compiled out, the ImageGen and Tts rows are absent from `ROSTER`, and `image_tool`, `speech_tool`, and `ask_vocalizer` are compiled out. Ask still registers and does not play audio. `Family::ImageGen`, `Family::Tts`, and the chat cards stay. Those rows have no settings key, so a settings map cannot reinstall them. `local-tts` still enables Kokoro in `omp-ai` and does not by itself compile the envd TTS device. Selected unification (`--locked --config 'resolver.feature-unification="selected"'`) on this host: `cargo tree -p omp-envd -i omp-audio` exits 101 (`omp-audio` matched no package). With `--features cap-media`, that tree shows `omp-audio` as a direct edge of `omp-envd` and not through `omp-ai`. `cargo check -p omp-envd` passes. `cargo check -p omp-envd --features cap-media,cap-browser,cap-computer` passes. `cargo check -p omp-app` passes. Under that selected unification, `cargo test -p omp-tools --lib` passes 559 tests with the feature off; the test binary asserts the `image_gen` and `tts` rows are compiled out. `cargo nextest` does not forward `--config`, so the same lib under nextest unifies `cap-media` on through `omp-app` defaults and passes the same 559 with the rows present. envd's `only_sandbox_spawning_tools_are_exec_sandboxed` and `default_roster_has_exactly_five_slots_and_keeps_long_tail_devices_live` pass under selected `cargo test` with the feature off; the binary asserts both rows are absent and does not contain `media_devices`. With the feature on, those two plus the eight `media_devices` tests pass. The two speech-rewrite accumulator tests pass; they do not call `omp-audio`.
- **DONE** Phase 3 PR4 (minimal-profile CI) — PR #552: `just check-minimal-caps` typechecks default `omp-app` (all `cap-*` on) and `omp-app --no-default-features --features local` under selected feature unification. It then requires `cargo tree -p omp-envd -i omp-{desktop,webview,audio,ssh}` with `--locked --no-default-features` and `resolver.feature-unification="selected"` to exit 101 (`did not match any packages`). Any other cargo failure fails the recipe. `Lint workspace (Linux)` runs the recipe, so both profiles gate on that required check. `cap-security` remains optional hygiene; forge and CI stay in Phase 4.
- **DONE** Phase 3 exit: capability gates (`cap-computer` #549, `cap-browser` #550, `cap-media` #551) plus the minimal-profile check. Optional `cap-security` hygiene does not block Phase 4.
- **DONE** Phase 4 PR1: pure `omp-forge` contract — PR #553. `RepoRef`, `CommitRef`, `ChangeRequest`, `Issue`, `Check`/`CheckState`, `ForgeChecks`, `required_checks`, `pr://`/`issue://` parsing into host/owner/repo/number, the operation vocabulary with mutation flags (`ForgeOp::mutates`), and `ForgeHost` (unboxed RPITIT). No I/O and no vendor names. In-core GitHub code stays until adapters prove parity.
- **DONE** Phase 4 PR2: pure `omp-ci` contract — PR #554. `Pipeline`, `Job`, `CiStatus`, `CiProvider`, `Capabilities` (`rerun_failed`, `rerun_job`, `cancel`, `trigger_with_inputs`, `artifacts`, `log_stream`, `play_manual`), pure `route(details_url)`, the operation vocabulary with mutation flags (`CiOp::mutates`: cancel, rerun, trigger, and play_manual write; status, artifacts, and log_stream read), and `CiHost` (unboxed RPITIT, separate read and mutate methods). No I/O and no vendor names. `github@3` `run_watch` stays until the later `ci@1` migration.
- **DONE** Phase 4 PR3: `omp-forge-delegated` host router — PR #555. Routes by ASCII-case-insensitive host to a `ForgeHost`, forwards every method, and approval-gates writes using `ForgeOp::mutates` chosen by the router. In-memory hosts prove routing. No I/O, no vendor names, no envd or tool wiring. `github@3` is unchanged.
- **DONE** Phase 4 PR4: `omp-ci-delegated` host router — PR #556. Routes by ASCII-case-insensitive provider host to a `CiHost`, uses `route` for a details URL, forwards every method, approval-gates writes using `CiOp::mutates` chosen by the router, and enforces `Capabilities::allows` from the caps stored at registration. In-memory hosts prove routing. No I/O, no vendor names, no envd or tool wiring. `github@3` `run_watch` is unchanged.
- **DONE** Phase 4 PR5: `forge@1` and `ci@1` replace `github@3` in one cutover — PR #557. Both tools are rev 1. Envd serves them through `Delegated` routers (`GithubForgeAdapter` and `GithubCiAdapter` over `GithubService`). `PermitAll` is the router gate because the desk gate is the tool commit and the routers are not exported. Registered hosts are `github.com` and the checkout host when it differs. CI capabilities are `log_stream` only; status stays allowed. `watch` defaults to false and, when true, polls status until the pipeline is terminal and then reads failed-job logs. The neutral contract is not stable until the GitLab T2 extension (D2.8). ADR 0024 records +1 permanent schema (34 listed families becomes 35; hidden stays 6). The wall-clock benchmark was not re-run. `cap-forge` and `cap-ci` are not added. No GitHub or GitLab T2 extension is added.
- **DONE** Phase 4 PR6: numbered `pr://` and `issue://` reads go through forge `Delegated` — PR #559. `GithubForgeAdapter` implements `view_change_request`, `view_issue`, the unified diff, and the comment list. A bare number uses `infer_repo`; a missing host is `github.com`; `parse_resource_url` supplies the ref. The rendered body stays `# title`, a blank line, and the body, cached with no etag. List URLs stay on `GithubResolver`'s REST client. `envd/src/github.rs` and `github_url.rs` stay. No `mr://`, no `cap-forge`, no GitLab or GitHub T2 extension.
- **DONE** Phase 4 `cap-forge` + `cap-ci`: `omp-tools` `cap-forge`/`cap-ci` enable optional `omp-forge`/`omp-ci` (unlike empty Phase 3 caps, whose host crates live only on envd); `omp-envd` makes `omp-forge`, `omp-forge-delegated`, `omp-ci`, and `omp-ci-delegated` optional (`cap-forge` / `cap-ci`, defaults still empty) and forwards the tools features; `omp-app` defaults add both and forwards envd + chat + tools. Workspace `omp-chat` / `omp-tools` use `default-features = false` so selected unification of `omp-app --features local` can leave forge/ci out; chat's own defaults keep cards on for root chat tests. With a cap off, its `ROSTER` row, tools module/renderer, chat card, and envd install/declare path are compiled out; `Family::Forge` / `Family::Ci` stay. `GithubForgeAdapter` / `forge_router` / `CheckoutForge` / numbered `pr://`/`issue://` Delegated path compile only with `cap-forge`; `GithubCiAdapter` / `ci_router` only with `cap-ci`. `github.rs` / list-URL helpers stay. App omits `ServiceState.forge` when `cap-forge` is off; `branch_change_request` returns `Ok(None)` so the status-band chip stays empty. Selected unification: `cargo tree -p omp-envd -i omp-{forge,forge-delegated,ci,ci-delegated}` with `--locked --no-default-features` exits 101 (`did not match any packages`). With `--features cap-forge` / `cap-ci`, those crates appear under envd. `cargo check -p omp-envd` (no features), `cargo check -p omp-envd --features cap-forge,cap-ci,cap-computer,cap-browser,cap-media`, `cargo check -p omp-app`, and `cargo check -p omp-app --no-default-features --features local` under selected unification all pass. `just check-minimal-caps` asserts all four forge/ci packages (plus the Phase 3 set) are absent.
- **DONE** Phase 4 remainder host claims (landed under Phase 5): adapter host-claim discovery via `ForgeDynHosts` (`GITLAB_HOST` / `GITHUB_HOST` + convar). **DONE** GitHub T2 read+create via dyn (`extensions/github/` + host-dispatching `extensions/forge/` catalog). `github.com` is on the Dyn forge arm. **DONE** T2 CI + `github.com` CI on Dyn (`extensions/ci/`). **DONE** search leaves + list-URL / `ForgeResolver` parity via `ForgeHost::search`. **DONE** Dyn checkout/push (D2.4) — see Phase 5. SessionHost bound-client threading is DONE. Self-hosted Dyn host registration via `sv_forge_dyn_hosts` + `GITLAB_HOST` / `GITHUB_HOST` is DONE. Write creates (`change_request_create` / `issue_create`) are DONE for GitLab and GitHub. Class C (scrapers, admission `gh` scrub, minimizer `gh` filter) stays. Autocomplete `GithubRefs` stays. **DONE** `github_url.rs` → `forge_url.rs`. The extensions **home** is no longer the blocker (owner decision 2026-11-10: in-repo `extensions/`). Dyn `forge/*` bridge (D2.3) is DONE — see Phase 5.
- **DONE** Phase 5 D2.3: dyn `forge/*` device bridge. Schema in `docs/adr/0049-forge-dyn-device-schema.md`. Envd `DynForgeAdapter` + `ForgeBackend` (now Dyn-only alias) + `register_dyn_forge_host` under `cap-forge`; unit proofs route `gitlab.example` through a fake device client for `view_change_request` / `view_issue`. Adapter host-claim discovery is DONE at `ForgeDynHosts` / `forge_router` / `ci_router`.
- **DONE** Phase 5 `ci/*` dyn bridge (follow-up to D2.3). Schema in `docs/adr/0049-ci-dyn-device-schema.md`. Envd `DynCiAdapter` + `CiBackend` (now Dyn-only alias) + `LiveCiDeviceClient` + `register_dyn_ci_host` under `cap-ci`. Unit proofs route a dyn host through a fake / live client for `status` / `log_stream`. Capabilities ceilings stay in Delegated.
- **DONE** Phase 5 T2 CI extension body + flip `github.com` CI to Dyn: sole catalog owner `extensions/ci/` (`omp.ci`) mounts `ci/status`, `ci/log_stream`, `ci/capabilities` and host-dispatches to `omp_github.ci` / `omp_gitlab.ci` (no competing `ci` parents). Production `ci_router` registers `github.com` (`CI_GITHUB_HOST`) and `gitlab.com` (`CI_DYN_HOST`) on Dyn with the same bound `LiveCiDeviceClient`; unlisted checkout hosts also register on Dyn. Caps stay `log_stream` only. Pure mapping fixtures cover Actions run/jobs and GitLab pipeline/jobs → `Pipeline`/`LogPage`.
- **DONE** Phase 5 D2.8 (read path): GitLab T2 adapter under `extensions/gitlab/` + live `ForgeDeviceClient`. Envd `LiveForgeDeviceClient` binds `DeviceControlFactory::forge_invoker` (`call_mounted` → `omp.devices.call`); production `forge_router` registers `gitlab.com` on the Dyn arm (Unavailable until devices mount / invoker bound). Extension mounts `forge/{repo_view,change_request_view,issue_view,change_request_diff,list_comments}` at `extension_activate`; pure mapping unit tests cover fixture → `ChangeRequest`/`Issue` shapes. **DONE** SessionHost bound-client threading: `SessionHost` / EnvironmentHost URL resolvers reuse `ProductionControlBindings.forge_devices` (same slot as CheckoutForge). **DONE** self-hosted / other Dyn host registration + adapter host-claim discovery: `sv_forge_dyn_hosts` + adapter env `GITLAB_HOST` / `GITHUB_HOST` via `ForgeDynHosts` (forge and CI routers share the claim set; checkout hosts in that set route to Dyn).
- **DONE** Phase 5 D2.8 (write creates): mounts `forge/change_request_create` and `forge/issue_create`; POST GitLab `/merge_requests` and `/issues` from `ChangeRequestDraft` / `IssueDraft`; pure request-body builders unit-tested with fixtures. Checkout / push stay unmounted (ADR D2.4: repository work in core; no honest `CheckoutReceipt`/`PushReceipt` without local git).
- **DONE** Phase 5 GitHub T2 (read+create via dyn): `extensions/github/` (`omp_github`) mirrors the GitLab leaf set; sole catalog owner `extensions/forge/` (`omp.forge`) host-dispatches by `repo.host` to `omp_github` vs `omp_gitlab` (no competing `forge` parents). Envd `forge_router` registers `github.com` on the Dyn arm (same bound `LiveForgeDeviceClient`). Credentials: adapter data `GITHUB_TOKEN` / `GH_TOKEN` (documented; none in tree). Scheme/credential surface later neutralized to `forge_url.rs`.
- **DONE** Phase 5 search leaves + list-URL parity: mounts `forge/search_change_requests` and `forge/search_issues` (host-dispatch); GitHub + GitLab map list/search JSON → `SearchPage`; `ForgeResolver` list URLs (`issue://owner/repo?state=…`, `pr://…`; historically `GithubResolver`) call `ForgeHost::search` (Dyn for github.com/gitlab.com). Search path has no etag — list bodies cache without one. `search_code` / commits / repos stay unmounted.
- **DONE** Phase 5 D2.4 (dyn forge checkout/push): `CheckoutPlan` / `PushPrep` in `omp-forge`; dyn devices `forge/change_request_checkout` / `forge/change_request_push` return plan/push-prep JSON only; core `crates/envd/src/forge_worktree.rs` performs fetch / worktree under the repo mutation lock / push via `omp-vcs` and fills `CheckoutReceipt` / `PushReceipt`. `DynForgeAdapter` obtains plan → call core → return receipt. Worktrees live under `forge-worktrees/cr-{n}`.
- **DONE** Phase 5 delete in-core `github.rs`: `ForgeBackend` / `CiBackend` are Dyn-only; `GithubForgeAdapter` / `GithubCiAdapter` / `GithubService` / `github_params.rs` removed. Unlisted checkout hosts register on Dyn (honest Unavailable without mounts). `CheckoutForge::view_branch` uses forge-neutral `ForgeHost::search` (`head:` + `state:open`) then `view_change_request`. Class C scrapers / `gh` scrub and autocomplete `GithubRefs` stay by design.
- **DONE** Phase 5 neutralize `github_url.rs` → `forge_url.rs`: rename+move with no shims; `GithubResolver`/`GithubScheme`/`GithubRepo`/`GithubCredentialBridge`/`GithubRead` → `ForgeResolver`/`ForgeScheme`/`ForgeRepo`/`ForgeCredentialBridge`/`ForgeRead`; default host constant `DEFAULT_FORGE_HOST` (`github.com`). Every caller cut over.
- **DONE** Phase 5 rename crate module `github_adapter` → `forge_adapter`: rename+move with no shims; `dyn_forge.rs` / `dyn_ci.rs` filenames kept; every caller cut over. Intentional residue: Class C / `gh` scrub / autocomplete `GithubRefs`.
- **DONE** Phase 5 conformance CI + first-cut manifest effect checks (D5/D4): `scripts/check-extension-conformance.py` gates every `extensions/*/omp.toml` (required keys, closed-vocab `capabilities`, wave-1 `env.net.fetch`, no Cargo members, no competing soft `forge`/`ci` parents on backends), runs package `tests/` with README PYTHONPATHs, and smokes frozen `omp` imports under native stubs. `just test-extensions` / `just check-extensions`; CI job `First-party extension conformance` (informational, not ruleset-required). Path filter includes `extensions/**`.
- **DONE** Phase 5 adapter host-claim discovery: `ForgeDynHosts` reads `GITLAB_HOST` + `GITHUB_HOST` (+ convar / `with_catalog_claims`); `forge_router` and `ci_router` register the same claim set. No new `omp.toml` host-claim schema; Delegated stays immutable.
- **DONE** Phase 5 rescue wave 1: eight ports restored under `extensions/` from `00611047c1^:examples/<name>/` (`pr-review`, `green-loop`, `workflows`, `remote-approve`, `search-provider`, `provider-pack`, `fuzzy-index`, `spec-flow`). Manifests + pure unittests + conformance discovery; several packages keep documented Gaps where typed journal/`omp.state` were removed (`state_dir` adaptation). Triage: `extensions/RESCUE.md`. UI-bound ports (`sidebar`, `hover-cards`, `welcome-chrome`) stay out of this wave.
- **DONE** Phase 5 remainder / ADR 0046 item 4: chat-host UI arms for `omp.ui.mount`/`unmount`/`patch`/`focus_slot`/`blur_slot` (retained `ExtensionSlots` in `omp-chat`), retained overlays (`Overlay*` on `ChatUiOwner` via `ext_overlay`), and `dynamic_mount` (generation-fenced console command install). UI-bound ports restored: `extensions/sidebar`, `extensions/hover-cards`, `extensions/welcome-chrome`. Intentional Gaps: hover-cards activation callback (frozen-vs-docs); sidebar telemetry event types as `object`. Phase 5 remainder is empty.
- **DONE** Phase 5b step 3 (ADR 0046 item 3): `omp_contract::HOOK_EVENTS` (`crates/contract/src/hook_catalog.rs`) is the hook-event descriptor table, one `HookEventDescriptor` (frozen `HookEventId`, payload schema revision, payload type name) per non-UNSPECIFIED `HookEventId`. `crates/contract/tests/hook_catalog.rs` holds it to `toolhost.proto`, `omp.events`, `omp.hooks` (its rejected names stay an explicit no-`HookEventId` state) and the Claude `HookSeam` mapping. Remote `remote-plain-test omp-contract`: 25 tests run, 25 passed. Open: `agent_settled` is revision 2 in `omp.events` but `AgentSettledEvent::REV` is 1 in-process; the driver `seam_event` parity and the `plugin_hooks` default arm are step 4.
- **OPEN** owner decision (ADR 0046 item 3): the `agent_settled` schema revision. `omp.events`, `docs/py/05-hooks.md` and `HOOK_EVENTS` declare 2; `omp_contract::AgentSettledEvent::REV`, which `HookGate` stamps on its dispatch, is 1. Either Python and the catalog move to 1, or `AgentSettledEvent::REV` and `HookGate` move to 2. `agent_settled_revision_divergence_is_pinned` in `crates/contract/tests/hook_catalog.rs` fails once either side moves. Runtime impact is unverified: `compose` in `crates/envd/src/tools/hooks.rs` rejects an `event_rev` that differs from the subscribed policy revision, and no `agent_settled` policy was found on the revision-1 path.
- **DONE** Phase 4 (D6 class A, forge, gitwatch): `chat/src/gitwatch.rs` no longer spawns `gh`. The chat host asks `Services::branch_change_request`. App builds `ProjectEnvironment::checkout_forge`, the same forge `Delegated` router as `forge@1`, and `CheckoutForge::view_branch` reads the open change request through `view_change_request`. The chip still shows the number and URL. Autocomplete insertion strings stay `pr://` and `issue://`; the module name `github_refs` stays. Extensions home decided 2026-11-10 (`extensions/`); GitLab T2 is OPEN / next.
- **DONE** Phase 4 (D6 class A, forge-cache): `cache/src/github_cache.rs` renamed+moved to `cache/src/forge_cache.rs`. Types, SQLite filename/table (`forge-cache.sqlite3` / `forge_cache`), convars (`sv_forge_cache_*`), and every caller cut over with no shims. TTL/etag/rebuildable semantics unchanged; old sqlite files are discarded. Autocomplete module name `github_refs` stays. Extensions home decided 2026-11-10 (`extensions/`); GitLab T2 is OPEN / next.
- **DONE** Phase 4 (D6 class A, execution steps 1–3): REAPI profiles are operator data (`sv_exec_remote_credential_header`, `sv_exec_remote_arch_spelling`, `sv_exec_remote_fixed_properties`, `sv_exec_remote_refuse_action_cache`); `Profile::buildbuddy` and every `"buildbuddy"` branch in `adw/remote.rs` are gone. Deleted `buildbuddy-cancel`, `buildbuddy_cancel.rs`, `proto-buildbuddy/`, and the orphan `crates/exec-buildbuddy` workspace member. Root `Cargo.toml` no longer names BuildBuddy. Cancel now uses standard `Operations.CancelOperation` / action timeout until `DelegatedBackend` adds a cancel fallback (research steps 4–5). Evidence: `just test-pkg omp-exec-reapi`, focused `omp-driver` tests, `cargo check -p omp-app --tests --locked`.
- **BLOCKED** Phase 4 (D6 class A, execution remainder): `DelegatedBackend`, a later Delegated cancel fallback (research steps 4–5), and `repo_pins` rewrite (step 6). The execution-job producer (`JobBoard::start_execution`, `da1f9a0a25`) and `reattach_execution` (`8084b0964b`) landed on 2026-11-08 and are mock-tested, not live-verified; the `omp-agent` suite passed 375 of 375 on a BuildBuddy runner at `origin/omp2` `03e79c0f69` (mock backends only: no live kill-and-resume, no REAPI run); ADR 0040 acceptance is still open. A BuildBuddy Run API / cancel extension still needs that Delegated surface; the extensions **home** (`extensions/`) is settled.
- **DONE** Phase 4 codex exit check (ADR 0043 ruling 2026-11-09) on tip `3dba669808`: neither Exit 1 nor Exit 2 holds; `envd/src/codex_app_server/*` kept as the recorded exception. Exit 1: no Codex ACP launch profile — `crates/driver/src/delegated_acp.rs` registers only dsh / Devin / Grok (`DSH_ID`/`DEVIN_ID`/`GROK_ID`, `enabled_executors`); Codex stays on the native app-server path (`sv_delegated_codex_program` in `delegated_host.rs`). ADR 0043 gaps still hold: system sections go through `thread/inject_items` (`session.rs` ~753–769; `TurnStartParams` in `wire.rs` has no system-prompt field); approval `write` and network `scoped` remain unmappable (`policy.rs` `wire_policy` returns `None` → `ExecutorError::PolicyUnmappable` at `session.rs` ~285–288). Research still records no Codex ACP server mode (`docs/research/native-cli-feasibility.md`). Exit 2: no delegated-executor **extension** contract in-tree — only the in-core `omp-agent` delegated + ACP client T1 surface; `DelegatedBackend` remains research/BLOCKED (`docs/research/exec-out-of-core.md`; TASKS execution remainder); a vendor-executor extension host remains Phase 5 work under `extensions/`. Module not deleted; no fake Codex ACP profile added.
- **OPEN** owner choice: the `local` (candle) default.
- **DONE** owner choice (2026-11-10): first-party T2 extensions home = in-repo `extensions/` (same-repo layout as early omp2 / can1357 upstream; not a Cargo member). Owners = repo maintainers / this tree. Wave-1 starts with the **GitLab forge adapter (D2.8)**; the list may grow. See `extensions/WAVE1.md`.

## ADR 0050 — extension-declared URL schemes

ADR status: **accepted by the owner 2026-11-11 with conditions**. Placement is ADR 0049 Phase **2S**, after Phase 2 and before Phase 3. Phase 2S does not satisfy a Phase 2 or Phase 3 exit criterion. One PR per slice. S1 may start; S2 to S5 stay gated as the ADR sequences them.

- **DONE** owner decision (2026-11-11): accept ADR 0050 with conditions.
- **DONE** owner decision (2026-11-11): D1 one canonical spelling, no aliases in v1.
- **DONE** owner decision (2026-11-11): D7 extensions use `mcp://`; no declared native MCP schemes.
- **DONE** S1 (PR #593, branch `feat/adr0050-s1-schemes`): manifest field `schemes` in `crates/ext/src/scheme.rs` (ASCII-lowercased canonical spelling, `^[a-z][a-z0-9+.-]*$`, at most 64 bytes, unique after lowercasing, at most 32; `SchemeDeclarations::claim` refuses an unclaimed name and a grammar miss) and additive, inert `omp.schemes` in `crates/py/python/omp/schemes.py` (refuses every built-in wire name of `url-vocab.json`, `https` and `pr` included). `omp.urls.schemes` is unchanged; nothing binds a resolver until S2. The package-root alias `from .urls import schemes` (a callable, never in `__all__`, no users found) is dropped, so `omp.schemes` is now the module; `omp.urls.schemes()` is unchanged. Tests: `omp-ext` `scheme::tests`, `omp-py` `schemes_contract`.
- **OPEN** S2 (starts once S1, #593, lands): bind declared schemes onto the existing unknown-scheme fallback (`install_unknown_fallback` → `HostUriResolver`). Gap from the S1 review: nothing links the manifest claims to `omp.schemes.register`, and `crates/ext` cannot refuse built-in names, so a manifest declaring `https` or `pr` passes the Rust parser today and is refused only if the extension itself calls `omp.schemes.register`. S2 MUST gate `register` on the loaded manifest's claims and refuse built-in wire names where claims are folded into the generation; its exit adds the named test `declared_scheme_fold_refuses_builtin_and_unclaimed`.
- **BLOCKED** S3: core line selectors and effect judgment for declared schemes. Prerequisite: replace the blanket `FetchEffects { credentials: false }` answer for host URIs (`crates/envd/src/tool_url.rs:453`) with the declaration-based judgment, with the regression test named in ADR 0050 D5. `mcp://` and undeclared unknown URIs stay selector-opaque.
- **BLOCKED** S4: `/reload-plugins` → `Mutation::ReloadExtensions` → `ExtensionReloadHandle::reload` rebinds the generation; `quarantine_extensions` drops that extension's schemes and keeps static routes.
- **BLOCKED** S5: model-facing listing without a roster change, plus the conformance read, selector, reload, and quarantine test.

## ADRs 0051 to 0053 and the factory and harness plan (2026-11-12)

Owner prompt 2026-11-12, roadmap P0 to P5. New records: [0051](0051-durable-resumable-adw-runs.md) durable ADW, [0052](0052-one-executor-contract.md) one executor contract and harness adapters, [0053](0053-independent-verdicts.md) independent verdicts. Amended in place: [0039](0039-remote-control-and-factory-modes.md) (Part D: workstreams, multi-repository, Issue-to-PR, invariants), [0043](0043-native-cli-integration.md) (vendor coverage, A2A, a gate on Q18), [0007](0007-subagent-filesystem-isolation.md) (parallel isolation, conflicts, OVNFS). Research: `docs/research/durable-run-coordinator.md`. Already decided and not redone: ACP client with launch profiles and A2A as shims (0043 and `docs/design/acp-extension-profiles.md`).

- **PARTIAL** P0 (ADR 0052 D6): an ADW prompt phase may name an `executor` (`[[phase]] executor = "codex"`); the ADW host routes it through `run_delegated_prompt`, the first production caller of `run_delegated_turn` and `ExecutorRegistry` (`crates/driver/src/adw/production.rs`, `crates/driver/src/delegated_host.rs`). The turn is journaled under `<data dir>/adw/delegated` and kept; the answer is the agent's final message and feeds the same `judge` as a native phase; a turn that did not complete is an error; an unknown executor is a typed error, never a native fallback. Proven with `MockExecutor` (answer and journal, a permission prompt denied with no approver, unknown executor, policy, text extraction) and the definition parser. **Not done:** a real Codex run (needs the CLI and credentials), cancel proven end to end through ADW, a phase requirement to `DelegatedPolicy` mapping (ACP executors are refused in `run_delegated_turn` itself (policy declared, not enforced), a phase that names an executor and declares a requirement is a load-time error, delegated phases are fixed at `DelegatedPolicy::STRICTEST`, read-only with no network, so they can review but not edit), an approver instead of `DenyAll`, and the `task` tool path.
- **PARTIAL** P1 (ADR 0051): `RunStore` trait, run journal, `Run` replay constructor, `omp adw resume`, effect keys and a first reconciler (PR creation). Unblocked: ADR 0051 records the specification decisions (S1 to S7). **Slice 1 done:** `omp_journal::Vocabulary` and the `_with` constructors. **Slice 2 done:** `omp_journal::runlog` (typed records, `RunLog` writer and reader). **Slice 3 done:** `omp_adw::replay` and `Run::snapshot` (PR #607). **Slice 4 (driver integration):** `records_to_replay_events`, `run_with_log`, `resume_from_log`, CLI `omp adw resume`. Next: first reconciler (PR creation, R1).
- **OPEN** P2 (ADR 0052): router, assignment layer, native OMP2 as an executor.
- **OPEN** P3 (ADR 0007 amendment, ADR 0051): concurrent ADW driver, isolated workspaces, integration conflict detection. Not started.
- **OPEN** P4 (ADR 0053, ADR 0039 Part D): `@judge` role, structured verdict, acceptance criteria, Issue-to-PR recipe, workstream ledger. Blocked on ADR 0053 O1.
- **OPEN** P5: factory API over `omp-rpc` and `omp-sdk`; not designed beyond ADR 0039 Part A.
- **OPEN** OVNFS (`stencil-hq/ovnfs`, owner-supplied): evaluate it as an extension isolation backend for parallel ADW workspaces (ADR 0007 amendment). README read only; the open items are listed in that amendment. Not started.
- **OPEN** decision-model judges (upstream issue can1357/oh-my-pi#18621, owner-supplied): let the judge route be a calibrated decision model and let `Verdict` carry probability and confidence (ADR 0053 related-request section). Upstream wants one provider per pull request and closed the bundled request; in OMP2 each adapter is an extension. Not started.
- **OPEN** MicroVM execution backend (ADR 0052 implementation guide, owner-recommended 2026-11-12): generic MicroVmBackend over ExecutionBackend, E2B/Vibemon adapter first, SmolVM and Microsandbox later; isolation, authority and recovery safeguards are normative. Not started.
- **OPEN** harness-as-host and the Vibemon execution-backend extension (ADR 0052 D8). OMP2 has no Vibemon adapter. `vmon.ts` was read in upstream can1357/oh-my-pi (a sandbox lifecycle, a host gateway and an RPC transport; see ADR 0052); the rest of the OMP1 metaharness (adapters, runner) and OMP1's `/review` prompts are unread. Upstream is the git remote `upstream` of the main checkout.
- **OPEN** owner decisions, with the fresh-context review (EGM personas zoom-out, comprehension, design critic; ADR 0053 evidence section) of 2026-11-12. These supersede the author's earlier recommendations:
  - `agent_settled` revision: do not take option A as wire-neutral. Python subscribers already put revision 2 on the wire and envd refuses a mismatched revision (`crates/envd/src/tools/hooks.rs:942-950`). The critic reports a Python `agent_settled` hook can never `Continue` today (fail open); only the first half was verified. Decide A or B after an end-to-end test where a Python hook returns `Continue`, and log the dropped Deny.
  - `omp-exec-ssh` closure: reword the ADR 0049 exit to name both measures. Under the repository's `feature-unification = "workspace"` (`.cargo/config.toml`) the count is about 363 and the exit is open; the 273 figure is a distinct-name count and is not a basis for calling it met.
  - ACP Q18: defer. Core needs an enforcement canary, an environment allowlist, a digest of every file the launch names plus `[evidence]`, refusal of an interpreter as the program, and sanitized approval text first (ADR 0043 amendment 2026-11-12).
  - ADR 0040 Gaps 1, 3, 4: do not accept yet. The two Step 2 tests ADR 0040 D1 requires do not exist (`execution_no_node_no_start_on_restart`, `execution_t13_crash_between_acceptance...`). Defer the Gap 2 live check with a hard trigger: before stage-2 work, before enabling `sv_exec_agent_runs` on any other machine, or before any non-test recipe. Keep the default off.
- **OPEN** ADRs 0051 to 0053 are proposals, not implementation-ready: an EGM implementation-readiness review (2026-11-12) found factual errors, now corrected, and decisions left open, now listed in each record's "Not yet specified" section. Settle those lists before code.
- **OPEN** the question text for the four decisions above was judged not decidable from its own text for three of them (reviewer finding); rewrite with definitions before asking the owner again.

## ADR 0048 — schema and serialization boundaries

ADR status: **accepted 2026-10-28; implementation gate open**.

Completed implementation items:

- **DONE** `buf breaking` configuration, CI check, and `just proto-breaking`.
- **DONE** B1, B2, B3, B4, B5, B6, B7, and B8.

Active items:

- **DONE** B4. `validate_worker_frame` guards the worker process and readiness-ping decode paths, and `validate_host_frame` guards the host-frame child path. `just test-pkg omp-proto` passed 33 tests plus one doctest.
- **DONE** B5 corpus replay and family identity: `crates/session/tests/golden_journals.rs:golden_journals_open_and_fold_to_their_recorded_snapshots` compares fixture names with `corpus()` and replays each against its snapshot.

- **RESOLVED** golden-corpus replay/registry divergence. `crates/session/tests/golden_journals.rs:golden_journals_open_and_fold_to_their_recorded_snapshots` compares the sorted registered names with the discovered fixture names.
- **DONE** branch-protection documentation drift. `.github/rulesets/omp2-protected.json` requires 11 status contexts; `docs/BRANCH_PROTECTION.md` lists all eleven (including `Protobuf format and lint`) and its prose says eleven. Found 2026-11-03; prose count corrected.
- **NOTE** a docs-only diff skips every code job: `.github/ci-paths.txt` gates `rust`, `remote_linux`, `protobuf` and the lint jobs out, observed on PR #466 (run 41594072179). Only `Detect CI-relevant changes` and the labelers run.

`just proto-breaking` passes on the current tree. `just e2e-p8` passes. The latest non-gating P8 artifact is workflow run [40246613996](https://github.com/blyzer/oh-my-pi/actions/runs/40246613996), but it measures the synthetic recorder workload, not ADR 0045 workloads W1–W9.

`adr0048-slice-c` is a **HISTORICAL** audit, not the live state. Its B8 and B9
labels are stale relative to the current tree. Use this section, the ADR, and
`STATUS.md` instead.

## Deferred PR audit

The active inventory is the committed
[`docs/audits/pr-deferred-adr-audit-2026-10-21.md`](../audits/pr-deferred-adr-audit-2026-10-21.md)
(95 classified rows: already-done, actionable-now, blocked, stale). The
session-local `pr-deferred-audit` (PRs 1–346, 2026-10-19) is **HISTORICAL**
and superseded by that file.

Deltas verified 2026-10-25 against `omp2` after PR #419:

- **RESOLVED** `SCOPED_WRITERS` typed-confinement follow-up (PR #197 item):
  PR #349 added `Confinement::DocumentAuthority`; the name list is gone.
- **RESOLVED** account-pin notice (PR #172 item): `crates/app/tests/rpc_spine.rs`
  asserts the `account-pin` notice frame.
- **RESOLVED** ADR 0038 open decisions (FOLLOW-0038, FOLLOW-0038B): PR #413.
- **RESOLVED** ADR 0045 W8 evidence (0045-CONTAIN test deliverable): PR #419.
- **Progressed** FOLLOW-0035 error-format migration: ratchet 1042 → 639
  formatted sites after PRs #414–#417.
- **BUILT, UNACCEPTED** `reattach_execution` backend call
  (formerly a TODO at `crates/agent/src/jobs.rs:1246-1257`, no longer present). The pieces it waited on exist: the
  versioned `ReattachHandle` (`crates/exec/src/handle.rs`, `01f8151003`) and the
  `WaitExecution` reattach in `crates/exec-reapi/src/execute.rs:ReapiBackend::reattach`.
  The producer now exists (`JobBoard::start_execution`, called by the `remote_build` tool,
  off by default) and `reattach_execution` is implemented (`crates/agent/src/jobs.rs:1669`, reached from
  `crates/app/src/jobs_cmd.rs:105`); what is open is acceptance and a live kill-and-resume run
  (ADR 0040 "Gap to acceptance", items 1 and 2). ADR 0039 Part B has no
  reattach text and ADR 0039 R2 does not unblock it.
- **STILL OPEN** kernel dispatch `channel_for(None, ..)`
  (`crates/agent/src/dispatch.rs:1549`; owner decision).

Deltas verified 2026-11-01 against `omp2` at `04576bc158`:

- **RESOLVED** FOLLOW-0007. The owner kept the gitignore allowlist empty. Gitignored files stay out of the CoW snapshot. ADR 0007 and `STATUS.md` record that as the rule, not an open gap.

Deltas started 2026-11-01 from `omp2` at `04576bc158`:

- **BLOCKED** ADR 0040 execution, re-verified 2026-11-04 at `1578b1204c`. Slice 1 is composed. `crates/driver/src/adw/production.rs:ProductionAdwHost::run_command` places eligible ADW code phases without `crates/exec/src/place.rs:place`, and `crates/driver/src/adw/remote.rs:ProductionAdwHost::run_remote` runs them over `ReapiBackend`. The production gate is unmet: no product path produces a `JobKind::Execution` job and `crates/agent/src/jobs.rs:reattach_execution` is a stub. The owner decided to require both before acceptance. Memory relief lacks a threshold and role-inclusive measurements; warm wall time needs a warm-state backend. The remote envd failures (three process-lifecycle tests, including `crates/envd/src/lib.rs:spawn_kills_a_daemon_that_never_becomes_ready`) stay open and undiagnosed.
- **DONE** ADR 0039 R2. Submit, Approve, and AnswerUi are served by `crates/serve/src/session.rs:SessionControlRpc::{submit,approve,answer_ui}` and `crates/driver/src/session_wire.rs:SessionWire::{submit,approve,answer_ui}`. New-session Open is served by `SessionControlRpc::open` and `SessionWire::open_session`; resume and fork remain `UNIMPLEMENTED` in `SessionControlRpc::open`. R2 landed on `omp2` in `3410f1e74f` (#478) and `19c807d686` (#477).
- **PARTIAL** ADR 0041 phase 3. Implemented: the `screen` cover for a full-screen panel (`crates/chat/src/host.rs:Host::present_tsp` through `crates/chat/src/tsp.rs:Surface::present_cover`, #472) and native composer `edit` and `undo` (`crates/tui/src/tsp/edit.rs:resolve`, `crates/tui/src/editcore.rs:EditBuffer::apply_native_edit`, P7 `tsp_native_edits_round_trip_through_utf16_offsets`). Open: `send`, data-first pickers and the picker half of the exit criterion, the autocomplete overlay at the caret, `prefs` and `effort`.
- **OPEN** ADR 0041 phase 4, which is optional and decided per item by the owner. No production code opens a `flow` surface (`crates/chat/src/host.rs:Host` builds inline surfaces, and `crates/app/src/print_mode.rs` has no TSP code), nothing calls `crates/chat/src/tsp.rs:Surface::set_stylesheet`, and nothing in `crates/` reads `TERN_BLOB_DIR`.
- **OPEN** the ADR 0034 amendment that the Consequences of ADR 0041 ask for. `docs/adr/0034-transcript-is-a-protocol.md` does not mention TSP surfaces.

Deltas verified 2026-10-25 against `omp2` at `1776c5cd25` (after PR #429):

- **RESOLVED** ADR 0039 phase R1 (read-only attach over the owner UDS). The orphaned PR #342
  is superseded, not recovered: its two lost files were rebuilt against the real projection
  rather than restored, and its `attach_cmd::run` stub that parked on
  `std::future::pending()` was never reinstated. R1 landed as PRs #433 through #442 and the
  P14 proof: `omp_dom::wire`/`redact`, `ControlVisibility`, `SessionBridge`, `SessionWire`
  on the owner socket, `SessionControlRpc` (Submit, Approve, and AnswerUi are now served by `crates/serve/src/session.rs:SessionControlRpc`), the
  `omp attach --observe` client, and the idle-session subscription seam. The unit queue and
  what each unit carries are below; `origin/feat/session-host` holds nothing `omp2` needs.
- **NO ACTION** Codex `auth_required` object-form classification. PR #366
  classified a signed-out `-32000` inside `codex_app_server`; `286ff0945b`
  reverted it and moved the rule to `acp_client::wire::is_missing_login`,
  because that shape arrives through the ACP client. The Codex adapter is
  correct as it stands. Do not re-apply #366.

  Re-confirmed 2026-10-27, because a stash-triage plan written before the
  revert listed the Codex-side typing as the one change worth retaking from
  the stashes. It is not. `crates/envd/src/acp_client/wire.rs:58-61` holds
  `MISSING_LOGIN_CODE` and `MISSING_LOGIN_DATA`, consumed at
  `delegated_session.rs:611` and `:789`, and `acp_client/tests.rs:956-1015`
  pins the exact shape plus four near-misses that must stay internal (`-32603`
  with the same `data`, `-32000` with no `data`, `-32000` with other `data`,
  and a structured `data`). `codex_app_server/session.rs:935-937` states the
  decision in the code: the object form stays `Internal` on purpose. The
  stashes are gone, so retaking it would mean re-implementing the reverted
  approach by hand.

## ADR 0039 R1 — decided and queued

The owner answered R1's blocking questions on 2026-10-26, recorded as the ADR 0039 amendment of
the same date. R1 is gRPC, owner-local, read-only, and carries canonical `omp_dom` bytes. The
`omp.control.v1` session messages are kept. Advisor-subtree redaction is out of R1 because the DOM
has no advisor marker to key on.

Units, in dependency order. Each lands as its own change with its own tests.

1. **DONE** `KernelHandle` carries the session's project root, so `SessionRef.project_root` can be
   filled (PR #433).
2. **DONE** `omp_dom::wire` encodes and decodes `Event`, replacing the private codec in
   `crates/driver/src/collab/session.rs`, and `omp_dom::redact` blanks host-local properties in
   place without pruning nodes or moving handles (PR #434).
3. **DONE** `ControlVisibility`: the configurable redaction table, backed by a convar so the owner
   can change the rules without a recompile (PR #436).
4. **DONE** `SessionBridge`: one bounded replay ring per attached session, an `(epoch, seq)`
   cursor, `Resync` for stale or evicted cursors, ordered `Reset` entries, lossless stream-append
   merging, and a drain task that never blocks the kernel (PR #437).
5. **DONE** `SessionWire` in `crates/driver`: reads `SessionRegistry`, owns the bridge table, binds
   the owner-only UDS at `<data dir>/run/session.sock`, and absorbs the permission and stale-socket
   handling from the unused `SessionHost` (PRs #439, #440).
6. **DONE** `SessionControlRpc` in `crates/serve`: `ListSessions` and `Attach` over a
   `SessionControlAuthority` trait that driver implements, with identity taken from transport
   extensions. At the R1 milestone, the four mutating verbs answered `UNIMPLEMENTED` (PR #435); see the R2 entry above for their current status.
7. **DONE** `omp attach --observe` remains the pipeable owner-socket observer. The retained
   R2 viewer is also implemented in `crates/chat/src/overlays/hub.rs`: `/hub` Enter runs
   `transcript <id>`, `TranscriptViewer` consumes `AgentView` snapshots and ordered patch
   streams, renders the detached transcript, supports steering input and scrolling, and closes
   cleanly. The `omp-chat` package verification passed 738 tests and doctests.
8. **DONE** Proofs: unit tests per crate, the driver integration test over a real UDS
   (`crates/driver/tests/session_attach_uds.rs`), the command's own socket path
   (`crates/app/tests/attach_client.rs`), and P14 (`crates/e2e/tests/p14_session_attach.rs`):
   a production kernel, the owner socket with its interceptor, and the generated client prove
   convergence from a snapshot plus ordered events, detach and cursor resume replayed from the
   ring, a foreign epoch answered with a resync and a fresh snapshot, a restarted host minting a
   new epoch, redaction of every host-local property under the shipped table, and the refusal of
   all four mutating verbs. Gated in `just e2e` and in CI's Linux proofs job.
9. **DONE** An idle interactive kernel never answered `Up::Subscribe`, because a kernel drains its
   mailbox only inside a turn. `KernelHandle` now carries `idle_subscribe`, the channel whoever
   holds the session between turns serves, and the wire asks the mailbox and that seam together,
   taking whichever answers. The chat controller serves it from its idle loop; `SessionHome`
   installs the seam and patches the handle `compose_kernel` registered before the controller
   existed. Smoked against a real `omp chat` sitting idle: welcome, a two-chunk snapshot, and a
   heartbeat.

   Found while fixing it, and left as it stands. The arm must be **first** in the controller's
   `biased` idle `select!`: placed third, behind `command_rx` and the pending-input gate, the host
   did not answer an attach within the 5 s subscribe budget, reproducibly, and moving it to the
   front fixed it just as reproducibly (three failures, three successes, same build otherwise).
   The mechanism is unexplained: `command_rx` carries only discrete user commands, so an idle chat
   should not feed it. Open question, with a real defect found next to it — the `REVIVED_POLL` and
   `GOAL_CONTINUATION_DELAY` arms construct their `tokio::time::sleep` inside the loop, so every
   iteration discards the timer and starts a new one, and neither fires while any other arm fires
   more often than 500 ms / 800 ms. The subscription arm is one such arm, so an observer
   re-attaching in a tight loop postpones goal continuation indefinitely. Both belong to the
   controller's loop, not to R1.

Deferred by the same decision: WebSocket, JSON, and gRPC-Web surfaces, which are adapters over
this projection and need a named consumer first.

Found while building units 2 and 4, and not part of R1:

- **RESOLVED by PR #449** `Snapshot::from_bytes` now validates through borrowed
  `RawValue` tokens and retains the validated source bytes, so structured and scalar lexical JSON
  survives the fixed-point round trip while typed scalar `Value` compatibility remains unchanged.
- **OPEN** `PropPolicy::redacts_content` receives only a `Tag`, so a value-conditioned rule cannot
  be expressed. The advisor transcript card is identifiable in the DOM, as a `notice` carrying
  `kind = advisor`, but classifying it needs a wider signature; `notice/data` alone would swallow
  unrelated notices. ADR 0039 section A4 names advisor subtrees as host-local, so R1 ships with
  that card unredacted.

## Superseded task snapshots

- `adr-task-list` is **HISTORICAL**. It is a session snapshot, predates ADR
  0045/0048 reconciliation, and contains both completed work and stale
  blockers. It is replaced by this file for active sequencing.
- `adr0045-slice-b` is retained as evidence and remains valid as an
  investigation.
- `adr0048-slice-c` is retained as evidence but is superseded for status by
  this file.
- `pr-deferred-audit` is retained as a dated audit, not an active queue.

## Validation rule for future sessions

Before starting an ADR task, verify the current branch, merged PR state, the
ADR implementation gate, and the cited code/test evidence. When a task lands,
update the affected ADR's `Status in omp`, `STATUS.md`, and this ledger in the
same change. Do not copy completed items into another task list.
