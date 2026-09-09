# Browser Eval prelude

The Eval `browser` facade opens, reuses, scripts, and closes named Chromium, Electron, CDP, relay, or cmux tabs. Use [`read`](./read.md) for static URLs; use `browser` for authenticated state, JavaScript execution, or interaction.

## Source

- Host facade: `packages/coding-agent/src/tools/browser.ts`
- JavaScript/Python facades: `packages/coding-agent/src/tools/browser/prelude.{js,py}`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/browser.md`
- Tab lifecycle: `packages/coding-agent/src/tools/browser/tab-supervisor.ts`
- Browser worker and inner tab API: `packages/coding-agent/src/tools/browser/tab-worker.ts`
- Browser registry and launch modes: `packages/coding-agent/src/tools/browser/{registry,launch,attach}.ts`
- Relay: `packages/coding-agent/src/tools/browser/relay/`
- Cmux backend: `packages/coding-agent/src/tools/browser/cmux/`

The prelude exists only while Eval and `browser.enabled` are enabled. It is not an AgentTool.

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
- `browser.tab(name = "main") -> BrowserTab` returns an existing handle; it does not open a tab.
- `browser.close({ name?, all?, kill?, timeout? }) -> Promise<void>` releases one or all managed tabs.
- `tab.close({ kill?, timeout? }) -> Promise<void>` releases that handle's tab.

`open` accepts `name`, `url`, `viewport`, `wait_until`, `dialogs`, `app`, and `timeout`. `timeout` is in seconds, defaults to 30, and is clamped to 1–300.

### Direct tab helpers

Direct helpers cross the host bridge and return real structured values:

- Navigation: `url()`, `title()`, `goto(url, { waitUntil? })`
- Inspection: `observe({ includeAll?, viewportOnly? })`, `ariaSnapshot(selector?, { depth?, boxes? })`, `screenshot({ selector?, fullPage?, silent? })`, `extract("markdown" | "text")`
- Interaction: `click(selector)`, `type(selector, text)`, `fill(selector, value)`, `press(key, { selector? })`, `scroll(dx, dy)`, `drag(from, to)`, `scrollIntoView(selector)`, `select(selector, ...values)`, `uploadFile(selector, ...paths)`
- Waiting: `waitFor(selector, { timeout? })`, `waitForSelector(selector, { timeout?, visible?, hidden? })`, `waitForUrl(stringOrRegExp, { timeout? })`
- Page execution: `evaluate(fnOrSource, ...args)`

Direct `waitFor` and `waitForSelector` return booleans. `tab.id(number)` and `tab.ref("e5")` instead return `BrowserElement` handles. Handles support `click`, `type`, `fill`, `press`, `hover`, `focus`, `select`, `uploadFile`, `scrollIntoView`, `boundingBox`, `isVisible`, `isHidden`, and `evaluate`. A string passed to `BrowserElement.evaluate` is a function expression invoked with the element as its first argument.

Selectors accept CSS and Puppeteer `aria/…`, `text/…`, `xpath/…`, and `pierce/…` query handlers. Playwright-only pseudos such as `:has-text()` and `:visible` are rejected. `tab.select` is required for `<select>` elements; `tab.fill` does not support them.

`observe()` assigns numeric ids consumed by `tab.id`. `ariaSnapshot()` assigns `[ref=eN]` ids consumed by `tab.ref`. Navigation and re-rendering invalidate handles; re-observe and act in the same Eval cell.

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

Runs use the shared JavaScript runtime with ordinary Eval helpers and full Bun/Node and tool-bridge access. This is API isolation, not a security sandbox. Request interception is cleaned up at the end of each run.

The return value stays structured. Nonempty text emitted by inner `display(...)` calls prints in the outer Eval cell, object/image displays remain Eval output, and a run with no display text emits no placeholder.

## Python API

Python exposes the same handles and direct method names. `open` and `close` use keyword arguments, while `browser.tab` and `tab.id`/`tab.ref` are synchronous handle lookups. Keyword arguments on direct helpers become a trailing JavaScript options object.

```python
tab = await browser.open(name="main", url="https://example.com")
observation = await tab.observe(viewportOnly=True)
await tab.id(observation["elements"][0]["id"]).click()
title = await tab.run("return await tab.title();", timeout=30)
await tab.close()
```

Python `tab.run` accepts a JavaScript string only; it does not accept a Python callable.

## Browser modes

`browser.open` selects a browser in this order when explicitly requested: `app.cdp_url`, `app.path`, then `app.relay`. Without explicit selection it considers relay settings, configured CDP, cmux, then project-shared headless Chromium.

- **Headless:** creates an omp-owned page in project-shared Chromium and applies stealth patches.
- **Spawned (`app.path`):** starts or reuses a CDP-enabled browser/Electron executable. `app.args` applies only here.
- **Connected (`app.cdp_url`):** attaches to an existing HTTP CDP discovery endpoint.
- **Relay (`app.relay: true`):** adopts the user's real Chrome tab. `app.target` selects by URL/title substring; without it the visible usable tab is adopted.
- **Cmux:** drives an available cmux WKWebView surface.

Reusing one tab name across browser kinds is rejected until the existing tab is closed. Closing omp-owned headless pages and owned cmux surfaces closes them. Connected and relay pages remain open. Spawned browser processes remain open unless `kill: true` releases their last managed tab and terminates the process.

## Screenshots and output

`tab.screenshot()` saves a full-resolution image beneath `browser.screenshotDir`, or the OS temporary directory when unset, and returns the path. Unless `silent: true`, it also emits an Eval image. It never accepts an output path.

Host result details preserve structured `value` separately from displayed content. Display text is capped by the shared inline-output policy; over-cap text is stored as a session artifact and the capped text is printed.

## Safety and lifecycle

Relay and attached modes operate on real logged-in sessions; sites attribute actions to the user. Name a target or create a dedicated tab. Never navigate the user's visible tab or take a consequential action without direct authorization.

Each named tab has one worker and permits one active run. A timed-out or aborted run can recycle the worker and invalidate handles. `browser.close({ all: true })` releases all managed tabs; `kill` never closes or kills relay/CDP-attached browsers.

## Common recovery

- Missing/dead tab: call `browser.open` again.
- Stale id/ref: call `observe` or `ariaSnapshot` again, then reacquire the handle.
- Busy tab: await the active helper/run before issuing another.
- Selector timeout: re-observe and use a supported selector.
- Relay unavailable: install/start the relay and verify its Chrome extension connection.
- Attached target missing: inspect available pages and use a precise `app.target`.

`tab.run` and direct helpers execute against live browser state. Verify the actual page after every UI-changing action.
