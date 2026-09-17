# Native savings and autonomous tasks: implementation ledger and acceptance campaign

Recorded: 2026-09-10. Scope: recovery knowledge and proposed verification, not implementation authorization.

## Executive state

**A and B+C were accepted at earlier revisions. D is partially implemented and unaccepted. E and Z have not started.** There is real native execution/recovery machinery and bounded passing behavioral evidence. There is not yet an accepted end-to-end reliable autonomous system or a measured token/cost-savings result.

This entry records the user's request for a profound implementation inventory and testing approach. It is based on the consolidated recovery contract, requirement matrix, and the discussion that followed. It is not a fresh production-source audit. No implementation tests, timing invocations, remote commands, commits, or production edits were performed to write this entry.

The user subsequently selected **Approve amendment and coverage inventory**: the narrow ALIGN-STOP exception, four-artifact amendment, read-only source/test inventory, and a proposed bounded D test batch. The amendment is now applied and parse-verified; section 9 records current coverage inspection. This does not authorize implementation changes, test execution, D/E/Z completion, paid benchmarks, timing experiments, remote dispatch, cleanup, or additional agents.

## 1. Reading the status correctly

| Term | Meaning here | What it does not mean |
|---|---|---|
| Previously accepted | A batch passed its historical acceptance at an earlier revision | Later shared changes cannot regress it |
| Implemented, partial evidence | Recorded implementation exists and selected behaviors have observations | Every lifecycle or safety requirement passes |
| Passed, bounded | The cited case passed within its stated scope | Its siblings, current union, or performance stability passed |
| Unverified | Current acceptance evidence is missing, incomplete, or stale | The implementation is necessarily absent or broken |
| Failed | A retained check or historical literal interpretation failed | Every related behavior fails |
| Not started | The contract records no completed work for that gate | It is automatically authorized next |

Historical source observations are evidence of code shape at a time, not runtime containment. Historical test success cannot be carried forward across later SDK/task changes without a current relevant regression run. A missing/truncated output cannot be promoted to a passing total.

## 2. Evidence and cold-session recovery

Repository: `C:/dev/infra/oh-my-pk`.
Primary package: `packages/coding-agent/`.

Historical artifact root, referred to below as **R**:

```text
C:/Users/prest/.ompk/agent/sessions/--C--dev-infra-oh-my-pk--/2026-09-10T00-20-58-530Z_01a088b0-6c22-7000-b0bb-f41bc81e9cfb/local/
```

Read these by absolute physical path rather than assuming another session's `local://` aliases resolve:

- `native-savings-recovery-contract.txt`: consolidated observable requirements and exact final gates.
- `native-savings-recovery-evidence-matrix.tsv`: per-requirement status, evidence IDs, currency, and remaining gate.
- `native-savings-recovery-evidence-index.tsv`: original evidence/capture references; consult before relying on a historical command/result.
- `native-savings-recovery-experiment.txt`: experiment history and falsified duplicate-capture premise.
- `native-savings-recovery-review.txt`: historical independent review, not review of this later documentation or a future amendment.
- `checkpoint-baseline-clarification-plan.md`: historical four-artifact amendment plan.
- `native-savings-d-host-test-residue.json`: inventory of attributable test residue; not permission to remove it.

The original `native-savings-autonomy-plan.md` remains provenance, not a required reread for this recovery entry. Do not recreate raw captures from summaries or substitute another session's similarly named files.

The consolidated contract recorded `main` at `dffe5704488f0b58e65480a6792a2d7e4f380eb8`, with 0 staged, 29 modified tracked, and 11 untracked entries. **Those are historical observations, not a fresh checkout status.** A future execution batch must record its own baseline, including untracked modules/tests. Ordinary `git diff` alone is not a complete inventory.

## 3. Implemented behavior by batch

### A — Effective delegation policy, model routing, root restrictions

Historically accepted. Current regression row: **R-A**.

The retained contract includes:

- Activation only with Fusion enabled, I/O delegation not disabled, and a supported savings/autonomous mode. Fusion remains disabled by default.
- Effective line threshold defaults to 350; positive integer environment overrides and invalid persisted/environment values follow defined fallback/warning behavior.
- Autonomous retains its selected planning model. Ordinary token-savings root steering is not accidentally activated by autonomous mode.
- Explicit worker model, difficulty, configured override, and role fallback keep their precedence.
- Shared bulk-I/O guidance appears once, late after stable harness instructions. Status distinguishes effective policy from actual store-derived durable counts or unavailability.
- Autonomous MAIN is fail-closed: read/inspect/ask/delegate/control capabilities are bounded; direct execution and mutation, unknown execution capabilities, and unsafe resolution are denied.
- Enforcement includes SDK, nested/direct/programmatic calls, previously obtained handles, and Cursor-related seams—not only visible root tool menus.

**Outstanding:** current policy/root capability tests after D's shared SDK/task edits. A settings resolver unit test alone does not certify runtime enforcement or model precedence.

### B — Guarded bulk reads and restricted evidence digest

