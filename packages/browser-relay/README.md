# @oh-my-pi/browser-relay

Chrome extension that lets omp's Eval `browser` API drive **your existing Chrome tabs** — logged-in sessions included — without relaunching Chrome with `--remote-debugging-port` (which Chrome 136+ refuses on the default profile anyway).

The companion relay server lives in the omp CLI (`omp browser-relay`, see `packages/coding-agent/src/tools/browser/relay/`). It impersonates Chrome's CDP discovery endpoint, synthesizes the browser target and `Target.*` hierarchy that `chrome.debugger` doesn't expose, and multiplexes any number of downstream puppeteer connections (omp opens one per tab worker) over the single debugger attachment Chrome allows per tab.

## Setup

1. `omp browser-relay install` — writes the bundled extension to `~/.omp/browser-relay/extension`, then load it via `chrome://extensions` → Developer mode → *Load unpacked*. (Or grab `omp-browser-relay-extension.zip` from GitHub releases.)
2. Opt in, one of two ways:
   - **Per call** — pass `app: { relay: true }` to `browser.open(...)` in Eval. Works without any setting and persists nothing: the configured default for every other call and session stays whatever it already was.
   - **As the default** — `omp config set browser.relay true` makes the relay the default for **every session using this profile, in every project** (project-level settings, `PI_BROWSER_RELAY`, and an explicit `app` choice still take precedence). Any session's ordinary `browser.open(...)` call will then drive your real browser — including background sessions you aren't watching; without `app.target` such a call adopts the currently visible tab, and if it carries a `url` it navigates that tab away from what you were reading.

That's it: the relay server auto-starts under omp's profile-independent global daemon broker the first time Eval's browser API needs it. Every relay consumer holds a broker lease, so one project exiting cannot interrupt another; the server stops after the last consumer across all projects exits. The extension badge turns **on** when connected. Run `omp browser-relay` manually only for `--token`, `--no-group`, or a non-default port — a relay already serving the port is adopted, never fought over.

`app.target` picks a specific tab by URL/title substring; without it, omp adopts the visible tab without stealing focus. Tabs omp is **actively driving** are gathered into a per-window **"omp" tab group** (cyan) — released when omp lets go of the tab and dissolved on disconnect; the rest of your tabs, pinned tabs, tabs in your own groups, and tabs you drag out are left alone. Disable with `omp browser-relay --no-group`.

## Development

- `bun run build` — bundles the extension into `dist/extension/`, zips it for GH releases, and regenerates the embedded CLI install assets under `packages/coding-agent/src/tools/browser/relay/extension-assets/` (**commit those**).
- `bun scripts/smoke.ts [relay-url] [target-substring]` — end-to-end smoke replicating omp's supervisor + tab-worker double-connection pattern against a live relay.

## Limitations

- `chrome://`, DevTools, Web Store, and other-extension pages are not attachable and are hidden from the agent.
- Chrome shows its "is debugging this browser" infobar while any tab is attached; dismissing it detaches that tab until it navigates again.
- A tab with DevTools open can't be attached (one debugger per tab — the constraint the relay multiplexes around for its own clients).
- Anything that can reach the relay port can drive your logged-in browser. The relay binds loopback only; use `omp browser-relay --token <secret>` (mirrored in the extension options) if untrusted local processes are a concern.
