# Roadmap

The task board for omp Desktop. Nothing reaches this file on a hunch: every item
was either measured while building the app or confirmed by an adversarial review
in which a second reader was paid to refute it. Six candidate items were killed
that way and are not listed.

## How to read this

- `- [ ]` open, `- [x]` closed — a closed item names the commit that closed it.
- Every open item gives **where** (file and symbol) and **Done when**: the
  observation that closes it, never the edit that is supposed to close it. This
  distinction is the whole point. A fix to the `opener` scope once passed its own
  review because the check confirmed the permission's *shape* reached Tauri's
  generated ACL, which proves nothing about whether it *grants* anything; the
  dotfile case stayed broken for two more rounds.
- Priorities are about consequence, not size. **P0** means a user loses data or
  is shown something false about their own session.

---

## P0 · Correctness — data is lost or misattributed

- [x] **A1 · Rename and Export can put a second agent on a live session's transcript**
  `src/shell/bridges.ts` — `liveBridgeFor()` returns `undefined` the moment the
  in-webview registry has no bridge, without ever asking the Rust pool. The
  registry only holds a bridge while a `SessionRoute` is mounted, and `/manage`,
  `/onboarding` and `/probe` unmount it while the pool deliberately keeps the
  sidecar running. Callers read that `undefined` as "no process" and fall through
  to the throwaway one-shot sidecar, which performs a persisted write on a jsonl
  the pooled process still owns. The module's own doc comment names this hazard
  three lines above the code that commits it. `DeletePrompt` was fixed; `Rename`,
  `Export` and *Stop the process* were not.
  Closed by replacing `liveBridgeFor` with a three-state `sessionProcess`:
  `none` (safe for a throwaway), `mounted` (use that bridge), `detached` (refuse).
  Rename and Export refuse rather than route, because routing would mean a second
  channel per tab in a relay that is deliberately protocol-ignorant; Stop is
  routed, because killing needs no protocol. A rejected pool query now reads as
  `detached` rather than as "nothing is running", which closes a second
  corruption case the old code had.
  **Known limitation:** the sidebar's greying uses a cached `live` snapshot, so a
  sidecar evicted between refreshes can grey a rename with a message that is no
  longer true. The act-time check in `sessionOps` is the actual safety; the
  greying is only an affordance.

- [x] **A2 · An evicted in-app chat comes back as a different, empty session**
  `src/rpc/useBridge.ts` — `boot()` switches sessions only when a `sessionPath`
  is known, and reloads history only when the process was resumed. A chat started
  inside the app has no `sessionPath` by design (`src/app.tsx`: adopting a session
  records its id and deliberately not its path, because the path is a boot input
  and `switch_session` aborts the session). When the pool evicts that tab and the
  user returns, a fresh process is spawned: neither branch runs, `markBooted()`
  is called over an empty session, and the next prompt is written to a different
  jsonl than the transcript on screen.
  Closed by remembering `tabId → sessionFile` in a module that outlives the
  bridge, because the identity is *not* knowable after the respawn: the boot's
  own `get_state` is answered by the new process and describes the session it
  just created. The memory is erased on close, since a project's tab id is
  `dir:<cwd>` and comes back — and `switch_session` does not fail on a missing
  file, it recreates it, so a stale path would resurrect a deleted transcript as
  an empty one.

- [x] **A3 · The one-shot path never checks whether its `switch_session` worked**
  `src/rpc/sessionOps.ts` — `oneshot()` writes the switch frame and the command
  frame together and reads back only the second. A `session_before_switch`
  handler returning false, or a `SESSION_CWD_CHANGE_REJECTED` throw when the
  session's recorded cwd differs from the throwaway's process cwd, both leave the
  child on its own fresh empty session while the command still answers success.
  Callers pass `session.cwd || session.projectRoot || ""`, so a listing without a
  cwd makes the mismatch reachable with no extension installed.
  Closed on both sides: `agent_oneshot` now answers one line per awaited id, and
  the client refuses the command's answer unless the switch that preceded it
  worked. Both real failure shapes come back as `success: true` carrying
  `data.cancelled`, which is exactly what reading `success` alone missed.
  **Consequence worth stating:** a session whose recorded cwd is a symlinked
  spelling of its real directory now refuses to open rather than renaming the
  wrong one — correct, but with no workaround from the UI while it is closed.

