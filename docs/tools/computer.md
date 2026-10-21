# computer Eval prelude

> Drive the real host desktop from Eval through direct `computer` helpers and window/element handles, or persistent JavaScript via `computer.run`: enumerate windows and displays, capture screenshots, send native input, use OS accessibility (AX), and access the clipboard. This is not the `browser` prelude and exposes no DOM.

User setup, permissions, safety guidance, examples, and platform limitations: [Scriptable computer use](../computer-use.md).

## Source

- Prelude factory and host service: `packages/coding-agent/src/tools/computer.ts`
- Direct-helper call renderer and approval policy: `packages/coding-agent/src/tools/computer/call.ts`
- Eval facades: `packages/coding-agent/src/tools/computer/{prelude.js,prelude.py,declarations.d.ts}`
- Model-facing prelude documentation: `packages/coding-agent/src/prompts/tools/computer.md`
- Computer-use prompt: `packages/coding-agent/src/prompts/system/computer-use.md`
- Prelude registration/gate: `packages/coding-agent/src/sdk.ts`
- Live prelude reconciliation: `packages/coding-agent/src/session/agent-session.ts`
- `/computer` toggle: `packages/coding-agent/src/slash-commands/builtin-modes.ts`
- Persistent worker: `packages/coding-agent/src/tools/computer/{supervisor,protocol,worker,worker-entry}.ts`
- Native implementation: `crates/pi-natives/src/desktop/`
- Native public types: `packages/natives/native/index.d.ts`

## Availability and declaration

- `computer.enabled` gates the Eval prelude and defaults to `false`. `/computer` toggles it for the current session without persisting settings.
- The prelude is available only through enabled Eval runtimes; it is not an AgentTool.
- The worker permits one active run; concurrent direct helpers/runs fail with `Computer worker is busy`. Capability inspection remains available during a run. The active Eval documentation and globals update with the current enabled state.
- Unlike `browser`, this prelude can operate IDEs, terminals, native applications, browser windows, and system dialogs. It has no browser DOM or web ARIA surface; its accessibility methods use the host OS.

## Settings

| Setting              | Type    |  Default | Contract                                                                                                                     |
| -------------------- | ------- | -------: | ---------------------------------------------------------------------------------------------------------------------------- |
| `computer.enabled`   | boolean |  `false` | Enable the Eval prelude.                                                                                                     |
| `computer.display`   | string  | `active` | Capture the display with the largest focused-window overlap (primary fallback); use `all` or a native display ID explicitly. |
| `computer.maxWidth`  | number  |   `3840` | Maximum screenshot width.                                                                                                    |
| `computer.maxHeight` | number  |   `2400` | Maximum screenshot height.                                                                                                   |
| `computer.backgroundFallback` | enum | `takeover` | When a window input call's background route is unavailable: `takeover` reruns that call once in takeover, returns focus to the user's app and reports it in the run output; `refuse` throws `BackgroundUnavailable` without taking over, and also refuses, before anything is sent, `takeover: true`, `raise()` and AX `raise`, `apps.open(…, { activate: true })`, `control.acquire`, input to the desktop or a display, off macOS `el.focus()`, and on macOS every call that opens a menu (right-click or Control-click, `perform("AXShowMenu")`, `press()`/`perform("AXPress")` or a left click, hold or drag on a popup button or menu button, `setValue` on a popup button) or passes `menu`, since an open menu takes the user's keyboard. |

There is no `computer.backend` setting. The native addon selects the platform backend.

For transports that do not preserve original image detail, and as a Claude-family compatibility fallback, the effective capture caps are `1280×896`. Other models retain the configured limits. The host snapshots cwd, session id, display, effective caps, and `read_only` for every run; the native desktop session itself remains persistent.

## Eval API

The `computer` global exposes the desktop helpers directly. Each helper is one host call (`action: "call"`) carrying an allowlisted method chain of at most two steps — a desktop root method, optionally followed by one method on the window or element handle it resolved — which the host renders into JavaScript and runs in the persistent session:

```js
const win = await computer.window({ app: "Code" });
await win.screenshot();
const tree = await win.ax({ maxDepth: 6 });
await win.ref("e12").press();
await computer.capabilities();
await computer.close();
```

Python uses the same helper names; keyword arguments become the trailing options object, and `win.raise_()` stands in for the keyword `raise`:

