# @oh-my-pi/pi-tui

TSP-first terminal UI: one retained tree of [Tern Surface Protocol](../wire/src/tsp.ts) nodes, rendered natively by terminals that speak TSP (Tern) and as rows by an in-process renderer everywhere else.

## Overview

- **Runtime.** Synchronous, glitch-free signals (`signal`, `computed`, `effect`, `createRoot`) and a compiler-free JSX runtime: component functions run once; anything that should update is a function or a signal.
- **Nodes.** Lowercase JSX tags are TSP kinds (`col`, `row`, `text`, `md`, `tool`, `picker`, `editor`, …) plus the terminal-only `canvas`. A node carries reactive props, children and handlers (`onAction`, `onSelect`, `onEdit`, `onKey`, …). JSX `key` is node identity; `propKey`/`propRef` set the wire props `key`/`ref`; the `term` prop carries terminal-only look facts and is never sent natively.
- **Surface.** A program declares three regions: `main` (the flowing document — settled nodes retire into terminal scrollback exactly once), `dock` (live chrome) and `layer` (overlays, sheets, toasts; fullscreen layers take the alternate screen).
- **Host.** `startHost` starts the terminal driver, negotiates TSP and renders the surface with the native backend (Tern) or the terminal backend. Both route the same events to the same handlers.
- **Terminal backend.** One painter per kind, optionally overridden per role (`defineRolePainter`), like CSS classes; widgets (`defineWidget`/`defineRoleWidget`) give focusable kinds their keys. Frames compose from the viewport tail; history retires in order, streaming answers emit their stable head early, and a lost display replays the committed ledger.
- **Driver.** Raw mode, input decoding (legacy/kitty/win32 keys, bracketed paste, SGR mouse, focus, terminal replies), capability and appearance probes, multiplexer passthrough, synchronized output, resize policies, inline images (kitty, SIXEL, iTerm2), notifications, OSC 8/52/66.
- **Text and theme.** Width/wrap/truncate, ANSI tokenizing, Markdown (streaming-aware), syntax highlighting, diffs, LaTeX; theme files, color depths, symbol presets.

## Example

```tsx
/** @jsxImportSource @oh-my-pi/pi-tui */
import { createSurface, For, settle, signal, startHost } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const lines = signal<string[]>([]);
const surface = createSurface(() => ({
	main: <For each={lines}>{line => <text text={line} />}</For>,
	dock: <text text={() => `${lines().length} lines · q quits`} />,
}));

const host = await startHost({
	surface,
	theme: currentTheme,
	onKey: key => {
		if (key.id === "q") {
			void host.stop();
			return true;
		}
		for (const node of surface.main()) settle(node);
		lines.set([...lines(), `pressed ${key.id}`]);
		return true;
	},
});
```

## Testing

- `bun run test:tern` (repo root) drives a headless Tern with a temporary profile. It clicks an autocomplete row, the effort ring, the model chip and a model result, then checks the model and draft. The regular test suite runs this on POSIX hosts with `tern` on `PATH`; the explicit command fails instead of skipping if unavailable. It does not access your panes or send a prompt.

- `@oh-my-pi/pi-tui/testing/terminal` — `createTestTerminal(template)` runs a surface on the real terminal backend over an in-memory driver (`press`, `type`, `paste`, `mouse`, `tick`, `resize`, `screen`, `cursor`).
- `TspEvent` is a closed union; its decoder and dispatch are checked against it. Application action IDs are open strings. For a new action, send the event to the control the live shell rendered and check its effect: the sheet opened, the field changed, or the selection was applied. A snapshot or a key-decoder test cannot prove that.
- `@oh-my-pi/pi-tui/testing/cells` — rendered-cell comparison of ANSI rows (glyph, colors, attributes, links).
- `@oh-my-pi/pi-tui/testing/corpus` — `describeTree` (the native description of a node) and helpers for corpus parity suites.

## Debugging

Set `OMP_TUI_DEBUG` to an IPC endpoint to expose the running surface (tree, frames, input injection) to the repository's `tui` debug tool; see [docs/tui.md](../../docs/tui.md).
