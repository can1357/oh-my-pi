---
title: Browser & App Automation
description: The agent can drive a real browser or any CDP-attached desktop app — navigate, click, fill, screenshot, and script tabs.
coverage: B
---

The browser tool gives the agent a real Chromium tab, attaches to any app that exposes a Chrome DevTools Protocol endpoint (every Electron app), or drives a cmux WKWebView surface. The agent uses it to read pages the way you would, fill forms, click through flows, and capture screenshots; you can configure where it runs, what it can reach, and where screenshots land.

## What the agent can drive

- **Headless Chromium** — a local Puppeteer-managed Chromium with stealth patches applied, default viewport `1365×768` at `deviceScaleFactor: 1.25`, launched with `--no-sandbox` and `--disable-blink-features=AutomationControlled`.
- **A CDP-attached app** — point the tool at any running process that speaks CDP. Slack, VS Code, and every other Electron app are reachable. Stealth patches are intentionally skipped in this mode.
- **A cmux surface** — drive a `cmux` WKWebView over its unix socket instead of spawning Puppeteer.
- **A custom CDP URL** — attach to a browser you started yourself; close only disconnects, it does not kill your process.

The tool picks the kind per call: `app.cdp_url` attaches to that endpoint, `app.path` resolves against the session cwd and spawns (or reuses) that executable with `--remote-debugging-port`, otherwise a configured `browser.cdpUrl` setting attaches, then cmux when `CMUX_SOCKET_PATH` is set and `browser.cmux` is enabled, then headless as a last resort.

## Tabs

Tabs are process-global and named. The same name is reused across later calls (and across in-process subagents) until you close it. The default name is `main`. Reusing a name across different browser kinds is rejected — close the tab first. Each call returns text like `Opened` or `Reused` plus browser description, URL, and title.

```text
# In the agent's tool call
{ "action": "open", "name": "main", "url": "https://example.com" }
{ "action": "open", "name": "docs", "url": "https://my.omp.sh/docs", "wait_until": "networkidle2" }
```

Dialogs can be auto-handled per tab with `dialogs: "accept"` or `dialogs: "dismiss"`. Changing the dialog policy on a live tab forces a recreate.

## Snapshots and refs

Two ways to get a handle on the page:

