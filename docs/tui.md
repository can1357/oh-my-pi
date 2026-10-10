# TUI integration for extensions and custom tools

This document covers the **current** TUI contract used by `packages/coding-agent` and `packages/tui` for extension UI, custom tool UI, and custom renderers.

## What this subsystem is

The runtime has two layers:

- **Rendering engine (`packages/tui`)**: differential terminal renderer, input dispatch, focus, overlays, cursor placement.
- **Integration layer (`packages/coding-agent`)**: mounts extension/custom-tool components, wires keybindings/theme, and restores editor state.

## Runtime behavior by mode

| Mode                | `ctx.ui.custom(...)` availability | Notes                                                                                                                          |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Interactive TUI     | Supported                         | Component is mounted in the editor area or overlay, focused, and must call `done(result)` to resolve.                          |
| Background/headless | Not interactive                   | UI context is no-op (`hasUI === false`).                                                                                       |
| RPC mode            | Not mounted                       | `custom()` is implemented as unsupported UI and returns `undefined as never`; do not depend on interactive UI in RPC handlers. |

If your extension/tool can run headless, guard with `ctx.hasUI` / `pi.hasUI`. RPC can expose `hasUI === true` for protocol-backed dialogs while still not supporting `custom()`; `hasUI` alone does not guarantee a component can be mounted.

## Core component contract (`@oh-my-pi/pi-tui`)

`packages/tui/src/tui.ts` defines:

```ts
export interface Component {
  render(width: number): readonly string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate?(): void;
  releaseRenderCaches?(): void;
  setIgnoreTight?(ignore: boolean): any;
  dispose?(): void;
}
```

Render results are component-owned and immutable to callers. An unchanged component may (and should) return the **same array reference** it returned last time; it must return a new array whenever content changes. Reference equality enables container memoization and stable-prefix work avoidance. A component that mutates a previously returned array in place must also implement `RenderStablePrefix` and report how many leading rows survived unchanged.

`releaseRenderCaches()` drops only derived rows, parsing, and formatting state. The next `render()` must reproduce the same rows from retained source state. Do not rebuild eagerly, invoke renderer callbacks, convert images, or replace or dispose children in this hook. The transcript calls it after retirement or replay batches are acknowledged, or immediately when replay has no rows to acknowledge. Semantic full renders and resized tails release committed caches after producing their rows. Tool cards can use `ToolCardOptions.onReleaseRenderCaches` to drop builder-owned memos, and `releaseRenderedStringCache()` clears a `RenderedStringCache` used for formatted strings.

`Focusable` is separate:

```ts
export interface Focusable {
  focused: boolean;
  setUseTerminalCursor?(useTerminalCursor: boolean): void;
}
```

Cursor behavior uses `CURSOR_MARKER` (not `getCursorPosition`). Focused components emit the marker in rendered text; `TUI` extracts it and positions the hardware cursor.

Fullscreen overlays opt into the shared hardware cursor only when the user's hardware-cursor preference is enabled and the focused component implements `setUseTerminalCursor`. The focus target must be the top overlay itself or a child it owns via `OverlayFocusOwner.ownsOverlayFocusTarget`; wrappers must forward focus and cursor mode to their input. Emit `CURSOR_MARKER` at the caret without replacing the underlying glyph. With the preference disabled, keep the software cursor; losing focus or removing the marker hides the hardware cursor.

## Rendering constraints (terminal safety)

Your `render(width)` output must be terminal-safe:

1. **Do not intentionally exceed `width` on any line**. The renderer truncates overwide non-image lines as a last-resort guard, but components should still return width-safe output.
2. **Measure visual width**, not string length: use `visibleWidth()`.
3. **Truncate/wrap ANSI-aware text** with `truncateToWidth()` / `wrapTextWithAnsi()`.
4. **Sanitize tabs/content** from external sources using `replaceTabs()` (and higher-level sanitizers in coding-agent render paths).

Minimal pattern:

```ts
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";

render(width: number): readonly string[] {
  return this.lines.map(line => truncateToWidth(replaceTabs(line), width));
}
```

## Input handling and keybindings

### Raw key matching

Use `matchesKey(data, "...")` for navigation keys and combos.

### Match app keybinding actions

