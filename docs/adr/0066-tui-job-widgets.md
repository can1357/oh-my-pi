# 0066. Job output in `/hub`: a model-free newest-line view of shell jobs first; widgets, charts and model specs deferred

Status: Proposed 2026-11-14; machine-reviewed (EGM, 3 rounds), not owner-approved
Date: 2026-11-13 (revised 2026-11-14)
Area: interface

Research: [docs/research/tui-job-widgets.md](../research/tui-job-widgets.md) (Gap 12 of the upstream gap closure, "TUI: job widgets and auto-graph charts"; this record is that gap's first slice, so the file keeps the gap's slug). Upstream pin `c308970263` (v18.20.0); omp2 base `origin/omp2 9cb6fd638`. Citations: `upstream:` is the OMPv1 pin; bare paths are omp2. Nothing was built or run for this record. It was reviewed in three rounds by fresh-context reviewers with no human in the loop (the Elephant-Goldfish Model, "EGM", [ADR 0053](0053-independent-verdicts.md) D7); see "What the review changed".

## Terms

- **Shell job**: a `bash` call that detached into envd, either because it asked for `async` or because it ran past the shell's auto-background threshold. It is a `<job kind="tool">` in the session DOM whose work is an envd **named process**.
- **Named process**: a process envd owns, addressed by a name and a **generation**, a counter that changes on every restart. Its output goes to a bounded log on disk with absolute byte offsets.
- **`/hub`**: the job supervisor overlay (`AgentHub` in `crates/chat/src/overlays/hub.rs`). Its **roster** is the job list; its **inspector** is the detail panel for the selected job, shown on the `Agents` tab (`Section::Agents`).
- **`Services`**: the trait through which `omp-chat` reads application data; the app implements it (`crates/chat/src/overlays/services.rs:1234`).
- **Stream slot**: envd's per-connection count of open streaming requests (the `stream_fanout` quota, `crates/envd/src/policy.rs:1859`).
- **TSP / Tern**: the native surface protocol and terminal of [ADR 0041](0041-native-surfaces-over-tsp.md). A **surface** here always means a TSP surface; UI places are called overlays, panels or the status band.

## Context

### The problem

A shell job runs in the background and the user cannot see what it is doing. `/hub` lists the job with its status and age; the inspector shows kind, owner, times and the raw detached payload, but no output (`crates/chat/src/overlays/hub.rs:794-905`). The only way to see output is to ask the model to poll the job.

### What OMPv1 does

- Upstream draws live "job widgets": a cheap model writes a declarative spec per job, a deterministic runtime applies it to each new output line, and renderers draw charts, bars and meters in the `wait` card, the HUD jobs pill and the jobs sheet (`upstream:packages/tui/src/tools/job-widget.ts:1-13`; switch `async.widgets`, default on, `upstream:docs/settings.md:654`).
- Its model-free fallback view is the newest non-empty output line plus line counts (`upstream:packages/coding-agent/src/job-widgets/runtime.ts:639-708`). The newest line stands for a job's activity only for a command's own output, never for a subagent's tool results (`upstream:packages/coding-agent/src/job-widgets/runtime.ts:313-320`); that rule fixed a leak of fetched text into widgets (`upstream:packages/coding-agent/CHANGELOG.md:829`).
- Auto-graph adds charts under numeric tables in answers: about 12,000 lines plus a 16.5 KB rubric (`upstream:packages/tui/src/charts/chart-plan.ts:1-8`).

### What omp2 has

- **Shell jobs.** `bash` with `async` detaches into an envd named process; so does a foreground run past `sv_shell_auto_background_threshold_ms`, default 60 s (`crates/tools/src/shell.rs:716-746`, `crates/envd/src/exec_settings/shell.rs:55-58`, `:111-118`, `crates/envd/src/tool_shell.rs:332-381`). The call settles with `{"kind":"detached","id":…,"job":JobRef}` (`crates/agent/src/dispatch.rs:3427-3433`). The session folds that into a `<job kind="tool">` whose `data` prop holds the payload (`crates/session/src/components/jobs.rs:318-366`). The owner sits at `data.job.owner` as `{"kind":"named_process","name":…,"generation":…}`; serde tags the variants `named_process` and `agent_loop` (`crates/tool/src/lib.rs:2088-2103`, `:2206-2217`). `JobRow` carries `data` as JSON text and `status` (`crates/chat/src/overlays/hub.rs:92-109`).
- **Other jobs.** The dispatcher detaches any call still running at its 30 s blocking limit into a job with an `agent_loop` owner (`crates/agent/src/dispatch.rs:122`, `:1817-1822`, `:2037-2045`, `:3435-3451`; `crates/driver/src/headless/kernel.rs:2966`). Because 30 s is less than the shell's 60 s default, a foreground `bash` may become such a job instead of a shell job. Whether the shell's foreground wait is shortened by the invocation deadline the kernel sends (`crates/driver/src/headless/kernel.rs:1283`) was not established. Named `process` jobs have the bare name as id, no `data` and no generation (`crates/driver/src/subagent/hub.rs:800-835`), and envd rejects an attach whose generation is not current (`crates/envd/src/exec.rs:2218-2235`).
- **The process log.** Offsets are absolute; the log rotates at 25 MiB; reads are capped at 2 MiB; `read_after` clamps a cursor into `[start, end]` (`crates/envd/src/process_log.rs:10-12`, `:148-175`).
- **`attach_output`.** It reads a backlog after a cursor; the backlog chunk's `log_offset` is `max(cursor, start)` (`crates/envd/src/exec.rs:2078-2125`). Then it subscribes to live output.
  - The server sends `OutputAttached` (`log_start_offset`, `log_end_offset`, `rotated`), the backlog frames, one `ProcessState`, then live events (`crates/envd/src/server/dispatch.rs:1081-1120`).
  - New output is appended to the log before it is broadcast, under separate locks, so an attach in between sees the same bytes in its backlog and as its first live event (`crates/envd/src/exec.rs:4022-4050`).
  - Each attach adds a subscriber that is pruned only on the next broadcast (`crates/envd/src/exec.rs:2109`, `:4079-4084`).
  - It reserves a stream slot. An explicit cancel of a `ProcessAttach` request does not release that slot; only connection close or a server-side finish does (`crates/envd/src/server/connection.rs:896-918` against `:786-801` and `:1020-1031`). Owner connections do not enforce the slot limit, because their quota account has no host key (`crates/envd/src/policy.rs:1863-1884`; `crates/envd/src/server/identity.rs:35-42`). Chat's `AppServices` uses the composed kernel's environment client (`crates/app/src/session_runner.rs:62`).
  - The client's `ProcessAttachment::cancel` sends a cancel frame, but dropping the attachment only unregisters it locally (`crates/env/src/client.rs:3556-3578`, `:3871-3873`). Attaching to an exited generation works (`crates/app/tests/it/envd_contract.rs:3114`).
