# 0017. Model compatibility is compiled knowledge with explicit precedence

Status: accepted
Date: 2026-09-02
Area: inference

## Context

The control plane asks for semantic behavior ("stream this model", "force that capability",
"enforce this shape"). Inference has to translate that into what this exact model, on this exact
host, through this exact API can do. In omp v1 that translation was a pile of provider-name
booleans, and there is a before/after commit (`dd57045396`) that shows what it had become.

Before the commit, OpenAI compatibility was one 880-line file centred on a builder that opened with:

```ts
const isCerebras = modelMatchesHost(hostModel, "cerebras");
const isZai = modelMatchesHost(hostModel, "zai");
const isKimiModel = isKimiModelId(spec.id);
const isMoonshotKimi = isKimiModel && isMoonshotNative;
const isAnthropicModel =
    modelMatchesHost(hostModel, "anthropic") ||
    isClaudeModelId(spec.id) ||
    isAnthropicNamespacedModelId(spec.id);
// …then DeepSeek, Qwen, MiMo, Grok, Mistral, OpenCode, local servers
```

Booleans fed booleans, nested ternaries, and one giant `compat` object. "May Kimi force a tool while
thinking?" depended on which Kimi, which host, which API. "Is this loopback URL llama.cpp or LiteLLM
proxying something else?" got another carve-out. Every branch fixed a real provider bug; the
failure was that the same knowledge was encoded in several places at once:

- `compat/openai.ts` — 880 lines
- `model-thinking.ts` — 977 lines
- `variant-collapse.ts` — 1,776 lines
- separate Bedrock, Anthropic, and Devin compatibility builders
- more model-name detection in discovery and provider serializers

Each new quirk became another branch in four functions, and no caller could ask "what does this
model on this host support?" and get a single answer.

## Decision

Compatibility facts are data, compiled with explicit precedence. Code MUST branch on compiled
capabilities, NEVER on model or provider names.

1. Knowledge is split by owner into three strata; a fact lives in exactly one of them:

   ```text
   taxonomy/   "what model is this string?"       (class, family, revision)
   classes/    "what is true of this lineage?"    (scoped to hosts where it was checked)
   providers/  "what does this host change?"
   ```

2. Rules are declarative and scoped by class, host, family, and revision range. The Anthropic
   thinking-mode fact reads as the knowledge it expresses:

   ```kdl
   class "anthropic" {
       on "anthropic" "amazon-bedrock" "google-vertex" {
           family "sonnet" {
               revision ">=3.7 <4.6" { thinking-mode "budget" }
           }
           revision ">=4.7" {
               thinking-mode "anthropic-adaptive"
           }
       }
   }
   ```

3. The compiler enforces the contract; the file format does not:
   - An unknown directive or malformed value is an error.
   - Two equally specific rules setting the same axis are an error. File and declaration order
     NEVER break a tie; the author adds an explicit priority.
   - No matching rule yields `unknown`, never `false`. Callers distinguish "unsupported" from
     "not established".

4. In `.rs`, a model-name conditional (`model_id.contains(…)`, `starts_with("gpt-")`) or a
   hardcoded model table is a reviewer-reject. The mapping goes into catalog data.

## Consequences

- Adding a provider or a lineage quirk is one rule in the file that owns the fact, and the compiler
  tells the author when it collides with an existing rule.
- The inference layer, discovery, and serializers query one compiled answer; they stop
  rediscovering model identity independently.
- `unknown` is a first-class state. Planning code must decide what to do with it (0016, 0021)
  rather than treating absence of a rule as "no".
- Cost accepted: the axes themselves stay ugly (`requires-mistral-tool-ids`,
  `qwen-preserve-thinking`, `strip-deepseek-special-tokens`, many spellings of "reasoning off").
  The win is one owner and explicit precedence per fact, not fewer quirks.
- Cost accepted: a compiler, a cascade resolver, and conformance tests are more machinery than a
  boolean. That machinery replaces ~4,000 lines of duplicated branches.

## Status in omp

**Implemented.** Primary implementation: `crates/catalog/src/compat/axes.rs`. The closed compatibility vocabulary is compiled with explicit precedence and conformance coverage. Runtime rows from local and configured provider discovery pass through `omp_catalog::DiscoveryNormalizer`; endpoint protocol selection is typed configuration rather than URL/model-name inference.

## References

- The Harness Playbook, "The inference" — "What omp taught us: quirks become architecture"
- omp v1 commit `dd57045396` (before/after of the compatibility rewrite)
- 0001 (consequence 4, explicit compatibility), 0002, 0016, 0018, 0021
- `crates/catalog/compat/README.md`, `crates/catalog/src/cascade.rs`,
  `tools/lintx/src/lints/model_name.rs`, `docs/py/13-inference.md` ("Providers are data")
