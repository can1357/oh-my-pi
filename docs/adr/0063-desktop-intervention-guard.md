# 0063. Desktop input: layout-aware XKB typing on Wayland and macOS drag release on abort; the macOS intervention guard is deferred

Status: Proposed 2026-11-14; machine-reviewed (EGM, 3 rounds), not owner-approved
Date: 2026-11-14 (first draft 2026-11-13)
Area: tools

Research: [docs/research/desktop-intervention-guard.md](../research/desktop-intervention-guard.md) (Gap 4 of the upstream gap closure). This record states decisions; the note holds the evidence.

## Review state

- This design was machine-reviewed and is not owner-approved.
- Elephant-Goldfish (EGM) review: the author drafts and holds the context; fresh-context reviewers ("Goldfish") see only this record and the files it cites. There were three rounds, and the author verified every finding against source.
- Round 3 left one blocker. It was closed by removing the affected scope, the libei (Wayland) half of release on abort, rather than by new design.
- Each part is implemented only behind its own default-off convar:
  - `sv_computer_xkb_layout` for Part A;
  - `sv_computer_release_on_abort` for Part C.
- Turning either on by default needs the owner (O1, O8 under "Open questions for the owner").

## Scope

- **Part A**: layout-aware typing on Wayland.
- **Part C**: macOS drag release and chord validation when an input call stops early.
- **Part B**, the macOS user-intervention guard, is deferred to its own record ("Part B: deferred").
- Release on abort for the libei backend is deferred too (D10).

## Terms