Historically accepted with C. Current regression row: **R-BC1**.

The implementation contract covers local root text-file interception before source reaches the root result, existing selector parsing, bounded alternate reads, abort behavior, and shell-display interception. It does not extend this transport policy indiscriminately to remote/internal URIs, archives, documents, images, or SQLite.

Digest workers receive `evidenceDigest {paths, question}`, use exactly the restricted read/grep/glob/ast_grep/yield profile, cannot discover additional execution capabilities or recursively delegate, and return at most 8,000 UTF-8 bytes to the parent. Capped results retain the original and provide an incompleteness notice/reference. A digest is not an edit anchor.

**Outstanding:** local selectors (raw/open-ended/multirange/delimited), CRLF/final-line counting, permission/missing errors, abort, interception ordering, internal-versus-worker identities, cap boundaries, and real restricted-tool enforcement.

### C — Isolated generation and receipt-only integration

Historically accepted with B. Current regression rows: **R-BC2, R-C**, plus D's integration serialization requirements.

The contract includes `codeWrite {spec, reference, target}` with an acceptance-bearing assignment across public flat/batch and sync/async routes. Invalid references, existing targets, escapes, equal paths, fork/schema conflicts, and incompatible digest requests reject before allocation. Canonical path checks account for real ancestors, Windows drives/case/symlinks, and isolation-relative paths.

Generation workers permit only assigned reference reads, target writes, and yield. Mandatory isolation applies to every codeWrite and autonomous writers; isolation failure cannot fall back to the shared checkout. The receipt is derived from observed filesystem/integration state, not worker prose, and contains exactly kind, target, lines, bytes, sha256, and changesApplied. Invalid outputs and conflicts fail without overwriting the parent; recovery artifacts remain available.

**Outstanding:** current sync/async projections and canonical handles, malformed/empty/fenced/unexpected-file results, path boundaries, PATCH/BRANCH modes, special Git filenames, source separation on failures, conflict handling, and recovery artifact retention.

### D — Durable native task execution and recovery

Partially implemented; acceptance remains incomplete.

Recorded machinery includes versioned native payload parsing, pinned model and policy reconstruction, a common headless native executor, durable queue/claim ownership, checkpoints, operational CLI recovery, heartbeat fencing, cross-process integration locks, durable retained artifacts, and receipts. Native task execution must stay native: no Spotify Portal, new registry, shell-wrapper scheduler, or separate generic plugin framework.

The following bounded observations are marked passed in the matrix:

| Rows | Observation | Limit |
|---|---|---|
| D2.02 | Checkpoint phase dispatch occurs before SDK/new-file preflight | Does not certify all phases/dependencies |
| D2.04, D5.08 | Generated BRANCH recovery integrates retained output with source removed and zero new allocation | PATCH, integrated replay, and competing-edit races still need current evidence |
| D5.02 | Standalone initial BRANCH persists capture before integration | One observed run; not a global timing guarantee |
| D7.01 | Real operational CLI invokes native recovery successfully for generated BRANCH | Not all malformed/legacy/process dispatch cases |
| D8.03 | BRANCH receipt and integrated checkpoint match observed output | Not all public result surfaces/modes |
| T2 | Standalone initial invocation completed assertions at 4,915 ms | Only 85 ms under its 5,000 ms deadline |
| T3 | Recovery-only BRANCH passed its unchanged outer deadline with 26 assertions | No inferred independent stage durations from suite wall time |
| T4 | Cancellation helper preserved exact abort reason and awaited settlement | Actual cancelled CLI recovery remains unrun |
| ALIGN-GIT | Branch path already reuses captured immutable delta | No new optimization or inferred timing win |

## 4. What remains incomplete: acceptance ledger

| Family / rows | Remaining observable contract |
|---|---|
| D1.01–D1.07 | Exact full payload roundtrip; pinned provider/model and validated definition; eight effective policy fields; null optionals; no secret/settings/corpus dump; named failure for unreconstructable dependencies; same non-owning store/root; malformed and legacy rejection |
| D2.01, D2.03, D2.05–D2.10 | Internal flag scope and grandchild fresh-job behavior; explicit integrated replay; retained PATCH; integrating refusal; common executor without extra planning model; canonical identities; dependency failures; real cancellation/resource disposal |
| D3.01–D3.06 | Durable record before worker allocation; runner-only claims/terminal transitions; open/create/claim failure boundaries; durable ID distinct from async ID; recovery independent of live parent callbacks |
| D4.01–D4.05 | Production heartbeat interval; cleanup; independent-runner non-reclaim; failed heartbeat/checkpoint abort; immediate ownership checks; unique concurrent runner identities |
| D5.01, D5.03–D5.07, D5.09–D5.16 | Full phase schema, baseline containment, generated artifact validation, restricted fresh replay, unrestricted reconciliation, explicit integrated replay, pause/cancel gates, uncertain integration truthfulness, fenced failure receipts, crash/reopen, accurate control latency |
| D6.01–D6.08 | Canonical repository lock key; atomic matching ownership; abortable wait; conservative missing/malformed owner handling; safe reaping; integration ordering; retirement/release races; real-process serialization |
| D7.02–D7.03 | Malformed/legacy/integrated/PATCH CLI dispatch and unchanged supported process executor behavior |
| D8.01–D8.02, D8.04–D8.05 | Existing status model and runner authority; failure receipts; terminal lease races; containment across public surfaces |
| T1 | Retained staged initial-generation failure remains failed |
| T5–T6 | Current PATCH timing variants and actual cancelled CLI recovery |
| R-A, R-BC1, R-BC2, R-C, R-GIT, R-OPS, R-QUALITY | Current affected behavior and quality union, not inherited historical passes |
| FULL-S, FULL-F | Complete native success flow and competing-integration failure flow |
| E | Product documentation/Unreleased changes and offline benchmark; optional paid live measurement |
| Z | Final combined acceptance after D and E |

