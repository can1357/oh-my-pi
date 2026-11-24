# 0056. Consult a saved session read-only; subagent progress is opt-in and measured

Status: proposed
Date: 2026-11-13
Area: tools

Research: [subagent-tools](../research/subagent-tools.md). Ledger gap 9.

## Context

- Upstream OMPv1 (can1357/oh-my-pi `c308970263`, paths under `packages/coding-agent/src`, written `up:`) has two subagent features omp2 lacks. `/seance` consults a saved session: it resolves a session id or path "without opening its writer" (`up:task/seance.ts:110`), forks the source (`:32`, `fork: { sourceFile }`) and runs the bundled `seance` agent with only `read, grep, glob` (`up:prompts/agents/seance.md:4`) and everything else off (`up:task/seance-policy.ts:6`). The **completion probe** asks a running subagent, on a 2, 5, 10, 30, 60 minute backoff (`up:task/completion-probe.ts:37`), for `{"pct","stage","watch"}` through a side turn that reuses the live prompt cache; it is on by default (`up:task/settings.ts:543`) for the main agent's direct subagents in the interactive TUI (`completion-probe.ts:45`).
- **The read is safe by construction.** `Journal::scan` reads committed entries "without taking the writer lock or truncating a torn tail" (`crates/journal/src/lib.rs:186`); `Journal::open` takes the writer lock (`lib.rs:124`). The saved model is recoverable: `msg.assistant.start` records `model`, `provider` and `route` (`crates/journal/src/data.rs:479`); the role name is not saved. The picker already derives the selected branch (`live_chain`, `crates/driver/src/sessions.rs:269`) and indexes sessions by id (`SessionIndex::get`, `sessions.rs:423`; `StoredSession.id` is "conventionally the `.oms` file stem", 243).
- **The existing fork is not a consult primitive.** `Kernel::fork` (`crates/driver/src/headless/kernel.rs:3451`) and the `fork` launch option (`select_journal_path`, `kernel.rs:3851`, which also makes `session`, `fork`, `continue` and `ephemeral` mutually exclusive) write the copy into `sessions_dir` as `<ULID>.oms`. A copy there is visible to `--continue` (`newest_session`, `kernel.rs:3774`, which takes the newest `.oms` in the directory) and to the `/resume` picker (`SessionIndex` scans `.oms` files recursively, `sessions.rs:455-463`), and opening it creates `<fork>.oms.lock`, a sidecar that is "deliberately never deleted" (`lib.rs:461-464`). A crash would leave a consult as a resumable session.
- **A private root already exists as a pattern.** `EphemeralJournal` removes a whole private root, journal plus blob, local and temp namespace, on drop (`kernel.rs:246-262`); the root is `<temp>/omp-session-<ULID>/` created atomically with `create_dir` (`kernel.rs:3903-3910`). Nothing sweeps roots left by a crash.
- **Blobs live next to the journal.** `default_blob_store` opens `<journal parent>/blobs` (`crates/session/src/session.rs:351`). A copy placed elsewhere cannot resolve the source's blobs unless they are copied. The relocate flow does exactly that: `copy_journal_blobs` (`crates/journal/src/gc.rs:383`, fail-closed if a rooted blob is missing or corrupt) called at `crates/app/src/chat_control.rs:2506`.
- **A path is not confined today.** `resolve_session_path` (`kernel.rs:3530`) returns any path with more than one component or an extension unchanged.
- **The liveness probe must not create files.** `WriterLock::acquire` opens `<journal>.lock` with `create(true)` (`lib.rs:523-535`), so using it to test a source would create the sidecar next to a journal that may not have one.
- **The child registry gets `goal` back.** With `KernelOptions.tools` (`kernel.rs:153`) the registry is restricted (`kernel.rs:2721`) and then `install_goal_contract` (`kernel.rs:2417`, called at `2702` and `2728`) re-registers the hidden `goal` declaration. `goal` is `Presentation::Hidden` and mounts only on a user's goal engagement (`crates/agent/src/roster.rs` header), so the wire roster is the three tools but the registry holds four.
- **Opening a session has side effects.** `kernel.rs:2864-2866`: `Session::open` then `recover_process_disappearance` (`crates/session/src/exit_diagnostics.rs:311`), which can append a record for a journal that did not end cleanly; composition then journals the agent class, the trust decision and the prompt facts.
- **No model-facing room.** `ChildRequest` is `#[serde(deny_unknown_fields)]` with `task, name, agent, effort, outputSchema, schemaMode, isolated` (`crates/tools/src/task.rs:49-50`). A `sourceSession` or `model` field would change the `task` tool's schema; ADR 0024 rule 2 and the additive-only rule forbid that.
- `history://` cannot stand in: live sessions only ("Session `{base}` is not live.", `crates/envd/src/tool_url.rs:126-130`).
- `/btw` is the nearest precedent for a chat command that runs a child: a fresh ephemeral, tool-less kernel with the transcript pasted in as text (`crates/app/src/chat_services/session_ops.rs:249-275`; trait `crates/chat/src/overlays/services.rs:1408`; panel `overlays/side.rs:1`). It does not reuse the live session's prompt cache or tool roster.
- v1 sessions are `.jsonl` transcripts (`crates/driver/src/v1_import/sessions.rs:152`) imported into journals by the existing flow (`crates/app/src/session_import.rs`; `import_session`, `v1_import/sessions.rs:1084`; converter `crates/app/src/session_import/convert/omp1.rs`).
- Error style: `thiserror` enums with typed sources, no string-payload variants (ADR 0035).

