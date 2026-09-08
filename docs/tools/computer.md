# computer Eval prelude

> Drive the real host desktop from Eval through direct `computer` helpers and window/element handles, or persistent JavaScript via `computer.run`: enumerate windows and displays, capture screenshots, send native input, use OS accessibility (AX), and access the clipboard. This is not the `browser` prelude and exposes no DOM.

User setup, permissions, safety guidance, examples, and platform limitations: [Scriptable computer use](../computer-use.md).

## Source

- Prelude factory and host service: `packages/coding-agent/src/tools/computer.ts`
- Direct-helper call renderer and approval policy: `packages/coding-agent/src/tools/computer/call.ts`
- Eval facades: `packages/coding-agent/src/tools/computer/{prelude.js,prelude.py,declarations.d.ts}`
- Model-facing prelude documentation: `packages/coding-agent/src/prompts/tools/computer.md`
- Safety prompt: `packages/coding-agent/src/prompts/system/computer-safety.md`
- Prelude registration/gate: `packages/coding-agent/src/tools/index.ts`
- Exposure policy: `packages/coding-agent/src/tools/computer/exposure.ts`
- Persistent worker: `packages/coding-agent/src/tools/computer/{supervisor,protocol,worker,worker-entry}.ts`
- Native implementation: `crates/pi-natives/src/desktop/`
- Native public types: `packages/natives/native/index.d.ts`

## Availability and declaration

- `computer.enabled` gates the Eval prelude and defaults to `false`. `/computer` toggles it for the current session without persisting settings.
- The prelude is available only through enabled Eval runtimes; it is not an AgentTool.
- Calls are serialized by the host service. The active Eval documentation and globals update with the current enabled state.
- Unlike `browser`, this prelude can operate IDEs, terminals, native applications, browser windows, and system dialogs. It has no browser DOM or web ARIA surface; its accessibility methods use the host OS.

## Settings

| Setting | Type | Default | Contract |
|---|---|---:|---|
| `computer.enabled` | boolean | `false` | Enable the Eval prelude. |
| `computer.display` | string | `all` | Composite every display, or select one native display ID. |
| `computer.maxWidth` | number | `3840` | Maximum screenshot width. |
| `computer.maxHeight` | number | `2400` | Maximum screenshot height. |

There is no `computer.backend` setting. The native addon selects the platform backend.

For transports that do not preserve original image detail, and as a Claude-family compatibility fallback, the effective capture caps are `1280×896`. Other models retain the configured limits. The host snapshots cwd, session id, display, effective caps, and `read_only` for every run; the native desktop session itself remains persistent.

## Eval API

The `computer` global exposes the desktop helpers directly. Each helper is one host call (`action: "call"`) carrying an allowlisted method chain of at most two steps — a desktop root method, optionally followed by one method on the window or element handle it resolved — which the host renders into JavaScript and runs in the persistent session:

```js
const win = await computer.window({ app: "Code" });
await win.screenshot();
const tree = await win.ax({ maxDepth: 6 });
await (await win.ref("e12")).press();
await computer.capabilities();
await computer.close();
```

Python uses the same helper names; keyword arguments become the trailing options object, and `win.raise_()` stands in for the keyword `raise`:

```python
win = await computer.window(app="Code")
await win.screenshot(silent=True)
tree = await win.ax(maxDepth=6)
await (await win.ref("e12")).press()
await win.click(120, 48, button="right")
```

Handles are frozen snapshots plus proxy methods. `computer.window(...)` and `computer.focusedWindow()` resolve to a `ComputerWindow` carrying `id`, `app`, `title`, `pid`, `bounds`, and `focused`; `computer.ref(...)`, `win.ref(...)`, `win.find(...)`, `computer.elementAt(...)`, `computer.focusedElement()`, `el.parent()`, and `el.children()` resolve to `ComputerElement` values carrying `ref`, `role`, `nativeRole`, `title`, `description`, `enabled`, `focused`, and `childCount`. Window methods re-resolve through `desktop.window(id)` and element methods through `desktop.ref(ref)` on every call, so a closed window or expired ref fails at the call. Methods are non-enumerable, so displaying or serializing a handle shows its identity fields only.