This is a testing/acceptance backlog, not a declaration that all listed source work is missing. Inspect existing focused tests before adding cases. The matrix remains the granular checklist.

## 5. Baseline clarification: separate representation from containment

Approved substantive replacement for the old D.5 categorical sentence:

> Generated task patches remain in job-owned artifacts. Checkpoints may retain baseline data needed for reliable recovery, provided it stays internal and is not automatically projected into model context or ordinary status output.

Three separate questions must stay separate:

1. **Recovery baseline representation:** inherited staged/unstaged/untracked patch data may be inline internally. Presence alone is not a failure.
2. **Generated task delta storage:** generated patches must remain in canonical private job-owned artifacts. Baseline permission is not permission to inline generated deltas everywhere.
3. **Containment:** neither recovery baseline nor generated source may be automatically projected into model context or ordinary status output. Permission to persist is not proof of containment.

The amended matrix now records D5.03 as unverified, leaves D5.04 unverified, and extends D8.05 to recovery-baseline patches and ordinary status. S4/S5 remain historical representation evidence, not leak evidence. Only S4's observation and currency were amended; S5 is unchanged. Experiment sections 1–7 remain unchanged and section 8 records the clarification. Independent review and raw captures were not edited. H0/H1 stay closed with zero timing invocations.

### Historical stop and approved resolution

The matrix ALIGN-STOP evidence cell is:

```text
A0;current roster and git status;owner direct confirmation
```

Only A0 is an index ID. Strict all-reference resolution conflicts with preserving every historical reference and allowing changes only to D5.03/D8.05 and S4.

The user explicitly approved preserving that cell exactly and exempting only its two narrative entries from ID resolution, solely in ALIGN-STOP. A0 and all other references resolved normally. No index entries were invented. The amendment has now passed its original-versus-amended comparison: 79 matrix rows, 32 index rows, preserved headers/IDs/counts/evidence cells, only D5.03/D8.05 and S4 changed, and failures decreased from two to one. T1 remains failed. Exact adopted clause appears in contract and experiment; the old categorical clause is absent from the contract. Experiment sections 1–7 remain an unchanged prefix. These are artifact checks, not runtime containment verification.

### Artifact-only acceptance

Take fresh original parsed snapshots of both TSVs. Parse with `text.trimEnd().split(/\r?\n/).map(line => line.split('\t'))`, keeping headers separate. Matrix rows must have seven cells; index rows six; IDs must be unique. Preserve original row counts/ID sets and all evidence-reference cells. Only D5.03 and D8.05 matrix rows and S4 index row may differ. D5.03/D5.04/D8.05 must be unverified; failures decrease exactly one; all other failures, especially T1, stay unchanged. Exact adopted clause must appear in contract and appended experiment; old categorical clause must disappear from contract. No implementation tests are needed for this amendment.

## 6. Test campaign: ordered, bounded, and evidence-bearing

### Stage 0 — Authorization and isolated baseline

Resolve the artifact amendment blocker first. Then obtain explicit authority for a bounded D verification batch. Record current revision, changed/untracked files, selected contract rows, exact focused command, store/artifact paths, expected result, and stop condition. Consult package rules before any source/test edits.

Use disposable repositories, a dedicated operational store, and dedicated artifact directories. Never let a fixture silently use the host store. Keep the same non-owning store instance/root through initial caller, runner, executor, and CLI where required. Assert caller-owned store remains open. Do not delete inventoried historical residue or unrelated rows. No remote dispatch without separate authorization; no broad bun/node process killing.

### Stage 1 — Recovery correctness without generation-speed coupling

Construct real retained-artifact/checkpoint fixtures so recovery tests do not require initial generation to meet a deadline merely to reach the behavior under test.

| Input phase | Expected result | Negative control |
|---|---|---|
| generated BRANCH/PATCH | Integrate retained output exactly once; no reference reopening or worker/SDK allocation | Missing/foreign/malformed artifact rejects safely |
| integrated | Validate receipt and return without another write, even with source removed | Forged/malformed receipt rejects |
| integrating | Reconciliation refusal with checkpoint/lock/artifact evidence retained | Must not blindly replay or allocate |
| prepared/executing restricted codeWrite | Fresh attempt and fresh isolation; orphan evidence retained | Must not reuse mutable prior environment |
| prepared/executing digest | Replay with exact restricted tool profile | No write/task/discovery expansion |
| interrupted unrestricted work | Reconciliation refusal | No guessed idempotency or automatic side-effect replay |

