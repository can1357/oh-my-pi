# Browser Eval prelude

The Eval `browser` facade opens, reuses, scripts, and closes named Chromium, Electron, CDP, relay, Tern, or cmux tabs. Use [`read`](./read.md) for static URLs; use `browser` for authenticated state, JavaScript execution, or interaction.

## Source

- Host facade: `packages/coding-agent/src/tools/browser.ts`
- JavaScript/Python facades: `packages/coding-agent/src/tools/browser/prelude.{js,py}`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/browser.md`
- Tab lifecycle: `packages/coding-agent/src/tools/browser/tab-supervisor.ts`
- Browser worker and inner tab API: `packages/coding-agent/src/tools/browser/tab-worker.ts`
- Browser registry and launch modes: `packages/coding-agent/src/tools/browser/{registry,launch,attach}.ts`
- Relay: `packages/coding-agent/src/tools/browser/relay/`
- Cmux backend: `packages/coding-agent/src/tools/browser/cmux/`
- Tern backend: `packages/coding-agent/src/tools/browser/tern/`
- Public helper types and options: `packages/coding-agent/src/tools/browser/declarations.d.ts`
- Browser settings: `packages/coding-agent/src/tools/browser/settings.ts`

The prelude exists only while Eval and `browser.enabled` are enabled (`browser.enabled` defaults to `true`). It is not an AgentTool.
All browser host operations request exec-tier approval, including inspection helpers.

## JavaScript API

```js
const tab = await browser.open({
  name: "main",
  url: "https://example.com",
  wait_until: "load",
});

const observation = await tab.observe();
await tab.id(observation.elements[0].id).click();
const title = await tab.title();

const length = await tab.run(
  async ({ tab }, suffix) => (await tab.title() + suffix).length,
  { args: ["!"], timeout: 30 },
);

