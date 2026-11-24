# 0059. Provider catalog additions and sign-in flows

Status: Proposed 2026-11-13
Date: 2026-11-13
Area: ai

## Context

Research: [`docs/research/providers-signin.md`](../research/providers-signin.md) (Gap 15). Upstream is pinned at `c308970263` (v18.20.0), at `/Users/enverfrancisco/repositories/omp-work/upstream`. Every upstream citation below was re-checked at that pin on 2026-11-13. Paths prefixed `upstream:` are in that tree. Shorthand `registry/…` means upstream `packages/ai/src/registry/…`, and `rules/…` means upstream `packages/catalog/src/compat/rules/…`. Other paths are in omp2 at `ed95a14a41`.

- **The provider diff is exact.** Upstream's generated `KnownProvider` list has 94 ids (`upstream:packages/catalog/src/compat/provider-ids.ts`). omp2's `fixtures/llm-oracle/catalog/providers.toml` has 119 `[providers."…"]` entries. 80 ids are shared, 14 exist only upstream, and 39 exist only in omp2 (search engines, aliases and additions, not reviewed here).
- **Five entries in the brief are already present.** DeepInfra, SiliconFlow (and `siliconflow-cn`), LiteLLM, GitLab Duo agent and Qwen portal are shared ids. They need no work.
- **Of the 14 upstream-only ids, 11 are real gaps and 3 are not.**
  - `apple` is omp2's `apple-intelligence`, kept on purpose by ADR 0042 (`docs/adr/0042-apple-pcc-integration.md:18`).
  - `web` is upstream's group id for search engines. Engines are modelled one per provider in omp2, and ADR 0055 covers the missing ones.
  - `local` is not a gap. The on-device route is live under the `local` codec (`crates/ai/src/provider/builtin.rs:893`, `("local", CodecProfile::AppleFm)`; `crates/catalog/src/compile.rs:5926`), and the catalog row that serves it is `apple-intelligence`. See D7.
- **Wire protocols.** Five of the eleven real gaps are catalog data on an existing codec. Snowflake needs a per-account base URL that omp2 lacks as a generic mechanism. Factory Droid routes to four existing codecs but needs a provider hook. Four are System One *judgment* providers, a different operation from chat (see D5).
- **Per-account base URLs are per-provider code today.** Azure is hardcoded in `canonical_provider_base` (`crates/catalog/src/compile.rs:3136`) and in `azure_effective_route` (`crates/ai/src/provider/builtin.rs:1504`), fed by `production_azure_endpoint` (`crates/driver/src/registry.rs:1786`) from env vars `OMP_AZURE_OPENAI_BASE_URL`, `OMP_AZURE_OPENAI_RESOURCE_NAME` and others (`registry.rs:134-137`). Vertex and Bedrock fill `{location}` and `{region}` inside their own codecs (`crates/ai/src/codec/bedrock.rs:1355-1356`, `bedrock_mantle.rs:23`, `anthropic.rs:2316,2362`).
- **`cloudflare-ai-gateway` may already be broken.** Its base URL is `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic` (`fixtures/llm-oracle/catalog/providers.toml:749-751`). No code found in `crates/ai/src/{provider,auth}` or `crates/catalog/src` resolves the placeholders, so a request may send the literal `{account}` on the wire. This is not reproduced; S2's test covers it.
- **The stored credential has no slot for an account value.** `CredentialMetadata` (`crates/ai/src/auth/store.rs:55-66`) holds `account_id`, `principal_id`, `kind`, a generation counter and timestamps. The account value cannot come from there.
- **The user overlay can set a base URL on catalog ids.** `ProviderConfig.base_url` (`crates/driver/src/discovery/models.rs:90`) is lowered by `lower_user_overlay` (`models.rs:364`) for an existing catalog provider (`models.rs:392-410`) and for a user-added provider (`models.rs:436-458`). Self-hosted endpoints can therefore use the existing `models.toml` overlay, with no schema change. The catalog-id path has no test yet (S1).
- **The catalog schema has no env-based base-URL key.** `crates/catalog/src` has none. `auth` takes `env` names only.
- **Sign-in is data plus Rust modules.** Login flows are rows in `fixtures/llm-oracle/catalog/oauth.toml` with kinds `pkce`, `device-code` and `custom-exchange`, plus Rust modules in `crates/ai/src/auth/oauth/custom/` (`api_key.rs`, `devin.rs`, `gitlab.rs`, `openrouter.rs`, `perplexity.rs`, `zai.rs`, `cursor.rs`, `anthropic.rs`, `google_antigravity.rs`), `crates/ai/src/auth/alibaba_token_plan.rs` and `crates/ai/src/auth/github_copilot.rs`. Shared PKCE is `begin_pkce` (`crates/ai/src/auth/oauth.rs:265`).
- **Upstream sign-in flows.** Upstream has 106 files under `rules/auth/` (105 excluding the `_order.kdl` index), of which 14 are custom hooks. Eight flows are in scope across eight provider ids (D4). The Devin CLI adoption flow is not adopted (D6). The Cloudflare Workers AI flow is deferred with the judgment decision (D5).
- **Placement is decided by ADR 0049 class B, not by the class A test.** ADR 0049 D6 (`docs/adr/0049-tiered-integration-architecture.md:130`) lists class B as "Inference and search transports … `ai/src/auth/**` (OAuth flows, including `github_copilot`, `gitlab`, `devin`)". Sign-in flows therefore stay in core because class B names them. They are not vendor integrations of the class A kind.

