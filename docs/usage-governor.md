# Usage governor

The usage governor paces paid quota across the agent processes on one machine. It is off by default. When `usageGovernor.enabled` is `true`, each request sent with a stored OAuth credential of this agent directory is checked before it leaves the process. The check reads the cached usage window for that account. If sending now would take the account past its allowance line, the request waits until the line catches up. Waits end when the request is aborted.

The governor is a forecast built from cached data. It does not guarantee that a request succeeds, that a provider limit is never reached, or that a wait ends before a reset.

## Settings

| Key                                | Type                 | Default | Meaning                                                                                                                  |
| ---------------------------------- | -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `usageGovernor.enabled`            | boolean              | `false` | Turns admission and governed account ranking on. Off creates no ledger file and leaves the dispatch path unchanged.     |
| `usageGovernor.leadPct`            | number, 0 to 100     | `25`    | Share of a window's allowance usable ahead of linear pacing at the window start. It decays to 0 at reset.                |
| `usageGovernor.interactiveReserve` | `hold` or `spend`    | `hold`  | Whether foreground requests may use the account reserve. See [Interactive reserve](#interactive-reserve-hold-or-spend). |

Two existing settings also shape the governor:

- `retry.usageReservePct` (default `10`) is the reserve target for every account, and the governor's reset target.
- `auth.accountPolicies[].reservePct` overrides that target for one account.

See [settings](./settings.md#usage-governor) for the same keys in the settings reference.

## How a request is paced

For each applicable window of the account a request would use:

- Only windows with a finite, current reset time are paced. Windowless limits such as credits or extra usage, and rolling windows, are not paced.
- The reserve `r` is the account's reset target as a fraction. With `interactiveReserve: spend` and a request a person is waiting on, `r` is 0.
- The allowance line `A` is `(1 - r) * (lead + (1 - lead) * x)`, where `x` is the elapsed share of the window. It starts at `lead` and reaches `1 - r` at reset. When the window length is unknown, `A` is `1 - r`.
- The need is `u + (p + 1) * c`. `u` is the used fraction in the cached snapshot. `p` counts reservations created after that snapshot was fetched, across every process on this machine. `c` is the calibrated cost per request, `0` until calibrated.
- If the snapshot is exhausted or the need is above `1 - r`, the window is `closed` until its reset.
- If the need is at or below `A`, the window is `open`.
- Otherwise the window is `paced` until the line reaches the need, and the request waits.

The request is admissible at the latest time across its windows. That window is the binding one. Every overlapping window is enforced.

The cost per request `c` is the usage growth observed across the reservations made in one window generation. It is used when at least three reservations fall between the first and last observation and usage grew across them. Otherwise the last value for the same quota from an earlier generation applies, and with none, the window reads `uncalibrated`. Consumption by other machines and applications raises the cost, which makes pacing more conservative.

The governor never generates work to consume quota. A request is never sent early to fill a window.

## Account routing

The governor ranks accounts inside `CredentialSelector`. Accounts whose window is open rank ahead of paced ones, and paced accounts rank ahead of closed ones. Within the paced group, the account that becomes admissible first is preferred, so a forced wait is the shortest available. Credits (extra usage) are never preferred over paced included usage.

The governor chooses no model and no provider. Model fallback chains and `retry.usageAwareFallback` behave as before and still use the static reserve. A role's configured chain is never widened.

## Interactive reserve: hold or spend

- `hold` (default): every request keeps the reserve. An interactive turn that cannot be sent waits until it is admissible, and the wait can be aborted. `retry.usageAwareFallback` can still move the turn to the role's next model before it is sent, if that setting is on.
- `spend`: a request a person is waiting on in the foreground may use the reserve. Background and subagent requests keep it.

## Coverage

Admitted when the governor is enabled. Each of these goes through admission when it is sent with a stored credential of this agent directory:

- All chat dispatch through `stream`, `streamSimple`, `complete` and `completeSimple` in any thread: main and subagent turns, `/btw` and IRC side turns, handoff, local compaction, branch summary, advisors, cache-warm replays, autolearn capture, titles, commit inference, prompted judges and classifiers, memories, mnemopi extract, speech enhancement, auto-repair, eval completions, image questions, skill-description compression, annotate summary, and custom extension APIs dispatched by pi-ai.
- All `withAuth` sends: native judgment, remote compaction (V1, V2 and endpoint), images, speech, embeddings, transcription, rerank and video.
- All `withOAuthAccess` sends: web search and the live transport.
- Every credential rotation and loop-guard retry.

Not admitted:

- Bearers that are not stored credentials of this agent directory: environment, runtime and config keys, `auth: none` providers, and pi-native gateway bearers. The auth gateway builds its own storage and is not registered.
- API-key credential rows, such as coding plans. API-key selection records no bearer fingerprint, so these are not yet governed.
- Provider-internal transport retries inside one dispatch (`maxHttpAttempts`, `providerRetryWait`). They share the grant of the dispatch they belong to.
- Extension code that calls `fetch` outside pi-ai.
- Usage probes, token refresh, model discovery, and connection prewarm `HEAD` requests. They are not inference.
- Broker mode, where windows are `unknown` if the broker store supplies no local cache entries.

## Waits

A governor wait is not a provider block. It writes no `auth_credential_blocks` row and marks no account as reached, so the blocked-account redemption path cannot run because of a wait. A session shows a notice when one of its requests starts a wait of 5 seconds or more.

## Unknown, stale and degraded states

- `unknown`: there is no cached usage report for the account. It never holds a request, and the status shows it as unknown.
- `stale`: the cached snapshot is older than 15 minutes. It never holds a request either. Its last values are shown with their age.
- Degraded ledger: the shared ledger is busy past its timeout or hits an error. Admission is skipped for that request, so it is sent ungoverned. The status shows `degraded` with the reason, and the next admission retries after 30 seconds. The governor fails open. It never blocks a request because its own storage is unhealthy.

## Banked resets

Banked resets are rate-limit resets a provider has saved for an account. The status and the usage reports show how many there are, how many are redeemable, whether one is eligible now, and when the soonest expires. They are labelled "not counted".

The governor never counts a banked reset as allowance, never redeems one, and never changes credit or extra-usage settings. Existing reset behaviour, including any `autoRedeem` setting, is unchanged. To spend a reset, use `omp usage reset` or `/usage reset` as before.

## Limits

- The coverage is cooperative. Only processes on this machine, with this agent directory and the governor enabled, see each other's reservations. Other profiles, machines and applications appear only through the usage snapshots they produce.
- The governor paces against the cached snapshot. The provider's own state can be ahead of or behind that snapshot, and a snapshot is trusted for up to 15 minutes.
- The governor reads cached snapshots only. It never fetches usage, refreshes a token, reloads the credential pool, or contacts the provider to decide a wait.
- The governor adds no model routing. It cannot widen a role's fallback chain or choose a cheaper model.

## Reading the state

`/usage` and `omp usage` print a governor block after the provider sections:

- Ledger health: `ok`, `degraded` with the reason, or `closed`.
- For each account and window: the state (`open`, `paced`, `closed`, `stale` or `unknown`), used against allowed, the reserve, the reset time, how old the snapshot is, pending and in-flight request counts, the calibrated cost per request or `uncalibrated`, and the next admissible time.
- Banked resets, labelled "not counted".
- Recent waits: role, source, session, account, binding window, used against allowed, and the duration of the wait.

`omp usage --json` adds a `governor` key with the same fields. It is `null` while the governor is off. Each banked-reset object carries `countedAs: "not counted"`, and each wait carries `durationMs`. `--redact` replaces account labels and any identity text in the output with masks, in both the text and the JSON.

## Forecast, not guarantee

Pacing uses the cached view and a linear line. A burst of requests from another application, a provider-side change in the window, or a snapshot that lags behind real usage can all put an account past its allowance even when the governor admitted every request. Use the governor to smooth demand across this machine's processes. Do not rely on it to stop a provider limit from being hit.