Explicit integrated-checkpoint replay is essential: a second CLI run with no eligible job does not exercise that contract.

### Stage 2 — Payload, dependency, and storage failures

Exercise full assignments longer than 500 characters, context/recovery structures, pinned provider/model, role aliases, changed ambient configuration, all eight policy fields, and absent optional fields. Assert serialization fidelity instead of checking only schema names.

Missing tools/models, custom in-memory verifiers, callbacks, unsupported fork dependencies, malformed versions, and legacy native rows must fail by name without silently dropping safety dependencies. Inspect redaction using synthetic sentinels, never real secrets.

Test opening, creating, and claiming separately. A store-open negative does not prove create/claim failures block allocation. Observe zero worker launch and no direct fallback. Preserve supported process job dispatch while rejecting native rows on their proper parser path.

### Stage 3 — Lease/control failure injection and cleanup

Use deterministic barriers or targeted fault injection at ownership boundaries rather than sleep-based race hopes. Observe actual store transitions and parent filesystem effects.

- Failed heartbeat/checkpoint write must abort the child and deny integration.
- Lease expiry/replacement immediately before integration must prevent writes.
- Pause/cancel before the gate must yield zero parent mutation.
- During integration, preserve uncertain effects and reconciliation evidence; never fabricate rollback.
- Expiry/replacement before terminal success or failure must prevent unfenced terminal writes.
- SDK/startup resources, timers, and listeners must settle/dispose on success, failure, and cancellation.
- The actual CLI cancellation test must reach integration/cancellation and settle before closing its store. Helper-level success is insufficient.

### Stage 4 — Cross-process integration locks

Use real independent processes/store connections for contention. Test canonical realpath and Windows case handling; include symlink/path variants where supported and report unsupported fixtures explicitly.

A waiting process must abort without modifying the live owner's lock. Missing/malformed metadata must reconcile conservatively. Reaping requires proof of nonlive ownership and a non-integrating checkpoint. Exercise owner replacement while a stale releaser/reaper acts; an old owner must not remove a new owner's lock. Uncertain integrating work retains its lock/evidence rather than being stolen.

### Stage 5 — Containment as a separate matrix

Use two distinct unique sentinel contents: inherited baseline patch text and newly generated source. Exercise successful, failed, asynchronous, and recovered flows. Inspect provider conversion, parent messages, progress, ordinary status, errors, details/results, outputPath, canonical handle resolution, and async completion.

Protected source must not be automatically exposed through parent-facing result surfaces. Internal artifacts/checkpoints must retain the information required for reliable recovery. This distinguishes actual containment from passing by deleting useful recovery data. Do not assume an artifact handle is safe because a receipt preview is safe: check the canonical resolved output route and intended access contract.

Test UTF-8 output limits in bytes, not characters. Confirm truncation includes an honest incomplete notice and recoverable reference. Failure text must not echo arbitrary source-bearing arguments.

### Stage 6 — A/B+C and operational regression union

Run current focused groups for policy/routing/root restrictions; selectors/abort/interception/digest; generation validation/isolation/profiles; receipt-only sync/async/provider/handle paths; PATCH/BRANCH conflict handling and special Git names; gitlink/submodule/nested/baseline behavior; runner/store/CLI/subagent-LSP.

Preserve existing behavior outside autonomous/savings mode. Keep tests full-suite safe: restore spies per test, no mock.module, no placeholder/source-text assertions, and prefer real lifecycle transitions over mocked success narratives.

Then prove two complete flows:

**FULL-S:** autonomous root starts with default-none isolation configuration; direct execution is blocked; digest and codeWrite are delegated; effective isolation is enforced; integration occurs once; durable record completes; parent receives receipt, not source.

**FULL-F:** competing parent edit causes integration failure; target is not overwritten; durable record truthfully fails; retained artifacts are inspectable; failure projections remain bounded and source-safe.

### Stage 7 — Timing only after a grounded hypothesis

T1 remains failed. The later 4,915 ms standalone pass does not supersede staged failure or establish stability. Five-second deadlines are specific fixture contracts, not a new product-wide SLA.

Preserve 5,000 ms initial and recovery stages within the explicit 15,000 ms staged outer allowance. Setup/cleanup allowance cannot be borrowed to make a stage pass. External observation caps and import/suite wall time are different measurements. Abort/reject a failed stage and await owned operations; late callbacks cannot convert timeout into success.

The branch path already reuses its immutable captured delta. Do not implement duplicate-capture removal again. Any further experiment needs explicit authorization, one named hypothesis, scoped phase instrumentation, one measured invocation, raw capture, verdict, and stop condition. Potential phases include SDK startup, isolation preparation, worker execution, delta capture, real Git branch/worktree/apply/stage/commit/removal, integration, and cleanup. A phase duration alone does not prove redundancy.

