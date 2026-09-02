---
title: Settings
description: Where omp settings live, how the layers merge, and how to inspect and change them with omp config.
coverage: A
---

`omp` resolves settings from built-in defaults, a persistent global config file, optional project-local config, one-shot CLI overlays, and in-memory runtime overrides. Settings are plain YAML mappings; every key, type, default, and enum value comes from the settings schema. You can inspect or change any of them with `omp config` from a shell or the interactive `/settings` panel inside a session. For the full key-by-key catalog, see the [Configuration reference](/oh-my-pi/reference/configuration/).

## Where settings live

| Scope | Path | Read behavior | Write behavior |
|---|---|---|---|
| Global | `~/.omp/agent/config.yml` | The main persistent settings file. Always loaded. | `/settings`, `omp config set`, and `omp config reset` write here. |
| Global legacy | `~/.omp/agent/settings.json` | Migrated into `config.yml` once, only when `config.yml` does not yet exist. | Not written after migration; the original is renamed to `settings.json.bak`. |
| Project | `<cwd>/.omp/config.yml` (plus `.omp/settings.json`) | Loaded when the process working directory has a non-empty `.omp/`. | Read-only from settings commands; edit the file by hand. |
| Project legacy | `<cwd>/.omp/settings.json` | Still read; project `config.yml` is merged on top of it. | Not written by settings commands. |
| CLI overlay | Any file passed with `--config <file>` | Loaded after global and project settings, for that one process. Repeatable. | Never persisted. |
| Runtime overrides | In-memory only | Set by dedicated CLI flags (`--model`, `--approval-mode`, …) and feature env vars. | Never persisted. |

`PI_CODING_AGENT_DIR` relocates the `~/.omp/agent` base directory. When it is set, the global `config.yml`, the auth store (`agent.db`), and everything else under the agent directory move with it. Run `omp config path` to print the active agent directory.

:::caution
Project settings discovery only checks the **current working directory's** `.omp/` folder — it does not walk ancestor directories looking for the nearest `.omp/`, and an empty `.omp/` directory is ignored. Start `omp` from the directory that contains the project config.
:::

