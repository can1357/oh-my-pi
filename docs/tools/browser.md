# browser

> Open, reuse, close, and script browser tabs against project-shared Chromium, CDP-attached apps, the user's Chrome through the OMP Browser Relay, or cmux surfaces.

## Source
- Entry: `packages/coding-agent/src/tools/browser.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/browser.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/browser/tab-supervisor.ts` — global tab registry; worker lifecycle; run/close coordination.
  - `packages/coding-agent/src/tools/browser/tab-worker.ts` — executes `run` code; implements the `tab` helper API.
  - `packages/coding-agent/src/tools/browser/tab-worker-entry.ts` — worker-thread transport bootstrap.
  - `packages/coding-agent/src/tools/browser/registry.ts` — browser-handle registry keyed by browser kind.
  - `packages/coding-agent/src/tools/browser/launch.ts` — Puppeteer loading, Chromium resolution/download, headless launch, stealth injection.
  - `packages/coding-agent/src/tools/browser/shared-daemon.ts` — project-shared broker-owned Chromium (ensure/attach over the daemon broker).
  - `packages/coding-agent/src/tools/browser/attach.ts` — CDP attach/reuse, target picking, spawned-app process handling.
  - `packages/coding-agent/src/tools/browser/tab-protocol.ts` — worker init/run/result message schema.
  - `packages/coding-agent/src/tools/browser/readable.ts` — `tab.extract()` readability extraction.
  - `packages/coding-agent/src/tools/browser/aria/aria-snapshot.ts` — `captureAriaSnapshot()` (puppeteer/CDP path) and `buildAriaSnapshotScript()` (cmux path); imports the committed `aria-snapshot.bundle.txt`.
  - `packages/coding-agent/src/tools/browser/aria/aria-snapshot.bundle.txt` — generated, committed artifact: Playwright's injected ARIA-snapshot sources (Apache-2.0, (c) Microsoft; ARIA tree + W3C accessible-name computation) bundled to a CJS module. Upstream sources are not vendored into the repo.
  - `packages/coding-agent/scripts/generate-aria-snapshot.ts` — fetches the pinned Playwright sources to a temp dir and bundles them into `aria-snapshot.bundle.txt` (CJS, browser target). Dev-time, network-bound; only the bundle is committed.
  - `packages/coding-agent/src/tools/browser/cmux/rpc.ts` — cmux browser-kind resolution plus snapshot/eval/wait-state helpers for the cmux backend.
  - `packages/coding-agent/src/tools/browser/cmux/socket-client.ts` — `CmuxSocketClient`: JSON-RPC over the cmux unix socket.
  - `packages/coding-agent/src/tools/browser/cmux/cmux-tab.ts` — `CmuxTab` surface helper API and `runCmuxCode()` execution path.
  - `packages/coding-agent/src/tools/browser/relay/kind.ts` — relay setting/env resolution and default endpoint.
  - `packages/coding-agent/src/tools/browser/relay/daemon.ts` — machine-global broker-owned relay auto-start.
  - `packages/coding-agent/src/tools/browser/relay/{server,bridge,protocol}.ts` — loopback CDP facade and Chrome-extension protocol bridge.
  - `packages/coding-agent/src/eval/js/shared/runtime.ts` — shared `JsRuntime` that executes `run` code (same engine as the `eval` JS tool); both the worker and cmux backends delegate to it.
  - `packages/coding-agent/src/tools/browser/render.ts` — TUI rendering for `open`/`close` status lines and `run` JS cells.
  - `packages/coding-agent/src/tools/puppeteer/00_stealth_tampering.txt` — mask patched functions/descriptors as native.
  - `packages/coding-agent/src/tools/puppeteer/01_stealth_activity.txt` — synthesize visibility/focus/scroll activity.
  - `packages/coding-agent/src/tools/puppeteer/02_stealth_hairline.txt` — fix Modernizr hairline detection.
  - `packages/coding-agent/src/tools/puppeteer/03_stealth_botd.txt` — spoof `navigator.webdriver`, `window.chrome`, and Chrome fingerprint surfaces.
  - `packages/coding-agent/src/tools/puppeteer/04_stealth_iframe.txt` — patch iframe `contentWindow`/`srcdoc` behavior.
  - `packages/coding-agent/src/tools/puppeteer/05_stealth_webgl.txt` — spoof WebGL vendor/renderer/precision.
  - `packages/coding-agent/src/tools/puppeteer/06_stealth_screen.txt` — normalize screen/viewport/device-pixel-ratio values.
  - `packages/coding-agent/src/tools/puppeteer/07_stealth_fonts.txt` — spoof local fonts and perturb canvas text rendering.
  - `packages/coding-agent/src/tools/puppeteer/08_stealth_audio.txt` — spoof audio latency/sample-rate and perturb offline rendering.
  - `packages/coding-agent/src/tools/puppeteer/09_stealth_locale.txt` — force locale/languages/timezone/date strings.
  - `packages/coding-agent/src/tools/puppeteer/10_stealth_plugins.txt` — synthesize `navigator.plugins`/`navigator.mimeTypes`.
  - `packages/coding-agent/src/tools/puppeteer/11_stealth_hardware.txt` — spoof `navigator.hardwareConcurrency`.
  - `packages/coding-agent/src/tools/puppeteer/12_stealth_codecs.txt` — spoof media codec support.
  - `packages/coding-agent/src/tools/puppeteer/13_stealth_worker.txt` — carry UA/platform spoofing into `Worker`/`SharedWorker`.