**Constraints checked.** Additive only: new catalog rows, new `oauth.toml` rows, new `custom/*.rs` modules and new env vars; no existing provider id, schema key or flow changes. ADR 0049 D4: raw provider tokens stay in core, so no flow here hands a token to an extension. Deterministic first: no model is involved in sign-in or routing. ADR 0024 (latched roster): no new roster family; the judgment `OperationKind` (D5) would change the wire vocabulary, so it is deferred. ADR 0036: unaffected, no extension code.

## Decision

**D1. Five data-only providers, shipped with their fixed URLs.** Add `sambanova`, `coralbricks`, `helmcode`, `modular` and `otari` as `providers.toml` rows on existing codecs, then run `just catalog-snapshot`. `modular` uses `thinking-format "openrouter"`, a value documented in the compat README (`crates/catalog/compat/README.md:169`), so it needs no code. Each row is unselectable until its key is set. The roster is refreshed with `just catalog-import-v1`, which also fills `scaleway`'s empty seeded roster.
- **Self-hosted Otari** uses the existing `models.toml` overlay (`ProviderConfig.base_url`, `crates/driver/src/discovery/models.rs:90`): the user sets `baseUrl` on the `otari` provider id. No catalog schema change. S1 adds a test that the overlay applies to a catalog provider id.
- Records the criterion for curated rows: a provider gets a curated catalog row only when its public endpoint is stable. The five here have fixed public hosts in upstream's `rules/providers/*.kdl`. Any other provider, or any private deployment, is a `models.toml` overlay instead.

**D2. A generic account-scoped base URL, with env-var configuration.** One mechanism fills a declared `{account}` or `{gateway}` placeholder from an env var, validated the way `production_azure_endpoint` validates `OMP_AZURE_OPENAI_RESOURCE_NAME` (`registry.rs:1786-1804`): absent gives `None`, present and invalid gives a typed error, and nothing invalid reaches a URL. The account value is never stored in `CredentialMetadata`. The env vars are new names:
- `OMP_CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account id. Validated as ASCII alphanumeric or `-`. Used by `cloudflare-ai-gateway` and, later, `cloudflare-workers-ai`.
- `OMP_CLOUDFLARE_AI_GATEWAY_NAME`: the gateway name. Validated as ASCII alphanumeric or `-`.
- `OMP_SNOWFLAKE_ACCOUNT`: the Snowflake account, as an identifier or an `https://` URL. Validated to match upstream's rules in `upstream:packages/ai/src/registry/snowflake.ts:20-` (`normalizeSnowflakeAccountUrl`): non-empty, `https` only when a scheme is given, no backslash.
- Then the providers that need it:
  - `cloudflare-ai-gateway` starts working once both Cloudflare vars are set. Its missing-value case returns the typed error (see the possible defect in Context).
  - `snowflake` is added as data: default model `claude-opus-5-5`, per-model `api` of `anthropic-messages` at `<account>/api/v2/cortex` or `openai-completions` at `<account>/api/v2/cortex/v1` (`upstream:packages/catalog/src/compat/rules/providers/snowflake.kdl:13-18`, `:79`). The roster already carries per-model `api` and `baseUrl`.