## Decision

**D1. `/seance` is a user command, not a `task` field.** `/seance [session id|path] [--model selector]` is a chat command. It does not touch the `task` tool, the roster or any schema. The model cannot consult a session; only the user can.

**D2. The source is confined, read, and never locked or created against.**
- *Selector grammar.* A selector is one token. A token with no path separator and no `.` is an **id**: a full session id (the journal stem, a ULID as `Ulid::generate` writes it, `kernel.rs:3405`) or a prefix of at least 8 characters, matched case-insensitively against `SessionIndex` ids; exactly one match is required. A token with a separator or the `.oms` extension is a **path**.
- *Confinement.* A path is canonicalized and must lie under the canonical `sessions_dir` by component-wise `starts_with` (not string prefix). Anything else is refused. A cross-project consult is not supported (O5).
- *v1 detection.* A `.jsonl` extension, or a path with no `.oms` extension, is a v1 or foreign transcript: refused with an error that names the existing import flow. /seance does not import.
- *Live source.* A new additive read-only `Journal::is_live(path)` in `omp-journal` opens an **existing** `<journal>.lock` read-only without `create` and tries a shared non-blocking lock: no lock file means not live; `WouldBlock` means live; success releases at once. A live source (including the session in use) is **refused**: "the session is open elsewhere; consult it after it ends". A snapshot consult of a live session is not offered (O6).
- *Read.* Validation and the saved model come from `Journal::scan`. The saved model is the `model`/`provider` of the last `msg.assistant.start` on the selected branch (`live_chain`).
- *Model semantics.* The saved concrete model if it resolves and has configured auth; `--model` overrides it; with neither, an error that says to pass `--model`. The role is not recovered because the journal does not store it.

**D3. The consult runs on a private copy outside `sessions_dir`.**
- A private root `<temp>/omp-consult-<ULID>/` is created atomically with `create_dir` (the `EphemeralJournal` pattern, `kernel.rs:3903-3910`); the owner holds an exclusive lock on `<root>/owner.lock` for its lifetime.
- Into the root go the journal bytes (`session.oms`), the session-local tree (the copy `Kernel::fork` and `select_journal_path` already do) and the blobs the source reaches, through `copy_journal_blobs` into `<root>/blobs` (the relocate precedent, `chat_control.rs:2478-2512`). A missing or corrupt blob fails the consult closed.
- The child is composed with `session: Some(<root>/session.oms)` and `sessions_dir: Some(<root>)`, `tools: Some([read, grep, glob])`, the seance prompt through `PromptOverrides` (`kernel.rs:47`), and no MCP, extensions, skills or spawns. Neither the launch `fork` option nor `Kernel::fork` is used (both write into `sessions_dir`; the launch options are also exclusive).
- A guard removes the root on panel close, error or panic, like `EphemeralJournal`. At chat service start, a sweep removes `omp-consult-*` roots whose `owner.lock` can be taken (the owner is gone). Nothing in `sessions_dir` is created or changed, so `--continue` and `/resume` never see a consult, and no `.lock` sidecar remains.
- The consult's answer shows in the side panel `/btw` uses.