- **Existing callers of `attach_output`** use it for lifecycle waits (`max_bytes: 1`) or for whole-log and cursor reads (`crates/app/src/ps_cmd.rs:121-130`, `:198-208`; `crates/driver/src/subagent/hub.rs:921-931`, `:1214-1225`, `:1352-1362`; `crates/py/src/bindings.rs:3985-3997`). None follows a tail.
- **Chat plumbing.** `Services` methods default to `ServiceError::Unavailable`; streaming feeds return a receiver plus a cancel sender, as `LoginFlow` does (`crates/chat/src/overlays/services.rs:22-47`, `:463-475`). `ServiceError::Failed(Str)` is a lint-allowed type-erasure seam (`crates/chat/src/overlays/services.rs:29-32`). `AppServices` holds the `EnvClient` and a runtime handle (`crates/app/src/chat_services/mod.rs:85-103`).
- **`/hub` itself.** Panels get `PanelCx`, which carries `services`, only in `open`; `tick(now)` gets the host clock, and `next_wake()` gets nothing (`crates/chat/src/overlays/mod.rs:262-274`, `:325-334`). `AgentView` shows the polling pattern: `tick` stores the next deadline, and `next_wake` returns the earlier of it and the UI's (`crates/chat/src/overlays/hub.rs:1865-1883`). `AgentHub` rebuilds its whole tree in `rebuild`, which every refresh, selection, resize and tab change calls (`crates/chat/src/overlays/hub.rs:412-417`, `:996-1054`). The inspector shows at 96 columns or more, or with narrow details toggled (`crates/chat/src/overlays/hub.rs:39`, `:609-617`, `:1009-1030`). Its body is a list of single-row components (each a one-line `<text truncate>` or a `<row>`), and its scroll and clip arithmetic count one component as one row (`crates/chat/src/overlays/hub.rs:893-905`, `:1265-1270`).
- **ANSI ingress.** The TUI's single ANSI ingress is `omp_tui::decompose`, which emits escape-free text runs to a `RichSink` and treats a lone CR as a line break (`crates/tui/src/rich.rs:140-150`, `:177-213`; exported at `crates/tui/src/lib.rs:120-123`).
- **Convars.** Chat presentation convars are `cl_*` in `crates/chat/src/settings.rs` (block at `:37`; tasks-tab entries carry `ui.tab`, `ui.group`, `ui.label`, `:395-407`). `/hub` reads one at open with `cx.con.get_typed::<bool>` (`crates/chat/src/overlays/hub.rs:361-364`).
- **The real-PTY harness** runs the real `omp chat` against a scripted fake provider (`ScriptedGateway::start_with_scripts`, `gateway.release(n)`), with the debug socket, a pinned Unicode charset, a workspace trust grant, `--approval-mode` and `--envd-idle-timeout` flags, and a hermetic `config.cfg` written only when absent. It resizes with the PTY winsize plus the debug `resize` op and checks terminal restoration (`crates/e2e/tests/p7_tui.rs:73-85`, `:244-268`, `:667`, `:740-790`, `:975`, `:1059-1100`, `:1187-1190`).

### Rules that bind

- Additive only: no change to the `<job>`/`<result>` schema, existing tools, convars or the role vocabulary (`crates/catalog/src/selection.rs:172-178`). Pre-release rule: no aliases or later renames, so names say what they do (`AGENTS.md` Conventions).
- Deterministic: no model in this plan.
- Layers: client protocol helpers in `omp-env`, host behaviour in `omp-envd`, presentation in `omp-chat`, composition in `omp-app` (`AGENTS.md` Architecture and Conventions).
- TUI doctrine: external text decomposed once where it enters, no escapes stored, no hardcoded glyphs or colours (`AGENTS.md:440-480`). TUI changes get a real-PTY proof: input, resize, clean quit (`AGENTS.md:566`, `:783`, `:821-822`). Done means compiled, wired, exercised (`AGENTS.md:564-565`).
- Errors follow [ADR 0035](0035-rust-for-the-engine.md): `thiserror` enums with typed sources, no string payloads in libraries.

## Decision

**D1. Scope: one slice.** This record commits to S1 only: the newest output line of the selected running shell job, shown in the `/hub` inspector. Guaranteed coverage is `bash` with `async: true`. Foreground runs are covered only when the shell's own auto-background detaches them before the dispatcher's 30 s limit, which is unverified (O5). Widgets (sparklines, meters, a rule runtime, a status-band glance), dispatcher-detached calls, named `process` jobs, model-written specs and table charts are deferred. The alternative, a full widget plan in this record, is open question O1 (see "Open questions for the owner").

**D2. Gate.** `cl_hub_job_output` (bool, default `false`, flags `archive`, meta `ui.tab: "tasks"`, `ui.group: "Jobs"`, `ui.label: "Job Output in Hub"`), declared in `crates/chat/src/settings.rs`. The name says what S1 ships; a widget gate belongs to the widget record.
- `/hub` reads it once in `open`, as it reads `cl_task_show_resolved_model_badge`. With it off, `/hub` renders exactly as today and opens no feed.
- No `legacy.path`: upstream's `async.widgets` covers widgets omp2 does not have, so importing it would claim more than S1 does.
- No `cap-*` feature: S1 adds no dependency.
- When to default it on is O2.

**D3. A tail helper in `omp-env`.** `EnvClient::tail_output(TailOutput { name, generation, history_bytes }) -> Result<OutputTail, ClientError>`, with `history_bytes` clamped to `1..=64 KiB` (S1 uses 8 KiB). It makes two attaches; offsets below are `log_offset`/`sequence` values, which envd reports as absolute log byte offsets.

1. **Live.** `attach_output { after_sequence: u64::MAX, max_bytes: 1 }`. `read_after` clamps the cursor to the log end, so the backlog is empty. `OutputAttached` gives the log start S and the end E at the moment of subscription, and live events follow from E. This is the same "follow from the end" use the `process` tool makes, without a separate `list_processes` call that could race the subscription.
2. **History.** Let H = max(S, E − `history_bytes`), and C = H − 1 if H > S, else H. If E = C (an empty log), skip this step, because envd reads `max_bytes: 0` as its 2 MiB default (`crates/envd/src/exec.rs:2083-2087`). Otherwise send `attach_output { after_sequence: C, max_bytes: E − C }`, read until its `ProcessState` frame, then cancel it. Reading from C, one byte early, lets the reader see whether H starts a line. Because the history is capped at E, the two attaches abut at E; envd's append-before-broadcast order can still repeat bytes around E, and the reader drops them by offset (D5).
3. `OutputTail::next_event()` yields `History { offset, data, aligned_at_start: bool }` once (`offset` = C; `aligned_at_start` is true only when C = 0), then live `Output { offset, data }` and `State(ProcessState)` in order. Live events that arrive while history is read wait in the live attachment's client stream.