Preserve the repeated-failure stop: the same focused check failing twice after targeted repair stops the batch with exact evidence. Do not reset permission by renaming tests, moving a timeout, or rerunning until lucky.

### Stage 8 — E and final Z

Only after D acceptance, E updates existing product documentation and package Unreleased changelog and implements/verifies the benchmark. This recovery entry is not completion of E.

Offline benchmark must use independent direct/delegated fixture workspaces, >350-line read and 100-line generation parity/source-separation/receipt assertions. Unmeasured token/cost savings remain null. Paid live runs require explicit authorization; report frontier versus worker/total usage, cache tokens, cost, retries, failed outcomes, and comparable median latency. Do not promise an automatic 90% saving.

Final behavior command from repository root (recorded requirement, **not executed here**):

```sh
bun test packages/coding-agent/test/fusion-savings.test.ts packages/coding-agent/test/agent-session-fusion-savings.test.ts packages/coding-agent/test/system-prompt-fusion.test.ts packages/coding-agent/test/session/autonomous-fusion.test.ts packages/coding-agent/test/integration/test_delegated_shunting.test.ts packages/coding-agent/test/operational/runner.test.ts packages/coding-agent/test/fusion-io-policy.test.ts packages/coding-agent/test/operational/native-task-executor.test.ts packages/coding-agent/test/benchmark-token-savings.test.ts
```

Additional gates from `packages/coding-agent/`, separately:

```sh
bun check
bun run lint
bun scripts/benchmark-token-savings.ts --offline --output <absolute-temp-path>/native-savings-benchmark.json
```

From repository root, separately:

```sh
bun packages/coding-agent/src/cli.ts --smoke-test
git diff --check
```

These are future contract commands, not a claim that every benchmark file already exists. Resolve prerequisites before running. No full monorepo suite/build. Run the shared final gate once after integration, then only failed/affected reruns under the stop policy. Keep changes uncommitted unless explicitly asked.

## 7. Evidence record for each authorized batch

Capture: requirement IDs; owner and authorization; current revision and relevant dirty/untracked baseline; exact command and cwd; isolated store/artifact roots; raw capture path; exit status; assertions/counts if available; phase timings versus outer observation limits; pass/fail/unverified verdict; scope limitations; changed files; cleanup/settlement facts; next bounded action or stop reason.

Never reconstruct raw evidence from this page. Never claim a code audit from source-shape observations. A failure should identify the smallest violated contract, not trigger an unrelated redesign. Repairs should modify source at the causal boundary and add/adjust behavior tests without weakening the original requirement.

## 8. Recommended next batch and boundaries

1. Completed: explicit narrow ALIGN-STOP exception approval.
2. Completed: four-artifact baseline amendment and read-only invariant verification.
3. First-pass coverage inventory completed below; seek bounded test-execution authorization before running anything.
4. Begin with retained-artifact recovery correctness, not a timing rerun.
5. Progress through safety/containment/regressions, then timing under its separate experiment rules.
6. Accept D only on complete current evidence; then E and Z.

No new agent ownership is assigned by this document. Historical NativeSavingsOwner/Main roles do not prove those agents are alive in a new session. Preserve a single implementation owner and satisfy repository collaboration rules before assigning code work. Linear is optional under the historical local exception; do not introduce a coordination service as a prerequisite.

The Task Hub work record is `C:/dev/Vaults/Design-and-Building/Daily Todos/Open/oh-my-pk-native-savings-recovery-acceptance.md`. It tracks this acceptance campaign as blocked/pending authorization rather than active implementation. The existing project record links both the task and this canonical repository entry.

## 9. Authorized read-only coverage inventory and first test-batch proposal

### Current checkout observation

Read-only `git rev-parse HEAD` returned `dffe5704488f0b58e65480a6792a2d7e4f380eb8`. `git status --short --branch` reported main, 0 staged, 30 modified tracked and 12 untracked entries. The difference from the historical 29/11 counts includes the wiki index and this new entry. No production/test files were changed by this continuation. Existing untracked native executor/payload/lock/integration/delegated-I/O modules and tests must remain in any later acceptance inventory.

### Source observations, not runtime acceptance

- `src/operational/native-task-executor.ts:107–128`: injected store/absolute artifact-root checks; production 10,000 ms heartbeat default; explicit integrated/integrating dispatch before SDK reconstruction.
- `:297–350`: preparation/generated checkpoints retain baseline; root/nested generated patches and raw results/output are written as artifacts. This confirms representation paths, not public-surface containment.
- `:364–445`: generated recovery validates artifact membership, nested paths, worker identity/outcome and baseline containment, reconstructs a retained result and calls integration without entering the new SDK branch.

All relative source/test paths in this section are under `packages/coding-agent/`. No acceptance row was promoted based on these reads.

### Existing native test inventory