```python
win = await computer.window(app="Code")
await win.screenshot(silent=True)
tree = await win.ax(maxDepth=6)
await win.ref("e12").press()
await win.click(120, 48, button="right")
```

Handles are frozen snapshots plus proxy methods. `computer.window(...)` and `computer.focusedWindow()` resolve to a `ComputerWindow` carrying `id`, `app`, `title`, `pid`, `bounds`, and `focused`; `computer.ref(...)`, `win.ref(...)`, `win.find(...)`, `computer.elementAt(...)`, `computer.focusedElement()`, `el.parent()`, and `el.children()` resolve to `ComputerElement` values carrying `ref`, `role`, `nativeRole`, `title`, `description`, `enabled`, `focused`, and `childCount`. Window methods re-resolve through `desktop.window(id)` and element methods through `desktop.ref(ref)` on every call, so a closed window or expired ref fails at the call. Methods are non-enumerable, so displaying or serializing a handle shows its identity fields only.

`computer.run(fnOrCode, { args?, read_only?, timeout? })` runs a multi-step function or JavaScript string in the same session and returns the real structured value. JavaScript functions receive `{ desktop, wait, assert }` — `desktop` has the desktop helpers plus synchronous `capabilities()`, but not `run()` or `close()` — and cannot capture Eval-cell closures; `{ args: [...] }` passes plain data, functions, and regular expressions after the scope object. `args` that is neither an array nor `null`, or a non-empty `args` with a code string, throws before the run starts; `null` passes no arguments. Python `computer.run(code, read_only=..., timeout=...)` accepts a JavaScript string only. Nonempty text printed inside the run prints in the outer Eval cell; screenshots surface as Eval images. `read_only` defaults to `false`; `timeout` defaults to 120 seconds, is capped by a positive `tools.maxTimeout`, then clamped to 1–300 seconds. The host invocation schema rejects unknown fields; the JavaScript facade forwards only recognized run options. `computer.capabilities()` reports the native backend and permission state (`action: "capabilities"`); `computer.close()` ends the persistent desktop session.

Approval: a direct call is `read` when its terminal method is inspection-only (`displays`, `windows`, `window`, `focusedWindow`, `screenshot`, `zoom`, `elementAt`, `focusedElement`, `ref`, `clipboard.read`, `ax`, `find`, `value`, `bounds`, `attributes`, `actions`, `parent`, `children`) and `exec` for input, `raise`, `setValue`, `selectText`, `perform`, `press`, `click`, `focus`, and `clipboard.write`; read calls also run with the worker's read-only guard. `computer.run` is `read` only when `read_only === true`; malformed input, an omitted flag, or `false` is `exec`.

Runs have full host access and are not sandboxed. The persistent `JsRuntime` supplies `desktop`, `wait`, and `assert`, plus ordinary helpers such as `print`, `read`, `write`, `env`, and `tool`. Full Bun/Node files, processes, modules, and network APIs remain available. `wait(ms)` sleeps; `wait(predicate, { timeout?, interval? })` polls until truthy.

## Desktop API

The same surface is reachable as `computer.*` directly and as `desktop.*` inside `computer.run`.

### Discovery

- `desktop.windows({ app?, title? })` returns up to 48 matching `DesktopWindow[]`; app/title matching is case-insensitive substring matching. Each entry is a plain record `{ id, app, title, pid?, x, y, width, height, focused }` with flat coordinates, no `bounds` and no handle methods; Python gets a dict (`w["x"]`, `w.get("pid")`, since `pid` is absent where the platform does not expose it). `await desktop.window(w.id)` returns the facade.
- `desktop.window(id | { id?, app?, title? })` returns one persistent window facade. An id may be a string or a number (`74` is the id `"74"`, never matched against app or title). Zero matches throw with the open windows grouped by app as `id "title"`: apps matching the filter's `app` first (up to 10 windows each, titled before untitled), then the focused window's app, then the rest (up to 3 each), at most 12 apps, with overflow and unlisted windows counted, plus a line when no app matches. Multiple matches throw with the candidates.
- `desktop.focusedWindow()` returns a window facade or `null`.
- `desktop.displays()` returns `DesktopDisplay[]`.
- `desktop.capabilities()` returns capture/input/AX availability, `backgroundWindowInput` and `takeover` support, permission states, display server, backend, display count, and on macOS `screenLocked`/`displayAsleep`.

