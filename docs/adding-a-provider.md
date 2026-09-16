# Adding a provider

A provider is described by two KDL documents, plus a TypeScript factory
whenever it has catalog-managed runtime model discovery:

- **Catalog half** (`packages/catalog/src/compat/rules/providers/<id>.kdl`): the
  root `provider "<id>"` node carrying `default-model`, the runtime env keys,
  discovery wiring, authored seed rows, and the provider's cascade rules. The
  entry is compiled into `src/compat/rules.json`, and `KnownProvider` is
  generated from these files into `src/compat/provider-ids.ts`.
- **Auth half** (`packages/catalog/src/compat/rules/auth/<id>.kdl`): the root
  `auth "<id>"` node carrying the login/refresh policy and optional env overrides.
  Runtime accessors live in `src/compat/auth.ts`; the `AuthProviderId` and
  `LoginProviderId` unions are generated into `src/compat/auth-ids.ts`, and
  `auth/_order.kdl` pins the `/login` roster order.
- **Code half** (`packages/catalog/src/provider-models/descriptors.ts`): the
  runtime model-manager factory for providers whose discovery needs code, and
  nothing else. `packages/ai/src/registry/registry.ts` derives the whole
  `PROVIDER_REGISTRY` from the compiled auth stratum.

`ProviderDescriptor` (runtime discovery), `DEFAULT_MODEL_PER_PROVIDER`, the
`KnownProvider` union, the `/login` list, and the login/refresh dispatch are all
derived from those sources. The provider roster is derived as well, but scoped
TypeScript tables still name individual ids and are expected: `TRANSPORTS` below,
the generator's local-only and credential-scoped exclusion sets, the
special-manager ids in
`packages/coding-agent/src/config/model-provider-discovery.ts`, and the
credential-ranking strategies in `packages/ai/src/auth-storage.ts`. The env-key
map is derived too, and then merged with legacy service- and API-name overrides
in `packages/ai/src/stream.ts`.

`packages/catalog/src/compat/rules/README.md` is the grammar specification for
the provider, auth, cascade, taxonomy, and seed nodes, including the closed
axis vocabulary. This page is the procedure.

**Scope.** This is for a provider that reuses an existing wire API
(`openai-completions`, `anthropic-messages`, `google-generative-ai`, …) — the
common case for gateways and API-key providers, since stream dispatch keys on
`model.api`, not `model.provider`. Adding a _new wire protocol_ (a new
`KnownApi`) is a separate task that also touches `stream.ts` dispatch,
`api-registry.ts`, and the catalog `types.ts`.

## Shape

A catalog provider needs **one catalog rule and one auth rule**. Add a factory
when using descriptor-based endpoint discovery:

1. **Add `packages/catalog/src/compat/rules/providers/<id>.kdl`** with the root
   `provider "<id>"` node: `default-model`, the plain API-key env var(s) as
   `env`, and the cascade rules the provider needs. The node argument, not the
   file name, is the id the compiler records; matching the file name to it is
   convention. Declaring `default-model`
   is what makes the file a catalog provider — a file without it is wire-compat
   only (custom provider ids such as `llama.cpp`) and may carry no other entry
   node. Add a `discovery` node when the generic generation-time path should
   fetch the provider's endpoint; that path walks `PROVIDER_DESCRIPTORS`, so it
   needs a factory entry too (step 3).
2. **Add `packages/catalog/src/compat/rules/auth/<id>.kdl`** with the root
   `auth "<id>"` node and required `name`. The `login` node is optional:
   env-only providers can omit it. For interactive API-key login, use
   `login "api-key"` with a required `prompt`; supply `auth-url` and
   `instructions` together or omit both. Add `validate` when a safe probe can
   distinguish valid credentials; a public endpoint is not a key-validation
   probe (see `auth/commandcode.kdl`). Keep ordinary API-key env names in the
   catalog rule from step 1; auth `env` is an optional override for auth-only
   providers or intentional overrides, including computed resolvers. When the
   provider has a `login` and does not set `show-in-login-list #false`, add its id
   to the `login-order` node in `auth/_order.kdl`.
