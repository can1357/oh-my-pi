---
title: Settings — Models
description: Configuration keys that pick and route models — roles, cycle order, allow-lists, advisor, and the active-model hint.
coverage: A
sidebar:
  label: Settings — Models
  order: 0
---

Settings that decide which model runs a turn and how the model switcher behaves. For the workflow and the layered config model, see [Settings](/oh-my-pi/configuration/settings/). For the exhaustive schema, run `omp config list`.

## Models

`modelRoles`, `modelTags`, and `cycleOrder` work together to define the models you can switch between. Role values may carry a thinking suffix (`:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`).

| Key | Type | Default | Description |
|---|---|---|---|
| `modelRoles` | record | `{}` | Map of role name to model id. Built-in roles: `default`, `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`, `task`, `advisor`. The `tiny` role overrides the online model for lightweight background tasks (titles, memory, auto-thinking, unexpected-stop), else `@smol`. Per-role env/flags exist only for `--model`/`--smol`/`--slow`/`--plan`; configure the advisor with `modelRoles.advisor`. |
| `modelRoleStorage` | enum | `global` | Where model-selector role assignments are saved: `global` writes them to the active global/profile config; `project` writes only those role assignments to `<cwd>/.omp/config.yml`. Missing project roles fall back to global roles. |
| `modelTags` | record | `{}` | Custom role/tag metadata; can introduce additional roles. |
| `modelProviderOrder` | array | `[]` | Preferred provider order when a model id is ambiguous. |
| `cycleOrder` | array | `["smol","default","slow"]` | Roles cycled by the model switcher. |
| `enabledModels` | array | `[]` | Allow-list of models; supports [path-scoped entries](/oh-my-pi/configuration/settings/#path-scoped-arrays). Empty means all available models. |
| `disabledProviders` | array | `[]` | Disabled model/discovery providers; supports path-scoped entries. See [Provider and source disabling](/oh-my-pi/configuration/settings/#provider-and-source-disabling). |
| `includeModelInPrompt` | boolean | `true` | Include the active model name in the system prompt. |
| `providers.anthropic.serverSideFallback` | boolean | `false` | When a Claude Fable 5 / Mythos 5 request is blocked by Anthropic's safety classifier, retry it on Claude Opus 4.8 server-side (Anthropic `server-side-fallback-2026-06-01` beta). Only direct `anthropic` provider requests using the `anthropic-messages` API are eligible. Opt-in — leaving it off preserves the pre-fallback behavior for every request. |

## Prompt and context

| Key | Type | Default | Description |
|---|---|---|---|
| `includeWorkspaceTree` | boolean | `false` | Render the workspace directory tree in the system prompt. Warning: this can bust prompt caching across sessions when files are modified. |
| `inlineToolDescriptors` | enum | `auto` | Render full tool descriptors in the system prompt and strip top-level/nested descriptions from provider tool schemas so descriptor text is sent once. `auto` inlines descriptors for Gemini models and keeps them in tool schemas otherwise; `on` always inlines; `off` keeps descriptors in provider tool schemas only. |
| `workspace.additionalDirectories` | array | `[]` | Extra workspace directories added to every session as additional roots (multi-root workspace). Managed live via `/add-dir` and `/remove-dir`. Paths resolve relative to cwd; absolute paths recommended. The agent is told these roots exist and can read/grep/glob them. |
| `omitThinking` | boolean | `false` | Instruct upstream providers to completely omit thinking summaries from responses (where supported). |
| `proseOnlyThinking` | boolean | `true` | Omit code blocks from thinking summaries and replace them with an ellipsis. |
| `textVerbosity` | enum | `medium` | OpenAI Responses and Codex response verbosity: `low`, `medium`, or `high`. |

## Loop guards

Loop guards detect stalled or repetitive model behavior and steer the model back on track.

| Key | Type | Default | Description |
|---|---|---|---|
| `model.loopGuard.enabled` | boolean | `true` | Enable automatic stream loop detection for model reasoning and prose. |
| `model.loopGuard.checkAssistantContent` | boolean | `true` | Apply loop guard to assistant prose messages in addition to thinking logs. |
| `model.loopGuard.toolCallReminder` | boolean | `true` | When a Gemini reasoning stream emits many consecutive planning headers without calling a tool, interrupt it and inject a reminder to issue a tool call (requires loop guard). |
| `model.toolCallLoopGuard.enabled` | boolean | `true` | Detect consecutive identical tool calls across turns and inject a corrective steer. |
| `model.toolCallLoopGuard.threshold` | number | `5` | Consecutive identical tool calls required before the corrective steer is injected. |
| `model.toolCallLoopGuard.exemptTools` | array | `["hub"]` | Tool names that may repeat consecutively without triggering the cross-turn loop guard. |

## Advisor

The advisor is a second model that reviews each completed turn and can inject advice into the primary session. Assign a model with `modelRoles.advisor`, then enable it with `advisor.enabled`, `/advisor on`, or by launching with the `--advisor` flag. See [Advisor](/oh-my-pi/features/advisor/) for runtime behavior, `WATCHDOG.md` discovery, and bounded catch-up semantics.

| Key | Type | Default | Description |
|---|---|---|---|
| `advisor.enabled` | boolean | `false` | Enable the advisor runtime when `modelRoles.advisor` resolves to an available model. |
| `advisor.subagents` | boolean | `false` | Also enable advisor runtimes for spawned task/eval subagents. |
| `advisor.syncBacklog` | enum | `off` | Bounded advisor catch-up delay: `off`, `1`, `3`, or `5`. The primary waits up to 30 seconds only while advisor backlog is at or above the threshold. |
| `advisor.immuneTurns` | number | `3` | After a `concern`/`blocker` interrupts, route further concerns/blockers as non-interrupting asides for this many completed primary turns. |
