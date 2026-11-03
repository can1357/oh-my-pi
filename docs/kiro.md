# Kiro

Kiro is a native provider backed by the Kiro API (`kiro-api`). It is built into OMP rather than supplied by an extension. Do not enable the legacy `omp-provider-kiro` extension alongside the native provider: the native `kiro` provider and `kiro-api` transport reject shadow registrations.

For general credential precedence and provider configuration, see [Providers](./providers.md).

## Quick start

1. Run `/login kiro`.
2. Choose **Identity Center** for an AWS organization, **Builder ID** for a personal free account, or **API key** for a `ksk_...` key.
3. After authentication, choose a `kiro/<model-id>` model from the discovered catalog.

Kiro login uses replacement semantics. Logging in again replaces the stored Kiro credential with the newly selected account or key.

## AWS IAM Identity Center device login

Choose **Identity Center** in the Kiro login method selector. OMP asks for:

- **Start URL** — the AWS access portal URL, for example `https://company.awsapps.com/start`.
- **OIDC region** — the AWS IAM Identity Center/OIDC region for that portal.

The Start URL must be an HTTPS `*.awsapps.com/start` URL without a port, query string, fragment, username, or password. The region must be a valid AWS region.

OMP registers a public Kiro client for the selected OIDC region, requests a device code, displays the verification URL and one-time user code, and waits for browser approval. When more than one Kiro profile is available, the login dialog presents a profile selector. The terminal shows a profile name or a region-based fallback, never the full profile ARN or AWS account number.

The selected profile determines the Kiro runtime route. Its profile identity, registered client metadata, and validated token endpoint are stored with the OAuth credential. If a registration response omits `tokenEndpoint` or returns it as `null`, OMP uses and persists the validated canonical regional endpoint `https://oidc.<region>.amazonaws.com/token`; a returned non-null endpoint is preserved only after the same validation.

OMP registers a fresh public client on every login rather than reusing an earlier registration. Each login also gets its own login id, which survives token refresh and scopes the model cache to that login.

When a refresh is rejected with `invalid_grant` or `expired_token`, the grant cannot recover: OMP disables the stored credential and asks you to run `/login kiro` again. Other refresh failures are treated as transient and retried later.

## Kiro API-key login

Choose **API** and paste the Kiro API key. Keys must use the `ksk_...` format; surrounding quotes and control characters are removed before validation. OMP validates the key against the Kiro model-management route and stores the key together with its resolved runtime endpoint.

Set `KIRO_API_REGION` when the key's AWS region is known:

```sh
export KIRO_API_KEY=ksk_...
export KIRO_API_REGION=us-east-1
```

`KIRO_API_KEY` is the environment fallback for the provider. `KIRO_API_REGION` pins an API key without a stored endpoint (such as `KIRO_API_KEY`) to that region for both model discovery and requests, with no probing of other regions. Without it, OMP probes the bootstrap regions and uses the key only when exactly one accepts it; set it when that probe is ambiguous or the key is tied to another region. An invalid region is an error rather than a silent fallback.

## Profile selection and model discovery

Model discovery is credential-scoped:

- AWS OAuth discovery uses the selected profile and its runtime region.
- API-key discovery uses the key's resolved runtime endpoint, or `KIRO_API_REGION`.
- Discovery follows every page of the model and profile listings.
- Cached models are restored only after the selected Kiro credential is known.

The roster is never bundled into OMP's model catalog, because it depends on the signed-in account. Kiro defaults to `auto` when no explicit model is selected; online discovery replaces the catalog with the account's live models. The model cache is scoped per login for Identity Center and Builder ID, and per key and endpoint for API keys, so one login's cache is never reused for another. A model whose metadata cannot be read is skipped without hiding the rest of the roster; a model whose request schema is not recognised is listed without thinking controls. If models disappear after switching accounts, log in again and allow discovery to complete.

## Builder ID

**Builder** signs in with a personal AWS Builder ID instead of an IAM Identity Center organization. It runs the same OIDC device grant, pinned to the public Builder portal (`https://view.awsapps.com/start`) and `us-east-1`, so it asks for no Start URL, region, or profile.

Because a Builder ID has no organization, the stored credential carries no profile ARN and the service infers the profile from the bearer token. The runtime region comes from the login region. Model discovery behaves the same as for Identity Center, and the model cache is scoped to the login, so two Builder ID accounts in the same region keep separate caches, including after their tokens expire.

Choose **Identity Center** when you sign in through an IAM Identity Center Start URL, and **API key** when you have a `ksk_…` key.

## Logout and re-login

Use `/logout` and select Kiro. Logging out removes the stored Kiro credential; it does not remove an environment-provided `KIRO_API_KEY` or another configured credential source.

Run `/login kiro` again when:

- the registered client or OAuth refresh state has expired;
- the AWS profile, Start URL, or OIDC region has changed;
- model discovery is using the wrong profile or endpoint; or
- a present registration endpoint fails validation.

## Transient request failures

A Kiro request is retried at most once, with an identical request body and a fresh request id, and only before any output has been shown, for exactly these failures:

- `InsufficientModelCapacity`, the runtime's capacity rejection.
- `HTTP 400 ValidationException: Invalid tool use format.`, which the runtime fleet occasionally returns for a fresh remote session's first request. Replaying the same payload succeeds.
- An event-stream frame cut off before any output, unless the service already sent its billing (`meteringEvent`) frame for the request.

A request the service has billed is never replayed. Any other failure, including another HTTP 400 or a stream that ends without output, is terminal and is reported as-is.

## Usage and truncation

Token usage comes only from the token metrics Kiro sends; when it sends none, usage is reported as zero rather than estimated. When a response is cut off at the output limit (`MAX_TOKENS`), it stops with `length` and any tool call whose arguments were cut off is dropped, so it never runs.

## Troubleshooting

### `Invalid AWS access portal URL`

Use the Start URL copied from IAM Identity Center. It must be an HTTPS `*.awsapps.com/start` URL with no query, fragment, port, username, or password.

### `Kiro API key did not resolve to exactly one route`

Set `KIRO_API_REGION` to the region that issued the key, then run `/login kiro` again and choose API. A region is also required when the key is valid in a route that cannot be discovered from the bootstrap probes.

### `Kiro response has an invalid tokenEndpoint`

A present registration endpoint must be the HTTPS regional AWS OIDC token endpoint with no query, fragment, port, or credentials. OMP uses the canonical regional endpoint only when the registration response omits the property. Re-run `/login kiro` after correcting a stale or invalid cached registration.

### No Kiro models after login

Confirm that the selected model is under the `kiro` provider, wait for online discovery, and verify that the selected AWS profile or API-key region is correct. Log in again after changing profiles or regions.

### Builder login does not start

Builder ID requires a browser sign-in at the Builder portal. If the flow never starts, re-run `/login kiro` and confirm the device code page opens, then check whether a network policy blocks `oidc.us-east-1.amazonaws.com`.
