# Round 2 seam fixes

Assignment: A backoff admission, B reusable transport context, C stated-delay refusal; optional Factory and GitLab refusal reporting, only named AI sources/tests. Owner retains changelog and commit/push duties.

- Read systematic-debugging, test-driven-development, receiving-code-review, dispatch, fork-work, jason-test and verification-before-completion.
- Searched Dispatch for `retry budget`; read tracked parent INFRA-515. CodeGraph status failed because the CLI is unavailable on PATH; using scoped file reads and search instead. No session records read.
- A: empty-completion-retry admits raw backoff before sleepUnderBudget clamps it; replayAfter also passes an unclamped own backoff into admission.
- B: transportFetch's boolean stamp returns a prior closure unchanged, losing a new budget/hooks. Need immutable source metadata and flat rebuilding when context changes, not stacked transports or mutable shared hooks.
- C: replayAfterDelay accepts an already-stated delay but sleeps through a clamping helper; compression supplies no failure object to record refusal. The known-delay entry must decline and mark its object, and compression must supply its Response.

- Added regressions before source edits: A exact 100 ms budget / 50 ms ceiling / 500 ms local backoff for empty and provider-error wrapper attempts, plus replayAfter's own backoff; B prebuilt preparation consumes 30 ms under a new 10 ms budget and immutable hook rebinding; C real gzip rejection with Retry-After: 1 under a 10 ms ceiling, with and without a 10 s budget, and both ReplayBudget replay entry points.
- Environment presence (`${VAR+SET}`): PI_CONFIG_FILES, PI_SESSION_FILE, PI_SESSION_ID, OMP_SESSION_ID and PI_SHELL_PREFIX were SET; CLAUDE_CODE_SHELL_PREFIX was absent. Every suite command explicitly unsets all six (actually clears the first five).
- Added a real Factory 429 regional-error regression requiring structured refusal plus one visible note, and a rebound prebuilt transport + streamSimple resolver regression requiring one debug dump and only current hooks.
- Initial four-file gated sanitised run (empty-completion-retry, replay-budget, transport-fetch-gate, request-compression): `0 pass / 4 fail / 4 errors`, import failures because all linux-x64 native addon variants are absent. Full output artifact://13963. Owner notified to restore addon; no generated files edited or build attempted outside scope.
- Extended GitLab fresh-workflow regression to cover a budget-spent refusal and a 10 s budget with a 1 s textual server wait refused by a 10 ms ceiling; the latter requires structured refusal and display-only note.
- GitLab's spent-budget row leaves the ceiling unset so it continues exercising budget refusal independently; the second row alone supplies the 10 ms ceiling.
- Owner restored the gitignored native addon and updated the two outside-scope refusal carriers (stream auth retry and Copilot denial resend). Owner explicitly instructed that the single final `bun check` and combined final focused pass are theirs after both workers finish; do not run a duplicate check here. Seven scoped AI test files submitted through the test gate for red controls after addon restoration.
- Seven-file sanitised red controls after addon restoration: `214 pass / 13 fail / 812 expect() calls`, `Ran 227 tests across 7 files. [1036.00ms]`. Eleven new-regression failures expose A/B/C and both reporting defects. Two pre-existing 90 s-hint budget tests also fail: their default 60 s policy ceiling refuses before the 2 s budget, so their required replayBudgetExhausted flag is absent. Owner notified; intended fixture correction is an explicit 100 s policy cap, keeping all budget assertions.
- Fixed A by bounding local empty/provider-error backoffs before budget admission; rechecked the longest server wait before policy refusal. Fixed replayAfter's own-backoff ordering too. Fixed C by declining+recording known server delays in replayAfterDelay, and checking compression resends with/without a budget while marking the Response carrier. sleepUnderBudget's API comment now distinguishes bounded local backoff from prevalidated stated waits.
- Fixed B with immutable TransportSetup metadata: unchanged context reuses the transport; changed budget/hooks rebuild over the original base, preserving counters and caller-base opacity without another debug layer or mutating the old call. beforeDispatch/origin/preparation/checkpoint/base order remains unchanged. withRequestTransport now reaches context rebinding rather than bypassing it on a counted stamp.
- Fixed Factory's regional display helper to retain its structured refusal note at both event and catch paths, guarded against duplicate notes. Fixed GitLab's fresh-workflow replay to pass a ProviderResponseError object and apply the shared finalizer when a policy refusal is recorded, preserving display/classification separation.
- Adjudication (owner-approved): the two budget fixtures use a 90 s server hint, default 60 s per-sleep cap, and 2 s call budget. The policy cap actually refuses first; their names and exhaustion assertions claim the budget boundary. An explicit 100 s cap now isolates that budget boundary while retaining every assertion. Marking the policy refusal as replayBudgetExhausted instead would dishonestly claim the budget refused a replay it never considered. Added header/text policy-control cases at the original values requiring structured refusal and exhaustion unset, so the moved boundary loses no coverage.
- Scoped simplification: consolidated replay-budget imports in compression, and retained the options identity on counted transport re-entry instead of allocating an equivalent spread. No behavior/test guards removed.
- Scoped formatter command: `bun x --no-install oxfmt` followed by the six source paths and seven affected test paths. Output: `Finished in 42ms on 13 files using 8 threads.` Exit 0. No files outside scope formatted.
- Fixed seven-file sanitised suite: `229 pass`, `0 fail`, `851 expect() calls`, `Ran 229 tests across 7 files. [945.00ms]`; command exit 0. Prefix actually cleared PI_CONFIG_FILES, PI_SESSION_FILE, PI_SESSION_ID, OMP_SESSION_ID and PI_SHELL_PREFIX; CLAUDE_CODE_SHELL_PREFIX was already absent. Gate waited 210 s for test and 75 s for heavy.

