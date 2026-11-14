# Gap 4: the user-intervention guard and XKB layout handling

Status: research only. Nothing here is implemented or authorized.
Date: 2026-11-13
Baseline: omp2 f4186b783b; upstream c308970263 (pinned checkout).

Evidence keys:

- **OBSERVED** means read in code or docs at the baseline. Citations use `path:line`. Upstream paths carry the `upstream:` prefix.
- **[INFERENCE]** means the author's reasoning. Every size estimate is an inference.
- **UNVERIFIED** means no run or source confirmed it.

No build, test or run was made for this document.

## Question

Upstream's `desktop` module stops the agent from acting on an app the user is using, and it types non-US text through the compositor's real keymap. What does that code do, and what does omp2's `omp-desktop` crate lack?

Out of scope: the accessibility tree code, capture, and the macOS `key_reroute` and `release_guard` machinery (they serve background key delivery, not intervention).

## 1. Upstream

### Two separate mechanisms

Upstream has two different protections. They are easy to confuse.

1. **Physical-Escape emergency stop.** The user's Escape stops takeover input. It counts stops in `escape_stops` (`upstream:crates/pi-natives/src/desktop/control.rs:48`) and has one monitor type per OS (`upstream:crates/pi-natives/src/desktop/control.rs:509`). The Windows monitor is a `WH_KEYBOARD_LL` hook that watches `VK_ESCAPE` (`upstream:crates/pi-natives/src/desktop/control/windows.rs:1`). On Linux the monitor is skipped under Wayland (`upstream:crates/pi-natives/src/desktop/control/linux.rs:25`) and uses an X11 listener otherwise (`upstream:crates/pi-natives/src/desktop/control/linux.rs:30`).
2. **User-intervention guard.** It protects the agent's last read of an app from the user's own input. The module header states the rule: input aimed at an app the user has used since the session last read it waits for the user to pause, then fails without sending, so the agent reads again; input already being sent stops at the user's first key or click (`upstream:crates/pi-natives/src/desktop/control/intervention.rs:1-7`).

### The guard's state machine (macOS)

- **Per-app record** `App`: process start time, a count of the user's inputs, and `unread`, the time of the last user input that no read has shown yet (`upstream:crates/pi-natives/src/desktop/control/intervention.rs:28`). The start time tells a new process reusing a pid from the old one (`upstream:crates/pi-natives/src/desktop/control/intervention.rs:81`).
- **Routes.** The user can type into a helper process that draws an app's Open or Save panel. A `Route` maps that helper's pid to the app, so the input counts for the app (`upstream:crates/pi-natives/src/desktop/control/intervention.rs:40`, `upstream:crates/pi-natives/src/desktop/control/intervention.rs:101`). A reused helper pid takes none of the app's input (test at `upstream:crates/pi-natives/src/desktop/control/intervention.rs:514`).
- **Quiet period.** `QUIET` is 5 s (`upstream:crates/pi-natives/src/desktop/control/intervention.rs:24`). A read clears `unread` only when the read began at least `QUIET` after the last user input (`upstream:crates/pi-natives/src/desktop/control/intervention.rs:133`). A read made while the user is typing therefore does not count as having seen their changes.
- **Admission before sending.** `admit` loops: no unread input means the call proceeds and a watch starts. If the user last acted at least `QUIET` ago, it fails at once with `UserIntervened` ("the user was using X; nothing was sent"). If the user is still active, it waits until they pause, up to a limit just before the run deadline (`upstream:crates/pi-natives/src/desktop/control/intervention.rs:147`). The error text always ends with "read the window again ... before acting on it" (`upstream:crates/pi-natives/src/desktop/control/intervention.rs:25`).
- **Mid-call abort.** `InputWatch` keeps a thread-local baseline of the input count (`upstream:crates/pi-natives/src/desktop/control/intervention.rs:187`). `check_press` runs before each key press, pointer press, accessibility action or write; if the count changed it fails, so at most the press already under way lands after the user's (`upstream:crates/pi-natives/src/desktop/control/intervention.rs:232`). Call sites are many: for example `upstream:crates/pi-natives/src/desktop/macos/ax.rs:1219`, `upstream:crates/pi-natives/src/desktop/macos/ax/menus.rs:119` and `upstream:crates/pi-natives/src/desktop/macos/ax/open_menu.rs:356`.
- **Listener lifecycle.** `Listener` starts the tap lazily at the session's first read or input and stops it on drop. Without event-listening permission the tap does not start, nothing is recorded and no input waits (`upstream:crates/pi-natives/src/desktop/control/intervention.rs:261`).
- **Tests.** Seven unit tests cover the pause rule, the deadline, routes, pid reuse and the wait ending before the native request times out (`upstream:crates/pi-natives/src/desktop/control/intervention.rs:351`, `upstream:crates/pi-natives/src/desktop/control/intervention.rs:376`, `upstream:crates/pi-natives/src/desktop/control/intervention.rs:425`, `upstream:crates/pi-natives/src/desktop/control/intervention.rs:451`, `upstream:crates/pi-natives/src/desktop/control/intervention.rs:484`, `upstream:crates/pi-natives/src/desktop/control/intervention.rs:536`). The `Listener::simulated` and `record_for_test` hooks let them run without an OS tap (`upstream:crates/pi-natives/src/desktop/control/intervention.rs:314`, `upstream:crates/pi-natives/src/desktop/control/intervention.rs:329`).

