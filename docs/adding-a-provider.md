# Adding a provider

A provider is described by two KDL documents, plus a TypeScript factory
whenever it has catalog-managed runtime model discovery:

- **Catalog half** (`packages/catalog/src/compat/rules/providers/<id>.kdl`): the
  root `provider "<id>"` node carrying `default-model`, the runtime env keys,
  discovery wiring, authored seed rows, and the provider's cascade rules. The
  entry is compiled into `src/compat/rules.json`, and `KnownProvider` is
  generated from these files into `src/compat/provider-ids.ts`.
- **Auth half** (`packages/catalog/src/compat/rules/auth/<id>.kdl`): the root
  `auth "<id>"` node carrying the env fallback and the login/refresh policy.
  Runtime accessors live in `src/compat/auth.ts`; the `AuthProviderId` and
  `LoginProviderId` unions are generated into `src/compat/auth-ids.ts`, and
  `auth/_order.kdl` pins the `/login` roster order.
- **Code half** (`packages/catalog/src/provider-models/descriptors.ts`): the
  runtime model-manager factory for providers whose discovery needs code, and
  nothing else. `packages/ai/src/registry/registry.ts` derives the whole
  `PROVIDER_REGISTRY` from the compiled auth stratum, so no file in
  `packages/ai` enumerates providers by hand.

`ProviderDescriptor` (runtime discovery), `DEFAULT_MODEL_PER_PROVIDER`, the
`KnownProvider` union, the env-key map, the `/login` list, and the
login/refresh dispatch are all derived from those sources. None of them is
hand-maintained.

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

For the common case, a provider is **one catalog rule, one auth rule, and one
factory entry**:

1. **Add `packages/catalog/src/compat/rules/providers/<id>.kdl`** with the root
   `provider "<id>"` node: `default-model`, the plain API-key env var(s) as
   `env`, and the cascade rules the provider needs. Declaring `default-model`
   is what makes the file a catalog provider — a file without it is wire-compat
   only (custom provider ids such as `llama.cpp`) and may carry no other entry
   node. Add a `discovery` node only when the provider should be model-listed at
   generation time.
2. **Add `packages/catalog/src/compat/rules/auth/<id>.kdl`** with the root
   `auth "<id>"` node: `name`, `env`, and the login flow (`login "api-key"`
   with a `validate` probe for the common case). When the provider has a
   `login` and does not set `show-in-login-list #false`, add its id to the
   `login-order` node in `auth/_order.kdl`.
3. **Add a factory to `MODEL_MANAGER_FACTORIES`** in
   `packages/catalog/src/provider-models/descriptors.ts`, keyed by provider id.
   Every provider with catalog-managed runtime discovery needs one, including a
   plain OpenAI-compatible gateway: build it inline with the exported
   `createSimpleOpenAICompletionsOptions(providerId, defaultBaseUrl, config)`
   (as `groq`, `together`, and `coreweave` do) or as a named factory in
   `packages/catalog/src/provider-models/openai-compat.ts` / `special.ts`.
   Only ids in this table enter `PROVIDER_DESCRIPTORS`, so a provider that
   declares a `discovery` node but has no factory is generated into the bundled
   catalog and never refreshed at runtime. Omit the factory only when there is
   no runtime discovery to run — the header of that file names those ids
   (`amazon-bedrock`, `azure`, `gitlab-duo`, the MiniMax ids, and the
   OAuth-driven managers `google-antigravity` / `google-gemini-cli` /
   `openai-codex`, whose managers are built by the coding-agent runtime).
4. **Add a `TRANSPORTS` entry** in `packages/ai/src/registry/registry.ts` only
   when the provider shapes models or requests in TypeScript alongside its KDL
   auth policy.
5. **Regenerate and commit.** `cd packages/catalog && bun run gen:compat`
   compiles the KDL tree into `src/compat/rules.json`; commit that file in the
   same change as the `.kdl` sources. Run `bun run gen:models` when the edit
   changes bundled rows or seed values, and commit the rebaked `src/models.json`
   with it.

For an **auth flow with vendor-specific code**, declare
`login "custom" hook="name"` and implement the hook in
`packages/ai/src/registry/hooks/custom.ts` (or the matching domain file under
`registry/hooks/`). Hook names are validated against those tables by the
`@oh-my-pi/pi-ai` `auth-hooks-registry` test, so an unknown hook name fails the
suite rather than the login.

## Field reference

**Catalog entry** (`provider "<id>"` in `providers/<id>.kdl`, compiled to
`CompiledProvider`; see the grammar README for the full node list):

