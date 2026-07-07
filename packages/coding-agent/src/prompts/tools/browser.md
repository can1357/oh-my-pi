Drives a real Chromium tab with full puppeteer access from JS.

<instruction>
- Static content (articles, docs, issues/PRs, JSON, PDFs, feeds)? `read` the URL. Browser only for JS execution, auth, or interactive actions.
- Three actions:
  - `open` — acquire/reuse named tab (`name` defaults `"main"`). Optional `url` (navigate once ready), `viewport`, `dialogs: "accept" | "dismiss"` (auto-handle `alert`/`confirm`/`beforeunload`; else the page hangs until `page.on('dialog', …)`).
  - `close` — release tab by `name`, or all with `all: true`. `kill: true` also tears down spawned-app process trees.
  - `run` — execute JS in the existing tab. `code` is an async function body; `page`, `browser`, `tab`, `display`, `assert`, `wait` are in scope. Return value is JSON-stringified into the result; `display(value)` accumulates text/images.
- Tabs survive `run` calls and in-process subagents — open once, reuse.
- Browser kinds (`app` on `open`):
  - default (no `app`) → headless Chromium with stealth patches.
  - `app.path` → spawn absolute binary (Electron/CDP). No stealth patches — NEVER tamper with a real desktop app.
  - `app.cdp_url` → connect to existing CDP endpoint (e.g. `http://127.0.0.1:9222`).
  - `app.target` (with `path`/`cdp_url`) — substring on url+title picks a BrowserWindow.
- `tab` helpers cover goto / observe / click / type / fill / press / scroll / drag / scrollIntoView / waitFor / select / uploadFile / waitForUrl / waitForResponse / evaluate / screenshot / extract. Drop to raw puppeteer `page` for anything uncovered.
- Selectors: CSS + puppeteer handlers `aria/Sign in`, `text/Continue`, `xpath/…`, `pierce/…`; also Playwright-style `p-aria/…`, `p-text/…`.
- `tab.fill` NEVER works for `<select>` — use `tab.select(selector, …values)`.
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