- **run**: one `action=run` program of the `computer@3` tool, the model-facing desktop tool.
- **convar**: a typed setting declared in code (ADR 0012).
- **session worker thread**: the per-session native thread `omp-desktop-session` (`crates/desktop/src/lib.rs:730-748`). It is the only thread that enters an `OperationScope`, so it is the only one where `operation_checkpoint()` can see a cancel or a deadline (`crates/desktop/src/lib.rs:90-114`, `:740`).
- **Linux desktop actor**: the process-wide thread `omp-desktop` (`crates/desktop/src/linux/actor.rs:50-57`, loop at `:91`). It owns AT-SPI and the one shared `ActorLibei` (`:121-135`). It never enters an `OperationScope`, so `operation_checkpoint()` there always returns `Ok`.
- **libei**: the Wayland emulated-input protocol, driven through the `reis` crate.
- **keymap**: the compiled XKB description that libei hands over.
- **group**: one layout inside a keymap (for example `us` and `fr` in `us,fr`).
- **level**: the shift state that selects a symbol on a key (base, Shift, AltGr and so on).
- **AltGr**: the third-level modifier, evdev keycode 100.
- **US ASCII fast path**: upstream's `can_use_us_ascii_fast_path` holds when every key in five physical rows (digits, `qwertyuiop[]`, `asdfghjkl;'\``, `\`, `zxcvbnm,./`) resolves to its US glyph at the base level and at Shift (`upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:521-540`). A French group fails this check. In `us,fr` with US active, it passes.
- **`native_fault`**: envd's map from `omp-desktop` errors to the model-facing fault. It keeps the code and replaces the message with fixed text (`crates/envd/src/computer.rs:1724-1755`).

Citation keys: omp2 paths are relative to the repository root at `omp2` 9cb6fd638. Upstream paths carry the `upstream:` prefix and refer to can1357/oh-my-pi at c308970263. "The brief" is the mission brief `docs/research/upstream-gap-closure-brief.md`. It is kept outside this repository, so its rules are quoted where they bind.

## Context

### The problems in omp2

**Part A: wrong characters on non-US Wayland layouts.**
- `type_text` maps each character through the fixed US table `evdev_char` (`crates/desktop/src/linux/wayland/libei.rs:453-484`, `:572`).
- `key_chord` maps `KeyName::Char` through the same table (`:429-451`, `:517-570`).
- Shift (42) is the only modifier the send loop knows (`:470-481`).
- On a French layout, `a` presses the US-`A` key, which types `q`, and no error is reported. [INFERENCE from the evdev codes]
- `ActorLibei::new` drops the libei event stream after its one discovery pass (`:84-91`). `EiDevice` holds only a device and a serial (`:45-48`). Nothing handles `KeyboardModifiers` or a keymap. So omp2 cannot know the active group.
- The socket itself stays open in `ActorLibei::context` (`:57`) and is not read after discovery.

**Part C: a held button after a cancelled macOS drag; a held modifier after an invalid chord.**
- **Drag.** `background_drag` posts button-down, then can leave through `crate::operation_checkpoint()?` without button-up (`crates/desktop/src/macos/input.rs:497-529`, checkpoint at `:513`). `global_pointer`'s drag arm has the same shape (`:883-913`, checkpoint at `:904`). These run on the session worker thread, so a cancel or an expired deadline really does reach them.
- **Chord.** macOS `key_chord` has no checkpoint. It resolves key codes lazily inside its press loop (`post_key` calls `key_code(key)?`, `:702-711`). `[Ctrl, Char('é')]` therefore presses Ctrl, fails on `é` (`char_key_code`, `:779`) and returns with Ctrl held (`:684-688`).
- **Posts fail only before delivery.** `post_dual` and `post_keyboard` fail only in `required()?`, before posting (`crates/desktop/src/macos/skylight.rs:207-229`). `post_global` cannot fail (`crates/desktop/src/macos/input.rs:971-974`). So a post that returned `Err` delivered nothing.
- **Where "held" lives.** Background routines post to a pid, which leaves only that app's input state with a held button. Global routines post at the HID level, which leaves the user's real pointer button held.
- **Not affected.** Clicks check before their down post (`:378`, `:854`), so a cancel cannot strand a click. X11 input has no `operation_checkpoint` at all (`crates/desktop/src/linux/x11/input.rs`, zero matches), so a cancel cannot strand a button there.
- **Win32.** Win32 drags have the drag's shape (`crates/desktop/src/win32/input.rs:324-341`, checkpoint at `:334`). They post window messages, not HID input, and are out of this record (O8).

### What OMPv1 does

- **Wayland typing.**
  - libei hands over the compositor's compiled keymap. `KeyboardLayout` parses keycodes, types and per-group levels, and never borrows a key from another group (`upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:1-7`).
  - `read_keymap` rejects non-XKB keymaps, size 0 and sizes over 16 MiB (`upstream:crates/pi-natives/src/desktop/linux/wayland/libei.rs:860-869`).
  - `char_stroke` sends control characters through fixed evdev keys, uses the US ASCII fast path only when it holds, and resolves everything else through the active group alone. With no keymap, printable text is an error (`:871-896`, test `:1117-1121`).
  - `plan_keys` resolves every key before anything is pressed. It routes `KeyName::Char` through the layout and skips a keycode already in the list (`:815-833`).
- **Device state.**
  - Upstream keeps the event stream and drains it before each input: 1 ms per poll, at most 256 events, otherwise "did not settle; no input was sent" (`:389-414`, called at `:459`, `:711`, `:751`).
  - `handle_event` tracks devices as a `Vec` selected by `resumed && capability`, and feeds `KeyboardModifiers` into the layout (`:316-388`).
  - A missing or paused keyboard is `permission_denied("no resumed libei keyboard is available")` (`:707-711`, `:753-757`).
- **Release.** `stroke_path` posts the drag's button-up at the last point it reached, whatever failed (`upstream:crates/pi-natives/src/desktop/macos/input.rs:2700-2735`). It moves back to the start only once a drag-and-drop session has begun (`:2728-2734`).

### Rules that bind

- **The brief.** It says: "Additive only. Do not change the behaviour, names, schemas or revisions of existing tools … If a gap seems to require changing one, stop work on that gap, write the conflict into its ADR as an open question" (brief lines 43-46). It also says implementation is "only behind a default-off `cap-*` feature or convar", with the record saying it was "machine-reviewed and not owner-approved" (brief lines 95-97).
- **How this record reconciles them.** Both parts change what `computer@3` does, from wrong to right. Behind a default-off convar, no existing behaviour changes unless a user opts in. The change of default is the open question the brief asks for (O1, O8).
- **Deviation recorded.** The brief also asks for an e2e or golden-journal test for user-visible behaviour (brief lines 150-152). This record has neither, for the reasons under "Proof levels".
- **Errors.** ADR 0035 (`docs/adr/0035-rust-for-the-engine.md:54-57`) requires typed `thiserror` errors with no formatted inner errors. The lintx `error-format` ratchet counts formatted error *bindings* (`tools/lintx/README.md:44-57`). `desktop` has no entry in `tools/lintx/baselines/error-formatting.toml`, so its baseline is zero. Ported code must not format an `Err` binding: upstream's `format!("libei device state: {err}")` (`upstream:crates/pi-natives/src/desktop/linux/wayland/libei.rs:402`) becomes `DesktopError::caused`, as `crates/desktop/src/linux/wayland/libei.rs:208-210` already does.
- **This record's own rule:** a layout that cannot be read never falls back to a guessed US layout.
- **Repository rules for ported code** (AGENTS.md "Conventions", "Allocation Discipline"):
  - Maps use `omp_core::FastHashMap`, so `omp-desktop` gains a dependency on the workspace crate `omp-core`. No external crate is added.
  - Single-code-point tests use std `char` methods, as elsewhere in the tree (`crates/catalog/src/cascade.rs:971`). Typing stays per `char`, as omp2's `type_text` is today, so no grapheme segmentation is needed.
- **Reuse check.** No XKB parser exists in the workspace. The only `xkbcommon` in `Cargo.lock` comes through the Windows-only `enigo` (`Cargo.lock:2803-2817`). Owning the roughly 600-line parser means tracking libxkbcommon serialisation changes, like the `symbols[GroupN]` to `symbols[N]` change D5 handles.
- **Naming.** No `pi` identity in anything ported. The computer convars are `sv_computer_*` with `ui.*` meta (`crates/envd/src/computer.rs:32-68`), compiled only with `cap-computer` (`crates/envd/src/lib.rs:28-29`; capability features per `docs/adr/0049-tiered-integration-architecture.md:47`).

## Decision

**D1. Two independent fixes, each with its own convar.**
- Part A and Part C change different files, apart from one shared plumbing struct (D4) and one shared test (`computer_settings_project_from_typed_convars`). They are authorised and shipped separately.
- Part B is not decided here (D9).

**D2. Plumbing: one `InputOptions` value, carried per call to the shared libei actor.**
- `InputOptions { xkb_layout: bool, release_on_abort: bool }` (`Copy`) is set from two new fields on `DesktopSessionOptions`. The single struct literal is updated (`crates/desktop/src/types.rs:137-141`, `crates/envd/src/computer.rs:103`).
- Path through omp-desktop:
  1. `DesktopSession::new` (`crates/desktop/src/lib.rs:852-854`)
  2. `SessionCore`
  3. `Worker::new` (`:300`)
  4. every cfg variant of `create_backend` (`:674-688`)
  5. on Linux: `linux::new_backend` (`crates/desktop/src/linux/mod.rs:15`), then `WaylandBackend::new` (`crates/desktop/src/linux/wayland/mod.rs:36`), which stores the value
  6. on macOS: `MacosBackend`, which passes `release_on_abort` to the drag and chord routines
- `ActorLibei` is process-wide and shared by every session through a reference count (`crates/desktop/src/linux/actor.rs:121-135`). So the flag is not set at its creation. Instead `Command::LibeiTypeText`, `Command::LibeiKeyChord` and `Command::LibeiPointer` (`:41-43`) each carry the calling session's `xkb_layout`, and each call behaves according to its own session's convar.
- Both convars are read once, when the computer session is created (`ComputerSettings::from_con`, `crates/envd/src/computer.rs:76-84`, `:100-108`). Changing one mid-session takes effect at the next computer session.

**D3. Part A: how a character becomes keys** (slice A1).
- Pure planning, as upstream's `char_stroke` and `plan_keys` (`upstream:crates/pi-natives/src/desktop/linux/wayland/libei.rs:815-833`, `:871-896`):
  - Control characters use fixed evdev keys in every group.
  - ASCII uses the fixed US table only when the US ASCII fast path holds.
  - Every other character resolves through the active group alone.
- Every key of a call is resolved before anything is pressed. A character the active group cannot produce fails with `ErrorCode::InputFailed` and presses nothing.
- A chord's plan is a list of evdev keycodes: each stroke's modifiers (AltGr included), then its key. A code already in the list is skipped, so `[Shift, Char('A')]` presses Shift once. The list is pressed in order and released in reverse.
- Execution takes a send sink, `FnMut(u32, bool) -> CoreResult<()>`, so planning and order can be tested without a device.
- If a send fails, the call returns at once, as today. That failure cannot strand a key: `send_key` fails only when the device has no keyboard interface (`crates/desktop/src/linux/wayland/libei.rs:323-327`), which fails the first send of the call, before anything is pressed.
- With the convar on and no usable keymap (non-XKB, size 0, over 16 MiB, parse failure), every printable `KeyName::Char` fails with `InputFailed`. That includes `ctrl+c`, which works today through the US table.
- With the convar off, `type_text` and `key_chord` behave exactly as today.

**D4. Part A: the keymap and the active group.**
- **A1 (keymap read once).** The keymap is read at discovery from the keyboard's `DeviceAdded` (`device.keymap()`), and the group starts at 0, the parser's initial state. A1 alone does not follow a later layout switch, so O1 waits for A2.
- **A2 (stream kept and drained).**
  - `ActorLibei` keeps the handshake's event stream and connection instead of dropping them (`:84-91`).
  - Before each libei command whose `xkb_layout` is on, the actor drains the stream on the Linux desktop actor. "Settled" means one 1 ms poll returned no event. The loop takes at most 256 events and runs through the actor's runtime (`crates/desktop/src/linux/actor.rs:119`, `:126`).
  - If the stream has not settled, the call fails with `InputFailed` ("libei device state did not settle; no input was sent") before sending anything. The call can be retried: drained events stay consumed.
  - No cancellation check runs inside the loop, because the actor has no operation scope (see Terms). The loop is bounded by its 256-event cap instead.
  - Commands whose `xkb_layout` is off do not read the stream. That matches today, where the socket is not read after discovery (`crates/desktop/src/linux/wayland/libei.rs:57`, `:84-91`).
- **A2 device model.** Drained events become omp-owned `DeviceChange` values at one conversion site. A pure transition function applies them to the existing `pointer` and `keyboard` slots (`:56-62`), which gain `resumed: bool` and, for the keyboard, `layout: Option<KeyboardLayout>`:
  - `DeviceAdded` with the keyboard capability: read its keymap and hold it pending.
  - `DeviceResumed`: adopt a pending device into an empty slot, or refresh a known slot's serial. Set `resumed`.
  - `DevicePaused`: clear `resumed`.
  - `DeviceRemoved` and `SeatRemoved`: empty the slot.
  - `KeyboardModifiers`: call `update_modifiers` on the keyboard's layout.
  - `Disconnected`: set a sticky `disconnected` flag. Every later libei call then fails with `InputFailed`.
- **A2 errors.** An empty or paused keyboard slot keeps today's code, `PermissionDenied` (`crates/desktop/src/linux/wayland/libei.rs:430-432`, `:454-456`), as upstream does (`upstream:…/libei.rs:707-711`).
- **A2 serial.** omp2 keeps its own serial model: the serial of the device's latest `DeviceResumed` (`crates/desktop/src/linux/wayland/libei.rs:236-240`), with start and stop emulation per call as today (`:271-281`). Upstream's live connection serial and its emulation once per resume are not ported. The manual check below covers the difference.
- **A2 shared state.** Device state is shared by every session on the process. A session whose convar is off can therefore see a slot that a convar-on session's drain emptied or paused. This is accepted: the state it then sees is the true one.

**D5. Part A: fixtures and licence.**
- omp2 generates its own keymaps with libxkbcommon's `xkbcli compile-keymap --rules evdev --model pc105 --layout fr` and `--layout us,fr` (US first). They are stored at `crates/desktop/src/linux/wayland/testdata/fr.xkb` and `us-fr.xkb`.
- `crates/desktop/NOTICE`, in the shape of `crates/tui/NOTICE`, records:
  - the command;
  - the libxkbcommon and xkeyboard-config versions;
  - xkeyboard-config's `COPYING` at tag `xkeyboard-config-2.41` (https://gitlab.freedesktop.org/xkeyboard-config/xkeyboard-config/-/raw/xkeyboard-config-2.41/COPYING): 190 lines, twelve copyright lines, X11/MIT-style permission notices, no copyleft clause;
  - upstream's MIT notice for the ported parser (`upstream:LICENSE:1-5`).
- The fixtures keep the generator's group-label form. A test helper rewrites `symbols[` and `type[` labels in both directions, between `GroupN` and numeric. The tests that use a fixture as written cover the form the generator produced; the rewritten twin covers the other.
- If a ported assertion disagrees with the generated keymap, the fix goes to the assertion (citing the fixture line) or to the parser. Upstream's fixtures are never copied.

**D6. Part C: macOS drag release on abort** (slice C1).
- `background_drag` and `global_pointer`'s drag arm share one stroke core: `stroke(path, checkpoint, post)`, where `post: FnMut(Stroke, (f64, f64)) -> CoreResult<()>`, `checkpoint: FnMut() -> CoreResult<()>`, and `Stroke` is `Down`, `Dragged` or `Up`.
- Each caller builds `post` from its own `post_mouse` or `post_global_mouse`. `pointer_prologue` and the initial move run before `stroke`, outside it.
- The rule: a press or motion counts as delivered once its post returned `Ok`. A post that returned `Err` delivered nothing (see Context) and gets no release.
- With `release_on_abort` on, an early exit after a successful `Down` (a checkpoint failure or a failed `Dragged` post) posts `Up` at the last point whose post returned `Ok`. If that `Up` fails, the original error is returned and the failure goes to `tracing::warn!`.
- A drag released mid-path drops whatever it carries at that point. Upstream does the same for strokes with no drag-and-drop session (`upstream:crates/pi-natives/src/desktop/macos/input.rs:2728-2734`).
- With the convar off, `stroke` posts exactly today's sequence, including today's early return.

**D7. Part C: macOS chord validation.**
- With `release_on_abort` on, `key_chord` resolves every key code before its first press (`chord_codes(keys) -> CoreResult<…>`, as libei already does at `crates/desktop/src/linux/wayland/libei.rs:433-436`). An invalid key then fails with today's `InvalidKey` or `InputFailed` code, and nothing is posted.
- No release tracker is needed. Once every code resolves, a press can fail only by the post failing, and that happens before delivery.

**D8. Gates.**
- Part A: `sv_computer_xkb_layout`. Part C: `sv_computer_release_on_abort`.
- Both are bool, default `false`, flags `archive`, with `ui.tab = "tools"` and `ui.group = "Computer"`.
- Labels: "Computer Wayland Keyboard Layout" and "Computer Release Held Input On Abort".
- They carry no `legacy.path`, because no OMPv1 setting maps to them.
- There is no Cargo feature: the code sits in `omp-desktop`, which is already behind `cap-computer` (`crates/envd/Cargo.toml:18`).
- Every slice may land behind its default-off convar on the recommendation stated here. Only turning a default on waits for the owner.

**D9. Part B, the macOS intervention guard, is deferred** to its own record, with the requirements under "Part B: deferred".
- It is a large design that cannot be proven in CI: no runner grants Input Monitoring.
- It needs owner rulings.
- Until it exists, a user typing in the app a run is driving is not detected. The agent's read-before-act habit narrows that window but does not close it.

**D10. libei release on abort is deferred.**
- The libei drag and click press modifiers and a button, then can leave early (`crates/desktop/src/linux/wayland/libei.rs:351-377`, `:379-410`). They run on the Linux desktop actor, where `operation_checkpoint()` never fails (see Terms), so a cancel does not reach them.
- What can strand a button is a later step failing: a path point outside every announced region (`move_absolute`, `:283-293`), or a missing button interface after the modifiers were pressed (`:389-391`).
- Fixing that, by validating every path point before pressing as upstream does (`upstream:crates/pi-natives/src/desktop/linux/wayland/libei.rs:496-517`), or by letting cancellation reach the actor, needs its own reviewed design (O13).

## Rejected options

- **Extend `evdev_char` with more layouts.** Unbounded, and still wrong for every layout it leaves out.
- **Link `libxkbcommon`.** A C dependency. `reis` 0.5.0 uses `xkbcommon` only as a dev-dependency. Running `xkbcli` once to generate fixtures adds no build dependency.
- **Fall back to the US table when the keymap cannot be read.** It brings back the silent wrong-character bug. Upstream refuses too.
- **No gate.** The brief requires default-off gates and forbids changing existing behaviour without the owner.
- **Unconditional fixes for the stuck drag button and the chord** (round 3, m3). Cheaper, but they change existing behaviour without the owner (brief lines 43-46). O8 asks to make them unconditional.
- **Set the libei flag once, when the shared actor is created.** Every later session would silently get the first session's setting (round 3, M1).
- **A release tracker in every macOS routine** (round 2's D6). Only the drag can be cancelled after a press, and resolving chord keys first removes the chord case (round 3, M3).
- **Copy upstream's `.xkb` fixtures.** They have no notice and no recorded provenance (`upstream:crates/pi-natives/src/desktop/linux/wayland/testdata/fr.xkb:1`).
- **Trim the fixtures to the keys the tests use.** The parser must be tested on a full compiled keymap.
- **Drop the US ASCII fast path.** It is optional. Keeping it ports upstream's rule and tests unchanged.
- **Return to the start point before an aborted drag's release.** Upstream does this only after a drag-and-drop session has begun, which omp2 cannot detect (O10).
- **Port the intervention guard now** (D9). **Port libei release now** (D10).

## Slices

Each slice is one PR. Tests are written first and are not edited to pass.

### Proof levels

- **No e2e proof in `crates/e2e`.** The harness has no desktop, and no CI runner grants a Wayland RemoteDesktop portal or macOS input access.
- **No golden journal.** No journal shape changes. This is a recorded deviation from the brief.
- **Proof is at the owning seams:**
  - `omp-desktop` unit tests on pure functions: parser, planning, the device transition function and the stroke core;
  - the existing envd settings test;
  - one in-process libei peer for A2.
- **The A2 peer.**
  - It lives in-crate under `#[cfg(test)]`, because `ActorLibei` is `pub(crate)`.
  - A `cfg(test)` constructor, `ActorLibei::from_context(ei::Context, runtime, targets)`, shares the handshake and discovery code with `new` (`crates/desktop/src/linux/wayland/libei.rs:70-98`).
  - The peer drives `reis::eis::Context::new(UnixStream)` with its synchronous `read`, `pending_request` and `flush` on a test thread (reis 0.5.0, `src/eis.rs:98-117`). No new `reis` feature is needed.
  - If the peer cannot be built, A2 does not merge.
- **Manual check before a default is flipped**, recorded in the flipping PR:
  - Part A on GNOME (Mutter) and on KDE (KWin) Wayland sessions with `us,fr`:
    - `type_text("é@aq\n")` is correct in each group;
    - a mid-session group switch changes the next call;
    - the number of events drained per call is logged once, to check the 256 cap;
    - convar-off sessions on the same process still type.
  - Part C on macOS: cancelling a run mid-drag leaves no button held; `[Ctrl, Char('é')]` leaves Ctrl released.

### A1. Layout-aware planning on Wayland, keymap read at discovery, behind `sv_computer_xkb_layout`

- **Scope:**
  - port `xkb.rs` with `FastHashMap`, adding the `omp-core` dependency;
  - fixtures and `crates/desktop/NOTICE` (D5);
  - `char_stroke`, the chord plan and the send sink (D3);
  - keymap read at discovery (D4, A1 part);
  - `InputOptions` plumbing for `xkb_layout` (D2);
  - the convar (D8);
  - a `crates/desktop/README.md` paragraph on the convar and its rule.
- **Acceptance:**
  - Eight ported `xkb.rs` tests (`upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:584-668`). `reads_the_keymap_from_the_start_of_a_shared_fd` runs under `cfg(target_os = "linux")`.
  - One new twin, `resolves_named_group_labels`.
  - The two ported `libei.rs` tests (`upstream:crates/pi-natives/src/desktop/linux/wayland/libei.rs:1117-1128`).
  - New unit tests:
    - `tab_and_return_use_fixed_keys_on_a_french_group`;
    - `character_absent_from_the_active_group_fails_before_any_key`;
    - `char_chord_on_azerty_plans_the_layouts_key`;
    - `altgr_plan_presses_in_order_and_releases_in_reverse`;
    - `duplicate_modifier_is_pressed_once`;
    - `no_keymap_refuses_ctrl_c_with_input_failed`.
  - `computer_settings_project_from_typed_convars` (`crates/envd/src/computer.rs:1847-1860`) is extended. Setting `sv_computer_xkb_layout` reaches `ComputerSettings`, and its `DesktopSessionOptions` carries it.
  - The existing `discovery_waits_for_every_granted_device` still passes.
- **Gate:** `sv_computer_xkb_layout`, default `false`.

### A2. Follow the active group: keep and drain the libei stream

- Depends on A1.
- **Scope:** D4's A2 part (stream kept and drained, the `DeviceChange` transition function, sticky disconnect, the drain before pointer commands too) and the peer.
- **Acceptance:**
  - Unit tests on the transition function:
    - `paused_keyboard_refuses_with_permission_denied`;
    - `removed_keyboard_refuses_with_permission_denied`;
    - `re_resumed_keyboard_uses_the_new_serial`;
    - `keyboard_added_after_removal_is_adopted`;
    - `disconnect_is_sticky`.
  - Peer tests:
    - `keyboard_modifiers_event_switches_the_group_used_by_the_next_type_text`;
    - `unsettled_event_stream_fails_before_sending_any_key`.
  - A convar-off command reads no events: `convar_off_command_leaves_the_stream_unread`, on the peer.
- **Gate:** `sv_computer_xkb_layout`. O1 may be asked only after A2.

### C1. macOS drag release and chord validation, behind `sv_computer_release_on_abort`

- **Scope:**
  - D6 (the shared `stroke` core, release at the last delivered point);
  - D7 (`chord_codes`);
  - `InputOptions` plumbing for `release_on_abort` (D2);
  - the convar (D8);
  - a `crates/desktop/README.md` paragraph.
- **Acceptance:** unit tests on `stroke` with recorded `(Stroke, point)` posts and an injected checkpoint (no `CGEvent` is created):
  - `cancel_mid_drag_posts_up_at_the_last_delivered_point`;
  - `failed_dragged_post_releases_at_the_previous_point`;
  - `failed_release_keeps_the_original_error`;
  - `convar_off_keeps_todays_early_return`;
  - `completed_drag_sequence_is_unchanged` (convar on or off).
- **Further acceptance:**
  - `invalid_key_after_a_modifier_posts_nothing`: macOS `key_chord` with a recording `post` closure. `chord_codes` fails before any event is built.
  - `computer_settings_project_from_typed_convars` is extended for `sv_computer_release_on_abort`.
- **Gate:** `sv_computer_release_on_abort`, default `false`.

Tracking: the STATUS.md row and any TASKS.md entry for these slices are kept by the gap orchestrator. Each slice PR names its row update.

## Part B: deferred

The round-1 resolutions for the guard stand as requirements for its future record:

- **Fixed fault text.** `native_fault` drops `DesktopError::message` (`crates/envd/src/computer.rs:1724-1755`). The code must be a typed `UserIntervened` with fixed text, never upstream's formatted app name (`upstream:crates/pi-natives/src/desktop/control/intervention.rs:169-179`).
- **A cancellable wait.** Today `OperationState` is only a flag and a deadline (`crates/desktop/src/lib.rs:62-75`).
- **Named default-off plumbing** (`docs/adr/0049-tiered-integration-architecture.md:47`), or a reasoned choice of a convar alone.
- **An omp-owned synthetic event tag.** Upstream's `0x7069_6465_736b` spells `pidesk` (`upstream:crates/pi-natives/src/desktop/control/macos.rs:20`).

Round 2's findings on the guard, all confirmed against source, are what that record must answer:

- **Round 2 B2.** Map every omp2 entry point and per-press site (`crates/desktop/src/macos/mod.rs:84-125`, `crates/desktop/src/macos/ax.rs:170-197`, `crates/desktop/src/macos/input.rs:56-132`). Decide the pid for `Target::Desktop`, which has none (`crates/desktop/src/types.rs:256-261`). Admit before focus moves, as upstream's `watch_app` does (`upstream:crates/pi-natives/src/desktop/mod.rs:1274`).
- **Round 2 M3.** `cancel` stores and notifies under the wait's mutex (`upstream:crates/pi-natives/src/desktop/control.rs:88-98`).
- **Round 2 M4.** State one wait bound, its function and where the run deadline is stored and cleared.
- **Round 2 M5.** Tap attribution and filtering by tag and source pid (`upstream:crates/pi-natives/src/desktop/control/macos.rs:413-440`), and one tagging choke point (`crates/desktop/src/macos/input.rs:572`, `:616`, `:656`, `:710`, `:927`, `:956`).
- **Round 2 M6 and M7.** The tap's lifecycle, its re-enable (`upstream:crates/pi-natives/src/desktop/control/macos.rs:375`, `:494`, `:596`), a permission preflight, and the classification tests (`:786-914`; the file is 929 lines).
- **Round 2 M8.** Panel routes with their call sites (`upstream:crates/pi-natives/src/desktop/macos/input.rs:98`, `:573`, `:862`), or drop them.
- **Round 2 M9, M10, M11.** A real-Mac acceptance procedure; CI for gated code, or no feature.
- **Round 2 M13.** No guard check between drag points without drag-session detection.
- **Round 3 B1, carried over.** The guard's waits and checks must run on a thread that sees the operation's cancellation. The Linux desktop actor does not (Terms).
- **Minors.** Round 2's m5, m7, m9, m11, m13, m14 and m15.

## Upstream origin and license

- Sources:
  - `upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs`;
  - `upstream:crates/pi-natives/src/desktop/linux/wayland/libei.rs` (`handle_event`, `refresh_devices`, `read_keymap`, `char_stroke`, `plan_keys`);
  - `stroke_path` in `upstream:crates/pi-natives/src/desktop/macos/input.rs`.
- Upstream is MIT (Mario Zechner, Can Bölük, Stencil Labs, Inc.; `upstream:LICENSE:1-5`), and `crates/desktop/NOTICE` keeps the notice.
- The fixtures are generated from xkeyboard-config 2.41 data, whose notices go in the same NOTICE.
- Nothing keeps a `pi` identity.

## Consequences

- With `sv_computer_xkb_layout` on, non-US Wayland users get the characters they typed and the chords they named, and from A2 on this follows layout switches.
- With that convar on, on a compositor with no usable keymap, every printable character and every `Char` chord (including `ctrl+c`) fails loudly instead of being sent through the US table.
- With `sv_computer_release_on_abort` on, a cancelled or expired macOS drag no longer leaves its button held, and an invalid macOS chord no longer leaves a modifier held. A drag aborted mid-path drops at its last delivered point.
- libei release on abort stays as it is today (D10).
- Accepted limitation: a character the layout lacks reaches the model as the generic "desktop input delivery failed" (`crates/envd/src/computer.rs:1730`) (O11).
- With either convar off, nothing changes for that session. One exception, by D4: on a process where another session drains the libei stream, a convar-off session sees the true device state.
- The intervention guard is still missing.

## What the review changed

D-numbers inside rounds 1 and 2 refer to the revision that round produced.

### Round 1 (Goldfish, five findings as recorded in STATUS.md row 0063)

1. **Release on abort mid-drag.** Confirmed against source.
   - `background_drag` leaves through `operation_checkpoint()?` after button-down (`crates/desktop/src/macos/input.rs:497-529`, `:513`), and so does the `global_pointer` drag arm (`:902-905`).
   - `key_chord` releases only after every press succeeds (`:684-698`).
   - Upstream always releases (`upstream:crates/pi-natives/src/desktop/control.rs:344-355`, `upstream:crates/pi-natives/src/desktop/macos/input.rs:2700-2735`, `:3621-3657`).
   - Changed: added release on abort. Round 2 made it the standalone Part C.
2. **Fixed `UserIntervened` text; `native_fault` drops messages.** Confirmed: `crates/envd/src/computer.rs:1724-1755`, against upstream's formatted text at `upstream:crates/pi-natives/src/desktop/control/intervention.rs:169-179`. Changed: fixed text and an argument-free constructor. Round 2 carried this into "Part B: deferred" as a requirement.
3. **The wait must be cancellable on the actor thread.** Confirmed: `crates/desktop/src/lib.rs:62-75`, against `upstream:crates/pi-natives/src/desktop/control.rs:205-216`. Changed: a condvar wait and a run deadline. Round 2 carried this into "Part B: deferred", with M3 and M4 added.
4. **Feature and convar plumbing.** Confirmed: the first draft declared neither (`crates/desktop/Cargo.toml:11-13`, `crates/envd/Cargo.toml:17-22`, `crates/app/Cargo.toml:24-43`). Changed: every link named, and the convars renamed `sv_computer_*` (`crates/envd/src/computer.rs:32-68`). Round 2 dropped the feature for Parts A and C (see M11) and kept the convars.
5. **`.xkb` fixture licence.** Confirmed: the upstream fixtures carry no notice (`upstream:crates/pi-natives/src/desktop/linux/wayland/testdata/fr.xkb:1`, "copyright" only as a keysym at `:1472`). Changed: generated fixtures plus a NOTICE. Round 2 replaced the evidence with xkeyboard-config's own `COPYING` (see m10).

Corrections found while verifying round 1:
- Upstream's tag spells `pidesk`.
- The test lists were incomplete: `upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:647`, `upstream:crates/pi-natives/src/desktop/control/intervention.rs:514`.
- A runtime test duplicated the compile-time exhaustive `match` (`crates/envd/src/computer.rs:1725`).
- A change to the `computer@3` description and its `Capabilities` output became owner questions (`crates/tools/src/computer.rs:494-502`, `:338-363`). Round 2 deferred both with Part B.

### Round 2 (Goldfish, four fresh reviewers and a synthesis: 2 blockers, 17 majors, 16 minors)

Each finding was verified against source before it was accepted or rejected.

- **B1 (blocker): the Wayland layout cannot track the active group.**
  - Confirmed. The event stream is dropped at `crates/desktop/src/linux/wayland/libei.rs:84-91`. `EiDevice` has no layout (`:45-48`). A grep finds no `KeyboardModifiers` in `crates/desktop/src`. Upstream drains its stream before each input (`upstream:crates/pi-natives/src/desktop/linux/wayland/libei.rs:316-414`).
  - Changed: D2 (stream ownership, `handle_event`, `refresh_devices` bounded at 256 events and 1 ms polls on the actor thread, device lifecycle) and EIS-peer seam tests in A1.
  - **Resolved.**
- **B2 (blocker): no omp2 call-site, admission or pid map for the guard.**
  - Confirmed. The draft's D9 cited only upstream lines. omp2's entry points are at `crates/desktop/src/macos/mod.rs:84-125`, and `Target::Desktop` carries no pid (`crates/desktop/src/types.rs:256-261`).
  - Changed: a scope cut. Part B is deferred to its own record (D9), with this finding as a requirement.
  - **Resolved for this record**, by not deciding the guard here.
- **M1: control characters and the no-keymap case.**
  - Confirmed: `upstream:crates/pi-natives/src/desktop/linux/wayland/libei.rs:871-896`, `:1117-1128`, and `upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:521-540`.
  - Changed: D3 ports upstream's `char_stroke` rule and refuses printable text without a keymap (no US fallback). The rejected-options list says why.
- **M2: chord scope and Shift-only sending.**
  - Confirmed: `crates/desktop/src/linux/wayland/libei.rs:429-451`, `:470-481`, `:567-569`, and `upstream:crates/pi-natives/src/desktop/linux/wayland/libei.rs:815-833`.
  - Changed: D3 routes chords through the layout and presses a modifier list released in reverse. A1 adds two tests.
- **M3 (lost wakeup), M4 (wait bound), M5 (tap attribution and tagging), M6 (tap lifecycle), M7 (size of the tap port), M8 (routes), M9 (real-Mac acceptance), M10 (CI for gated code).**
  - Confirmed. The citations are in "Part B: deferred", for example `upstream:crates/pi-natives/src/desktop/control.rs:88-98`, `upstream:crates/pi-natives/src/desktop/control/macos.rs:375`, `:494`, `:596` (re-enable) and `crates/desktop/src/macos/input.rs:616`, `:710`, `:927`, `:956` (unnamed event sites).
  - Changed: all move to Part B's future record.
- **M11: the three-crate feature chain is ceremony.**
  - Confirmed for Parts A and C. Their code sits in `omp-desktop`, already behind `cap-computer` (`crates/envd/Cargo.toml:18`, `crates/envd/src/lib.rs:28-29`). They add no dependency.
  - Changed: no Cargo feature. A default-off convar each (D4, D7). For Part B, left to its record.
- **M12: the release fix is gated behind the guard, and a test pins the bug.**
  - Confirmed: `crates/desktop/src/macos/input.rs:513`, `:684-698`, `:902-905`.
  - Changed: Part C is a standalone slice with its own convar (D7). The guard-off test is replaced by `completed_drag_sequence_is_unchanged`, which covers only the sequence that is not aborted.
  - Partly rejected: the fix is not ungated. The brief forbids changing existing behaviour without the owner and requires default-off gates (brief lines 43-46, 95-97). O8 asks to turn it on.
- **M13: releasing at the last point drops at an arbitrary place.**
  - Confirmed that upstream returns to the start only once a drag session has begun (`upstream:crates/pi-natives/src/desktop/macos/input.rs:2728-2734`).
  - Changed: the per-step guard check that made mid-path aborts frequent went with Part B. D6 keeps upstream's rule for strokes with no drag session (release at the last point) and states the drop. Drag-session detection is O10.
- **M14: B3 depends on B4 and has no seam.**
  - Confirmed: `background_drag` and `background_click` call `post_mouse` directly (`crates/desktop/src/macos/input.rs:362-415`, `:478-551`).
  - Changed: C1 needs no guard. D6 gives every routine post and checkpoint closures, and its tests use an injected failing checkpoint.
- **M15: drop the Part A convar.**
  - Rejected. The brief requires implementation behind a default-off gate and forbids changing existing tool behaviour without the owner (brief lines 43-46, 95-97). The silent-fallback concern is handled by D3's no-US-fallback rule. The `meta` part is accepted: D4 now carries `ui.tab`, `ui.group` and `ui.label` like `crates/envd/src/computer.rs:32-68`.
- **M16: fixtures and the recipe.**
  - Confirmed: upstream's tests hard-code keycodes and rewrite labels one way only (`upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:577-624`). The fixtures use `symbols[Group1]` (`upstream:crates/pi-natives/src/desktop/linux/wayland/testdata/fr.xkb`, `xkb_symbols` section).
  - Changed: D5 states the path, the group order and the generator versions recorded in the NOTICE; both label forms are tested; on a mismatch the assertion or parser is fixed and upstream's fixtures are never copied; `memfd_create` is under `cfg(target_os = "linux")`. The test names stay upstream's; "under omp names" was dropped.
- **M17: no rule for proceeding while owner questions are open.**
  - Confirmed: the draft's header and O-list gave none.
  - Changed: D8. O-questions are now referenced only after they are defined, or by number with "see Open questions".
- **m1: dead-code slices.** Confirmed: the draft's A1, B1 and B2 had no caller. Changed: the parser lands with its caller in one slice, A1. The other dead slices went with Part B.
- **m2: two decisions in one record.** Confirmed. Changed: Part B is deferred, and Parts A and C are authorised independently (D1, D8).
- **m3: the omp2 problem is never stated.** Confirmed. Changed: Context opens with the omp2 failures.
- **m4: undefined terms.** Confirmed. Changed: a terms paragraph at the top. Most of the undefined terms belonged to Part B and left with it.
- **m5, m7, m9, m11, m13, m14, m15.** Confirmed where they apply. All concern Part B and are listed under "Part B: deferred".
- **m6: inconsistent review status.**
  - Confirmed for the ADR's wording ("five reviewers' findings"), now "five findings".
  - Rejected for `docs/adr/STATUS.md:75`: the gap orchestrator owns that file, and this record proposes the row text in its report instead.
- **m8: distinct failures collapse into generic text.**
  - Confirmed: `crates/envd/src/computer.rs:1730`.
  - Changed: recorded as an accepted limitation in Consequences. O11 asks for a typed code. The draft's Part B `PermissionDenied` case went with Part B.
- **m10: licence evidence and the fallback.**
  - Confirmed: the draft cited a host file and a copy fallback that contradicted the draft's own rejection of copying.
  - Changed: D5 cites xkeyboard-config's `COPYING` at tag `xkeyboard-config-2.41` (190 lines, twelve copyright lines, no copyleft), and the copy fallback is removed.
  - Trimming the fixtures is rejected (see Rejected options).
- **m12: drop the US fast path.** Rejected as optional. Keeping it ports upstream's rule and tests unchanged (`upstream:crates/pi-natives/src/desktop/linux/wayland/libei.rs:877-884`).
- **m16: release state per routine.** Confirmed: `crates/desktop/src/macos/input.rs:684-698`. Changed: D6 lists what each routine tracks, including that clicks hold only between down and up.

### Round 3 (Goldfish, four fresh reviewers and a synthesis: 1 blocker, 13 majors, 18 minors; last round)

Each finding was verified against source. The confirmed blocker was closed only by removing scope.

- **B1 (blocker): the libei cancel premise is false.**
  - Confirmed. `OperationScope::enter` has one call site, on the session worker thread (`crates/desktop/src/lib.rs:740`). The Linux desktop actor (`crates/desktop/src/linux/actor.rs:50-57`, `:91`) never enters a scope, so `operation_checkpoint()` there (`crates/desktop/src/linux/wayland/libei.rs:366`, `:401`) always returns `Ok`.
  - Changed by a scope cut. libei release on abort is removed from Part C and deferred (D10, O13), along with its test and Context sentence. Part C is now macOS only.
  - The drain in D4 claims no cancellation. It is bounded by its cap instead, as stated.
  - The Terms paragraph now names the two threads separately.
  - **Closed.**
- **M1: the shared libei actor makes a creation-time flag wrong for later sessions.**
  - Confirmed: `crates/desktop/src/linux/actor.rs:121-135` (one `ActorLibei`, reference-counted), and commands without options (`:41-43`).
  - Changed: D2 carries the flag on each libei command.
- **M2: the plumbing is understated.**
  - Confirmed: `crates/desktop/src/lib.rs:300`, `:674-688`, `:852-854`; `crates/desktop/src/linux/mod.rs:15`; `crates/desktop/src/linux/wayland/mod.rs:36`; `crates/envd/src/computer.rs:1847-1860`.
  - Changed: D2 lists every hop, and the envd test is extended.
- **M3: the macOS click and chord premises are wrong; validate first.**
  - Confirmed. macOS checkpoints exist only at `crates/desktop/src/macos/input.rs:378`, `:513`, `:854` and `:904`, none of them in `key_chord`. Key codes are resolved lazily (`:702-711`). Posts fail only before delivery (`crates/desktop/src/macos/skylight.rs:207-229`, `crates/desktop/src/macos/input.rs:971-974`).
  - Changed: Part C shrinks to drag release (D6) plus chord validation (D7). The click tracker, the chord tracker and their tests are removed, and the Context is corrected.
- **M4: incomplete routine inventory.**
  - Confirmed for the libei Click (`crates/desktop/src/linux/wayland/libei.rs:351-377`). It is deferred with D10.
  - Rejected for libei `key_chord`/`type_text`: a send fails only for a missing keyboard interface, which fails the first send (`:323-327`), and all strokes are resolved first (`:457-466`; D3).
  - Rejected for macOS `pointer_prologue` and `type_text`: their posts fail only before delivery (M3 citations).
  - Changed: D3 states what happens when a send fails.
- **M5: one rule for a failed press.**
  - Confirmed: the round-2 bullets disagreed.
  - Changed: D6 has one rule, "delivered once its post returned `Ok`", justified by the macOS post functions failing only before delivery.
- **M6: no seam for the macOS routines.**
  - Confirmed: `crates/desktop/src/macos/input.rs:478-551`, `:883-913` call `post_mouse` and `post_global_mouse` directly.
  - Changed: D6 specifies the shared `stroke` core and its closure types. Tests record `(Stroke, point)` pairs and create no `CGEvent`.
- **M7: the device model after discovery.**
  - Confirmed: `crates/desktop/src/linux/wayland/libei.rs:45-48`, `:56-62`, `:186-262`, against `upstream:…/libei.rs:316-388`.
  - Changed: D4's A2 part specifies the transition function, adoption after removal, `resumed`, the serial model (omp2's, kept and stated), and the sticky disconnect, each with a unit test in A2.
- **M8: the missing-keyboard error code.**
  - Confirmed: today's `PermissionDenied` at `crates/desktop/src/linux/wayland/libei.rs:430-432`, `:454-456`, and upstream's at `upstream:…/libei.rs:707-711`.
  - Changed: D4 keeps `PermissionDenied`, and the A2 tests assert it.
- **M9: the retained stream with the convar off.**
  - Confirmed: the round-2 text left this undefined.
  - Changed: D4 says convar-off commands do not read the stream. That is the same as today, where the socket is not read after discovery (`crates/desktop/src/linux/wayland/libei.rs:57`, `:84-91`). A2 adds `convar_off_command_leaves_the_stream_unread`.
- **M10: the drain bound, "settled", and the pointer path.**
  - Confirmed: `upstream:…/libei.rs:389-414`.
  - Changed: D4 defines "settled", drains before pointer commands too (when the flag is on), states that the failure is retryable, sets the initial group to 0, and says there is no cancellation in the loop.
  - The event rate on real compositors is **unverified**. The manual check logs it on GNOME and KWin before O1.
- **M11: the peer is unscoped and A1 is oversized.**
  - Confirmed: `crates/desktop/src/linux/wayland/libei.rs:70-98`; reis 0.5.0 `src/eis.rs:98-117`.
  - Changed: A splits into A1 (parser and planning, keymap at discovery) and A2 (stream and device model). The peer is specified (in-crate, a `cfg(test)` constructor, synchronous `reis::eis`), and peer tests are cut to three.
  - D1 now states the shared plumbing struct and test.
- **M12: no seam for chord planning; dedupe unspecified.**
  - Confirmed: `upstream:…/libei.rs:815-833` skips duplicates.
  - Changed: D3 makes planning pure and execution a send sink, dedupes, and releases in reverse. A1 tests cover both.
- **M13: XKB vocabulary undefined.**
  - Confirmed.
  - Changed: Terms defines keymap, group, level, AltGr and the US ASCII fast path, from `upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:521-540`.
- **m1: flag-on regression without a keymap.** Confirmed (`crates/desktop/src/linux/wayland/libei.rs:517-570`). Changed: stated in D3 and Consequences. KWin is added to the manual check, and there is a test `no_keymap_refuses_ctrl_c_with_input_failed`.
- **m2: `release_posts_skip_the_checkpoint` holds by construction.** Confirmed: the post functions call no checkpoint (`crates/desktop/src/linux/wayland/libei.rs:323-340`; macOS `post_mouse`). Changed: the test is removed.
- **m3: weigh an unconditional fix.** Confirmed as a missing option. Changed: listed under Rejected options with the brief's rule. O8 asks to make it unconditional.
- **m4: Win32 and X11 answers are already in the tree.** Confirmed: `crates/desktop/src/win32/input.rs:324-341`; zero `operation_checkpoint` in `crates/desktop/src/linux/x11/input.rs`. Changed: settled in the Context. O8 keeps only Win32.
- **m5: altitude and history.**
  - Partly rejected: "What the review changed" is required by the review procedure.
  - Accepted: terms are now defined, O-labels point to "Open questions for the owner", and review labels carry their round.
- **m6: title, filename and STATUS row.** The title already names the scope. The filename is kept so that existing links (`docs/adr/STATUS.md:75`) still resolve. The STATUS row is the orchestrator's; its proposed text is in the PR.
- **m7: the brief's path and its rules.** Confirmed: the brief is not in the repository (`git ls-tree origin/omp2 docs/research/` lists no brief). Changed: its rules are quoted with line numbers, the two rules are reconciled explicitly, the e2e deviation is recorded, and the machine-reviewed statement is in "Review state".
- **m8: ADR 0049 is ambiguous.** Confirmed: three 0049 files exist in `docs/adr`. Changed: the record now cites `docs/adr/0049-tiered-integration-architecture.md`.
- **m9: ADR 0035 mis-cited for "never silent".** Confirmed: `docs/adr/0035-rust-for-the-engine.md:54-57` covers typed errors only. Changed: the never-silent rule is stated as this record's own.
- **m10: test counts and the label helper.** Confirmed. Changed: A1 says eight ported tests plus one new twin. D5 specifies the two-way rewrite of `symbols[` and `type[`.
- **m11: unverifiable licence and tool evidence.** Changed: D5 records the `COPYING` URL at its tag. The `xkbcli` flags stay unverified here, because `xkbcli` is not installed on the review host; the NOTICE records the command actually run.
- **m12: repository rules for the ported parser.**
  - Confirmed for `FastHashMap`. Changed: added, with the `omp-core` dependency, in "Rules that bind".
  - Rejected for the lintx baseline: `desktop` is absent from `tools/lintx/baselines/error-formatting.toml`, so its baseline is zero, not 86. Formatting a character is not counted (`tools/lintx/README.md:44-57`). The ported code avoids formatting error bindings.
  - Grapheme segmentation is not needed (typing stays per `char`).
- **m13: reuse check.** Confirmed (`Cargo.lock:2803-2817`). Changed: recorded in "Rules that bind".
- **m14: convar lifetime and `legacy.path`.** Confirmed: `crates/envd/src/computer.rs:76-84`, `:100-108`. Changed: D2 states that the convars are read once per computer session. D8 says why there is no `legacy.path`.
- **m15: the unsupported "race, not a hole" claim.** Confirmed. Changed: D9 is reworded without the claim, and Consequences no longer says "the only protection".
- **m16: wrong `block_on` citation.** Confirmed: only `crates/desktop/src/linux/actor.rs:91` is the loop, and the runtime is used at `:119`, `:126`, `:159`. Changed: D4 cites those lines.
- **m17: missing wiring tests, docs and tracking.** Confirmed. Changed: both slices extend `computer_settings_project_from_typed_convars`. A1 and C1 each add a `crates/desktop/README.md` paragraph. The tracking line is under Slices.
- **m18: "held on the user's desktop" is too broad.** Confirmed: `post_dual`/`post_keyboard` target a pid (`crates/desktop/src/macos/skylight.rs:207-229`). Changed: the Context separates background and global effects.

## Open questions for the owner

- **O1.** Turn `sv_computer_xkb_layout` on by default after A2 and the manual check? Recommendation: yes. It changes what is typed, from wrong to right. It also makes `Char` chords fail on a compositor without a keymap.
- **O2-O7, O9.** Part B questions. They move to Part B's record.
- **O8.** Turn `sv_computer_release_on_abort` on by default, or make D6 and D7 unconditional? And check the Win32 posted-message drag (`crates/desktop/src/win32/input.rs:324-341`)? Recommendation: yes to all. A held button after a cancel is never intended.
- **O10.** Port drag-and-drop session detection, so an aborted drag that lifted an item returns it to the start (`upstream:crates/pi-natives/src/desktop/macos/input.rs:2716-2734`)? Recommendation: yes, after C1.
- **O11.** Add a typed code for "the active layout cannot produce this character"? Recommendation: yes, additive, with the usual caveat for a new `FaultCode`.
- **O12.** Is the guard (Part B) still wanted as its own record? Recommendation: yes, after the owner rules on the `UserIntervened` code.
- **O13.** How should libei release on abort be done (D10): validate every path point before pressing, as upstream does, or let cancellation reach the Linux desktop actor? Recommendation: validate first. It fixes the failure that actually strands a button and needs no cross-thread state.

## Status in omp

**Status: Not started.** The design was machine-reviewed (EGM, 3 rounds) and is not owner-approved.

- Reusable today: `reis` (including `reis::eis` for the test peer), `xkeysym`, the Linux desktop actor and its runtime, the `sv_computer_*` convar path, `DesktopSessionOptions`, and the envd settings test.
- Slices A1, A2 and C1 land behind the default-off convars `sv_computer_xkb_layout` (A1, A2) and `sv_computer_release_on_abort` (C1). There is no new Cargo feature.

## References

- [docs/research/desktop-intervention-guard.md](../research/desktop-intervention-guard.md)
- [ADR 0035](0035-rust-for-the-engine.md) (typed errors)
- [ADR 0049 tiered integration architecture](0049-tiered-integration-architecture.md) (`cap-*` features)
- [ADR 0012](0012-convars.md) (convars)
- `crates/tui/NOTICE` (the bundled-data notice pattern)
- xkeyboard-config `COPYING` at tag `xkeyboard-config-2.41`
