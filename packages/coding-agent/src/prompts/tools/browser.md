Drives real Chromium tab; full puppeteer access via JS.

<instruction>
- Static content (articles, docs, issues/PRs, JSON, PDFs, feeds)? `read` the URL. Browser only for JS execution, auth, interactive actions.
- Three actions:
  - `open` — acquire/reuse named tab (`name` defaults `"main"`). Optional `url` (navigate once ready), `viewport`, `dialogs: "accept" | "dismiss"` (auto-handle `alert`/`confirm`/`beforeunload`; else page hangs till you wire `page.on('dialog', …)`).
  - `close` — release tab by `name`, or all with `all: true`. `kill: true` also kills spawned-app process trees.
  - `run` — execute JS in existing tab. `code` = async function body; `page`, `browser`, `tab`, `display`, `assert`, `wait` in scope. Return value JSON-stringified into result; `display(value)` accumulates text/images.
- Tabs survive `run` calls and in-process subagents — open once, reuse.
- Browser kinds (`app` on `open`):
  - default (no `app`) → headless Chromium with stealth patches.
  - `app.path` → spawn absolute binary (Electron/CDP). No stealth patches — NEVER tamper with a real desktop app.
  - `app.cdp_url` → connect to existing CDP endpoint (e.g. `http://127.0.0.1:9222`).
  - `app.target` (with `path`/`cdp_url`) — substring on url+title picks BrowserWindow.
- `tab` helpers; drop to raw puppeteer `page` for anything uncovered:
  - `tab.goto(url, { waitUntil? })` — navigate.
  - `tab.observe({ includeAll?, viewportOnly? })` — accessibility snapshot: `{ url, title, viewport, scroll, elements: [{ id, role, name, value, states, … }] }`. Ids stable until next observe/goto.
  - `tab.ariaSnapshot(selector?, { depth?, boxes? })` — Playwright-format ARIA-tree YAML (nested roles + accessible names + `/url`/`/placeholder`), scoped to `selector` or the whole document. Every node carries a `[ref=eN]` id; `[cursor=pointer]` flags clickables. Captures dense, hierarchical structure/text that `observe()`'s flat list flattens away. Refs renumber from e1 each call and stay valid until the next `ariaSnapshot()`.
  - `tab.ref("e5")` — `[ref=eN]` from the last ariaSnapshot → element handle with the common action methods (`.click()`, `.type()`, `.fill()`, `.hover()`, `.evaluate()`, …); the primary way to act on a ref. For convenience `aria-ref=e5` also works inline in `tab.click`/`type`/`fill`/`waitFor`/`scrollIntoView` (e.g. `tab.click("aria-ref=e5")`).
  - `tab.id(n)` — id from last observe → `ElementHandle` (`.click()`, `.type()`, …).
  - `tab.click(selector)` / `tab.type(selector, text)` / `tab.fill(selector, value)` / `tab.press(key, { selector? })` / `tab.scroll(dx, dy)`.
  - `tab.waitFor(selector, { timeout? })` / `tab.waitForSelector(selector, { timeout?, visible?, hidden? })` — wait until attached (optionally visible/hidden); returns the `ElementHandle`.
  - `tab.drag(from, to)` — endpoints: selector (center-to-center) or `{ x, y }` viewport point (canvases, sliders).
  - `tab.scrollIntoView(selector)` — center in viewport; before clicking off-screen elements.
  - `tab.select(selector, …values)` — set `<select>` option(s); returns selection. `tab.fill` NEVER works for selects.
  - `tab.uploadFile(selector, …filePaths)` — attach files to `<input type="file">`; paths relative to cwd.
  - `tab.waitForUrl(pattern, { timeout? })` — substring or `RegExp` (matches SPA pushState nav); returns matched URL.
  - `tab.waitForResponse(pattern, { timeout? })` — substring, `RegExp`, or `(response) => boolean`; returns puppeteer `HTTPResponse` (`.text()`/`.json()`/`.status()`/`.headers()`).
  - `tab.waitForNavigation({ waitUntil?, timeout? })` — resolves on the next navigation. Start it BEFORE the click/submit that triggers it; after `tab.goto` (which already waits) use `tab.waitForUrl`/`tab.waitForSelector` instead.
  - `tab.evaluate(fn, …args)` — `page.evaluate` for ad-hoc DOM reads.
  - `tab.screenshot({ selector?, fullPage?, save?, silent? })` — capture + attach for viewing (`silent: true` skips). Pass `save` only when a later step needs the file.
  - `tab.extract(format = "markdown")` — readable page content (`"markdown"` | `"text"`); throws when nothing readable.
- Selectors: CSS + puppeteer handlers `aria/Sign in`, `text/Continue`, `xpath/…`, `pierce/…`; also Playwright-style `p-aria/…`, `p-text/…`. Playwright-only engines/pseudos (`:has-text()`, `:visible`, …) are rejected — use `text/…` or `aria/…`. A stalled action/wait fails fast with a named `tab.<op> timed out` error, never the whole-cell timeout.
</instruction>

<critical>
- MUST `open` before `run` — `run` never creates a tab.
- Default to `tab.observe()` for page state — structured data, actionable ids. Screenshot ONLY when appearance matters.
- Navigation invalidates element ids — re-observe before use.
- `code` runs with full Node access. Treat as your code, not sandboxed.
</critical>

<output>
Per call: `display(value)` output, then `code`'s return value. `run` always produces at least a status line.
</output>