- [x] **A4 · A rejected send silently eats the composed message**
  `src/components/composer/useComposerDraft.ts` — `submit` revokes the object
  URLs and clears draft, attachments and references *before* awaiting the send,
  and the await's `.catch` is empty. `prompt()` carries no `streamingBehavior`,
  so the server throws `AgentBusyError` for a prompt that arrives while
  streaming; the composer picks prompt-vs-steer from a snapshot that refreshes
  only on state-changing events, so a submit in the window between a turn
  starting server-side and the client noticing is rejected and lost.
  Closed three ways, because the named trigger turned out not to reach the client
  at all: the server acknowledges `prompt` before the turn starts, so a later
  `AgentBusyError` arrives as a second response on the same id and the bridge
  dropped it as a late frame. So: `prompt` now carries `streamingBehavior`, the
  bridge surfaces a post-acknowledgement failure, and the draft is given up only
  after the send lands.

- [x] **A5 · Reloading history mid-stream loses the reply being written**
  `src/rpc/transcript.ts` — I had this backwards, and the design corrected me: the
  server does not put the in-flight message in a `get_messages` answer at all
  (it is appended on `message_end`), so a mid-turn reload **deletes** the reply
  rather than duplicating it — and deletes a running tool card along with the
  handle its result would have landed on. The duplicate is real too, but arrives
  from the other side: the relay coalesces frames, so `hydrate` can land behind
  frames that logically follow it. One fix covers all three — an entry now keeps
  the identity its frame carries, and `hydrate` carries the in-flight tail across
  the rebuild.
  **Done when:** a `TranscriptModel` test hydrates a transcript whose tail is
  still streaming, applies the next update for that same message, and ends with
  one entry. The test must fail if the fix is reverted.

## P1 · Behaviour — the app does the wrong thing, visibly