### How the macOS tap tells the user from the agent

- `UserInputMonitor` is a listen-only tap on the annotated session tap, with a mask of key-down and the three mouse-down types (`upstream:crates/pi-natives/src/desktop/control/macos.rs:663`, `upstream:crates/pi-natives/src/desktop/control/macos.rs:34`, `upstream:crates/pi-natives/src/desktop/control/macos.rs:430`). It listens during background input and between calls, not only during takeover.
- `observe_user` reads the event's source user data, source pid, target pid and location, then records the input against the target process (`upstream:crates/pi-natives/src/desktop/control/macos.rs:487`).
- An event is the user's if it lacks omp's synthetic tag and does not come from this process. That includes dictation tools that post under their own pid (`upstream:crates/pi-natives/src/desktop/control/macos.rs:413`). One known shape, an untagged left press at the origin from another process, is treated as another omp's make-key record and ignored (`upstream:crates/pi-natives/src/desktop/control/macos.rs:417`).
- A key with no named target goes to the front process; a click with no target is dropped (`upstream:crates/pi-natives/src/desktop/control/macos.rs:443`). A compile-time assertion fails the build if a mask type has no such rule (`upstream:crates/pi-natives/src/desktop/control/macos.rs:451`).

### X11

`linux/x11/activity.rs` is the X11 counterpart for takeover only. It reads XI2 raw presses by source device. omp's virtual MPX devices are never the user's. The core XTEST devices carry takeover's own presses and also tools such as x11vnc and xdotool, so a press beyond the ones this session sent is someone else's (`upstream:crates/pi-natives/src/desktop/linux/x11/activity.rs:1-9`). It raises `UserIntervened` in three places (`upstream:crates/pi-natives/src/desktop/linux/x11/activity.rs:131`, `upstream:crates/pi-natives/src/desktop/linux/x11/activity.rs:149`, `upstream:crates/pi-natives/src/desktop/linux/x11/activity.rs:220`). The product docs say a takeover first waits until the user has pressed nothing for 5 s, never past the run timeout, and refuses if the XI2.2 listener cannot start (`upstream:docs/computer-use.md:269`, `upstream:docs/computer-use.md:271`).

### Wayland and Windows

- Wayland: no intervention guard. The Escape monitor returns `None` there (`upstream:crates/pi-natives/src/desktop/control/linux.rs:25`). A search for `intervention` and `user_intervened` under `linux` and `win32` matched only three X11 files (`activity.rs`, `input.rs`, `named_change_tests.rs`).
- Windows: only the Escape hook (`upstream:crates/pi-natives/src/desktop/control/windows.rs:1`). No user-input guard.
- The documented contract is platform-scoped: `UserIntervened` is listed as macOS (`upstream:docs/computer-use.md:284`) and the physical-Escape text is at `upstream:docs/computer-use.md:265`.
- Error code: `UserIntervened` is one variant of `ErrorCode` with a `user_intervened` constructor (`upstream:crates/pi-natives/src/desktop/error.rs:10`, `upstream:crates/pi-natives/src/desktop/error.rs:84`).

### XKB layout handling (Wayland, libei)