A window facade exposes immutable `id`, `app`, `title`, optional `pid`, `bounds`, and `focused` fields.

### Applications and display handles

- `desktop.apps.list({ query?, runningOnly? })` returns `{ id, name, path, running, pid? }[]`.
- `desktop.apps.open(idOrNameOrNativeAppPath, { activate? })` launches a native application; exact identities/paths precede unique names, and deliberate activation defaults off.
- `desktop.display(id | "active" | "all")` returns a display input target with an independent screenshot frame. A new `"active"` screenshot reselects its monitor; input and zoom use that last frame, and keyboard input cannot silently target another monitor.

macOS uses bundle/Launch Services identity, Windows includes registered/Start-menu/packaged applications, and Linux uses XDG desktop entries with argv or D-Bus activation. Missing platform services fail explicitly. Windows/Linux activation hints are advisory; PID is omitted when process attribution cannot be established.

### Screenshots and input

Both a selected window and `desktop` expose:

- `screenshot({ silent? }) -> { path, width, height, coordinateWidth, coordinateHeight, screenLocked? }`
- `zoom({ x, y, width, height }, { silent? }) -> { path, width, height, coordinateWidth, coordinateHeight, region, screenLocked? }`
- `click(x, y, { button?, count?, modifiers?, menu?, takeover? })`
- `doubleClick(x, y, { button?, modifiers?, takeover? })`
- `move(x, y, { takeover? })`
- `drag([[x, y], ...], { modifiers?, takeover? })`
- `scroll(x, y, { dx?, dy?, takeover? })`
- `type(text, { takeover? })`
- `press(chord | string[], { takeover? })`

A window also exposes `raise()`, `ax(...)`, `find(...)`, and `ref(...)`. Window input defaults to background delivery without deliberate activation or pointer movement. On macOS, background keys, key-event typing, left clicks, left-button drags and holds, and menu actions make the target window key only within its own application, so the user's application keeps keyboard focus; keystrokes wait until the application reports the target as focused and stop with `InputFailed` if another of its windows becomes key, keys for a window whose attached sheet or panel has focus throw `InvalidTarget` naming that window, and these actions on a non-key window of the frontmost application have no background route. macOS background modified clicks, right-clicks, Electron scrolls, middle-button drags and holds, and left-button drags and holds that start on a slider, scroll bar, splitter or stepper are delivered without moving the user's pointer; a left-button drag or hold that starts anywhere else has no background route, since it could start a drag and drop that macOS completes at the user's real pointer; a right-click or Control-click, or a click, `press()` or `perform("AXShowMenu")` on a menu button or popup button, that opens a menu in a background application closes it and throws `InputFailed` listing its items, because it was delivered (a takeover rerun would close it again when focus returns), unless the call passed `menu`: an item path, matched like `win.menu.select`, that the call presses in the menu it opened, returning with the menu closed. Right-button or Control drags and holds, right-clicks or Control-clicks with `count` above 1, gestures with modifiers or keys into Apple Screen Sharing, and presses into Tk 8.6 or later have no background route. When a call has no background route, `computer.backgroundFallback` decides: `takeover` reruns it once in takeover and returns focus to the user's app, `refuse` throws `BackgroundUnavailable`. `takeover: true` briefly activates the target and posts real input at once; reserve it for a background call a screenshot proves did nothing when AX cannot perform the action. Never replay uncertain input blindly. Desktop-root pointer helpers drive the user's real pointer, so prefer window handles. Pixel coordinates belong to the most recent full screenshot of the same target. Coordinate input before capture, after target/layout changes, or with another target's frame throws.

On macOS, Screen Sharing and iPhone Mirroring forward key codes, not text, so `type` there presses each character's key on the current keyboard layout (holding Shift or Option where needed) and throws `InvalidKey` before typing anything when no key types a character; takeover does not change that. Characters in `press` and `holdKeys` there take the layout's key the same way. Other targets receive typed text as event text. Screen Sharing reads modifiers and Caps Lock from the physical keyboard: background text, shortcuts or held keys needing Shift, Option, Control or Command throw `BackgroundUnavailable`, as does a background key while the user holds a modifier key or Caps Lock is on (`InputFailed` once earlier keys went out, so it is not rerun in takeover); takeover sends them as key presses.

