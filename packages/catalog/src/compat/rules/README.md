# Compatibility taxonomy and cascade

This tree is the checked-in source of model identity and compatibility policy. A **class** is a vendor lineage such as `gemini` or `anthropic`; a **family** is a product line within one class, such as `flash`, `pro`, `sonnet`, or `opus`; and a **revision** is a `major.minor.patch` triple extracted from a model name. Missing minor and patch components compare as zero.

There are three ownership strata:

- `taxonomy/*.kdl` defines identity: class membership, product families, revision extraction, reviewed exact corrections, and suffix collapse.
- `classes/*.kdl` defines model-lineage truths: behavior inherent to a model line, optionally scoped to the providers where the census established it.
- `providers/*.kdl` defines deployment contracts: behavior imposed by a host, plus documented per-model residue that taxonomy cannot express exactly.
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

| Node | Rank | Match |
| --- | ---: | --- |
| `exact "token"` | 4 | The whole bare name equals `token`. |
| `bounded "token"` | 3 | The bare name equals `token`, or starts with it followed by `-`, `_`, `.`, `:`, or an ASCII digit. |
| `namespace "token"` | 2 | A non-empty `/`-separated segment of the full identifier equals `token`. |
| `namespace "token" bounded=#true` | 2 | Split the full identifier on `/`, `.`, and `:`; a segment must satisfy the bounded rule above. This is the only matcher property. |
| `prefix "token"` | 1 | The bare name starts with `token`. |
| `glob "pattern"` | 0 | An anchored `*` wildcard match over the bare name. `*` spans any substring; all non-wildcard text remains anchored in order. |

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

`override` has properties only and no child block. Required string properties are `id` (stable, globally unique review ID), `model` (exact bare model identifier, compared case-insensitively), `rationale`, and `provenance`.

Optional properties are:

| Property | Shape and meaning |
| --- | --- |
| `provider` | Exact provider key, compared case-insensitively. A matching provider-specific override wins over a provider-agnostic one. |
| `logical` | Corrected logical model identifier. |
| `class` | Corrected class ID; a non-empty string. |
| `family` | Corrected product-family ID; a non-empty string. |
| `revision` | One to three unsigned 8-bit components separated by `.` or `-`. |
| `effort` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `thinking-variant` | Boolean marker for a separately exposed thinking sibling. |
| `expires-at-ms` | Non-negative Unix time in milliseconds. The override is inactive when the observation time is at or after this value. |

The pair `(provider, model)` must also be unique, including provider-agnostic pairs. When no observation time is supplied, an expiring override remains active.

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

A cascade document starts with `class` or `provider`. Every selector adds a conjunct to the current rule. Axis directives may appear directly in any permitted scope, and nested selector blocks may appear alongside them.

```kdl
class "gemini" {
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

| Selector | Form | Matching semantics |
| --- | --- | --- |
| `class` | `class "id" { ... }` | Exact class ID. At document root it may contain `on`, `family`, `revision`, and `models`. Under `provider` it may contain `family`, `revision`, and `models`. |
| `provider` | `provider "id" { ... }` | Exact provider ID. It is root-only and may contain `class` and `models`. |
| `on` | `on "provider-a" "provider-b" { ... }` | One or more provider IDs, combined as OR. It is allowed only under a root `class`, and may contain `family`, `revision`, and `models`. |
| `family` | `family "id" { ... }` | Exact classified family ID. It may contain `revision` and `models`. A target with no family does not match. |
| `revision` | `revision ">=2.5 <4" { ... }` | A non-empty, whitespace-separated conjunction of comparisons. It may contain `models`. A target with no revision does not match. |
| `models` | `models "id" "vendor/*" { ... }` | One or more alternatives, combined as OR. It cannot contain another selector. `token="name"` matches an ASCII-case-insensitive token bounded by non-alphanumerics. |

Class, provider/`on`, and family selector values are compared exactly and case-sensitively to the structured resolve target. Revision operators are `>=`, `>`, `<=`, `<`, and `=`; operands have one to three dot-separated unsigned 8-bit components, omitted components zero.

A `models` string without `*` is an exact, case-sensitive match against the provider-relative model identifier. A string containing `*` is an anchored, ASCII-case-insensitive wildcard match. Prefer taxonomy ranks; retain exact/glob lists only when they isolate the census member set exactly, and keep a `// residue:` comment explaining why ranks do not.

`priority=N` is an optional signed integer property on the block that owns axis assignments. Its default is zero. Use it only to resolve an intentional equal-specificity overlap; do not use it to encode declaration order.

### Axis vocabulary and value shapes

The directive vocabulary is closed and lives in **`src/compat/axes.ts`** — one table mapping each kebab-case directive to its resolved camelCase field, namespace (`wire` / `thinking` / `catalog`), value shape, applicable compat records, and (for enums) accepted values. The compiler rejects unknown directives and out-of-vocabulary values against that table; consult it rather than a duplicated table here.

The three value shapes are:

- **Scalar**: exactly one KDL boolean, integer, float, or string argument and no children. `#null` is rejected.
- **Array**: one or more scalar arguments and no children; it resolves to a JSON array.
- **Object**: no arguments and a child block, including an empty block. Child names are kebab-case: an axis-directive spelling compiles to its resolved axis key (`template-reasoning-effort` → `qwenTemplateReasoningEffort`), anything else converts mechanically (`input-threshold` → `inputThreshold`); camelCase names are a compile error. `extra-body` payloads (top-level or nested) are the exception — their child names are literal wire JSON keys copied verbatim (`enable_thinking`). Each child is either one scalar or another object; arrays are not representable inside an object payload.