**D4. The consult child's tools.** The wire roster is exactly `read`, `grep`, `glob`. The registry also holds the hidden `goal` declaration that `install_goal_contract` adds; the consult offers no way to engage a goal, so it is never mounted. The test asserts the wire roster and that `goal` is not mounted; it does not assert a three-tool registry.

**D5. A custom agent never shadows the consult.** The seance prompt is bundled data, not a user-overridable role.

**D6. The completion probe is proposed, not adopted.** It ships only if a measurement shows a fork-based probe reuses the child's prompt cache. The probe works on a private copy of the child's journal made the same way as D3 (journal path from `ChildResult.session_path`); the child's own journal is never opened for write. It is **off by default** (upstream's default is on), depth 0 only (`SV_TASK_RECURSION_DEPTH`, `crates/driver/src/subagent/settings.rs:101`), interactive host only. A probe of a live child necessarily copies a live journal, so it uses the snapshot path D2 declines for the user command; the copy takes the committed prefix, and a torn tail is truncated on the copy only.

**D7. Probe output is data.** One JSON line, `pct` 0-100, `stage` at most 80 characters, `watch` at most 200 characters, parsed by a pure function; an unparseable reply is dropped, never shown.

## Options rejected

- **Port upstream as written (`sourceSession`, `model` and `solutionSpace` on `task`).** Changes an existing tool's schema (hard constraint; ADR 0024 rule 2). The model-facing form is recorded as O3.
- **Open the source with `KernelOptions.session`.** Opens a writer on the source and appends to it.
- **`Kernel::fork` or the launch `fork` option.** Writes into `sessions_dir`: visible to `--continue` and the picker, leaves a never-deleted lock sidecar, and cannot be combined with `ephemeral`.
- **Fork into `sessions_dir` and delete on close.** A crash leaves a resumable session; a private root cannot.
- **`WriterLock::acquire` as the liveness test.** It creates the lock file.
- **Read through `history://`.** Live sessions only.
- **Build the probe on `/btw`'s fresh kernel.** Pays for the whole child context uncached on every tick.
- **Probe on by default, as upstream.** The cost is unmeasured.

## Consequences

- A user can ask a past session why it did something without resuming it. The source journal and `sessions_dir` are unchanged afterwards, including no new files.
- Each consult copies the source's blob set. `copy_journal_blobs` retains the whole branch DAG, including abandoned-branch media (`gc.rs:372-379`), so a media-heavy session costs disk and time for the life of the panel.
- A live session cannot be consulted. The user waits, or uses `/fork`.
- The probe may be dropped if the measurement shows no cache reuse; D6 says so in advance.

## Slices

One PR each. `cl_seance_enabled` (bool, default false) gates S1-S4; `sv_task_completion_probe` (bool, default false) gates P1-P3. Convar prefixes follow ADR 0012. No `cap-*` feature: no new heavy dependency. Errors are one `thiserror` enum, `ConsultError`, with typed fields and `#[source]`: `EmptySelector`, `BadSelector`, `NotFound`, `Ambiguous { matches }`, `OutsideSessions { path }`, `ForeignTranscript { path }` (v1 or non-`.oms`), `Live { path }`, `Unreadable { #[source] JournalError }`, `NoSavedModel`, `ModelUnavailable { model }`, `BlobCopy { #[source] GcError }`, `Io { #[from] }`.