3. **For descriptor-based endpoint discovery, add a factory to
   `MODEL_MANAGER_FACTORIES`** in
   `packages/catalog/src/provider-models/descriptors.ts`, keyed by provider id.
   Providers relying only on seeds or upstream catalog data can omit this step.
   For a plain OpenAI-compatible gateway, call the exported
   `createSimpleOpenAICompletionsOptions(providerId, defaultBaseUrl, config)` —
   from a thin named wrapper beside the others in
   `packages/catalog/src/provider-models/openai-compat.ts`, the way `groq`,
   `together`, and `coreweave` do it — or use a bespoke manager in the
   appropriate module under `provider-models/`, following similar providers.
   `PROVIDER_DESCRIPTORS` is that table joined with the compiled
   entries, and the descriptor-based paths read it: the runtime refreshes the
   ids in it, and `generate-models.ts` fetches the entries whose compiled entry
   also carries a `discovery` node, minus its local-only and credential-scoped
   exclusions (`DISCOVERY_ONLY_PROVIDERS`, `CREDENTIAL_SCOPED_PROVIDERS` in that
   script). A `discovery` node without a factory
   therefore reaches neither path, and that provider's rows have to come from
   elsewhere — upstream catalog data, an authored `seed`, a previous
   `models.json` snapshot, or a path that lives outside this table: the
   coding-agent runtime builds the special managers and the models.dev catalog
   itself (`packages/coding-agent/src/config/model-registry.ts`, ids collected in
   `model-provider-discovery.ts`), and `generate-models.ts` has its own
   Antigravity and Codex fetches. The header
   of `descriptors.ts` names the ids with no factory here: `amazon-bedrock`,
   `azure`, `gitlab-duo`, the MiniMax ids, and the OAuth-driven managers
   `google-antigravity` / `google-gemini-cli` / `openai-codex`.
4. **Add a `TRANSPORTS` entry** in `packages/ai/src/registry/registry.ts` only
   when the provider shapes models or requests in TypeScript alongside its KDL
   auth policy.
5. **Regenerate and commit.** `cd packages/catalog && bun run gen:compat`
   rewrites three tracked files from the KDL tree — `src/compat/rules.json`, and
   the `src/compat/provider-ids.ts` and `src/compat/auth-ids.ts` unions — so
   commit all three alongside the `.kdl` sources. Until it runs, the factory key
   added in step 3 is not yet a member of `KnownProvider` and the type check will
   say so, and a stale `auth-ids.ts` fails `compat-compile.test.ts`. Run
   `bun run gen:models` when the edit changes bundled rows or seed values, and
   commit the rebaked `src/models.json` with it.

For an **auth flow with vendor-specific code**, declare
`login "custom" hook="name"` and implement the hook in the matching domain file
under `packages/ai/src/registry/hooks/` (`api-key.ts` for key-paste flows,
`custom.ts` for its whole-flow hooks). Hook names are validated against the
merged tables in `registry/hooks/index.ts` by the
`@oh-my-pi/pi-ai` `auth-hooks-registry` test, so an unknown hook name fails the
suite rather than the login.

## Field reference

**Catalog entry** (`provider "<id>"` in `providers/<id>.kdl`, compiled to
`CompiledProvider`; see the grammar README for the full node list):

| Field                                 | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default-model`                       | Required for a catalog entry. Member of `KnownProvider`; preferred model when no explicit selection is made.                                                                                                                                                                                                                                                                                                                                                                             |
| `env`                                 | Env var name(s), in order, for the runtime API-key fallback (`getEnvApiKey`).                                                                                                                                                                                                                                                                                                                                                                                                            |
| `allow-unauthenticated`               | Runtime creates a model manager even without a key.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `dynamic-models-authoritative`        | Controls generator replacement of upstream/snapshot rows after qualifying endpoint discovery and disables unauthenticated shared-catalog fallback in descriptor-based runtime setup. Runtime pruning additionally requires the factory's returned `ModelManagerOptions.dynamicModelsAuthoritative` to be `true`; the descriptor flag is not copied into those options.                                                                                                                   |
| `skip-cross-provider-reference-fills` | Generator backfills never copy reasoning/input/limits from same-id rows on other hosts.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `discovery`                           | Configures the generation-time catalog fetch. The generator walks `PROVIDER_DESCRIPTORS`, so this node only configures a fetch for a provider that already has a factory entry, and it is still only eligible: the local-only and credential-scoped ids are dropped by that script. `label=` is required; `oauth-provider=` lets a stored credential stand in for a key; `allow-unauthenticated=` permits credential-less discovery; child `env "…"` overrides the generation-time keys. |
| `seed`                                | Authors bundled rows — credential-scoped rosters, unauthenticated regens, or models ahead of upstream catalogs. A discoverable provider can seed too: `bundle="always"` keeps those rows in every regeneration, deduped behind upstream data at the default `precedence="upstream"`, while `precedence="seed"` prepends them after the snapshot merge so the authored row wins dedup. `bundle=` picks `always` (default), `fallback`, or `empty`.                                        |

Cascade rules (wire quirks, thinking ladders, limit/pricing corrections) live
in the same `provider` node, below the entry properties.

**Auth policy** (`auth "<id>"` in `auth/<id>.kdl`, compiled to
`CompiledAuthProvider`):

| Field                    | Effect                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | Required. Shows in the `/login` list when the policy declares a visible login flow.                                                                                                                                                                                                                                               |
| `env`                    | Optional override of the catalog env fallback for `getEnvApiKey`: `env "A" "B"` for an ordered list, or `env hook="name"` for a computed resolver registered in `packages/ai/src/registry/hooks/env.ts`. Omit it for ordinary catalog API-key providers; use it for auth-only providers or intentional overrides.                 |
| `login`                  | Interactive login: `api-key`, `oauth-code`, `device-code`, or `custom`. Present ⇒ member of `LoginProviderId` and dispatchable through `AuthStorage.login`.                                                                                                                                                                       |
| `refresh`                | Token refresher (`refresh { … }`, `refresh "none"`, or `refresh hook="name"`). `oauth-code` and `device-code` logins must declare one — use `refresh "none"` for a grant that cannot be refreshed; omit it when there is no login, since the compiler rejects a `refresh` without one.                                            |
| `store-as`               | Persist stored OAuth credentials under a different provider id (e.g. `openai-codex-device` ⇒ `openai-codex`); a login returning a plain API-key string is stored under the provider's own id.                                                                                                                                     |
| `callback-port`          | Present ⇒ entry in the auth-broker `CALLBACK_PORTS` map.                                                                                                                                                                                                                                                                          |
| `paste-code`             | The OAuth flow needs a pasted code/redirect URL ⇒ member of `PASTE_CODE_LOGIN_PROVIDERS`.                                                                                                                                                                                                                                         |
| `api-key-format`         | `bearer` (default) or `structured`, where the API key is a JSON object of credential fields (`token`, `apiEndpoint`, `projectId`, `expiresAt`, …) instead of the bare access token.                                                                                                                                               |
| `expiry`                 | Session-JWT expiry policy (`jwt-or-never`).                                                                                                                                                                                                                                                                                       |
| `result "api-key"`       | Turn an OAuth login's result into a plain API key. Implemented for `login "oauth-code"` with `refresh "none"`: the engine then stores `credentials.access` instead of OAuth credentials. The compiler also accepts the directive on `device-code` and `custom` logins, but those engines store their OAuth credentials unchanged. |
| `allows-missing-api-key` | The provider transport can authenticate without a resolved API-key string.                                                                                                                                                                                                                                                        |
| `native-auth-api`        | The provider transport resolves auth itself; scan plans pin this API without secrets.                                                                                                                                                                                                                                             |
| `available`              | Optional login-list availability flag.                                                                                                                                                                                                                                                                                            |
| `show-in-login-list`     | Set `#false` to keep a provider with a `login` out of the interactive list; such a provider is not required in `login-order`.                                                                                                                                                                                                     |