- libei hands over the compositor's compiled textual keymap. `KeyboardLayout` parses `xkb_keycodes`, types and per-group symbol levels directly and never borrows a key from another group, because libei has no portable way to change the active group and a failed switch would type the wrong glyph (`upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:1-7`, `upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:57`).
- The keymap fd shares its file offset with the compositor's copy, which may sit at EOF, so the bytes are read positionally from offset 0 (test: `upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:585`).
- Behaviours with tests: numeric group labels (`upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:602`), French levels and AltGr (`upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:617`), only the active group resolves in a multi-layout keymap (`upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:627`), a modifier event that changes group changes resolution (`upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:638`), NumLock does not change non-keypad levels (`upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:659`) and CapsLock uses the alphabetic type map (`upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:668`).
- The libei backend reads the keymap from the device and falls back to no layout (`upstream:crates/pi-natives/src/desktop/linux/wayland/libei.rs:860`). `char_stroke` resolves a character through the layout, with a US-ASCII fast path only when the group is US (`upstream:crates/pi-natives/src/desktop/linux/wayland/libei.rs:876`). Two real keymaps (`fr.xkb`, `us-fr.xkb`) are checked in as test data (`upstream:crates/pi-natives/src/desktop/linux/wayland/libei.rs:1125`).
- macOS reads the active input source per call (`upstream:docs/computer-use.md:159`). X11 has its own map in `linux/x11/keymap.rs` (651 lines; not read in depth for this document, so its group handling is UNVERIFIED).

## 2. omp2 inventory

omp2 has the same crate shape (`omp-desktop`: session facade, actor thread, per-OS backends) but none of the guard.

- The crate describes itself as capture, input and accessibility automation for three OSes; there is no mention of user input or takeover (`crates/desktop/README.md:1-4`).
- No `takeover`, `UserIntervened`, physical-Escape, `UserInputMonitor` or event-tap code exists. A count of those terms across `crates/desktop/src`, `crates/tools/src/computer.rs` and `crates/envd/src/computer.rs` found only two unrelated lines in `crates/desktop/src/macos/input.rs` (`crates/desktop/src/macos/input.rs:958`, `crates/desktop/src/macos/input.rs:960`, both `set_integer_value_field`).
- Error codes: `ErrorCode` has no `UserIntervened` (`crates/desktop/src/error.rs:3`). It has `InvalidKey` (`crates/desktop/src/error.rs:23`) and `BackgroundUnavailable`. The tool layer's `FaultCode` mirrors those and has no intervention fault (`crates/tools/src/computer.rs:389`).
- Cancellation exists only as run cancel and deadline: `OperationState` holds `cancelled` and `deadline` (`crates/desktop/src/lib.rs:62`). Nothing in it knows about the user.
- Delivery has two modes, `Background` and `Foreground` (`crates/desktop/src/backend.rs:12`). omp2 has no takeover mode and no input-lease concept.
- macOS events are posted with a plain `CGEventSource` and no synthetic tag (`crates/desktop/src/macos/input.rs:572`, `crates/desktop/src/macos/input.rs:656`). The module sets the local-events suppression interval to 0 (`crates/desktop/src/macos/input.rs:236`). A listen-only tap could not tell omp's events from the user's without a tag. [INFERENCE]
- Wayland typing is US-only. `type_text` maps each char through `evdev_char` and fails for anything else with "libei cannot type character ... with the announced evdev keymap" (`crates/desktop/src/linux/wayland/libei.rs:453`, `crates/desktop/src/linux/wayland/libei.rs:460`). `evdev_char` is a fixed table of US-layout evdev codes (`crates/desktop/src/linux/wayland/libei.rs:572`). It does not read the compositor keymap, so on a French or Dvorak layout it types the wrong glyphs without error. [INFERENCE]
- X11 looks up a keycode by keysym in the first two columns of the server's keyboard mapping and errors when none matches (`crates/desktop/src/linux/x11/input.rs:494-510`). This respects the live layout but not other groups.
- Dependencies: `reis`, `x11rb` (with `xinput` and `xtest`) and `xkeysym` are already present (`crates/desktop/Cargo.toml:25-33`, `Cargo.toml:214`, `Cargo.toml:326`, `Cargo.toml:328`). The `wayland/xkb.rs` parser upstream is hand-written and needs no new crate.

### Gap table

| Capability | Upstream | omp2 | Gap |
|---|---|---|---|
| macOS user-input tap, per-app unread/quiet logic | yes (`intervention.rs`, `macos.rs`) | none | full port, medium |
| Synthetic-event tag on posted events | yes (`SYNTHETIC_EVENT_TAG`, `upstream:crates/pi-natives/src/desktop/control/macos.rs:20`) | none | prerequisite for the tap |
| `UserIntervened` error code and tool fault | yes | none | small, but a public contract change |
| Mid-call abort (`check_press`) | yes, many call sites in `macos/ax*` | none | requires a hook at each press |
| X11 takeover guard (XI2 raw) | yes | none (no takeover mode) | blocked on takeover concept |
| Wayland guard | none | none | no gap |
| Windows guard | none (Escape hook only) | none | no gap |
| Physical-Escape emergency stop | macOS, X11, Windows | none | separate feature |
| XKB group-aware typing (libei) | yes, parsed keymap | fixed US table | functional gap on non-US layouts |
| X11 non-US typing | own keymap module | server mapping, 2 columns | partial |
| Keymap test data | `fr.xkb`, `us-fr.xkb` | none | add with the parser |