`test/operational/native-task-executor.test.ts` currently contains these relevant declaration groups. Rows outside the first proposed batch are declaration-level inventory only; do not assume all assertions satisfy the named contracts.

| Lines | Existing case/group | Requirement mapping and remaining qualification |
|---|---|---|
| 495, 519, 538 | Payload roundtrip, pinned discovery, malformed/legacy rows | D1/D2; full policy/dependency/redaction fidelity still needs assertion mapping |
| 552–641 | Six malformed retained-artifact/baseline variants | D5.04, D2.05; bodies inspected: foreign/cross-job/traversal/missing/foreign-baseline/worker-failure rejection, retained raw result, no target/no allocation, no generated sentinel in error; not symlink or all leak surfaces |
| 643–685 | Explicit integrated receipt replay | D2.03/D5.10/D7.02; body inspected: source removed, target retained, real CLI, exact result, zero internal/child SDK sessions |
| 687–707 | Integrating reconciliation refusal | D2.06/D5.11; body inspected: failed state/error and zero child sessions; does not assert internal session count or full lock/artifact retention |
| 710–778 | Initial, retained recovery, staged paths parameterized for PATCH/BRANCH | D5.02/D5.08/D5.09/T1–T5; only retained pair proposed now; initial/staged timing excluded |
| 781–796 | Actual cancelled branch CLI recovery | D2.10/D5.13/T6; body inspected: abort after observed integration, queued/integrating state and target existence. Not executed; helper cancellation semantics need observation |
| 799, 833 | External pause/cancel, live heartbeat independent runner | D4/D5.12; declaration inventory only |
| 873, 888, 918 | Conflict receipt, fresh restricted executing isolation, unrestricted/unavailable pins | D5/D8; prepared codeWrite parity is not established by an executing-case name |
| 943, 967, 991 | Owner replacement, controls during integration, fenced checkpoint failure | D4/D5/D8; exact expiry/terminal coverage still needs inspection |
| 1003, 1057, 1501 | Connection locks, stale state variants, real child-process contender | D6; cross-process abort waiting/reaper races remain unproven |
| 1104, 1173, 1212 | Real crash/reopen, store-open failure, full success/conflict provider flow | D3/D5.15/FULL-S/FULL-F; create/claim failure is not covered merely by store-open negative |
| 1354, 1372–1413 | CLI dispatch, forged integrated receipts | D7/D2.03; forged body inspected: invalid empty/wrong-target receipt fails and no SDK allocation |
| 1416, 1468, 1558, 1579 | Prepared/executing digest, terminal ownership changes, submodule, async handles | D5.06/D8.04/R-GIT/D8.05; declaration inventory, not current passes or full containment |

Fixture inspection at `:72–164` shows a temporary agent directory, dedicated operational DB/artifact root, assertion that default store resolves to that same temporary path, tracked owned attempts, session disposal, restored spies/environment, and store close after settled attempts. This is a source-level safety observation, not proof setup/teardown succeeds. `:338–443` constructs retained PATCH/BRANCH artifacts using real Git/worktree helpers without worker generation. CLI receives the injected store. Recovery asserts exact receipt/hash/content and integrated checkpoint. Its later no-eligible-job CLI invocation is not explicit integrated replay; the separate 643 case supplies that coverage.

The normal regression files listed in Z are present except **`test/benchmark-token-savings.test.ts` and `scripts/benchmark-token-savings.ts`, which are missing**. This is direct file-presence evidence that the E benchmark prerequisite is not delivered. Operational runner/store/CLI/process-executor tests and crash/lock fixture files exist. Other A/B+C gate files were checked for presence, not audited or executed.

### First bounded D recovery batch — AUTHORIZED AND PASSED

One local invocation, six expected selected cases (the retained pattern selects PATCH and BRANCH separately):

```sh
bun test packages/coding-agent/test/operational/native-task-executor.test.ts --test-name-pattern "rejects malformed retained artifacts and baselines before allocating recovery workers|returns integrated receipt without reference validation, SDK creation or another write|requires reconciliation for integrating checkpoints without launching a model|recovers retained (patch|branch) artifacts without an initial model request|rejects forged integrated receipts before reconstructing an SDK"
```

Run from `C:/dev/infra/oh-my-pk` only after explicit authorization. Keep native fixture deadlines unchanged; allow a separately disclosed external observation window sufficient for imports/setup, not longer test stages. Capture exact selected pass/fail/skip counts and full raw output. A regex selection mismatch is inconclusive, not coverage. No initial-generation, staged timing, actual cancellation, real-process contention, or full-flow case is included in this first batch.

Acceptance for this batch is limited to current observations of the six cases and their inspected assertions. Even six passes do not accept all D2/D5/D7 rows, prove containment, or complete D. Record residual assertion gaps instead of promoting whole families. Stop after the single invocation on failure, timeout, missing output or selection mismatch; propose a separately authorized causal repair rather than edit tests, retry, or weaken deadlines automatically. Normal fixture-owned temporary teardown is part of test execution; host-residue/manual cleanup remains prohibited.