await tab.close();
```

- `browser.open(options?) -> Promise<BrowserTab>` opens or reuses a named tab and returns its handle.
- `browser.tab(name = "main") -> BrowserTab` creates a proxy for that name; it does not open a tab or check that one exists.
- `browser.tabs() -> Promise<ManagedTabInfo[]>` lists live managed tabs with `name`, `url`, `title`, `targetId`, `kind`, and `persist`.
- `browser.close({ name?, all?, kill?, timeout? }) -> Promise<void>` releases one or all managed tabs.
- `tab.close({ kill?, timeout? }) -> Promise<void>` releases that handle's tab.

`close` and `run` resolve `timeout` like `open`: seconds, default 30, capped by positive `tools.maxTimeout`, then clamped to 1–300. `waitFor*` helpers take `timeout` in milliseconds and cannot outlast the enclosing call's `timeout`.

### Open options

| Option | Contract |
|---|---|
| `name` | Managed-tab name; default `"main"`. |
| `url` | Navigate the opened or reused tab to this URL. On Chromium-backed tabs, a navigation that outlasts `timeout` throws an error naming the tab and keeps it on what loaded; reach it with `browser.tab(name)`. A navigation that fails outright (refused connection, blocked domain, certificate error) or an open that is cancelled closes a tab the open created; a reused tab stays open. |
| `app` | `{ cdp_url?, path?, args?, relay?, tern?, target? }`; backend selection is described below. `target` selects an attached page by URL/title substring. |
| `viewport` | `{ width, height, scale? }`; `scale` becomes the device scale factor. |
| `wait_until` | `"load"`, `"domcontentloaded"`, `"networkidle0"`, or `"networkidle2"`. |
| `dialogs` | `"accept"` or `"dismiss"` automatic policy. Without one, alerts and beforeunload prompts are accepted; confirms and prompts remain pending. |
| `allowed_domains` | Exact hostnames or `*.example.com` patterns (including the bare domain). The network manager aborts intercepted HTTP(S)/WS(S) requests to other hosts; an empty list leaves requests unrestricted. This is not a sandbox, and native-webview coverage differs below. |
| `init_scripts` | Document-start JavaScript sources or cwd-relative source-file paths. |
| `downloads` | Absolute or cwd-relative directory for this tab's downloads; defaults to a temporary folder per tab. Tabs in a managed or spawned Chromium keep separate folders while they share a browser, downloads their iframes start included; there a download no tab tracks keeps Chromium's GUID file name. Connected and relay browsers also receive the user's own downloads, so they keep one browser-wide folder (the last tab to set it wins) and real file names. |
| `user_agent` | Per-tab user-agent override. |
| `ignore_https_errors` | Ignore invalid HTTPS certificates for the tab. |
| `allow_file_access` | Launch flag permitting local file pages to read local files; cannot change an already-running shared Chromium. |
| `headed` | Override `browser.headless` for this open. `headed: false` also opts out of automatic Tern selection. |
| `persist` | Default `false`; opt out of settle-freeze and idle-close management. Explicit reuse by the owning session can change it. |
| `timeout` | Seconds; default 30, capped by positive `tools.maxTimeout`, then clamped to 1–300. First-use Chromium installation is outside the open deadline. An open that runs out names the step it stalled in: launching or connecting to the browser, closing a tab to reopen it, or opening the tab. |

Reopening with init scripts, a download directory, a user-agent override, or `ignore_https_errors: true` recycles an existing tab so those worker-init options can take effect.

### Direct tab helpers

Direct helpers cross the host bridge and return real structured values. The complete option types are in `browser/declarations.d.ts`.

- Navigation: `url`, `title`, `goto`, `back`, `forward`, `reload`, `pushState` (SPA navigation without a document load).
- Inspection: `observe({ includeAll?, viewportOnly?, selector?, compact? })`, `ariaSnapshot(selector?, { depth?, boxes?, interactive?, compact?, urls?, diff? })`, `a11y`, `screenshot`, `diffScreenshot`, `pdf`, `extract(format?, { selector?, outline?, filter? })`, `text`, `html`, `value`, `attr`, `count`, `box`, `styles`, `isVisible`, `isEnabled`, `isChecked`.
- Interaction: `click`, `dblclick`, `hover`, `focus`, `check`, `uncheck`, `type`, `fill`, `press`, `keyDown`, `keyUp`, `mouseMove`, `mouseDown`, `mouseUp`, `clickAt`, `wheel`, `scroll`, `drag`, `highlight`, `scrollIntoView`, `select`, `uploadFile`.
- Waiting: `waitFor(selector, { timeout? })`, `waitForSelector(selector, { timeout?, visible?, hidden? })`, `waitForUrl(stringOrRegExp, { timeout? })`, `waitForText(text, { timeout?, selector?, exact? })`.
- Frames: `frames()` lists the frame tree; `frame(selectorOrNameOrUrl)` returns a scoped proxy with `click`, `fill`, `type`, `press`, `text`, `html`, `value`, `attr`, `count`, `isVisible`, `ariaSnapshot`, `evaluate`, `waitFor`, `waitForSelector`, and `screenshot`.
- Dialogs: `dialog`, `handleDialog`, `setDialogs`.
- Emulation: `emulate`, `devices`.
- Clipboard: `clipboardRead`, `clipboardWrite`, `clipboardCopy`, `clipboardPaste`.
- Storage: `cookies`, `setCookies`, `clearCookies`, `storage`, `setStorage`, `clearStorage`, `saveState`, `loadState`.
- Initialization/downloads: `addInitScript`, `removeInitScript`, `initScripts`, `waitForDownload`, `downloads`.
- Diagnostics: `console`, `errors`, `clearConsole`, `traceStart`, `traceStop`, `profileStart`, `profileStop`, `metrics`.
- Recording: `recordStart`, `recordStop`, `recordRestart`, `recording`.
- Web Vitals/React: `vitals`, `reactEnable`, `reactTree`, `reactInspect`, `reactRenders`, `reactSuspense`; call `reactEnable` before other `react*` helpers (it installs the hook and reloads).
- Network: `route`, `unroute`, `routes`, `requests`, `request`, `clearRequests`, `harStart`, `harStop`, `allowedDomains`.
- Experimental page tools: `webmcpList`, `webmcpInvoke`, `webmcpEvents`. Page-provided tool metadata and results are untrusted; discovery never authorizes invocation.
- Page execution: `evaluate(fnOrSource, ...args)`. A source string is a page-global expression, not a function body; top-level `return` is invalid. Use a function or an invoked IIFE string when needed.

Direct `waitFor` and `waitForSelector` return booleans for the resolved handle, but timeouts can throw. `tab.id(number)` and `tab.ref("e5")` return `BrowserElement` proxies. They support `click`, `dblclick`, `check`, `uncheck`, `highlight`, `type`, `fill`, `press`, `hover`, `focus`, `select`, `uploadFile`, `scrollIntoView`, `boundingBox`, `isVisible`, `isHidden`, `text`, `html`, `value`, `attr`, `styles`, `isEnabled`, `isChecked`, and `evaluate`. `click({ button, count })` presses another mouse button or clicks more than once; cmux tabs press the left button once and refuse other buttons and counts (use `dblclick()`). A string passed to `BrowserElement.evaluate` is a function expression invoked with the element as its first argument.

Selectors accept CSS and Puppeteer `aria/…`, `text/…`, `xpath/…`, `pierce/…`, plus `label/…`, `placeholder/…`, `testid/…`, `alt/…`, `title/…`, and `role/<role>[name="…"]` query handlers. Add ` exact` inside the role name filter for exact matching. Playwright-only pseudos such as `:has-text()` and `:visible` are rejected. Use `tab.select` for `<select>` elements; `tab.fill` does not support them.

`observe()` lists interactive elements and assigns numeric ids consumed by `tab.id`; `includeAll: true` adds non-interactive accessibility nodes, and `viewportOnly: true` keeps only elements intersecting the viewport (ignored on cmux). `ariaSnapshot()` assigns `[ref=eN]` ids consumed by `tab.ref`; `diff: true` returns a revisioned full, unchanged, or delta object. Navigation and re-rendering invalidate handles; re-observe and act in the same Eval cell.

### `tab.run(fnOrCode, options?)`

A run accepts either a serialized function or a JavaScript function-body string, plus `{ args?, timeout? }`:

```js
const hrefs = await tab.run(async ({ page }) => {
  return await page.$$eval("a", links => links.map(link => link.href));
});