- [x] **B1 · Leaving plan mode over RPC does not interrupt the running turn**
  `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — `set_plan_mode` exits
  without interruption while the terminal's exit passes `interruptActiveTurn`.
  Turning plan mode off from the app mid-turn leaves that turn running under the
  old toolset. The two exits are not the same event and must not behave the same:
  approving a proposed plan exists to continue into execution, and aborting there
  would kill what the user just approved.
  **Done when:** toggling plan mode off mid-turn stops the turn; approving a plan
  does not.

- [x] **B2 · Session state is never refreshed after switching into a saved session**
  `src/rpc/useBridge.ts` — `getState()` runs before `switchSession()`, and the
  switch clears the transcript and reloads history without re-reading state.
  State has one writer, driven by turn and compaction events, none of which a
  switch fires. So the status bar, model picker and context meter describe the
  throwaway session the sidecar booted into until the first turn ends.
  **Done when:** opening a saved session shows that session's model and context
  usage immediately, before any turn runs.

- [x] **B3 · Truncated `git` output is presented as a complete diff**
  `src/workspace/git.ts` — the RPC `BashResult` carries `truncated`, declared on
  the local type and never read. `rawFileDiff` returns the output verbatim, and
  `fileDiff`/`changedFiles` parse it, so a diff larger than the capture window is
  shown — and copied — as an applicable patch with its middle silently removed.
  **Done when:** a diff that exceeds the capture window is refused or visibly
  marked, and never offered to the clipboard as a patch.

- [x] **B4 · "Stop the process" is a dead control from any non-session route**
  `src/components/Sidebar.tsx` — same root cause as A1. From `/manage`,
  `/onboarding` or `/probe` the menu item resolves no bridge and does nothing.
  **Done when:** stopping a live session from the sidebar while on `/manage`
  kills its sidecar; `pgrep -cf "mode rpc-ui"` drops by one.

- [x] **B5 · The MCP screen reports neither success nor failure**
  `src/manage/McpScreen.tsx` — commands are sent with `bridge.prompt` and the
  screen renders nothing about what came back, so a failed `/mcp add` is
  indistinguishable from a successful one.
  **Done when:** a failing MCP command shows its error on that screen.

- [x] **B6 · Model and thinking-level failures are dropped**
  `src/components/ModelPicker.tsx` and `src/components/ApprovalModeBadge.tsx` —
  both swallow the rejection. The control goes mute and the only trace is an
  unhandled rejection. Fix both or neither; they are the same shape.
  **Done when:** a rejected model change surfaces through the bridge error
  banner rather than the console.

- [x] **B7 · The working indicator's dots render square**
  `src/styles/app.css` — the flattener strips every radius under `.omp-shell`
  with `!important`, exempting `.omp-dot` inside its `:not()` list. The later
  attempt to restore `.omp-working span` adds the class to a *rule* rather than
  to the exemption list, so it loses on specificity (0,1,1 against 0,2,0). The
  comment above it states the defect is fixed; it is not. Verified by computing
  the style, not by reading the rule.
  **Done when:** the computed `border-radius` of a working-indicator span is
  `50%` in the running app, and the comment no longer claims a fix that is not
  there.

- [x] **B8 · The pre-warmed spare could still be installed as a fourth process**
  `src-tauri/src/lib.rs` — capacity was checked before a spawn that takes
  seconds, and the post-spawn check asked only whether another spare had
  appeared. A third project session inserted while the spare was starting left
  it installed anyway, over the ceiling that the eviction path holds everywhere
  else.

- [x] **B9 · Nine findings from the second Codex round** — a refused
  `switch_session` at boot read as success; the pool could still reach four
  processes when two different tabs raced; a message refused *after* the agent
  accepted it vanished, because the server acknowledges a prompt before the turn
  starts and the bridge dropped the later refusal as a late frame; an approval
  the server had stopped waiting for held the screen and the queue, since the
  timeout path sends no `cancel` and nothing ran the deadline the frame carries;
  the editor dialog opened blank over the document it was asked to edit; a
  session whose process died mid-turn kept reading as working, blocking the
  window close; a worktree-side rename grew a phantom file with a truncated
  name; `new Promise` where the house rule asks for `Promise.withResolvers`.

- [x] **B11 · A third Codex round: two more, both real** — `agent_kill` answered
  `Ok` for a tab whose cold start was between dropping the pool lock and
  inserting its child, so Stop did nothing and delete unlinked the jsonl on the
  strength of that answer, after which the booting child switched to the missing
  path and recreated it. A spawn in flight is now reserved, and a stop cancels
  it. And copying the diff of an untracked file put an empty string on the
  clipboard, because only the rendered path had a fallback; it now asks git for
  a real `new file` patch.

- [x] **B10 · Three tests scanned source text, which `AGENTS.md:284` bans** — and
  two of them were added the same morning, on the third as precedent. The ban is
  right: they break on a rename and pass on broken behaviour. Rather than delete
  the guard the third one held — that only the turn's abort handler listens for
  Escape on `window`, a rule three overlays have broken — the invariant is now
  structural. `useEscape` owns the target and every overlay goes through it, so
  there is no per-overlay decision left to get wrong.

- [x] **B12 · A sent message took seconds to appear** — measured before touching
  anything: the sidecar acknowledges a prompt in **34 ms**, and the second and
  third prompts of a session echo the message in 34 ms and open the turn in 6 ms.
  The whole cost is the FIRST prompt of a session — 3.7 s in one run, 12 s under
  load — spent connecting MCP servers, and the app's boot sequence does not warm
  it. What was ours: nothing was drawn until the server echoed the message back,
  and the working indicator comes from `state.isStreaming`, which is refreshed
  only at turn boundaries — so it lit at the END of the wait. The composer now
  draws the message immediately and the server's copy reconciles with it.

  Measured and deliberately NOT changed: the relay's coalescing adds a mean of
  4 ms; the bridge already collapses a batch of 50 deltas into one snapshot
  notification; and the transcript's memoisation holds — 0.995 entry identities
  change per delta at 300 entries, so one bubble re-renders, not 300.

  **Still open, and named rather than guessed at:** `message_update` carries the
  whole message, so `marked` re-parses it per batch and is superlinear — 16 ms
  per delta at 20 KB, ~940 ms cumulative for a 20 KB answer. The obvious fix
  (`useDeferredValue`) was designed and then rejected: it breaks the transcript's
  auto-scroll while streaming, and worst in exactly the long-answer case it would
  serve. A real fix needs the pin to follow the deferred commit.

- [ ] **C6 · The sidebar dot does not light during a turn that is still starting**
  The transcript's indicator does, because a pending echo is its own proof of
  work. Carrying that to the sidebar needs a bridge-level flag the activity store
  can read for unmounted tabs — and that store has no cleanup, so a flag
  published and orphaned by a route change would show a busy session forever.
  **Done when:** a background tab's dot lights between Send and `turn_start`, and
  navigating away mid-send does not leave it lit.

- [x] **B13 · The fifth review round: nine findings, one a regression of the
  fourth** — the reservation check landed in front of the branch that adopts an
  installed winner, so a second `agent_start` for one tab reported the session
  stopped instead of attaching to it. Plus: the model picker cached a transient
  failure as an empty catalog and never retried; the active row matched on id
  without provider; two dynamic `import()` survived a sweep I had called done;
  the smoke probe used node's spawn twelve lines above its own `Bun.spawn`;
  `abort_compact` acknowledged before the cleanup barrier it was already handed;
  custom tools got the compaction origin only on the start half; and a manual
  pass falling back to another method returned in front of every lifecycle close.

  **Two honest gaps.** I could not build a test that reaches that fallback
  branch — the active model is added as its own first candidate and passes the
  filter by construction whenever `remote` was selected on provider-native
  support — so the fix is reasoned, not proven, and the test that passed either
  way was removed rather than kept as decoration. And the conformance test still
  reads `rpc-types.ts` as text: the rule's own alternative was built and
  measured, catches the historical bug as a compile error, and is unusable here
  because importing those types makes `packages/ai` stop type-checking under the
  DOM lib this package needs.

- [x] **B14 · The sixth round: three more, and a claim of mine that was false**
  The sidebar's `done` dot latches on the falling edge and is cleared only by
  `markViewed`, which runs on activation — so the tab you are already on kept
  announcing a finished turn while you read it. MCP arguments were split on
  whitespace, so a quoted `-e` script or a path with spaces reached the server as
  several argv entries; it now goes through the repository's own
  `tokenizeShellSegments`, with a JSON array as the escape hatch. And the
  changelog said clicking a notification brings that session forward when no
  click handler existed at all — my line, written before the feature. The
  notification now carries its tab in `extra` and the shell activates it.

  **Unverified, and it is the interesting half:** whether macOS delivers a plain
  body click to `onAction` at all. The round trip is right in code; nobody has
  clicked one. It belongs to C5's manual pass.

## P2 · Verification — things believed to work that nothing observes

- [x] **C1 · The package's 266 tests run in no CI bucket**
  `scripts/ci-test-ts.ts` selects packages from three explicit allowlists and
  `packages/desktop` is in none of them; `grep -rn desktop .github/` returns
  nothing. Every regression guard written for the defects already fixed —
  including the conformance test that pins the wire shapes against omp's own
  `rpc-types.ts` — is decorative outside a local run.
  **Done when:** the suite runs in CI on this PR and its failure would block.

- [ ] **C2 · The Rust crate is in no CI job and has no tests**
  `src-tauri/Cargo.toml` declares its own `[workspace]` — deliberately, so the
  root build does not drag in Tauri — which also puts it beyond the root
  clippy/fmt tasks. The pool logic changed twice in the last two rounds (LRU
  eviction, the prewarm ceiling, two identity guards) and nothing mechanical has
  ever read it.
  **Half done.** `bun run check:rs` in this package now runs clippy against the
  crate, which passes. Two pieces are deliberately left out. `cargo fmt --check`
  is not in it: the repository pins `nightly-2026-08-08` and a stable rustfmt
  ignores the nightly-only options in `rustfmt.toml`, so it reports diffs that
  are toolchain artifacts — a gate nobody can put green is worse than none.
  And the crate cannot join the repository-wide Rust tasks, because Tauri needs
  webkit2gtk on Linux and every one of those jobs is Linux.
  **Done when:** a macOS CI job runs both, on a runner with the pinned
  toolchain. Unit tests over eviction need `Session`'s child handle
  parameterised first; that is a separate item if it is worth doing.

- [x] **C3 · The smoke test cannot detect a dead webview**
  `scripts/smoke.ts` asserts the process lives, a sidecar appears, and no refusal
  line is printed. All three hold with a webview that failed to render, because
  the sidecar is spawned by Rust. Its header, and this file, claimed more than
  that.
  **Done when:** the script fails if the webview never reaches the point of
  asking Rust for a session.

- [x] **C4 · Five of the smoke test's eight refusal patterns can never match**
  They describe CSP violations and capability refusals that surface in the
  webview console, which the script does not read. Either delete them and drop
  the claim, or add the bridge that makes them reachable.
  **Done when:** every pattern the script greps for is one that can actually be
  produced.

- [ ] **C5 · No manual pass over a bundle built from current HEAD**
  The pool changes of the last round are compiled and reasoned about, not driven.
  A bundle from HEAD builds, launches, reports its window loaded and spawns a
  sidecar with nothing refused (`bun run smoke --build`, after the upstream
  merge). Opened by hand as well, which confirmed more than the smoke test can:
  the sidebar lists real sessions grouped by project — so `omp sessions --json`
  works end to end through the relay, including the pi-vcs port — the
  startup-progress notices and the process-exit banner render and say something
  true, and quitting leaves zero sidecars behind.

  **What is still unverified is the clicking, and the reason is the harness, not
  the app:** synthetic clicks do not reach this bundle at all — not the webview,
  not even its native traffic-light buttons — because it is an unsigned debug
  bundle outside `/Applications`. So a person has to do this pass, or the bundle
  has to be signed and installed first.

  One thing that pass would want to know: on a machine whose prebuilt native
  addon predates the pi-vcs crate, `resolveActiveRepoContext` fails and startup
  takes over a minute cold. The app says so rather than hanging silently, which
  is the behaviour that made this diagnosable at all.

  **Done when:** that bundle has been driven once through: opening a file under
  a dot-directory, a fourth tab forcing eviction, a native notification, and
  paste through the context menu.

## P3 · Documentation accuracy — what the repository tells a reviewer

- [x] **D1 · This file's "Broken right now" section was stale** — five of its six
  entries were fixed, and it was the first thing a reviewer read. Replaced by
  this board.

- [x] **D2 · The README describes the wrong channel for MCP, and miscounts twice**
  `README.md` says settings, plugins *and MCP* are managed over short CLI
  invocations. `src/manage/McpScreen.tsx` says the opposite in its own header and
  the code agrees with the header: `/mcp` is a slash command over the session's
  RPC connection. The same paragraph says the protocol has 59 commands (it has
  45, counted twice by two methods) and that 22 call sites carry the button
  attribute (35, and never 22 at any commit).
  **Done when:** each number matches what a counting command returns, and the
  MCP sentence matches the code.

- [x] **D3 · The changelog omits a headline feature and two fix rounds**
  Native notifications are advertised in the README and appear nowhere in
  `CHANGELOG.md`; two of the four fix rounds left no user-visible entry.
  **Done when:** the "Added" list matches what the README advertises.

- [x] **D4 · The root README's package table has no row for this package**
  It is the only workspace package missing from it, and this PR is what adds the
  package.
  **Done when:** the table lists it.

## P4 · Pull request hygiene

- [x] **E1 · The branch is behind its base** — `main` has moved 115 commits since
  the last merge, and GitHub reports the PR as conflicting. `git merge-tree`
  against the current base reports zero conflicts, so this is a merge and a push,
  with nothing to resolve by hand.
  Merged; zero conflicts, as `git merge-tree` predicted. It did break one thing
  the merge itself could not see: upstream replaced `utils/git` with the `pi-vcs`
  crate, and `omp sessions --json` — this package's data source — imported the
  deleted module. Ported to `vcs.gitInfo`, with the attribution rule extracted as
  a pure function so it stays testable on a machine whose prebuilt native addon
  predates that crate, which is every machine that cannot build it.

- [x] **E2 · Review threads left open that later commits closed** — several
  threads point at code that has since changed. Resolving them with a pointer to
  the fixing commit is what keeps the remaining open ones meaningful.
  All eighteen threads were addressed and are resolved, with a comment on the PR
  mapping each finding to the commit that closed it.

---

## Closed in this branch

Sixteen commits, 207 files, 25 test files. Four review rounds, three of them
adversarial with a refuter per finding, plus three external bot reviews.

- [x] **The app itself** — sidecar relay and process pool, protocol client with
  correlation by id, session list grouped by git checkout, streaming transcript
  rendering omp's own tool cards, read-only diff and file tree, task panel, live
  subagents, settings/plugins/MCP screens. `67899d3477`, `c33633f963`
- [x] **Plan mode and compaction over RPC**, instead of being guessed at from
  prose — new commands, a state field, a lifecycle event. `580249a573`
- [x] **Round one: five things that had never worked once** — the `opener` scope
  that refused every path, `path` vs `sessionPath`, the unwired file-tree menu,
  cut and paste acting on a lost focus, and a remount that aborted the turn.
  `5893e8cbc7`
- [x] **The content security policy turned back on** and the image reader
  narrowed to paths that arrived by a real drop. `b0db5c4e2d`
- [x] **Round two: the relay and the protocol client** — the blocking-UI queue,
  the compaction deadline, the spawn race, the overflowed frame. `3f6750cd12`,
  `65853e36aa`
- [x] **Round three: two regressions of my own**, one of which reopened the
  hazard it was meant to close. `858e871156`, `4561686285`
- [x] **The compaction and plan-review paths** the RPC additions had opened —
  including a manual `/compact` being repainted by the automatic handlers.
  `42d4c76afe`, `687df75b66`, `93d96f8f37`, `cc096e28cc`
- [x] **A smoke test that launches the packaged app**, because nothing did.
  `4838d202fc`
- [x] **Round four: the session that was working is no longer the first evicted**
  — output now counts as activity — and deleting a session stops its process even
  when no route is mounted. `79e7e13cfe`

---

## Next — not built yet

- [ ] **Ship it.** The app builds a DMG, but distribution is wired in
  documentation rather than in code: a signing identity and notarization
  (`docs/macos-signing-notarization.md` has the mechanics), an updater keypair —
  Tauri validates the public key at build time, so a placeholder breaks the build
  rather than degrading — and a release endpoint. Every release must embed a real
  omp binary: `sync:sidecar` generates a shim that execs an installed `omp`, and
  `scripts/release.ts` refuses to package with it unless forced, because that
  failure would otherwise be silent.
- [ ] **Assertions about what is on screen.** `bun run tauri build --debug`
  produces a real `omp Desktop.app` that a person or an agent with screen control
  can click through, and `bun run smoke` launches it. Neither can prove a menu
  opened or a file opened in an editor. Until something automates that, every
  change costs a manual pass.
- [ ] **Windows and Linux.** macOS first was deliberate: it bounds where WebKit
  and Chromium disagree. The relay and the protocol client are platform-agnostic;
  the title bar is not, and `externalBin` needs a target-triple binary per
  platform.
- [ ] **The Plan tab shows the plan file.** Plan mode works and its approval
  dialog renders the plan, but the side panel does not show the document while it
  is being written. The file is locatable — the session file is in the RPC state
  and the plan sits beside it — but reading it needs either a new RPC command or
  a `bash` call, and the context-cost item below argues against the second.

## Known debt

- [ ] **`handoff` still holds the serialized command queue.** `compact` and
  `bash` are dispatched in the background so `abort` and `get_state` keep
  answering while they run; `handoff` is not, and it can block for minutes. Same
  defect, same fix, not yet applied.
- [ ] **Plan mode has two implementations.** `AgentSession.setPlanMode()` was
  added for the RPC path and the terminal's own entry was not refactored onto it.
  They agree today and nothing keeps them agreeing.
- [ ] **The app's own shell commands land in your session's context.** The diff
  and file panels run `git` through the session's `bash`, and those calls are
  recorded in the transcript: one session measured 69 execution records, roughly
  9.8K tokens of the app talking to itself. A side channel that does not write to
  the session would fix it.
- [ ] **The `compact` response carries no session id,** so a failure arriving
  after a `switch_session` cannot be attributed.
- [ ] **Clipboard paste is unverified on WKWebView.** The plugin was chosen so
  this does not depend on what the engine allows, but only a driveable app can
  confirm it.
- [ ] **Closing a session is not a thing you can ask for.** Deleting one closes
  its tab; there is no other way. Sessions opened this run stay open and Rust
  reclaims their processes by LRU once more than three are live.
- [ ] **Transcripts are not virtualized.** collab-web renders a full transcript
  without windowing and copes, so this waits on a measurement with several
  hundred messages rather than a guess — virtualizing breaks the browser's own
  find and complicates auto-scroll.

## Deliberately not doing

**Editing the agent's task list.** `set_todos` exists in the protocol and stays
unused: the plan has one owner, and two writers on a list the agent rewrites
wholesale is a race with no upside.

**A theme picker.** The transcript uses `titanium` because that is the CLI's
default. The generator is written so a second theme is a one-line change, but
importing all 100 is a feature nobody asked for.

**A second front-end for configuration.** Settings and plugins are managed
through omp's own CLI, and MCP through its slash commands. The app curates them;
it does not become a second place where that state lives.

**An embedded editor.** The diff is read-only and editing opens your system
editor. Syntax highlighting, LSP and reconciling edits against an agent writing
to the same files is a different product.

**Collab.** Reachable by slash command; not a surface of its own.
