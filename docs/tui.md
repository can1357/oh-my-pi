# TUI integration for extensions and custom tools

This document covers the **current** UI contract used by `packages/coding-agent` and `packages/tui` (`@oh-my-pi/pi-tui`) for extension UI, custom tool UI, and custom renderers.

## What this subsystem is

The runtime has two layers:

- **UI library (`packages/tui`)**: reactive runtime and JSX, the retained node tree, a native backend (Tern Surface Protocol) and a terminal backend (layout, per-kind painters, focus/input widgets, frame writer), the terminal driver (I/O), text and theme.
- **Integration layer (`packages/coding-agent/src/ui/**`, `src/modes/**`)**: the interactive shell, screens, tool presenters, and the controllers that mount extension/custom-tool views, wire keybindings/theme, and restore the composer.

## Runtime behavior by mode

| Mode                | `ctx.ui.custom(...)` availability | Notes                                                                                                                          |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Interactive TUI     | Supported                         | View is shown in place of the composer or as an overlay, focused, and must call `done(result)` to resolve.                     |
| Background/headless | Not interactive                   | UI context is no-op (`hasUI === false`).                                                                                       |
| RPC mode            | Not mounted                       | `custom()` is implemented as unsupported UI and returns `undefined as never`; do not depend on interactive UI in RPC handlers. |

If your extension/tool can run headless, guard with `ctx.hasUI` / `pi.hasUI`. RPC can expose `hasUI === true` for protocol-backed dialogs while still not supporting `custom()`; `hasUI` alone does not guarantee a component can be mounted.

## Project-local TUI debug tool

`.omp/tools/tui.ts` provides the repository's `tui` debug tool. `start` accepts
either a TypeScript/JavaScript `file` (run with Bun; under the compiled `omp`
binary, the `bun` on `PATH`) or an executable `bin` with separate `args`.
Windows uses native ConPTY without requiring a POSIX shell; macOS/Linux use
Bun's PTY.
The debug connection uses a Windows named pipe or a POSIX Unix socket.
On Windows, `start` and `resize` use the native `normalizePtyDimensions(cols, rows)`
helper, which returns integer dimensions clamped to 20–400 columns and 5–200 rows.
The PTY, emulated screen, and reported size use the same effective dimensions.

`screen`, `send`, `resize`, and `stop` also work for programs without an
`OMP_TUI_DEBUG` server. Renderer queries (`info`, `tree`, `values`, and `frame`)
require an omp/pi-ui host: `startHost` (`packages/tui/src/host.ts`) lazily loads
the server in `packages/tui/src/debug/server.ts` when `OMP_TUI_DEBUG` is set.
`packages/tui/examples/debug-demo.tsx` is a minimal host to try them on.

The server answers one JSON object per line:

| Op | Answer |
| --- | --- |
| `text` | `lines` on screen in the last presented frame (the fullscreen layer's rows on the alternate screen), `window_top` (history rows above the viewport), `alt_screen`, `cursor` (`{x, y, visible}`, absent when hidden). `no frame painted yet` before the first frame. |
| `frame` | `lines`: every history row the terminal acknowledged writing, then the screen rows. |
| `tree` | `root`: a `surface` node holding `main` and `dock` region nodes; `overlays`: one entry per `layer` node with `band` (its `anchor`/`size`) and `hidden`. Nodes carry `kind`, `id` (the node key), `hidden`, `focused`, and `focusable` (the terminal renderer routes keys to the kind's widget). |
| `values` | For each node with a terminal widget, and the focused node: its wire props (without `term` and function props) and widget state, keyed `kind#key` or `kind[region:index.index…]`. |
| `info` | `columns`, `rows`, `pid`, `native`, `overlays` (layer nodes), `focused` (kind), `focus` (`region:keypath`), `alt_screen`, `cursor`. |
| `doc` | `doc`: each region described as its native (TSP) tree (`describeTree`), plus the focus keypath. Served in both renderers. |
| `tsp` | `native`, and `frames`: the last TSP frames a native surface sent (64 kept; `n` limits). |
| `keys`, `bytes`, `paste`, `mouse` | Inject input: chords and literals are encoded as terminal bytes, decoded by the driver's input decoder, and delivered to the driver's input listeners, so interceptors, focus routing, and `onKey` see them as real input. `paste` delivers one paste event. |
| `quit` | Answers, stops the host, exits 0. |

There are no component rects: overlay `band`s are the layer node's
`anchor`/`size` props, `values` reports props and widget state, and `doc`
describes the live surface. A native (Tern) surface has no
terminal frames: `text` and `frame` answer `native surface: the terminal
renders it`; use `doc`, `tsp`, `tree`, and `values` there.

`send` accepts literal text and `\e`, `\r`, `\n`, `\t`, and `\xNN` escapes.
On Windows, each payload must contain complete, valid UTF-8; invalid or truncated
sequences are rejected before any input is written. Arbitrary non-UTF-8 bytes
(such as `\x9b` 8-bit CSI) are not supported by the Windows PTY string API.
Use the UTF-8-compatible `\e[` CSI sequence instead. macOS/Linux preserve raw bytes.

Install the tool's dependencies with `bun install --cwd .omp/tools`.
Native PTY API changes require rebuilding the addon with
`bun --cwd=packages/natives run build` before running the tool.
Run its real-PTY regressions with `bun test ./.omp/tests/tui.test.ts`. CI runs
them on Linux only; the Windows-specific cases run only on a local Windows host.

## Component model (`@oh-my-pi/pi-tui`)

- **Signals** (`packages/tui/src/reactive.ts`): `signal`, `computed`, `effect`, `batch`, `untrack`, `onCleanup`, contexts. Synchronous and glitch-free.
- **JSX without a compiler** (`jsx-runtime.ts`, `element.ts`): start a `.tsx` file with `/** @jsxImportSource @oh-my-pi/pi-tui */`. Function components run once; a function passed as a prop or child is reactive. Control flow: `Show`, `For`, `Index`, `Switch`/`Match`, `Dynamic` (`flow.ts`).
- **Nodes** (`node.ts`): lowercase tags create retained `UiNode`s. Their kinds are the TSP wire kinds (`col`, `row`, `text`, `md`, `code`, `card`, `spinner`, `list`, `picker`, `editor`, …) plus the terminal-only `canvas`. A node has reactive props, children, a `key`, and handlers (`onSelect`, `onActivate`, `onAction`, `onChange`, `onEdit`, `onSend`, `onKey`, `onPaste`, …).
- **Surface** (`surface.ts`): `createSurface(template)` builds three regions: `main` (the transcript flow; `settle(node)` marks a block final so the terminal backend writes it to scrollback once), `dock` (live chrome such as the composer), and `layer` (overlays; fullscreen layers use the alternate screen). The surface owns keyboard focus.
- **Host** (`host.ts`): `startHost({ surface, theme, onKey, intercept, … })` renders the surface natively when the terminal speaks TSP (Tern), and with the terminal backend everywhere else.

### Terminal backend: painters, roles, widgets

- **Painters** (`packages/tui/src/term/paint.ts`, `term/painters/*`): `definePainter(kind, painter)` registers `paint(node, cx) → Block` (`rows`, optional cursor, hit rects, images). Blocks are cached per node by width and the signals they read.
- **Roles**: `defineRolePainter(kind, role, painter)` overrides a kind's look for nodes whose `role` prop matches; coding-agent uses this for screens that keep a specific look (`packages/coding-agent/src/ui/styles/**`).
- **Widgets** (`term/widgets.ts`, `term/widgets/*`): `defineWidget(kind, widget)` / `defineRoleWidget` give focusable kinds their `key`, `paste` and `mouse` behaviour. A widget emits the same events a Tern terminal sends (an `editor` edit, a `picker` select/activate, a `button` action).

Coding-agent wraps the surface in `Shell` (`packages/coding-agent/src/ui/shell/shell.ts`): controllers append transcript blocks (`shell.transcript`), fill dock slots (`shell.dock`) and open overlays; they never build regions themselves.

## Rendering constraints (terminal safety)

Nodes are laid out and painted by pi-tui; you only manage width yourself in a rows object (`{ render(width): string[] }`, drawn as a `canvas` node):

1. Rows wider than `width` are cut; return width-safe rows anyway.
2. **Measure visual width**, not string length: `visibleWidth()`.
3. **Truncate/wrap ANSI-aware text** with `truncate()` / `wrap()`.
4. **Sanitize tabs** from external content with `replaceTabs()`.

All four come from `@oh-my-pi/pi-tui/text/width`.

```ts
import { replaceTabs, truncate } from "@oh-my-pi/pi-tui/text/width";

const rows = { render: (width: number) => lines.map(line => truncate(replaceTabs(line), width)) };
```

## Input handling and keybindings

### Keys

In the terminal backend a key is offered to `onKey(key)` handlers from the focused node up the focus path (return `true` to stop it), then to the focused kind's widget (an `editor` turns it into `edit` events), then to the host's global `onKey`. `KeyEvent.id` is canonical (`ctrl+c`, `shift+enter`, `up`, `a`); `kind` is `press`, `repeat` or `release`. A rows object in `ctx.ui.custom` receives raw input in `handleInput(data)` instead.

### Match app keybinding actions

Extension UI factories receive a `KeybindingsManager` (interactive mode; an in-memory instance carrying the default bindings, not the user's `keybindings.yml`) so you can match action ids instead of hardcoding keys:

```ts
<col onKey={key => (keybindings.matches(key, "app.interrupt") ? (done(undefined), true) : false)}>…</col>
```

### Built-in widgets follow the keymap

pi-tui's terminal widgets (`picker`, `prefs`, `menu`, `button`/`buttons`, `editor`/`input`) read their keys from a widget keymap instead of fixed key ids: `select.up`/`down`/`pageUp`/`pageDown`/`confirm`/`cancel` and the `editor.*` motions and edits (`@oh-my-pi/pi-tui/term/keymap`). omp fills it from the user's `tui.select.*`, `tui.editor.*` and `tui.input.newLine` bindings when the keymap loads or reloads (`setWidgetKeymap`), so a list or text field in your UI honours remaps without matching keys itself. A picker action keyed `esc` (or `enter`) also runs on the other `select.cancel` (`select.confirm`) keys.

## Focus, overlays, and cursor

- The surface tracks one focused node; both backends draw the caret/focus ring there and route keys to it.
- `ctx.ui.custom(factory)` without options shows the view in place of the composer; `{ overlay: true }` draws it over the transcript, `fullscreen: true` on the alternate screen. `onHandle` receives `{ closed, close() }`.
- An `editor`/`input` node places the terminal cursor itself; rows objects have no cursor.

### Built-in full-screen surfaces

The coding-agent integration also mounts built-in full-screen surfaces outside `ctx.ui.custom(...)`. [Agent Hub](./agent-hub.md) is the live roster and control surface for subagents. Its file-backed transcript viewer borrows the alternate screen while it is open, then restores the Hub beneath it on close.

## Mount points and return contracts

## 1) Extension UI (`ExtensionUIContext`)

Current signature (`extensibility/extensions/types.ts`):

```ts
custom<T>(factory: ExtensionCustomFactory<T>, options?: ExtensionCustomOptions): Promise<T>

type ExtensionCustomFactory<T> = (
  ui: ExtensionUiHost, // requestRender(), size(), suspend(run)
  theme: ExtensionTheme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => ExtensionRender | Promise<ExtensionRender>;
```

`ExtensionRender` (`extensibility/extensions/render-types.ts`) is pi-tui nodes or a rows object (`render(width)`, optional `handleInput(data)`, `dispose()`).

Behavior in interactive mode (`extension-ui-controller.ts`):

- Saves composer text.
- Without `options.overlay`, shows your view in place of the composer; with it, as an overlay (`fullscreen` for the alternate screen).
- `options.onHandle` receives the overlay handle.
- `options.signal` aborts the flow and rejects its promise with the signal's reason (or `AbortError`); a view returned after cancellation is disposed rather than mounted.
- Focuses your view: a node root takes focus (handle keys with `onKey`); a rows object gets raw input in `handleInput`.
- On `done(result)`: disposes the view, closes the overlay if present, restores the composer and its text, resolves the promise.
  Call `done(...)` to complete successfully; factory failures and signal cancellation reject the promise.

## 2) Hook/custom-tool UI context (`HookUIContext`)

`custom(factory)` in `extensibility/hooks/types.ts` takes the same factory as
`ExtensionUIContext.custom` (no options). Guard terminal-only UI with
`pi.hasUI` when the hook may also run headless.

## 3) Custom tool call/result renderers

Custom tools and extension tools can return an `ExtensionRender` from:

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme, args?)`

`options` (`RenderResultOptions`, `tools/details/renderer.ts`) includes `expanded`, `isPartial`, `spinnerFrame?`, and call-state flags such as `argsComplete`.

`packages/coding-agent/src/ui/tools/legacy.ts` runs these hooks and draws their parts inside the custom-tool box. Nodes are drawn by the terminal and by Tern; rows objects by the terminal only (Tern keeps the generic tool card). See [Rendering extension points](./extensions.md#rendering-extension-points).

## Lifecycle and cancellation

- Nodes are disposed with the view; register teardown for timers, subprocesses, watchers or sockets with `onCleanup` inside the view, or `dispose()` on a rows object. Teardown must be idempotent.
- `done(...)` should be called exactly once from your view.
- For cancellable long-running UI, pass an `AbortSignal` through `options.signal` or call `done(undefined)` from your own cancel key.

## Pause status

The `/pause` screen shows the same local turn-and-job state in ANSI and TSP: draining turns and running jobs count, while parked or finished turns do not. When both counts reach zero, it hides the rows and signals readiness. These counts cover OMP-tracked work only, not device-wide idleness.

## Realistic custom view example (extension command)

```tsx
/** @jsxImportSource @oh-my-pi/pi-tui */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { signal } from "@oh-my-pi/pi-tui";

export default function extension(pi: ExtensionAPI): void {
	pi.registerCommand("pick-model", {
		description: "Pick a model profile",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const cursor = signal("fast");
			const selected = await ctx.ui.custom<string | undefined>((_ui, _theme, keybindings, done) => (
				<picker
					items={[
						{ id: "fast", label: "Fast" },
						{ id: "balanced", label: "Balanced" },
						{ id: "quality", label: "Quality" },
					]}
					selected={cursor}
					onSelect={id => cursor.set(id)}
					onActivate={id => done(id)}
					onKey={key => (keybindings.matches(key, "app.interrupt") ? (done(undefined), true) : false)}
				/>
			));

			if (selected) ctx.ui.notify(`Selected profile: ${selected}`, "info");
		},
	});
}
```

## Key implementation files

- `packages/tui/src/reactive.ts`, `element.ts`, `flow.ts`, `node.ts` — signals, JSX, control flow, the node model.
- `packages/tui/src/surface.ts` / `host.ts` — regions, focus, settling; native vs terminal rendering.
- `packages/tui/src/term/paint.ts`, `term/painters/*`, `term/widgets.ts`, `term/widgets/*`, `term/keymap.ts` — painters, roles, widgets, widget keymap.
- `packages/tui/src/driver/input/*` — terminal input decoding (`keys.ts`: key ids).
- `packages/tui/src/text/width.ts` — width/truncation/wrapping/tab primitives.
- `packages/coding-agent/src/config/keybindings/keybindings.ts` / `app-keybindings.ts` — action mapping, disk loading, widget keymap fill.
- `packages/coding-agent/src/ui/shell/*` — the interactive shell (transcript, dock, overlays).
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts` — interactive mounting/unmounting for extension/hook/custom-tool UI.
- `packages/coding-agent/src/ui/extensions/render-output.tsx` — turning an `ExtensionRender` into nodes (rows → `canvas`).
- `packages/coding-agent/src/extensibility/extensions/types.ts`, `render-types.ts` — extension UI and renderer contracts.
- `packages/coding-agent/src/extensibility/hooks/types.ts` — hook UI contract.
- `packages/coding-agent/src/extensibility/custom-tools/types.ts` — custom tool execute/render contracts.
- `packages/coding-agent/src/ui/tools/legacy.ts` — running `renderCall`/`renderResult` hooks.
- `packages/coding-agent/src/tools/context.ts` — tool UI context propagation (`hasUI`, `ui`).
