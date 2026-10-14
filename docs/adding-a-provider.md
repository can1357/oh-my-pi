# Adding a provider

A built-in provider is described in two halves:

- **Catalog half** (`packages/catalog`): a `provider "<id>"` entry in
  `src/compat/rules/providers/<id>.kdl` carrying the default model, environment
  variables, catalog-discovery policy, seed models, and provider compat rules.
  Runtime discovery factories live in
  `src/provider-models/descriptors.ts`'s `MODEL_MANAGER_FACTORIES` table.
  `KnownProvider`, `PROVIDER_DESCRIPTORS`, and `DEFAULT_MODEL_PER_PROVIDER`
  derive from the compiled catalog entries and that factory table.
- **Auth half** (`packages/catalog` + `packages/ai`): an
  `auth "<id>"` entry in `packages/catalog/src/compat/rules/auth/<id>.kdl`.
  `packages/ai/src/registry/build.ts` interprets the compiled policy into a
  `ProviderDefinition`. The OAuth-provider union, environment-key map,
  `/login` provider list, login/refresh dispatch, and coding-agent callback maps
  derive from this registry. Provider-specific TypeScript hooks are only needed
  when the declarative engines cannot express the behavior.

**Scope.** This is for a provider that reuses an existing wire API
(`openai-completions`, `openai-responses`, `anthropic-messages`,
`google-generative-ai`, …). Dispatch keys on `model.api`, not just
`model.provider`. A new built-in wire protocol also needs its transport and
registration in `packages/ai/src/providers/register-builtins.ts`, dispatch in
`stream.ts`, reserved API registration in `api-registry.ts`, and catalog API
and compat/compiler definitions. Extensions can instead register a custom API.

## Shape

For an API-key gateway, start with catalog and auth KDL files; add a discovery
factory only if the provider supports model listing.

1. **Add `packages/catalog/src/compat/rules/providers/<id>.kdl`.**
   `default-model` makes the entry a catalog provider; a provider rule without
   it is wire-compat-only. Put ordinary API-key environment names in `env`, in
   precedence order. Add reviewed seed rows when models must be bundled, and
   provider/model compat directives when the endpoint differs from API defaults.
2. **Add `packages/catalog/src/compat/rules/auth/<id>.kdl`.**
   `name` is required. An env-only provider needs no `login` node. For a simple
   API-key login, declare the dashboard URL, prompt, and an appropriate protected
   validation endpoint. Public `/models` endpoints cannot validate a key.
   Auth `env` overrides catalog `env`; use it for auth-specific aliases or an
   `env hook="…"` computed resolver.
3. **If login is visible, add its ID to `auth/_order.kdl`.**
   The compiler requires every visible loginable provider in `login-order`.
   There is no hand-maintained `ALL` array or per-provider definition file in
   `packages/ai/src/registry/`.
4. **If models are discoverable, add a factory to `MODEL_MANAGER_FACTORIES`**
   in `packages/catalog/src/provider-models/descriptors.ts`. A simple
   OpenAI-compatible gateway can call the exported
   `createSimpleOpenAICompletionsOptions(providerId, baseUrl, config)` from
   `provider-models/openai-compat.ts`. A KDL `discovery` node alone does not
   create a runtime factory. The bespoke Google OAuth and Codex managers are
   constructed by the coding-agent runtime instead.
5. **Regenerate compiled rules and the bundled catalog.** From the repo root,
   run `bun run gen:compat`, then `bun run gen:models` with the discovery
   credentials needed by the provider. `gen:compat` writes `rules.json`,
   `auth-ids.ts`, and `provider-ids.ts` under `packages/catalog/src/compat/`.
   For a provider-only catalog update, use `bun run gen:models --provider <id>`
   to regenerate that provider while preserving every other provider's committed
   snapshot. Cross-provider reference data remains available to the generator.
   Do not edit these generated files by hand.

For example, a static OpenAI-compatible gateway can declare its catalog row as:

```kdl
provider "my-gateway" {
    default-model "chat-model"
    env "MY_GATEWAY_API_KEY"
    seed api="openai-completions" base-url="https://gateway.example.com/v1" {
        model "chat-model" name="Gateway Chat" {
            reasoning #false
            input "text"
            cost input=1 output=2 cache-read=0 cache-write=0
            limits context=128000 max-tokens=8192
        }
    }
}
```

Its env-only auth policy is:

```kdl
auth "my-gateway" {
    name "My Gateway"
}
```

The endpoint, limits, modalities, and per-million-token prices above are example
values; use the provider's verified deployment contract. Examples under
`packages/catalog/src/compat/rules/auth/` include `deepinfra.kdl` for API-key
login with inference validation, `anthropic.kdl` for a declarative
authorization-code flow, and `github-copilot.kdl` for a custom flow.

## Field reference

**Catalog KDL** (compiled by
`packages/catalog/scripts/compat-compiler/compile-providers.ts`):