## 3. Class

**Class c (port)**, in two independent parts.

- Part A, group-aware XKB typing on Wayland: port. Upstream has a working Rust parser and tests; omp2 types through a fixed US table (`crates/desktop/src/linux/wayland/libei.rs:572`). This is a correctness bug on non-US layouts.
- Part B, the macOS user-intervention guard: port, after a decision. It adds one error code and one event tag, and it needs the Input Monitoring permission.
- Not ported now: the X11 takeover guard and the Escape monitors. omp2 has no takeover mode (`crates/desktop/src/backend.rs:12`), so they have nothing to attach to. That is an open question, not a slice.

Verdict: implement Part A; Part B after owner agreement; the rest research only.

Superseded on 2026-11-14 by ADR 0063 after EGM round 2:

- Part A proceeds.
- A release-on-abort fix (Part C) is added. After round 3 it covers macOS only.
- Part B is deferred to its own record. Round 2 found that its omp2 call sites, pid source, tap lifecycle and CI coverage were all undesigned.
- One correction to section 2 below: omp2's libei backend drops its event stream after discovery (`crates/desktop/src/linux/wayland/libei.rs:84-91`). So reading the keymap once is not enough; the stream has to be drained before each input.

## 4. Options

### Part A: typing on a non-US Wayland layout

1. **Build on existing omp2 code.** Extend `evdev_char` with more tables. Cost: low for one layout, unbounded for the rest, and still wrong for any layout it does not list. Fit: poor.
2. **Port upstream `xkb.rs`** (676 lines, std only) with its two keymap test files. Cost: 1 to 2 days. Fit: good. It reads the compositor's own compiled keymap, so every layout works, and no new dependency is needed. `reis`, `x11rb` and `xkeysym` are already in the crate (`crates/desktop/Cargo.toml:25-33`).
3. **Link `libxkbcommon`.** Cost: a C dependency in a Rust-only workspace, plus build and packaging work on every platform. Fit: poor.

Choice: option 2. [INFERENCE]

### Part B: the macOS guard

1. **Build on existing omp2 code.** Before each input call, compare the frontmost app's pid with the target's using the AX focus code omp2 already has. Cost: about a day. It catches an app switch but not typing inside the target app, which is the case upstream cares about. Fit: weak.
2. **Port upstream `intervention.rs` and the tap.** Cost: 4 to 7 days. Fit: good. It needs a synthetic-event tag, a listen-only tap and `UserIntervened`.
3. **Do nothing.** The agent already re-reads before acting, so the gap is a race, not a hole. Cost: zero.

Choice: option 2, behind a default-off convar, once the owner accepts the new error code. Option 3 is acceptable if that code is refused. [INFERENCE]

## 5. Plan

ADR 0063 supersedes this first-draft plan. It was revised 2026-11-14 after three EGM rounds; it is machine-reviewed and not owner-approved.

- Slices: A1, A2 and C1.
  - A1: layout-aware planning on Wayland, with the keymap read at discovery. Gated by `sv_computer_xkb_layout`.
  - A2: the libei event stream is kept and drained before each input, and a device model follows the active group. Same convar.
  - C1: macOS drag release on abort, plus validating every chord key before pressing. Gated by `sv_computer_release_on_abort`.
- Two parts are deferred:
  - The macOS intervention guard (Part B below), to its own future record.
  - libei release on abort. Round 3 found that cancellation never reaches the Linux desktop actor thread.

The plan below is kept as the original research record.

### Slice A1: layout parser (no behaviour change)

- Port `xkb.rs` and the two `.xkb` test files into `crates/desktop/src/linux/wayland/`.
- Acceptance: unit tests ported from `upstream:crates/pi-natives/src/desktop/linux/wayland/xkb.rs:602-668` pass with no display: French levels and AltGr, numeric group labels, only the active group resolves, NumLock and CapsLock rules.
- Ships dead: nothing calls it yet.

### Slice A2: use the layout in `type_text`

