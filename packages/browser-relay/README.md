# @oh-my-pi/browser-relay

Chrome extension that lets omp's Eval `browser` API drive **your existing Chrome tabs** — logged-in sessions included — without relaunching Chrome with `--remote-debugging-port` (which Chrome 136+ refuses on the default profile anyway).

The companion relay server lives in the omp CLI (`omp browser-relay`, see `packages/coding-agent/src/tools/browser/relay/`). It impersonates Chrome's CDP discovery endpoint, synthesizes the browser target and `Target.*` hierarchy that `chrome.debugger` doesn't expose, and multiplexes any number of downstream puppeteer connections (omp opens one per tab worker) over the single debugger attachment Chrome allows per tab.

## Setup

1. `omp browser-relay install` — writes the bundled extension to `~/.omp/browser-relay/extension`, then load it via `chrome://extensions` → Developer mode → *Load unpacked*. (Or grab `omp-browser-relay-extension.zip` from GitHub releases.)
2. Start `omp browser-relay` and verify that the extension badge turns **on**. Use `--token`, `--no-group`, or a non-default port as needed.
3. Pass `app: { relay: true }` to `browser.open(...)` in Eval, then select one exact browser-instance/tab in the host-user picker. A task session identity and an interactive UI are required; no-UI/background calls cannot authorize new attachments.

Standing `browser.relay`, `browser.cdpUrl`, and `PI_BROWSER_RELAY=1` never authorize automatic adoption of user tabs. `PI_BROWSER_RELAY=0` disables explicit relay requests. `app.target` only filters the picker's URL/title choices; it cannot replace user selection. Instance-scoped target IDs bind the chosen browser/tab, while titles and URLs do not establish the signed-in profile/email. Cancellation, interruption, and changed/disappeared targets fail without selecting another tab. Previously approved named attachments are reusable only by their approving task.

The selected-tab websocket connection confines debugger bootstrap and commands to that tab. Older relay servers without selected-target isolation are rejected, even through `app.cdp_url`; restart the relay under the fixed runtime. The Chrome extension wire protocol is unchanged.

Tabs omp is **actively driving** are gathered into a per-window **"omp" tab group** (cyan) — released when omp lets go of the tab and dissolved on disconnect; the rest of your tabs, pinned tabs, tabs in your own groups, and tabs you drag out are left alone. Disable with `omp browser-relay --no-group`.

## Development

- `bun run build` — bundles the extension into `dist/extension/`, zips it for GH releases, and regenerates the embedded CLI install assets under `packages/coding-agent/src/tools/browser/relay/extension-assets/` (**commit those**).
- `bun scripts/smoke.ts [relay-url] [target-substring]` — end-to-end smoke replicating omp's supervisor + tab-worker double-connection pattern against a live relay.

## Limitations

- `chrome://`, DevTools, Web Store, and other-extension pages are not attachable and are hidden from the agent.
- Chrome shows its "is debugging this browser" infobar while any tab is attached; dismissing it detaches that tab until it navigates again.
- A tab with DevTools open can't be attached (one debugger per tab — the constraint the relay multiplexes around for its own clients).
- Anything that can reach the relay port can drive your logged-in browser. The relay binds loopback only; use `omp browser-relay --token <secret>` (mirrored in the extension options) if untrusted local processes are a concern.