A rule cannot assign the same resolved axis twice in one block.
One object axis carries a computed form: `long-context-cost` accepts either the absolute rates (`input-threshold` + `input`/`output`/`cache-read`/`cache-write`) or `input-threshold` + `multiplier` (with optional `input-threshold-inclusive`), which derives the tier from the row's live base price at build time so the rule tracks upstream list-price updates (xAI's SuperGrok 200K tier). Rows without a token price carry no tier.

### Precedence and ambiguity

Rules resolve independently per axis. A matching rule is ranked by:

```text
(model-selector exactness, constrained-dimension count, priority)
```

The tuple is compared lexicographically, greatest first:

- model exactness is `2` when any matching `models` selector is exact, `1` when the best matching selector is a glob or token, and `0` when the rule has no `models` selector;
- dimension count is the number of present dimensions among class, provider/`on`, family, revision, and models;
- priority is the local block's `priority`, defaulting to `0`.

The highest-ranked matching assignment wins for that axis. Two distinct rules that tie on all three components and assign the same axis are an ambiguity error even if their values are equal. File and declaration order never resolve the tie; add an explicit priority only after confirming the overlap is intentional.

### Capability gating

Wire axes are considered for every matching target. Thinking axes are considered only when the structured resolve target sets `reasoning` — except that an exact model selector declaring `thinking-efforts` upgrades the target (a reviewed correction to stale source capability metadata). Family and revision selectors never match targets missing that rank. An unmatched target resolves to empty maps; the cascade does not infer negative capabilities from absence.

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
    exclude-models provider="nanogpt" substring="embed" substring="tts"
    plan-requirement provider="openai-codex" { tier "pro" substring="-spark" }
    pricing-peer provider="google-antigravity" peers="google" "google-vertex" {
        alias "gemini-3-pro" peer-id="gemini-3-pro-preview"
    }
}
```

Matcher properties on `route` / `exclude-models` / `tier` nodes are `exact=` / `prefix=` / `substring=` / `glob=`, repeatable. `strip-prefix=#true` on a prefix route strips the matched prefix off the wire id. Values are copied verbatim from the TS constants they replaced; runtime accessors live in `src/compat/behavior.ts`.

## Auth grammar

Every provider has exactly one `auth "<id>" { … }` node under `auth/`; `auth/_order.kdl` holds a single `login-order "id" …` node pinning the `/login` roster order (every provider with a `login` and `show-in-login-list` unset/true must appear; providers without a login sort alphabetically after it). Runtime accessors live in `src/compat/auth.ts`; the id unions in the generated `src/compat/auth-ids.ts`. Every provider in `provider-models/descriptors.ts` needs an auth node (`@oh-my-pi/pi-ai` type-checks this).

```kdl
auth "anthropic" {
    name "Anthropic (Claude Pro/Max)"
    env hook="anthropic-foundry"                 // or: env "ANTHROPIC_OAUTH_TOKEN" "ANTHROPIC_API_KEY"
    login "oauth-code" {
        client-id "OWQxYzI1…" encoding="base64"  // env="VAR" adds an override; child `env "A" "B"` an ordered list
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
    available #false
    show-in-login-list #false
}
```

Login kinds:

- `login "api-key" { auth-url "…"; instructions "…"; prompt "…" placeholder="…"; empty-fallback "…"; normalize "strip-bearer"; validate … }` — `validate "chat-completions" base-url= model= tolerate-model-denied= max-tokens-field= max-tokens=`, `validate "anthropic-messages" base-url= model=`, or `validate "models-endpoint" url= base-url-env= headers-hook=`; all accept `label=` (error-message label, defaults to `name`) and `optional=#true` (only auth failures reject).
- `login "oauth-code" { … }` as above; `token`/`refresh` `params` values may use `{code}`, `{state}`, `{redirect_uri}`, `{code_verifier}`, `{client_id}`, `{client_secret}`, `{refresh_token}`, `{scope}`; the standard grant parameters are sent unless `standard=#false`.
- `login "device-code" { client-id …; base-url "…"; scopes …; headers-hook "…"; device url="{base}/…" body="form" { params {…} headers {…} }; token url="…" url-hook="…"; response user-code= device-code= verification-uri= verification-uri-complete= interval= expires-in=; instructions "Enter code: {user_code}"; credential {…}; userinfo …; after-exchange hook=… }`.
- `login "custom" hook="name"` — the whole flow is a named `@oh-my-pi/pi-ai` hook (`src/registry/hooks/custom.ts`).

Hook names are validated against the hook tables in `@oh-my-pi/pi-ai/src/registry/hooks` by that package's `auth-hooks-registry` test. Values marked `encoding="base64"` are public OAuth client ids stored obfuscated to keep secret scanners quiet; they are decoded at runtime.

## Vendoring provenance

This tree was vendored from the o2 catalog census (`census 2026-08`), pruned of providers pi does not ship (agnes, agnes-plan, cohere, crofai, friendli, inception, ovhai, poolside, sarvam, scaleway, stepfun, stepfun-plan, yandex — provider files and `on` tokens only; class/taxonomy files remain), and re-authored where pi's baked `models.json` values are the ground truth. No provider-id renames were required.
