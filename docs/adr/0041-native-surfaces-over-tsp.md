# 0041. The chat draws natively in Tern over TSP; cell rendering stays the fallback

Status: accepted
Date: 2026-10-09
Area: interface

## Context

Tern is Stencil's terminal. A program running in a Tern pane can send a tree of semantic nodes
instead of painting cells, through the Tern Surface Protocol (TSP): APC strings in-band on the pty
(`ESC _ tsp;<verb>;<json> ESC \`). Tern lays the tree out and draws it with native widgets
(cards, Markdown, tool rows, editors, pickers), and sends events back on the pty's input. The
specification is public (docs.stencil.so/tern/protocol). A terminal that does not speak TSP never
answers the handshake, and the program keeps its own renderer.

omp v1 (TypeScript) speaks TSP. In Tern it shows its transcript, tool cards, composer, status
line and model picker as native UI. omp2 has no TSP code, so in the same pane it shows its
cell-rendered TUI. The owner compared the two side by side, and this difference is what they saw.
It is not an RPC or ACP problem: Tern talks to omp through the pty, not through `omp rpc`.

### v1, measured (`upstream/main` at `579da1d661`)

- `packages/tui/src/native/` is 4,251 lines: backend, reconciler, reference applier, encoder,
  overlays, pickers, icons, palette and tones. `packages/wire/src/tsp.ts` is 982 lines.
- Components opt in with `describe()`. There are 174 definitions in 136 files, 26 tool renderers
  with `describeCall`/`describeResult`, and 81 files with `handleNativeEvent`.
- A component without `describe()` is sent as a `rows` node: its pre-rendered ANSI lines.
- The reconciler derives ids (base-36 component counter plus key path), skips unchanged subtrees
  by reference and turns growing text into `text append`. A finished block gets `settle` and its
  description is dropped.
- Flow control: at most `credits` (2) frames unacknowledged; while blocked, renders coalesce into
  one frame on the next `ack`, with a 5 s stall escape.
- Node kinds by UI part:

  | UI part | Kind |
  | --- | --- |
  | Assistant text | `md` with `stream` |
  | Thinking | `section` |
  | User message | `card` |
  | Tool calls | `tool` |
  | Bash output | `ansi` with `follow` |
  | Todos | `checklist` |
  | Subagents | `agent` |
  | Composer | `editor` |
  | Status line | `status`/`seg` |
  | Model hub | `picker` |
  | Settings | `prefs` |
  | Notices | `toast` |

- Not used: `flow` surfaces, stylesheets (`s`), `el` nodes, `chart`.
- The feature is young: first commit 2026-09-29, 21 commits by 2026-10-08. Several kinds (`tool`,
  `agent`, `checklist`, `picker`, `prefs`, `effort`) were designed together with omp v1 and may
  still change.

### omp2 today (`omp2` at `6427fb648c`)

- **Input.** The decoder already turns non-kitty APC strings into
  `TerminalResponse::ApplicationProgramCommand` (`crates/tui/src/input.rs`). It turns OSC strings
  into `TerminalResponse::Osc`, which also covers Tern's Windows framing, OSC 877. Both arrive
  through the single `TerminalEvent` mailbox.
- **Probing.** The startup probe is one batch fenced by DA1 (`PROBE_BATCH`,
  `crates/tui/src/graphics.rs`), so a `hello` query fits just before `ESC [ c`. The chat host
  negotiates with a 120 ms timeout on every terminal epoch (`crates/chat/src/host.rs`).
  Nothing detects Tern, and multiplexers are already flagged.
- **Output.** Bytes are produced only by `Renderer::present_slots` (`crates/tui/src/renderer.rs`).
  The transcript is the Slots ledger of 0034.
- **A semantic layer exists above the component tree.** `omp-chat`'s projection yields
  `RenderedBlock`s with a stable `key`, a `BlockKind`, append-only `stream` text and a
  `finalized` flag (`crates/chat/src/project.rs`). Cards read a typed `CardView`
  (`crates/chat/src/cards/mod.rs`).
- **Tool cards are cell chrome.** For example, bash is `box`/`hr`/`pre` with status carried as a
  border colour. Lowering the component tree directly would lose the tool semantics.
- **Naming.** `NativeHost`, `NativeEffect` and `NativeOverlay` already name the GUI window path
  in `crates/chat/src/host.rs`.

### The official Rust SDK

`tern-sdk` 0.1.0 (MIT, about 10k lines) is not a fit:
- Its `Session` opens the tty, sets raw mode, decodes keys and blocks on reads. That collides with
  `omp-tui` owning the terminal and the one input mailbox.
- It depends on the `base64` crate, which is banned.
- Props are untyped `Map<String, Value>`, and errors carry `String` payloads.
- It reads `TERN_TSP*` variables.
- It diffs the whole view on every render and has no `settle`, so memory grows with the session.

Its wire format, chunking rule and examples are useful as conformance vectors.

## Decision

1. **TSP is a second presentation of the same projection.** The chat presents to Tern by
   describing semantic nodes, not by painting cells. Cell rendering stays the default and the
   fallback, and is unchanged when Tern is absent.
2. **In-house wire module in `omp-tui`** (`crates/tui/src/tsp/`). It covers:
   - typed messages: open, close, frame and ops, palette, queries, replies, events;
   - framing and chunking with Tern's cut rule;
   - blobs through `omp_core::base64` and `Hash32`;
   - one recycled encode buffer.

   Terminal negotiation stays inside `omp-tui`:
   - the `hello` query joins the probe batch before DA1, and is never sent in a multiplexer;
   - `ProbeParser` stores the reply as `TerminalCaps.tsp`;
   - `Terminal::handle_response` routes `tsp;r`/`tsp;e` (APC, and OSC 877) to typed TSP input on
     the same mailbox.

   No dependency on `tern-sdk`.
3. **Node source, in order of preference:**
   1. A semantic description from the chat projection: `BlockKind` plus a per-card describe
      hook over `CardView`, defaulting to a generic `tool` node.
   2. A generic lowering of the `omp-tui` component tree (`md`, `diff`, `table`, `tree`, `todo`,
      `editor`, `status` and others map one to one).
   3. `rows`: the component painted at the pane width and emitted as ANSI lines.

   Ids derive from `BlockView.key`. Streamed text is sent as `text append`, and `finalized`
   maps to `settle`.
4. **One inline surface per terminal epoch.**
   - It has `main`, `dock` and `layer` regions.
   - It closes with `keep:true` before the terminal is left (suspend, external editor, exit), and
     input is drained afterwards.
   - Re-entry uses `adopt`; a `gone` reply opens a new surface.
   - While a surface is live, the `Renderer` and the Slots ledger are idle for the transcript.
5. **Interaction.**
   - Keys stay ordinary pty input owned by omp.
   - `action`, `change` and `toggle` events route to the owning block or card by id.
   - Native editing (`edit`, `undo`, `send`) waits for phase 3: its UTF-16 offsets must go
     through `xutf`.
6. **Opt-out and debugging.** TSP is on whenever Tern answers; `OMP_TSP=0` forces cell
   rendering. `OMP_TSP_RECORD=<file>` records messages as JSONL for Tern's `surface-play`. No
   `PI_*` or `TERN_*` names.

### Phases

| Phase | Scope | Exit criterion | On `omp2` (2026-11-04) |
| --- | --- | --- | --- |
| 0 | Wire module, probe arm, input routing, a port of v1's reference applier (`apply.ts`) as a test oracle, opt-out and recording | Unit tests: chunk cut rule (property), framing round-trip, probe demux; no user-visible change | Done |
| 1 | Handshake, with the optimistic start on `TERM_PROGRAM=tern` (revoked after 1 s without a reply); inline surface; transcript blocks as `card`/`md` (append)/`section`/generic `tool`/`rows`; `settle`; credits and ack; composer as a minimal `editor` (caret, no native editing) and status band as `rows`; overlays fall back to cell rendering; close/adopt across epochs | Real-PTY e2e against a scripted fake Tern (hello before DA1, acks, document assertions) plus the fallback paths (DA1 first, multiplexer, `OMP_TSP=0`) | Done |
| 2 | Per-card descriptions (bash `ansi`+`follow`, edit `diff`, read `code`, todo `checklist`, task `agent`), status as `status`/`seg`, toasts, images via blobs (no palette `t`: Tern's theme applies) | Each card's description checked against the applier; `rows` count per frame logged | Done, except the `rows` count per frame: nothing logs it |
| 3 | `editor` with `edit`/`undo`/`send`, autocomplete overlay at the caret, pickers and settings as `picker`/`prefs`, modal approvals in `layer`, `screen` surfaces for full-screen apps | Editor edits round-trip through UTF-16 offsets; picker selection drives the same commands as the cell UI | Done (2026-11-15; #648, #650, #653). Modal approvals, settings as a `prefs` sheet (an `el` form for an older Tern), `screen` covers, native `edit`, `undo` and `send`, data-first pickers, the autocomplete overlay at the caret and the `effort` seg. Both halves of the criterion are proven in P7. Owed: `aside` docking of the sheet, and `select`/`activate`/`focus` on it |
| 4 (optional) | `flow` surfaces for print-mode output, stylesheets and `el`, Windows ConPTY input, `TERN_BLOB_DIR` | Owner decision per item | Partial. Done: the typed `el` builder, OSC 877 input. Owed: a `flow` caller, a stylesheet caller, a `TERN_BLOB_DIR` reader |

## Consequences

- **0034 (transcript is a protocol).** Under a live surface, committed rows and the resize policy
  do not apply: TSP nodes stay addressable and Tern reflows them. The exactly-once rule moves to
  the surface: every block is added once, settled once, and replayed by Tern's own snapshot. The
  switch between cell paint and a surface mid-session must erase the painted viewport (v1 does
  this). Needs an amendment of 0034 when phase 1 lands.
- **0032 (presentation policy in the renderer).** Tern animates spinners, shimmer, elapsed timers
  and streamed Markdown. omp stops its own ticks for nodes Tern animates. Stream pacing becomes a
  convar (`tsp_stream_pacing`), settled by the test in the owner decisions below.
- **0030 (one-pass rendering).** `ansi` and `rows` need ANSI bytes in frame bodies. That is a
  second materialization point, from spans or cells to bytes, at the TSP output boundary. Text
  is still decoded once at entry, and no component stores escapes.
- **0031 (typed component model).** "One description, many surfaces" gains a third surface. The
  per-card describe hook becomes part of the card contract.
- **Testing.** Tern is not in CI. Correctness rests on the reference applier, the fake responder
  and conformance vectors taken from the spec and the SDK's examples (written as data, not copied
  code). The visual result is verified by hand in Tern.
- **Risks:**
  - The protocol and its omp-specific kinds may still change, so omp falls back per kind using
    `hello.kinds`.
  - A slow reply over ssh misses the 120 ms fence and silently gives cell rendering.
  - A crash before `x` may leak events to the shell; the spec says Tern cleans up when the
    process exits.
  - A third presenter can drift from the other two unless overlay, approval and composer state
    stay in `Presenter`.

## Owner decisions (2026-10-09)

1. **Default: on.** TSP is used whenever Tern answers the handshake. `OMP_TSP=0` is the only
   switch, and it only turns TSP off.
2. **Optimistic start: yes.** With `TERM_PROGRAM=tern` and no multiplexer, omp opens the inline
   surface and sends its first frame without waiting for the reply, on the assumed v1 hello (every
   kind, `apc` 65536, `credits` 2). If DA1 answers first or no reply arrives within 1 s, the
   surface is closed with `keep:false` and omp paints cells. This moves from phase 4 into phase 1.
3. **Theme: Tern's.** omp never sends a palette (`t`). Nodes carry roles and tones only; colours
   come from Tern's theme.
4. **Node kinds: all of omp's.** omp uses `tool`, `agent`, `checklist`, `picker`, `prefs` and
   `effort` wherever they fit. A kind missing from `hello.kinds` (an older Tern) still falls back
   per kind to its generic equivalent (`tool` to `card`, `picker` to a `list` composition).
5. **Stream pacing: decided by a test.** Tern does not animate arriving text: an `md` node
   re-renders from its last open block on each `text append`. So the choice is between:
   - raw appends: each provider delta goes out as it arrives, coalesced only by credits (v1);
   - paced appends: omp releases the text at its reveal cadence (`cl_smooth_streaming`).

   Both ship behind a convar (`tsp_stream_pacing raw|paced`); `raw` is the default until the test
   says otherwise.

   **The test:**
   1. Record the same scripted response in both modes with `OMP_TSP_RECORD`, once with a
      fine-grained stream (small deltas) and once with a coarse one (large chunks).
   2. The owner replays each recording in Tern with `surface-play <file> paced` and judges it by
      eye.
   3. Measure from the recordings: time to first text, frames per second, largest append, and
      how often credits ran out.
   4. If the coarse stream looks jumpy under `raw`, the default becomes `paced`.

### Remaining decisions (2026-10-09)

The owner accepted the recommendations for the six decisions left open:

6. **Where the code lives.** The TSP presenter lives in `omp-chat`, beside `Host`, sharing
   `Presenter`. The wire module, probe arm and input routing stay in `omp-tui`
   (`crates/tui/src/tsp/`); there is no `omp-tsp` crate. The terminal keeps one owner.
7. **Node source: the semantic projection first.** Blocks come from `BlockKind` and cards from a
   per-card describe hook over `CardView`. Lowering the component tree is the fallback, then
   `rows`.
8. **Bash output as `ansi`.** Process output goes out as an `ansi` node with `follow`, re-encoded
   to SGR at the TSP output boundary (the second materialization point noted under 0030).
9. **Phase 1 composer: a minimal `editor` node.** It has text, a cursor converted to UTF-16, a
   placeholder and `focus`. Every key stays omp's: no `edit`, `undo` or `send` before phase 3.
   The status band is `rows` in phase 1.
10. **Phase 1 overlays fall back to cell rendering.** While an overlay is open, the surface is
    suspended and the existing renderer draws it; the surface resumes when it closes. Native
    overlays arrive in phase 3.
11. **The GUI window host is not decided now.** Whether it later consumes the same semantic
    description instead of cells is deferred; nothing in phases 0 to 4 depends on it.

## Status in omp

Phase 0 done (`crates/tui/src/tsp/`):
- typed wire messages, framing and chunking with Tern's cut rule, a reply and event reader;
- the reference document applier, used as the test oracle;
- the `OMP_TSP_RECORD` recorder and the `OMP_TSP=0` opt-out;
- the `hello` query in the startup probe before DA1, with the reply in `ProbeResults::tsp`;
- `tsp;` replies and events (APC and OSC 877) consumed by `Terminal::handle_response` and queued for
  `Terminal::take_tsp`.

Phase 1 done (`crates/chat/src/tsp.rs`, wired in `crates/chat/src/host.rs`):
- one inline surface per terminal epoch, with `main`/`dock`/`layer` regions;
- the optimistic start: inside Tern, outside a multiplexer, the surface opens and sends its first
  frame on the assumed v1 `hello` (every kind, `apc` 65536, `credits` 2); a DA1 answer with no
  `hello` in front of it, or one second of silence, closes it with `keep:false` and the epoch
  finishes in cells;
- close with `keep:true` before leaving the terminal and `adopt` on re-entry; a `gone` event
  mounts a fresh surface;
- transcript blocks as `card`/`md`/`section`/`tool`/`rows` with ids from `BlockView.key`,
  `text append` for streaming and `finalized` → `settle`;
- credits and `ack`: never more than `credits` frames unacknowledged;
- the composer as a minimal `editor` node (text, UTF-16 cursor, placeholder, `focus`), the status
  band as `rows`, and every key still omp's (phase 3 adds Tern's native selection edits);
- overlays suspend the surface and the existing renderer draws them;
- the `tsp_stream_pacing raw|paced` convar, both modes implemented;
- while a surface is live the slot ledger stays idle; it is admitted when an overlay hands the
  screen back.

Phase 2 done (`crates/chat/src/cards/`, `crates/chat/src/tsp.rs`; `5790db5f4e`):
- per-card descriptions through `Card::describe` over `CardView`: bash as `ansi` with `follow`
  while the call is in progress, edit as `diff`, read as `code` plus `image` nodes for blob parts,
  todo as `checklist`, task as `agent`; a card without a description keeps the generic `tool`
  node, then `rows`;
- the status band as `status`/`seg`, and notices as `toast`, each falling back per kind through
  `hello.kinds`;
- no palette is sent; nodes carry roles and tones only;
- every frame logs, at debug level, a `tsp frame` event with the fields `surface`, `seq`, `ops` and
  `rows`. `rows` counts the nodes that fell back to `rows` and is computed only when debug is on
  (`crates/chat/src/tsp.rs:log_frame`; #648).

Phase 3 done:
- the approval prompt is a surface-scoped `el` form in the `layer` region; Tern `action` events
  are queued by the surface and routed to the same approval decision authority as the cell UI
  (`fe1b29c476`);
- settings panels expose a surface-scoped `el` form; Tern `change` events lower through the
  panel's existing `PreviewSetting` path, so validation and commit semantics are unchanged
  (`dc9b310a76`);
- both fall back to the retained cell overlay when TSP is unavailable;
- a full-screen panel that describes itself natively covers the pane with a `screen` surface
  (`d9684b4de9`, #472). `crates/chat/src/host.rs:Host::present_tsp` hands the `Panel::tsp_node`
  of a `PanelAnchor::Full` panel the terminal draws to
  `crates/chat/src/tsp.rs:Surface::present_cover`, which opens `omp-screen` in `screen` mode over
  the live session and closes it with the panel. P7
  `tsp_a_full_screen_panel_covers_the_pane_with_a_screen_surface` drives it through `/settings`.
  Only the settings panel describes itself, so every other full-screen panel suspends the
  surface and draws in cells;
- native editing in the composer. The `hello` query announces the program features `edit` and
  `undo` (`crates/tui/src/tsp/mod.rs:PROGRAM_FEATURES`), so Tern may keep a native selection in
  the composer and turn ⌃Z there into `undo`. `crates/tui/src/tsp/edit.rs:resolve` drops an
  `edit` whose `len` is not the displayed draft's UTF-16 length, clamps and orders its offsets,
  takes the whole character when a range end falls inside a surrogate pair, sanitizes the text
  like a paste, and carries Tern's caret onto the result.
  `crates/tui/src/editcore.rs:EditBuffer::apply_native_edit` widens a range that touches an
  attachment marker to the whole marker and records one undo unit, and none for a caret move.
  `crates/chat/src/host.rs:Host::route_tsp_event` applies `edit` and `undo` to the composer. P7
  `tsp_native_edits_round_trip_through_utf16_offsets` proves the round trip on a real PTY: this
  is the editor half of the exit criterion;
- `xutf` 1.6.0 has no offset conversion: its `convert` module exports `transcode`,
  `transcode_into`, `transcode_with_case`, `transcoded_len` and `to_string`. Lengths go through
  `transcoded_len::<Utf8, Utf16Le>`, and `resolve` maps offsets by walking the characters.

- native `send` (#648). The `hello` query announces `send`. The composer carries `sendable`
  while Enter would reach it: no approval and no modal overlay (`Presenter::composer_ready`).
  `Host::route_tsp_send` accepts a `send` only for the live session composer
  (`Surface::addresses_composer`). It submits the sanitized text (`edit.rs:send_text`) through
  `Presenter::send_prompt`, the same classification and refusals as Enter, so a sent `/exit`
  quits. The draft it displaces is kept for Up recall (`Composer::stage_send`), as v1 parks it in
  local recall. v1's only `sendable` gate is a bootstrap flag that omp2 lacks. P7
  `tsp_native_sends_take_the_path_enter_takes`;
- data-first pickers (#650). `crates/chat/src/overlays/models.rs:ModelPicker::tsp_node` and
  `crates/chat/src/overlays/mod.rs:HistoryPicker::tsp_node` send a `picker` shaped like v1's
  `TspPickerProps`, with typed props in `crates/tui/src/tsp/picker.rs`:
  - rows in `items`, keyed by catalog key or history row id;
  - the list's filtered rows in `order`, and the cursor row named by id in `selected`;
  - the selected model's preview as children.

  `crates/chat/src/tsp.rs:Surface::present_sheet` patches the sheet in place, so a cursor move
  sends `selected` and the preview, never the catalogue. The whole catalogue rides one frame,
  chunked under the `apc` limit. `Host::route_tsp_gesture` routes the events through the same
  `PickerEvent`s as the cell picker's keys: `select` previews, `activate` or the `confirm` action
  picks, and `close` or `cancel` closes. A Tern without `picker` keeps the cell overlay. P7
  `tsp_the_model_picker_previews_on_select_and_picks_on_activate_or_confirm` is the picker half
  of the exit criterion;
- the autocomplete overlay (#650). `crates/chat/src/composer.rs:Composer::autocomplete_node`
  sends an `overlay` anchored to the composer's caret around a `list` of the dropdown's window.
  A row's `select` or `activate` is accepted as a click on the cell row is
  (`Composer::accept_completion`). P7
  `tsp_the_completion_list_sits_at_the_caret_and_accepts_a_row`;
- `prefs` and `effort` (#653). The settings panel describes itself as a data-first `prefs`
  sheet (`crates/chat/src/tsp/prefs.rs`, `SettingsPanel::tsp_prefs`). It goes on the screen
  cover when `hello.kinds` has `prefs`; otherwise the panel sends its `el` form. Its `change`
  events commit through `SettingsPanel::stage_commit`, the cell UI's validation, rollback and
  `writecfg` path, and `null` resets a row to its default. The model hub stays a `picker`, as in
  v1. P7 `tsp_a_prefs_change_commits_the_setting_like_the_cell_ui`. The status band carries
  thinking effort as an `effort` seg, falling back to a four-step `blocks` meter and then to
  text. A click cycles the level (`thinking.cycle`).

Phase 3 not done:
- `aside` docking. v1 docks the `prefs` sheet in `layer` when Tern advertises `aside`; omp
  always uses the screen cover;
- `select`, `activate` and `focus` events on the `prefs` sheet are not routed;
- no P7 proof covers `effort`, because the sandbox model reports no reasoning. Unit tests against
  the reference applier cover it;
- a P7 run on the merged prefs branch twice failed one test with "chat did not quit": the
  surface closed and the terminal was restored, but the process did not exit within 20 s. Each
  time the test passed when rerun, alone and in the full suite. The cause is unknown.

Phase 4 partly done (`f44c83c249`, `ee8b23083f`):
- a typed `ElementTag` builder (`crates/chat/src/tsp.rs:element_node`) keeps Tern's tag
  vocabulary closed; the approval and settings forms use it;
- OSC 877 input, Tern's framing through a Windows ConPTY, is decoded in
  `crates/tui/src/tsp/frame.rs` (`OSC_PREFIX`);
- surface-scoped stylesheets. `crates/chat/src/tsp.rs:Surface::set_stylesheet` sends one only
  when `hello` advertises the `styles` feature, with validated names and Tern's 256 KiB
  per-surface budget. Nothing calls it: `cargo check -p omp-chat` reports it as never used.

Surface modes, phases 3 and 4 (`crates/tui/src/tsp/doc.rs`, `crates/chat/src/tsp.rs`):
- `screen` and `flow` need no new node kind. A TSP node joins `wire::Kind`, and `Mode::Screen` and
  `Mode::Flow` were already typed in the wire module, so both are placement decisions over `Mode`. The
  ledger of 2026-11-01 blocked them on a node shape that none of them needs;
- a `Surface` is built for a `Mode`. `inline` is the chat session. `screen` never adopts and is
  discarded when it closes, whatever `keep` says. `flow` is command output that stays in the
  scrollback: it never listens, so Tern sends it no acks and its frames never wait for credits; it needs
  the `flow` feature (`present` refuses with `Unsupported` without it) and mounts no composer or
  status band;
- the reference applier knows the mode a document opened in: `Document::close(keep)` discards a screen
  surface whatever `keep` says and keeps the `main` of an inline or flow one. The specification's own
  frames and its static `ls` table run through it in every mode.

Phase 4 not done, checked against the code on `omp2`:
- `flow`. No production code opens a flow surface. `crates/chat/src/host.rs:Host` builds its
  surface inline, through `Surface::new` with `Mode::Inline` or `Surface::optimistic`; flow
  surfaces are built only by the tests in `crates/chat/src/tsp.rs`; and
  `crates/app/src/print_mode.rs` has no TSP code;
- `TERN_BLOB_DIR`. Nothing in `crates/` reads it.

The 0034 amendment that the Consequences section asks for is not written. Native editing does
not change the transcript protocol, so it is still owed.

## Not verified

- Appearance and fluidity in a real Tern: every proof here runs against a scripted fake Tern on a
  real PTY, with `omp_tui::tsp::doc` as the oracle. The `.jsonl` recordings (both pacing modes) are
  for the owner to replay with `surface-play`.
- Which gestures make a real Tern send `edit`, and whether ⌃Z in the composer reaches omp as
  `undo` rather than as the `cl_suspend` key. The P7 proof sends both events itself.
- That a bracketed paste can never surface as a TSP response in omp2's decoder.
- How many v1 components still fall back to `rows` at runtime.
- How Tern's `md` treats omp's Markdown extensions (mermaid, graphviz).
