# @oh-my-pi/browser-relay

Chrome extension that lets omp's Eval `browser` API drive **your existing Chrome tabs** — logged-in sessions included — without relaunching Chrome with `--remote-debugging-port` (which Chrome 136+ refuses on the default profile anyway).

The companion relay server lives in the omp CLI (`omp browser-relay`, see `packages/coding-agent/src/tools/browser/relay/`). It impersonates Chrome's CDP discovery endpoint, synthesizes the browser target and `Target.*` hierarchy that `chrome.debugger` doesn't expose, and multiplexes any number of downstream puppeteer connections (omp opens one per tab worker) over the single debugger attachment Chrome allows per tab.

## Setup

1. `omp browser-relay install` — writes the bundled extension to `~/.omp/browser-relay/extension`, then load it via `chrome://extensions` → Developer mode → _Load unpacked_. (Or grab `omp-browser-relay-extension.zip` from GitHub releases.)
2. Opt in, one of two ways:
   - **Per call** — pass `app: { relay: true }` to `browser.open(...)` in Eval. Works without any setting and persists nothing: the configured default for every other call and session stays whatever it already was.
   - **As the default** — `omp config set browser.relay true` makes the relay the default for **every session using this profile, in every project** (project-level settings, `PI_BROWSER_RELAY`, and an explicit `app` choice still take precedence). Any session's ordinary `browser.open(...)` call will then drive your real browser — including background sessions you aren't watching; without `app.target` such a call adopts the currently visible tab, and if it carries a `url` it navigates that tab away from what you were reading.

That's it: the relay server auto-starts under omp's profile-independent global daemon broker the first time Eval's browser API needs it. Every relay consumer holds a broker lease, so one project exiting cannot interrupt another; the server stops after the last consumer across all projects exits. The extension badge turns **on** when connected. Run `omp browser-relay` manually only for `--token`, `--no-group`, or a non-default port — a relay already serving the port is adopted, never fought over.

`app.target` picks a specific tab by URL/title substring; without it, omp opens a dedicated background tab — never stealing focus from what you are reading. Tabs omp has **driven** are gathered into a per-window **"omp" tab group** (cyan). Membership is sticky and all-or-nothing: the group holds exactly the tabs omp created/drove and only disappears as its tabs are closed or dragged out by hand — releasing a tab or disconnecting the relay never ungroups it. Pinned tabs, tabs in your own groups, and tabs you drag out are left alone; concurrent sessions converge on the one omp group per window. Disable grouping with `omp browser-relay --no-group`.

## Development

- `bun run build` — bundles the extension into `dist/extension/`, zips it for GH releases, and regenerates the embedded CLI install assets under `packages/coding-agent/src/tools/browser/relay/extension-assets/` (**commit those**).
- `bun scripts/smoke.ts [relay-url] [target-substring]` — end-to-end smoke replicating omp's supervisor + tab-worker double-connection pattern against a live relay.

## Limitations

- `chrome://`, DevTools, Web Store, and other-extension pages are not attachable and are hidden from the agent.
- Chrome shows its "is debugging this browser" infobar while any tab is attached; dismissing it detaches that tab until it navigates again.
- A tab with DevTools open can't be attached (one debugger per tab — the constraint the relay multiplexes around for its own clients).
- Chrome sometimes refuses `chrome.debugger.attach` for a tab it previously detached — it reports "Cannot access a chrome-extension:// URL of different extension" even for ordinary pages. Another debugger (DevTools, or a devtools-style extension such as React/Redux DevTools, Selenium, uBlock, password managers) competing for that tab is the usual cause, and a dedicated Chrome profile with only this extension is the reliable fix. OMP retries the attach and reports Chrome's wording on the failing command, and a refused tab is never banned or torn down — it recovers as soon as Chrome accepts attaches again.
