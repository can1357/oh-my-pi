# 0067. Browser inspection: React helpers in the `run` runtime, an axe-core audit pending a licence ruling; ABKit is not adopted in this pass

Status: Proposed 2026-11-14; machine-reviewed (EGM, 3 rounds), not owner-approved
Date: 2026-11-14
Area: tools

Research: [docs/research/browser-inspection.md](../research/browser-inspection.md), gap 13 of the upstream gap closure (`docs/research/upstream-gap-closure.md`; brief `docs/research/upstream-gap-closure-brief.md`). Upstream pin `c308970263` (v18.20.0); omp2 base `origin/omp2` as merged into this branch. Citations: `upstream:` is the OMPv1 pin; bare paths are omp2. The licence evidence for axe-core and ABKit is in the research note, sections 1 and 5. Nothing was built or run.

Review state. This design went through three rounds of the Elephant-Goldfish Model (EGM) review: fresh-context reviewer agents that see only this record and the files it cites, then a synthesis, with every finding checked against source. No blocker is open. It is machine-reviewed, not owner-approved. Implementation lands only behind the default-off convar `sv_browser_inspect` (D2).

Terms used here. **Stencil** (Stencil Labs, Inc.) publishes OMPv1, its build service and ABKit. A **tab** is one named browser view the daemon keeps (`TabSession`, `crates/envd/src/browser_daemon.rs:227-230`). An **owned** tab is one the daemon created (`headless`, `window`, `spawned`); an **attached** tab is a user page reached through `app.cdp_url` (`cdp`) or the **relay**, omp's Chrome-extension bridge to the user's logged-in browser (`relay`) (`crates/envd/src/browser_daemon.rs:859-897`, `crates/envd/src/browser_relay.rs:1-8`, `crates/tools/src/browser.rs:299-302`). The **run runtime** is the throwaway offscreen ("frames") webview in which `run` code executes. A **document-start script** runs in every new document before the page's own scripts. A **`Fault`** is the browser tool's serialized failure (`crates/tools/src/browser.rs:215-235`). The **environment session** is the `omp-envd` session that builds the tool roster (`crates/envd/src/server/session.rs`). `legacy.path` is the convar meta key that maps an OMPv1 setting. **UNVERIFIED** marks a claim no source or run confirmed. A **journal lift** maps calls recorded under an older tool revision to the current one (ADR 0026). **P4** and **P10** are the e2e proofs for live tool schemas and for lifts (`crates/e2e/README.md`). **ABKit** is Stencil's WebKit engine, a fork of WebKit's WPE port; **ABHost** is its stdio host process.

## Context

### What OMPv1 does

- **React inspection.** Tab helpers `reactEnable`, `reactTree`, `reactInspect`, `reactRenders`, `reactSuspense`, methods of the tab object in the agent's script runtime (`upstream:packages/coding-agent/src/tools/browser/prelude.js:231`, `upstream:packages/coding-agent/src/tools/browser/tab-call.ts:108`). `reactEnable` "installs the hook and reloads" (`upstream:docs/tools/browser.md:95`); the hook stays "for the tab's life" (`:159`). The hook is upstream's own minimal stand-in for the React DevTools global hook (`upstream:packages/coding-agent/src/tools/browser/react/devtools-hook.ts:21-24`); its members are `supportsFiber`, `renderers`, `inject`, `getFiberRoots`, `onCommitFiberRoot`, `onCommitFiberUnmount` (`:122-150`). It skips only if a hook carrying its own `__ompReact` marker exists, otherwise it defines `__REACT_DEVTOOLS_GLOBAL_HOOK__` over whatever is there (`:22-23`, `:163-170`). Fiber ids unify a fiber and its `alternate` (`:85-93`); on every commit it walks the whole fiber tree and stores every fiber in a strong `fibersById` map, recording or not (`:99-117`, `:140-143`), and it writes `__ompBrowserVitals.hydration` for the separate `vitals` helper (`:144-145`). `enableReact` registers the hook for future documents, evaluates it live, reloads and waits for `load`, then fails with "Unable to install the React DevTools hook in this document" only if the hook object is absent (`:176-187`, `:213-219`). Reads go to the main frame (`:191`, `:199`). A helper without the hook fails with "React DevTools hook not installed — call tab.reactEnable() first" (`:12`). `reactTree({maxDepth, includeHost})` clamps depth to 0..100, default 20, keeps 20 props and 160-character strings and recurses children-first (`upstream:packages/coding-agent/src/tools/browser/react/tree.ts:7-10`, `:53-98`); `reactInspect(id)` returns `{name, props, state, source, domSelector}` or a not-found envelope (`tree.ts:38-44`, `:113`); `reactRenders({action})` takes `start | stop | status` (`upstream:packages/coding-agent/src/tools/browser/react/renders.ts:6-19`); `reactSuspense({onlyDynamic})` lists boundaries (`upstream:packages/coding-agent/src/tools/browser/react/suspense.ts:6-17`).
- **Accessibility audit.** `a11y` evaluates axe-core 4.13.0 inside a function scope that saves and restores `window.axe` (`upstream:packages/coding-agent/src/tools/browser/a11y/audit.ts:2`, `:119-141`), with options `tags`, `rules`, `selector`, `includeIncomplete` (`:5-14`), and returns `BrowserA11yResult` (`:16-56`), at most ten nodes of 300 characters per rule (`:116-117`). It runs axe per frame through Puppeteer frame handles and merges partial results (`:264-287`), and pushes a text summary into the tool output (`upstream:packages/coding-agent/src/tools/browser/tab-worker.ts:3120-3124`).
- **ABKit.** The default browser when installed, started as `ABHost` and driven over length-prefixed JSON on stdio (`upstream:docs/tools/browser.md:154`, `upstream:packages/coding-agent/src/tools/browser/tern/wire.ts:1-19`), downloaded from `https://build.stencil.so` into `~/.o2/lib/abkit` (`upstream:packages/coding-agent/src/tools/browser/webkit/install.ts:1-12`, `upstream:packages/coding-agent/src/cli/build-service.ts:48`).

### What omp2 has