## Inputs

### Shared fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"open" \| "close" \| "run"` | Yes | Dispatches to the open/close/run path. |
| `name` | `string` | No | Tab id. Defaults to `"main"`. Tabs live in a process-global map, so the same name is reused across later calls and in-process subagents until closed. |
| `timeout` | `number` | No | Tool wall-clock timeout in seconds. Defaults to `30`; clamped to the browser tool range before execution. |

### `action: "open"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | No | Navigate after the tab is ready. Existing reusable tabs also navigate when `url` is supplied. |
| `viewport` | `{ width: number; height: number; scale?: number }` | No | Requested viewport. For headless launch this becomes the initial viewport; for a page it is applied with `page.setViewport()`. `scale` maps to Puppeteer `deviceScaleFactor`. |
| `wait_until` | `"load" \| "domcontentloaded" \| "networkidle0" \| "networkidle2"` | No | Navigation wait condition. Defaults to `"load"` where omitted, including `open` navigation and later `tab.goto(...)`. |
| `dialogs` | `"accept" \| "dismiss"` | No | Installs a page `dialog` handler that auto-accepts or auto-dismisses dialogs. Omitted means no handler. |
| `app` | `{ path?: string; cdp_url?: string; relay?: boolean; args?: string[]; target?: string }` | No | Selects browser kind. Explicit `app.cdp_url` wins, then `app.path`, then relay selection. `app.relay: true` opts into the OMP Browser Relay; `app.relay: false` suppresses relay settings for this call. With no explicit app kind, `browser.relay` (overridden by `PI_BROWSER_RELAY`) precedes `browser.cdpUrl`, then cmux when available, then `browser.headless`. `browser.relayUrl` defaults to `http://127.0.0.1:9224`. `args` apply only to spawned `app.path`; `target` selects an attached/spawned/relay page by URL/title substring. |

### `action: "close"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `all` | `boolean` | No | Release every known managed tab. Omitted releases only `name`. Tool-owned headless pages and owned cmux surfaces close; spawned, connected, and relay pages remain open unless `kill: true` terminates a spawned browser. |
| `kill` | `boolean` | No | When a tab release drops a spawned-app browser handle to refcount 0, also terminate its process tree. Has no effect on headless shutdown; connected and relay browsers are only disconnected. |

### `action: "run"`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | `string` | Yes | Async-function body executed by the shared `JsRuntime` (`src/eval/js/shared/runtime.ts`, the same engine as the `eval` JS tool). In scope: browser-specific `page`, `browser`, `tab`, `assert(cond, msg?)`, and `wait(ms)`, plus the runtime prelude helpers (`display`, `print`, `read`, `write`, `append`, `tree`, `env`, `tool`, `completion`, `agent`, `parallel`, `pipeline`, `log`, `phase`, `budget`, ...) and ambient Bun globals (`console`, timers, `URL`, `TextEncoder`/`TextDecoder`, `Buffer`). |

## Outputs
The tool returns one result per call; no streaming partial output is emitted from the browser implementation itself.