Both attachments are held in a guard whose `Drop` calls `ProcessAttachment::cancel`, so dropping `OutputTail`, or the future that builds it, at any point sends the cancel frames. A failure in step 2 cancels step 1 before returning the error. Errors are the existing `ClientError` variants. There is no new protocol message and no envd change.

Accepted costs:
- Each opened tail leaves at most two dead subscribers in envd, pruned at that process's next output or state change.
- Each tail adds two stream-slot reservations that envd's `ProcessAttach` cancel path does not give back until the connection closes. This is not enforced on the owner connection chat uses (Context); the envd fix is O6.

**D4. The feed: `Services::job_output`.** A defaulted method (default `Unavailable`):

```rust
fn job_output(&self, target: JobOutputTarget) -> ServiceResult<JobOutputFeed>;
pub struct JobOutputTarget { pub name: Str, pub generation: u64 }
pub struct JobOutputFeed { pub window: Arc<parking_lot::Mutex<OutputWindow>>, pub cancel: flume::Sender<()> }
```

`AppServices` spawns one task on its runtime. The task drives `tail_output(history_bytes: 8 KiB)` and folds every event into the shared `OutputWindow` (D5), mapping `omp-env` types to the window's own calls. The task ends, dropping the tail, when `cancel` fires or is dropped, or after the process reaches a terminal state.

A shared window replaces the `LoginFlow` receiver form for one reason. A per-event channel would either grow with the job's output rate between one-second ticks or, if bounded, apply backpressure to envd's unbounded subscriber channel (`crates/envd/src/exec.rs:2081`). Folding in the task bounds memory whatever the output rate.

An error is stored as `ServiceError::Failed`, the existing type-erasure seam, rendered once by the inspector. An attach rejected because the process or generation no longer exists is stored as the state `Gone`, not as an error.

**D5. `OutputWindow`: the newest-line model, in `omp-chat`.** A plain type in `crates/chat/src/overlays/job_output.rs`, unit-tested without I/O. `omp-chat` does not depend on `omp-env`, so its API is chat-owned:

```rust
impl OutputWindow {
    pub fn new() -> Self;
    pub fn history(&mut self, offset: u64, data: &[u8], aligned_at_start: bool);
    pub fn push(&mut self, offset: u64, data: &[u8]);
    pub fn set_state(&mut self, state: JobOutputState);
    pub fn fail(&mut self, error: ServiceError);
    pub fn line(&self) -> Option<&str>;   // newest non-empty line, escape-free
    pub fn revision(&self) -> u64;
}
pub enum JobOutputState { Starting, Running, Exited { code: Option<i32> }, Stopped, Failed, Gone }
```

The app maps `ProcessState` onto it: `STARTING` to `Starting`; `READY` and `RUNNING` to `Running`; `EXITED` to `Exited` with `ExecStatusMsg.exit_code`; `STOPPED` and `FAILED` likewise; an unknown generation or process to `Gone` (`crates/proto/proto/omp/env/v1/env.proto:443-451`, `:550-558`).

Rules, all on absolute offsets:
- **Continuity.** The window tracks `next`, the offset of the next expected byte. Bytes below `next` are dropped. A chunk starting above `next` is a gap: the window marks itself `skipped` and treats the join as mid-line.
- **Leading fragment.** `history` reads its first byte as the one before H (D3 step 2). If that byte is LF or CR, or `aligned_at_start`, the first line is whole. Otherwise everything up to the first LF or CR is a fragment and is dropped. If no LF or CR arrives in the whole history, the window stays "inside a dropped line" until the first terminator in live output.
- **Terminators.** LF and CR both end a line, as in `decompose`; a CR at the end of a chunk is held, so a CRLF split across chunks counts once. Blank lines are skipped, so `line()` is the newest non-empty line, as upstream's fallback shows.
- **Decoding.** UTF-8 sequences split across chunks are carried to the next chunk; invalid bytes decode lossily (O7 records which helper does this). Each completed line is passed once through `omp_tui::decompose` with a sink that keeps only text runs, so the window stores no escapes and the inspector draws plain text. The still-open trailing line is decomposed the same way whenever it changes, so prompts and progress bars show.
- **Bound.** The open line keeps at most its newest 4 KiB, cut at a character boundary. Memory per window stays under 16 KiB.
- **Revision.** `revision` changes only when `line()`, the state or `skipped` changes.

**D6. The inspector "Output" rows.** For the selected job, `/hub` wants a feed when all hold: the gate is on; the inspector is visible (`Section::Agents`, and the split layout or narrow details); `JobRow.status` is `running`; and `data` parses to a `named_process` owner. Anything else wants no feed: malformed or absent `data`, an `agent_loop` owner, a subagent job, or a `process` job.

- **Reconcile.** `AgentHub` keeps `Option<Arc<dyn Services>>` (set in `open`, `None` in `with_rows`) and at most one feed, keyed by job id, name and generation. `rebuild` ends with `sync_feed()`, which computes the wanted key. If it differs from the held key, the held feed is cancelled at once, and the new one opens on the first `tick` at which the wanted key has been unchanged for 300 ms, so moving the cursor through the roster does not open a feed per row. Every path that changes the selection, the inspector's visibility or the job's status goes through `rebuild`: refresh, select, filter and sort, resize, tab switch and the narrow-details toggle. Closing `/hub` drops the hub and its feed. An open `/hub` therefore holds at most one feed, and a closed one none.
- **Repaint.** While a feed is wanted or held, `tick` stores `now + 1 s` as its next check, and `next_wake` returns the earlier of that and `self.ui.next_wake()`; a newly wanted feed asks for an immediate tick. `tick` locks the window, and rebuilds and returns `true` only when `revision` changed. So `/hub` repaints at most once a second and only on change.
- **Rows.** Three rows after "elapsed" and before "Data", each a single one-row component as every inspector entry is: a blank `<text>`, the heading `Output` (`<text bold fg=accent>`), and one `<text truncate>` holding `line()`, or a muted placeholder. The placeholder is `no output yet`, or `no complete line yet` while inside a dropped line. When the window is not plain running, the heading row appends a muted state: `skipped`, `exited 0`, `stopped`, `failed`, `gone`, or `unavailable: <error>`. The section adds three rows to an inspector of about twenty and keeps the scroll arithmetic exact.
- **Roster.** The roster rows do not change: their status is the DOM's, and the live process state shows only in the Output heading.
- **TSP.** `/hub` is an overlay, and overlays are cell-rendered while a surface is live (ADR 0041 decision 10). No TSP node is involved.

