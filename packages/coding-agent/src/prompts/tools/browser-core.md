Drive real Chromium tabs from JavaScript or Python Eval with the global `browser` object. This is the core; the full reference has every helper's options, application modes (relay, Tern, CDP, app paths) and platform notes.

<instruction>
- Static content? Use `read`. Use `browser` for JavaScript execution, authenticated sessions, and interactive actions.
- `await browser.open({name?, url?, app?, timeout?, persist?})` returns a `BrowserTab`;
  `browser.tab(name)` returns an open one; `await browser.tabs()` lists them;
  `await browser.targets({app?})` lists pages `target` can adopt;
  `await browser.close({name?, all?})` releases tabs. Python takes the same names as keyword arguments.
- Relay tabs omp opened close when the session ends. For a page you leave open for the user, pass `persist: true` to `open`;
  for a tab already open, call `browser.open({ name, persist: true })` again with its name.
- `open`, `close`, and `run` take `timeout` in seconds; `waitFor*` helpers take it in milliseconds.
- Tab helpers:
  - Navigation: `url`, `title`, `goto`, `back`, `forward`, `reload`.
  - Look: `observe({selector?, viewportOnly?, includeAll?})` lists interactive elements with ids;
    `text(selector?)`, `extract(format?)`, `value`, `attr`, `count`, `isVisible`,
    `screenshot({selector?, fullPage?})`. `text()` without a selector reads `<body>`.
  - Act: `click(selector, {button?, count?})`, `dblclick`, `hover`, `check`, `uncheck`,
    `fill(selector, text)`, `type(selector, text)`, `press(key, {selector?})`,
    `select(selector, …values)` (for `<select>`; `fill` does not handle them), `uploadFile(selector, …paths)`,
    `scroll(dx, dy)`, `drag(from, to)`, `clickAt(x, y)`.
  - Wait: `waitFor`, `waitForSelector`, `waitForUrl`, `waitForText`; they resolve as soon as the condition holds.
    After a click or navigation wait for the expected text, URL or selector instead of a fixed sleep.
  - Frames: `frame(selectorOrNameOrUrl)` returns a handle with `click`, `fill`, `type`, `press`, `text`, `evaluate`, `waitForSelector`.
  - Dialogs: alerts are accepted automatically; confirms and prompts wait for `handleDialog`.
  - Downloads: start `waitForDownload()` and the click that downloads in one `tab.run`.
  - Page JavaScript: `tab.evaluate(fnOrExpression)` runs in the page; a string is an expression (no top-level `return`), so pass a function to use `return`.
- `tab.id(n)` (an id from the last `observe()`) and `tab.ref("e5")` (a ref from the last `ariaSnapshot()`)
  return element handles with `click`, `fill`, `type`, `press`, `select`, `check`, `text`, `value`, `evaluate` and more.
- `await tab.run(fnOrCode, {args?, timeout?})` runs a function, called with `{tab, page, browser}` and then each `args` item,
  in a separate runtime with Puppeteer `page`; it is Node, not the page.
  Python `await tab.run(code, timeout=…)` takes a JavaScript code string only.
- Selectors: CSS plus `aria/…`, `text/…`, `xpath/…`, `pierce/…`, `label/…`, `placeholder/…`, `role/<role>[name="…"]`. No Playwright selectors.
- Navigation and re-renders invalidate observed ids. Re-observe, then act in the same cell.
</instruction>

<examples>
```javascript
const tab = await browser.open({ name: "docs", url: "https://example.com" });
const observed = await tab.observe();
await tab.id(observed.elements[0].id).click();
print(await tab.title());
```
</examples>

<critical>
- MUST open a tab before direct use; `browser.tab(name)` does not open one.
- Default to `tab.observe()`; use screenshots for visual confirmation.
- `tab.run` has full Bun/Node and tool-bridge access; it is not sandboxed.
</critical>