Screenshots are PNGs written under the OS temp directory. Native capture is resized to the effective capture caps before both saving and displaying; both Eval runtimes preserve the original-detail image bytes and metadata, so Eval does not perform a second resize or encode. Unless `silent: true`, each capture emits a status text block and an image block. Details record captured dimensions, original source dimensions, and target.

Zoom requires a previous full capture of the same target. Its rectangle is in that full frame's pixels; a fresh native image is cropped before applying output caps. Zoom does not replace the stored click frame. `width`/`height` describe the returned image; `coordinateWidth`/`coordinateHeight` describe the unchanged full frame used for later input. Desktop zoom pins the originally captured display even if focus moves to another monitor. Window resizes and display-layout changes reject stale input/zoom with `InvalidCoordinateFrame`.

### Observation, menus, holds, and control

- `win.observe({ silent?, all?, maxDepth? })` returns screenshot metadata plus `{ ax, nodeCount, truncated }`, normally emitting both image and AX text. Capture/AX failure restores the previous delivered coordinate frame. When the AX text was emitted, the returned `ax` stays readable but is left out of the value's display, so a trailing `await win.observe()` shows the tree once: in JavaScript `ax` is non-enumerable (spread, `JSON.stringify` and `console.log` leave it out), and in Python the repr omits it. A `silent: true` observation keeps `ax` everywhere; values returned from `computer.run` are unchanged.
- `win.menu.items(path?)` lists `{ title, path, enabled, checked, hasSubmenu, shortcut? }[]`; `win.menu.select(path)` invokes one enabled unambiguous command in the target window's context. Both take a path as one title (`"File"`), an array (`["File", "Export…"]`), or separate arguments (`"File", "Export…"`). On macOS `menu.items` makes the window key in its own application first, so like `menu.select` it needs `exec` approval and is rejected in read-only runs, on every platform.
- `holdKeys(keys, { duration, takeover? })` and `holdMouse(x, y, { duration, button?, keys?, takeover? })` use seconds in `[0, 100]`. `drag` also accepts arbitrary `keys`. Held input is always released within the call, and on macOS also when the omp process dies or the native call panics mid-hold (see below).
- `desktop.control.acquire({ reason })` needs live human confirmation, returns `{ active: true }` or `{ active: false, reason }`, and holds native task ownership between calls. `reason` is `"denied"` when the user declined (or the confirmation was cancelled), `"no-ui"` when the session has no interactive UI to ask through, as in a subagent or headless run, where repeating the call cannot succeed, and `"unanswered"` when nobody answered before the confirmation expired, 5 seconds (a quarter of a shorter timeout) before the run's timeout, so the script still gets the answer; a late answer grants nothing, including through an ACP client that leaves its form on screen. `release()` revokes it; `state()` reads live state. Normal run retirement preserves an acquired grant, while interruption, task completion, and disposal revoke it. The grant does not change delivery: omitted takeover stays background; only `takeover: true` takes over. Under `computer.backgroundFallback: refuse`, `acquire` throws `BackgroundUnavailable` without asking, and each run releases a grant acquired before.
- `win.bringToCurrentSpace()` is macOS-only, verifies actual movement without switching Spaces/activating, and invalidates the old frame.

Menu/app labels are untrusted data. A takeover grant does not authorize unrelated external effects. Inspect `applications`, `menus`, `heldInput`, `spaces`, and `globalEscape` capabilities.

### Accessibility

- `win.ax({ all?, maxDepth? }) -> string` returns the native textual accessibility tree with `[ref=eN]` references.
- `win.find({ role?, title?, value?, limit? }) -> El[]` returns all native matches within the requested limit as an array; calling an element method or reading an element field on the array itself throws a `TypeError` that says to pick one first (`const [el] = await win.find(...)`).
- `await win.ref("e5") -> El` and `await desktop.ref("e5") -> El` resolve a live native reference. The handle `ref()` returns also takes element methods directly, so `win.ref("e5").click()` needs no inner `await`.
- `desktop.elementAt(x, y)` and `desktop.focusedElement()` return `El | null`.

`El` exposes snapshot fields `ref`, `role`, `nativeRole`, optional `title`/`description`, `enabled`, `focused`, and `childCount`, plus:

- reads: `value()`, `bounds()`, `attributes()`, `actions()`, `parent()`, `children()`;
- mutations: `setValue(value)`, `selectText(text, { prefix?, suffix?, select? })`, `perform(action, { menu? })`, `press({ menu? })`, `press(chord, { takeover? })`, `type(text, { takeover? })`, `click({ button?, count?, modifiers?, menu?, takeover? })`, `doubleClick({ button?, modifiers?, takeover? })`, and `focus()`.