## Rejected options

| Option | Why not |
|---|---|
| Keep the S1-S5 widget plan in this record | Round 2 found two blockers and eleven majors in it (status-band polling with no owner, `<spark>` body against the markup parser, an undefined rule data model, a speculative sparkline caller). Recorded as O1. |
| A multi-line output window in the inspector (`<pre>` with the bash card's ten-line tail) | The inspector counts one component as one row (`crates/chat/src/overlays/hub.rs:893-905`); a multi-line `<pre>` breaks its scroll and clip arithmetic, and ten lines push the newest line below the fold at 30 rows. Removed in round 3. |
| Probe, follow and retry on growth (round-2 D3) | Up to four attaches, a growth race and an untestable retry; live-at-end plus capped history abuts at E with no retry. |
| Poll with a fresh attach every second | Every attach adds a subscriber and a stream slot; a quiet job would pile up dead subscribers (`crates/envd/src/exec.rs:2109`, `:4079-4084`). |
| A per-event receiver instead of a shared window | Grows with output rate between ticks, or backpressures envd's unbounded subscriber channel (D4). |
| Store ANSI text and decompose at paint | The doctrine stores no escapes; S1 decomposes each line once in the window and draws plain text. |
| Compose the tail inside `AppServices` | Client protocol helpers belong in `omp-env`; `AppServices` only adapts. |
| Migrate the existing `attach_output` callers to `tail_output` | They wait for lifecycle events or read whole or cursor ranges; none tails (Context). |
| Read the DOM `<result>` stream | Shell jobs never stream into it after detach, and it keeps only the first 64 KiB (`crates/agent/src/dispatch.rs:1048-1085`). |
| Show a "quiet for Ns" timer and a rate | The log has no timestamps, so a timer after `/hub` opens is a lower bound that reads wrong after a reopen; cut in round 3. |
| Name the gate `cl_job_widgets` | S1 ships no widget; the pre-release rule forbids renaming it later. |
| Ship S1 with no gate | The gap-closure brief requires a default-off gate until the acceptance tests pass. |

## Slices

**S1. Newest output line of the selected running shell job in the `/hub` inspector.**
- **Scope:**
  - `cl_hub_job_output` in `crates/chat/src/settings.rs`.
  - `EnvClient::tail_output`, `TailOutput`, `OutputTail` and the cancel-on-drop guard in `crates/env/src/client.rs`.
  - `Services::job_output`, `JobOutputTarget`, `JobOutputFeed` in `crates/chat/src/overlays/services.rs`.
  - `OutputWindow`, `JobOutputState` in `crates/chat/src/overlays/job_output.rs`.
  - `AppServices::job_output` and its task in `crates/app/src/chat_services/mod.rs`.
  - `sync_feed`, the tick and wake changes and the three inspector rows in `crates/chat/src/overlays/hub.rs`.
- **Unit tests, `crates/chat/src/overlays/job_output.rs`:**
  - `overlap_below_next_is_dropped`
  - `gap_marks_skipped_and_joins_mid_line`
  - `history_starting_after_a_terminator_keeps_its_first_line`
  - `history_starting_mid_line_drops_the_fragment`
  - `history_without_terminator_stays_inside_the_dropped_line`
  - `crlf_split_across_chunks_counts_once`
  - `lone_cr_redraw_shows_the_newest_segment`
  - `utf8_split_across_chunks_decodes_once`
  - `escapes_never_reach_the_stored_line`
  - `open_line_keeps_its_newest_4_kib_on_a_char_boundary`
  - `blank_lines_do_not_replace_the_newest_line`
  - `revision_changes_only_with_line_state_or_skipped`
- **Unit tests, `crates/chat/src/overlays/hub.rs`** (fake `Services` recording opens and cancels; host-clock `Duration`s passed to `tick`):
  - `gate_off_opens_no_feed_and_renders_unchanged`
  - `running_named_process_job_opens_one_feed_after_300ms`
  - `malformed_data_agent_loop_subagent_and_process_jobs_open_no_feed`
  - `completed_job_opens_no_feed`
  - `selection_change_cancels_then_reopens`
  - `rapid_selection_moves_open_one_feed`
  - `refresh_reorder_keeps_the_feed_for_the_same_job`
  - `resize_below_96_columns_cancels_the_feed`
  - `narrow_details_toggle_and_tab_switch_reconcile_the_feed`
  - `closing_hub_cancels_the_feed`
  - `output_rows_keep_scroll_arithmetic_exact_at_20_rows`
  - `tick_rebuilds_only_on_revision_change`
  - `unavailable_and_gone_render_in_the_heading`
- **Unit tests, `crates/app/src/chat_services/`:**
  - `feed_task_folds_history_then_live_into_the_window`
  - `feed_task_stops_and_drops_the_tail_when_cancel_is_dropped`
  - `feed_task_maps_process_states`
- **Client tests, `crates/env/tests/client.rs`** (its scripted transport, `crates/env/tests/client.rs:39-95`):
  - `tail_output_sends_live_then_capped_history_attach`
  - `dropping_output_tail_sends_both_cancel_frames`
  - `history_failure_cancels_the_live_attach`
- **Crate integration, `crates/app/tests/it/envd_contract.rs`** (real envd, beside the existing `attach_output` cases at `:3078-3205`):
  - `tail_output_history_ends_at_the_live_start`
  - `tail_output_reads_an_exited_generation`
  - `tail_output_rejects_a_stale_generation`
- **Real PTY, `crates/e2e/tests/p7_tui.rs`: `chat_tui_hub_shows_live_job_output_through_resize_and_clean_quit`.** Built like `chat_tui_drives_real_pty_tools_interrupt_resize_and_clean_quit`: `ScriptedGateway::start_with_scripts`, `trust_workspace`, `--approval-mode` and `--envd-idle-timeout` as that case passes them.
  1. Before spawn, write `<scratch>/home/.o2/config.cfg` with `cl_startup_check_update 0` and `cl_hub_job_output 1`.
  2. Spawn on a 40×120 PTY.
  3. Script 1 makes one `bash` call with `async: true` and the command `printf 'live-%s\n' one; while [ ! -e go ]; do sleep 0.1; done; printf 'live-%s\n' two; sleep 60`. Script 2 answers the detached result with text. The command text contains neither `live-one` nor `live-two`, so only output can match.
  4. After the turn settles, type `/hub` Enter and select the job.
  5. In the inspector (the columns right of the split divider), wait for the row under `Output` to read `live-one`, and check that `live-two` is absent.
  6. Create `<project>/go`; wait for that row to read `live-two`.
  7. Resize to 30×90 (process winsize plus the debug `resize` op) and wait for the repaint without the inspector.
  8. Resize back to 40×120 and wait for the row to read `live-two` again; this proves the feed reopened and read history.
  9. `C-c C-c`; `assert_restored`.
- **Acceptance:** gate on, the selected running shell job's newest output line appears in the inspector and updates while `/hub` is open; gate off, the existing `/hub` tests and all P7 cases pass unchanged; no feed exists while the inspector is hidden or `/hub` is closed.
- **Gate:** `cl_hub_job_output`, default off. **Depends on:** none.
- **Verify:** `just test-pkg omp-env`, `just test-pkg omp-chat`, `just test-pkg omp-app`, `just e2e-p7`, `just lint`.

## Deferred work (not designed here)

Each item needs its own record or an amendment once S1 has run. The notes keep what review established, so later design starts from checked facts.

- **Sparkline and `<spark>`.** A tag with a body must go through the raw-body branch of the markup parser, not `is_leaf_tag`, which drops the body (`crates/tui/src/markup.rs:523-552`, `:579-582`). `dom!` needs a `spark => Spark;` entry in `for_each_component!` (`crates/vocab/src/lib.rs:238-270`). Colour cannot be "as `Progress`", which paints theme tokens directly and ignores `fg` (`crates/tui/src/components/progress.rs:100-106`). Two block ramps are hardcoded today and would move to a charset ramp: `trend_bar` in `omp usage` (`crates/app/src/usage_cmd.rs:350-364`) and the live voice meter (`crates/chat/src/overlays/live.rs:667`). The TSP `chart` kind exists on the wire with no schema or builder (`crates/tui/src/tsp/wire.rs:108`).
- **A multi-line output view.** It needs the inspector to account rows per component (`crates/chat/src/overlays/hub.rs:893-905`) and a row budget.
- **Status-band glance.** The band is not a panel and has no `tick` (`crates/chat/src/status_band.rs:1994-2000`). A glance there needs an owner in the chat actor, a cadence and a budget, and it would end S1's "no feed without `/hub`".
- **Rule-driven views for known commands.** Start from `omp-minimizer`'s deterministic `cargo` and `pytest` patterns (`crates/minimizer/src/filters/cargo.rs:130-160`, `crates/minimizer/src/filters/python.rs`) as small typed extractors. The command text is not on the `<job>` (`crates/tools/src/shell.rs:1062-1088`).
- **Dispatcher-detached calls** (`agent_loop` owner). Their DOM text is a 64 KiB head, and showing other tools' text as activity would reintroduce upstream's fetched-text leak.
- **Named `process` jobs** need a generation (O3).
- **Model-written specs** (upstream's author with a `widget` role, which omp2 lacks, `crates/catalog/src/selection.rs:175-178`) and **table charts**.

## Upstream origin and license

S1 ports no upstream code. It follows upstream's model-free fallback, the newest non-empty line (`upstream:packages/coding-agent/src/job-widgets/runtime.ts:697-708`). Upstream's `LICENSE` is MIT (copyright Mario Zechner, Can Bölük, Stencil Labs, Inc.; `upstream:LICENSE:1-5`). A later port records its origin in its own record.

## Consequences

- A user can see the newest output line of a background `async` shell job in `/hub` without asking the model; foreground runs depend on O5.
- An open `/hub` holds at most one feed (two envd attachments while history is read, then one), and a closed one none.
- envd's stream-slot counter on chat's connection grows by two per feed opened, without effect on an owner connection, until O6 is fixed.
- `omp-env` gains a reusable tail-and-follow helper for named processes.
- Upstream's widgets, glance and charts stay absent.

## Open questions for the owner

- **O1. Scope.** This record cuts to S1. The alternative is a full widget plan here: a rule runtime, a sparkline, a status-band glance and model specs. Recommendation: S1 now; decide on widgets after S1 has been used, starting from "Deferred work".
- **O2. Default.** When does `cl_hub_job_output` default on? Recommendation: after S1's tests pass in CI for one release and the owner has used it.
- **O3. Named `process` jobs.** Add a generation prop to their `<job>` (a schema change) or a name-only lookup to `EnvClient` (additive)? Recommendation: the lookup.
- **O4. `widget` role**, if model specs are ever built: a new role or an alias of `smol`? Recommendation: the alias.
- **O5. Foreground coverage.** Does a foreground `bash` reach envd as a named process (the shell's auto-background, possibly shortened by the invocation deadline at `crates/driver/src/headless/kernel.rs:1283`), or does the dispatcher's 30 s limit detach it first as an `agent_loop` job? Recommendation: settle it with a P3 detached-jobs case before S1 merges, and state the answer in this record.
- **O6. envd slot release.** Cancelling a `ProcessAttach` request does not release its stream slot (`crates/envd/src/server/connection.rs:910-913`; the `DataStream` arm at `:914-917` does). Recommendation: a one-line `omp-envd` fix with its own test at the envd seam, as a separate change; S1 does not depend on it on owner connections.
- **O7. UTF-8 carry helper.** `AGENTS.md` asks for `xutf` for UTF-8 handling. No chunk-carry decoder was found in `xutf` 1.6.0 (its `read` module is a strict `BufRead` decoder), and `OutputStream::decode` uses the standard library (`crates/agent/src/dispatch.rs:999-1016`). Recommendation: implement S1's carry in `OutputWindow` with `xutf` if a suitable API exists, else follow `OutputStream::decode` and record the exception in the S1 PR.

## What the review changed

### Round 1 (2026-11-13; findings as recorded in `docs/adr/STATUS.md` row 0066)

- **No real-PTY proof per slice.** Confirmed: `AGENTS.md:566`, `:783`, `:821-822`; the 2026-11-13 slices named only unit and snapshot tests. Changed: every slice got a `crates/e2e/tests/p7_tui.rs` case (input, resize, `C-c C-c`, `assert_restored`, `crates/e2e/tests/p7_tui.rs:975`). After round 2, S1's case is the only one.
- **Sparkline ramp API and `<spark>` tag path unspecified.** Confirmed: one sentence in the old D2; `crates/tui/src/markup.rs:1074-1330` registers tags; no series prop in `crates/vocab/src/lib.rs:36-38`. Changed in round 1: a full D6 spec. Round 2 found that spec wrong (S-02, S-13, S-17), so it now survives only as the deferred notes. Kept from round 1: upstream's mapping draws a constant positive series at the top block (`upstream:packages/tui/src/components/sparkline.ts:29-43`), not the lowest as the first draft's test said.
- **Output tail and chip detail surface unspecified.** Confirmed: the DOM `<result>` holds only the first 64 KiB (`crates/agent/src/dispatch.rs:107`, `:1048-1085`); shell jobs never stream into it after detach (`crates/tools/src/shell.rs:716-746`, `crates/envd/src/tool_shell.rs:373-381`); the chip has no detail surface (`crates/chat/src/status_band.rs:1994-2000`). Changed: the tail comes from envd's process log (round 2 respecified how, D3-D5); the chip idea was dropped.
- **S1 dead code until S3.** Confirmed: upstream's fallback has no spark (`upstream:packages/coding-agent/src/job-widgets/runtime.ts:671-693`). Changed in round 1: the sparkline moved behind the job view. Round 2 dropped it from the committed plan.
- **TSP lowering (coordinator note on ADR 0041).** Confirmed: `crates/chat/src/tsp.rs:836-850`; `chart`/`meter` kinds at `crates/tui/src/tsp/wire.rs:108-109`; overlays are cell-rendered while a surface is live (ADR 0041 decision 10). Changed: D6 states that `/hub` sends no TSP node; the `chart` lowering is deferred (S-17).
- **Corrected against this tree.** `sv_job_widgets` became `cl_job_widgets` (`crates/chat/src/settings.rs:37`, `:407`). Area `ui` became `interface`.

### Round 2 (2026-11-14; four fresh-context reviewers plus a synthesizer, 2 blockers, 13 majors, 6 minors)

Every finding was checked in this tree. Scope decision: **cut to S1** (zoom-out's recommendation) and record the larger plan as O1. The cut resolves S-01, S-02, S-09 to S-14 and parts of S-17 by removing the designs they faulted. The checked facts are kept in "Deferred work" so a later design starts from them.

- **S-01 (blocker) chip glance needs polling with `/hub` closed.** Confirmed: the status band is not a panel and has no `tick` (`crates/chat/src/status_band.rs:1994-2000`; `Panel::tick` at `crates/chat/src/overlays/hub.rs:1349`); the hub is created per open (`crates/chat/src/overlays/hub.rs:343`). Resolved: the glance is deferred; S1 holds no attachment without `/hub` (D6) and the Consequences now say so.
- **S-02 (blocker) `<spark>` body vs the leaf-tag rule.** Confirmed: leaf tags finish with an empty body (`crates/tui/src/markup.rs:579-582`); body tags use the raw-body branch (`crates/tui/src/markup.rs:523-552`). Resolved: the sparkline is deferred, and the correct path is in the deferred notes.
- **S-03 `job_output` not implementable; polling leaks subscribers.** Confirmed: each attach pushes a subscriber (`crates/envd/src/exec.rs:2109`), pruned only on broadcast (`:4079-4084`); backlog end is marked by the first `ProcessState` (`crates/envd/src/server/dispatch.rs:1096-1112`); `process_info` is not on `EnvClient` (`crates/env/src/client.rs:2830`); `list_processes` is unfiltered (`:2246`). Resolved: D3 holds one attachment, with a probe for the offsets, a stated window formula, a growth retry, a backlog-end rule and cancel; the helper lives in `omp-env`; D4 shares a bounded window instead of returning one-shot results.
- **S-04 label and command text are not what the ADR assumed.** Confirmed: `crates/tools/src/shell.rs:1062-1088`. Resolved: S1 uses neither. The inspector already titles the job by id, and command-keyed rules are deferred, with the source of the command noted.
- **S-05 `JobRow` lacks owner; no generation for `process` jobs.** Confirmed: `crates/driver/src/subagent/hub.rs:828-835`; generation must match (`crates/envd/src/exec.rs:2227-2233`). Resolved: S1 reads the owner from the existing `JobRow.data` (`crates/agent/src/dispatch.rs:3427-3433`, `crates/tool/src/lib.rs:2088-2103`) with no `JobRow` change; `process` jobs are out of S1 and are O3. Round 1's "O4 resolved" was wrong and is withdrawn.
- **S-06 line and byte semantics incomplete.** Confirmed: `crates/envd/src/process_log.rs:148-175`; upstream's 4096 cap at `upstream:packages/coding-agent/src/job-widgets/runtime.ts:36`. Resolved by D5: UTF-8 carry, CRLF and CR, the line cap, the leading fragment, the bound, the open trailing line. Lag cannot arise, because the task folds each event as it arrives into a fixed window. On rotation and skips, the `skipped` flag shows.
- **S-07 rate and quiet semantics undefined; state lifetime.** Confirmed: the hub is dropped on close and uses a wall clock (`crates/chat/src/overlays/hub.rs:163-168`). Resolved: the rate is removed. Quiet is a stated lower bound (`quiet ≥Ns`) on `tokio::time::Instant`. State lives in the feed and dies with `/hub`.
- **S-08 polling plumbing through `Panel::tick` unspecified.** Confirmed: `crates/chat/src/overlays/mod.rs:262-274`; `crates/chat/src/overlays/hub.rs:343-368`, `:1349-1355`. Resolved by D6: the services clone is taken in `open`, at most one feed is held, the `next_wake` combination and the `tick` repaint rule are stated, and tests inject a fake `Services`.
- **S-09 roster-line change not mapped to layouts.** Confirmed: `crates/chat/src/overlays/hub.rs:743-780`. Resolved: the roster is unchanged in S1 (Rejected options).
- **S-10 dispatcher-detached output, leak, owner transition, 30 s PTY cost.** Confirmed: `agent_loop` owner at `crates/agent/src/dispatch.rs:3435-3451`; 64 KiB head at `:1048-1085`. Resolved: deferred, with the leak risk and the unverified 30 s vs 60 s order noted. S1 excludes those jobs by owner kind.
- **S-11 rule runtime unspecified and unjustified.** Confirmed: `crates/minimizer/src/filters/cargo.rs:130-160` already recognises `cargo test` summaries. Resolved: deferred, with the note to start from minimizer patterns as typed extractors.
- **S-12 `Spark` built for a contrived caller.** Accepted, as a scope judgment backed by `upstream:packages/coding-agent/src/job-widgets/runtime.ts:671-693`. Resolved: deferred.
- **S-13 spark colour cites `Progress` wrongly.** Confirmed: `crates/tui/src/components/progress.rs:100-106` paints theme tokens and never reads `fg`. Resolved: recorded in the deferred notes.
- **S-14 D8, D9, S5, S6 are speculative detail.** Accepted. Resolved: reduced to one-line deferred notes and O4.
- **S-15 root problem unstated; S1 model too large.** Confirmed: the bash card's window exists (`crates/chat/src/cards/bash.rs:11-40`). Resolved: Context opens with the problem; `JobWidgetView` and its states are gone; S1 reuses `output_tail`.
- **S-16 no flip criterion; loose registration.** Confirmed: `crates/chat/src/settings.rs:400-412`; open-time read precedent at `crates/chat/src/overlays/hub.rs:361-364`. Resolved: D2 gives the meta, read time and why there is no `legacy.path`; O2 covers flipping the default. **Rejected in part**: shipping S1 ungated, because the gap-closure brief requires a default-off gate until acceptance passes.
- **S-17 spark follow-ups.** Confirmed: `crates/vocab/src/lib.rs:238-270`; `crates/app/src/usage_cmd.rs:350-364`; `crates/chat/src/overlays/live.rs:667`; `crates/tui/src/tsp/wire.rs:108`. Resolved: all in the deferred notes. The round-1 Context line "no sparkline" is corrected there: two hardcoded ramps exist.
- **S-18 ANSI decomposition location inconsistent.** Confirmed: `crates/tui/src/components/text.rs:498`. Resolved: the feed passes text through; `<pre>` decomposes once, as for the bash card (Rejected options).
- **S-19 PTY case ambiguous and under-seeded.** Confirmed: `config.cfg` is written only when absent (`crates/e2e/tests/p7_tui.rs:744-753`). Resolved: S1 gives the exact command, markers, seed lines, sizes and steps.
- **S-20 terms undefined; altitude.** Accepted in part. Resolved: a Terms section; mapping formulas and per-component test lists left with the deferred work; O1, O4 and O5 of round 1 removed because the Decision settles them. **Rejected in part**: Context and "What the review changed" stay at this length, because the brief requires the evidence and one entry per finding.
- **S-21 header vs `docs/adr/STATUS.md` row disagree.** Confirmed: `docs/adr/STATUS.md:78`. **Rejected for this change**: the orchestrator owns `STATUS.md` and updates the row; this record is the newer source.

### Round 3 (2026-11-14; four fresh-context reviewers plus a synthesizer, 1 blocker, 12 majors, 14 minors; the last round)

Every finding was checked in this tree. Where a round-2 resolution above is superseded, this group says so; the round-2 entries stay as written.

- **R3-01 (blocker) a multi-line `<pre>` breaks the inspector's one-component-per-row layout.** Confirmed: `crates/chat/src/overlays/hub.rs:893-905` counts components as rows and `:1265-1270` pads by count; every existing entry is one row. **Closed by removing the affected scope**: the ten-line `<pre>` window (and the reuse of `output_tail`, which superseded S-15's and S-18's resolutions) is gone. D6 now adds three single-row components (blank, heading, newest line), which is the kind of entry the inspector already counts correctly. The PTY case asserts the newest line after a resize. A multi-line view is deferred work.
- **R3-02 cancel does not release the stream slot; "no envd change" was false as a consequence.** Confirmed: `crates/envd/src/server/connection.rs:910-913` (no release on the `ProcessAttach` cancel path) against `:914-917` and `:1025-1031`; owner connections do not enforce the limit (`crates/envd/src/policy.rs:1876-1884`, `crates/envd/src/server/identity.rs:35-42`). Changed: the round-2 claim and its test are withdrawn. D3 states the cost and that S1 still makes no envd change; the envd fix is O6. That chat's client is an owner connection is inferred from `crates/app/src/session_runner.rs:62` (the composed kernel's client) and not otherwise verified.
- **R3-03 probe, follow and retry are more complex than needed and leave dead subscribers.** Confirmed: `crates/envd/src/exec.rs:2109`, `:4079-4084`. Changed: D3 is now live-at-end plus capped history, which abut at E with no retry; the dead-subscriber bound is stated (two per feed). This supersedes S-03's resolution.
- **R3-04 no offset continuity between backlog and live.** Confirmed: append before broadcast under separate locks (`crates/envd/src/exec.rs:4022-4050`); the backlog offset rule at `:2094-2102`. Changed: D5 continuity rule (`next`, overlap drop, gap marks `skipped`); tests `overlap_below_next_is_dropped`, `gap_marks_skipped_and_joins_mid_line`.
- **R3-05 cancel-on-drop unspecified.** Confirmed: dropping a request stream only unregisters it (`crates/env/src/client.rs:3556-3578`); `ProcessAttachment::cancel` is synchronous (`:3871-3873`). Changed: D3's drop guard and error-path cancels; tests `dropping_output_tail_sends_both_cancel_frames`, `history_failure_cancels_the_live_attach`.
- **R3-06 retry test not constructible.** Confirmed: no seam for growth between two calls. Changed: the retry is gone (R3-03); its test is removed.
- **R3-07 feed lifecycle covers only selection and close.** Confirmed: `crates/chat/src/overlays/hub.rs:412-417`, `:609-617`, `:996-1054`, `:1316-1325`. Changed: D6 reconciles in `sync_feed()` at the end of `rebuild`, debounces by 300 ms, runs only for running jobs, ends at a terminal state, and maps a gone process to `gone`. Tests cover refresh, resize below 96 columns, narrow details and tab switch, and the PTY case crosses 96 columns.
- **R3-08 the headline case may never produce a feed.** Confirmed in part: the dispatcher detaches any running call at 30 s (`crates/agent/src/dispatch.rs:122`, `:2037-2045`) and the shell defaults to 60 s (`crates/envd/src/exec_settings/shell.rs:55-58`). Whether the kernel's invocation deadline (`crates/driver/src/headless/kernel.rs:1283`) shortens the shell's wait was not established. Changed: D1 and Consequences state guaranteed coverage (`async: true`); O5 asks for a P3 case before S1 merges.
- **R3-09 leading fragment, CR and cap cases.** Confirmed: the backlog carries `log_offset = max(cursor, start)` (`crates/envd/src/exec.rs:2094-2102`); `decompose` treats CR as a break (`crates/tui/src/rich.rs:195-201`); upstream's cap is in characters (`upstream:packages/coding-agent/src/job-widgets/runtime.ts:35-36`). Changed: D5 reads one byte before H, keeps an "inside a dropped line" state, holds a trailing CR, and cuts the open line on a character boundary. The per-line cap now applies only to the open line, because completed lines are no longer kept.
- **R3-10 `OutputWindow` API and crate boundary undefined.** Confirmed: `omp-chat` has no `omp-env` dependency (`crates/chat/Cargo.toml:21-57`); `ProcessState` has seven values (`crates/proto/proto/omp/env/v1/env.proto:550-558`). Changed: D5 gives chat-owned methods, `JobOutputState` and the mapping.
- **R3-11 the `ctrl+o to expand` marker does nothing in `/hub`.** Confirmed: `crates/chat/src/cards/bash.rs:18-40`. Resolved by R3-01's removal: `output_tail` is not used.
- **R3-12 PTY case under-specified, weak assertions.** Confirmed: `crates/e2e/tests/p7_tui.rs:244-268`, `:1059-1100`, `:1187-1190`. Changed: S1's case names the harness pieces, seeds `config.cfg` before spawn, gates on a handshake file, uses output strings absent from the command text, asserts in the inspector columns, and asserts the newest line after a resize.
- **R3-13 `cl_job_widgets` names a feature S1 does not ship.** Accepted: the pre-release rule forbids a later rename. Changed: `cl_hub_job_output`; the title says "Job output in `/hub`"; the header says why the file keeps the gap's slug.
- **R3-14 shared mutex departs from the `LoginFlow` pattern.** Confirmed: `crates/chat/src/overlays/services.rs:463-475`. **Rejected**, with the reason now in D4: a per-event receiver grows with output rate or backpressures envd's unbounded subscriber channel (`crates/envd/src/exec.rs:2081`).
- **R3-15 reuse of existing attach loops not addressed.** Confirmed: `crates/app/src/ps_cmd.rs:121-130`, `:198-208`; `crates/driver/src/subagent/hub.rs:921-931`, `:1214-1225`, `:1352-1362`; `crates/py/src/bindings.rs:3985-3997`. Changed: Context and Rejected options say why none migrate, and that the `process` tool's follow-from-end uses `list_processes`, which D3 replaces with an atomic attach.
- **R3-16 mechanisms beyond the root problem.** Accepted: the quiet timer and its clocks are cut; the CR rule and fragment drop stay. The per-line cap stays only for the open line, as the memory bound.
- **R3-17 shared UTF-8 helper has no destination; `xutf` not used.** Confirmed: `crates/agent/src/dispatch.rs:999-1016` is private and standard-library based. Changed: `dispatch.rs` is no longer touched; the carry lives in `OutputWindow`; the `xutf` question is O7.
- **R3-18 escape-bearing text stored.** Accepted: D5 decomposes each line once through `omp_tui::decompose` (`crates/tui/src/rich.rs:177-213`) with a text-only sink and stores no escapes. This supersedes S-18's resolution.
- **R3-19 clock and repaint mechanics.** Confirmed: `crates/chat/src/overlays/mod.rs:325-334`; the `AgentView` pattern at `crates/chat/src/overlays/hub.rs:1865-1883`. Changed: D6 states the property (at most once a second, only on change), uses the host-clock `tick(now)` only, and drops `tokio::time` from the window.
- **R3-20 quiet semantics.** Resolved by removing the quiet timer (R3-16).
- **R3-21 offset vs sequence wording, retry count.** Changed: D3 says both are absolute log offsets; the retry is gone.
- **R3-22 JSON path and wire spelling.** Confirmed: `crates/agent/src/dispatch.rs:3427-3433`, `crates/tool/src/lib.rs:2088-2103`. Changed: Context gives `data.job.owner` and the serde tags; D6 lists the no-feed outcomes.
- **R3-23 errors stringified despite ADR 0035.** Confirmed: `crates/chat/src/overlays/services.rs:29-40`. Changed: D4 says S1 uses the existing lint-allowed type-erasure seam and adds no error type.
- **R3-24 no `ui.group`.** Confirmed: `crates/chat/src/settings.rs:395-407`. Changed: `ui.group: "Jobs"`.
- **R3-25 test coverage gaps, and the opposite "too heavy" view.** Changed: the list now covers the feed task, the window's state rules, overlap and gap, and the failure mapping; the retry and quiet tests are gone with their mechanisms.
- **R3-26 undefined project terms, missing ADR links.** Changed: Terms gains `AgentHub`, roster, `Section::Agents` and stream slot; References link every ADR by file. Also corrected while linking: ADR 0005 is "Controller owns state; views are projections", not "the hub" as the earlier References said, and ADR 0035's error rule is in `docs/adr/0035-rust-for-the-engine.md:55-56`.
- **R3-27 review ledger inside the record; status vocabulary.** **Rejected**: the gap-closure brief requires a "What the review changed" section in the ADR with one entry per finding, and the status string the orchestrator set. `docs/adr/STATUS.md` is the orchestrator's to update. D1 now points to "Open questions" before O1 is defined.

No blocker remains open. Machine-reviewed (EGM, three rounds); not owner-approved. Implementation is gated by `cl_hub_job_output`, default off.

## Acceptance tests

1. S1: with `cl_hub_job_output 1`, a running `bash` `async` job's newest output line appears in the `/hub` inspector and updates while `/hub` is open, on a real PTY, and reappears after the inspector is hidden by a resize and shown again; then a clean quit.
2. S1: with `cl_hub_job_output 0`, no feed is opened and the existing `/hub` tests and P7 cases pass unchanged.
3. S1: closing `/hub`, hiding the inspector or changing the selection cancels the feed, and dropping an `OutputTail` sends both cancel frames.
4. S1: overlapping and gapped chunks, a backlog starting mid-line, CRLF split across chunks, CR redraws and split UTF-8 produce the line D5 states, with no escapes stored.
5. S1: malformed `data`, `agent_loop`, subagent, `process` and completed jobs open no feed.
6. S1: the inspector's scroll arithmetic stays exact with the Output rows present.

## Status in omp

**Status: Not started.** Reusable today: `EnvClient::attach_output` and `ProcessAttachment::cancel`, the `Services` feed pattern, the `/hub` inspector and the `AgentView` tick pattern, `omp_tui::decompose`, the P7 PTY harness.

## References

[docs/research/tui-job-widgets.md](../research/tui-job-widgets.md); [ADR 0005](0005-controller-actor-separation.md) (views are projections; `/hub` reads the DOM); [ADR 0008](0008-tool-execution-is-a-state-stream.md) and [ADR 0009](0009-bound-output-once.md) (tool output streaming and bounds); [ADR 0012](0012-convars.md) (convars); [ADR 0035](0035-rust-for-the-engine.md) (typed errors); [ADR 0041](0041-native-surfaces-over-tsp.md) (surfaces over TSP); [ADR 0053](0053-independent-verdicts.md) (EGM review, D7).