**D3. Factory Droid as a provider hook over existing wires, gated on fixtures.** Upstream routes each model to `openai-completions` at `/api/llm/o/v1`, `openai-responses`, `anthropic-messages` at `/api/llm/a`, or google-generate at `/api/llm/g/v1` (`upstream:packages/catalog/src/wire/factory-droid.ts:16-24`, `:75-84`). omp2 has all four codecs. The hook goes in `crates/ai/src/codec/provider_hooks.rs`. It covers per-model wire choice, the regional host (`api.factory.ai` or `api.eu.factory.ai`), client headers and tool-name mapping. No new codec is added. The provider and its sign-in stay out of the snapshot until recorded fixtures exist (O1, O2).

**D4. Eight sign-in flows across eight provider ids, each on an existing mechanism.** Each is a `custom` module or an `oauth.toml` row, with no new core protocol. Placement: core, per ADR 0049 class B (see Context).

| Provider | Upstream flow (file) | omp2 mechanism |
|---|---|---|
| Mistral Vibe | Browser sign-in: `POST /api/vibe/sign-in` with a PKCE challenge, then poll, then `POST …/exchange` for a plain API key (`upstream:…/registry/oauth/mistral-vibe.ts:4-6`, `:21-26`) | New `custom/mistral_vibe.rs`, reusing `begin_pkce` |
| Snowflake | Account prompt, Snowflake OAuth with `LOCAL_APPLICATION`, PKCE, loopback port 54551, refresh (`registry/oauth/snowflake.ts:9`; `rules/auth/snowflake.kdl`) | New `custom/snowflake.rs` on the callback server (`crates/ai/src/auth/oauth/callback.rs`). Needs D2 |
| Kilo | Device authorisation (`registry/oauth/kilo.ts`) | `oauth.toml` `device-code` row |
| Muse Code | Device login, then a key minted at `https://api.meta.ai/muse-code/key` (`registry/oauth/muse-code.ts:9`) | New `custom/muse_code.rs` |
| Factory Droid | WorkOS device login, `/api/cli/whoami` and `/api/cli/org` (`registry/oauth/factory-droid.ts:8-10`, `:34-37`) | New `custom/factory_droid.rs`. Needs D3 and fixtures |
| Cloudflare AI Gateway | Collects gateway credential and account and gateway ids (`registry/oauth/cloudflare-ai-gateway.ts:5`) | Existing `custom/api_key.rs` with two extra fields, values from D2's env vars |
| Alibaba Coding Plan | Region choice (international or China base URL), key paste, optional proxy (`registry/oauth/alibaba-coding-plan.ts:5-8`) | Existing `auth/alibaba_token_plan.rs` pattern |
| Devin, Windsurf | Windsurf authorise page with PKCE and loopback, stored as a `devin` key (`registry/oauth/devin-windsurf.ts:1-5`) | Existing `custom/devin.rs` |

**D5. The judgment operation is deferred to its own ADR.** Four providers are System One judgment models, not chat: `cloudflare-workers-ai`, `liquid`, `nace` and `typesafe`. They need an operation omp2 does not have. `OperationKind` (`crates/catalog/src/capability.rs:95`) has `Chat`, `Embed`, `Search`, `Native`, `Extract` and so on, but no judge. Upstream's `packages/ai/src/judgment/systemone.ts` defines the body `{ model, state, questions }` and the per-vendor endpoints. The Cloudflare Workers AI sign-in ships with this decision, not with D4. This ADR does not add an `OperationKind` variant, and it does not add the four providers as chat entries.

