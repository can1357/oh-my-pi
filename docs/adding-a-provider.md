# Adding a provider

Providers are declared in KDL and compiled by `bun run gen:compat`. TypeScript is only for what KDL
cannot express: a discovery factory, request shaping, a bespoke login flow. Grammar reference:
[`packages/catalog/src/compat/rules/README.md`](../packages/catalog/src/compat/rules/README.md).

This covers providers on an existing wire API. A new `Api` also touches `packages/ai/src/stream.ts`,
`packages/ai/src/api-registry.ts` and `KnownApi` in `packages/catalog/src/types.ts`.

## Where things live

| # | What | Where | Needed |
| --- | --- | --- | --- |
| 1 | Catalog entry, wire/thinking rules | `packages/catalog/src/compat/rules/providers/<id>.kdl` | always |
| 2 | Auth policy | `packages/catalog/src/compat/rules/auth/<id>.kdl`, `auth/_order.kdl` | always |
| 3 | Discovery factory | `MODEL_MANAGER_FACTORIES` in `packages/catalog/src/provider-models/descriptors.ts` | for runtime model discovery |
| 4 | Request shaping | `TRANSPORTS` in `packages/ai/src/registry/registry.ts` + `packages/ai/src/registry/<id>.ts` | rarely |
| 5 | Login flow | `packages/ai/src/registry/oauth/<id>.ts` + a table in `packages/ai/src/registry/hooks/` | rarely |

Examples: `minimax` (1–2), `groq` (1–3), `cloudflare-ai-gateway` (1–5).

## 1. Provider KDL

```kdl
provider "cloudflare-ai-gateway" {
	default-model "anthropic/claude-opus-4-8"
	env "CLOUDFLARE_AI_GATEWAY_API_KEY"
	discovery label="Cloudflare AI Gateway"
	…
}
```

- `default-model` makes the file a catalog provider and adds the id to `KnownProvider`.
- `env` lists API-key env vars, tried in order.
- Catalog shape:
  - no `discovery` node: bundled `models.json` rows only, or runtime discovery only. With no bundled
    rows, add the id to `RUNTIME_ONLY_PROVIDERS` in `packages/catalog/test/compat-conformance.test.ts`.
  - `discovery label="…"`: `generate-models.ts` fetches the live catalog into `models.json`.
  - `seed … bundle="always" | "fallback" | "empty"`: authored rows; see "Seed rows" in the README.
- Host quirks are axes from the closed vocabulary in `packages/catalog/src/compat/axes.ts`. Never
  branch on provider or model id in TypeScript.
- Placement: `taxonomy/` model identity, `classes/` lineage behavior, `providers/` host behavior,
  `runtime/behavior.kdl` pre-lookup heuristics.
- A `thinking` ladder set by a discovery mapper always wins over KDL `thinking-efforts`.
- On `AmbiguousOverlapError`, set `priority=` on the block and name the rule it yields to in a
  comment (precedent: `providers/ollama.kdl`). Do not reorder rules.

## 2. Auth KDL

```kdl
auth "cloudflare-ai-gateway" {
	name "Cloudflare AI Gateway"
	login "custom" hook="cloudflare-ai-gateway"
}
```

- Env-key only: just `name` (`auth/minimax.kdl`). Declarative flows: `api-key`, `oauth-code`,
  `device-code`.
- A provider with a `login` must appear in `login-order` in `auth/_order.kdl`, or `gen:compat` fails.
- A catalog provider without an auth policy is a compile error (`_CheckRegistryComplete` in
  `registry.ts`).

## 3. Regenerate

```sh
bun run gen:compat
```

Commit the generated `rules.json`, `provider-ids.ts` and `auth-ids.ts` with the KDL. Never edit them
by hand.

## 4. Discovery factory

```ts
export function groqModelManagerOptions(config?: GroqModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	return createSimpleOpenAICompletionsOptions("groq", "https://api.groq.com/openai/v1", config);
}
```

- Register it: `groq: config => groqModelManagerOptions(config),` in `MODEL_MANAGER_FACTORIES`.
- Anthropic-format hosts use `createSimpleAnthropicProviderOptions`.
- Write a bespoke fetcher only when the model list is not OpenAI-shaped
  (`litellmModelManagerOptions`).
- No factory means no runtime discovery or refresh.
- Add the id to `DEFAULT_MODEL_PROVIDER_ORDER` in `packages/catalog/src/identity/priority.ts` if it
  should take part in automatic model selection.

## 5. Transport and login hook

Only when KDL cannot express it.

- Transport: export a `ProviderTransport` (`prepareModel`, `prepareRequest`, `mapSimpleOptions`,
  `prepareModelDiscovery`) from `packages/ai/src/registry/<id>.ts` and add it to `TRANSPORTS`.
  `cloudflare-ai-gateway.ts` picks the route per model id and substitutes `<account>`/`<gateway>` in
  the base URL.
- Login: `login "custom" hook="<name>"` resolves against the tables in
  `packages/ai/src/registry/hooks/`. Paste-a-token flows go in `API_KEY_LOGIN_HOOKS`
  (`hooks/api-key.ts`); the flow lives in `registry/oauth/<id>.ts`.
- Structured credentials (token + ids): parse/serialize helpers in
  `packages/catalog/src/wire/<id>.ts`, and a `matchesReplacementCredential` case in
  `packages/ai/src/auth/sqlite-credential-store.ts` so re-login replaces the stored row.

## Adding a compat axis

Example: `requiresStringMessageContent`.

1. `packages/catalog/src/compat/axes.ts`: KDL name → field.
2. `packages/catalog/src/types.ts`: field on `OpenAICompat`.
3. `packages/catalog/src/compat/resolve.ts`: default.
4. `packages/catalog/test/compat-parity.test.ts`: `NEW_COMPAT_FIELDS`.
5. `packages/coding-agent/src/config/models-config-schema-bundle.ts`: `models.yml` schema.
6. The transport that reads `compat.<field>`.
7. `docs/models.md`.

## Tests

```sh
bun run gen:compat
bun --cwd=packages/catalog test test/compat-compile.test.ts test/compat-conformance.test.ts \
     test/compat-cascade.test.ts test/compat-taxonomy.test.ts test/compat-parity.test.ts \
     test/descriptors.test.ts test/provider-default-models.test.ts
bun --cwd=packages/ai test test/auth-hooks-registry.test.ts
bun run check:ts
bun run check:tools
```

- Add `packages/catalog/test/<id>-provider.test.ts` (discovery mapping, mocked `fetch`) and
  `packages/ai/test/<id>.test.ts` (login, request shaping).
- No network, no `mock.module()`, no source-grepping; use `withEnv`
  (`packages/ai/test/helpers/index.ts`) for env vars.

## Docs

`docs/providers.md`, `docs/environment-variables.md`, `docs/provider-quirks.md`,
`packages/ai/README.md`, and one `## [Unreleased]` line in each affected `packages/*/CHANGELOG.md`.