- Read the keymap fd from the libei keyboard device (upstream does it in `read_keymap`, `upstream:crates/pi-natives/src/desktop/linux/wayland/libei.rs:860`), keep it on the device, and resolve each character through it. Keep the US table as the fast path only when the active group is US. When no stroke exists, return `InputFailed` naming the character and the group.
- Acceptance: a French keymap fixture types `e-acute` and `@` with the keycodes and modifiers the keymap dictates; a character absent from every level fails with a typed error; US typing is unchanged (the existing libei tests still pass).
- Gate: default-off convar `sv_desktop_xkb_layout` for one release, then default-on. Open question 1 asks whether a gate is wanted for a pure bug fix.

### Slice B1: event tag and error code

- Add `ErrorCode::UserIntervened` (`crates/desktop/src/error.rs:3`) and the matching `FaultCode` (`crates/tools/src/computer.rs:389`); tag every event omp posts (`crates/desktop/src/macos/input.rs:572`, `crates/desktop/src/macos/input.rs:656`).
- Acceptance: a test posts an event and reads back the tag from the event source user data; the fault code round-trips through the tool layer's serde tests.
- Gate: the code is unused until B2, so it ships with `cap-desktop-guard` off. Adding an enum variant is additive, but both enums are wire-visible, so the owner must agree first.

### Slice B2: the guard

- Port `intervention.rs` (state machine, `QUIET` of 5 s, `admit`, `check_press`) and the macOS `UserInputMonitor`; call `check_press` before each press and AX action in `crates/desktop/src/macos/input.rs` and `crates/desktop/src/macos/ax.rs`; give `OperationState` a cancellable wait (`crates/desktop/src/lib.rs:62`).
- Acceptance: the upstream state-machine tests, ported with a simulated listener, pass headless; an integration test with the listener off shows input is never blocked when the tap cannot start.
- Gate: feature `cap-desktop-guard` plus default-off convar `sv_desktop_intervention_guard`.

### Slice B3: documentation and prompt

- Tell the computer tool's prompt that `UserIntervened` means read again; document the Input Monitoring permission.
- Acceptance: the tool prompt snapshot test changes only by the new paragraph.

## 6. Open questions

1. Does a pure bug fix (Part A) need a default-off gate under the additive-only rule? It changes what is typed on non-US layouts, from wrong to right.
2. Does the owner accept a new `UserIntervened` variant in two wire-visible enums? Without it Part B cannot ship.
3. Should omp2 grow a takeover mode at all? The X11 guard and the Escape stops depend on it. That is a product decision larger than this gap.
4. Privacy. The tap sees every key and click system-wide. Upstream stores only a pid and a time. Do the same and never log key codes. [INFERENCE]
5. False positives. A dictation tool or a remote desktop posts under another pid and counts as the user. That matches upstream's intent (`upstream:crates/pi-natives/src/desktop/control/macos.rs:413`) but will make the agent wait.
6. Wait cost. `admit` can block up to the run deadline. omp2's `OperationState` has a deadline but no wait primitive (`crates/desktop/src/lib.rs:62`). ADR 0063 defers the guard. It records this as a requirement for the guard's own record: a lost-wakeup-free condvar wait that cancel wakes.
7. UNVERIFIED: the X11 map's group handling upstream (`linux/x11/keymap.rs`), and whether omp2's X11 path behaves on a non-US layout. Neither was run.
8. Conflicts with locked ADRs: none found. ADR 0006 (sandbox policy) is about sandboxing, not desktop input.

## 7. Upstream origin and license

A port would draw from `upstream:crates/pi-natives/src/desktop/control/intervention.rs`, `control/macos.rs`, `linux/wayland/xkb.rs`, `linux/wayland/libei.rs` and the two `testdata/*.xkb` files. The upstream `LICENSE` is MIT, with copyright lines for Mario Zechner, Can Bölük and Stencil Labs, Inc. (`upstream:LICENSE:1-5`). A port keeps that notice. The `.xkb` testdata are compiled keymaps derived from xkeyboard-config.

- OBSERVED: they carry no copyright or licence header. The only "copyright" in `fr.xkb` is a keysym (`upstream:crates/pi-natives/src/desktop/linux/wayland/testdata/fr.xkb:1472`).
- OBSERVED: xkeyboard-config's terms are X11/MIT-style permission notices that require the notice in all copies, with no copyleft clause. This was read from the Debian `xkb-data` 2.41 `copyright` file.
- OBSERVED: xkeyboard-config's own `COPYING` at tag `xkeyboard-config-2.41` agrees: 190 lines, twelve copyright lines, no copyleft clause.
- ADR 0063 D5 generates omp2's own fixtures with `xkbcli compile-keymap` and records the command and the versions in a new `crates/desktop/NOTICE`. Upstream's fixtures are not copied.
