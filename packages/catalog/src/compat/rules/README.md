# Compatibility taxonomy and cascade

This tree is the checked-in source of model identity and compatibility policy. A **class** is a vendor lineage such as `gemini` or `anthropic`; a **family** is a product line within one class, such as `flash`, `pro`, `sonnet`, or `opus`; and a **revision** is a `major.minor.patch` triple extracted from a model name. Missing minor and patch components compare as zero.

There are three ownership strata:

- `taxonomy/*.kdl` defines identity: class membership, product families, revision extraction, reviewed exact corrections, and suffix collapse.
- `classes/*.kdl` defines model-lineage truths: behavior inherent to a model line, optionally scoped to the providers or request adapters where the census established it.
- `providers/<id>.kdl` is a provider's entry: its catalog identity (default model, env keys, discovery wiring, optional authored seed rows — see [Provider catalog grammar](#provider-catalog-grammar)) plus its deployment contract: behavior imposed by the host and documented per-model residue that taxonomy cannot express exactly.
- `runtime/behavior.kdl` defines heuristics used before or outside exact model lookup: responses routing, API routes, quota tiers, plan requirements, model limits, roster exclusions, hosted defaults, pricing peers.
- `auth/<provider>.kdl` defines the provider's auth contract: display name, env-var fallback, credential storage/format, and the declarative login / refresh flow that `@oh-my-pi/pi-ai`'s registry engines interpret (see [Auth grammar](#auth-grammar)).

Do not move a statistically common provider behavior into a class file, or a lineage truth into a provider file. Absence is not evidence that a capability is stripped. Preserve comments that record census provenance, reviewed exceptions, and why a `models` residue remains.

Both grammars are KDL v2. Unknown nodes/directives and malformed value shapes are errors. Declaration and file order never break cascade ties.

## Regeneration and validation

```sh
cd packages/catalog
bun run gen:compat        # compiles rules/ → src/compat/rules.json (committed)
bun test test/compat-compile.test.ts test/compat-conformance.test.ts \
         test/compat-taxonomy.test.ts test/compat-cascade.test.ts test/compat-parity.test.ts
```

`compat-compile.test.ts` fails when `rules.json` drifts from the KDL sources; `compat-parity.test.ts` proves the engine reproduces every baked `models.json` compat/thinking value. Commit `rules.json` together with the KDL change.

## Taxonomy grammar

At a taxonomy document root, the only permitted nodes are `class`, `collapse`, and `discovery`; a source may contain multiple class nodes. Class names and override IDs must be unique across all bundled sources. Exactly one non-empty `collapse` definition is required across the inventory; at most one `discovery` definition may appear.

```kdl
class "anthropic" {
    namespace "anthropic" bounded=#true
    bounded "claude"

    family "sonnet" glob="*sonnet*"
    family "opus" glob="*opus*"

    revision prefix="claude-" anywhere=#true

    override id="reviewed-distill" provider="example-host" model="opaque-model" \
        logical="author/opaque-model" class="anthropic" family="opus" revision="4.6" \
        effort="high" thinking-variant=#true expires-at-ms=1799712000000 \
        rationale="Reviewed teacher lineage" provenance="frozen census case identity-01"
}
```

### Class membership matchers

Classification trims and lowercases the full model identifier. The **bare name** is the segment after its final `/`. Matcher tokens are also lowercased while parsing.

| Node                              | Rank | Match                                                                                                                             |
| --------------------------------- | ---: | --------------------------------------------------------------------------------------------------------------------------------- |
| `exact "token"`                   |    4 | The whole bare name equals `token`.                                                                                               |
| `bounded "token"`                 |    3 | The bare name equals `token`, or starts with it followed by `-`, `_`, `.`, `:`, or an ASCII digit.                                |
| `namespace "token"`               |    2 | A non-empty `/`-separated segment of the full identifier equals `token`.                                                          |
| `namespace "token" bounded=#true` |    2 | Split the full identifier on `/`, `.`, and `:`; a segment must satisfy the bounded rule above. This is the only matcher property. |
| `prefix "token"`                  |    1 | The bare name starts with `token`.                                                                                                |
| `glob "pattern"`                  |    0 | An anchored `*` wildcard match over the bare name. `*` spans any substring; all non-wildcard text remains anchored in order.      |

A class match is ranked by `(matcher-kind rank, token byte length)`. The greatest tuple wins. Equal tuples from different classes are an ambiguity error; source order is not a tiebreak. If nothing matches, classification returns class `unknown` with no family or revision.

### Product families

A family rule has one name, a required `glob` property, and an optional signed integer `priority` (default `0`):

```kdl
family "flash" glob="*flash*"
family "lite" glob="*flash-lite*" priority=10
```

The glob is anchored, ASCII-case-insensitive, and matched against the lowercased bare name. Matching families rank by `(priority, non-wildcard byte count in the glob)`. When equal-ranked family globs tie, a leading `class.` or `class:` namespace matching one of the selected class's tokens is removed and family matching is retried; a remaining tie is an ambiguity error. No match produces no family. Repeating rules for the same family ID is allowed, as in the checked-in `o-series` taxonomy.

### Revision extraction

A class may contain both forms:

```kdl
revision prefix="gemini-"
revision prefix="claude-" anywhere=#true
revision skip-bare "o1" "o3" "o4"
```

- `prefix=` adds a lowercased extraction prefix. Without `anywhere=#true`, it must begin the bare name. With it, the first occurrence may appear anywhere in the bare name.
- Prefixes are tried in declaration order; the first matching prefix is used.
- `skip-bare` takes one or more bare names that intentionally carry no revision and overrides extraction.
- After removing or locating the prefix, extraction starts at the first ASCII digit. It reads at most three unsigned 8-bit numeric components separated by `.` or by `-` followed by a digit. Missing components become zero. Thus `claude-opus-4-6` produces `4.6.0`.

### Reviewed identity overrides

`override` has properties only and no child block. Required string properties are `id` (stable, globally unique review ID), `rationale`, and `provenance`, plus exactly one selector: `model` (exact bare identifier) or `glob` (anchored `*` wildcard over the bare identifier). Both selectors compare case-insensitively; namespace prefixes before the final `/` are ignored.

Optional properties are:

| Property           | Shape and meaning                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `provider`         | Exact provider key, compared case-insensitively. A matching provider-specific override wins over a provider-agnostic one. |
| `logical`          | Corrected logical model identifier.                                                                                       |
| `class`            | Corrected class ID; a non-empty string.                                                                                   |
| `family`           | Corrected product-family ID; a non-empty string.                                                                          |
| `revision`         | One to three unsigned 8-bit components separated by `.` or `-`.                                                           |
| `effort`           | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.                                                             |
| `thinking-variant` | Boolean marker for a separately exposed thinking sibling.                                                                 |
| `expires-at-ms`    | Non-negative Unix time in milliseconds. The override is inactive when the observation time is at or after this value.     |

The tuple `(provider, selector-kind, selector)` must also be unique, including provider-agnostic selectors. Active exact overrides take precedence over every glob. Within each selector kind, provider-scoped overrides precede provider-agnostic ones; matching globs rank by non-wildcard byte count. Equal-ranked globs are an ambiguity error, never resolved by declaration order. When no observation time is supplied, an expiring override remains active.

### Suffix collapse

The single collapse vocabulary has this grammar:

```kdl
collapse {
    thinking-suffix "-thinking"
    pair-token "thinking" "reasoning" "reasoner"
    effort-suffix "-minimal" tier="minimal"
    effort-suffix "-max" tier="max" except-bare-prefix="qwen"
    effort-lane-suffix "-fast" "cursor" bare-prefix="cursor-grok"
    effort-family "cursor" "gpt-5.6-luna"
    routing-variant-suffix "-wm" "openai-codex" "openai-codex-device"
    variant-family "devin" "claude-opus-5" name="Claude Opus 5" { /* reviewed routing */ }
    variant-family "google-antigravity" "gemini-{rev}-flash" name="Gemini {rev} Flash" revision=">=3.6" { /* per-revision template */ }
    provider-alias "devin" "opus" "claude-opus-5"
}
```

`variant-family` declares one reviewed provider-scoped collapsed family: positional provider and logical id, `name=` display name, and a body of `members "a" "b" …` (wire ids in priority order), `route "<tier>" "<wire-id>"` per effort tier (`off` included), and optional `mode`, `efforts`, `default-level`, `default-member`, `retired-members`, `effort-budget "<tier>" <n>`, `requires-effort`, `suppress-when-off`, `no-thinking`, `preserve-absent-effort-routes`, and `extra-aliases`. A `{rev}` placeholder in the logical id makes the node a **template**: it is instantiated once per revision found in live ids (`gemini-{rev}-flash` matches `gemini-3.8-flash-low` → family `gemini-3.8-flash`), every wire id in the body and the `name=` carry the same placeholder, and an optional `revision=` constraint (`">=3.6"`) bounds the generations it applies to. A concrete family with the same instantiated id wins over the template. `provider-alias` maps one provider-scoped selector spelling onto a logical id without making it a family member.

`thinking-suffix` accepts one non-empty suffix and no properties. `pair-token` declares bounded (possibly infix) tokens naming the thinking sibling of a live bare twin (`sonar-reasoning-pro` beside `sonar-pro`); it drives thinking-pair derivation only — never identity suffix collapse — and negated `no-`/`non-` forms never match. `effort-suffix` additionally requires `tier` with one of the effort values above, and may have `except-bare-prefix`. `routing-variant-suffix` takes one non-empty suffix followed by one or more provider IDs: a wire identifier carrying the suffix on one of those providers is a **routing variant** of its plain identifier — discovery derives base-model metadata from the plain bundled SKU while keeping the suffixed wire identifier for requests; routing variants never participate in effort collapse. `effort-lane-suffix` takes one non-empty lane suffix followed by one or more provider IDs, plus an optional `bare-prefix` gate: on a declared provider, an identifier ending in the lane suffix collapses the effort suffix wedged before the lane token while keeping the lane on the logical id. `effort-family` takes a provider, the canonical logical id, and zero or more exact aliases that fold onto it.

### Discovery vocabulary

```kdl
discovery {
    recover-canonical-params "gmi-cloud"
    borrow-responses-route "opencode-go" "opencode-zen"
    billing-variant-suffix "-free" "-contributor"
    trailing-marker "nitro" "fp8"
    reference-only-trailing-marker "search"
    pro-reasoning-alias "openai" "gpt-5.6-luna" "gpt-5.6-sol" "gpt-5.6-terra"
    pro-reasoning-sweep "openai" "openai-codex"
    canonical-family-token "claude" "gemini" "gpt"
    wrapper-prefix "duo-chat-"
    synthetic-prefix "hf:"
}
```

`recover-canonical-params` names providers whose runtime discovery recovers intrinsic base-model parameters from the bundled canonical reference index. `borrow-responses-route` declares sibling-gateway groups whose bundled catalogs hint the responses route; a provider may belong to at most one group. `responses-route-models` pins exact ids onto a provider's responses route. `billing-variant-suffix` declares suffixes (`-free`, `-contributor`) that share a transport with their base id; nothing else — pricing in particular — is derived from the base SKU.
`trailing-marker` declares routing/quantization markers (`[-:]<marker>$`) a reseller appends without changing model identity; `reference-only-trailing-marker` markers are stripped only when recovering bundled metadata for a proxied id, never during canonical coalescing. `pro-reasoning-alias` names the reviewed base ids the generator projects `-pro` reasoning aliases from, per provider; `pro-reasoning-sweep` names providers swept for stale generated aliases during regeneration.
`canonical-family-token` lists the vendor-lineage tokens that anchor generator-side canonical-family extraction and attached-version separator insertion (`gpt5` → `gpt-5`) — deliberately broader than the class taxonomy so open-weight lineages without a compat class still coalesce. `wrapper-prefix` and `synthetic-prefix` declare reseller wrapper (`duo-chat-`) and synthetic namespace (`hf:`) prefixes stripped during canonical candidate expansion; the candidate-generation and scoring algorithms stay in `scripts/equivalence.ts`, but every authored token they consume lives here.

## Cascade grammar

A cascade document starts with `class`, `provider`, or `on-api`. Root `on-api` declares a transport contract independent of model identity and provider name. Every selector adds a conjunct to the current rule. `on` scopes by deployment provider; `on-api` scopes by request adapter, including custom provider names; `on-upstream` scopes by the actual upstream selected behind that deployment. An upstream never changes the deployment provider or imports that upstream's direct-host rules. Axis directives may appear directly in any permitted scope, and nested selector blocks may appear alongside them.

```kdl
class "gemini" {
    on-api "google-generative-ai" {
        revision ">=3" {
            requires-skip-thought-signature #true
        }
    }
    on "google" "google-vertex" "openrouter" {
        family "flash" {
            revision ">=2.5 <3.8" {
                thinking-efforts "minimal" "low" "medium" "high"
            }
        }
    }
}
provider "openrouter" {
    thinking-format "openrouter"
    models "openai/o1:batch" "vendor/*-reasoning" priority=10 {
        thinking-requires-effort #true
    }
}
```

### Selectors and nesting

| Selector   | Form                                     | Matching semantics                                                                                                                                                             |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `class`    | `class "id" { ... }`                     | Exact class ID. At document root it may contain `on`, `on-api`, `family`, `revision`, and `models`. Under `provider` it may contain `family`, `revision`, and `models`.        |
| `provider` | `provider "id" { ... }`                  | Exact provider ID. It is root-only and may contain `class`, `on-api`, and `models`.                                                                                           |
| `on`       | `on "provider-a" "provider-b" { ... }`   | One or more provider IDs, combined as OR. It is allowed under a root `class`, and may contain `on-api` to conjoin an API scope plus `family`, `revision`, and `models`. |
| `on-api`   | `on-api "adapter-a" "adapter-b" { ... }` | One or more request adapter IDs, combined as OR. At document root it may contain `class` and `models`; under a root `class` (directly or nested inside `on`) or `provider` it may contain `family`, `revision`, and `models`. |
| `family`   | `family "id" { ... }`                    | Exact classified family ID. It may contain `revision` and `models`. A target with no family does not match.                                                                    |
| `revision` | `revision ">=2.5 <4" { ... }`            | A non-empty, whitespace-separated conjunction of comparisons. It may contain `models`. A target with no revision does not match.                                               |
| `models`   | `models "id" "vendor/*" { ... }`         | One or more alternatives, combined as OR. It may contain only `on-upstream`. `token="name"` matches an ASCII-case-insensitive token bounded by non-alphanumerics.                 |
| `on-upstream` | `on-upstream "a" "b" { ... }`        | Exact selected upstream IDs, combined as OR. Allowed inside any selector scope once; preserves the containing scope's other permitted children. Absent upstream never matches. |

Every selector scope may additionally contain `on-upstream`; it cannot replace an already constrained upstream. Class, provider/`on`, `on-api`, `on-upstream`, and family values are compared exactly and case-sensitively to the structured resolve target. Revision operators are `>=`, `>`, `<=`, `<`, and `=`; operands have one to three dot-separated unsigned 8-bit components, omitted components zero.

An `on-api` nested inside `on` under a class requires both the selected provider and request adapter; values within each selector remain alternatives.

A `models` string without `*` is an exact, case-sensitive match against the provider-relative model identifier. A string containing `*` is an anchored, ASCII-case-insensitive wildcard match. Prefer taxonomy ranks; retain exact/glob lists only when they isolate the census member set exactly, and keep a `// residue:` comment explaining why ranks do not.

A row whose own id classifies as `unknown` but whose `requestModelId` does not resolves under the wire id: classification and `models` matching both use it, so the model the row sends gets its own rules. Devin Fusion pairings (`fusion-<lead>-sidekick-*`) resolve as their lead this way.

`priority=N` is an optional signed integer property on the block that owns axis assignments. Its default is zero. Use it only to resolve an intentional equal-specificity overlap; do not use it to encode declaration order.

`buildDiscoveredModel(spec, providerType)` resolves the catalog `discovery-api` axis before materializing compatibility. It preserves the credential-bearing provider ID and records `providerType` as the backend used for provider selectors on subsequent rebuilds. Ordinary `buildModel` preserves its input API. This lets custom-named llama.cpp deployments reuse the same rules without model-specific discovery code.

`resolveModelPolicy(spec, { upstream })` resolves the selected route without mutating the model identity. Call it again when retry routing selects another upstream. Its typed `request` record carries request-shaping axes (reasoning history, disabled-effort semantics, Anthropic thinking mode, Responses options, and Google thinking dialect); shared transport fields remain in `compat`. Both records use the same per-axis cascade, precedence, ambiguity checks, and upstream-aware cache key. Request fields have the `request` applicability record in `axes.ts`, so they do not leak into shared transport compat objects. See [`providers/factory-droid.kdl`](providers/factory-droid.kdl) for the upstream-scoped consumer.

### Axis vocabulary and value shapes

The directive vocabulary is closed and lives in **`src/compat/axes.ts`** — one table mapping each kebab-case directive to its resolved camelCase field, namespace (`wire` / `thinking` / `catalog`), value shape, applicable compat records, and (for enums) accepted values. The compiler rejects unknown directives and out-of-vocabulary values against that table; consult it rather than a duplicated table here.

The three value shapes are:

- **Scalar**: exactly one KDL boolean, integer, float, or string argument and no children. `#null` is rejected.
- **Array**: one or more scalar arguments and no children; it resolves to a JSON array. Axes marked `emptyArray` in `axes.ts` also accept a bare directive, which assigns an explicit empty list (`region-upstreams-eu` with no arguments: the region never serves the model). Bare `thinking-efforts` keeps a reasoning-capable deployment without selectable effort tiers off the effort dial.
- **Object**: no arguments and a child block, including an empty block. Child names are kebab-case: an axis-directive spelling compiles to its resolved axis key (`template-reasoning-effort` → `qwenTemplateReasoningEffort`), anything else converts mechanically (`input-threshold` → `inputThreshold`); camelCase names are a compile error. `extra-body` payloads (top-level or nested) are the exception — their child names are literal wire JSON keys copied verbatim (`enable_thinking`). Each child is either one scalar or another object; arrays are not representable inside an object payload.

A rule cannot assign the same resolved axis twice in one block.
One object axis carries a computed form: `long-context-cost` accepts either the absolute rates (`input-threshold` + `input`/`output`/`cache-read`/`cache-write`) or `input-threshold` + `multiplier` (with optional `input-threshold-inclusive`, and `output-multiplier` when the tier raises output by a different factor than the other legs), which derives the tier from the row's base price at build time, after `cost-patch` and `cost-fallback`, so the rule tracks upstream list-price updates (xAI's SuperGrok 200K tier). Rows without a token price carry no tier. An empty `long-context-cost {}` adds no tier; a more specific rule uses it to opt a host out of a broader rule's band (GitHub Copilot's Haiku 5.5 rows, whose long tier is the `-1m` sibling).

