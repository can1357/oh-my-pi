# Usage governor

The usage governor paces eligible paid quota across the agent processes on one machine. It is off by default. When `usageGovernor.enabled` is `true`, eligible requests using a stored credential of this agent directory are checked against cached usage windows. If sending now would take the account past its allowance line, the request waits until the line catches up, the observation becomes stale, or the governor is disabled. Waits can also be aborted.

The governor is a forecast built from cached data. It does not guarantee that a request succeeds, that a provider limit is never reached, or that a wait ends before a reset.

## Settings

| Key                                | Type                 | Default | Meaning                                                                                                                  |
| ---------------------------------- | -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `usageGovernor.enabled`            | boolean              | `false` | Turns admission and governed account ranking on. Off creates no ledger file and leaves the dispatch path unchanged.     |
| `usageGovernor.leadPct`            | number, 0 to 100     | `25`    | Share of a window's allowance usable ahead of linear pacing at the window start. It decays to 0 at reset.                |
| `usageGovernor.interactiveReserve` | `hold` or `spend`    | `hold`  | Whether foreground requests may use the account reserve. See [Interactive reserve](#interactive-reserve-hold-or-spend). |
| `usageGovernor.roleProtection` | `off` or `prefer-alternatives` | `prefer-alternatives` | Prefer independent included allowances when another role has fewer verified open alternatives. |

Two existing settings also shape the governor:

- `retry.usageReservePct` (default `10`) is the reserve target for every account, and the governor's reset target.
- `auth.accountPolicies[].reservePct` overrides that target for one account.

See [settings](./settings.md#usage-governor) for the same keys in the settings reference.

## How a request is paced

For each applicable window of the account a request would use:

- Only windows with a finite, current reset time are paced. Windowless limits such as credits or extra usage, and rolling windows, are not paced.
- The reserve `r` is the account's reset target as a fraction. With `interactiveReserve: spend` and a request a person is waiting on, `r` is 0.
- The allowance line `A` is `(1 - r) * (lead + (1 - lead) * x)`, where `x` is the elapsed share of the window. It starts at `lead` and reaches `1 - r` at reset. When the window length is unknown, `A` is `1 - r`.
- The need is `u + (p + 1) * c`. `u` is the used fraction in the cached snapshot. `p` counts reservations not yet reflected in that snapshot, including live in-flight requests, across processes on this machine. `c` is the calibrated cost per request, `0` until calibrated.
- If the snapshot is exhausted or the need is above `1 - r`, the window is `closed` until its reset.
- If the need is at or below `A`, the window is `open`.
- Otherwise the window is `paced` until the line reaches the need, and the request waits.

The request is admissible at the latest time across its windows. That window is the binding one. Every overlapping window is enforced.

The cost per request `c` is the usage growth observed across the reservations made in one window generation. It is used when at least three reservations fall between the first and last observation and usage grew across them. Otherwise the last value for the same quota from an earlier generation applies, and with none, the window reads `uncalibrated`. Consumption by other machines and applications raises the cost, which makes pacing more conservative.

The governor never generates work to consume quota. A request is never sent early to fill a window.

## Account routing

The governor evaluates eligible accounts and configured fallback targets using cached evidence. It prefers verified open included allowances; it does not compare paced accounts by their admissible time. With `roleProtection: prefer-alternatives`, it can favor an independent open allowance for a flexible role when another role depends on the shared allowance. Set it to `off` to disable that preference. Protection is a preference, not a reservation or a guarantee.

When enabled, governed fallback can select a model and account within the requesting role's authorized configured chain, subject to the enabled-model and disabled-provider settings. It does not widen that chain. Explicit model requests remain bounded by their own authorized targets. Unknown routes do not attract proactive switching. Existing `retry.usageAwareFallback` settings continue to apply independently of the governor.

## Interactive reserve: hold or spend

- `hold` (default): every request keeps the reserve. An interactive turn that cannot be sent waits until it is admissible, and the wait can be aborted. Governed routing may choose an eligible alternative within the authorized chain.
- `spend`: a request a person is waiting on in the foreground may use the reserve. Background and subagent requests keep it.

## Coverage

Stored API keys are not categorically excluded: an eligible key can be paced when its identity, provider, endpoint, model and cached quota evidence can be matched. Keys without that evidence fail open.

These paths enter admission when the governor is enabled and the request has a matching stored credential. A path entering admission does not mean its provider or account has a usable quota window:

- All chat dispatch through `stream`, `streamSimple`, `complete` and `completeSimple` in any thread: main and subagent turns, `/btw` and IRC side turns, handoff, local compaction, branch summary, advisors, cache-warm replays, autolearn capture, titles, commit inference, prompted judges and classifiers, memories, mnemopi extract, speech enhancement, auto-repair, eval completions, image questions, skill-description compression, annotate summary, and custom extension APIs dispatched by pi-ai.
- All `withAuth` sends: native judgment, remote compaction (V1, V2 and endpoint), images, speech, embeddings, transcription, rerank and video.
- All `withOAuthAccess` sends: web search and the live transport.
- Every credential rotation and loop-guard retry.

Not admitted:

- Bearers that are not stored credentials of this agent directory: environment, runtime and config keys, `auth: none` providers, and pi-native gateway bearers. The auth gateway builds its own storage and is not registered.
- Provider-internal transport retries inside one dispatch (`maxHttpAttempts`, `providerRetryWait`). They share the grant of the dispatch they belong to.
- Extension code that calls `fetch` outside pi-ai.
- Usage probes, token refresh, model discovery, and connection prewarm `HEAD` requests. They are not inference.
- Broker mode, where windows are `unknown` if the broker store supplies no local cache entries.

## Waits

A governor wait is not a provider block. It writes no `auth_credential_blocks` row and marks no account as reached, so the blocked-account redemption path cannot run because of a wait. A session shows a notice when one of its requests starts a wait of 5 seconds or more.

## Unknown, stale and degraded states

- `unknown`: required identity, provider eligibility, model or cached usage evidence is missing or cannot be verified. An explicit request is not held on that basis, but an unknown route is not a proactive switching target.
- `stale`: the cached snapshot is older than 15 minutes. It does not hold an explicit request. A bound route requiring verified allowance is rejected unsent when its evidence expires. The governor does not refresh usage itself: an external refresh can extend a wait, but a headless session without refreshed observations eventually releases an unbound wait.
- Degraded ledger: the shared ledger is busy past its timeout or hits an error. Admission is skipped for that request, so it is sent ungoverned. The status shows `degraded` with the reason, and the next admission retries after 30 seconds. The governor fails open. It never blocks a request because its own storage is unhealthy.

## Banked resets

Banked resets are rate-limit resets a provider has saved for an account. Status and usage reports show available reset information labelled "not counted". For otherwise comparable eligible routes, fresh evidence of an eligible usable reset that clears all applicable limits and has a future expiry can be used as a routing tie-break.

The governor never counts a banked reset as allowance, never redeems one, and never changes credit or extra-usage settings. Routing does not authorize new spending or redemption. Existing reset behaviour, including any `autoRedeem` setting, is unchanged. To spend a reset, use `omp usage reset` or `/usage reset` as before.

## Limits

- The coverage is cooperative. Only processes on this machine, with this agent directory and the governor enabled, see each other's reservations. Other profiles, machines and applications appear only through the usage snapshots they produce.
- The built-in governed allowance adapter covers OpenAI Codex OAuth only, and requires cached evidence that paid overage is disabled. Z.AI and other providers can have matching stored credentials paced against fresh applicable windows, but their allowance is unknown for proactive routing and role protection unless an adapter verifies it.
- Routing uses cached reports, not a fresh network probe. It requires a matching stored credential and identity, an applicable model and endpoint, and all required limit observations to be current and no older than 15 minutes. Broker mode without local cache entries cannot establish those facts.
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