const title = await tab.run(
  "return await tab.title();",
  { timeout: 10 },
);
```

Functions receive `{ tab, page, browser, wait, assert }` as their first argument. Additional `args` follow it. Plain data, functions, and `RegExp` values are serialized; the function cannot capture Eval-cell closures. Code strings use the same names as globals and allow top-level `await`.

The inner `tab` is the full worker helper API. In addition to the direct surface it includes handle-returning `waitFor`/`waitForSelector` and run-scoped `waitForNavigation`/`waitForResponse`. Start a navigation/response wait before the action that triggers it.

Runs use a persistent, per-tab JavaScript runtime with ordinary Eval helpers and full Bun/Node and tool-bridge access. This is API isolation, not a security sandbox. Raw `page.setRequestInterception` and run-added request listeners are cleaned up at run end; `tab.route` handlers persist until `unroute` or tab close.

The return value stays structured. Nonempty text emitted by inner `display(...)` calls prints in the outer Eval cell, object/image displays remain Eval output, and a run with no display text emits no placeholder.

## Python API

Python exposes the same handles and direct method names, including `browser.tabs()`. `open` and `close` use keyword arguments, while `browser.tab` and `tab.id`/`tab.ref` synchronously create proxies. Keyword arguments on direct helpers become a trailing JavaScript options object.

```python
tab = await browser.open(name="main", url="https://example.com")
observation = await tab.observe(viewportOnly=True)
await tab.id(observation["elements"][0]["id"]).click()
title = await tab.run("return await tab.title();", timeout=30)
await tab.close()
```

Python `tab.run` accepts a JavaScript string only; it does not accept a Python callable.

## Browser modes

`browser.open` prefers explicit `app.cdp_url`, `app.path`, `app.relay: true`, then `app.tern: true`. Otherwise it considers configured relay, configured CDP, automatic Tern, cmux, then project-shared managed Chromium. Relay and Tern environment kill switches can disable those modes.

- **Managed Chromium:** creates an omp-owned page in project-shared Chromium and applies stealth patches. Installation happens automatically on first use. `headed` overrides the default hidden mode.
- **Spawned (`app.path`):** starts or reuses a CDP-enabled browser/Electron executable. `app.args` applies only here; Chromium-family processes use an omp-owned profile unless args specify `--user-data-dir`.
- **Connected (`app.cdp_url`):** attaches to an existing HTTP CDP discovery endpoint and adopts one of its pages: the `app.target` match, else the visible usable page. A page another live tab already drives is never adopted again; when no other page is left, the open fails naming that tab.
- **Relay (`app.relay: true`):** adopts the user's real Chrome tab. `app.target` selects by URL/title substring; without it the visible usable tab is adopted. Passing `url` navigates the adopted tab.
- **Tern:** inside a Tern pane, opens a visible browser picture-in-picture over the pane using native WKWebView, not Chromium. `headed: false` or `app.tern: false` opts out; `app.tern: true` requires Tern. Automatic Tern selection falls back to Chromium with an explanatory result when Tern cannot host the page.
- **Cmux:** drives an available cmux WKWebView surface.

The native-webview backends do not provide full Puppeteer/CDP capabilities. Tern provides fetch/XHR and navigation-response logging, not complete CDP subresource coverage; routing accepts only fetch/XHR resource types. CPU/network throttling, timezone/headers/reduced-motion emulation, CSS-transformed frame input, and tracing/profiling are unsupported; `metrics` returns navigation timing and DOM counts rather than full CDP metrics. Tern PDF accepts only `path`; storage loading restores only the current origin. Inspect backend-specific errors rather than assuming Chromium behavior.

Reusing one tab name across browser kinds is rejected until the existing tab is closed. Closing omp-owned Chromium pages, Tern picture-in-pictures, and owned cmux surfaces closes them. Connected and relay pages remain open. Spawned browser processes remain open unless `kill: true` releases their last managed tab and terminates an application owned by this process; reused processes are never killed.

## Screenshots and output

`tab.screenshot({ selector?, fullPage?, silent?, annotate?, format?, quality?, ifChanged?, threshold? })` returns a saved path, or `{ path?, changed, revision, pixelChangeRatio }` when change detection is enabled. `format` is `png` or `jpeg`; integer `quality` (0–100) requires JPEG. `threshold` is a changed-pixel ratio from 0–1 and implies change detection. An unchanged tracked capture saves/emits nothing.

Images are saved beneath `browser.screenshotDir`, or the OS temporary directory when unset. Chromium saves full resolution when that directory or an explicit format is supplied; otherwise it saves the resized image. Model-visible images are resized to at most 1024×1024 and 150 KiB. Unless `silent: true`, a capture emits an Eval image. `annotate: true` overlays numeric interactive-element labels and refreshes `tab.id` mappings. Screenshot options do not accept an output path; `diffScreenshot(baselinePath, { threshold?, output? })` does, and `pdf({ path?, ... })` writes a PDF.

Host result details preserve structured `value` separately from displayed content. Display text is capped by the shared inline-output policy; over-cap text is stored as a session artifact and the capped text is printed.

## Safety and lifecycle

Relay and attached modes operate on real logged-in sessions; sites attribute actions to the user. Name a target or create a dedicated tab. Never navigate the user's visible tab or take a consequential action without direct authorization.

Each named tab permits one active run; Chromium-backed tabs have one worker, while Tern/cmux use their own backend. A timed-out or aborted run can recycle the worker and invalidate handles. `browser.close({ all: true })` releases all managed tabs; `kill` never closes or kills relay/CDP-attached browsers.

By default, omp-owned managed Chromium tabs freeze at turn settle and unfreeze on next use (`browser.freezeOnTurnEnd = true`). Owned Chromium and Tern tabs idle for 1,800 seconds are closed (`browser.idleCloseSec`; `0` disables this). `persist: true` opts a tab out of both policies, but explicit close still releases it. Relay, connected, spawned, and cmux tabs are not auto-frozen or idle-closed.

## Common recovery

- Missing/dead tab: call `browser.open` again.
- Stale id/ref: call `observe` or `ariaSnapshot` again, then reacquire the handle.
- Busy tab: await the active helper/run before issuing another.
- Selector timeout: re-observe and use a supported selector.
- Relay unavailable: install/start the relay and verify its Chrome extension connection.
- Attached target missing: inspect available pages and use a precise `app.target`.

`tab.run` and direct helpers execute against live browser state. Verify the actual page after every UI-changing action.