**D6. The Devin CLI credential is not adopted.** Upstream's `registry/oauth/devin-cli.ts` adopts the seat key the Devin CLI keeps in `credentials.toml`. omp2 will not do this. Reasons:
1. It creates a second copy of a seat credential. The CLI's own logout does not remove that copy, so the copy outlives the session the user ended.
2. ADR 0049 D4 (`docs/adr/0049-tiered-integration-architecture.md:104`) says raw provider tokens stay in core. Adopting the file widens the set of raw seat tokens core holds, from one per login to one per adopted file.
3. The `credentials.toml` format is undocumented. It can change without notice, and the adoption would break silently.
4. No other flow in omp2 adopts another tool's credential file. `oauth.toml` and `crates/ai/src/auth/oauth/custom/` contain no such flow, so this would be a new pattern with no precedent to follow.
5. The CLI already owns login. The user runs the Devin CLI login once, and omp2 should defer to it.

omp2 uses the existing delegated ACP path instead. `crates/driver/src/delegated_acp.rs` `devin_profile` (`:175-183`) sets a login notice with method `_cognition.ai/agent_stopped` (`:96`) and cause `auth_required`, which `delegated_acp.rs:277-283` already asserts. When the Devin session needs login, that notice tells the user to run the Devin CLI login. No new code and no new flow.

**D7. The on-device route keeps `apple-intelligence` as its id.** The `local` codec is live (`crates/ai/src/provider/builtin.rs:893`), and the catalog row it serves is `apple-intelligence` (ADR 0042). Renaming the id to upstream's `local` would change a stable identifier for no behaviour gain. Recommendation: do not rename. Upstream's `local` catalog row (`upstream:…/rules/providers/local.kdl:7`, `api="local-inference"`, 14 models) is a separate thing from this route and is not adopted here.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Azure-style hardcoded resolver for each account provider | Repeats `canonical_provider_base` (`compile.rs:3136`) once per provider. D2 generalises it instead. |
| All five D1 providers as `models.toml` overlays only | The overlay works for private or unstable endpoints (D1). The five here have fixed public hosts, so they stay curated rows. |
| Add the judgment providers as chat entries | They would send chat requests to a decisions API, which is wrong on the wire. |
| New codec for Factory Droid | All four wires exist. A codec would duplicate them. |
| Adopt the Devin CLI credential (`devin-cli.ts`) | Rejected in D6: a second unrevocable seat copy, widens core's raw-token surface, undocumented file, no precedent, and the CLI already owns login. |
| Store the account value in the credential secret | The secret payload is opaque and the metadata has no field for it (`store.rs:55-66`). Mixing a host into the secret would make it unreadable without the secret. |
| One generic "custom" sign-in hook for all eight | Each flow has its own endpoints, state and failure modes. A shared hook would hide them. |
| Add `local` as a catalog id, renaming `apple-intelligence` | Rejected in D7. |

## Consequences

- Five providers can be selected once a key is set. Nothing changes for providers already present.
- D2 adds a mechanism that `cloudflare-ai-gateway` needs today, and that Snowflake and Cloudflare Workers AI will also need.
- Devin users are pointed at the Devin CLI login through the existing notice, not given a copy of its credential.
- Judgment remains unavailable until its own ADR.

## Review (EGM, 2026-11-13)

A fresh-context reviewer (design critic and zoom-out) reviewed the draft. Verdicts, and where each is applied:

1. **O1, otari self-hosted URL: settled.** No schema change. Self-hosted Otari uses the `models.toml` `baseUrl` overlay, and S1 tests that it applies to a catalog id. (D1)
2. **O2, account value source: settled.** Env vars validated like `production_azure_endpoint`, never `CredentialMetadata`. Names fixed in D2. The `cloudflare-ai-gateway` placeholders are a possible current defect, and S2 covers it. (D2, Context)
3. **O4, Devin CLI credential: decided.** Not adopted. S7 as first written is dropped. The existing delegated ACP login notice is used. Five reasons recorded in D6. ADR 0006 citation removed, since ADR 0006 does not govern credentials.
4. **O7, `local`: reworded and settled.** The on-device route is live under the `local` codec. The only question was renaming the id, and the recommendation is no. (D7)
5. **Placement: corrected.** Sign-in flows stay in core because ADR 0049 D6 class B names `ai/src/auth/**`, not because of the class A test. Factory Droid stays gated on fixtures. (Context, D3, D4)
6. **Zoom-out: applied.** User-defined `models.toml` providers already cover private endpoints. Curated rows are kept only for providers with stable public endpoints. (D1, Alternatives)
7. **Upstream re-verified.** The reviewer could not find upstream files. Every upstream citation in this ADR was re-checked at `/Users/enverfrancisco/repositories/omp-work/upstream` (`c308970263`) on 2026-11-13.

## Slices

Each slice is one PR. Catalog slices end with `just catalog-snapshot`. Gates are `just test-pkg omp-catalog` for data and `just test-pkg omp-ai` for code, then `just check-minimal-caps`.

| # | Slice | Ships behind | Acceptance and tests |
|---|---|---|---|
| S1 | Five data rows (D1), roster refresh, and the `models.toml` overlay test for a catalog provider id | Unselectable until a key is set | `omp-catalog` tests resolve each provider's env names, base URL, codec and default model. A test in `omp-driver` applies a `baseUrl` overlay to the `otari` catalog id and checks the route. The snapshot regenerates. |
| S2 | Account-scoped base URL (D2) with the three env vars, and `cloudflare-ai-gateway` as the first user | No change for other providers. A missing value fails with a typed error | Unit tests: placeholder filled from the env var; invalid value (for example a `/` or a space) returns the typed error; a missing value returns the typed error and never sends a literal `{account}`. The last test reproduces or rules out the possible defect in Context. |
| S3 | Mistral Vibe sign-in | `login` command only | Fixture test over the exchange: pending, `429` and `410` polls; a plain key is stored. No network in tests. |
| S4 | Kilo and Muse Code sign-ins (`device-code`) | `login` command only | Fixture tests for the device poll and, for Muse Code, the key mint. |
| S5 | Snowflake provider data and sign-in | Needs S2; dormant without `OMP_SNOWFLAKE_ACCOUNT` | Loopback callback test on port 54551; refresh test; the paste-code fallback is tested. Account validation matches D2. Per-model `api` routing test. |
| S6 | Alibaba Coding Plan and Devin Windsurf sign-ins | `login` command only | Region-to-base-URL test; Devin key stored as `devin`. |
| S7 | Factory Droid hook and sign-in (D3) | Absent from the snapshot until fixtures exist | Recorded fixtures under `fixtures/llm-oracle/agent-protocols/factory-droid/` for each wire. Replay tests per wire, plus the whoami and org flow. |
| — | Devin CLI adoption | Not built (D6) | None. The existing `delegated_acp.rs` notice test (`:277-283`) covers the path. |
| — | Judgment operation, the four judgment providers, and the Cloudflare Workers AI sign-in | Deferred to its own ADR | None in this ADR. |

## Upstream origin and license

Files a port draws behaviour from, all `upstream:` paths at `c308970263`, re-verified on 2026-11-13: `packages/catalog/src/compat/rules/providers/{sambanova,coralbricks,helmcode,modular,otari,snowflake,factory-droid,local}.kdl`, the matching `rules/auth/*.kdl`, `packages/ai/src/registry/oauth/*.ts` for the sign-in flows, `packages/ai/src/registry/snowflake.ts` for account normalisation, `packages/catalog/src/wire/factory-droid.ts`, and `packages/ai/src/judgment/systemone.ts`.