The user subsequently selected **Run six cases once**. The exact command above was executed once locally and succeeded: **6 pass, 38 filtered out, 0 fail, 108 expect() calls**, Bun v1.3.14 (0d9b296a). Suite time 41.68s; tool wall 42.01s; external observation cap 120s. No fixture deadline changed. Aggregate output does not expose individual case durations; suite time is not evidence about any 5,000ms stage. T1 remains failed and untouched.

Raw result: `artifact://13`. Durable exact stdout copy under R: `native-savings-recovery-six-case-2026-09-10.stdout.txt`. The six selected cases match the filter and inspected declarations. Current evidence now supports retained PATCH/BRANCH recovery, explicit integrated replay, malformed/forged receipt rejection, malformed retained-artifact rejection, and integrating refusal within their actual assertions. Complete integrating lock/artifact retention remains unverified; the corresponding combined checklist item stays open.

The task record marks three additional items complete: temporary non-host fixture setup, retained PATCH/BRANCH recovery, and integrated replay/receipt rejection. No broad matrix family was promoted. Historical evidence captures remain unchanged; this is a new bounded result, not a rewrite of the prior failures. No repair, retry, production/test edit, remote dispatch, host cleanup, or additional agent occurred. The authorized invocation is consumed; further execution requires a new bounded approval. D/E/Z and the full goal remain incomplete.

## 10. Delegated regression repairs — implemented, runtime unverified (2026-09-10)

The user authorized implementation and CodeGraph blast-radius analysis, including **creating** the previously missing native replay fixture branch. This supersedes the earlier repair-authorization blocker only; it is **not** the separate authorization to execute tests or package quality commands. One source implementation owner made the scoped changes below, preserving unrelated dirty work. No commit or host operational-data query/cleanup occurred.

Changed source/test files:
- `packages/coding-agent/test/integration/test_delegated_shunting.test.ts`: supported directory/profile snapshot/reset and exact default-store/artifact-root guards; separate native replay session tracking/guard/hook; extended existing digest and two-writer assertions. Existing temporary prefix and deadlines retained.
- `packages/coding-agent/src/task/delegated-output.ts`: extracted one shared `projectEvidenceDigest` UTF-8 cap operation with the named oversized-reference error; existing projector signature and non-digest behavior retained.
- `packages/coding-agent/src/task/index.ts`: parent successful digest publication now starts from retained full output and final artifact reference before writing canonical output/metadata; authenticated native replay retains context while still rejecting nested tasks/schema, with unchanged lane-policy processing.

**Static evidence only:** repair-only diffs inspected against pre-edit snapshots; `git diff --check` passed with no diagnostics. Initial/post-source-edit state: HEAD `dffe5704488f0b58e65480a6792a2d7e4f380eb8`, `main...origin/main`, 0 staged / 30 unstaged tracked / 12 untracked. The cap file was already untracked, so its repair-only no-index diff was inspected separately. This section and the existing external task record are the only documentation updates for this slice.

**CodeGraph follow-through:** original projector and shape-validator impact queries traced native executor, operational CLI, public task adapter and regression paths. Depth-1 affected analysis found 26 dependents / 21 test files; broad depth-5 traversal reached 4,072 dependents and was treated as conservative reachability, not a mandate to execute unrelated suites. Direct source inspection confirmed native WeakMap authentication/registration order, `task.batch=false`, unchanged projector API, async artifact-registry resolution and assignment-only public adapter compatibility. After edits, `codegraph sync .` processed 3 modified files / 160 nodes (1.8s reported processing, 16.51s wall); `codegraph impact projectEvidenceDigest -p . -d 3 -j` found 12 nodes / 17 edges. `codegraph status .` reported **up to date**, 4,482 files / 105,796 nodes / 397,411 edges, node:sqlite WAL. No CodeGraph warnings were reported.

New evidence directory **R2** (distinct from historical R): `C:/Users/prest/.ompk/agent/sessions/--C--dev-infra-oh-my-pk--/2026-09-10T21-47-02-597Z_01a08d49-da45-7000-a0a1-be6c4c2a52f9/local/`. Full implementation/authorization/gate record: `R2/native-regression-repair-implementation-evidence.txt`. Blast-radius assessment and raw command captures: `native-regression-blast-radius-assessment.txt`, `native-regression-codegraph-direct.txt`, `native-regression-codegraph-broad.txt`, `native-repair-codegraph-helper-impact.txt`, `native-repair-codegraph-sync.txt`, `native-repair-codegraph-status.txt`. Repair-only full diffs: `native-repair-full-{test_delegated_shunting.test.ts,delegated-output.ts,index.ts}.txt`; whitespace result: `native-repair-whitespace-check.txt`. Original full diff captures remain `artifact://42`, `artifact://43`, `artifact://44`; initial/final dirty captures `artifact://9` / `artifact://62`.

### Separate execution authorization still required

Proposed command, **not executed**, cwd `C:/dev/infra/oh-my-pk`:

