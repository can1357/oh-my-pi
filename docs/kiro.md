# Kiro

Kiro is a native provider backed by the Kiro API (`kiro-api`). It is built into OMP rather than supplied by an extension. The legacy `omp-provider-kiro` extension is no longer needed: its `baseUrl` and header overrides still apply, but a registration that brings its own transport or login is ignored with a warning naming the extension.

For general credential precedence and provider configuration, see [Providers](./providers.md).

## Quick start

1. Run `/login kiro`.
2. Choose **Identity Center** for an AWS organization, **Builder ID** for a personal free account, **API key** for a `ksk_...` key, or **Google** / **GitHub** to sign in with that account.
3. After authentication, choose a `kiro/<model-id>` model from the discovered catalog.

Kiro login uses replacement semantics. Logging in again replaces every stored Kiro credential, OAuth logins and stored API keys alike, with the newly selected account or key. See [Several Kiro accounts](#several-kiro-accounts) for the only ways more than one can be stored.

## AWS IAM Identity Center device login

Choose **Identity Center** in the Kiro login method selector. OMP asks for:

- **Start URL** — the AWS access portal URL, for example `https://company.awsapps.com/start`.
- **OIDC region** — the AWS IAM Identity Center/OIDC region for that portal.

The Start URL must be an HTTPS `*.awsapps.com/start` URL without a port, query string, fragment, username, or password. The region must be a valid AWS region.

OMP registers a public Kiro client for the selected OIDC region, requests a device code, displays the verification URL and one-time user code, and waits for browser approval. When more than one Kiro profile is available, the login dialog presents a profile selector. The terminal shows a profile name or a region-based fallback, never the full profile ARN or AWS account number.

The selected profile determines the Kiro runtime route. Its profile identity, registered client metadata, and validated token endpoint are stored with the OAuth credential. If a registration response omits `tokenEndpoint` or returns it as `null`, OMP uses and persists the validated canonical regional endpoint `https://oidc.<region>.amazonaws.com/token`; a returned non-null endpoint is preserved only after the same validation.

OMP registers a fresh public client on every login rather than reusing an earlier registration. Each login also gets its own login id, which survives token refresh, scopes the model cache to that login, and is the login's account identity (see [Several Kiro accounts](#several-kiro-accounts)).

When a refresh is rejected with `invalid_grant` or `expired_token`, or the stored refresh state can no longer work (the registered client expired, or the client binding is missing or invalid), the grant cannot recover: OMP disables the stored credential and asks you to run `/login kiro` again. Other refresh failures are treated as transient and retried later.

## Google and GitHub sign-in

Choose **Google** or **GitHub** in the Kiro login method selector. OMP starts Kiro's device sign-in, shows a link to `app.kiro.dev` and a one-time code, and waits while you approve the code and sign in with that account in a browser. No local callback server is involved, so this also works over SSH or on a headless machine.

A Google or GitHub account needs a Kiro profile to send requests. OMP uses the profile Kiro returns at sign-in; when it returns none, OMP offers the profiles the account can list (asking you to choose if there is more than one), and an account that lists none uses the default profile Kiro assigns Google and GitHub users. Requests and model discovery route to that profile's region. Each sign-in gets its own login id, so two Google or GitHub accounts on the same profile keep separate model caches.

The session refreshes through Kiro's auth service, which may also move the account to another profile; OMP follows it. When Kiro rejects the refresh token (`Bad credentials` or an invalid request), OMP disables the stored credential and asks you to run `/login kiro` again; rate limits, server errors, and network failures are retried later.

## Kiro API-key login

Choose **API key** and paste the Kiro API key. Keys must use the `ksk_...` format; surrounding quotes and control characters are removed before validation. OMP validates the key against the Kiro model-management route and stores the key together with its resolved runtime endpoint.

Set `KIRO_API_REGION` when the key's AWS region is known:

```sh
export KIRO_API_KEY=ksk_...
export KIRO_API_REGION=us-east-1
```

`KIRO_API_KEY` is the environment fallback for the provider. `KIRO_API_REGION` pins an API key without a stored endpoint (such as `KIRO_API_KEY`) to that region for both model discovery and requests, with no probing of other regions. Without it, OMP probes the bootstrap regions (`us-east-1`, `eu-central-1`) and uses the key only when exactly one accepts it; set it when that probe is ambiguous or the key is tied to another region. An invalid region is an error rather than a silent fallback.

## Profile selection and model discovery

Model discovery is credential-scoped:

- AWS OAuth discovery uses the selected profile and its runtime region; Google and GitHub sign-in uses the account's resolved profile the same way.
- API-key discovery uses the key's resolved runtime endpoint, or `KIRO_API_REGION`.
- Discovery follows every page of the model and profile listings.
- Cached models are restored only after the selected Kiro credential is known.

The roster is never bundled into OMP's model catalog, because it depends on the signed-in account. Kiro defaults to `auto` when no explicit model is selected; online discovery replaces the catalog with the account's live models. The model cache is scoped per login for Identity Center, Builder ID, Google, and GitHub, and per key and endpoint for API keys, so one login's cache is never reused for another. A model whose metadata cannot be read is skipped without hiding the rest of the roster; a model whose request schema is not recognised is listed without thinking controls. If models disappear after switching accounts, log in again and allow discovery to complete.

## Builder ID

**Builder ID** signs in with a personal AWS Builder ID instead of an IAM Identity Center organization. It runs the same OIDC device grant, pinned to the public Builder portal (`https://view.awsapps.com/start`) and `us-east-1`, so it asks for no Start URL, region, or profile.

Because a Builder ID has no organization, the stored credential carries no profile ARN and the service infers the profile from the bearer token. The runtime region comes from the login region. Model discovery behaves the same as for Identity Center, and the model cache is scoped to the login, so two Builder ID accounts in the same region keep separate caches, including after their tokens expire.

Choose **Identity Center** when you sign in through an IAM Identity Center Start URL, **Google** or **GitHub** for a Kiro account signed in with one of those, and **API key** when you have a `ksk_…` key.

## Logout and re-login

Use `/logout` and select Kiro. Logging out removes the stored Kiro credentials; it does not remove an environment-provided `KIRO_API_KEY` or another configured credential source.

Run `/login kiro` again when:

- the registered client or OAuth refresh state has expired, or Kiro rejected a Google/GitHub refresh token;
- the AWS profile, Start URL, or OIDC region has changed;
- model discovery is using the wrong profile or endpoint; or
- a present registration endpoint fails validation.

## Transient request failures

A Kiro request is retried at most once, with an identical request body and a fresh request id, and only before any output has been shown, for exactly these failures:

- A `ThrottlingError` whose `reason` is `INSUFFICIENT_MODEL_CAPACITY`, the runtime's capacity rejection, whether it arrives as an HTTP error or as an exception frame before any output.
- `HTTP 400 ValidationException: Invalid tool use format.`, which the runtime fleet occasionally returns for a fresh remote session's first request. Replaying the same payload succeeds.
- An event-stream frame cut off before any output, unless the service already sent its billing (`meteringEvent`) frame for the request.

A request the service has billed is never replayed. Any other failure, including another HTTP 400 or a stream that ends without output, is terminal and is reported as-is.

## Request identity

OMP sends every Kiro request — chat, model and profile discovery, AWS sign-in, and Google/GitHub sign-in — with the same headers and service targets as the official Kiro CLI 3.2.0. The one intentional difference is `x-amzn-codewhisperer-optout: true`: OMP opts out of sharing content with AWS, where the CLI opts in by default.

## Usage and truncation

Token usage comes only from the token metrics Kiro sends (including `metadataEvent.tokenUsage`); when it sends none, usage is reported as zero rather than estimated. Kiro's `contextUsageEvent` percentage is reported as the context size, scaled to the model's context window. When a response is cut off at the output limit (`MAX_TOKENS`), it stops with `length` and any tool call whose arguments were cut off is dropped, so it never runs. A response Kiro's content filter stops (`CONTENT_FILTERED`) is reported as a refusal with the service's category and explanation and is not retried.

The normal size of a tool result is governed by OMP's tool output limit (`tools.artifactSpillThreshold`: larger output spills to an `artifact://` with a head and tail inline); the Kiro provider only adds a safety cap at Kiro's service limit of 800,000 UTF-8 bytes per result, cutting a longer result and ending it with a marker telling the model how much was omitted. When a request would exceed its budget (850,000 bytes per 200,000 tokens of context window), historical tool results are shrunk to 25,000 bytes oldest first until it fits, then current-turn results, which are never cut below 25,000 bytes. A request that still does not fit is reported as a context overflow, so OMP compacts the conversation.

## Credits in `/usage`

`/usage` and `omp usage` show each Kiro login's monthly plan credits (for example **Kiro Pro credits**) with the reset date, each active bonus grant such as trial credits with its expiry, and, when overage billing is on, overage credits used against the cap with the charges so far. A plan with no credits left shows as exhausted only when no bonus credits remain and overage is off; otherwise it is a warning. OMP never enables overage: it spends overage only when you enabled it in your Kiro account. An API key gets a report only when the key has a stored endpoint (or `KIRO_API_REGION` is set) and the service answers for it.

With `retry.usageAwareFallback` on, the pre-turn check measures stored Kiro logins and `/login kiro` API keys by their free credits (plan plus active bonus): an account that can only draw paid overage counts as inside the reserve (`retry.usageReservePct`), and one with no free credits and no overage left as depleted, so `retry.usageReservePolicy` decides whether to move to a fallback model. `KIRO_API_KEY` from the environment is never measured, so the check leaves it alone.

## Several Kiro accounts

`/login kiro` keeps one Kiro credential, also when the store is an [auth broker](./auth-broker-gateway.md): a login from a broker client replaces every Kiro credential that client can see. `KIRO_API_KEY` is not a second account; a stored Kiro credential always wins over it. Several Kiro accounts exist only on a broker that received them as uploads, such as `omp auth-broker migrate --from-local --include-oauth` run on several machines that each signed in once.

No Kiro sign-in returns an account id or email, so each Identity Center, Builder ID, Google, or GitHub login is identified by its login id: its identity key is `account:<login id>`, and `omp usage accounts` lists it. The id is random, never contains the AWS account number, and survives token refresh and `migrate`, so re-running `migrate` on the same machine skips a login the broker already holds instead of storing it twice. Logging in again creates a new login id, and with it a new account. A `ksk_…` API key has no identity key.

With several accounts, requests prefer one with free credits (plan or bonus) left; an account that can only draw paid overage yields to any account with free credits but still serves when it is the only one, so overage is spent only after the free credits on every Kiro account are used.

Account selection names a Kiro login like any other OAuth account:

- `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` `accounts` lists, `task.agentAccountPools`, and gateway client `accounts` take its identity key (`account:<login id>`).
- `auth.accountPolicies` match it with `account: { accountId: "<login id>" }`.
- `omp token kiro --list` numbers the stored logins (by login id, followed by the profile name when the login has one). `omp bench --account <n>` benchmarks that login; `omp token kiro --account <n>` prints its access token, and with `--raw` the full Kiro credential the transport sends.

## Troubleshooting

### `Invalid AWS access portal URL`

Use the Start URL copied from IAM Identity Center. It must be an HTTPS `*.awsapps.com/start` URL with no query, fragment, port, username, or password.

### `Kiro API key did not resolve to exactly one route`

Set `KIRO_API_REGION` to the region that issued the key, then run `/login kiro` again and choose **API key**. A region is also required when the key is valid in a route that cannot be discovered from the bootstrap probes.

### `Kiro returned an invalid tokenEndpoint`

A present registration endpoint must be the HTTPS regional AWS OIDC token endpoint with no query, fragment, port, or credentials. OMP uses the canonical regional endpoint only when the registration response omits the property. Re-run `/login kiro` after correcting a stale or invalid cached registration.

### No Kiro models after login

Confirm that the selected model is under the `kiro` provider, wait for online discovery, and verify that the selected AWS profile or API-key region is correct. Log in again after changing profiles or regions.

### Builder login does not start

Builder ID requires a browser sign-in at the Builder portal. If the flow never starts, re-run `/login kiro` and confirm the device code page opens, then check whether a network policy blocks `oidc.us-east-1.amazonaws.com`.
