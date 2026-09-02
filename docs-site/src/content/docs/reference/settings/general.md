---
title: Settings — General
description: Auth broker, advisor, model and provider ordering, extensions, git, power, prewalk, shell, and startup settings.
coverage: A
---

Settings in the General group have no dedicated UI tab; each key is surfaced where it applies (model selector, interaction, providers). Domain-specific keys also appear on their dedicated pages: [Models](/oh-my-pi/reference/settings/models/), [Interaction](/oh-my-pi/reference/settings/interaction/), [Tools](/oh-my-pi/reference/settings/tools/), and [Providers](/oh-my-pi/reference/settings/providers/). For the workflow and the layered config model, see [Settings](/oh-my-pi/configuration/settings/). For the exhaustive schema, run `omp config list`.

:::caution
Array settings (`enabledModels`, `disabledProviders`, `cycleOrder`, `extensions`, `disabledExtensions`) replace rather than append across config layers: a project that sets one must list the complete desired value.
:::

## Auth broker

| Key | Type | Default | Description |
|---|---|---|---|
| `auth.broker.url` | string | _(unset)_ | URL of a remote `omp auth-broker serve` host that proxies credentials. Overridden by `OMP_AUTH_BROKER_URL`. |
| `auth.broker.token` | string | _(unset)_ | Token for the auth broker. Overridden by `OMP_AUTH_BROKER_TOKEN`. |

## Advisor

The advisor pairs a second model with the main agent. See [The Advisor](/oh-my-pi/features/advisor/) for runtime behavior.

| Key | Type | Default | Description |
|---|---|---|---|
| `advisor.enabled` | boolean | `false` | Enable the advisor runtime when `modelRoles.advisor` resolves to an available model. |
| `advisor.subagents` | boolean | `false` | Also enable the advisor on spawned task/eval subagents. |
| `advisor.syncBacklog` | enum | `off` | Pause the main agent for up to 30 seconds if the advisor falls behind by this many turns. One of `off`, `1`, `3`, `5`; `off` disables catch-up delays. |
| `advisor.immuneTurns` | number | `3` | After an advisor concern or blocker interrupts, route further concerns/blockers non-interruptingly for this many primary turns. |

## Models and providers

| Key | Type | Default | Description |
|---|---|---|---|
| `enabledModels` | array | `[]` | Allow-list of models; supports [path-scoped entries](/oh-my-pi/configuration/settings/). Empty means all available models. |
| `disabledProviders` | array | `[]` | Disabled model/discovery providers; supports path-scoped entries. One shared id namespace that gates both subsystems before any credential check. |
| `modelProviderOrder` | array | `[]` | Preferred provider order when a model id is ambiguous. |
| `cycleOrder` | array | `["smol", "default", "slow"]` | Roles cycled by the model switcher. |
| `modelRoles` | record | `{}` | Map of role name to model id. Built-in roles: `default`, `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`, `task`, `advisor`. Values may carry a thinking suffix (`:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`). |
| `modelRoleStorage` | enum | `global` | Where model-selector role assignments are saved: `global` saves them in the active profile config; `project` saves them in `.omp/config.yml`, with missing project roles falling back to global ones. |
| `modelTags` | record | `{}` | Custom role/tag metadata; can introduce additional roles. Each value is `{ name, color?, hidden? }`. |
| `providers.maxInFlightRequests` | record | `{}` | Maximum concurrent LLM requests per provider id (for example `openai` or `anthropic`), shared across local OMP processes with this config root. Omitted providers are unlimited. |

## Extensions

| Key | Type | Default | Description |
|---|---|---|---|
| `extensions` | array | `[]` | Additional extension paths to load. See [Extensions](/oh-my-pi/extending/extensions/). |
| `disabledExtensions` | array | `[]` | Extension IDs to disable, including extensions contributed by skills, MCP servers, hooks, and context files. |

## Git

| Key | Type | Default | Description |
|---|---|---|---|
| `git.enabled` | boolean | `true` | Show git branch, status, and PR information in the TUI and watch repository metadata. See [Atomic Commits](/oh-my-pi/features/atomic-commits/). |

## Power

| Key | Type | Default | Description |
|---|---|---|---|
| `power.sleepPrevention` | enum | `idle` | Prevent macOS sleep during active sessions (caffeinate flags; no-op on other platforms). Each level is cumulative — it adds the flags of all lower levels: `off` (none), `idle` (`caffeinate -i`), `display` (`-i -d`), `system` (`-i -d -s -u`). |

## Prewalk

| Key | Type | Default | Description |
|---|---|---|---|
| `prewalk.enabled` | boolean | `false` | Start on the active model, then switch to a fast/cheap model (default the `smol` role) at the first edit/write after the plan nudge's todo list exists — the strong model plans, commits the todos, and starts the implementation before handing off. Overridable per session with `--prewalk` / `--no-prewalk` ([CLI Reference](/oh-my-pi/reference/cli/)). |

## Shell

| Key | Type | Default | Description |
|---|---|---|---|
| `shellPath` | string | _(unset)_ | Override the shell binary used by bash. |

## Startup

| Key | Type | Default | Description |
|---|---|---|---|
| `autoResume` | boolean | `false` | Automatically resume the most recent session in the current directory. See [Sessions](/oh-my-pi/features/sessions/). |
| `setupVersion` | number | `0` | Version of the setup wizard last completed; when lower than the current setup version, the setup wizard runs on the next start. Written automatically when the wizard finishes. |