```sh
bun test packages/coding-agent/test/integration/test_delegated_shunting.test.ts --test-name-pattern "enforces digest capabilities, cites missing evidence, and caps UTF-8 output with a retained artifact|isolates two autonomous writers separately with default none and integrates after generation"
```

Static case inventory remains 29 (13 ordinary cases plus parameterized groups of 4+4+2+2+4); the two exact selected titles each occur once. Expected result is **2 pass / 27 filtered / 0 fail**, not an observed result. External cap must be 120s, digest default deadline and writer 30,000ms unchanged. Stop after one invocation on failure, timeout or selection mismatch; no retry or automatic repair. No runtime exit/counts/assertion totals/duration/stdout exist for this repair yet. `bun check` and `bun run lint` are **unrun** and require explicit authorization; no wider suite or timing execution is included.

Historical **27-pass/2-fail** delegated evidence is preserved, not superseded by static inspection. **T1 remains failed; D remains unaccepted; E/Z, containment and other open acceptance/quality gaps remain open.** Even two future passes complete only this bounded repair slice, not the full goal.

**Independent static review follow-through:** review caught one assertion-placement defect: shared context is in the provider's system-prompt blocks, not message history. The same implementation owner corrected the assertion to `expect(context.systemPrompt?.join("\n")).toContain(sharedContext)` while preserving message-based target/result detection. Reviewer inspected that final correction and closed the finding; no outstanding confirmed repair-only findings remain. This is static closure, not a passing test. The prior full fixture diff is pre-review; this assertion is its sole subsequent source delta. Evidence: `R2/native-regression-repair-review-closure.txt`.

After that correction, `git diff --check` again passed with no diagnostics; CodeGraph synced 1 modified file / 37 nodes (953ms processing / 2.20s wall) and final status remained **up to date**, now 397,412 edges with file/node counts unchanged. No warnings. Final captures: `R2/native-repair-final-whitespace-check.txt`, `R2/native-repair-codegraph-final-sync.txt`, `R2/native-repair-codegraph-final-status.txt`. Runtime and quality gates remain unrun.

## 11. Authorized two-case rerun — 1 pass / 1 fail, stopped (2026-09-10)

The user authorized the remaining focused testing action. It was explicitly interpreted as the two-test run only, not package quality gates. Ran **once**, cwd `C:/dev/infra/oh-my-pk`, external cap **120 seconds**, existing test deadlines unchanged:

```sh
bun test packages/coding-agent/test/integration/test_delegated_shunting.test.ts --test-name-pattern "enforces digest capabilities, cites missing evidence, and caps UTF-8 output with a retained artifact|isolates two autonomous writers separately with default none and integrates after generation"
```

Baseline: HEAD `dffe5704488f0b58e65480a6792a2d7e4f380eb8`, `main...origin/main`, 0 staged / 30 unstaged tracked / 12 untracked. Source repair files remain the three listed in section 10; **no source edits occurred in this execution batch**. Only evidence and the existing wiki/task records were updated.

**Actual result:** Bun 1.3.14; exit **1**; **1 pass / 1 fail / 27 filtered out**, **73 expect() calls**, exactly **2 tests across 1 file**. Suite duration **17.08s**, external wall **17.468s** versus 120s cap. No timeout or selection mismatch. The failing two-writer case took 2,431.42ms and stopped at `test_delegated_shunting.test.ts:856:26`: `expect(generatedCount).toBe(2)` — **expected 2, received 4**.

Contract classification from this run only:
- **Digest case passed:** bounded valid UTF-8, artifact/footer/canonical file/metadata/handle agreement, full retained output and pure-helper boundary assertions completed.
- **Fixture isolation guards passed** for both selected cases; teardown reported no restoration failure. No host fallback or outside-TempDir output was reported. No host operational queries/cleanup were performed.
- **Writer case remains failed:** it reached the count assertion after checking two successful/applied results, two generation child sessions and two native sessions. Earlier forbidden-shape and shared-system-prompt assertions did not fail. The later target-content and stored-payload assertions were **not reached**. The count mismatch's root cause is not established by this run.

Full raw output was read and retained, not reconstructed: `artifact://75`, absolute path `C:/Users/prest/.ompk/agent/sessions/--C--dev-infra-oh-my-pk--/2026-09-10T21-47-02-597Z_01a08d49-da45-7000-a0a1-be6c4c2a52f9/75.bash-original.log`. R2 files: `native-repair-focused-run-result.txt` (complete bounded evidence), `native-repair-focused-run-tool-result.json` (exact command/cwd/cap/result), `native-repair-focused-run-raw-capture.json` (full raw text), `native-repair-run-head.txt`, `native-repair-run-dirty-state.txt`; full baseline status also `artifact://72`.

**Stopped after failure. No retry, repair, broader investigation, typecheck or lint was run.** `bun check` and `bun run lint` remain unrun. Historical 27-pass/2-fail and T1 captures remain unchanged; this is a new bounded result, not replacement history. **T1 remains failed, D remains unaccepted, E/Z/full goal and wider containment/regression/quality gaps remain open.** Further diagnosis/repair requires renewed scope authorization.

