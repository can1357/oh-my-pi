# Kiro

Kiro is a native provider backed by the Kiro API (`kiro-api`). For general credential precedence and provider configuration, see [Providers](./providers.md); for transport details, see [Provider quirks](./provider-quirks.md#kiro).

## Quick start

1. Run `/login kiro`.
2. Choose **Identity Center** for an AWS organization, **Builder ID** for a personal AWS Builder ID, **API key** for a `ksk_…` key, or **Google** / **GitHub** to sign in with that account.
3. Choose a `kiro/<model-id>` model from the discovered catalog.

## Login methods

**Identity Center** runs an AWS IAM Identity Center device login. OMP asks for the **Start URL** (an HTTPS `*.awsapps.com/start` portal URL, for example `https://company.awsapps.com/start`) and the **OIDC region**, shows a verification URL and one-time code, and waits for browser approval. When several Kiro profiles are available, you pick one; the selected profile decides the region requests and discovery use.

**Builder ID** signs in with a personal AWS Builder ID through the same device flow, pinned to the public Builder portal and `us-east-1`, so it asks for nothing.

**Google** and **GitHub** use Kiro's device sign-in: OMP shows a link to `app.kiro.dev` and a one-time code, and you approve it in a browser. No local callback server is involved, so this works over SSH or on a headless machine.

**API key** takes a `ksk_…` key, validates it, and stores it with its resolved endpoint. `KIRO_API_KEY` is the environment fallback. Set `KIRO_API_REGION` when the key's region is known:

```sh
export KIRO_API_KEY=ksk_...
export KIRO_API_REGION=us-east-1
```

`KIRO_API_REGION` pins an API key without a stored endpoint (such as `KIRO_API_KEY`) to that region for model discovery and requests. Without it, OMP probes the bootstrap regions `us-east-1` and `eu-central-1` and uses the key only when exactly one accepts it. An invalid region is an error.

## Models and discovery

The model roster is discovered per credential and never bundled into OMP's catalog, because it depends on the signed-in account. Kiro defaults to `auto` until you pick a model. The model cache is scoped per login for Identity Center, Builder ID, Google, and GitHub, and per key and endpoint for API keys, so one account's roster is never reused for another.

## Accounts and usage

Each `/login kiro` adds an account, like every other provider, so logging the same person in again adds a second entry; remove the old one with `/logout`.

Each OAuth login gets a random login id, and its identity key is `account:<login id>`. Use that key in account pools, or match it in `auth.accountPolicies` with `account: { accountId: "<login id>" }`. A `ksk_…` API key has no identity key.

`/usage` shows each account's monthly plan credits with the reset date, active bonus credits with their expiry, and overage credits when overage billing is enabled in your Kiro account. With several accounts, requests prefer accounts with free credits left; accounts that can only draw overage are used last.

## Logout and re-login

Use `/logout` and select Kiro to remove stored Kiro credentials. It does not remove an environment-provided `KIRO_API_KEY`.

When a refresh fails in a way that cannot recover (`invalid_grant`, `expired_token`, an expired registered client, a missing client binding, or `Bad credentials` for Google/GitHub), OMP disables the stored credential and asks you to run `/login kiro` again. Other refresh failures are retried. Also log in again after your AWS profile, Start URL, or OIDC region changes.

## Troubleshooting

### `Invalid AWS access portal URL`

Use the Start URL copied from IAM Identity Center. It must be an HTTPS `*.awsapps.com/start` URL with no query, fragment, port, username, or password.

### `Kiro API key did not resolve to exactly one route`

Set `KIRO_API_REGION` to the region that issued the key, then run `/login kiro` again and choose **API key**.

### `Kiro returned an invalid tokenEndpoint`

The registration response named a token endpoint that is not the HTTPS regional AWS OIDC endpoint. Run `/login kiro` again.

### No Kiro models after login

Check that the selected model is under the `kiro` provider, wait for online discovery, and verify the selected AWS profile or API-key region.

### Builder ID login does not start

Confirm the device code page opens in a browser, then check whether a network policy blocks `oidc.us-east-1.amazonaws.com`.