| Slice | Content | Acceptance | Tests |
|---|---|---|---|
| S0 | `Journal::is_live(path)` in `omp-journal` (additive) | Read-only; creates no file; true while a writer holds the journal | Held by `Journal::open` in the test then dropped; absent lock file means false and the directory listing is unchanged; a lock file left by a finished writer means false |
| S1 | Source resolution (`omp-driver`, new `consult` module): `resolve_source(sessions_dir, selector, model_override) -> Result<ConsultSource, ConsultError>`, `ConsultSource { id, path, model }` | Grammar, confinement, v1 detection, live refusal and saved model as in D2 | Directory listing (names, sizes, mtimes, lock files) identical before and after; live source refused with `Live`; torn tail not truncated; `../` and symlink out of `sessions_dir` refused; ambiguous prefix and unknown id; `.jsonl` gives `ForeignTranscript`; abandoned-branch model ignored; journal with no `msg.assistant.start` gives `NoSavedModel` |
| S2 | Private root, copy, guard, sweep | Root contains journal, local tree and reachable blobs; removed on drop and on panic; sweep removes dead roots only | Blob-bearing journal resolves its blob from the copy; a missing blob fails closed with `BlobCopy`; a root whose `owner.lock` is held is not swept; a dead root is; `sessions_dir` untouched |
| S3 | Read-only child | Wire roster exactly `read, grep, glob`; `goal` not mounted; no MCP, extensions, skills, spawns | Roster assertion; source hash unchanged after a full consult; a write attempt is refused |
| S4 | `/seance [selector] [--model]` (`omp-chat` command, `omp-app` service like `btw`) | Answer in the side panel; absent when the convar is off; each `ConsultError` shown as a one-line message | Parse table; panel shows the answer; command not offered when off; `--continue` and the picker list nothing new during a consult |
| P1 | Measurement spike | One copy-based probe of a running child records input tokens, cached tokens and cost, **with controls** (below) | A number, not a test. If cached tokens are about zero on equal prefixes, stop and mark D6 rejected |
| P2 | Estimator (pure) | Parse one JSON line to `pct, stage, watch`; backoff as a pure function | Parser table with oversized and malformed input; schedule test; abort cancels an in-flight probe |
| P3 | Wiring | Depth 0 and interactive only; estimate shown on the hub row | No probe at depth 1 or when off; child journal hash unchanged |

**P1 controls.** The copy's first request differs from the child's in two ways that can hide or fake a cache hit: `recover_process_disappearance` (`exit_diagnostics.rs:311`) may append a record, and composition journals class, trust and prompt facts (`kernel.rs:2864-2900`). The spike therefore (1) serializes the system prompt and tool declarations of the child's last request and of the copy's first request and compares their hashes; a cache figure is reported only when the hashes are equal, and otherwise the result is "prefix mismatch", not a cost; (2) runs once against a source that ended cleanly at a turn boundary (no recovery record) and once against a mid-turn copy, so the recovery effect is measured, not assumed; (3) takes cached-token counts from the provider's response for both requests and reports the copy's against the child's own next request.

## Open questions