`el.type(text)` and `el.press(chord)` address the element instead of whatever the window's focus is on. On macOS, a native text field, text area or combo box whose selection is settable takes `type` text by accessibility insertion at its own selection, sending no keys and moving no focus, in the background and in takeover alike. Otherwise, as for web and Electron fields and every chord, the element is focused, and keys go out through the window's background (or takeover) keyboard route only once its application reports that exact element as focused within 250 ms, even when the element refuses the focus request. Focus is confirmed once, before the first key, so a code input that moves focus to the next box per digit still fills; each background press is still checked against the window's key status. If the element never reports focus, nothing is sent and the call throws `BackgroundUnavailable` (`InputFailed` in takeover) naming the window that holds keyboard focus and the focused element's `ax()` line with a usable ref. On Windows, background `type` and `press` post straight to the element's own control window, such as a classic edit box, without moving focus or the foreground; a windowless element (WPF, WinUI, web content) throws `BackgroundUnavailable` with nothing sent, since focusing it would bring its window to the front, and takeover focuses it first. Linux focuses the element, then sends through the window's keyboard route.

On macOS, `press()` in a Mac Catalyst app first requests `AXScrollToVisible` when the element offers that action, then presses it: in those apps a press on a row scrolled out of view otherwise reports success and does nothing. A failed scroll request does not prevent the press.

On macOS, `setValue` on a date or time control (one whose `AXValue` is a date) takes ISO-8601: `YYYY-MM-DD` changes the day and keeps the control's time of day, `YYYY-MM-DDTHH:MM[:SS]` is local time, and a date-time followed by `Z` or `±HH:MM` is that exact instant. Anything else is refused before a write, naming these forms and the control's current date, as is a local time that daylight saving skips or repeats (add an offset to pick a repeated one).

On macOS, a ref whose element the app has since removed throws `StaleRef` from every element operation, without waiting for the snapshots to expire it. Some apps destroy an element and build an identical one in its place, as Automator does with a filter rule's popups when one of them changes. The `StaleRef` then names the one element of the window with the fields the ref was read with (role, subrole, role description, title, description, value, value description, help, identifier, URL), registered as a new ref: `e12 destroyed; e57 is the one element in the window with the role, labels and value e12 was read with…`. Nothing is sent to it, and `e12` keeps naming the destroyed element. Equal fields do not prove it is the same control, and they are the fields as that read saw them, not as any action since left them. A candidate is named only when the app reports the element destroyed; the ref came from an `ax()` or `find()` read of the whole window (not cut short by its node or depth limit, every element's fields and children answered) in which no other element had those fields; the window id still names the same window; and a read of the whole window now, at least as deep as that one, finds exactly one element with them. Otherwise the plain `StaleRef` stands.

On macOS, `setValue(value)` on a popup button (`popupbutton`) chooses the menu option titled exactly `value`: it opens a closed menu, presses the option, and confirms the choice by reading the popup's value back. No match, or several options with that title, throws with the available option titles, and a menu the call opened is closed again.

On macOS, `setValue(text)` on a native text field, text area or combo box replaces its whole value the way `win.type` inserts text, so the app handles the edit as typed input: a search field searches, and a field with suggestions may offer them. An unfocused field is focused first only when its app is not the frontmost one, where focusing it would move the user's caret; such a field, a secure text field, and an element without a settable selection are written through `AXValue` instead, which some apps show without storing. A background field focused for the write keeps its app's focus afterwards, since some apps drop an edit whose field loses focus before it is committed. Either way the field is read back, and a value other than `text` throws `AxFailed` naming what the field reads now (never for a secure field). Web content and terminals are refused before anything is written.

On macOS, `selectText(text, { prefix?, suffix?, select? })` writes `AXSelectedTextRange` so `text` is selected in the element's value, or with `select: "start" | "end"` places a caret before or after it; nothing is typed, the value is unchanged, and the user's focus and pointer stay put. `prefix` and `suffix` must directly surround the match and choose between repeats. A missing match, a match only outside that context, several matches, or a selection the element does not let AX set throws `AxFailed` saying which, before anything is written; so does an app that was in the background when the call started and came to the front before the write, since the user is working in it. The result `{ start, length, text, focused }` is the selection read back once the write has settled, in UTF-16 code units; a read-back that differs from the request throws instead. `focused` is the element's focus inside its own app. In an editable field, a following `type` or AX insertion replaces the selection when `focused` is true; otherwise call `focus()` first. A terminal's AX text is its displayed output, so selecting there does not move the shell's input cursor and typing does not replace the selection. Other platforms throw `Unsupported`.