## Intended red controls, now green

- `checks the current call's budget after a prebuilt transport's preparation hook` — B: new 10 ms budget must refuse after 30 ms preparation with zero sends; failed before fix, now green.
- `rebinds a built transport to new hooks without changing another call's hooks` — B: new dispatch uses new hooks while the original stays unchanged; failed before fix, now green.
- `keeps one debug layer when a prebuilt transport is rebound and streamSimple re-enters` — B: resolver-based streamSimple re-entry must issue one request/dump and only current hooks; failed before fix, now green.
- `admits a empty replay after clamping its own backoff to both bounds` — A: 500 ms own backoff must sleep 50 ms within 100 ms budget and recover; failed before fix, now green.
- `admits a provider error replay after clamping its own backoff to both bounds` — A: same exact bounds on the provider-error branch; failed before fix, now green.
- `does not restart when a fresh workflow exceeds its budget or stated-wait ceiling (budget 10000)` — GitLab reporting: a refused wait must retain structured refusal and visible note; failed before fix, now green.
- `admits its own 500 ms backoff after clamping it to a 50 ms ceiling inside a 100 ms budget` — A helper entry: replayAfter must admit bounded own backoff, not raw 500 ms; failed before fix, now green.
- `replayAfterDelay refuses and records a stated wait above the ceiling` — C helper entry: known server delay must refuse and mark rather than clamp; failed before fix, now green.
- `refuses a compressed-body resend rather than shortening Retry-After (budget: %s)` (budgeted=true row) — C: real gzip rejection, Retry-After: 1, 10 ms ceiling, 10 s budget; one request, zero sleeps, recorded refusal; failed before fix, now green.
- `refuses a compressed-body resend rather than shortening Retry-After (budget: %s)` (budgeted=false row) — C: same ceiling refusal on the no-budget compression path; failed before fix, now green.
- `keeps the refused-wait note beside the regional explanation` — Factory reporting: regional display rewrite must preserve exactly one refusal note; failed before fix, now green.

## Entry-point audit

- `ReplayBudget.replayAfter`: refuses/marks server wait first, clamps only own backoff before admission.
- `ReplayBudget.replayAfterDelay`: refuses/marks known server delay before admission/sleep.
- `withReplaySafeStreamRetry`: empty/provider-error own backoff clamped first; server-stated waits refused/marked, including the longest wait under a budget.
- Compression resend with and without budget: refuses/marks Response, otherwise honors full stated wait.
- Known-delay callers: compression passes Response; owner-updated stream auth retry passes failure.error and Copilot denial resend passes Response to both decline and replay. No remaining production replayAfterDelay caller passes undefined as carrier.
- `sleepUnderBudget` / `ReplayBudget.wait`: low-level scheduling of own backoff or already-validated stated wait; policy-owning entries above prevent a stated wait from entering the clamp above its bound.
- Transport re-entry verified in request-debug.test.ts: both existing resolver/auth-path test and new rebound prebuilt test pass with exactly one debug dump for one wire request.

- Scoped lint command: `bun x --no-install oxlint` followed by the same six source and seven test paths. Output: `(no output)`; exit 0.
- Owner fixed the additional Copilot no-budget denial resend: stated wait read and decline/record now precede the budget branch; the no-budget branch sleeps the already-validated full wait. The refuse-don't-clamp rule now holds at every enumerated entry point below, with refused waits recorded on an object. The owner will verify the combined final tree.
- Completion audit uses the assignment and current notes only; no session record was read. All requested source/test edits are complete and the seven scoped suites are green. The owner's single final bun check and combined suite remain intentionally theirs; changelog is outside this worker's allowed paths.

| Entry point | Refuses server waits above bound | Records refusal | Clamps own backoff only |
| --- | --- | --- | --- |
| ReplayBudget.replayAfter | Yes, before admission | failure object | Yes, before budget admission |
| ReplayBudget.replayAfterDelay | Yes, before admission/sleep | replaced failure object | Known-delay entry is server-stated only; own backoff uses replayAfter |
| withReplaySafeStreamRetry: empty completion | No server wait on this branch | Not applicable | Yes, before admission |
| withReplaySafeStreamRetry: provider error | Yes, including longest named wait under budget | failed AssistantMessage, then display-only note/structured field | Yes, before admission |
| Compression resend with budget | Yes | rejected Response | No own backoff; validated stated wait remains whole |
| Compression resend without budget | Yes | rejected Response | No own backoff; validated stated wait remains whole |
| stream auth-retry known-delay caller (owner edit) | Yes, through replayAfterDelay | failure.error object | No own backoff |
| Copilot denial resend with budget (owner edit) | Yes, before budget branch | denied Response | No own backoff; validated stated wait remains whole |
| Copilot denial resend without budget (owner edit) | Yes, before budget branch | denied Response | No own backoff; validated stated wait remains whole |
| GitLab fresh-workflow restart | Yes, through replayAfter | ProviderResponseError, then shared finalizer onto output | No own backoff |
| sleepUnderBudget / ReplayBudget.wait | Scheduling only; stated waits prevalidated at entries above | At the owning entry above | sleepUnderBudget clamps own backoff; ReplayBudget.wait never shortens a wait |

- Inline simplification review covered reuse, quality, efficiency, tests and comments. Kept regressions and API contract comments; no further behavior-preserving simplifications justified. Reused retryWaitBounds, shared refusal formatting/finalization, existing wire-counter helpers and existing test fixtures.
- Confirmed owner's final Copilot code by scoped read: wait parsing and decline/record precede the budget branch, and its no-budget branch sleeps the already-validated full wait. Told ReaderRewrite source/tests are stable and that final whole-tree check ownership must be coordinated with the parent; no duplicate check started.