- **`browser@3` is `open`, `run`, `close`**, with automation as a JavaScript `code` body for `run` (`crates/tools/src/browser.rs:26-36`, `:111-112`). Its description lists the `tab` vocabulary (`:293-304`); its revision is pinned by a test (`:571`). A fault reaches the model as its `message` only (`:440`).
- **The run runtime.** Each `run` builds a frames webview, evaluates `RUN_RUNTIME` and starts the code there (`crates/envd/src/browser_daemon.rs:899-947`). `RUN_RUNTIME` keeps its queue and `rpc` closure-local and exports only `__ompTake`, `__ompReply`, `__ompStart` (`:1850-1854`, `:1881-1883`), so run code reaches the daemon only through the `tab` methods the runtime defines. The `tab` literal ends with `download:url=>rpc('download',[url])` (`:1872`). Each `tab.*` call is queued as `{id, op, args}` and served by `dispatch_helper(&WebView, ...)` (`:957-975`, `:1104-1458`). An unknown op is `unsupported browser helper` (`:1450-1455`); a helper fault fails the whole run (`?` at `:970`). Replies travel back by evaluating `__ompReply(id, <json>)` with a 1-second timeout; its error arm sends `{ok: false, error}`, which rejects the call's promise in run code, but today's callers only send `Ok` (`:970-972`, `:1000-1003`, `:1460-1472`). A page script that throws inside `tab.evaluate` comes back as a non-JSON reply and fails the run (`crates/webview/src/automation.rs:545-554`). `tab.url()` returns the URL cached at the last `goto` or wait (`browser_daemon.rs:1863`). `mutates_page` is `goto | click | press | drag`; it counts page activity so a pending `waitForNavigation` notices it (`:975-977`, `:1612-1614`). A test asserts `RUN_RUNTIME` contains its helper names (`:2003-2019`).
- **Tab lifetime.** `run_tab` looks the session up by shared reference (`:808`). A `TabSession` is dropped on `close` (`:437-491`), `close` with `all` (`:448-460`), `open` over an existing name (`tabs.insert`, `:424`), owner release (`:313-315`), restart for a mode change (`:316-321`), daemon exit (`:325`) and a cancelled run (`:850-855`), all on the daemon's actor thread; a released `spawned` tab is kept alive instead (`:456-458`, `:471-473`).
- **Document-start scripts exist only at construction.** `WebViewBuilder::init_script` (`crates/webview/src/lib.rs:303-310`) is applied when a view is wired: Chromium `Page.addScriptToEvaluateOnNewDocument`, with no frame filter (`crates/webview/src/remote/chromium.rs:643-661`; attached and relay views too, `:539`), Firefox `script.addPreloadScript` (`crates/webview/src/remote/firefox.rs:270-298`), system WebKit (`crates/webview/src/wk/mod.rs:166-187`). The daemon's `open` sets none (`crates/envd/src/browser_daemon.rs:372-381`); a built `WebView` has no method to add one (`crates/webview/src/lib.rs:618-807`). Remote drivers take `Command`s whose replies are callbacks or `flume` channels; `RemoteView::send` is a plain channel send (`crates/webview/src/remote/mod.rs:48-103`, `:148-151`); driver calls wait up to `CALL_TIMEOUT`, 30 s (`chromium.rs:60`, `:816`). `IPC_SHIM` is registered on every Chromium view and never removed (`chromium.rs:647`). An attached view picks its page target by URL or title substring (`chromium.rs:554-568`).
- **Evaluation is main-frame only** (`chromium.rs:980-985`, `firefox.rs:580-590`).
- **Engines.** `Engine::find` returns the system engine for a remote surface only when `OMP_WEBVIEW_BROWSER=system`; otherwise it prefers an installed Chromium (`crates/webview/src/lib.rs:208-236`).
- **The relay.** One `chrome.debugger` attachment per tab, shared by all downstream CDP clients (`crates/envd/src/browser_relay.rs:1-8`); `Page.*` commands are forwarded verbatim (`:1866-1896`). When a client disconnects, the relay detaches every tab no other client still holds; a held tab stays attached (`cdp_closed`, `:1470-1489`; `detach_unheld`, `:1997-2029`).
- **Settings.** Browser convars `sv_browser_enabled`, `sv_browser_headless` (`crates/envd/src/browser_daemon.rs:63-85`), `sv_browser_relay*` (`crates/envd/src/lib.rs:312-330`) feed `BrowserSettings` (`browser_daemon.rs:88-122`), read by `BrowserSettings::from_con` at three environment-session sites (`crates/envd/src/server/session.rs:328`, `:633`, `:876`) and passed to the daemon at tool install (`crates/envd/src/tools/roster_host.rs:779-782`); a restart changes only `headless` (`browser_daemon.rs:316-321`). A test compares a full `BrowserSettings` literal (`:175-181`).
- **Features and test commands.** `omp-envd` has `default = []` and an optional `cap-browser` (`crates/envd/Cargo.toml:13`, `:19`); `cap-browser` reaches builds through `omp-app`'s defaults (`crates/app/Cargo.toml:25-33`). `just test-pkg <pkg>` runs `cargo nextest run -p <pkg>` with no features (`justfile:294-296`), so `just test-pkg omp-envd` compiles neither `browser_daemon.rs` nor `browser_relay_contract` (`crates/envd/Cargo.toml:137-139`). Test-only helpers are shared through a `test-support` feature (`omp-vcs`, `crates/envd/Cargo.toml:132`).
- **Tests and CI.** `crates/webview` has no `tests/` directory; `BrowserDaemon` is `pub(crate)` (`browser_daemon.rs:234`); `browser_relay_contract.rs` drives the relay with raw CDP and a fake extension, including attaching a second client to a held tab (`crates/envd/tests/browser_relay_contract.rs:222-300`, `attach_existing_page` at `:277`). No CI step names a browser. Workspace tests run on macOS in `Rust workspace and acceptance proofs` (`.github/workflows/ci.yml:421`, `:441`) and on Linux through `Remote Linux verification (BuildBuddy)` (`:978`), which forwards only `OMP_REMOTE_JUST_ARGS` to its container (`scripts/remote-verify.sh:90-101`). `Acceptance proofs P9, P10 and tool sources (Linux)` runs on GitHub-hosted `ubuntu-24.04` and already installs packages (`.github/workflows/ci.yml:791`, `:794`, `:808-812`). That image lists Google Chrome 157 and Chromium 157 (`actions/runner-images`, `images/ubuntu/Ubuntu2404-Readme.md`, fetched 2026-11-14).
- **Licence policy.** `cargo deny` admits MPL-2.0 per named crate, and five MPL-2.0 crates already ship (`deny.toml:28-35`); `just license-check` runs only `cargo deny` (`justfile:476-477`). `THIRD-PARTY-NOTICES.txt` is tracked by hand: MPL-2.0 components with source archives (`:25-41`), package `NOTICE` files concatenated (`:66-72`; fixture precedent `fixtures/llm-oracle/vendor-schemas/NOTICE.txt`, `:1631`). It is embedded in the binary (`crates/app/src/cli.rs:27`).
- **axe-core 4.13.0** is MPL-2.0 and bundles MIT and ISC components; `axe.min.js` is 580,491 bytes (research note, section 5).
- **ABKit** has a public source repository under LGPL 2 and BSD per file, a public host protocol, and release archives with no notices; Stencil's Terms do not address third-party download clients (research note, section 1).

### Rules that bind

- Additive only: no change to an existing tool's name, schema or revision. ADR 0026: a revision bumps when "the argument contract or the model-facing projection changes" (`docs/adr/0026-intent-and-versioned-tools.md:30-32`).
- ADR 0024: no new roster tool. [ADR 0049](0049-tiered-integration-architecture.md): vendor integration lives outside core (`:14`, owner ruling `:17`). ADR 0036: extensions are Python. [ADR 0035](0035-rust-for-the-engine.md) and AGENTS.md: typed `thiserror` errors, no string payloads (`docs/adr/0035-rust-for-the-engine.md:55-56`). ADR 0009: tool output is bounded centrally.
- Page scripts run in the browser's own JavaScript engine, as `RUN_RUNTIME` does; no new omp runtime.

## Decision

**D1. The helpers are `tab.*` methods of the run runtime, in two kinds.**
- **Read helpers** `reactTree`, `reactInspect`, `reactRenders`, `reactSuspense` (and `a11y`, D7) are defined in the runtime as wrappers over the existing `evaluate` RPC. Each sends an embedded page script that never throws and returns an envelope `{ok: true, value}` or `{ok: false, reason}`. The wrapper returns `value`, or throws a JavaScript `Error` whose message starts with the reason code. Run code can catch it. They add no dispatch arm.
- **Control helpers** `reactEnable` and `reactDisable` are new `dispatch_helper` arms, because they need D3 and per-tab state. Their expected failures (a foreign hook, an engine without D3) are answered through `reply_runtime`'s existing error envelope (`crates/envd/src/browser_daemon.rs:1460-1472`), so the call's promise rejects in run code. Only infrastructure failures (timeouts, a closed engine) fail the run, as for every helper today.
- **Page scripts** are `.js` files in `crates/envd/src/browser_inspect/`, loaded with `include_str!`, ported from upstream with its MIT notice. The hook keeps upstream's members (`devtools-hook.ts:122-150`) and drops the `vitals` write (`:144-145`).
- **Reason codes** (stable prefixes of the thrown or rejected message): `react_hook_missing` (upstream's message, `devtools-hook.ts:12`), `react_hook_foreign` ("another React DevTools hook is installed in this page"), `react_reload_required` ("React hook was installed after this page loaded; reload the tab to inspect React"), `react_fiber_not_found`, `react_hook_failed` (upstream's message, `:218`), plus the existing `browser_unsupported` for D3.