- `open`: text content with `Opened` or `Reused`, browser description, URL, and optional title. `details` includes `action`, `name`, `browser`, `url`, `viewport`, and the same text in `details.result`.
- `close`: text content with either `Closed ...` or `No tab named ...`. `details` includes `action`, `name`, and `details.result`.
- `run`: ordered `content` array built as:
  1. every structured display output in execution order (object/image `display(value)` calls plus helper status events),
  2. final return value, JSON-stringified unless already a string,
  3. or `Ran code on tab "..."` if nothing else was produced.
- `display(value)` is handled by the shared runtime's `displayValue()` (`src/eval/js/shared/runtime.ts`), then mapped to content by `WorkerCore.#pushDisplay()` (`packages/coding-agent/src/tools/browser/tab-worker.ts`):
  - `{ type: "image", data, mimeType }` with decodable base64 becomes image content; an unrecognized `data` shape is dropped with a debug note.
  - any other object/array becomes pretty JSON text (`JSON.stringify(value, null, 2)`); a value that is not structured-cloneable is dropped with a debug note.
  - helper side effects (`read`/`write`/`tree`/...) emit `status` events that surface as compact JSON text.
  - primitive `display(value)` (string/number/...) and `console.*` flow to the text channel, which the worker forwards as debug logs rather than tool content; `undefined` is ignored.
- `tab.screenshot()` returns its saved path and appends text plus an image unless `silent: true`; `details.screenshots` records `{ dest, mimeType, bytes, width, height }`.
- `run` `details` includes `action`, `name`, current `browser`/`url` when the tab exists, optional `screenshots`, and `details.result` containing only the concatenated text outputs. Combined run text is capped at the inline byte limit via `enforceInlineByteCap()`; over-cap text is saved as a session artifact (`saveBrowserOutputArtifact()`) and the capped text replaces it in content and `details.result`.

## Flow
1. `BrowserTool.execute()` (`packages/coding-agent/src/tools/browser.ts`) abort-checks, clamps `timeout` via `clampTimeout("browser", ...)`, defaults `name` to `"main"`, and dispatches on `action`.
2. `open` resolves browser kind with `resolveBrowserKind()`:
   - `app.cdp_url` → `{ kind: "connected" }` after trimming trailing slashes.
   - `app.path` → `{ kind: "spawned" }` after resolving against session cwd.
   - `app.relay: true` → relay mode unless `PI_BROWSER_RELAY=0` disables it.
   - otherwise, unless `app.relay === false`, `browser.relay` selects relay mode; `PI_BROWSER_RELAY=0|1` is the final setting override and `browser.relayUrl` supplies the endpoint.
   - otherwise, a non-empty `browser.cdpUrl` setting → `{ kind: "connected" }`.
   - otherwise, `resolveCmuxKind()` → `{ kind: "cmux", socketPath, password?, surface? }` when `CMUX_SOCKET_PATH` is set and cmux is enabled (`browser.cmux`, overridable by `PI_BROWSER_CMUX`).
   - otherwise → `{ kind: "headless", headless: session.settings.get("browser.headless") }`.
3. `open` rejects reusing the same tab name across different browser kinds (`sameBrowserKind()`); callers must close first.
4. `open` acquires a browser handle through `acquireBrowser()` (`packages/coding-agent/src/tools/browser/registry.ts`):
   - existing connected handle is reused by browser-kind key;
   - headless attaches to the project-shared broker-owned Chromium (`ensureSharedBrowser()`); in a CLI-host process a broker failure is a hard error, while non-CLI hosts (`bun test`, SDK embedding) launch a process-local Chromium via `launchHeadlessBrowser()`;
   - `connected` waits for `${cdpUrl}/json/version`, then `puppeteer.connect()`;
   - `relay` auto-starts the machine-global broker-owned server for loopback endpoints in CLI hosts, waits up to 35 seconds for the extension handshake, then attaches through Puppeteer. Remote endpoints and non-CLI hosts must already be serving;
   - `spawned` first tries `findReusableCdp()`, else kills same-path processes, allocates a free loopback port, spawns the executable with `--remote-debugging-port=<port>`, waits for CDP, then connects;
   - `cmux` connects a `CmuxSocketClient` to the cmux unix socket; existing cmux handles are reused unconditionally (no connection-liveness recheck).