`cost-patch` and `cost-fallback` accept an optional `effective-rates` block of named dated cards, each with a distinct ISO UTC `effective-from` (`YYYY-MM-DDTHH:mm:ssZ` or with three fractional-second digits) and any of `input`/`output`/`cache-read`/`cache-write` as nonnegative rates; a malformed card fails `buildModel` rather than leaving the old price in force. A card overwrites those legs from its date: for `cost-patch` over whatever upstream reports, for `cost-fallback` only when it seeded the row. A patch may carry the dated cards alone, leaving the upstream price in place until the first one starts; pin the current price beside them when upstream may later report the new one, or a row built after that loses the earlier period (Gemini 4 Argon's 2026-12-01 list-price increase in [`classes/gemini.kdl`](classes/gemini.kdl) pins both). `buildModel` sets the row's legs to the card due when it is built, and compiles every price period into `ModelCost.timeBased.effectiveRates` (complete cards, long-context tier and cache-rate derivations included, with a leading card for the price before the first change) under a schedule with no peak windows and a 1x off-peak multiplier. Requests are therefore priced at the card in force when they were made, even on rows built before a change (bundles, caches, long sessions); price displays read `getEffectiveTokenCost`, which selects the same card, and such a schedule reports no peak/off-peak period. Rebuilding a row that already carries such a schedule (dynamic merges, overrides) starts from the card due at the rebuild, and Cursor lanes priced from a sibling slug's card keep that card's schedule, scaled by the lane's multiplier. Cards that leave the price unchanged (a fallback the upstream price outranks) add no schedule. A rule cannot combine these cards with `time-based-cost` `effective-rates`; it may add them to a recurring `time-based-cost` tariff without its own.

`context-window-authoritative #true` preserves a host's supplied context window through runtime model selection instead of applying inferred expansion or reference-price-tier caps. Explicit user context overrides still apply afterward. It applies to rows materialized through `buildModel` (discovery and regenerated bundles). See [`providers/factory-droid.kdl`](providers/factory-droid.kdl).

`long-context-window-uncapped #true` keeps a model's `long-context-cost` tier from capping its runtime context window while extended context is off: the coding agent normally lowers the window to the tier's input threshold so compaction fires before a request crosses into premium pricing. Use it where the tier is an API-equivalent estimate on a subscription host (`xai-oauth`) or where the model is served at its full window regardless (GPT-5.4, except on GitHub Copilot). `buildModel` materializes it as `Model.longContextWindowUncapped`; explicit user context overrides still apply.

`max-tokens-fallback` seeds `maxTokens` only when the row reports none, and `max-tokens-ceiling` lowers a larger reported `maxTokens` to the host's output cap (an unknown budget stays unknown unless a fallback seeded it). Both apply in `buildModel` after `limits-patch`, so discovery mappers pass upstream output budgets through verbatim. See the Kimi rules in [`providers/fireworks.kdl`](providers/fireworks.kdl).

`inline-image-byte-budget` caps retained base64 image characters for a deployment's request body. It leaves room for tool schemas and text beneath the provider's body-size limit; the coding agent reads it through `resolveInlineImageByteBudget` before sending live history, and snapcompact gives its archive frames half of it (`frameDataBytesBudget`). The budget applies only while the request reaches the host the rules describe (the Anthropic API, first-party OpenAI, the Codex backend at its default URL, or Factory Droid's own global or EU API host), which callers decide with pi-ai's `reachesBudgetedHost`: `compat.officialEndpoint` for the configured `baseUrl`, for first-party Anthropic models also the `ANTHROPIC_BASE_URL` or Foundry `FOUNDRY_BASE_URL` reroute applied at request time, and for Factory Droid models the `baseUrl` origin. A custom or rerouted endpoint imposes its own body limit.

`request-body-byte-limit` is the largest request body the host accepts (Factory Droid's hosted routes: 4,500,000 bytes), under the same gate. Where it is set, the byte clamp keeps the inline images of the newest user message and then of the newest image-bearing tool result even past `inline-image-byte-budget`, each only while the kept images fit the limit less the request's other serialized bytes, and evicts older images instead; read through `resolveRequestBodyByteLimit`.

`catalog-endpoint-budgets #true` makes these host budgets apply whenever a request reaches the provider's own catalog endpoint (an unset `baseUrl`, or an `endpoint-hosts` host; see `isCatalogEndpointUrl`), for a hosted gateway such as Factory Droid whose compat names no official endpoint. Unassigned, they apply only on the official endpoint.

`image-count-budget` is the most images one request may carry, archive frames, screenshots and imaged tool results combined. The coding agent reads it through `resolveImageCountBudget`, drops the oldest images past it, and caps snapcompact frames at it; unassigned hosts get a floor of 5. `official-image-count-budget` replaces it while the request reaches the host the rules describe (same gate as `inline-image-byte-budget`), for limits established on the host's own endpoint (Anthropic: 600, 100 on 200k-window models; Codex: 2,000); a custom or rerouted endpoint keeps `image-count-budget` (Anthropic 90, Codex 200).

`endpoint-hosts` lists the HTTPS hostnames a provider serves besides its bundled base URL's host, such as Copilot's per-plan `api.<plan>.githubcopilot.com` hosts. That host plus these define the provider's own endpoint (`isCatalogEndpointUrl`), which separates first-party traffic from a custom model or provider override that keeps a catalog provider id but points `baseUrl` at a gateway, proxy, or local server. Connection prewarming and request compression act only on the provider's own endpoint.

`request-encodings` lists the `Content-Encoding`s (`zstd`, `gzip`) a provider's own endpoint decodes on request bodies, most preferred first; pi-ai's `wrapFetchForRequestCompression` reads them through `resolveRequestCompression` and compresses bodies of 1 KiB or more. A proxy, relay, or `ANTHROPIC_BASE_URL` reroute never receives bytes it cannot read. `request-encoding-rejection` is a regular expression for the JSON 400/415 error body the host returns when it cannot decode the body; unassigned, every JSON 400/415 is re-checked with an uncompressed resend. A 400/403/415 whose body is not JSON (empty included) is presumed to come from a proxy in front of the host, such as a TLS-inspecting gateway that refuses compressed uploads, and is re-checked either way, until the uncompressed resend draws the same status from that host. A rejected encoding is dropped for that host only after the uncompressed resend succeeds. Assign them only from a live probe of every endpoint host: a compressed body, the same plain JSON mislabeled as compressed (a decoding host must reject it), and a real request.

`judgment-questions-max` is the most questions one System One judgment request may carry (razorback16/openjev: 256; Cloudflare Clef on Workers AI and through OpenRouter Decisions: 64; unidentified `*openjev*` deployments: 16). The coding agent reads it through `resolveJudgmentQuestionsMax` and `NativeJudge` splits larger requests into parallel chunks; unassigned means the endpoint takes any batch size. [`providers/judgment-questions.kdl`](providers/judgment-questions.kdl) lists the servers verified uncapped or not isolatable.

`judgment-image-input` assigns model-specific native judgment image bounds, read through `resolveJudgmentImageInput`. Its object accepts `mime-types` as a comma-separated lowercase MIME list and positive integer `max-count`, `max-bytes`, `max-total-bytes`, `min-pixels`, `max-pixels`, `min-side`, and `max-side`; byte limits count decoded data. `NativeJudge` enforces these alongside its wire's encoding constraints without resizing, and candidate filtering skips models whose bounds reject the images. Unassigned adds no model-specific bounds. The Jev selectors in [`providers/typesafe.kdl`](providers/typesafe.kdl) and [`providers/openrouter.kdl`](providers/openrouter.kdl) own Jev's limits rather than imposing them on every model using those APIs.

`prompt-cache-lookback` is how many block positions back from a cache breakpoint the model's prompt cache looks for an earlier request's entry (Claude: 20, counting the breakpoint; a run of consecutive `tool_use` or `tool_result` blocks is one position). The coding agent reads it through `resolvePromptCacheLookback` and keeps warm-cache tool-result pruning inside the window; unassigned means no known bound.

`prompt-cache-persistent #true` marks a provider whose own endpoint keeps prompt-cache entries indefinitely (logged-in Codex accounts). The coding agent reads it through `isPromptCachePersistent` and skips idle compaction, which would only discard a prefix that stays warm; a custom `baseUrl` reusing the provider id does not qualify. Unassigned means entries expire.

`task-sibling-prompt-cache #true` lets Task children use an automatically derived sibling cache key on the matching request model. Missing or `#false` keeps the provider's per-child default; explicit cache keys still win. The session resolves this catalog policy against the actual model for primary turns, handoff, and ephemeral requests that reuse the live context, including model changes, without sharing conversation IDs or response state. The automatic candidate is persisted separately from explicit keys and survives full forks, `/tan`, and session reopening; new and partial sessions discard it. A fork carrying an automatic candidate uses its own conversation ID on unsupported models, and re-enables the candidate when returning to an eligible model. Ordinary forks without an automatic candidate keep their existing inherited cache routing. Conventional compaction keeps its existing cache routing because its serialized summary prompt differs from the primary context. The opt-in covers Muse Code's `muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-wonder-1.0`, `muse-wonder-1.0-contributor`, `muse-wonder-full-1.0`, and `muse-wonder-full-1.0-contributor` over `openai-responses`. Meta documents shared-prefix `prompt_cache_key` routing for Responses. Warmed sibling cache reuse was measured on Spark 1.3 Contributor; the standard Spark variant shares this scope following maintainer guidance. A bounded synthetic probe observed cache reuse on all four Wonder variants; it does not establish production or latency benefits. Auxiliary-request latency has not been measured. Provider selectors also match custom providers that declare the same `providerType`; no benefit is established for custom endpoints.

`image-max-edge` is the longest image edge, in pixels, a host passes to the model; it downscales larger images to fit first (Cursor: 1024 for Claude and GPT). Snapcompact reads it through `resolveImageMaxEdge` and renders frames no wider, so their glyphs reach the model at the size they were drawn; unassigned means the host keeps the image's size.

`snapcompact-image-reads #true` opts a reader in to getting a fresh `read` result as snapcompact frames when `snapcompact.toolResults` is on. Frames collapse whitespace, so snapcompact draws each row's leading indentation as a count bracket (`[»2]`, `[·4]`) and keeps the `[path#TAG]` header as text beside them. On 3–4 frame reads Opus 5.5 then made exact first edits from frames within one of text (38 vs 39 of 40), so Opus 5.5+ opts in ([`classes/anthropic.kdl`](classes/anthropic.kdl)); Sonnet 5.5 (37 vs 40) and Haiku 5.5 (35 vs 40) still miscounted deep tab indents. Unassigned: `read` results stay text; other tools' results are imaged either way.

The routed-subscription registry axes (`upstream-rotation`, `region-upstreams-global|us|eu`, `region-limits-eu`, `credit-rates`, `list-price-from`, `routing-family`, `policy-aliases`, `entitlement`, `default-reasoning-off`) describe a gateway whose proxy fans one model out to several upstreams. They are read through `src/compat/factory-droid.ts` by Factory Droid discovery and its request provider, not materialized by `buildModel`. A provider-wide `region-upstreams-*` rule is the upstream serving table and a model rule replaces it for that region. `list-price-from "<provider>" ["<id>"]` shows a bundled row's list price beside the subscription's own billing; unlike seed values it is resolved at runtime and degrades to the seed's zero cost when the row is gone. See [`providers/factory-droid.kdl`](providers/factory-droid.kdl), whose wire and billing pool per model are `api-routes` and `quota-tiers` rules in `runtime/behavior.kdl`.

### Time-based pricing

The catalog object axis `time-based-cost` materializes into `ModelCost.timeBased`. It uses **named child objects**, not KDL arrays or repeated anonymous windows. For example, inside a matching provider/model scope:

```kdl
time-based-cost {
    off-peak-multiplier 0.5
    peak-windows {
        morning {
            weekdays "1,2,3,4,5"
            start-minute 60
            end-minute 240
        }
        afternoon {
            weekdays "1,2,3,4,5"
            start-minute 360
            end-minute 600
        }
    }
    effective-rates {
        flash-pricing {
            effective-from "2026-09-14T04:00:00Z"
            input 0.30
            output 1.20
            cache-read 0.006
            cache-write 0
        }
    }
}
```

`morning`, `afternoon`, and `flash-pricing` are arbitrary unique object names, discarded when the payload is normalized into arrays. `weekdays` is a comma-separated string of distinct UTC weekday numbers (`0` = Sunday through `6` = Saturday), without spaces. Each window has integer minutes with `0 <= start-minute < end-minute <= 1440`; its start is inclusive and end exclusive. Split overnight windows across days. Outside the union of peak windows, the nonnegative `off-peak-multiplier` applies to token costs.

`effective-rates` is optional. Each entry requires a distinct valid ISO UTC `effective-from` (`YYYY-MM-DDTHH:mm:ssZ` or with three fractional-second digits) and all four nonnegative per-million-token rates. The latest entry at or before the request timestamp replaces the entire base card; before the first entry, the base card applies. An entry may contain a `long-context` object with `input-threshold`, optional `input-threshold-inclusive`, and all four absolute rates. Effective rates do not inherit the base card's long-context tier. Selection order is effective card, context tier, then tariff multiplier.

The recurring schedule and dated DeepSeek transition above come from [DeepSeek's official pricing](https://api-docs.deepseek.com/quick_start/pricing); see `providers/deepseek.kdl` for the complete rules and [the catalog API](../../../README.md#cost-calculation) for timestamp semantics. This is catalog policy metadata, not a supported schedule syntax for the coding agent's `models.yml`.

### Precedence and ambiguity

Rules resolve independently per axis. A matching rule is ranked by:

```text
(model-selector exactness, constrained-dimension count, priority)
```

The tuple is compared lexicographically, greatest first:

- model exactness is `2` when any matching `models` selector is exact, `1` when the best matching selector is a glob or token, and `0` when the rule has no `models` selector;
- dimension count is the number of present dimensions among class, provider/`on`, API/`on-api`, upstream/`on-upstream`, family, revision, and models;
- priority is the local block's `priority`, defaulting to `0`.

The highest-ranked matching assignment wins for that axis. Two distinct rules that tie on all three components and assign the same axis are an ambiguity error even if their values are equal. File and declaration order never resolve the tie; add an explicit priority only after confirming the overlap is intentional.

### Capability gating

Wire axes are considered for every matching target. Thinking axes require `reasoning`, except that an exact model selector declaring `thinking-efforts` opens the gate for reviewed corrections. A winning `thinking-upgrade-neutral #true` scoped to a recognized class, family, revision, or model selector also opens it when a matching effort ladder exists; provider-wide opt-in alone does not. Materializing a neutral spec as reasoning-capable requires that opt-in and no explicit thinking vocabulary. A winning `thinking-unverified #true` (scoped `class "unknown"` on hosts whose model list carries no capability metadata) instead offers an unclassified neutral spec its ladder as `ThinkingConfig.unverified`: off until the user picks an effort, and sent as non-reasoning without one; it never changes compat. Family and revision selectors never match targets missing that rank. An unmatched target resolves to empty maps; the cascade does not infer negative capabilities from absence.

## Runtime behavior grammar

`runtime/behavior.kdl` has one root `behavior` node. Child node kinds (all optional, strict shapes):

```kdl
behavior {
    openai-responses-heuristic {
        include-prefix "gpt-" "o1"
        exclude-prefix "whisper-"
        exclude-substring "embedding"
    }
    model-operations provider="openai" { exact "o3"; prefix "gpt-"; operation "generate_image" }
    cursor-effort family-marker="gpt-" { tier "minimal" "low" "medium" "high" "xhigh" "max" }
    cursor-model-parameter model="composer-2.5" id="fast" value="false"
    quota-tiers provider="openai-codex" {
        tier "spark" "gpt-5.3-codex-spark"
        fallback "chat" substring="gpt-"
    }
    hosted-default provider="zai-search" model="glm-4.7"
    api-routes provider="cloudflare-ai-gateway" {
        route "anthropic-messages" prefix="anthropic/" strip-prefix=#true
        route "openai-completions" prefix="openai/" strip-prefix=#true
    }
    model-limits provider="github-copilot" { limits "gpt-5.6" context=272000 max-tokens=128000 }
    exclude-discovery-modes "embedding" "moderation" provider="litellm"
    exclude-models provider="nanogpt" substring="embed" substring="tts"
    plan-requirement provider="openai-codex" { tier "pro" substring="-spark" }
    retry-reset-timezone provider="zai" offset="+08:00"
    pricing-peer provider="google-antigravity" peers="google" "google-vertex" {
        alias "gemini-3-pro" peer-id="gemini-3-pro-preview"
    }
    role-defaults "smol" {
        model "claude-haiku-5-5"
        model "openai-codex/gpt-5.3-codex-spark"
    }
}
```

`exclude-discovery-modes` takes one or more exact, case-sensitive upstream mode strings plus `provider=`; discovery mappers preserve missing, malformed, and unknown modes unless the provider policy explicitly lists them. Matcher properties on `route` / `exclude-models` / `tier` nodes are `exact=` / `prefix=` / `substring=` / `glob=`, repeatable. `strip-prefix=#true` on a prefix route strips the matched prefix off the wire id. Values are copied verbatim from the TS constants they replaced; runtime accessors live in `src/compat/behavior.ts`.

`role-defaults "<role>"` declares one agent role's built-in default model selector chain, one `model "<selector>"` child per entry, most preferred first. Selectors are copied verbatim (`provider/id`, bare ids, fuzzy fragments such as `-mini`, and `@role` references); duplicates within a role and repeated roles are compile errors. `roleDefaultModels()` returns every chain keyed by role in declaration order.

## Auth grammar

Every provider has exactly one `auth "<id>" { … }` node under `auth/`; `auth/_order.kdl` holds a single `login-order "id" …` node pinning the `/login` roster order (every provider with a `login` and `show-in-login-list` unset/true must appear; providers without a login sort alphabetically after it). Runtime accessors live in `src/compat/auth.ts`; the id unions in the generated `src/compat/auth-ids.ts`. Every provider in `provider-models/descriptors.ts` needs an auth node (`@oh-my-pi/pi-ai` type-checks this).

```kdl
auth "anthropic" {
    name "Anthropic (Claude Pro/Max)"
    env hook="anthropic-foundry"                 // or: env "ANTHROPIC_OAUTH_TOKEN" "ANTHROPIC_API_KEY"
    login "oauth-code" {
        client-id "OWQxYzI1…" encoding="base64"  // env="VAR" adds an override; child `env "A" "B"` an ordered list
        base-url "https://api.example" { env "X_BASE_URL" }      // optional; `{base}` placeholder (API origin)
        auth-url "https://auth.example" { env "X_AUTH_URL" }     // optional; `{auth}` placeholder for authorize/token/userinfo
        authorize-url "https://claude.ai/oauth/authorize"
        scopes "org:create_api_key" "user:profile"      // separator=" " default
        pkce #true
        state "hex"                              // hex | uuid | none
        authorize-params { code "true" }         // standard=#false drops client_id/response_type/redirect_uri/scope/PKCE/state
        instructions "Complete login in your browser…"
        callback port=54545 path="/callback" hostname="localhost" redirect-uri="…" redirect-uri-env="VAR" port-fallback=#true manual-only=#false native-scheme=#false
        token url="https://api.anthropic.com/v1/oauth/token" body="json" { params { state "{state}" } headers { X "y" } }
        credential {
            access "access_token"                // dot path; `claim="a|b"` reads JWT claims; `literal="…"` pins a value
            refresh "refresh_token"
            expires "seconds" path="expires_in" from="created_at" skew-ms=300000 fallback-ms=3600000   // or `expires "jwt" fallback-ms=N` / `expires "never"`
            email "account.email_address"        // also account-id, org-id, org-name, project-id, api-endpoint, enterprise-url
        }
        userinfo url="https://…/userinfo" email="email" account-id="sub"
        after-exchange hook="anthropic-identity"
        paste-key prefix="sk-or-" validate-url="https://…"   // manual input starting with prefix is an API key
    }
    refresh {                                   // or `refresh "none"` / `refresh hook="name"`
        token url="…" body="json" { headers { anthropic-beta "oauth-2025-04-20" } }   // defaults to the login token request
        require "projectId"
        credential { … }                        // defaults to the login map
        after-refresh hook="…"
    }
    store-as "openai-codex"                      // persist under another provider id
    callback-port 54545                          // defaults to the oauth-code callback port
    paste-code #true                             // defaults to #true for oauth-code logins
    api-key-format "structured"                  // bearer (default) | structured (JSON credential as API key)
    expiry "jwt-or-never"                        // session-JWT expiry policy
    result "api-key"                             // OAuth login persists only credentials.access as a plain API key
    allows-missing-api-key #true
    org-scoped-identity #true                   // qualify credential/report identity by org (one email can have multiple subscriptions)
    oauth-token-env "PROVIDER_OAUTH_TOKEN"      // dedicated OAuth bearer env vars, excluding borrowed API-key aliases in provider env
    native-auth-api "bedrock-converse-stream"     // provider transport resolves auth; scan plans pin this API without secrets
    available #false
    show-in-login-list #false
}
```

`org-scoped-identity #true` keeps credentials and usage reports for different organizations separate even when they share an email; absent or `#false` uses ordinary account identity. `oauth-token-env` takes one or more ordered, non-empty env names carrying this provider's own OAuth bearer. When present, availability ignores other provider-env aliases, and usage probes accept only stored OAuth credentials or the first set bearer from that list; absent providers keep the ordinary API-key env behavior.

Login kinds:

- `login "api-key" { auth-url "…"; instructions "…"; prompt "…" placeholder="…"; empty-fallback "…"; normalize "strip-bearer"; validate … }` — `validate "chat-completions" base-url= model= tolerate-model-denied= max-tokens-field= max-tokens=`, `validate "anthropic-messages" base-url= model=`, or `validate "models-endpoint" url= base-url-env= headers-hook=`; all accept `label=` (error-message label, defaults to `name`), `optional=#true` (only auth failures reject), and `trust-forbidden=#true` (requires `optional=#true`; a 403 no longer rejects, so only a 401 does).
- `login "oauth-code" { … }` as above; `token`/`refresh` `params` values may use `{code}`, `{state}`, `{redirect_uri}`, `{code_verifier}`, `{client_id}`, `{client_secret}`, `{refresh_token}`, `{scope}`; the standard grant parameters are sent unless `standard=#false`.
- `login "device-code" { client-id …; base-url "…"; scopes …; headers-hook "…"; device url="{base}/…" body="form" { params {…} headers {…} }; token url="…" url-hook="…"; response user-code= device-code= verification-uri= verification-uri-complete= interval= expires-in=; instructions "Enter code: {user_code}"; credential {…}; userinfo …; after-exchange hook=… }`.
- `login "custom" hook="name"` — the whole flow is a named `@oh-my-pi/pi-ai` hook (`src/registry/hooks/custom.ts`).

Hook names are validated against the hook tables in `@oh-my-pi/pi-ai/src/registry/hooks` by that package's `auth-hooks-registry` test. Values marked `encoding="base64"` are public OAuth client ids stored obfuscated to keep secret scanners quiet; they are decoded at runtime.

## Provider catalog grammar

The root `provider "<id>"` node of `providers/<id>.kdl` carries the catalog entry next to the cascade rules. A file that declares `default-model` is a catalog provider (a member of the generated `KnownProvider` union in `src/compat/provider-ids.ts`); a file without it is wire-compat only (custom provider ids such as `llama.cpp`) and may not carry any other entry node. The compiled entries live in `rules.json` under `providers`, keyed by id; runtime accessors are in `src/compat/providers.ts`, and `provider-models/descriptors.ts` pairs each entry with its model-manager factory — the only provider fact that stays in code.

```kdl
provider "sakana" {
    default-model "fugu"                          // required for a catalog entry
    env "SAKANA_API_KEY" "FUGU_API_KEY"           // runtime API-key env fallback, in order
    dynamic-models-authoritative #true            // discovery replaces bundled rows
    allow-unauthenticated #true                   // runtime manager without a key
    skip-cross-provider-reference-fills #true     // generator never backfills from same-id rows elsewhere
    keep-bundled-names #true                      // discovery never renames a bundled row
    discovery label="Sakana AI" oauth-provider="sakana" allow-unauthenticated=#true {
        env "SAKANA_GEN_KEY"                      // generation-time keys; defaults to the provider env
    }
    seed api="openai-responses" base-url="https://api.sakana.ai/v1" bundle="fallback" {
        model "fugu-ultra" name="Fugu Ultra" {
            reasoning #true
            input "text"
            cost input=5 output=30 cache-read=0.5 cache-write=0
            limits context=1000000                // max-tokens omitted → null
            thinking-mode "effort"                // thinking-* axes → row.thinking
            thinking-efforts "high" "max"
            include-encrypted-reasoning #false    // wire axes → row.compat
        }
    }

    // cascade rules follow, as before
    include-encrypted-reasoning #false
}
provider "muse-code" {
    default-model "muse-spark-1.3"
    seed api="openai-responses" base-url="https://api.meta.ai/v1" {
        models-from "meta"                        // copies meta's seed rows under this provider
    }
}
```

Only `discovery` enrolls a provider in `generate-models.ts`; providers without it are never fetched at generation time (see the `charm-hyper` entry for why a live gateway deliberately omits it).

`automatic-default #false` keeps a provider available for explicit selection but excludes it from startup fallback and automatic model presets. The default is `#true`; `apple` opts out because its on-device context cannot accommodate the standard coding-agent prompt in many projects.

`kind-apis { <kind> "<api>" }` maps each non-chat kind (`image`, `tts`, `stt`, `embedding`, `rerank`, `video`) to the API discovery assigns rows of that kind. A runner API must sit under the kind it serves (`RUNNER_API_KINDS` in `src/types.ts`); chat APIs, which serve hosted image generation, and multi-kind `local-inference` may back any kind.

### Seed rows

A `seed` _defines_ bundled rows for providers whose catalog cannot be discovered at generation time — credential-scoped rosters, unauthenticated regens, or models ahead of upstream catalogs. Every other stratum patches rows; this one authors them. Runtime model managers hand the rows to `staticModels` through `seedModels(provider)`; the generator bundles them per the seed's `bundle` policy. Values are literal — a seed never derives from another provider's row, and pricing is never borrowed.

`seed` properties: `api` and `base-url` are per-row defaults (a `model` may override either with the same property names); `bundle` defaults to `always`; `precedence="seed"` is optional. `model` takes the row id positionally, requires `name=`, and its body MUST declare `reasoning`, `input` (`"text"` and/or `"image"`), `cost` (all four per-million rates), and `limits` (`context=` / `max-tokens=`, an omitted limit is `null`); `supports-tools #true` is optional, and `request-model-id "<wire id>"` sets the row's `requestModelId` when the upstream id differs from the row id (an OpenAI Decisions judge row beside the same-id chat model). Any other directive is an axis from the cascade vocabulary: thinking axes become the row's explicit `thinking` (then `thinking-mode` and `thinking-efforts` are both required), wire axes become its explicit `compat` and must apply to the row's API, and catalog axes are rejected because they stay rule-owned in the cascade block. Explicit `thinking`/`compat` on a seed row win over the cascade exactly as they do for any authored spec.

`bundle` decides when the generator includes the rows:

| Policy     | Rows enter the bundle                                                     |
| ---------- | ------------------------------------------------------------------------- |
| `always`   | Every regeneration. Same-id upstream/discovery rows win dedup.            |
| `fallback` | Only when the provider's authoritative catalog discovery did not succeed. |
| `empty`    | Only when no other source produced a row for the provider.                |
| `never`    | Never; the provider's runtime model manager is the only consumer.         |

`precedence="seed"` prepends the rows after the previous-snapshot merge and cross-provider reference fills, so the authored row wins dedup and same-id rows on other hosts never overwrite its name or capabilities (QwenCloud Token Plan, Meta). The default `upstream` precedence appends before the snapshot merge, so the current seed — not a stale snapshot copy — is the fallback row.

## Vendoring provenance

This tree was vendored from the o2 catalog census (`census 2026-08`), pruned of providers pi does not ship (agnes, agnes-plan, cohere, crofai, friendli, inception, ovhai, poolside, sarvam, scaleway, stepfun, stepfun-plan, yandex — provider files and `on` tokens only; class/taxonomy files remain), and re-authored where pi's baked `models.json` values are the ground truth. No provider-id renames were required.