- **`tab.observe()`** — Puppeteer accessibility snapshot. Interactive nodes are filtered by default (pass `includeAll: true` to get every node, or `viewportOnly: true` to keep only viewport-visible ones). Each node gets a numeric id, `ElementHandle`s are cached, and the result returns URL/title/viewport/scroll metadata plus `elements`. Any new `observe()` clears and rebuilds the cache.
- **`tab.ariaSnapshot(selector?)`** — Playwright ARIA-snapshot YAML. Every node gets a `[ref=eN]` id, clickables get `[cursor=pointer]`, and matched DOM nodes are tagged with an `_ariaRef` expando. Existing `_ariaRef` expandos are cleared before each snapshot so ids renumber deterministically from `e1` (the fresh module's counter resets each call).

A ref is resolved with `tab.ref("e5")` (or `tab.id(5)`), which returns a live `ElementHandle`. After navigation or any new `observe()` call, the cache is invalidated — `tab.id(n)` and `tab.ref(id)` throw a stale-id error if the DOM changed or the cache was cleared.

For inline selector use inside `tab.click` / `tab.type` / `tab.fill` / `tab.waitFor` / `tab.scrollIntoView`, only the explicit `aria-ref=eN` / `aria-ref/eN` / `ariaref/eN` forms are recognized; a bare `eN` is rejected there so it does not collide with the cmux backend's own observe ids.

## Interactions and selectors

`tab.click`, `tab.type`, `tab.fill`, `tab.press`, `tab.scroll`, `tab.drag`, `tab.scrollIntoView`, `tab.select`, `tab.uploadFile`, and the `tab.waitFor*` helpers all run under a per-op deadline, so a stalled helper aborts the CDP action and rejects with a named `tab.<op> timed out after <ms>ms` rather than the whole cell.

Selectors accept plain CSS plus the puppeteer query handlers `text/…`, `aria/…`, `xpath/…`, and `pierce/…`. Legacy Playwright-style prefixes (`p-text/`, `p-xpath/`, `p-pierce/`, `p-aria/`) are rewritten; other `p-*` prefixes throw a `ToolError`. Playwright-only engines and pseudos (`:has-text()`, `:text()`, `:visible`, `:nth-match()`, `:near()`, `:above()`, …) on a CSS selector also throw — use the `text/` / `aria/` equivalents instead.

`tab.fill` does not work for `<select>`; use `tab.select(selector, ...values)`. `tab.uploadFile(selector, ...filePaths)` resolves paths against the session cwd.

## Screenshots

```text
{ "action": "run", "code": "await tab.screenshot({ selector: 'main', fullPage: true });" }
```

Saves a full-resolution PNG to `browser.screenshotDir` (when set) or the OS temp directory, returns the saved path, and records `{ dest, mimeType, bytes, width, height }` in the run details. A model-attached copy is resized to `maxWidth 1024 × maxHeight 1024`, `maxBytes 150 * 1024`, JPEG quality `70`. Pass `silent: true` to skip attaching an image content block.

## Driving an Electron app

```text
{ "action": "open",
  "app": { "path": "/Applications/Slack.app/Contents/MacOS/Slack", "target": "settings" },
  "name": "slack" }
```

`app.path` is resolved against the session cwd, then `findReusableCdp()` looks for a same-path process that already speaks CDP; if none, existing same-path processes are killed, a free loopback port is allocated, the executable is spawned with `--remote-debugging-port=<port>`, and the tool waits up to 30s for the CDP endpoint. `app.target` picks a page whose URL or title contains the case-insensitive substring; without it, the tool skips titles/URLs matching `request handler|devtools|background page|background host|service worker` and uses the first remaining page. `app.cdp_url` attaches without owning the process — `close` only disconnects.

## Closing tabs

```text
{ "action": "close", "name": "docs" }
{ "action": "close", "all": true, "kill": true }
```

`close` releases one tab. `close(all: true)` releases every known tab. `kill: true` terminates the spawned-app process tree when the last tab drops; headless shutdown ignores it. Connected browsers are always disconnected, never killed.

## Settings and env vars

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `browser.cdpUrl` | string | empty | Default CDP endpoint to attach to when the call carries no `app` |
| `browser.cmux` | boolean | true (when a `CMUX_SOCKET_PATH` is set) | Drive the cmux WKWebView backend over its unix socket |
| `browser.headless` | boolean | true | Default browser kind when no `app` and no `browser.cdpUrl` |
| `browser.screenshotDir` | path | OS temp dir | Where `tab.screenshot()` persists PNGs |

| Env var | Effect |
| --- | --- |
| `CMUX_SOCKET_PATH` | Path to the cmux unix socket; enables the cmux backend when `browser.cmux` is true |
| `PI_BROWSER_CMUX` | Force-enable or force-disable the cmux backend (overrides `browser.cmux`) |
| `PUPPETEER_EXECUTABLE_PATH` | Override the headless Chromium path before any download |
| `PUPPETEER_PROXY` | Proxy for the headless launch only |
| `PUPPETEER_PROXY_BYPASS_LOOPBACK` | Bypass loopback addresses through the proxy |
| `PUPPETEER_PROXY_IGNORE_CERT_ERRORS` | Ignore TLS errors when the proxy is in use |

Change settings with `omp config set <key> <value>`; see [Settings](/oh-my-pi/configuration/settings/).

:::caution
- Tool timeout is clamped to `1..300` seconds with a default of `30`; long-running `run` blocks must be sliced.
- Headless mode downloads Chromium on first launch. The first CDP attach on `app.cdp_url` has a 5s readiness wait; spawned-app attach has 30s.
- Console methods inside `run` are forwarded as debug logs, not tool output; use `display(value)` to surface values to the conversation.
:::