Other discovery providers (Claude, Codex, Gemini, Cursor, OpenCode) can also contribute project-level settings from their own files. Those are read-only from `omp` settings commands and can be turned off by provider id — see [Provider and source disabling](#provider-and-source-disabling).

## Config file formats

The global `config.yml` is always YAML. The generic config loader used for other files (for example `models.yml`) accepts `.yml`, `.yaml`, `.json`, and `.jsonc`:

- When a `.yml`/`.yaml` path is requested and only a sibling `.json` exists, it is migrated to YAML automatically (idempotent, once per process).
- `.json` and `.jsonc` configs are read as-is, with no migration.
- A file whose top level is not a mapping (a bare array or scalar) is treated as empty for persistent settings, and is a hard error for `--config` overlays.

## Reading and writing settings

Use the interactive `/settings` panel inside a session, or the `omp config` command from a shell. Both operate on the merged effective settings, but every persistent write lands in the **global** file only.

```bash
omp config list                 # all settings with current effective values
omp config list --json          # same, machine-readable
omp config get theme.dark       # one value
omp config get theme.dark --json
omp config set compaction.enabled false
omp config set defaultThinkingLevel medium
omp config reset steeringMode   # restore a key to its schema default
omp config path                 # print the active agent directory
```

| Command | Effect |
|---|---|
| `omp config list` | Print every setting grouped by tab, with its current value and type. `--json` emits an object keyed by setting path with `{ value, type, description }`. |
| `omp config get <key>` | Print the effective value of one key. Unknown keys exit non-zero. `--json` emits `{ key, value, type, description }`. |
| `omp config set <key> <value>` | Parse `<value>` against the key's schema type and write it to the global `config.yml`. |
| `omp config reset <key>` | Write the key's schema **default** back to the global config (this persists the default, it does not delete the key). |
| `omp config path` | Print the active agent directory (honors `PI_CODING_AGENT_DIR`). |

`omp config` with no subcommand, or `--help`, prints the help and lists settings. The `--json` flag is accepted by `list`, `get`, `set`, and `reset`.

### Value parsing

`omp config set` parses the value string according to the target key's schema type. The string is trimmed first.

| Type | Accepted input | Notes |
|---|---|---|
| boolean | `true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0` | Case-insensitive. Anything else is rejected. |
| number | Any finite JavaScript number | `Infinity`/`NaN` are rejected. |
| enum | One of the key's allowed values | Must match exactly; the error lists the valid values. |
| array | A JSON array | e.g. `'["anthropic","openai"]'`. Must parse and be an array. |
| record | A JSON object | e.g. `'{"bash":"prompt"}'`. Must parse and be a non-array object. |
| string | Stored as given (trimmed) | Multi-word values are joined with spaces. |

Keys must match a real schema path exactly. There is no shorthand — set `theme.dark`, not `theme`. Run `omp config list` to see every valid key.

### Where writes go

`omp config set`, `omp config reset`, `/settings`, and any runtime settings change all write to the global `config.yml` under the active agent directory. They never write to `<cwd>/.omp/config.yml`. To create a project-local override, edit that file directly (see [Project-local config](#project-local-config)). Saves are debounced and re-read the file under a lock, so external edits made while a session is open are preserved.

## Precedence

From lowest to highest priority, the effective value of a setting is built as:

```text
built-in defaults  <-  global config  <-  project config  <-  CLI overlays  <-  runtime overrides
```

From highest to lowest:

1. **Runtime overrides** — dedicated CLI flags and feature env vars applied in memory for the current process: `--model`, `--smol`, `--slow`, `--plan`, `--approval-mode`, `--auto-approve`/`--yolo`, `--hide-thinking`, `--advisor`, `--no-pty`, `--api-key`, and protocol-mode defaults. Never persisted.
2. **CLI config overlays** — each `--config <file>`; later overlay files override earlier ones.
3. **Project settings** — `<cwd>/.omp/settings.json` then `<cwd>/.omp/config.yml` (and contributions from other discovery providers at project level).
4. **Global settings** — `~/.omp/agent/config.yml`.
5. **Built-in defaults** — from the settings schema.

A key that is unset at every layer resolves to its schema default at read time.

### Environment overrides

Environment variables are **not** a single settings layer. Each is read by the feature that owns the value, usually as a per-machine override or fallback, and is never written back to `config.yml`. The ones that map directly onto a setting:

| Env var | Overrides setting | Notes |
|---|---|---|
| `PI_SMOL_MODEL` | `modelRoles.smol` | Also exposed as `--smol`. |
| `PI_SLOW_MODEL` | `modelRoles.slow` | Also exposed as `--slow`. |
| `PI_PLAN_MODEL` | `modelRoles.plan` | Also exposed as `--plan`. |
| `PI_NO_PTY=1` | (disables PTY bash) | Equivalent to `--no-pty` for the process. |
| `PI_PY` | `eval.py` | `PI_PY=0` disables the Python eval backend. |
| `PI_JS` | `eval.js` | `PI_JS=0` disables the JavaScript eval backend. |
| `PI_TINY_DEVICE` | `providers.tinyModelDevice` | ONNX execution provider for local tiny models. |
| `PI_TINY_DTYPE` | `providers.tinyModelDtype` | ONNX precision for local tiny models. |
| `OMP_AUTH_BROKER_URL` | `auth.broker.url` | Env value takes precedence over config. |
| `OMP_AUTH_BROKER_TOKEN` | `auth.broker.token` | Env value takes precedence over config. |
| `PI_CODING_AGENT_DIR` | (relocates agent dir) | Moves `config.yml`, `agent.db`, and the whole agent base. |
| `PI_CONFIG_FILES` | CLI config overlays | Platform path-list (`:` on Unix, `;` on Windows); files load in order before `--config` overlays. |

Provider API keys are resolved separately (stored auth, OAuth, `models.yml`, environment, and `.env` files); see [Providers](/oh-my-pi/models/providers/) and the full [Environment variables](/oh-my-pi/configuration/environment-variables/) reference.

## Merge rules

Layers are combined with a deep merge:

- **Objects are deep-merged** — keys present only in a lower layer are kept; keys present in a higher layer override.
- **Scalars and arrays are replaced wholesale** by the higher-precedence layer. A higher layer's array does not append to a lower layer's array.

Use nested YAML mappings for dotted setting paths:

```yaml
theme:
  dark: titanium
  light: light

tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
```

### Worked example: global vs. project

```yaml
# ~/.omp/agent/config.yml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
disabledProviders:
  - anthropic
  - openai
  - gemini
```

```yaml
# <repo>/.omp/config.yml
tools:
  approval:
    bash: allow
disabledProviders:
  - groq
```

Effective settings inside `<repo>`:

```yaml
tools:
  approvalMode: write   # kept from global (object deep-merge)
  approval:
    bash: allow         # overridden by project
    read: allow         # kept from global
disabledProviders:
  - groq                # project array REPLACES the global array
```

:::caution
Array replacement is the most common surprise: the project's `disabledProviders` does not extend the global list — it becomes the entire list for that project. The same applies to `enabledModels`, `cycleOrder`, `extensions`, and every other array-typed setting. Include the **complete** desired value in the higher-precedence layer.
:::

### Bash command approval patterns

`tools.approval` sets default policy by tool name. For bash, you can add ordered command rules with `bash.patterns`; the first matching rule wins. Patterns support literal text plus `*` as a wildcard.

```yaml
tools:
  approvalMode: write
  approval:
    bash: allow

bash:
  patterns:
    - match: "git *"
      approval: allow
    - match: "rm -rf *"
      approval: deny
    - match: "*"
      approval: allow
```

Valid rule approvals are `allow`, `prompt`, and `deny`. Critical bash commands still require confirmation unless a matching rule explicitly denies them; broad allow rules such as `match: "*"` do not bypass the critical-command guard.

Matching is asymmetric so that rules mean what they appear to: `deny` and `prompt` rules fire when the glob matches the whole command **or any single segment** of a compound line (split on `&&`, `||`, `;`, `|`, a single `&`, subshells, and newlines), so `match: "rm -rf *"` still denies `cd /tmp && rm -rf build`. `allow` rules must match the **entire** command and never apply to a compound line, so a narrow allow such as `match: "git *"` cannot vouch for `git status && rm -rf /`.

## Project-local config

Create `<repo>/.omp/config.yml` when a repository needs its own provider set, model role, tool policy, memory backend, or UI behavior — without touching your machine-wide configuration:

```yaml
# <repo>/.omp/config.yml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high

tools:
  approvalMode: write
  approval:
    bash: prompt

compaction:
  strategy: snapcompact
  thresholdPercent: 80

theme:
  dark: titanium
```

:::caution
Keep secrets out of committed project config unless your repository policy allows it. Prefer environment variables, stored auth, an auth broker, or an untracked `--config` overlay for credentials.
:::

### One-shot overlays

Use `--config` for a temporary layer that should not persist:

```bash
omp --config ./local/ci-settings.yml "check this failure"
omp --config ./base.yml --config ./experiment.yml "try this model"
```

`--config` is accepted by the default launch command, `acp`, and `models`. Later overlay files override earlier ones.

Wrappers may instead set `PI_CONFIG_FILES` to a platform-delimited path list (`:` on Unix, `;` on Windows). Environment overlays load in listed order before explicit `--config` overlays.

Overlay paths are resolved relative to the process working directory (and `~` is expanded). Each overlay must parse as a YAML mapping; a missing file, invalid YAML, or a top-level array/scalar is a hard error — it does **not** silently fall back to lower-precedence settings.

## Path-scoped arrays

Two array settings — `enabledModels` and `disabledProviders` — accept path-scoped entries in addition to bare strings, so a single global config can behave differently per directory:

```yaml
enabledModels:
  - claude-sonnet-4-5            # applies everywhere
  - path: ~/work/high-context
    models:
      - anthropic/claude-opus-4-5

disabledProviders:
  - ollama                       # applies everywhere
  - paths:
      - ~/projects/sensitive
      - ~/clients/acme
    providers:
      - anthropic
      - openai
```

Bare string entries apply everywhere. A scoped entry applies when the current working directory **is** the configured path or is **under** it. `~` expands to your home directory and relative paths are resolved before matching.

Accepted **path** keys (any of them, combined): `path`, `paths`, `pathPrefix`, `pathPrefixes`. Accepted **value** keys: `models` (for `enabledModels`), `providers` (for `disabledProviders`), or `values`/`items` (for either setting). Only string values are kept; malformed scoped entries are ignored. Path scoping is resolved **after** the layer merge, so it reads the final effective array.

## Provider and source disabling

`disabledProviders` is a single shared id namespace that gates two different subsystems, before any credential check:

| Entry kind | Example ids | Effect |
|---|---|---|
| Model providers | `anthropic`, `openai`, `gemini`, `groq`, `ollama`, `openrouter` | Removes those backends from model selection, even when credentials are available. See [Providers](/oh-my-pi/models/providers/). |
| Discovery sources | `native`, `claude`, `codex`, `gemini`, `github`, `opencode`, `cursor`, `agents-md` | Stops that source from contributing context files, MCP servers, commands, skills, hooks, tools, prompts, or settings. |

Disabling the `claude` discovery source is different from disabling the `anthropic` model provider — one stops Claude-format config discovery, the other stops the Anthropic model backend.

Because arrays replace rather than append, a project that sets `disabledProviders` must list the complete desired set:

```yaml
# ~/.omp/agent/config.yml
disabledProviders:
  - anthropic
  - openai

# <repo>/.omp/config.yml — inside this repo ONLY groq is disabled
disabledProviders:
  - groq
```

The default is an empty array (nothing disabled).

## Profiles

A named profile relocates the entire OMP user base, so different machines, roles, or experiments can keep fully separate settings, auth, and session state. Launch one with `omp --profile <name>` (or the `--alias` shortcut, or the `OMP_PROFILE` / `PI_PROFILE` environment variables). When a profile is active, every path written here as `~/.omp/agent/...` resolves to `~/.omp/profiles/<name>/agent/...` instead.

The relocation is uniform: it covers slash commands, rules, prompts, instructions, hooks, tools, extensions, settings, skills, and MCP, plus the top-level `SYSTEM.md` / `RULES.md` / `AGENTS.md` files and runtime state (sessions, blobs, `agent.db`). A profile sees only its own OMP config, never the default profile's `~/.omp/agent`.

Two things are not profile-scoped:

- **Keybindings** — a named profile merges the default profile's `~/.omp/agent/keybindings.*` under its own, with the profile file overriding per binding, because keybindings describe the terminal in front of you rather than the active profile. The inherited file is read-only for the profile process. See [Keybindings](/oh-my-pi/configuration/keybindings/).
- **External and project bases** — `~/.claude`, `~/.codex`, `~/.gemini`, and the project-level `<cwd>/.omp`, `<cwd>/.claude`, … load identically under every profile.

## Legacy migration

`omp` migrates older config shapes automatically. None of these require action; they are listed so you know what changes you may see in `config.yml`.

**Startup migration to `config.yml`.** When `~/.omp/agent/config.yml` does not exist, startup builds it once from `~/.omp/agent/settings.json` (renamed to `settings.json.bak` after a successful migration) and from settings persisted in `agent.db`, then writes the result. After `config.yml` exists, these legacy sources are no longer consulted.

**Field-level migrations.** Applied whenever raw settings are loaded (global, project, overlays, and runtime overrides) — for example `queueMode` becomes `steeringMode`, an `ask.timeout` in milliseconds becomes seconds, and a flat `theme: "<name>"` string becomes `theme.dark` / `theme.light`. The full mapping table is in the [Configuration reference](/oh-my-pi/reference/configuration/#legacy-key-migrations).

## Troubleshooting

**A project setting is not taking effect.** Start `omp` from the directory that contains `.omp/config.yml` (discovery checks only the current working directory's `.omp/`, not ancestors), ensure `.omp/` is non-empty, and confirm the file is valid YAML whose top level is a mapping. Run `omp config get <key>` from that directory to see the effective value, and remember that `--config` overlays and runtime flags override project config.

**A global array disappeared in a project.** Arrays replace; they do not append. If a project sets `disabledProviders`, `enabledModels`, `cycleOrder`, `extensions`, or any other array, include the complete desired value in the project layer — the global array is fully replaced.

**A provider is still available after editing config.** Check whether you disabled the model provider id (e.g. `anthropic`) or a discovery source id (e.g. `claude`) — they are different namespaces with different effects. Check for a project or overlay `disabledProviders` array replacing your global one. Credentials can still come from environment variables, `.env`, OAuth, stored auth, or `models.yml`; disabling a provider blocks selection regardless, but verify you edited the right layer. Restart the session if the model list was already initialized.

**`omp config set` changed the wrong file.** `omp config set` and `omp config reset` always write the global `config.yml` under the active agent directory — run `omp config path` to print it. For project-local settings, edit `<repo>/.omp/config.yml` directly.

**`omp config reset` did not remove my key.** `reset` writes the schema **default** value into the global config — it persists the default rather than deleting the key. To stop overriding a project value from global config, delete the key from `~/.omp/agent/config.yml` by hand.

**A `--config` overlay fails at startup.** Overlays are process-local YAML mappings: a missing file, invalid YAML, or a top-level array/scalar is a hard error, not a silent fallback. Fix the path or contents.

**An environment variable beats my config.** Some settings (model roles, eval backends, tiny-model device/precision, auth broker, PTY) are overridable by env vars or CLI flags for per-machine convenience, and those take precedence over `config.yml`. Unset the variable or drop the flag to let the persisted value win — see [Environment overrides](#environment-overrides).

**`omp config set <key>` says "Unknown setting".** Keys must match a schema path exactly, with no shorthand. Use `theme.dark`, not `theme`; run `omp config list` to see every valid key.