Licences. The root `LICENSE` is MIT, "Copyright (c) 2025 Mario Zechner" and "Copyright (c) 2025-2026 Can Bölük". `packages/catalog/LICENSE` is MIT with two copyright lines, "Copyright (c) 2025-2026 Can Bölük" and "Copyright (c) 2026 Stencil Labs, Inc." The catalog data is derived from upstream's `packages/catalog` rules, so the catalog package's notice is the one to carry. Record it in the root `THIRD-PARTY-NOTICES.txt` in the S1 PR.

## Open questions for the owner

- **O1.** Who records the Factory Droid fixtures, and from which account? Recommendation: the owner records them. No fixture means no snapshot entry, so the provider stays absent until then. omp2 has agent-protocol fixtures only for cursor, devin, gitlab and ollama.
- **O2.** Factory Droid's device login and org refresh call services that are not public. Recommendation: ship only after the S7 fixtures prove the flow. Do not infer endpoints from upstream beyond those fixtures.
- **O3.** Judgment operation: add an `OperationKind` variant, and do the four providers become judge routes? This needs its own ADR. ADR 0053 records the judge role as not started and may use it. Check against ADR 0024 (latched roster) before any variant is added, because a new variant changes the wire vocabulary. Whether `opencode-zen` and `commandcode` carry judge models is unverified.

## Acceptance tests

1. After S1, `omp-catalog` resolves all five providers with the expected env names, base URLs, codecs and default models, and an overlay `baseUrl` on `otari` takes effect.
2. After S2, a `cloudflare-ai-gateway` request with a missing or invalid `OMP_CLOUDFLARE_*` value fails with the typed error and never sends `{account}` or `{gateway}`.
3. Each sign-in in S3 to S6 completes against recorded or canned responses, with no live network in tests.
4. S7 is absent from the snapshot until its fixtures are committed.
5. `just check-minimal-caps` still passes, with no new `cap-*` feature.

## Status in omp

**Status: In progress. S1 and S2 landed; S3 to S7 are not started.** The `oauth.toml` kinds, the custom OAuth modules and the Azure env-var pattern exist in part.

