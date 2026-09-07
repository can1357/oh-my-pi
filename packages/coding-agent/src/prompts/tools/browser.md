Drive real Chromium tabs from JavaScript or Python Eval with the global `browser` object.

<instruction>
- Static content? Use `read`. Use `browser` for JavaScript execution, authenticated sessions, and interactive actions.
- JavaScript: `await browser.open(options)` returns a `BrowserTab`; `browser.tab(name)` returns an existing handle; `await browser.close(options)` releases tabs.
- Python: `await browser.open(name=…, url=…)`, synchronous `browser.tab(name)`, and `await browser.close(name=…)`. Python methods accept keyword arguments.
- `open` options: `name`, `url`, `app`, `viewport`, `wait_until`, `dialogs`, `timeout`.
- `close` options: `name`, `all`, `kill`, `timeout`.
- Direct tab helpers:
  - Navigation: `url`, `title`, `goto`.
  - Inspection: `observe`, `ariaSnapshot`, `screenshot`, `extract`.
  - Interaction: `click`, `type`, `fill`, `press`, `scroll`, `drag`, `scrollIntoView`, `select`, `uploadFile`.
  - Waiting: `waitFor`, `waitForSelector`, `waitForUrl`.
  - Page execution: `evaluate`.
- `tab.id(n)` / `tab.ref("e5")` return `BrowserElement` handles supporting `click`, `type`, `fill`, `press`, `hover`, `focus`, `select`, `uploadFile`, `scrollIntoView`, `boundingBox`, `isVisible`, `isHidden`, and `evaluate`. A string passed to `BrowserElement.evaluate` is a function expression invoked with the element as its first argument.
- JavaScript `await tab.run(fnOrCode, { args?, timeout? })` runs a function or code string. Functions receive `{ tab, page, browser, wait, assert }`; cell closures are not captured. Plain data, functions, and `RegExp` values are supported in `args`.
- Python `await tab.run(code, timeout=…)` accepts a JavaScript code string only. Direct Python helpers use the same method names; keyword arguments become a trailing JavaScript options object.
- `tab.run` executes in an isolated JavaScript tab runtime with raw Puppeteer `page`/`browser`, ordinary Eval helpers, and full Bun/Node + tool-bridge access. It is not sandboxed.
- Direct helpers and `tab.run` return real structured values. Nonempty inner `display` text prints in the outer Eval cell; screenshots surface as Eval images.
- Selectors accept CSS plus Puppeteer `aria/…`, `text/…`, `xpath/…`, and `pierce/…` query handlers.
- Navigation and re-renders invalidate observed ids and refs. Re-observe, then act in the same cell.
- Use `tab.select` for `<select>` elements; `tab.fill` does not support them.
- Raw request interception lasts only for the current `tab.run`.

Application modes:
- `app.path`: spawn the specified browser or Electron executable.
- `app.cdp_url`: attach to an existing CDP endpoint.
- `app.relay: true`: drive the user's Chrome through the omp relay. `app.target` selects a tab by URL/title substring; without it, the visible tab is adopted. Opening with `url` navigates that adopted tab.
- Relay sessions are the user's real logged-in browser. Sites attribute actions to the user. Name a target or create a dedicated tab; NEVER navigate the visible tab without authorization.
- Closing releases the managed tab. It never closes relay/CDP-attached pages. Spawned browsers remain open unless `kill: true`.
</instruction>

<examples>
```javascript
const tab = await browser.open({ name: "docs", url: "https://example.com" });
const observed = await tab.observe();
await tab.id(observed.elements[0].id).click();
const title = await tab.run(async ({ tab }, suffix) => (await tab.title()) + suffix, { args: ["!"] });
await tab.close();
```

```python
tab = await browser.open(name="docs", url="https://example.com")
observed = await tab.observe()
await tab.id(observed["elements"][0]["id"]).click()
title = await tab.run("return await tab.title();", timeout=30)
await tab.close()
```
</examples>

<critical>
- MUST open a tab before direct use; `browser.tab(name)` does not open one.
- Default to `tab.observe()`; use screenshots for visual confirmation.
- `tab.run` has full Bun/Node and tool-bridge access; it is not sandboxed.
- Relay and CDP actions operate on real user sessions.
</critical>