Extension UI factories receive a `KeybindingsManager` (interactive mode; an in-memory instance carrying the default bindings, not the user's `keybindings.yml`) so you can match action ids instead of hardcoding keys:

```ts
if (keybindings.matches(data, "app.interrupt")) {
  done(undefined);
  return;
}
```

### Key release/repeat events

Key release events are filtered unless your component sets:

```ts
wantsKeyRelease = true;
```

Then use `isKeyRelease()` / `isKeyRepeat()` if needed.

## Focus, overlays, and cursor

- `TUI.setFocus(component)` routes input to that component.
- Overlay APIs exist in `TUI` (`showOverlay`, `OverlayHandle`). In interactive extension/custom UI, `custom(..., { overlay: true })` mounts your component through `TUI.showOverlay(...)`; without `overlay`, it replaces the editor component area directly.
- By default, overlay custom UI is anchored at `bottom-center` with full terminal width/max height. `overlayOptions` can override positioning and sizing; `onHandle` receives the `OverlayHandle`. The overlay is removed when `done(...)` closes the flow.

### Built-in full-screen surfaces

The coding-agent integration also mounts built-in full-screen surfaces outside `ctx.ui.custom(...)`. [Agent Hub](./agent-hub.md) is the live roster and control surface for subagents. Its file-backed transcript viewer borrows the alternate screen while it is open, then restores the Hub beneath it on close.

## Mount points and return contracts

## 1) Extension UI (`ExtensionUIContext`)

Current signature (`extensibility/extensions/types.ts`):

```ts
custom<T>(
  factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: T) => void,
  ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
  options?: ExtensionCustomOptions,
): Promise<T>
```

Behavior in interactive mode (`extension-ui-controller.ts`):

- Saves editor text.
- Without `options.overlay`, replaces the editor component with your component.
- With `options.overlay`, mounts your component as an overlay instead of replacing the editor; `overlayOptions` accepts static options or a function evaluated when mounting.
- `options.onHandle` receives the mounted overlay handle.
- `options.signal` aborts the flow and rejects its promise with the signal's reason (or `AbortError`); a component returned after cancellation is disposed rather than mounted.
- Focuses your component.
- On `done(result)`: calls `component.dispose?.()`, hides the overlay if present, restores editor + text for non-overlay flows, focuses editor, resolves promise.
  Call `done(...)` to complete successfully; factory failures and signal cancellation reject the promise.

## 2) Hook/custom-tool UI context (`HookUIContext`)

Current signature (`extensibility/hooks/types.ts`) matches the interactive
controller and `ExtensionUIContext.custom`:

```ts
custom<T>(
  factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (result: T) => void,
  ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
): Promise<T>
```

Use the fourth argument as `done`. The third argument is a `KeybindingsManager`
(interactive mode uses an in-memory instance with the default bindings). Guard
terminal-only UI with `pi.hasUI` when the hook may also run headless.

## 3) Custom tool call/result renderers

Custom tools and extension tools can return components from:

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme, args?)`

`options` currently includes:

- `expanded: boolean`
- `isPartial: boolean`
- `spinnerFrame?: number`

For `renderCall`, the `options` argument also answers the `Theme` API (`fg`,
`bold`, `symbol`, …), so renderers ported from upstream pi — declared
`renderCall(args, theme, context)` — keep working unchanged.

These renderers are mounted by `ToolExecutionComponent`.

On Tern Surface Protocol terminals, tools may additionally supply `describeCall(args, options)` and `describeResult(result, options, args?)`, returning a semantic `NativeToolView` or `undefined`. Custom components can implement `describe(cx)` and `handleNativeEvent(event)`; otherwise the native backend falls back to their rendered rows. See [the core renderer contract](./tui-core-renderer.md#native-rendering-tern-surface-protocol).

## Lifecycle and cancellation

- `dispose()` is optional at type level but should be implemented when you own timers, subprocesses, watchers, sockets, or overlays. It must be idempotent: containers propagate disposal, and reset/removal paths may converge.
- `done(...)` should be called exactly once from your component flow.
- For cancellable long-running UI, pair `CancellableLoader` with `AbortSignal` and call `done(...)` from `onAbort`.

Example cancellation pattern:

```ts
const loader = new CancellableLoader(
  tui,
  text => theme.fg("accent", text),
  text => theme.fg("muted", text),
  "Working...",
);
loader.onAbort = () => done(undefined);
void doWork(loader.signal).then(result => {
  if (!loader.aborted) done(result);
});
return loader;
```

## Realistic custom component example (extension command)

```ts
import type { Component } from "@oh-my-pi/pi-tui";
import {
  SelectList,
  matchesKey,
  replaceTabs,
  truncateToWidth,
} from "@oh-my-pi/pi-tui";
import {
  getSelectListTheme,
  type ExtensionAPI,
} from "@oh-my-pi/pi-coding-agent";

class Picker implements Component {
  list: SelectList;
  keybindings: any;
  done: (value: string | undefined) => void;

  constructor(
    items: Array<{ value: string; label: string }>,
    keybindings: any,
    done: (value: string | undefined) => void,
  ) {
    this.list = new SelectList(items, 8, getSelectListTheme());
    this.keybindings = keybindings;
    this.done = done;
    this.list.onSelect = (item) => this.done(item.value);
    this.list.onCancel = () => this.done(undefined);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.interrupt")) {
      this.done(undefined);
      return;
    }
    this.list.handleInput(data);
  }

  render(width: number): readonly string[] {
    return this.list
      .render(width)
      .map((line) => truncateToWidth(replaceTabs(line), width));
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

export default function extension(pi: ExtensionAPI): void {
  pi.registerCommand("pick-model", {
    description: "Pick a model profile",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const selected = await ctx.ui.custom<string | undefined>(
        (tui, theme, keybindings, done) => {
          const items = [
            { value: "fast", label: theme.fg("accent", "Fast") },
            { value: "balanced", label: "Balanced" },
            { value: "quality", label: "Quality" },
          ];
          return new Picker(items, keybindings, done);
        },
      );

      if (selected) ctx.ui.notify(`Selected profile: ${selected}`, "info");
    },
  });
}
```

## Key implementation files

- `packages/tui/src/tui.ts` — `Component`, `Focusable`, cursor marker, focus, overlay, input dispatch.
- `packages/tui/src/utils.ts` — width/truncation/sanitization primitives.
- `packages/tui/src/keys.ts` / `keybindings.ts` — key parsing and base TUI action mapping; `app-keybindings.ts` adds coding-agent actions and disk loading.
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts` — interactive mounting/unmounting for extension/hook/custom-tool UI.
- `packages/coding-agent/src/extensibility/extensions/types.ts` — extension UI and renderer contracts.
- `packages/coding-agent/src/extensibility/hooks/types.ts` — hook UI contract.
- `packages/coding-agent/src/extensibility/custom-tools/types.ts` — custom tool execute/render contracts.
- `packages/tui/src/chat/tool-execution.ts` — mounting `renderCall`/`renderResult` components and partial-state options.
- `packages/coding-agent/src/tools/context.ts` — tool UI context propagation (`hasUI`, `ui`).