**S2 (D2, account-scoped base URL; PR #693).**
- `cloudflare_effective_route` (`crates/ai/src/provider/builtin.rs`) is the only resolver for the `cloudflare-ai-gateway` provider. It fills `{account}`, `<account>`, `{gateway}` and `<gateway>` in the route's base URL from a validated `CloudflareGatewayConfig`, re-derives `trust_domain.origin` from the result, and refuses a URL that still contains `{`, `}`, `<` or `>` (`cloudflare-effective-endpoint-invalid`). Without a config the call fails with `cloudflare-gateway-not-configured` before any request is built, so a literal placeholder never reaches the wire. Every other provider returns `None` from this resolver and is unchanged.
- `production_cloudflare_gateway` and `cloudflare_gateway_from` (`crates/driver/src/registry.rs`) read `OMP_CLOUDFLARE_ACCOUNT_ID` and `OMP_CLOUDFLARE_AI_GATEWAY_NAME`. Both present and valid give a config. Either absent leaves the gateway unconfigured, so each call fails with the typed error instead of sending a placeholder. A present but invalid value is refused at startup, even when the other value is absent. `cloudflare_coordinate_is_valid` (`builtin.rs`) is the coordinate check. The values come from the environment, never from `CredentialMetadata`, as O2 settled.
- Tests: `cloudflare_gateway_route_fills_account_and_gateway_from_validated_config`, `cloudflare_gateway_without_config_fails_and_never_yields_a_placeholder_url`, `cloudflare_gateway_config_refuses_unsafe_coordinates` and `other_providers_are_untouched_by_the_cloudflare_resolver` in `builtin.rs`; `cloudflare_gateway_needs_both_values_and_refuses_invalid_ones` in `registry.rs`.
- Not done by S2: S5 (Snowflake) still needs this seam to carry the account coordinate for its own base URL; no second provider uses it yet.

**S1 (D1, data rows).**
- `fixtures/llm-oracle/catalog/providers.toml` has `sambanova`, `coralbricks`, `helmcode`, `modular` and `otari`, all `open-ai-chat` bearer routes, each unselectable until its key is set. Env names are `OMP_<ID>_API_KEY` then the vendor's own name (`SAMBANOVA_API_KEY`, `CORAL_API_KEY`, `HELMCODE_API_KEY`, `MODULAR_API_KEY`, `OTARI_API_KEY`). `CORALBRICKS_API_KEY` is not carried: upstream's own comment says the Coral pi extension introduced it.
- `crates/catalog/compat/providers/{sambanova,coralbricks,helmcode,modular}.kdl` carry the upstream cascade rules the omp axis table can express, and are listed in `BUNDLED_COMPAT` (`crates/catalog/src/cascade.rs`). Provider-wide dialects that rows found by runtime discovery need (Coral's `max_tokens`, no `developer` role, no `store`; Otari's no `developer` role) are in the `providers.toml` `compat` table, because a discovered row carries only the provider's own wire policy. `otari` has no KDL: it bundles no rows.
- The roster has rows for `sambanova` (1), `coralbricks` (2), `helmcode` (4), `modular` (5) and `scaleway` (12, previously empty). It was refreshed with `just catalog-import-v1 <models.json> sambanova,coralbricks,helmcode,modular,scaleway`. `scripts/import_v1_models.py` now also decodes pi's compact `version: 1` `models.json` (pi v18.20 no longer ships the provider-keyed map) and takes `--only` so a provider addition does not rewrite the other 5,300 rows. A whole-roster import at the pin changes rows in 70 providers and was not taken.
- `otari` declares no `default_model`: a default must name a bundled row (`snapshot.rs` invariant) and upstream bundles none (its default is a placeholder).
- `crates/catalog/NOTICE` and the root `THIRD-PARTY-NOTICES.txt` carry the upstream catalog licence notice.
- Tests: `adr_0059_*` in `crates/catalog/tests/catalog_conformance.rs` (env names, host, codec, default model, key gating, dialect), the roster check in `crates/catalog/tests/compat_cascade.rs`, and `a_base_url_on_a_catalog_provider_id_redirects_its_catalog_route` in `crates/driver/tests/configured_models.rs` (the `models.toml` `baseUrl` overlay on the `otari` catalog id).
- Not expressible as data, left for a codec change: upstream sends `reasoning.enabled = true` for Modular's two single-rung models (`minimax/minimax-m3`, `google/gemma-4-31b-it`) through `when-thinking extra-body`. omp's typed `ReasoningBodyOverride` has no `reasoning` field, so the importer drops that key (`DROPPED_EXTRA_BODY_KEYS`). Also, the OpenAI chat codec reads `thinking_format` only for `chat-template`, so Modular rows carry `thinking_format = openrouter` as a fact but send `reasoning_effort`, not OpenRouter's `reasoning` object, until a codec reads it. This is an open question for a later slice, not a regression: the provider is unselectable without a key.
- A catalog-id overlay patches the route's `endpoint` only; the route's `trust_domain.origin` stays the hosted origin (the user-added path rewrites it, `discovery/models.rs`). Nothing in the request path was found to gate credentials on that origin besides server-session binding, but the test does not pin it.

## References

ADR 0024 (latched roster); ADR 0036 (Python for extensions, unaffected); ADR 0042 (`apple-intelligence` identifier); ADR 0049 (D4 raw tokens, D6 class B); ADR 0053 (judge role, not started); ADR 0055 (web search backends, a parallel gap); `docs/research/providers-signin.md`; `crates/catalog/src/compile.rs`; `crates/catalog/src/capability.rs`; `crates/ai/src/provider/builtin.rs`; `crates/ai/src/auth/store.rs`; `crates/ai/src/auth/oauth.rs`; `crates/ai/src/auth/oauth/custom/`; `crates/ai/src/codec/provider_hooks.rs`; `crates/driver/src/registry.rs`; `crates/driver/src/discovery/models.rs`; `crates/driver/src/delegated_acp.rs`; `fixtures/llm-oracle/catalog/providers.toml`; `fixtures/llm-oracle/catalog/oauth.toml`.