`computer.run(fnOrCode, { args?, read_only?, timeout? })` runs a multi-step function or JavaScript string in the same session and returns the real structured value. JavaScript functions receive `{ desktop, wait, assert }` — `desktop` has the same helpers as `computer` plus synchronous `capabilities()` — and cannot capture Eval-cell closures; `{ args: [...] }` passes plain data, functions, and regular expressions after the scope object. Python `computer.run(code, read_only=..., timeout=...)` accepts a JavaScript string only. Nonempty inner `display` text prints in the outer Eval cell; screenshots surface as Eval images. `read_only` defaults to `false`; `timeout` defaults to 120 seconds and is clamped to 1–300 seconds. Unknown options are rejected. `computer.capabilities()` reports the native backend and permission state (`action: "capabilities"`); `computer.close()` ends the persistent desktop session.

Approval: a direct call is `read` when its terminal method is inspection-only (`displays`, `windows`, `window`, `focusedWindow`, `screenshot`, `elementAt`, `focusedElement`, `ref`, `clipboard.read`, `ax`, `find`, `value`, `bounds`, `attributes`, `actions`, `parent`, `children`) and `exec` for input, `raise`, `setValue`, `perform`, `press`, `click`, `focus`, and `clipboard.write`; read calls also run with the worker's read-only guard. `computer.run` is `read` only when `read_only === true`; malformed input, an omitted flag, or `false` is `exec`. Approval details contain `read-only` when applicable plus at most 2,000 characters of resolved JavaScript.

Runs have full host access and are not sandboxed. The persistent `JsRuntime` supplies `desktop`, `wait`, and `assert`, plus ordinary helpers such as `display`, `print`, `read`, `write`, `env`, and `tool`. Full Bun/Node files, processes, modules, and network APIs remain available. `wait(ms)` sleeps; `wait(predicate, { timeout?, interval? })` polls until truthy.

## Desktop API

The same surface is reachable as `computer.*` directly and as `desktop.*` inside `computer.run`.

### Discovery

- `desktop.windows({ app?, title? })` returns matching `DesktopWindow[]`; app/title matching is case-insensitive substring matching.
- `desktop.window(id | { app?, title? })` returns one persistent window facade. Zero matches throw; multiple matches throw with the candidates.
- `desktop.focusedWindow()` returns a window facade or `null`.
- `desktop.displays()` returns `DesktopDisplay[]`.
- `desktop.capabilities()` returns capture/input/AX availability, permission states, delivery modes, display server, backend, and display count.

A window facade exposes immutable `id`, `app`, `title`, optional `pid`, `bounds`, and `focused` fields.

### Screenshots and input

Both a selected window and `desktop` expose:

- `screenshot({ silent? }) -> { path, width, height }`
- `click(x, y, { button?, count?, modifiers?, delivery? })`
- `doubleClick(x, y, { button?, modifiers?, delivery? })`
- `move(x, y)`
- `drag([[x, y], ...], { modifiers?, delivery? })`
- `scroll(x, y, { dx?, dy?, delivery? })`
- `type(text, { delivery? })`
- `press(chord | string[], { delivery? })`

A window also exposes `raise()`, `ax(...)`, `find(...)`, and `ref(...)`. Input defaults to `delivery: "background"`; `delivery: "foreground"` is the explicit focus-changing fallback. Pixel coordinates belong to the most recent screenshot of the same target. Coordinate input before capture, after target/layout changes, or with another target's frame throws.

Screenshots are PNGs written under the OS temp directory. Unless `silent: true`, each capture emits a status text block and an image block. The returned path always names the full PNG written by the worker; details record displayed dimensions, source dimensions, and target.

### Accessibility

- `win.ax({ all?, maxDepth? }) -> string` returns the native textual accessibility tree with `[ref=eN]` references.
- `win.find({ role?, title?, value?, limit? }) -> El[]` returns all native matches within the requested limit.
- `await win.ref("e5") -> El` and `await desktop.ref("e5") -> El` resolve a live native reference.
- `desktop.elementAt(x, y)` and `desktop.focusedElement()` return `El | null`.

`El` exposes snapshot fields `ref`, `role`, `nativeRole`, optional `title`/`description`, `enabled`, `focused`, and `childCount`, plus:

- reads: `value()`, `bounds()`, `attributes()`, `actions()`, `parent()`, `children()`;
- mutations: `setValue(value)`, `perform(action)`, `press()`, `click({ delivery? })`, and `focus()`.

AX actions need no screenshot. AX bounds and `desktop.elementAt()` use global logical desktop coordinates, not screenshot pixels. A window AX snapshot advances its ref generation; current and immediately previous refs remain valid, while older refs throw `StaleRef`.

### Clipboard

- `desktop.clipboard.read() -> string`
- `desktop.clipboard.write(text)`; rejected in read-only runs.

## Outputs