AX actions need no screenshot. AX bounds and `desktop.elementAt()` use platform-native global desktop coordinates (logical points on macOS, physical pixels on Windows), not screenshot pixels. An element keeps its ref across AX snapshots; a ref throws `StaleRef` once its element is missing from the window's current and previous snapshots. A role or label change gives the element a new ref, and its old ref keeps working until it expires the same way.

### Clipboard

- `desktop.clipboard.read() -> string`
- `desktop.clipboard.write(text)`; rejected in read-only runs.

## Outputs

Direct helpers and `computer.run(...)` return the worker's structured value directly; window and element facades cross the boundary as their identity fields. The outer Eval cell prints nonempty text printed inside the run. Non-silent screenshots remain ordinary Eval image output. A run with no printed text and no return value emits no placeholder text. Combined printed text is subject to the shared inline byte cap; over-cap text is saved as a session artifact.

Result details contain the resolved `code`, `readOnly`, `screenshots`, optional structured `value`, and capability metadata (`backend`, `capturePermission`, `inputPermission`, `axPermission`). Each screenshot detail contains `path`, `width`, `height`, `coordinateWidth`, `coordinateHeight`, optional `sourceWidth`/`sourceHeight`, `region` and `screenLocked`, and `target`. Provider delivery uses ordinary text/image content with image detail `original`; it does not use provider Files or native `computer_call_output` metadata.