| Node | Effect |
| ---- | ------ |
| `default-model "id"` | Required for a catalog entry. Supplies `DEFAULT_MODEL_PER_PROVIDER`. |
| `env "VAR" …` | Ordered runtime API-key environment fallbacks, unless overridden by auth policy. |
| `allow-unauthenticated #true` | Allows runtime discovery-manager creation without credentials. Does not by itself make hosted inference keyless. |
| `dynamic-models-authoritative #true` | Successful discovery replaces bundled provider models rather than retaining fallback-only IDs. |
| `skip-cross-provider-reference-fills #true` | Prevents generation from borrowing reasoning, modalities, and limits from same-ID rows on other providers. |
| `discovery label="…"` | Enables catalog generation for an entry with a discovery factory. Optional `oauth-provider`, `allow-unauthenticated`, and child `env` select generation credentials/policy. |
| `seed api="…" base-url="…"` | Defines reviewed model rows; individual rows may override API and base URL. Each row needs `name`, `reasoning`, `input`, `cost`, and `limits`. |
| Seed `bundle` / `precedence` | `bundle="always"` is the default; `"fallback"` omits seeds after authoritative discovery, and `"empty"` emits them only if the provider has no rows. Default `precedence="upstream"` lets upstream rows win; `"seed"` pins the seed row. |
| `kind-apis { … }` | Maps non-chat catalog kinds to their runner APIs. |
| Compat/thinking/catalog directives | Deployment policy, optionally scoped to classes, revisions, families, or model IDs. See `src/compat/axes.ts` and existing provider rules. |

**Auth KDL** (compiled by
`packages/catalog/scripts/compat-compiler/compile-auth.ts`):

| Node | Effect |
| ---- | ------ |
| `name "…"` | Required display name. |
| `env "VAR" …` / `env hook="…"` | Overrides catalog environment fallbacks with an ordered list or computed resolver. |
| `login "api-key" { … }` | Paste-a-key login with optional validation. |
| `login "oauth-code" { … }` | Declarative authorization-code flow. Requires an explicit `refresh` policy. |
| `login "device-code" { … }` | Declarative device-code flow. Requires an explicit `refresh` policy. |
| `login "custom" hook="…"` | Lazy whole-flow hook when the declarative grammar is insufficient. |
| `refresh { … }` / `refresh hook="…"` / `refresh "none"` | Token refresh policy, custom refresher, or explicit no-refresh policy. |
| `available #false` | Marks the login entry unavailable. |
| `show-in-login-list #false` | Hides a login flow from the interactive list. |
| `store-as "id"` | Stores credentials under another provider ID. |
| `callback-port N`, `paste-code #true` | Coding-agent/broker callback metadata; OAuth-code flows derive these from their callback policy unless overridden. |
| `oauth-token-env "VAR" …` | Dedicated OAuth environment tokens; borrowed API-key aliases do not make this provider automatically available. |
| `org-scoped-identity #true` | Distinguishes stored accounts by organization as well as identity. |
| `api-key-format "structured"` | Declares a transport-specific credential encoding rather than a plain bearer. |
| `allows-missing-api-key #true`, `native-auth-api "api" …` | Marks transport-owned authentication paths. |

The compiled types in `packages/catalog/src/compat/types.ts` and the compiler
are the complete grammar reference. The materialized runtime interface is
`packages/ai/src/registry/types.ts`'s `ProviderDefinition`, not the authoring
format for built-ins.

## Conventions

- Put pure provider/model policy in KDL rather than adding provider-name branches
  to transports. `resolveModelPolicy` in `packages/catalog/src/compat/resolve.ts`
  applies API defaults, endpoint detection, the KDL cascade, then sparse model
  overrides/fixups; thinking metadata resolves afterward.
- Prefer the shared engines in `packages/ai/src/registry/engine/` for API-key,
  OAuth-code, device-code, and refresh flows. Register computed or custom pieces
  in the appropriate domain table under `registry/hooks/`.
- Heavy provider-local OAuth modules belong under `registry/oauth/` and must be
  reached through lazy hook imports, not eager registry imports.
- Request/model/discovery shaping that truly needs code belongs in a
  `ProviderTransport` and an entry in `registry.ts`'s `TRANSPORTS` table. Hooks
  include `prepareModel`, `prepareRequest`, `mapSimpleOptions`, and
  `prepareModelDiscovery`.
- Extensions register an `OAuthProviderInterface` through
  `registerOAuthProvider`, not a built-in KDL policy or transport definition.
  Built-in and extension logins use the same `AuthStorage.oauth.login`
  dispatcher; extension model/API registration is handled separately.
- Exercise login against its actual credential-protected surface, model
  discovery, and inference with tools/reasoning where supported. Check the
  [endpoint constraints](./provider-endpoint-constraints.md) before reusing a
  protocol adapter or adding compat policy.