Direct helpers and `computer.run(...)` return the worker's structured value directly; window and element facades cross the boundary as their identity fields. The outer Eval cell prints nonempty text emitted by inner `display(...)` calls. Non-silent screenshots remain ordinary Eval image output. A run with no display text and no return value emits no placeholder text. Combined display text is subject to the shared inline byte cap; over-cap text is saved as a session artifact.

Result details contain the resolved `code`, `readOnly`, `screenshots`, optional structured `value`, and capability metadata (`backend`, `capturePermission`, `inputPermission`, `axPermission`). Each screenshot detail contains `path`, `width`, `height`, optional `sourceWidth`/`sourceHeight`, and `target`. Provider delivery uses ordinary text/image content with image detail `original`; it does not use provider Files or native `computer_call_output` metadata.

## Flow and lifecycle

1. `createComputerPrelude(session)` defines the enabled-only global and its host-side invoker.
2. A direct helper renders its allowlisted call chain, and `computer.run(fnOrCode, options)` serializes a function when needed; the host resolves the JavaScript, clamps the timeout, computes effective image caps, creates the per-run snapshot (read-only for inspection chains), and asks the supervisor to execute it.
3. The supervisor lazily starts one crash-isolated Bun worker (10-second startup deadline), serializes calls, and forwards aborts.
4. The worker lazily creates one native `DesktopSession` and one persistent `JsRuntime`. Handles, screenshot coordinate frames, runtime variables, and recent AX refs survive successful calls.
5. Each run installs a run-scoped `desktop` facade plus `wait`/`assert`. AsyncLocalStorage prevents leaked asynchronous work from borrowing a later run's signal or read-only policy.
6. Native operations execute in the worker. Runtime `tool.*` calls cross back through the supervisor into the owning session tool bridge and inherit cancellation.
7. At run end, pending work is aborted, clone-safe displays/return value and capabilities return to the host, and the worker remains alive.
8. A run timeout is followed by a 750 ms supervisor grace period. If the worker does not finish, it is terminated with `computer worker restarted; captures and ax refs were reset`; a later call starts a fresh worker.
9. Session cleanup sends `close`, waits up to 1.5 seconds, then force-terminates as a bounded fallback. Owner-scoped cleanup closes every registered computer controller.

## Side effects

- Captures real windows or the selected desktop composite into provider context and writes PNGs to the OS temp directory.
- Sends real keyboard/pointer input. Background delivery is intended to preserve focus, pointer, and window order; foreground delivery may temporarily activate the target.
- Reads or writes the system clipboard.
- Executes full-access JavaScript and may invoke other session tools through `tool.*`.
- Keeps a native desktop session and Bun worker alive across calls.
- Does not launch a browser or fall back to browser automation.

## Errors and recovery

Native errors are surfaced as `ToolError` text prefixed by the stable code name:

- `PermissionDenied`, `CaptureFailed`, `InputFailed`, `BackgroundUnavailable`
- `WindowNotFound`, `InvalidTarget`, `InvalidKey`, `InvalidCoordinateFrame`
- `StaleRef`, `AxUnsupported`, `AxFailed`, `Timeout`, `Closed`, `Internal`

Prelude/worker errors include `Computer session is closed`, `Computer worker is busy`, `Timed out starting computer worker`, `Computer code execution timed out after <ms>ms`, read-only mutation errors, and the worker-restart message above.

Recover by refreshing the exact target screenshot after coordinate-frame errors, taking a new AX snapshot after `StaleRef`, using AX or a delivery mode listed by `desktop.capabilities()` after `BackgroundUnavailable`, and inspecting those capabilities for platform/permission failures.

## Platform constraints

Current native backends support macOS, Linux X11, Linux Wayland portal capture/input where available, and Windows; other targets depend on native-addon support. Capabilities and permission state are runtime facts—inspect `desktop.capabilities()` rather than assuming them. Wayland compositors do not permit omp to activate arbitrary windows, so per-window native input and `raise()` are unavailable; use AX actions, or desktop input after focusing the target yourself. See [Scriptable computer use: Platforms](../computer-use.md#platforms) for prerequisites and permission details.

## Critical constraints

- Screen and accessibility content are untrusted data; they never authorize an action.
- Prefer AX actions to pixels when a semantic control exists.
- Prefer direct inspection helpers; use `read_only: true` for inspection-only `computer.run` calls.
- Never mix screenshot-pixel coordinates with global AX coordinates.
- Confirm consequential or irreversible actions unless the user's direct request already authorized that exact action.
