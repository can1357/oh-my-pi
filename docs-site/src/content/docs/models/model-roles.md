---
title: Model Roles & Routing
description: Roles route work by intent — pick a model per role, set fallbacks, round-robin credentials, and pin a model set to a path.
coverage: B
---

Roles name the *kind* of work a model will do. omp assigns a model to each role and routes requests accordingly: `default` for normal turns, `smol` for cheap subagent fan-out, `slow` for deep reasoning, `plan` for plan mode, `commit` for changelogs. This page covers how a model gets selected, the available roles, the thinking levels you can attach to them, and the routing settings that turn the role model into a real one.

## How a model gets selected

A model is referenced as `provider/model-id` (for example `anthropic/claude-opus-4-6`) or by an upstream canonical id (for example `gpt-5.3-codex`). The selector parser also accepts:

- the model id alone, with the provider inferred;
- fuzzy / substring matching against available models;
- glob scope patterns in `--models` (for example `openai/*` or `*sonnet*`);
- an optional `:thinkingLevel` suffix (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`).

`--model` is the preferred flag; `--provider` is legacy.

Resolution precedence for exact selectors:

1. exact `provider/model-id` (bypasses canonical coalescing);
2. exact canonical id resolved through the canonical index;
3. exact bare concrete id;
4. fuzzy and glob matching.

When no selector is given, `findInitialModel` uses this order:

1. explicit CLI provider and model;
2. the first scoped model (when not resuming);
3. the saved default provider/model;
4. known provider defaults (OpenAI, Anthropic, etc.) among available models;
5. the first available model.

## Available roles

omp ships these role aliases:

| Role | Purpose |
|---|---|
| `default` | Normal turns. |
| `smol` | Cheap subagent fan-out and lightweight background work. |
| `slow` | Deep reasoning. |
| `vision` | Image-aware turns. |
| `plan` | Plan mode. |
| `designer` | Design-mode work. |
| `commit` | Changelog / commit message drafting. |
| `tiny` | Online model used for lightweight background tasks (session titles, memory, `auto`-thinking difficulty classification, unexpected-stop detection). Falls back to `@smol` when unset. Pick one in `/models`. |
| `task` | Task-agent work. |
| `advisor` | Reviewer model that reads every main-agent turn and injects notes inline. |

`@smol`, `@slow`, and similar aliases expand through `settings.modelRoles`; `*` selects `@default`. In YAML values, quote `@` aliases (`fable: "@slow"`). Each role value may also append a thinking selector — for example `:minimal`, `:low`, `:medium`, or `:high` — that takes effect for that role-specific use. If a role points at another role, the target model inherits normally and any explicit suffix on the referring role wins for that role.

CLI overrides let you launch with a different model for the run:

```bash
omp --smol gpt-5.3-codex
omp --slow claude-opus-4-6
omp --plan qwen3-coder
```

`Ctrl+P` cycles through the configured models for the active role; `/model` swaps the active model mid-session and also exposes a canonical view alongside the provider tabs.

## Choosing a model per role

Set `modelRoles` in `~/.omp/agent/config.yml` (or a project-scoped `.omp/config.yml`) to pin a model to a role:

```yaml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: gpt-5.3-codex
  slow: anthropic/claude-opus-4-6
  plan: qwen3-coder
  tiny: gemma-3-1b
```

Each value is either `provider/modelId` to pin a concrete provider variant or a canonical id (such as `gpt-5.3-codex`) to allow provider coalescing. Concrete provider/model rows are still selectable through `/model` even when only a canonical id is set.

## Thinking levels

Append a thinking level to any selector to force the effort:

```text
anthropic/claude-sonnet-4-5:medium
gpt-5.3-codex:low
claude-opus-4-6:xhigh
```

Internal levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Per-role overrides accept `:minimal`, `:low`, `:medium`, or `:high`. Endpoint providers translate these to their own dialect — `reasoning_effort` on OpenAI-style APIs, `thinking: { type: "enabled" }` on Z.AI / GLM, top-level `enable_thinking` on Qwen, Anthropic thinking enablement plus budget tokens on Anthropic-compatible format. Compat metadata drives the mapping; a partial `reasoningEffortMap` can rewrite internal levels to provider-specific strings (for example, mapping `minimal -> "none"` for Fireworks GLM).

To turn off `reasoning_effort` on a host that has no real off switch, map to the lowest supported effort rather than sending an unsupported value.

## Fallbacks and overflow recovery

### `retry.fallbackChains`
Per-role or per-model fallback chains live under `retry.fallbackChains`. When the primary throws 429s or hits a quota wall, the next entry takes the rest of the turn and is restored on cooldown. Configure a chain to round-robin across providers or to gracefully degrade when one model is unavailable:

```yaml
retry:
  fallbackChains:
    default:
      - anthropic/claude-sonnet-4-5
      - gpt-5.3-codex
      - gpt-5.1-codex
```

### Context promotion

When a turn fails with a context overflow (for example `context_length_exceeded`), the session tries to promote to a larger-context sibling before falling back to compaction:

1. If `contextPromotion.enabled` is true, resolve a promotion target.
2. If a target is found, switch to it and retry the request — no compaction needed.
3. If no target is available, fall through to auto-compaction on the current model.

Targets are explicit and model-driven, set via `contextPromotionTarget` on a model override. Only the configured target is considered — context promotion does not automatically choose a larger same-provider sibling. Configured targets are ignored unless credentials resolve. Promotion uses temporary switching: it is recorded as a `model_change` in session history but does not rewrite the saved role mapping.

```yaml
providers:
  openai-codex:
    modelOverrides:
      gpt-5.5:
        contextPromotionTarget: openai-codex/gpt-5.4
```

`contextPromotionTarget` accepts either `provider/model-id` or a bare `model-id` resolved within the current provider. The built-in model policy currently links OpenAI `codex-spark` variants to `gpt-5.5`, and `gpt-5.5` to `gpt-5.4`, when that target exists on the same provider/API.

## Path-scoped models

`enabledModels` and `disabledProviders` entries can mix plain strings (apply everywhere) with path-scoped blocks (apply when the working directory is the configured path or under it):

```yaml
enabledModels:
  - claude-sonnet-4-5
  - path: ~/work
    models:
      - anthropic/claude-opus-4-5
disabledProviders:
  - ollama
  - path: ~/private
    providers:
      - anthropic
```

Accepted path keys are `path`, `paths`, `pathPrefix`, `pathPrefixes`; accepted value keys are `models` (for `enabledModels`) and `providers` (or `values`) for `disabledProviders`. `~` expands to the home directory.

For `enabledModels` and CLI `--models`:

- exact canonical ids expand to all concrete variants in that canonical group;
- explicit `provider/model-id` entries stay exact;
- globs and fuzzy matches still operate on concrete models.

## Provider precedence and round-robin credentials

Two more routing levers round out the model story.

### `modelProviderOrder`

When multiple concrete variants share a canonical id, resolution uses availability and auth first, then `modelProviderOrder`, then the registry order. Set it as a global canonical-provider precedence:

```yaml
modelProviderOrder:
  - anthropic
  - openai-codex
  - openai
```

Disabled or unauthenticated providers are skipped.

### Round-robin credentials

Stack multiple API keys per provider and the runtime rotates them with session affinity and per-credential backoff — useful when a single key would burn its quota by lunch. Combine this with the credential resolution order in [Providers](/oh-my-pi/models/providers/#credential-resolution-order): the runtime override, then `models.yml` `apiKey`, then stored OAuth, then login-sourced keys, then environment variables, then any other stored API key.

## Inspecting and swapping

Both `/model` and `omp models` keep provider-prefixed models visible and selectable, and both now also expose the canonical view:

- `/model` includes a canonical view alongside provider tabs.
- `omp models` prints provider-grouped tables of every concrete model; `omp models canonical` prints the coalesced canonical view.

Selecting a canonical entry stores the canonical selector; selecting a provider row stores the explicit `provider/model-id`. Session state and transcripts continue to record the concrete provider/model that actually executed the turn.