5. `open` acquires a tab through `acquireTab()` (`packages/coding-agent/src/tools/browser/tab-supervisor.ts`):
   - same-name + same-browser + alive tab is reused unless `dialogs` changed;
   - same-name but different browser handle, dead state, or changed dialog policy forces release and recreation;
   - reusing with a new `url` navigates by issuing `await tab.goto(...)` through the worker, defaulting to `waitUntil: "load"` when `wait_until` is omitted.
6. New tabs build a `WorkerInitPayload` in `buildInitPayload()`:
   - headless mode sends `url`, `waitUntil`, `viewport`, `dialogs`, and timeout; the worker defaults missing `waitUntil` to `"load"`.
   - attached, spawned, and relay modes resolve a page with `pickElectronTarget()`, get its target id, and send `targetId` plus `dialogs`. When no `target` is supplied for connected/relay mode, target selection prefers the visible usable page and screenshots do not activate it; an explicit matcher may select and activate a background page for target-correct pixels.
7. `acquireTab()` spawns a dedicated Bun `Worker` from `tab-worker-entry.ts`; if that fails it falls back to inline execution in the main thread (`spawnInlineWorker()`), preserving behavior but losing protection against synchronous infinite loops. Worker init runs under the caller's `timeoutMs` deadline (plus a small supervisor grace) instead of any fixed floor: callers that started their own deadline before browser acquisition pass it through `deadlineStartMs`, so the clock starts with the caller's budget and time already spent acquiring the browser counts against init instead of restarting it. The `setup` handshake is bounded by `min(10 s, remaining/3)` with a `2 s` floor, the ready wait gets what is left, and the inline-fallback retry only happens while budget remains — once the caller's deadline is exhausted, init fails fast instead of restarting the clock.
8. `WorkerCore.#init()` (`packages/coding-agent/src/tools/browser/tab-worker.ts`) connects back to the browser websocket endpoint. Headless mode opens a new page and reports the new target (`page-created`) to the supervisor before the slow post-creation CDP work (stealth patches, viewport) — so a supervisor that kills the worker mid-init can close exactly that target — applies stealth patches, applies viewport, installs dialog handling if requested, and optionally navigates. Attach mode resolves the requested target page and optionally installs dialog handling.
9. On success the worker sends `ready` with `{ url, title, viewport, targetId }`; the supervisor stores a `TabSession`, increments browser-handle refcount with `holdBrowser()`, and keeps the tab in a process-global `Map<string, TabSession>`.
10. `run` requires non-empty `code`, looks up the tab with `getTab()`, then delegates to `runInTab()`.
11. `runInTabWithSnapshot()` rejects dead tabs and concurrent runs (`Tab ... is busy`), captures session cwd plus optional `browser.screenshotDir`, registers an abort hook, sends a `run` message to the worker, and races the result against `timeoutMs + 750` ms. Timeouts force-kill the tab worker and, for headless tabs, close the orphaned page target.
12. `WorkerCore.#run()` builds the `tab` API, lazily creates a shared `JsRuntime` via `#ensureRuntime()`, injects `page`/`browser`/`tab`/`assert`/`wait` with `runtime.setRunScope()`, and executes the user code through `runtime.run(code, ...)` raced against a cancel/timeout rejection. Cmux tabs take a parallel path through `runCmuxCode()`, which drives the same `JsRuntime`.
13. The `tab` helper API implemented in `#createTabApi()` is:
   - `tab.name: string`
   - `tab.page: Page`
   - `tab.signal?: AbortSignal`
   - `tab.url(): string`
   - `tab.title(): Promise<string>`
   - `tab.goto(url, { waitUntil? })`
   - `tab.observe({ includeAll?, viewportOnly? })`
   - `tab.ariaSnapshot(selector?, { depth?, boxes? })`
   - `tab.ref(id)`
   - `tab.screenshot({ selector?, fullPage?, silent? })`
   - `tab.extract(format = "markdown")`
   - `tab.click(selector)`
   - `tab.type(selector, text)`
   - `tab.fill(selector, value)`
   - `tab.press(key, { selector? })`
   - `tab.scroll(deltaX, deltaY)`
   - `tab.drag(from, to)`
   - `tab.waitFor(selector, { timeout? })`
   - `tab.evaluate(fn, ...args)`
   - `tab.scrollIntoView(selector)`
   - `tab.select(selector, ...values)`
   - `tab.uploadFile(selector, ...filePaths)`
   - `tab.waitForUrl(pattern, { timeout? })`
   - `tab.waitForResponse(pattern, { timeout? })`
   - `tab.waitForSelector(selector, { timeout?, visible?, hidden? })`
   - `tab.waitForNavigation({ waitUntil?, timeout? })`
   - `tab.id(n)`
   - `tab.ref(id)`