**Code half** (`provider-models/descriptors.ts`): `MODEL_MANAGER_FACTORIES`
pairs each provider id with a
`(config: ModelManagerConfig) => ModelManagerOptions<Api>` factory;
`PROVIDER_DESCRIPTORS` joins those factories with the compiled entries, and a
provider appears there only when it has both. It is the enrollment surface for
descriptor-based discovery: the runtime refreshes the ids in it, and
`generate-models.ts` filters the same array down to the entries carrying a
`discovery` node — so that node configures a fetch the factory entry has already
enabled, and neither path applies without one (step 3 lists the routes that do
not go through this table). **Code half**
(`packages/ai/src/registry/registry.ts`): `TRANSPORTS` pairs a provider id with
a `ProviderTransport` (`prepareModel`, `prepareRequest`, `mapSimpleOptions`,
`prepareModelDiscovery`) for the few providers that need code beside their auth
policy.

## Conventions

- Author policy in KDL (repository policy: `AGENTS.md` §Model/Provider Policy
  Lives in KDL). Branching on model identity in TypeScript is allowed only
  through structured facts from `classifyModel()`, and only for transport
  mechanics; anything expressible as an axis belongs in the rules tree.
- One `auth "<id>"` node per provider. Every catalog provider (`KnownProvider`)
  needs one — `packages/ai` type-checks this through `_CheckRegistryComplete`,
  and a missing rule surfaces as a type error naming the uncovered ids.
- Prefer the declarative `login` kinds over `login "custom"`. A custom hook is
  for flows no rule kind can express, and it must exist in the hook tables.
- A `models.yml` provider added by a user is a different path: it is not a
  bundled catalog provider and needs no KDL. A `ProviderDefinition` may also be
  registered at runtime by an extension via `registerOAuthProvider` /
  `unregisterOAuthProvider` (the `AuthStorage.login` dispatcher handles built-ins
  and extensions through the same path).

## Checks

```sh
cd packages/catalog
bun run gen:compat   # rules/ → rules.json, provider-ids.ts, auth-ids.ts in src/compat/
bun test test/compat-compile.test.ts test/compat-conformance.test.ts \
         test/compat-taxonomy.test.ts test/compat-cascade.test.ts test/compat-parity.test.ts
```

`compat-compile.test.ts` fails when `rules.json` drifts from the KDL sources, so
a forgotten `gen:compat` is a test failure rather than a silent mismatch. As
`AGENTS.md` §Generated Files requires, add a regression test against the rule or
factory rather than against the bundled JSON, so it survives upstream metadata
shifts. Run `bun check` from the repository root before opening the pull request.