On macOS a screenshot taken behind the lock screen sets `screenLocked: true` and adds a note to its status text; a native error raised while the screen is locked or the display asleep ends with that state in parentheses; and a run that ends locked or asleep returns a leading `Note:` text block. None of these refuse input. While it is in use, the native session keeps the display awake with a `PreventUserIdleDisplaySleep` assertion held from an agent turn's first desktop call until the turn ends or a prompt waits for the user's answer (outside an agent turn or in a subagent, until five minutes after the last desktop call) or on close; see [macOS display sleep and the lock screen](../computer-use.md#macos-display-sleep-and-the-lock-screen).

## Flow and lifecycle

1. `createComputerPrelude(session)` defines the enabled-only global and its host-side invoker.
2. A direct helper renders its allowlisted call chain, and `computer.run(fnOrCode, options)` serializes a function when needed; the host resolves the JavaScript, clamps the timeout, computes effective image caps, creates the per-run snapshot (read-only for inspection chains), and asks the supervisor to execute it.
3. The supervisor lazily starts one crash-isolated Bun worker (10-second startup deadline) and forwards aborts. The worker rejects overlapping runs instead of queueing them.
4. The worker lazily creates one native `DesktopSession` and one persistent `JsRuntime`. Handles, screenshot coordinate frames, runtime variables, and recent AX refs survive successful calls.
5. Each run installs a run-scoped `desktop` facade plus `wait`/`assert`. AsyncLocalStorage prevents leaked asynchronous work from borrowing a later run's signal or read-only policy.
6. Native operations execute in the worker with cancellation tokens captured before NAPI scheduling. Mutations acquire an OS-backed cross-process input/focus lease; reads do not. Runtime `tool.*` calls cross back through the supervisor into the owning session tool bridge and inherit cancellation.
7. Abort, timeout, and normal run teardown synchronously retire that run's native generation, including unawaited queued operations. Delivery checks cancellation between events and releases held input during cleanup; later runs use a fresh generation. Clone-safe displays/return value and capabilities return to the host, and the worker remains alive.
8. A run timeout is followed by a 750 ms supervisor grace period. If the worker does not finish, it is terminated with `computer worker restarted; captures and ax refs were reset`; a later call starts a fresh worker.
9. A run made during the owning top-level agent session's turn (its `power.sleepPrevention` in-flight bracket) marks the native session to keep the display awake until released. When the turn ends, or a dialog opens that waits for the user's answer (`ask`, a tool or settings approval, a control confirmation, an extension prompt), the session sends `release-display` to each of its computer workers, which drops only that hold; the worker, runtime, frames and AX refs stay. A dialog with a deadline (`ask.timeout`, or a `timeout` in its dialog options) is not a wait: it settles on its own and the turn goes on, so the hold stays. Once the last open dialog settles with a prompt still in flight, the turn goes on: the session sends `resume-display`, so a run of the turn still active (one whose control confirmation the dialog was) holds the display again, as do the turn's later runs.
10. Session cleanup sends `close`, waits up to 1.5 seconds, then force-terminates as a bounded fallback. Owner-scoped cleanup closes every registered computer controller.

## Side effects

- Captures real windows or the selected desktop composite into provider context and writes PNGs to the OS temp directory.
- Sends real keyboard/pointer input. Window background delivery is intended to preserve focus, pointer, and window order; `takeover: true`, and the `computer.backgroundFallback: takeover` rerun of a refused background call, temporarily activate the target. Desktop-root pointer calls affect the user's real pointer. Under `computer.backgroundFallback: refuse`, every call that would activate an application, drive the user's pointer or keyboard, or on macOS open a menu (which takes the user's keyboard while open) is refused before anything is sent.
- Reads or writes the system clipboard.
- Executes full-access JavaScript and may invoke other session tools through `tool.*`.
- Keeps a native desktop session and Bun worker alive across calls.
- Does not launch a browser or fall back to browser automation.

## Errors and recovery

Native errors are surfaced as `ToolError` text prefixed by the stable code name:

- `PermissionDenied`, `CaptureFailed`, `InputFailed`, `BackgroundUnavailable`, `InputBusy`, `Cancelled`, `UserIntervened` (macOS)
- `WindowNotFound`, `InvalidTarget`, `InvalidKey`, `InvalidCoordinateFrame`
- `StaleRef`, `AxUnsupported`, `AxFailed`, `AxUnconfirmed`, `Timeout`, `Closed`, `Internal`
- `Unsupported`, `SpaceUnsupported`, `SpaceMoveDenied`

Prelude/worker errors include `Computer session is closed`, `Computer worker is busy`, `Timed out starting computer worker`, `Computer code execution timed out after <ms>ms`, read-only mutation errors, and the worker-restart message above. A missing or mistyped text argument fails before any native call, naming the helper and parameter: `setValue(value) requires a string, got undefined`.

`AxUnconfirmed` (macOS) means an AX action was requested but its outcome could not be confirmed: the app did not reply in time or messaging failed, for example because the action opened a modal dialog. It may already have taken effect, so observe the window before repeating it.

`UserIntervened` (macOS) means the user pressed a key or clicked in the app the call was aimed at. A listen-only tap, started when the session first reads or acts on an app, records the user's keys and clicks (and input a tool such as dictation posts for them) per app the session has touched; a later process that reuses a touched app's process id starts untouched. Input into a process that draws a window for the app, such as the one that draws its Open or Save panel, counts as input into the app. Keys already being typed, including keys held around a takeover click, drag or `holdMouse`, stop at the user's first key or click there: keys sent before it may have landed, nothing more is sent, and releases still go out. A left click, background or takeover, and any takeover click do not press once the user has pressed a key or clicked there since the call began, so such a multi-click can stop after its first click; a background right or middle click checks only before it starts, and a press under way, drags and scrolls are not interrupted mid-gesture. Later input or mutation aimed at that app (window input, `menu.select`, `raise`, `bringToCurrentSpace` including for a window on another Space, and element `setValue`/`selectText`/`perform`/`press`/`type`/`click`/`focus`) waits until the user has left it alone for 5 s, or until 250 ms before the run's timeout or the native request's 3-minute limit, then throws `UserIntervened` without sending anything, naming the app and how long ago its last input came. Each such call throws until a `screenshot`, `zoom`, `observe`, `ax` or `find` of one of the app's windows begins at least 5 s after that input and its result is delivered; reads before then still succeed. Other apps are unaffected, as is desktop- or display-level input. Without event-listening access (Input Monitoring) the tap sees no input and nothing is detected.

`InputBusy` means another native operation owns input/focus and no input was sent. A listen-only Escape monitor, armed for takeover input only (`takeover: true`, any operation under held control, desktop/display-level input, raises and activating launches), cancels on physical Escape anywhere and ignores synthetic events. Native sessions count those stops under a key the supervisor picks (`escapeStopKey`; host cancels, retirement and release never count), and the supervisor reads the count with `desktopEscapeStops(key)`, so a stop survives a worker restart and is seen even when no run reported it. Each agent session has its own supervisor and key, so a stop refuses only that session's later calls, not a parent's or a subagent's. Within a run, every native access checks the count first and after it settles, so a script that catches the cancelled operation sends nothing more; the stopped call's error keeps what the native operation reported (a failed restoration, a key left held) ahead of the stop. A count above what the user's latest message acknowledged fails the call that was running and refuses every later run and capabilities call before messaging the worker; `AgentSession` acknowledges the count on the user's own prompt, steer, follow-up or user-initiated custom prompt, never on synthetic or agent-attributed messages. Without held control, background window input and semantic AX actions arm no monitor: the user's own Escape cancels nothing, and only the host interrupt (the tool call's abort signal) or the run timeout stops them. On macOS, without event-listening access (Input Monitoring turned off for the launching app) the monitor sees no input and `globalEscape` reports `false`; a monitor that fails to start refuses takeover input with `PermissionDenied`. `Cancelled` may follow partial input or an atomic OS/AX operation: cancellation cannot undo effects already delivered.

Recover by refreshing the exact target screenshot after coordinate-frame errors, taking a new AX snapshot after `StaleRef`, and inspecting `desktop.capabilities()` for platform/permission failures. A background refusal reaches the script as `BackgroundUnavailable` only when `computer.backgroundFallback` is `refuse`, the call set `takeover: false`, or the backend has no takeover; otherwise the tool has already rerun the call in takeover and the run output says `<method> ran in takeover because <reason>; the input was delivered, and <where focus ended>`. Under `refuse`, a foreground request is `BackgroundUnavailable` too: the message says the user's setting keeps the agent in the background and names the background route where there is one. After partial-delivery or restoration errors, inspect the target before retrying because input may already have landed. After `UserIntervened`, read that window again and continue from what it shows, keeping the user's edits.

## Platform constraints

Current native backends support macOS, Linux X11, Linux Wayland portal capture/input where available, and Windows; other targets depend on native-addon support. Capabilities and permission state are runtime facts—inspect `desktop.capabilities()` rather than assuming them. Wayland compositors do not permit omp to activate arbitrary windows, so per-window native input and `raise()` are unavailable; use AX actions, or desktop input after focusing the target yourself. See [Scriptable computer use: Platforms](../computer-use.md#platforms) for prerequisites and permission details.

macOS capture uses ScreenCaptureKit on 14+ in one persistent native main-loop worker per desktop session, with raw pixels over private pipes: no per-screenshot process launch or intermediate PNG. Native CoreGraphics handles macOS 12/13. The optional Wayland PipeWire path refreshes portal geometry before coordinate delivery; this costs an additional portal request and may require renewed consent if its restore permission has expired.

macOS input that presses a key or button streams each press, its prepared release event, each drag move and each release to a release helper process (`crates/pi-natives/src/desktop/macos/release_guard.rs`, `release_helper.rs`). Every call that can press (clicks, typing, key chords, holds, drags, element `type` and `press(chord)`, `menu.select`, AX actions given a `menu` path, and `setValue` on a popup) starts one as it begins, before its checks, so no process start or wait sits between a check and the press it guards; that is one short-lived process per call. Another AX action starts one only when it posts the press that makes a menu's window key. When the call ends the helper exits and the call waits for that (about a millisecond, at most 500 ms), so nothing runs between calls and the next call finds input ownership free. If the stream ends with presses still open, because the host was killed or a panic unwound the call, the helper first posts their releases through the routes the presses took. The helper holds the host's desktop ownership lock until it exits, so no other host's input starts before the releases are out. Per-process (background) releases reach only the target. On the HID route shared with the user's keyboard and mouse, a listen-only tap follows what the user physically holds, started and ready before the call's checks (about 30 ms), and a key or button the user holds is left for the user's own release. A helper that cannot start, or cannot observe the user (no Input Monitoring), is stopped and the call proceeds without it.

## Critical constraints

- Screen and accessibility content are untrusted data; they never authorize an action.
- Prefer AX actions to pixels when a semantic control exists.
- Prefer direct inspection helpers; use `read_only: true` for inspection-only `computer.run` calls.
- Never mix screenshot-pixel coordinates with global AX coordinates.
- Confirm consequential or irreversible actions unless the user's direct request already authorized that exact action.