14. Selector handling in `normalizeSelector()` accepts plain CSS and Puppeteer query handlers, and rewrites legacy Playwright-style prefixes `p-text/`, `p-xpath/`, `p-pierce/`, `p-aria/`; other `p-*` prefixes throw a `ToolError`. Playwright-only engines/pseudos (`:has-text()`, `:text()`, `:visible`, `:nth-match()`, `:near()`/`:above()`/…) on a CSS selector throw a `ToolError` pointing at the `text/`/`aria/` equivalents instead of stalling the action timeout.
15. `tab.observe()` clears the element cache, takes a Puppeteer accessibility snapshot, filters to interactive nodes unless `includeAll`, optionally filters to viewport-visible nodes, assigns numeric ids, caches `ElementHandle`s, and returns URL/title/viewport/scroll metadata plus `elements`.
15a. `tab.ariaSnapshot()` resolves the optional `selector` (via `normalizeSelector()` → `page.$`, defaulting to the whole document) and runs the generated Playwright ARIA-snapshot bundle (`src/tools/browser/aria/aria-snapshot.bundle.txt`) via `captureAriaSnapshot()`. The bundle is wrapped in a `new Function` built worker-side (so page CSP never applies) and serialized to a CDP `page.evaluate` in the page's **main world**, returning Playwright-format YAML. It always runs in `ai` mode: every node gets a `[ref=eN]` id, clickables get `[cursor=pointer]`, and matched DOM nodes are tagged with an `_ariaRef` expando. Existing `_ariaRef` expandos are cleared before each snapshot so ids renumber deterministically from e1 (the fresh module's counter resets each call); refs stay valid until the next snapshot. The cmux backend uses `buildAriaSnapshotScript()` over `browser.eval` instead (no `ElementHandle`; CSS selectors only for the root).
16. `tab.id(n)` resolves the cached `ElementHandle`, verifies `el.isConnected`, and throws a stale-id error after cache invalidation if the DOM changed or the cache was cleared.
16a. `tab.ref(id)` resolves a `[ref=eN]` id from the latest `ariaSnapshot()` to a live `ElementHandle` via `resolveAriaRefHandle()` (`page.evaluateHandle` in the main world, walking the document + shadow roots for the matching `_ariaRef`), throwing if no element matches; it accepts a bare `eN` or a prefixed form. Selector helpers recognize `aria-ref=eN`, `aria-ref/eN`, `ariaref/eN`, bare `eN`, and `@eN`. The cmux backend interprets bare `eN` in its own observation-id namespace; in either backend an `eN` selector means the id from the latest page dump.
17. `tab.goto()` clears the cached element ids before navigating. Any new `tab.observe()` also clears and rebuilds the cache.
18. `tab.click()` uses a custom retry loop for `text/...` selectors to find an actionable visible match; other selectors use `page.locator(...).click()`. Interactive actions (`click`/`fill`/`type`/`press`/`scroll`/`drag`/`scrollIntoView`/`select`/`uploadFile`) and the `waitFor*` helpers run under a per-op deadline (`min(cellBudget − slack, ceiling)`) threaded into both the puppeteer `signal` and `.setTimeout()`, so a stalled helper aborts the CDP action and rejects with a named `tab.<op> timed out after <ms>ms` that leaves cell budget — never the opaque whole-cell timeout. `goto`/`evaluate` stay uncapped.
19. `tab.screenshot()` captures the page or selected element as PNG, resizes a model copy, saves under `browser.screenshotDir` or the OS temp directory, returns that path, records metadata, and optionally emits text plus image content.
20. `display()` calls accumulate in an array. After code finishes, the worker posts `{ displays, returnValue, screenshots }`; `BrowserTool.#run()` appends the return value as trailing text content when not `undefined`.
21. `close` releases one managed tab handle or all handles via `releaseTab()` / `releaseAllTabs()`. Each tab aborts pending runs, asks the worker to clean up, waits up to `750` ms for a `closed` ack, terminates the worker, decrements browser refcount, and disposes the browser handle when refcount reaches zero. Headless workers close their tool-owned page; attach workers disconnect without closing spawned, connected, or relay pages.

