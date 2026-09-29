# @oh-my-pi/collab-web

Web client for [omp collab sessions](../../docs/collab.md). Paste a `/collab` link into the browser and you get the same live session guests see in the TUI: streaming transcript, tool-call cards, subagent panel with live transcripts, and a composer that prompts (or interrupts) the host agent.

Host and guest messages sit on the right with their speaker labels. Agent replies and inter-agent messages stay on the left, in both the main transcript and agent drawer.

The prompt composer separates the input from a footer showing the host's model, reasoning effort, and context usage. These are read-only session details, not guest-side settings. Enter sends a prompt; Shift+Enter adds a line. Stop interrupts the current turn.

Reasoning streams as visible Markdown, separate from collapsed work blocks of up to three tool calls. When the host has measured a reasoning segment, its elapsed time appears below the text as the segment finishes. Timing is retained for replay; older sessions without measurements show the text without a duration.

Work blocks stay collapsed during execution unless you open them. Opened tool output updates in place and retains its state as results are saved. A single status line shows the latest streamed or executing tool intent (`i`), falling back to `Thinking…` until an intent is available; status text never replaces reasoning prose.

Spawned subagents appear as a card with one live-status row per agent (click to open its transcript). Background job completions and inter-agent messages render as compact rows rather than their model-facing envelopes. Parent wait-interrupt messages use the same sender → recipient presentation in the main chat and task viewer.

Structured subagent results open as labeled reports with lists and wrapped text. Switch to JSON for the complete payload; ordinary Markdown results keep their original presentation.

## Quick start

```sh
# dev server (Bun HTML dev server with HMR) — http://localhost:3000
bun run dev

# offline demo: local relay + scripted mock host; prints a ws://localhost link
bun run mock-host
```

Host a session from any omp instance (`/collab`, or `/collab ws://localhost:7466` to use the mock relay), then paste the printed link into the connect screen. Deep links work too: `http://localhost:3000/#<roomId>.<key>` auto-connects on load.

## Build & deploy

```sh
bun run build   # static site in dist/
```

`dist/` is a fully static SPA — host it anywhere. JS/CSS bundles are content-hashed; favicons, `manifest.webmanifest`, `robots.txt`, `sitemap.xml`, and `og-image.png` come from `public/` and are emitted at the site root under stable names (canonical URL: `https://my.omp.sh/`). Two runtime requirements:

- **Secure context**: room keys are unwrapped with WebCrypto (`crypto.subtle`), which browsers expose only on `https://` or `localhost`.
- **Relay reachability**: the client connects straight to the relay over WebSocket (`wss://` for anything that isn't localhost). The default relay is `wss://my.omp.sh`; bare `<roomId>.<key>` links resolve against it (legacy `<roomId>#<key>` and `%23`-mangled links still parse).

The room key never leaves the URL fragment — it is not sent to the relay or any server.

## Architecture

- `src/lib/` — vendored wire codec (`codec.ts` AES-256-GCM, `link.ts` envelope + link grammar), `socket.ts` reconnecting relay socket, `client.ts` guest session store (`GuestClient` + immutable snapshots for `useSyncExternalStore`). Shared protocol shapes come from `@oh-my-pi/pi-wire`.
- `src/components/` — `transcript/` (entries, markdown, tool cards), `agents/` (panel + transcript drawer), `shell/` (connect screen, header, composer, banners, toasts).
- `src/tool-render/` — per-tool React renderers shared with coding-agent HTML session exports: one view per built-in tool, common `ToolView` chrome, theme-adaptive `tv-` design tokens, and an `<omp-tool-view>` web-component wrapper. The `ToolRenderHost` seam lets hosts wire agent-id chips to a sub-session view (drawer here, overlay in exports).
- `scripts/` — `local-relay.ts` (content-blind relay on `Bun.serve`), `mock-host.ts` + `fixture.ts` (scripted host for offline dev), `build-tool-views.ts` (bundles `src/tool-render/` + React into `packages/coding-agent/src/export/html/tool-views.generated.js` for self-contained exports).

The package is intentionally standalone — no dependency on `@oh-my-pi/pi-coding-agent` at runtime or type level. Wire-shape drift is prevented by consuming the same `@oh-my-pi/pi-wire` contracts as the host, with sealed-frame interop still covered by `test/codec.test.ts`.