Signatures and results (TypeScript notation):
- `reactEnable(): {installed: true, renderers: number, reloaded: boolean, needsReload: boolean, reactVersion?: string}`. `renderers` counts React renderers registered with the hook; `needsReload` is true when the hook was installed late (D4) and no renderer registered.
- `reactDisable(): {removed: boolean}`. `removed` is false when no registration existed.
- `reactTree({maxDepth?, includeHost?}): {roots: ReactTreeNode[], truncated: boolean, omitted: number}`, `ReactTreeNode` as upstream (`tree.ts:13-20`) except that `id` is an opaque string (D4).
- `reactInspect(id: string): ReactInspectResult` as upstream (`tree.ts:38-44`).
- `reactRenders({action: "start" | "stop" | "status"}): {active?: boolean, commits: number, components: {name, renders, totalMs}[]}` as upstream (`renders.ts:6-19`).
- `reactSuspense({onlyDynamic?}): ReactSuspenseBoundary[]` as upstream (`suspense.ts:6-17`), with the classification caveat in D4.
- Fiber `type` uses upstream's tag table, in which an unknown tag maps to `"other"` (`devtools-hook.ts:47-83`).

Data exposure: `reactInspect` and `reactTree` return props and hook state of the page, which on an attached tab may include tokens or form values; they reach the model and the journal as `tab.evaluate` results already do. No redaction pass is added; the default-off gate is the control.

**D2. Gate: default-off convar `sv_browser_inspect`, enforced in one place.** Declared with `omp_con::var!` beside `SV_BROWSER_HEADLESS`: `bool`, default `false`, flags `archive`, meta like its neighbours, no `legacy.path` (upstream has no such setting), no `PROJECT` flag. What it protects: a persistent document-start registration and a hook that observes React commits on the user's attached pages, which `tab.evaluate` alone does not create. `BrowserSettings` gains `inspect: bool`, filled by `from_con` at its three call sites; a change takes effect in the next environment session, not on a mode restart. The one enforcement point is runtime composition: with the gate off the daemon evaluates `RUN_RUNTIME` unchanged; with it on it evaluates `RUN_RUNTIME_INSPECT`, a `LazyLock<String>` built once by inserting `,` plus `INSPECT_TAB_METHODS` after the anchor `download:url=>rpc('download',[url])`, which must occur exactly once. Because run code cannot reach the RPC queue except through defined methods (`browser_daemon.rs:1850-1854`, `:1881-1883`), the control arms are unreachable with the gate off. With the gate off, `typeof tab.reactTree` is `"undefined"`, as today.

**D3. `omp-webview` gains post-construction document-start scripts, on Chromium only.**
- API: `WebView::add_init_script(&self, source: &str) -> Result<InitScriptId>` and `WebView::remove_init_script(&self, id: &InitScriptId<str>) -> Result<()>`. `InitScriptId` is declared with `omp_core::string_id!` over the CDP identifier.
- Plumbing: `Command::AddInitScript { source, reply: flume::Sender<Result<Str>> }` and `Command::RemoveInitScript { id, reply: flume::Sender<Result<()>> }`, served in the Chromium driver with `Page.addScriptToEvaluateOnNewDocument` and `Page.removeScriptToEvaluateOnNewDocument`. The caller waits on the reply with a bound it passes: the run's remaining deadline for add, one second for remove.
- Scope: the registration is made on the view's CDP session and runs in every new document of that page target, whoever navigates it, until it is removed or that session detaches. On a `cdp` tab the session is the daemon's own. On a `relay` tab the relay forwards over one debugger attachment shared by every relay client, so the registration is tab-wide and lasts until removed or until no client holds the tab (`browser_relay.rs:1-8`, `:1470-1489`, `:1997-2029`).
- That a detached session's registrations are dropped is UNVERIFIED and tested in S1. If the test shows they persist, `reactEnable` is refused on attached tabs (owned tabs only) and this record is amended.
- Firefox and the system engine return the existing `Error::Unsupported { operation }`. The builder API is unchanged; no new error variants.