## Modes / Variants
- **Action dispatch**
  - `open` — acquire/reuse browser + tab.
  - `close` — release one tab or all tabs.
  - `run` — execute JS inside the tab worker.
- **Browser kind**
  - **Headless**: attaches to one project-shared Chromium supervised by the daemon broker (`omp.browser.headless` / `omp.browser.headed` in `hub ps`), applies stealth patches, and creates a fresh page per tab. The daemon stops with the last omp client in the project. Non-CLI hosts launch a private local Chromium instead.
  - **Spawned app (`app.path`)**: reuses an existing CDP-enabled process for that executable when possible; otherwise kills same-path processes, spawns the executable with remote debugging enabled, then attaches. No stealth patches are injected.
  - **Connected browser (`app.cdp_url`, or the `browser.cdpUrl` setting when the call carries no `app`)**: attaches to an already-running CDP endpoint. No process ownership; close only disconnects.
  - **OMP Browser Relay (`app.relay`, or `browser.relay`)**: attaches to the user's own Chrome tabs through the loopback relay and its MV3 extension. Install once with `omp browser-relay install`. CLI hosts auto-start the fixed-port relay daemon for loopback URLs; a remote/custom relay must already be serving. The relay is a connected browser: no process ownership and no stealth patches. Without `app.target`, the visible usable tab is adopted without raising it; a matcher selects by URL/title substring.
  - **Cmux surface (`browser.cmux`)**: with no `app` and a cmux socket available (`CMUX_SOCKET_PATH`, enabled by the `browser.cmux` setting / `PI_BROWSER_CMUX` override), drives a cmux WKWebView surface over a unix-socket JSON-RPC client instead of Puppeteer. No Bun worker and no stealth patches; `open` opens a split (owning that surface), `run` executes via `runCmuxCode()`, and `close` issues `surface.close` for surfaces it owns (leaving the workspace's last surface open).
- **Target selection for attached/spawned/relay browsers**
  - With `app.target`, `pickElectronTarget()` returns the first page whose URL or title contains the case-insensitive substring.
  - Without `app.target`, it skips titles/URLs matching `request handler|devtools|background page|background host|service worker` and otherwise falls back to the first page.
- **Worker mode**
  - **Dedicated worker**: normal path; user code runs off the main thread and can be aborted even when it blocks synchronously.
  - **Inline fallback**: activated when Bun worker spawn fails; behavior matches, but synchronous infinite loops on user code cannot be interrupted.
- **Dialog policy**
  - No `dialogs` field: no auto-handler.
  - `accept`/`dismiss`: page `dialog` events are handled automatically.
  - Changing dialog policy on an existing live tab forces tab recreation instead of mutating the worker in place.
- **Screenshot persistence**
  - `browser.screenshotDir` session setting set: persist full-resolution PNG under that directory with a timestamped filename.
  - Unset: persist to a temp-file path under the OS temp dir.
  - `tab.screenshot()` returns the saved file path.

## Side Effects
- Filesystem
  - `loadPuppeteer()` writes `{}` to `<puppeteer-safe-dir>/package.json` before importing `puppeteer-core`.
  - First headless launch may download Chromium into the Puppeteer cache directory returned by `getPuppeteerDir()`.
  - `tab.screenshot()` creates parent directories and writes image files.
  - `tab.uploadFile()` resolves supplied paths against the session cwd.
- Network
  - CDP attach paths poll `http://127.0.0.1:<port>/json/version` or the supplied `cdp_url` `/json/version`.
  - Headless/browser-attach sessions create CDP websocket connections.
  - Headless first-use Chromium download uses the in-house `@oh-my-pi/pi-utils/browsers` installer.
  - Loopback relay mode may start the machine-global `omp.browser.relay` daemon. The extension connects outbound to the relay, and Puppeteer connects to its CDP-compatible endpoint.
  - User `page` / `tab` operations perform normal browser network traffic.
- Subprocesses / native bindings
  - Headless mode launches Chromium through Puppeteer.
  - `app.path` mode may spawn the target executable via `Bun.spawn()`.
  - `killExistingByPath()` / `gracefulKillTreeOnce()` use `@oh-my-pi/pi-natives` process inspection/termination.
  - Worker mode uses Bun `Worker`; fallback mode does not.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Browser handles are cached in a process-global `Map` keyed by browser kind in `packages/coding-agent/src/tools/browser/registry.ts`.
  - Tabs are cached in a process-global `Map` keyed by `name` in `packages/coding-agent/src/tools/browser/tab-supervisor.ts`.
  - `run` captures session cwd and optional `browser.screenshotDir` for screenshot path resolution.
  - `restartForModeChange()` drops only headless tabs.
- User-visible prompts / interactive UI
  - None beyond normal tool output. Dialog auto-handling is invisible unless it fails and emits debug logs.
- Background work / cancellation
  - `open`, `run`, CDP waits, and browser actions thread through abort signals.
  - A timed-out `run` aborts the worker execution path and can tear down the tab.

## Limits & Caps
- Tool timeout clamp: default `30` s, min `1` s, max `300` s (`TOOL_TIMEOUTS.browser` in `packages/coding-agent/src/tools/tool-timeouts.ts`).
- Supervisor grace period around init/run/close: `750` ms (`GRACE_MS` in `packages/coding-agent/src/tools/browser/tab-supervisor.ts`).
- Puppeteer protocol timeout for launch/connect operations: `60_000` ms (`BROWSER_PROTOCOL_TIMEOUT_MS` in `packages/coding-agent/src/tools/browser/launch.ts`).
- Connected-browser CDP readiness wait: `5_000` ms before `puppeteer.connect()` (`packages/coding-agent/src/tools/browser/registry.ts`).
- Spawned-app CDP readiness wait after spawn: `30_000` ms (`packages/coding-agent/src/tools/browser/registry.ts`).
- Relay extension handshake wait: `35_000` ms; loopback relay daemon readiness: `15_000` ms (`packages/coding-agent/src/tools/browser/{registry,relay/daemon}.ts`).
- CDP polling cadence: 150 ms in `waitForCdp()` (`packages/coding-agent/src/tools/browser/attach.ts`).
- Headless default viewport: `1365x768` at `deviceScaleFactor: 1.25` (`DEFAULT_VIEWPORT` in `packages/coding-agent/src/tools/browser/launch.ts`).
- Screenshot model-attachment resize cap: `maxWidth 1024`, `maxHeight 1024`, `maxBytes 150 * 1024`, `jpegQuality 70` (`packages/coding-agent/src/tools/browser/tab-worker.ts`).
- `tab.waitForUrl()` polling interval: `200` ms (`packages/coding-agent/src/tools/browser/tab-worker.ts`).
- Drag simulation uses `12` mouse-move steps (`packages/coding-agent/src/tools/browser/tab-worker.ts`).
- Per-op fail-fast ceilings (`packages/coding-agent/src/tools/browser/tab-worker.ts`): quick page reads (`observe`/`screenshot`/`extract`/`ariaSnapshot`) `min(cellBudget − 1s, 20s)`; interactive actions + default waits `min(cellBudget − 1s, 15s)`; an explicit `{ timeout }` on a `waitFor*` is clamped to `cellBudget − 1s` (`0`/`Infinity` → that bound). See `resolveOpTimeouts()` / `resolveWaitTimeout()`.

## Errors
- `BrowserTool.execute()` converts DOM-style `AbortError` into `ToolAbortError`; other errors propagate.
- `run` hard-fails on missing code: `Missing required parameter 'code' for action 'run'.`
- `open` fails when reusing a name across browser kinds: `Tab "..." is bound to a different browser (...). Close it first.`
- `runInTabWithSnapshot()` fails when the tab is absent/dead (`Tab "..." is not alive. Reopen it.`) or already running (`Tab "..." is busy`).
- Worker init failures and run failures are serialized through `RunErrorPayload`; `ToolError` and abort state are reconstructed on the host side by `errorFromPayload()`.
- Attached-target mismatches surface as:
  - `No page targets available on the attached browser`
  - `No page target matched "...". Available pages:\n...`
  - `Target ... is no longer available on the attached browser`
- Spawned-app path validation requires an absolute executable path after cwd resolution, not an app bundle directory path.
- Spawn/attach failures are wrapped into `ToolError`s such as `Timed out waiting for CDP endpoint ...`, `Failed to attach to ...`, or `Connected to ... but puppeteer.connect failed: ...`.
- `app.cdp_url` must be the HTTP CDP discovery endpoint, not a `ws://` URL; otherwise `normalizeConnectedCdpUrl()` throws `browser app.cdp_url must be the HTTP CDP discovery endpoint ...`.
- Relay mode rejects an unreachable endpoint or a relay whose extension never connects. Loopback CLI-host errors tell the user to run `omp browser-relay install` and check the extension badge; remote/non-auto-started errors tell the user to start `omp browser-relay` or check the endpoint.
- `tab` helper errors are user-visible `ToolError`s, including unsupported selector prefix, stale/unknown element id, invalid drag target, missing upload files, non-`<select>` for `tab.select()`, non-file-input for `tab.uploadFile()`, and screenshot selector misses.
- On run timeout, the worker reports `Browser code execution timed out after <ms>ms` (with `(stalled on <op>)` naming the still-running helper); a single stalled per-op helper instead rejects with `tab.<op>(...) timed out after <ms>ms` before the cell budget is reached. The supervisor may escalate to `Browser code execution hung past grace; tab killed` if the worker does not respond after the grace window.

## Notes
- Use `read` for static URLs; use `browser` when JavaScript execution, authentication, or interaction is required. A tab must be opened before `run`, and named tabs persist until closed.
- `run` code has full Node/Bun and session-tool access; it is not sandboxed.
- `loadPuppeteer()` and `loadPuppeteerInWorker()` temporarily redirect `cwd` to a safe Puppeteer directory before importing `puppeteer-core`, because Puppeteer probes the current working directory during module load.
- Headless launch resolves its executable in this order: `PUPPETEER_EXECUTABLE_PATH` always wins; otherwise, on macOS the isolated Chrome for Testing binary (`com.google.chrome.for.testing`) is preferred over a detected system Chrome and downloaded on first use, falling back to system Chrome only when Chrome for Testing cannot be obtained (a headless daemon launched from a system `Google Chrome.app` bundle shares its `com.google.Chrome` LaunchServices identity, so macOS can route the user's link clicks to the daemon — #8673). On other platforms a detected system Chrome/Chromium is preferred, then a downloaded Chrome for Testing.
- Headless launch always passes `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-blink-features=AutomationControlled`, and a `--window-size=...` matching the initial viewport. It also ignores Puppeteer default args `--disable-extensions`, `--disable-default-apps`, and `--disable-component-extensions-with-background-pages`.
- Proxy-related env vars only affect headless launch argv (shared and local): `PUPPETEER_PROXY`, `PUPPETEER_PROXY_BYPASS_LOOPBACK`, and `PUPPETEER_PROXY_IGNORE_CERT_ERRORS`. For the shared daemon they are baked in at first launch and take effect again after the daemon's next cold start.
- Stealth patches are applied only in headless mode. Spawned or externally connected browsers are intentionally left untouched.
- Relay mode drives an existing user browser and receives no stealth patches. Anything that can reach the relay endpoint can drive logged-in tabs; the built-in server binds loopback, and an optional shared token gates the extension connection.
- `applyStealthPatches()` also strips Puppeteer's `//# sourceURL=__puppeteer_evaluation_script__` suffix from CDP `Runtime.evaluate` / `Runtime.callFunctionOn` payloads.
- `tab.extract()` reads `page.content()`, runs Readability first, then falls back to the first non-empty of `[data-pagefind-body]`/`main article`/`article`/`main`/`[role='main']`/`body`, and returns `null` if neither extraction path yields content.
- `close(all: true, kill: false)` disconnects from spawned, connected, and relay browsers when the last managed tab is released but leaves their pages, spawned app processes, and the user's Chrome running. `kill: true` additionally terminates spawned-app processes; it never closes or kills connected or relay browsers.
- Headless orphan cleanup is best-effort: if a worker dies before closing its page, the supervisor searches browser targets by `targetId` and closes that page. A worker killed mid-init (init budget exhausted, aborted open) is covered the same way through the target the worker reported in `page-created` — a killed worker can't clean up after itself, and a shared browser's other targets are never touched.
- Console methods inside `run` do not appear in tool output; they are forwarded as debug/warn/error logs through the worker transport.
- Raw page request interception is run-scoped. At run end the worker removes user `request` handlers, disables interception, and releases held requests; cleanup failure marks the tab for recovery.