- **O2.** Does a copy-based probe share the child's prompt cache? The code cannot settle it. Recommendation: P1, with the controls above, answers it before any P2 work.
- **O3.** Should the model be able to consult a session (a `task@2` revision with `sourceSession`)? Recommendation: no. It is a schema change, and the user command covers the need.
- **O4.** Where is the estimate shown, and does it need an additive job DOM property? Recommendation: the `/hub` row, with one additive property.
- **O5.** Cross-project consult (upstream's `includeGlobal`)? Recommendation: not in v1; the user switches to the project.
- **O6.** Offer a snapshot consult of a live session? Recommendation: no for the user command (refuse); the probe path (D6) is the only snapshot user.

Settled by the code, not open: a side turn on a live child is possible without opening its journal for write; the saved model is the concrete model in the journal (D2); the consult fork is deleted on panel close and swept after a crash (D3, formerly O1); the registry holds `goal` (D4).

## Acceptance tests

1. A consult leaves the source journal's bytes and the `sessions_dir` listing (names, sizes, modification times, lock files) identical, including when the source has a torn tail. A live source is refused and the listing is still identical.
2. The consult child's wire roster is exactly `read`, `grep`, `glob`, and `goal` is not mounted.
3. With `cl_seance_enabled` off, `/seance` is not offered and the `task` schema is byte-identical to today's.
4. A session with no resolvable saved model fails with the `--model` message.
5. A path outside `sessions_dir`, through `..` or a symlink, is refused.
6. After a consult, `--continue` and the `/resume` picker show nothing new, and the private root is gone; after a simulated crash the next start's sweep removes it.
7. The probe never starts at depth 1, on a non-interactive host, or with the convar off. An unparseable probe reply shows nothing.

## Status in omp

Status: Partially implemented.

- S0 (#647): `Journal::is_live(path) -> Result<bool, JournalError>` in `crates/journal/src/lib.rs` (backed by the private `WriterLock::is_held`). Tests in `crates/journal/tests/journal.rs` (`is_live_*`).
- S1–S3 (#692, #694, #695): `crates/driver/src/consult.rs`. `resolve_source`, `prepare_root`, `sweep`, `child_options`, and the bundled `SEANCE_PROMPT`. The wire roster is `read`, `grep`, `glob`.
- S4: `cl_seance_enabled` (bool, default false) in `crates/chat/src/commands/session.rs`. The slash palette omits `/seance` while the convar is off; a typed `/seance` returns one line that tells the operator to set it. `parse_seance_args` accepts `[selector] [--model]`. A missing selector posts usage (`SEANCE_USAGE`) and the host prints that line. The resume picker stays closed. `AppServices::seance` (`crates/app/src/chat_services/session_ops.rs`) resolves the source, copies it with `prepare_root`, composes `child_options`, and streams the answer through `SidePanel::btw`. Each `ConsultError` is shown as one line. `AppServices::new` sweeps abandoned `omp-consult-*` roots. A held private root stays outside `sessions_dir`, so `SessionIndex::list` gains no row (`a_held_private_root_adds_nothing_the_picker_lists`).
- The `task` schema is unchanged.
- P1–P3 are unbuilt. O2, whether a copy reuses the child's prompt cache, is unverified. There is no consult-specific session picker.

## Review (EGM, 2026-11-13)

Design critic and readiness findings, and what changed:
- The first draft forked into `sessions_dir`. That is visible to `--continue` and the picker and leaves a permanent lock sidecar. Changed: a private root outside `sessions_dir`, guard plus startup sweep (D3). The launch options are mutually exclusive, so the consult composes with an explicit session path on its own copy.
- The liveness probe could not use `WriterLock::acquire` (it creates the file). Changed: a new read-only `Journal::is_live` (S0); a live source is refused (D2).
- Paths were not confined and blobs would not resolve from a copy elsewhere. Changed: confinement to `sessions_dir`, and blob copy through `copy_journal_blobs`, fail closed (D2, D3).
- The S2 test was wrong: `install_goal_contract` re-adds `goal`. Changed: assert the wire roster; `goal` is hidden and never mounted (D4, S3).
- P1 was confounded by recovery and prompt facts. Changed: prefix-hash equality, a clean and a mid-turn source, provider cache counts (P1 controls).
- Slice 1 was under-specified. Changed: id grammar, `ConsultError` taxonomy (ADR 0035), model semantics from the selected branch, v1 detection, the API and fixtures (S1).
- The importer citation was checked: `crates/app/src/session_import/convert/omp1.rs`, `crates/app/src/session_import.rs` and `crates/driver/src/v1_import/sessions.rs` all exist; the flow is now cited by its entry points.
- Confirmed by the reviewers: a consult never writes the source journal (`scan` and `decode_committed` are lock-free and non-truncating; the copy only reads).

## Upstream origin and license

Draws on `up:slash-commands/seance.ts`, `task/seance.ts`, `task/seance-policy.ts`, `prompts/agents/seance.md`, `task/completion-probe.ts`, `task/settings.ts`, `task/executor.ts`. License: MIT, "Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc." (upstream `LICENSE`). omp2 re-implements the behaviour in Rust; no TypeScript is carried over. If the seance prompt text is copied, keep the notice and list it in `THIRD-PARTY-NOTICES.txt`.

## References

ADR 0006 (host owns policy; the child runs host-side with a bounded registry); ADR 0012 (convars); ADR 0024 (roster, schemas latched); ADR 0035 (error discipline); ADR 0036 (no second runtime); ADR 0049 (no vendor code in core); `crates/journal/src/lib.rs`; `crates/journal/src/gc.rs`; `crates/driver/src/headless/kernel.rs`; `crates/driver/src/sessions.rs`; `crates/app/src/chat_control.rs`; `crates/app/src/chat_services/session_ops.rs`; research note [subagent-tools](../research/subagent-tools.md).