| Field                                 | Effect                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default-model`                       | Required for a catalog entry. Member of `KnownProvider`; preferred model when no explicit selection is made.                                                                                                                                                                                                                                   |
| `env`                                 | Env var name(s), in order, for the runtime API-key fallback (`getEnvApiKey`).                                                                                                                                                                                                                                                                  |
| `allow-unauthenticated`               | Runtime creates a model manager even without a key.                                                                                                                                                                                                                                                                                            |
| `dynamic-models-authoritative`        | Successful runtime discovery replaces bundled models instead of merging.                                                                                                                                                                                                                                                                       |
| `skip-cross-provider-reference-fills` | Generator backfills never copy reasoning/input/limits from same-id rows on other hosts.                                                                                                                                                                                                                                                        |
| `discovery`                           | Enrolls the provider in generation-time discovery (`generate-models.ts`). Runtime discovery is a `MODEL_MANAGER_FACTORIES` entry instead. `label=` is required; `oauth-provider=` lets a stored credential stand in for a key; `allow-unauthenticated=` permits credential-less discovery; child `env "…"` overrides the generation-time keys. |
| `seed`                                | Authors bundled rows for providers that cannot be discovered at generation time; `bundle=` picks `always` (default), `fallback`, or `empty`.                                                                                                                                                                                                   |

Cascade rules (wire quirks, thinking ladders, limit/pricing corrections) live
in the same `provider` node, below the entry properties.

**Auth policy** (`auth "<id>"` in `auth/<id>.kdl`, compiled to
`CompiledAuthProvider`):

| Field                    | Effect                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | Required. Shows in the `/login` list when the policy declares a visible login flow.                                                                                     |
| `env`                    | Env fallback for `getEnvApiKey`: `env "A" "B"` for an ordered list, or `env hook="name"` for a computed resolver registered in `packages/ai/src/registry/hooks/env.ts`. |
| `login`                  | Interactive login: `api-key`, `oauth-code`, `device-code`, or `custom`. Present ⇒ member of `LoginProviderId` and dispatchable through `AuthStorage.login`.             |
| `refresh`                | Token refresher (`refresh { … }`, `refresh "none"`, or `refresh hook="name"`); omit for static-token providers.                                                         |
| `store-as`               | Persist credentials under a different provider id (e.g. `openai-codex-device` ⇒ `openai-codex`).                                                                        |
| `callback-port`          | Present ⇒ entry in the auth-broker `CALLBACK_PORTS` map.                                                                                                                |
| `paste-code`             | The OAuth flow needs a pasted code/redirect URL ⇒ member of `PASTE_CODE_LOGIN_PROVIDERS`.                                                                               |
| `api-key-format`         | `bearer` (default) or `structured` (the JSON credential is used as the API key).                                                                                        |
| `expiry`                 | Session-JWT expiry policy (`jwt-or-never`).                                                                                                                             |
| `result "api-key"`       | An OAuth login persists only `credentials.access` as a plain API key.                                                                                                   |
| `allows-missing-api-key` | The provider transport can authenticate without a resolved API-key string.                                                                                              |
| `native-auth-api`        | The provider transport resolves auth itself; scan plans pin this API without secrets.                                                                                   |
| `available`              | Optional login-list availability flag.                                                                                                                                  |
| `show-in-login-list`     | Set `#false` to keep a provider with a `login` out of the interactive list; such a provider is not required in `login-order`.                                           |

**Code half** (`provider-models/descriptors.ts`): `MODEL_MANAGER_FACTORIES`
pairs each provider id with a
`(config: ModelManagerConfig) => ModelManagerOptions<Api>` factory;
`PROVIDER_DESCRIPTORS` joins those factories with the compiled entries, and a
provider appears there only when it has both — the factory entry, not the KDL
`discovery` node, is what enables runtime discovery. **Code half**
(`packages/ai/src/registry/registry.ts`): `TRANSPORTS` pairs a provider id with
a `ProviderTransport` (`prepareModel`, `prepareRequest`, `mapSimpleOptions`,
`prepareModelDiscovery`) for the few providers that need code beside their auth
policy.

## Conventions

- Author policy in KDL. Branching on model identity in TypeScript is allowed
  only through structured facts from `classifyModel()`, and only for transport
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
bun run gen:compat   # rules/ → src/compat/rules.json (committed)
bun test test/compat-compile.test.ts test/compat-conformance.test.ts \
         test/compat-taxonomy.test.ts test/compat-cascade.test.ts test/compat-parity.test.ts
```

`compat-compile.test.ts` fails when `rules.json` drifts from the KDL sources, so
a forgotten `gen:compat` is a test failure rather than a silent mismatch. Add a
regression test against the rule or factory, not against the bundled JSON, so it
survives upstream metadata shifts. Run `bun check` from the repository root
before opening the pull request.