**D4. `reactEnable` and the hook's lifetime.**
- **Install.** `reactEnable` registers the hook once per tab through D3 and evaluates it in the live document. The hook source is a function expression invoked with a literal: the registration source ends `(false)` and the live evaluation `(true)`; the argument is stored as `late`. If an omp hook already exists the call does nothing, so a hook created at document start keeps `late: false`. The hook returns at once in any frame where `window !== window.top`, since reads are main-frame only.
- **Reload.** On an owned tab, `reactEnable` then calls `automation().reload(remaining)`, which waits for readiness itself (`crates/webview/src/automation.rs:297-300`); `remaining` is the time left before the run's deadline. `reactEnable` joins `mutates_page`, so a pending `waitForNavigation` sees the reload. On an attached tab it never reloads (`reloaded: false`). The agent reloads when it chooses, with `await tab.goto(await tab.evaluate(() => location.href))`: `tab.url()` is a cached value and can be stale (`browser_daemon.rs:1863`).
- **Outcomes.** If after install (and reload) no omp hook object exists, `reactEnable` rejects with `react_hook_failed`, as upstream (`devtools-hook.ts:176-187`). Zero renderers is success with `renderers: 0` (no React, or React not yet mounted). Every read helper on a hook with zero renderers rejects with `react_reload_required` when `late` is true, and returns an empty result when it is false; a page that mounts React later is read correctly on the next call, because the hook was there from document start.
- **Foreign hooks.** If `__REACT_DEVTOOLS_GLOBAL_HOOK__` exists without the omp marker (a user's React DevTools, typically on the relay), the omp hook does not replace it, read helpers reject with `react_hook_foreign` (not `react_hook_missing`), and `reactEnable` rejects with `react_hook_foreign` and removes its registration. At document start the order between omp's script and an extension's hook is not specified: when the foreign hook runs first the rule above applies; when omp's runs first it defines the property `configurable: true`, and whether React DevTools then replaces it or stops is UNVERIFIED. Forwarding to a foreign hook (chaining) is rejected: it would need DevTools' whole hook protocol.
- **Ids.** Fiber ids are opaque strings `<epoch>:<n>`, the epoch random per hook instance; a fiber and its `alternate` share one id in a `WeakMap`, as upstream (`devtools-hook.ts:85-93`). Ids are assigned when a read helper visits a fiber. `reactInspect(id)` resolves an id by walking the committed trees from each root's `current` within D6's bounds, so it reads current props and state; an id absent from the committed trees, or from another epoch (an earlier document), rejects with `react_fiber_not_found`. The hook keeps no id-to-fiber map; `roots` stays a strong set, as React holds the roots anyway. The memory saving against upstream is unmeasured.
- **Recording.** The whole-tree walk on commit runs only while `reactRenders` is recording. Consequence: Suspense `classification: "dynamic"` covers boundaries pending at read time or seen pending during a recorded commit, narrower than upstream's every-commit tracking (`devtools-hook.ts:108`).
- **Teardown.** `TabSession` gains `attached: bool`, set in `open` from the `resolve_backend` branch that chose CDP or relay rather than from the backend string, and `react_hook: Option<InitScriptId>`. Its `impl Drop` on an attached tab calls `remove_init_script` with the one-second bound; `Error::Closed` (the view is already gone, as after a cancelled run) is logged at debug level, and any other error with `tracing::warn!`. This covers every drop site listed in Context. Owned tabs need no removal: their pages die with the view. A released `spawned` tab keeps its registration in the omp-owned browser process until that process exits; no user page is involved. A daemon crash runs no `Drop`: for `cdp` tabs the registration ends with the CDP session (subject to the S1 check); for relay tabs it ends when no relay client holds the tab, and lasts while another one does. `IPC_SHIM`'s registration (`chromium.rs:647`) is existing behaviour and out of scope.
- **Disable.** `reactDisable` removes the registration and clears the stored id; a later `reactEnable` registers anew.
- **Plumbing.** `run_tab` takes the session with `tabs.get_mut`; `run_code` and `dispatch_helper` take `&mut TabSession` instead of `&WebView`.

**D5. Main frame only.** React helpers read the main frame's hook; React roots in iframes are not reported. `a11y` (D7) audits the main document with axe's `iframes: false` and reports `frames: {skipped}`, the number of `iframe` and `frame` elements in the light DOM of the audited context (the `selector` subtree or the document). It is a lower bound: frames inside shadow roots are not counted.

**D6. Bounds are page-side and the traversal is bounded too.** Every page script bounds its own work and output before returning, so nothing large crosses `returnByValue` or the 1-second reply. Traversals are iterative and pre-order with an explicit stack (no recursion, unlike upstream's children-first recursion, `tree.ts:72-98`). They stop visiting at the node cap, and track the byte budget as a running sum of each emitted node's serialized length. When a walk stops early, `truncated` is `true` and `omitted` is a lower bound on the nodes not emitted. Upstream's per-value limits stay (depth 0..100, default 20; 20 props; 160-character strings in trees; 500 characters and 20 items in `reactInspect`; 10 nodes and 300 characters per `a11y` rule). Initial caps, which the implementing PR may tune with a measurement: 2,000 nodes and 256 KiB for `reactTree`, 64 KiB for `reactInspect`, 500 entries for `reactRenders` and `reactSuspense`, 256 KiB for `a11y`. The tool result is then bounded centrally as for every tool (ADR 0009).

**D7. The audit is axe-core only, and waits on O3 and O6.**
- If the owner accepts axe-core (O3), embed `crates/envd/assets/axe-core/axe.min.js` from the 4.13.0 npm tarball, unmodified with its header, with `include_str!` under `cap-browser`, and expose it only through `sv_browser_inspect`. There is no separate feature: 580 KB is small next to the embedded Python runtime the binary already carries, and a second switch would add a build matrix for no protection the convar lacks.
- `tab.a11y({tags?, rules?, selector?, includeIncomplete?})` is a read helper (D1). It evaluates axe inside a function scope that saves and restores `window.axe`, ported from `audit.ts:119-141`, then `axe.run(context, {resultTypes: ["violations", "incomplete", "passes"], iframes: false, runOnly})` with upstream's option mapping and selector errors (`audit.ts:175-190`; upstream's standalone path omits `iframes: false`, which D5 adds). It returns `BrowserA11yResult` as upstream (`audit.ts:44-56`) plus `frames: {skipped}`. It returns the object only; the text summary upstream pushes into its output (`tab-worker.ts:3123`) is not produced.
- Why this is not a vendor integration under ADR 0049: axe-core is a library run locally in the page, with no vendor service, account or network call. ADR 0049 moves vendor service integrations out of core (`docs/adr/0049-tiered-integration-architecture.md:14-17`). MPL-2.0 code already ships under the per-crate exceptions (`deny.toml:30-35`), so O3 extends that practice to a file that is not a crate.
- Licence handling, in the same PR:
  - a package `crates/envd/assets/axe-core/NOTICE` with the copyright line, the MPL-2.0 notice, the tarball URL and SHA-256, the source tag `v4.13.0` of `github.com/dequelabs/axe-core`, the unminified `axe.js` in the same tarball named as the Source Code Form (MPL section 3.2), and the verbatim `LICENSE-3RD-PARTY.txt`;
  - an `axe-core 4.13.0` line in the MPL-2.0 list of `THIRD-PARTY-NOTICES.txt` (`:25-41`);
  - the `NOTICE` concatenated into its package-notice section (`:66-72`), edited by hand as the file is today;
  - no `deny.toml` change.

**D8. ABKit is not adopted in this pass.** Its licence (LGPL 2 and BSD per file; the host BSD 2-clause) and its host protocol are public, so they are not the obstacle. What is:
1. The one release archive inspected (0.1.1, Windows x64) carries none of the notices its BSD and LGPL components require for binary redistribution, and the other seven were not inspected. omp2 must not bundle or mirror the archives.
2. Acquisition through `build.stencil.so` is a vendor service, which under ADR 0049 belongs in an extension, and Stencil's Terms do not say whether a third-party client may fetch builds for its users.
3. `Engine` is a closed enum dispatched without `dyn` (`crates/webview/src/lib.rs:129`, `crates/webview/README.md:44`), so no extension can supply an engine.

No engine variant, download, bundling or protocol client is added. Revisit with O1, O2 and O5.

**D9. Discovery and ordering.** The `browser@3` description (`crates/tools/src/browser.rs:293-304`) is not changed here, so with the gate on a model learns the helpers only from the user, a cfg or a skill until O6 is answered. To avoid paying for more than the core before that, only S1 and S2 are scheduled now; S3 (render recording and Suspense) and S4 (axe) start after O6, and S4 also needs O3.

## Rejected options

| Option | Why not |
|---|---|
| New tool actions (`action: "react_tree"`) | Changes `browser@3`'s argument contract (`crates/tools/src/browser.rs:26-36`). |
| Rust dispatch arms for the read helpers | They only evaluate a page script and return bounded JSON, which the `evaluate` RPC already does; a Rust fault would also make expected conditions uncatchable. |
| Install the hook with `tab.evaluate` only | Gone after every reload; React registers with the hook at module load, so a live install sees no renderer. |
| Register the hook in every tab at `open` | Injects into attached pages nobody asked to inspect. |
| Reload attached tabs, or a `{reload: true}` option | Reloads the user's page; the agent can reload with `tab.goto` when it decides to. |
| Define the methods with the gate off and refuse them in dispatch | Changes gate-off behaviour (`typeof tab.reactTree`); a second enforcement point adds nothing because run code cannot reach the queue. |
| A SHA-256 pin of the gate-off runtime | Breaks on unrelated `RUN_RUNTIME` edits; the gate-off path evaluates the unchanged constant. |
| An id-to-`WeakRef` map for `reactInspect` | Can hold the stale `alternate` after a re-render; resolution walks the committed tree instead. |
| Chain to a foreign DevTools hook | Needs DevTools' whole hook protocol. |
| Init scripts on Firefox and the system engine | No caller needs them (`lib.rs:208-236`); the system engine needs main-thread work and cannot remove one script. |
| omp's own seven-rule audit | A second audit engine with its own accessible-name and selector algorithms; see D7. |
| A separate `cap-browser-axe` feature | Small weight next to the embedded Python runtime; the convar already gates use. |
| Audit every frame | No per-frame evaluate in `omp-webview` (`chromium.rs:980-985`). |
| CDP's React DevTools backend | Needs the DevTools frontend bundle; Chromium only. |
| `Engine::AbKit` and a downloader in core; bundling or mirroring ABKit | ADR 0049; archives without notices. |

## Slices

Each slice is one PR; tests are written first and not edited to pass.

**Browser test support and CI (delivered in S1, used by S2 to S4).**
- `omp-webview` gains a `test-support` feature exposing `omp_webview::test_support`. It provides a Chromium process owner that each test creates for itself (`--headless=new --remote-debugging-port=0 --user-data-dir=<tempdir>`, the endpoint read from the profile's `DevToolsActivePort`, the process killed on drop), so tests share no port under nextest parallelism. It also provides `require_or_skip()`: without an engine a test prints why and returns, unless the new variable `OMP_BROWSER_TESTS=require` is set, which makes a missing engine a failure. `omp-envd` uses it as a dev-dependency with `features = ["test-support"]`, like `omp-vcs` (`crates/envd/Cargo.toml:132`).
- Fixtures are local files loaded by `file://` URL.
- A new recipe `just test-browser` runs `cargo nextest run -p omp-webview --features test-support --locked`, `cargo nextest run -p omp-envd --features cap-browser --locked` and the matching `cargo test --doc` calls. It is needed because `just test-pkg omp-envd` builds without `cap-browser` (`justfile:294-296`, `crates/envd/Cargo.toml:13`).
- CI: a step in `Acceptance proofs P9, P10 and tool sources (Linux)` (`.github/workflows/ci.yml:791`, GitHub-hosted `ubuntu-24.04`) runs `just test-browser` with `OMP_BROWSER_TESTS=require` and `OMP_WEBVIEW_BROWSER` set to the image's Google Chrome. The image lists Chrome 157; the binary path is UNVERIFIED and is S1's first check. The browser version is not pinned: it moves with the image, and the tests print it. The macOS job and the BuildBuddy job do not run browser tests (the latter forwards only `OMP_REMOTE_JUST_ARGS`, `scripts/remote-verify.sh:101`).

**S1. Chromium post-construction init scripts and test support (D3).**
- Scope: `WebView::add_init_script`, `remove_init_script`, `InitScriptId`; the two `Command` variants and the Chromium driver arms (`chromium.rs:950-960` area); `Error::Unsupported` on Firefox and the system engine; the test support, recipe and CI step above.
- Gate: none. The API has no caller until S2; S1 proves it with its own tests and S2 wires it.
- Tests in `crates/webview/tests/init_scripts.rs`. The attached case opens a page target with a unique URL through the endpoint's `/json/new` and attaches `Engine::chromium_cdp(endpoint, Some(<that URL>))` (target selection, `chromium.rs:554-568`).
  - `added_init_script_runs_on_reload_and_navigation`
  - `removed_init_script_does_not_run_on_next_document`
  - `init_script_runs_in_documents_navigated_by_another_client`
  - `init_script_does_not_survive_session_detach` (decides D3's fallback)
  - unit `firefox_add_init_script_is_unsupported`
- Acceptance: existing `omp-webview` tests pass unchanged; the CI step shows the browser tests ran, not skipped.

**S2. Gate, runtime composition and `reactEnable`, `reactDisable`, `reactTree`, `reactInspect` (D1, D2, D4, D5, D6).**
- Scope: `sv_browser_inspect`; `BrowserSettings.inspect` (the literal test at `browser_daemon.rs:175-181` gains the field); `RUN_RUNTIME_INSPECT`; the hook and read scripts; the two control arms; `TabSession.attached`, `react_hook` and `Drop`; the `get_mut` and `&mut TabSession` plumbing; `reactEnable` in `mutates_page`.
- Gate: `sv_browser_inspect`, default off.
- Fixtures in `fixtures/browser/react/`:
  - `basic.html` on pinned React 18.3.1 and ReactDOM 18.3.1 UMD development builds (MIT), with a known component tree, props, state and a button that re-renders one child;
  - `large.html`, the same bundles rendering 3,000 components;
  - a `NOTICE` concatenated into `THIRD-PARTY-NOTICES.txt` like `fixtures/llm-oracle/vendor-schemas/NOTICE.txt`.
- Tests, in the crate because `BrowserDaemon` is `pub(crate)`:
  - unit `inspect_anchor_occurs_once_in_run_runtime`, `unknown_fiber_tag_maps_to_other`;
  - browser-backed through `BrowserDaemon::start`: `react_helpers_are_undefined_with_gate_off`, `tree_and_inspect_read_the_fixture`, `inspect_after_rerender_returns_current_state`, `hook_survives_navigation_within_the_tab`, `page_without_react_returns_an_empty_tree`, `read_errors_are_catchable_in_run_code`, `large_tree_is_truncated_page_side`, `attached_tab_is_not_reloaded_and_reports_needs_reload`, `foreign_hook_registered_first_is_reported_not_replaced` (the foreign hook is registered with the S1 API before `reactEnable`, so it runs first), `hook_is_gone_after_an_attached_tab_is_dropped` (the user-visible outcome on `close`, `close` with `all`, replacing `open` and owner release, whichever mechanism removed it).
  - Relay, in `crates/envd/tests/browser_relay_contract.rs` with its fake extension: `relay_keeps_a_held_tab_attached_when_one_client_disconnects` (with `attach_existing_page`) and `relay_detaches_an_unheld_tab_when_its_client_disconnects`. They prove the lifetime facts D3 and D4 rely on, not script removal itself.
- Acceptance: `just test-browser` passes in CI with `require`. Gate off, `just test-pkg omp-envd` and `just test-pkg omp-tools` pass with the `RUN_RUNTIME` helper test (`:2003-2019`) and `browser@3`'s schema and revision tests (`crates/tools/src/browser.rs:506-623`) unchanged; the only edited existing test is the `BrowserSettings` literal. React 19 is UNVERIFIED and is recorded so in `Status in omp`.
- Depends on: S1.

**S3. Render recording and Suspense (D1, D4, D6).** After O6.
- Scope: `reactRenders`, `reactSuspense`, the recording-only commit walk.
- Gate: `sv_browser_inspect`.
- Fixture: `fixtures/browser/react/suspense.html`, a lazy component behind `Suspense`, resolved by a timer.
- Tests: `renders_count_commits_only_while_recording`, `suspense_lists_fixture_boundaries`, `lists_are_capped_page_side` (on `large.html`). In `just test-browser`.
- Depends on: S2, O6.

**S4 (optional). axe-core audit (D5, D7).** After O3 and O6.
- Scope: the vendored file and its `NOTICE`, the `THIRD-PARTY-NOTICES.txt` entries, the `a11y` read helper.
- Gate: `sv_browser_inspect`.
- Fixtures in `fixtures/browser/a11y/`: one page with an image without `alt`, an unlabeled input and an empty link; one clean page; one page with an iframe.
- Tests:
  - unit `vendored_axe_sha256_is_pinned`, `vendored_axe_header_notice_is_intact`, `notices_file_lists_axe_core_with_its_source_archive` (reads the shipped `THIRD-PARTY-NOTICES.txt`);
  - browser-backed `a11y_reports_axe_rule_ids_for_fixture_violations` (`image-alt`, `label`, `link-name`), `clean_page_reports_no_violations`, `selector_limits_the_audit`, `light_dom_iframes_are_counted_as_skipped`, `existing_window_axe_is_restored`.
  - All in `just test-browser`.
- Depends on: S2, O3, O6.

**S5. Advertise the helpers (D9).**
- Scope: the `browser` description and whatever revision O6 settles, with a journal lift if it moves.
- Tests: the tool's schema and revision tests; P4 (`crates/e2e/tests/p4_schema_isolation.rs`) and P10 (`crates/e2e/tests/p10_lift_idempotence.rs`) if the revision moves.
- Depends on: S2, O6.

S1 to S4 add no e2e proof: the joined path from tool to envd to daemon is unchanged and the behaviour is proven at its owning seams, `crates/webview` and `crates/envd` (AGENTS.md, Testing & QA). No golden journal: no journal kind or payload field changes.

## Upstream origin and license

S2 and S3 draw from `upstream:packages/coding-agent/src/tools/browser/react/` (`devtools-hook.ts`, `tree.ts`, `renders.ts`, `suspense.ts`), with the changes D4 and D6 name: no overwrite, the `late` flag, the top-frame guard, opaque epoch ids resolved by walking, recording-only walks, iterative bounded traversal, no `vitals` coupling. S4 draws from `upstream:packages/coding-agent/src/tools/browser/a11y/audit.ts` for the injection scope, options and report shape. Upstream is MIT (`upstream:LICENSE:1-5`; copyright Mario Zechner, Can Bölük, Stencil Labs, Inc.); the embedded scripts keep that notice. React 18.3.1 (test fixture only) is MIT. axe-core 4.13.0 is MPL-2.0 with bundled MIT and ISC parts; D7 states its handling. ABKit: nothing reused.

## Consequences

- With the gate on, an agent can enable, read and inspect React trees on Chromium tabs from the `run` code it already writes, and can catch the expected React conditions; render counts, Suspense and the audit follow after O6.
- `reactEnable` never reloads a user's page and does not replace a user's React DevTools hook found before it. Its registration is removed whenever the daemon drops an attached tab. After a daemon crash it lasts until the CDP session ends or, on the relay, until no relay client holds the tab.
- On a relay tab the registration is tab-wide: it runs in documents other relay clients drive while it lasts (O7).
- Firefox and system-engine tabs get `browser_unsupported` from `reactEnable`.
- Props and state from logged-in pages can reach the model and the journal when the agent asks for them; only the gate controls that.
- iframe React roots and iframe accessibility are out of reach; the audit says how many light-DOM frames it skipped.
- There is no accessibility audit unless the owner accepts axe-core (O3).
- Until O6, the helpers work only for an agent told their names.
- omp2 gains no WebKit-over-stdio engine.

## Open questions for the owner

- **O1. ABKit binary notices.** The inspected 0.1.1 archive ships BSD and LGPL components with no licence texts or notices. Recommendation: ask Stencil to ship notices in the archives; until then do not fetch them for users.
- **O2. ABKit acquisition.** May a third-party client download `build.stencil.so` releases for its users under the Terms (sections 1.2, 1.3, 5(g))? Recommendation: ask in writing; if yes, the downloader is an extension (ADR 0049).
- **O3. axe-core.** Is an unmodified vendored MPL-2.0 JavaScript file with bundled MIT and ISC parts, handled as D7 says, acceptable when `deny.toml` admits MPL-2.0 per crate only (`deny.toml:28-35`)? Recommendation: yes; otherwise omp2 ships no audit in this pass.
- **O4.** Resolved in round 2: S2 requires a pinned React 18.3.1 fixture.
- **O5. An engine seam.** ABKit, or any stdio browser host, needs a vendor-neutral `Engine` variant for a host at a user-supplied path, or an extension seam for engines. Recommendation: a separate record.
- **O6. Advertising the helpers.** Listing them in the description changes `browser@3`'s model-facing projection, which ADR 0026 says bumps the revision; the additive-only rule forbids changing an existing tool's revision. Options: (a) a `browser@4` with a lift from `@3`, chosen when the roster host builds the tool (`crates/envd/src/tools/roster_host.rs:779-782`) from the session's `sv_browser_inspect`, which is fixed for the session so the tool set stays stable; (b) leave the description unchanged and ship a skill that documents the helpers with the gate; (c) leave them unadvertised. Recommendation: (a), owner to rule. S3, S4 and S5 wait on it.
- **O7. Relay tabs.** Should `reactEnable` be allowed on relay tabs, where the registration is tab-wide across relay clients and outlives a daemon crash while another client holds the tab? Recommendation: allow it, since the gate is an explicit opt-in, and revisit if the relay gains per-client cleanup.

## What the review changed

D-numbers in each round refer to the record as it stood after that round.

### Round 1 (EGM; findings as recorded in `docs/adr/STATUS.md` row 0067)

- **The helpers are JavaScript run-runtime helpers, not Rust ops.** Confirmed: `crates/tools/src/browser.rs:26-36`; `crates/envd/src/browser_daemon.rs:1850-1896`, `:1104-1458`; upstream `prelude.js:231`. Changed: helpers became `tab.*` runtime methods behind a default-off convar; D9 and O6 added because advertising them moves `browser@3`'s projection (`docs/adr/0026-intent-and-versioned-tools.md:30-32`).
- **Reload on attached and relay tabs; injection must survive navigation and reload.** Confirmed: upstream reloads unconditionally (`devtools-hook.ts:213-219`); attached tabs are the user's pages (`crates/tools/src/browser.rs:299-302`); the relay shares one attachment per tab (`crates/envd/src/browser_relay.rs:7-8`). Changed: no reload on attached tabs, document-start registration, removal on close.
- **Init scripts are unreachable from the daemon.** Confirmed: `crates/webview/src/lib.rs:303-310`, `:618-807`; `crates/envd/src/browser_daemon.rs:372-381`. Changed: a post-construction `omp-webview` API and slice S1.
- **Main frame only.** Confirmed: `chromium.rs:980-985`, `firefox.rs:580-590`; upstream React reads are main-frame (`devtools-hook.ts:191`). Changed: the limit stated; frame tests replaced.
- **axe-core MPL-2.0 notice (O3).** Confirmed and widened: the tarball bundles MIT and ISC components. Changed: notice files, Source Code Form pointer, pinned hash.
- **ABKit "not adopted", checked against published terms.** Corrected: the public `stencil-hq/abkit` repository states LGPL 2 and BSD per file and publishes the protocol; the archive still has no notices. Changed: D8's reasons, O1, O2. Verdict kept.
- Also: a `cap-browser-inspect` feature was dropped; the convar alone gates behaviour.

### Round 2 (EGM, four fresh reviewers and a synthesis: 1 blocker, 19 majors, 11 minors)

- **B1. The own-rule audit was unspecified.** Confirmed: the round-1 record named seven rules in one line each, with no predicates, accessible-name algorithm, selector generation or result type, while upstream's type requires `helpUrl` and `failureSummary` and names the engine `axe-core` (`upstream:.../a11y/audit.ts:26-56`). Resolved by a scope cut: the own engine is dropped and the audit is axe-core only (D7), so the rules are axe's. S3's untestable tests are gone. No blocker remains.
- **M1. Teardown only on graceful close.** Confirmed: sessions drop at `browser_daemon.rs:313-325`, `:424`, `:448-460`, `:850-855`. Changed: `impl Drop for TabSession` removes the registration on every path, best-effort with a logged failure; the crash path rests on the relay's detach (`browser_relay.rs:1470-1489`, `:1997-2029`) and the CDP session ending, the latter tested in S1. Consequences no longer claim "no script behind" unconditionally.
- **M2. `IPC_SHIM` already persists on attached views.** Confirmed: `chromium.rs:647`, no removal in `crates/webview/src`. Changed: the claim is narrowed to the React hook. Rejected in part: shim cleanup is not added; it is existing behaviour outside this gap.
- **M3. `reactEnable` result and fault text.** Confirmed: upstream's result is `{installed, reactVersion?}` and its message uses an em dash (`devtools-hook.ts:7-12`, `:218`). Changed: D1 defines the result (`renderers`, `reloaded`), D4 uses upstream's messages verbatim and names the post-reload failure.
- **M4. "No React" and "not hooked" were indistinguishable.** Confirmed from the record's own D4. Changed: the hook's `late` flag and `browser_react_reload_required`.
- **M5. Collision with a user's DevTools hook.** Confirmed: upstream overwrites (`devtools-hook.ts:22-23`, `:163-170`). Changed: no overwrite, `browser_react_hook_conflict`, registration removed.
- **M6. Permanent cost on the page.** Confirmed: whole-tree walk and strong `fibersById` on every commit (`devtools-hook.ts:85-117`, `:140-143`). Changed: lazy ids with `WeakRef`, recording-only walks, `reactDisable`; the Suspense classification narrowing is stated.
- **M7. Unquantified bounds.** Confirmed: upstream bounds depth, props and strings only (`tree.ts:53-75`); replies go through a 1-second evaluation (`browser_daemon.rs:1460-1472`). Changed: D6 gives page-side caps and S2 tests the largest bounded reply.
- **M8. Incomplete signatures; `vitals` coupling.** Confirmed: `renders.ts:6-19`, `suspense.ts:6-17`, `tree.ts:7-10`, `:113`, `devtools-hook.ts:144-145`. Changed: D1 lists every signature and result; the coupling is stripped.
- **M9. Gate and session plumbing.** Confirmed: `dispatch_helper` takes `&WebView` (`browser_daemon.rs:1104-1112`), `run_tab` borrows immutably (`:808`), settings are read at session build (`crates/envd/src/server/session.rs:328`) and a restart changes only `headless` (`browser_daemon.rs:316-321`), the literal test at `:175-181`, the contains test at `:2003-2019`. Changed: D2 and D4 name the plumbing, the read point and the insertion anchor; `RUN_RUNTIME` stays a constant; S2 states the one edited existing test.
- **M10. `add_init_script` plumbing.** Confirmed: `crates/webview/src/remote/mod.rs:48-103`, `:148-151`; system engine needs the main thread (`wk/mod.rs:171-187`) and is never found by default (`lib.rs:208-236`). Changed: D3 names the `Command` variants, the id type and the scope rule, and drops Firefox and system (with M18).
- **M11. Reload semantics and activity.** Confirmed: `automation.rs:297-300`, `mutates_page` at `browser_daemon.rs:1612-1614`. Changed: D4 names the reload and ready wait; `reactEnable` joins `mutates_page`; the `{reload: true}` option is gone.
- **M12. No channel for the summary text.** Confirmed: helpers return one value (`browser_daemon.rs:1460-1472`); upstream pushes text (`tab-worker.ts:3123`). Changed: D7 returns the object only.
- **M13. Tests may never run; harnesses missing.** Confirmed: no browser in `.github/workflows/ci.yml`, no `OMP_BROWSER_TESTS`, `BrowserDaemon` is `pub(crate)` (`browser_daemon.rs:234`), no `crates/webview/tests`. Changed: the variable is declared as new, S1 owns the CI step and names the candidate jobs (which one is UNVERIFIED), daemon tests live in the crate, the relay test uses the existing fake-extension harness, fixtures are named.
- **M14. Real React unproven.** Confirmed: tag numbers are hard-coded (`devtools-hook.ts:36-79`). Changed: a pinned React 18.3.1 fixture is a precondition of S2; React 19 is UNVERIFIED; O4 resolved.
- **M15. Undiscoverable deliverable; option (a) layering.** Confirmed: `crates/tools/src/browser.rs:287-306` is a static spec. Changed: D9 says plainly how a model learns the helpers before S5; O6(a) now says where the spec would be chosen and why it is session-stable (`crates/envd/src/tools/roster_host.rs:779-782`). Rejected in part: Z9's claim that a skill makes the gate redundant; the gate controls page-side registration, not discovery.
- **M16. Gate rationale and mechanisms.** Confirmed: `tab.evaluate` already runs arbitrary page JavaScript ungated (`browser_daemon.rs:1375-1387`). Changed: the rationale now names what the gate protects; the SHA-256 pin is dropped; dispatch refuses the ops when off. Rejected in part: defining the methods unconditionally, because it changes gate-off behaviour.
- **M17. Own rules before axe was an inversion.** Accepted: D7 is axe-only (with B1).
- **M18. Three-engine init scripts were speculative.** Accepted: Chromium only (D3).
- **M19. Altitude.** Accepted in part: licence evidence moved to the research note, terms defined at the top. Rejected in part: "What the review changed" stays, because the gap-closure brief requires it in every reviewed ADR.
- **m1.** Accepted: render recording and Suspense moved to S3.
- **m2.** Accepted: `{reload: true}` removed (M11).
- **m3.** Superseded: same-origin iframe walking went with the own engine.
- **m4.** Accepted: D4 says where fault codes are built and how they reach the model (`crates/tools/src/browser.rs:440`); D3 adds no error variants.
- **m5.** Accepted: D7 names the `window.axe` save and restore and the `axe.run` options (`audit.ts:119-141`, `:175-190`).
- **m6.** Accepted: D7 names the tag and the hand edit; no generator exists (`justfile:476-477`). The section 3.2 reading stays under O3.
- **m7.** Accepted: D8 says "the one archive inspected".
- **m8.** Accepted: the review status left D2.
- **m9.** Accepted: ADR 0049 cited at `:14` and `:17` and linked; ADR 0035 cited at `:55-56`.
- **m10.** Accepted: terms defined under the research line.
- **m11.** Accepted for the convar meta (D2). Rejected for `docs/adr/STATUS.md`: the gap-closure orchestrator owns that file; the proposed row goes in its report.

### Round 3 (EGM, four fresh reviewers and a synthesis: 0 blockers, 16 majors, 15 minors; the last round)

- **M1. Relay registration scope.** Confirmed: one shared attachment, verbatim `Page.*` forwarding, held tabs stay attached (`crates/envd/src/browser_relay.rs:1-8`, `:1866-1896`, `:1470-1489`, `:1997-2029`). Changed: D3 states scope per path (CDP versus relay); Consequences and D4 teardown say the relay registration is tab-wide and lasts while another client holds the tab; S1's contradictory "scoped to its view session" test is replaced by `init_script_runs_in_documents_navigated_by_another_client`; the relay tests are renamed to the lifetime facts they prove and gain the held case (`browser_relay_contract.rs:277`). Whether to allow `reactEnable` on relay tabs at all became O7.
- **M2. Expected React conditions aborted the run.** Confirmed: `dispatch_helper(...)?` (`browser_daemon.rs:970-972`); `reply_runtime` has an error envelope no caller uses (`:1460-1472`). Changed: read helpers throw catchable errors in the runtime from envelopes; control helpers answer expected failures through `reply_runtime`'s error envelope; `needsReload` added to `reactEnable`'s result; test `read_errors_are_catchable_in_run_code`.
- **M3. `react_hook_failed` contradicted the no-React case.** Confirmed: upstream fails only when the hook object is absent (`devtools-hook.ts:176-187`, `:213-219`). Changed: D4 "Outcomes" defines failure as no hook object; zero renderers is success; a lazy-mounted React is read on the next call because the hook was there from document start.
- **M4. No rule from id to current fiber.** Confirmed: upstream unifies `alternate` and repoints `fibersById` on each walk (`devtools-hook.ts:85-117`). Changed: ids are epoch-scoped strings, `reactInspect` resolves by walking the committed trees from `root.current`, unmounted means absent from those trees, `roots` stated as strong, the saving stated as unmeasured; test `inspect_after_rerender_returns_current_state`.
- **M5. Blocking teardown on the actor thread; drop sites.** Confirmed: drops at `browser_daemon.rs:313-325`, `:850-855`; plain channel send (`crates/webview/src/remote/mod.rs:148-151`); 30 s `CALL_TIMEOUT` (`chromium.rs:60`). Changed: one-second bound on remove; `Error::Closed` logged at debug level; released `spawned` tabs stated; `reactDisable` clears the id and `removed: false` defined; typed `attached` flag (also m31); the drop test renamed to the outcome it proves.
- **M6. CI job undecided.** Confirmed: `ci.yml:421`/`:441` is macOS, `:978` forwards only `OMP_REMOTE_JUST_ARGS` (`scripts/remote-verify.sh:101`); the GitHub-hosted `ubuntu-24.04` job at `:791` already installs packages, and the image lists Chrome 157 (runner-images readme, fetched 2026-11-14). Changed: the job, recipe, variables and an acceptance line that the tests ran with `require`; the unpinned version and per-test process ownership are stated; drifted line citations corrected. Rejected in part: a fake-CDP layer for S1 is not added; the real-browser tests cover the same contract.
- **M7. `just test-pkg omp-envd` does not compile the code under test.** Confirmed: `justfile:294-296`, `crates/envd/Cargo.toml:13`, `:19`, `:137-139`. Changed: new recipe `just test-browser` with the features named; S2 to S4 acceptance use it.
- **M8. Test support placement.** Confirmed: no `crates/webview/tests`, `test-support` precedent at `crates/envd/Cargo.toml:132`. Changed: `omp-webview` `test-support` feature; the garbled S2 test name fixed.
- **M9. Two gates; Rust arms for read helpers.** Confirmed: run code reaches the queue only through defined methods (`browser_daemon.rs:1850-1854`, `:1881-1883`); `evaluate` already returns page JSON (`:1375-1387`). Changed: one enforcement point (runtime composition); read helpers are runtime wrappers over `evaluate`; only `reactEnable` and `reactDisable` are Rust arms.
- **M10. Undiscoverable feature; build cost before O6.** Confirmed: `crates/tools/src/browser.rs:293-304`. Changed: D9 schedules only S1 and S2 now; S3 and S4 wait on O6. Rejected in part: O6 is not settled in this record, because changing `browser@3`'s revision is the owner's call under the additive-only rule.
- **M11. The axe cap and its governance.** Confirmed: `crates/envd/Cargo.toml:13-22`, `crates/app/Cargo.toml:25-38`, `deny.toml:30-35`. Changed: `cap-browser-axe` dropped; axe sits under `cap-browser` and the convar; S4 runs in `just test-browser`; D7 says why axe is not a vendor integration under ADR 0049 (`:14-17`) and that O3 extends existing MPL-2.0 practice.
- **M12. Foreign-hook ordering.** Confirmed: upstream defines over any non-omp hook (`devtools-hook.ts:22-23`, `:163-170`). Changed: reads distinguish `react_hook_foreign` from `react_hook_missing`; both document-start orders stated, the omp-first one UNVERIFIED for React DevTools; chaining rejected with its reason; the test registers the foreign hook first with the S1 API so the order is deterministic.
- **M13. `late` and the envelope undefined.** Confirmed: the same source is evaluated both ways upstream (`devtools-hook.ts:14-24`). Changed: the `(false)`/`(true)` invocation, the envelope shape and the rule that every read helper obeys the zero-renderer rule.
- **M14. Truncation algorithm.** Confirmed: upstream recurses children-first (`tree.ts:72-98`). Changed: D6 pins the contract (iterative pre-order, early stop, running byte sum, `omitted` as a lower bound) and labels the figures as initial values for the PR to tune; the timing-gate test is dropped; the central bound (ADR 0009) is named.
- **M15. Fixtures.** Confirmed: no Suspense, large tree or serving method were named. Changed: `basic.html`, `large.html`, `suspense.html`, `file://` loading.
- **M16. React 19.** Accepted in part: unknown tags map to `"other"`, as upstream's table already does (`devtools-hook.ts:81-82`), now pinned by a unit test, and React 19 stays UNVERIFIED in `Status in omp`. Rejected in part: a React 19 fixture is not required now; whether React 19 ships builds usable from `file://` was not verified.
- **m17. Altitude.** Accepted in part: WeakRef detail and the splice detail trimmed, the S2 test list shortened. Rejected in part: reason codes and test names stay, because callers and the slice reviewers depend on them.
- **m18.** Accepted: Stencil, the relay, `Fault`, environment session, frames webview and `legacy.path` defined; EGM defined in the review-state paragraph.
- **m19.** Accepted: D3 now labels detach removal UNVERIFIED and gives the fallback.
- **m20.** Accepted: the redundant ready wait dropped; `remaining` and `mutates_page` explained (`automation.rs:297-300`, `browser_daemon.rs:975-977`).
- **m21.** Accepted: leading comma and the shape of the inserted methods stated; `a11y` arrives with S4.
- **m22.** Accepted: the hook members are listed from `devtools-hook.ts:122-150`.
- **m23.** Accepted: three `from_con` sites (`crates/envd/src/server/session.rs:328`, `:633`, `:876`).
- **m24.** Accepted: S1 says it is proven by its own tests and wired in S2.
- **m25.** Accepted: top-frame guard in the hook (no frame filter at `chromium.rs:643-661`).
- **m26.** Accepted: D1 states the data exposure and that the gate is the control.
- **m27.** Accepted: the reload recipe reads `location.href` because `tab.url()` is cached (`browser_daemon.rs:1863`).
- **m28.** No change, as the finding allowed: a mid-session toggle needs a new session (D2).
- **m29.** Accepted: D5 defines `frames.skipped` as light-DOM frames in the audited context, a lower bound.
- **m30.** Accepted: S1's harness says how the attached view picks its target (`chromium.rs:554-568`).
- **m31.** Accepted with M5: typed `attached` flag.

No blocker was raised in round 3, and none is open. Machine-reviewed (EGM, 3 rounds), not owner-approved.

## Acceptance tests

1. S1: on Chromium, a script added after build runs on reload and navigation, stops after removal, runs in documents another client navigates, and its fate after session detach is recorded (D3's fallback); Firefox reports `Error::Unsupported`; CI shows the browser tests ran with `OMP_BROWSER_TESTS=require`.
2. S2: gate off, `typeof tab.reactTree` is `"undefined"` and the existing envd and tools tests pass.
3. S2: gate on, the React 18.3.1 fixture yields the expected tree, props, state and selector, current after a re-render; the hook survives navigation; a large tree is truncated page-side; read errors are catchable.
4. S2: on an attached tab, `reactEnable` does not reload and reports `needsReload`; a foreign hook registered first is reported, not replaced; the hook is gone after the tab is dropped; the relay's held and unheld detach behaviour holds.
5. S3: render counts follow commits only while recording; Suspense boundaries are listed; lists are capped.
6. S4: axe reports its rule ids on the fixture and nothing on the clean page, counts light-DOM iframes as skipped, restores `window.axe`; the notices file lists axe-core with its source archive.

## Status in omp

**Status: Not started.** Reusable today: the run runtime and `dispatch_helper` (`crates/envd/src/browser_daemon.rs:899-1458`), `WebViewBuilder::init_script` (`crates/webview/src/lib.rs:303-310`), `ariaSnapshot` (`browser_daemon.rs:1168-1180`). Not yet implemented: D1 to D7. Unverified: React 19 compatibility; whether Chromium drops a detached session's scripts; the Chrome binary path on the CI image; React DevTools' behaviour when omp's hook is defined first.

## References

[docs/research/browser-inspection.md](../research/browser-inspection.md); [ADR 0009](0009-bound-output-once.md) (central output bound); [ADR 0024](0024-small-permanent-roster.md) (fixed roster); [ADR 0026](0026-intent-and-versioned-tools.md) (versioned tools); [ADR 0035](0035-rust-for-the-engine.md) (errors); [ADR 0036](0036-python-for-extensions.md) (Python-only extensions and eval); [ADR 0049](0049-tiered-integration-architecture.md) (vendors outside core); `https://github.com/stencil-hq/abkit` (`ReadMe.md`, `docs/protocol.md`, `docs/installing.md`); `https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md`.
