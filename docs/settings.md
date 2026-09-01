# Settings

`omp` resolves settings from built-in defaults, a persistent global config file, optional project-local config, one-shot CLI overlays, and in-memory runtime overrides. Reach for project settings when one repository needs a different provider set, model role, tool policy, memory backend, or UI behavior than your global defaults — without touching your machine-wide configuration.

Settings are stored as plain YAML mappings. Every key, its type, default, and enum values come from the settings schema. `omp config` exposes the complete schema; the interactive `/settings` panel exposes the schema entries that have UI metadata.

- For model/provider credentials, `.env` files, and the env-var table that resolves API keys, see [Providers](./providers.md).
- For custom model definitions in `models.yml`, see [Models](./models.md).
- For instruction files discovered into the agent context (`AGENTS.md`, `.omp/`, etc.), see [Context files](./context-files.md).
- For the full catalog of environment variables, see [Environment variables](./environment-variables.md).
- For prompt words that activate specialized per-turn behavior, see [Magic keywords](./magic-keywords.md).

## Where settings live

| Scope             | Path                                                  | Read behavior                                                                                                                            | Write behavior                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global            | `~/.omp/agent/config.yml` (or existing `config.yaml`) | The main persistent settings file. `config.yml` is the canonical write target; an existing `config.yaml` is loaded and updated in place. | `/settings`, `omp config set`, and `omp config reset` write here.                                                                                                                |
| Global legacy     | `~/.omp/agent/settings.json`                          | Migrated into `config.yml` once, only when neither main YAML filename exists.                                                            | Not written after migration; the original is renamed to `settings.json.bak`.                                                                                                     |
| Project           | `<cwd>/.omp/config.yml` (plus `.omp/settings.json`)   | Loaded when the process working directory has a non-empty `.omp/`.                                                                       | Settings commands do not write arbitrary project keys. With `modelRoleStorage: project`, model-selector role assignments update only `modelRoles` here; edit other keys by hand. |
| Project legacy    | `<cwd>/.omp/settings.json`                            | Still read; project `config.yml` is merged on top of it.                                                                                 | Not written by settings commands.                                                                                                                                                |
| CLI overlay       | Any file passed with `--config <file>`                | Loaded after global and project settings, for that one process. Repeatable.                                                              | Never persisted.                                                                                                                                                                 |
| Runtime overrides | In-memory only                                        | Set by dedicated CLI flags (`--model`, `--approval-mode`, …) and feature env vars.                                                       | Never persisted.                                                                                                                                                                 |

`PI_CODING_AGENT_DIR` relocates the `~/.omp/agent` base directory. When it is set, the global `config.yml`, the auth store (`agent.db`), and everything else under the agent directory move with it. Use `omp config path` to print the active agent directory.

Native project settings are intentionally scoped to the process working directory's `.omp/` folder — settings discovery does **not** walk ancestor directories looking for the nearest `.omp/`. Other discovery providers (Claude, Codex, Gemini, Cursor, OpenCode) can also contribute project-level settings from their own files; those are read-only from `omp` settings commands and can be turned off by provider id (see [Provider and source disabling](#provider-and-source-disabling)).

## Config file formats

The canonical global file is YAML at `config.yml`; `config.yaml` is accepted as a compatibility filename. The generic config loader used for other files (for example `models.yml`) accepts `.yml`, `.yaml`, `.json`, and `.jsonc`:

- When a `.yml`/`.yaml` path is requested and only a sibling `.json` exists, it is migrated to YAML automatically (idempotent, once per process).
- `.json` and `.jsonc` configs are read as-is, with no migration.
- A settings YAML file whose top level is not a mapping is invalid. On writable startup, `omp` moves an invalid persistent settings file to a uniquely named `.broken-*` backup and exits with the original error and backup path. A `--config` overlay with a bare array/scalar is also a hard error, but is not moved.

## Reading and writing settings

Use the interactive `/settings` panel inside a session, or the `omp config` command from a shell. Both read merged effective settings. Ordinary persistent writes land in the **global** file; model-selector role changes are the exception when `modelRoleStorage: project` (see [Where writes go](#where-writes-go)).

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

For users who want the full first-run animation on normal launches, set `startup.showSplash`:

```bash
omp config set startup.showSplash true
```

This only controls the startup splash animation. It does not rerun setup or change setup state, and `startup.quiet: true` still suppresses all startup chrome including the splash.

### Subcommands

| Command                        | Effect                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `omp config list`              | Print every setting grouped by tab, with its current value and type. `--json` emits an object keyed by setting path with `{ value, type, description }`. Configured credential fields are masked as `********` in human output; in JSON their `value` is omitted and `redacted: true` is emitted. |
| `omp config get <key>`         | Print the effective value of one key. Unknown keys exit non-zero. `--json` emits `{ key, value, type, description }`. This is an explicit single-key request, so credential values are returned unmasked.                                                                                         |
| `omp config set <key> <value>` | Parse `<value>` against the key's schema type and write it to the global main YAML file.                                                                                                                                                                                                          |
| `omp config reset <key>`       | Write the key's schema **default** back to the global config (this persists the default, it does not delete the key).                                                                                                                                                                             |
| `omp config path`              | Print the active agent directory (honors `PI_CODING_AGENT_DIR`).                                                                                                                                                                                                                                  |
| `omp config init-xdg`          | On Linux and macOS, create the `omp` directories under the effective XDG data, state, and cache homes. It does not move existing files or set the XDG environment variables. Other platforms exit non-zero.                                                                                       |

`omp config` with no subcommand, `--help`, or `-h` lists settings. The `--json` flag is accepted by `list`, `get`, `set`, and `reset`.

### Value parsing

`omp config set` parses the value string according to the target key's schema type. The string is trimmed first.

| Type    | Accepted input                                      | Notes                                                             |
| ------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| boolean | `true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0` | Case-insensitive. Anything else is rejected.                      |
| number  | Any finite JavaScript number                        | `Infinity`/`NaN` are rejected.                                    |
| enum    | One of the key's allowed values                     | Must match exactly; the error lists the valid values.             |
| array   | A JSON array                                        | e.g. `'["anthropic","openai"]'`. Must parse and be an array.      |
| record  | A JSON object                                       | e.g. `'{"bash":"prompt"}'`. Must parse and be a non-array object. |
| string  | Stored as given (trimmed)                           | Multi-word values are joined with spaces.                         |

Keys must match a real schema path exactly. There is no shorthand — set `theme.dark`, not `theme`.

### Where writes go

`omp config set`, `omp config reset`, `/settings`, and ordinary runtime settings changes write the global main YAML file under the active agent directory. They do not write arbitrary keys to `<cwd>/.omp/config.yml`. The one supported project write path is a model-selector role assignment when `modelRoleStorage` is `project`; it updates only that role under `<cwd>/.omp/config.yml`, and missing project roles continue to fall back to global roles. To create any other project-local override, edit the project file directly (see [Project-local config](#project-local-config)). Saves are debounced and re-read the file under a lock, so external edits made while a session is open are preserved.

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

| Env var                 | Overrides setting           | Notes                                                                                             |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `PI_SMOL_MODEL`         | `modelRoles.smol`           | Also exposed as `--smol`.                                                                         |
| `PI_SLOW_MODEL`         | `modelRoles.slow`           | Also exposed as `--slow`.                                                                         |
| `PI_PLAN_MODEL`         | `modelRoles.plan`           | Also exposed as `--plan`.                                                                         |
| `PI_NO_PTY=1`           | (disables PTY bash)         | Equivalent to `--no-pty` for the process.                                                         |
| `PI_PY`                 | `eval.py`                   | `PI_PY=0` disables the Python eval backend.                                                       |
| `PI_JS`                 | `eval.js`                   | `PI_JS=0` disables the JavaScript eval backend.                                                   |
| `PI_TINY_DEVICE`        | `providers.tinyModelDevice` | ONNX execution provider for local tiny models.                                                    |
| `PI_TINY_DTYPE`         | `providers.tinyModelDtype`  | ONNX precision for local tiny models.                                                             |
| `OMP_AUTH_BROKER_URL`   | `auth.broker.url`           | Env value takes precedence over config.                                                           |
| `OMP_AUTH_BROKER_TOKEN` | `auth.broker.token`         | Env value takes precedence over config.                                                           |
| `PI_CODING_AGENT_DIR`   | (relocates agent dir)       | Moves `config.yml`, `agent.db`, and the whole agent base.                                         |
| `PI_CONFIG_FILES`       | CLI config overlays         | Platform path-list (`:` on Unix, `;` on Windows); files load in order before `--config` overlays. |

Provider API keys are resolved separately (stored auth, OAuth, `models.yml`, environment, and `.env` files); see [Providers](./providers.md) and the full [Environment variables](./environment-variables.md) reference.

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

### Bash command approval patterns

`tools.approval` is a record keyed by tool name; dotted forms such as `tools.approval.eval` and `tools.approval.computer` identify entries in that record, not separate settings-schema paths. Each entry sets that tool's default policy. For bash, you can add ordered command rules with `bash.patterns`; the first matching rule wins. Patterns support literal text plus `*` as a wildcard.

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

Matching is asymmetric so that rules mean what they appear to: `deny` and `prompt` rules fire when the glob matches the whole command **or any single segment** of a compound line (split on `&&`, `||`, `;`, `|`, a single `&`, subshells, and newlines), so `match: "rm -rf *"` still denies `cd /tmp && rm -rf build` and `sleep 1 & rm -rf build`. `allow` rules must match the **entire** command and never apply to a compound line, so a narrow allow such as `match: "git *"` cannot vouch for `git status && rm -rf /`.

`bash.patterns` gates the `bash` tool only. It does not cover shells started through `eval`, which can spawn one via subprocess, so a `deny` rule here is bypassed when the same command runs through `eval`. To close that path, add a `tools.approval.eval` policy (`prompt` or `deny`) as well; see [Tool approval mode](./approval-mode.md).

### Bash interceptor patterns

`bashInterceptor` is separate from `bash.patterns`: it redirects Bash commands to dedicated tools rather than defining whether a command may execute. Enable it explicitly and configure regular-expression patterns with a replacement tool and a model-facing message:

```yaml
bashInterceptor:
  enabled: true
  patterns:
    - pattern: '^\s*(cat|head|tail)\s+'
      tool: read
      message: "Use the read tool instead."
```

The named replacement tool must be available in the current session or the interceptor does not block the Bash call. For a detailed comparison of permission policy and dedicated-tool routing, including compound-command behavior and ordering, see [the Bash tool documentation](tools/bash.md#command-policy-and-dedicated-tool-routing).

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
  - google

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
  approvalMode: write # kept from global (object deep-merge)
  approval:
    bash: allow # overridden by project
    read: allow # kept from global
disabledProviders:
  - groq # project array REPLACES the global array
```

Array replacement is the most common surprise: the project's `disabledProviders` does not extend the global list — it becomes the entire list for that project. The same applies to `enabledModels`, `cycleOrder`, `extensions`, and every other array-typed setting.

## Project-local config

Create `<repo>/.omp/config.yml` when a repository needs its own settings:

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

Keep secrets out of committed project config unless your repository policy allows it. Prefer environment variables, stored auth, an auth broker, or an untracked `--config` overlay for credentials.

### One-shot overlays

Use `--config` for a temporary layer that should not persist:

```bash
omp --config ./local/ci-settings.yml "check this failure"
omp --config ./base.yml --config ./experiment.yml "try this model"
```

`--config` is accepted by the default launch command, `acp`, and `models`.

Wrappers may instead set `PI_CONFIG_FILES` to a platform-delimited path list (`:` on Unix, `;` on Windows). Environment overlays load in listed order before explicit `--config` overlays.

Overlay paths are resolved relative to the process working directory (and `~` is expanded). Each overlay must parse as a YAML mapping; a missing file, invalid YAML, or a top-level array/scalar is a hard error — it does **not** silently fall back to lower-precedence settings.

## Path-scoped arrays

Two array settings — `enabledModels` and `disabledProviders` — accept path-scoped entries in addition to bare strings, so a single global config can behave differently per directory:

```yaml
enabledModels:
  - claude-sonnet-4-5 # applies everywhere
  - path: ~/work/high-context
    models:
      - anthropic/claude-opus-4-5

disabledProviders:
  - ollama # applies everywhere
  - paths:
      - ~/projects/sensitive
      - ~/clients/acme
    providers:
      - anthropic
      - openai
```

Bare string entries apply everywhere. A scoped entry applies when the current working directory **is** the configured path or is **under** it. `~` expands to your home directory and relative paths are resolved before matching.

Accepted **path** keys (any of them, combined): `path`, `paths`, `pathPrefix`, `pathPrefixes`.

Accepted **value** keys:

- `models` (for `enabledModels`) or `providers` (for `disabledProviders`)
- `values` or `items` (for either setting)

Only string values are kept; malformed scoped entries are ignored. Path scoping is resolved **after** the layer merge, so it reads the final effective array.

## Provider and source disabling

`disabledProviders` is a single shared id namespace that gates two different subsystems, before any credential check:

| Entry kind        | Example ids                                                                        | Effect                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model providers   | `anthropic`, `openai`, `google`, `groq`, `ollama`, `openrouter`                    | Removes those backends from model selection, even when credentials are available. See [Providers](./providers.md).                                             |
| Discovery sources | `native`, `claude`, `codex`, `gemini`, `github`, `opencode`, `cursor`, `agents-md` | Stops that source from contributing context files, MCP servers, commands, skills, hooks, tools, prompts, or settings. See [Context files](./context-files.md). |

Most provider-control use cases list model provider ids. Disabling the `claude` discovery source is different from disabling the `anthropic` model provider — one stops Claude-format config discovery, the other stops the Anthropic model backend.

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

The default is an empty array (nothing disabled). For the two subsystems' provider ids and ordering, see [Providers](./providers.md) and [Context files](./context-files.md).

## Settings catalog

The catalog below highlights common settings; it is not the complete schema. `omp config list` is the authoritative reference for every key, current value, type, and description. Defaults and enum values shown here come from the schema. Settings that accept an env or flag override are noted; those overrides are process-local and not persisted.

### Models

`modelRoles`, `modelTags`, and `cycleOrder` work together to define the models you can switch between. Role values may carry a thinking suffix (`:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`).

```yaml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high
  vision: google/gemini-3.1-pro-preview
  plan: anthropic/claude-opus-4-5
  advisor: anthropic/claude-sonnet-4-5:medium

cycleOrder:
  - smol
  - default
  - slow

modelProviderOrder:
  - anthropic
  - openai

enabledModels:
  - claude-sonnet-4-5
```

| Key                    | Type    | Default                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelRoles`           | record  | `{}`                        | Map of role name -> model id. Built-in roles: `default`, `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`, `task`, `advisor`. The `tiny` role overrides the online model for lightweight background tasks (titles, memory, auto-thinking, unexpected-stop), else `@smol`. Per-role env/flags exist only for `--model`/`--smol`/`--slow`/`--plan`; configure the advisor with `modelRoles.advisor`. |
| `modelRoleStorage`     | enum    | `global`                    | `global` saves model-selector role assignments in the active global/profile config; `project` saves only those role assignments in `<cwd>/.omp/config.yml`. Missing project roles fall back to global roles.                                                                                                                                                                                                     |
| `modelTags`            | record  | `{}`                        | Custom role/tag metadata; can introduce additional roles.                                                                                                                                                                                                                                                                                                                                                        |
| `modelProviderOrder`   | array   | `[]`                        | Preferred provider order when a model id is ambiguous.                                                                                                                                                                                                                                                                                                                                                           |
| `cycleOrder`           | array   | `["smol","default","slow"]` | Roles cycled by the model switcher.                                                                                                                                                                                                                                                                                                                                                                              |
| `enabledModels`        | array   | `[]`                        | Allow-list of models; supports [path-scoped entries](#path-scoped-arrays). Empty means all available models.                                                                                                                                                                                                                                                                                                     |
| `disabledProviders`    | array   | `[]`                        | Disabled model/discovery providers; supports path-scoped entries. See [above](#provider-and-source-disabling).                                                                                                                                                                                                                                                                                                   |
| `includeModelInPrompt` | boolean | `true`                      | Include the active model name in the system prompt.                                                                                                                                                                                                                                                                                                                                                              |

See [Models](./models.md) for the `models.yml` schema and custom-provider definitions.

### Advisor

The advisor is a second model that reviews each completed turn and can inject advice into the primary session. Assign a model with `modelRoles.advisor`, then enable it with `advisor.enabled`, `/advisor on`, or by launching with the `--advisor` flag.

See [Advisor and WATCHDOG.md](./advisor-watchdog.md) for runtime behavior, `WATCHDOG.md` discovery, and bounded catch-up semantics.

| Key                   | Type    | Default | Notes                                                                                                                                                |
| --------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advisor.enabled`     | boolean | `false` | Enable the advisor runtime when `modelRoles.advisor` resolves to an available model.                                                                 |
| `task.agentAdvisor`   | record  | `{}`    | Per-agent subagent advisor: agent name → `"on"` / `"off"` / advisor model pattern. Overrides agent frontmatter `advisor`; configured from the `/agents` hub. |
| `advisor.syncBacklog` | enum    | `off`   | Bounded advisor catch-up delay: `off`, `1`, `3`, or `5`. The primary waits up to 30 seconds only while advisor backlog is at or above the threshold. |
| `advisor.immuneTurns` | number  | `3`     | After a `concern`/`blocker` interrupts, route further concerns/blockers as non-interrupting asides for this many completed primary turns.            |

### Thinking

```yaml
defaultThinkingLevel: high
hideThinkingBlock: false
thinkingBudgets:
  minimal: 1024
  low: 2048
  medium: 8192
  high: 16384
  xhigh: 32768
  max: 32768
```

| Key                               | Type    | Default | Values                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultThinkingLevel`            | enum    | `high`  | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`. Override per run with `--thinking`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `hideThinkingBlock`               | boolean | `false` | Hide thinking blocks in output. `--hide-thinking` sets it for the run (display only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `thinkingBudgets.minimal`         | number  | `1024`  | Token budget for the `minimal` level.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `thinkingBudgets.low`             | number  | `2048`  | Token budget for `low`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `thinkingBudgets.medium`          | number  | `8192`  | Token budget for `medium`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `thinkingBudgets.high`            | number  | `16384` | Token budget for `high`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `thinkingBudgets.xhigh`           | number  | `32768` | Token budget for `xhigh`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `thinkingBudgets.max`             | number  | `32768` | Token budget for `max`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `providers.autoThinkingMaxEffort` | enum    | `xhigh` | Highest effort `defaultThinkingLevel: auto` may resolve. `xhigh` keeps the classifier one tier below the top, so only `ultrathink` reaches `max`; `max` lets the classifier bill the top tier on models that expose it. The local on-device classifier stays capped at `xhigh` either way. This governs what `auto` _resolves_: a model whose ladder offers nothing under the ceiling gets no auto level at all, and one whose metadata requires explicit effort still receives its lowest supported effort from the transport — on a `["max"]` ladder that is `max`, because the model accepts nothing else. |

### Sampling

A value of `-1` means "use the provider/model default" — `omp` does not send that parameter.

| Key                 | Type   | Default   | Notes                                                                                                                                                                                                                                                                          |
| ------------------- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `temperature`       | number | `-1`      | Sampling temperature.                                                                                                                                                                                                                                                          |
| `topP`              | number | `-1`      | Nucleus sampling.                                                                                                                                                                                                                                                              |
| `topK`              | number | `-1`      | Top-K sampling.                                                                                                                                                                                                                                                                |
| `minP`              | number | `-1`      | Minimum-probability cutoff.                                                                                                                                                                                                                                                    |
| `presencePenalty`   | number | `-1`      | Presence penalty.                                                                                                                                                                                                                                                              |
| `repetitionPenalty` | number | `-1`      | Repetition penalty.                                                                                                                                                                                                                                                            |
| `textVerbosity`     | enum   | `medium`  | `low`, `medium`, `high`. Sent as response verbosity by OpenAI Responses and Codex transports.                                                                                                                                                                                  |
| `tier.openai`       | enum   | `none`    | `none`, `auto`, `default`, `flex`, `scale`, `priority`. Sent as `service_tier` for OpenAI / OpenAI-Codex and OpenAI-family OpenRouter models. Launch with `--service-tier <value>` for a one-session OpenAI override; the flag is not persisted (`none` omits `service_tier`). |
| `tier.anthropic`    | enum   | `none`    | `none`, `priority`. `priority` realizes fast mode on supported direct Claude models (ignored on Bedrock/Vertex and via OpenRouter).                                                                                                                                            |
| `tier.google`       | enum   | `none`    | `none`, `flex`, `priority`. Gemini API sends it in the body; Vertex sends `priority` via header (`flex` is a no-op on Vertex).                                                                                                                                                 |
| `tier.subagent`     | enum   | `inherit` | `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`. Applied to the spawned model's family; `inherit` tracks the main agent.                                                                                                                                     |
| `tier.advisor`      | enum   | `none`    | `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`. Applied to the advisor model's family.                                                                                                                                                                      |
| `personality`       | enum   | `default` | `default`, `friendly`, `pragmatic`, `none`. A user-level `<agent dir>/PERSONALITY.md` replaces the selected preset's text; `none` still omits the block. See [system-prompt-customization](./system-prompt-customization.md).                                                  |

### Retry and fallback

```yaml
retry:
  enabled: true
  maxRetries: 10
  baseDelayMs: 500
  maxDelayMs: 300000
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
  fallbackChains:
    # Any role without an explicit chain inherits the "default" chain.
    default:
      - anthropic/claude-opus-4-5
      - openai/gpt-5.5
      - google/gemini-3-pro
    # Per-role chains override the default (roles from `modelRoles`,
    # including custom roles). Selectors accept an optional thinking
    # suffix, e.g. openai/gpt-5.5:low.
    smol:
      - openai/gpt-5.5-mini
      - anthropic/claude-haiku-4-5
    # Model-selector keys (any key containing "/") attach the chain to the
    # model itself: it applies whenever that model is active, no matter
    # which role it is assigned to, and survives role reassignment.
    google/gemini-3-pro:
      - google-vertex/gemini-3-pro
    # A `provider/*` KEY covers every model of a provider — current or
    # future. A `provider/*` ENTRY keeps the failing model's id and swaps
    # the provider: google-antigravity/x -> google/x -> google-vertex/x.
    # Ids missing on the target provider are skipped (near-miss ids resolve
    # fuzzily); exact model keys override the wildcard for a specific model.
    google-antigravity/*:
      - google/*
      - google-vertex/*

providers:
  anthropic:
    serverSideFallback: false
```

| Key                                      | Type    | Default           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retry.enabled`                          | boolean | `true`            | Retry transient provider errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `retry.maxRetries`                       | number  | `10`              | Max retries per request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `retry.baseDelayMs`                      | number  | `500`             | Initial backoff.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `retry.maxDelayMs`                       | number  | `300000`          | Backoff ceiling (5 min). Provider-stated waits longer than this fail fast instead of sleeping when no credential or model fallback succeeds; `0` disables the cap (to auto-resume through provider-stated quota resets).                                                                                                                                                                                                                                                                                                                  |
| `retry.modelFallback`                    | boolean | `true`            | Fall back to another model when one is unavailable.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `retry.fallbackChains`                   | record  | `{}`              | Maps roles, model selectors, or `provider/*` wildcards to ordered fallback selectors. Keys containing `/` are model-oriented and win over roles: `provider/model-id` matches that exact model, `provider/*` matches every model of the provider. A `provider/*` _entry_ keeps the failing model's id and swaps the provider. The `default` chain covers every assigned role without its own chain. Unknown models/providers or malformed chains are reported as config warnings at startup. |
| `retry.fallbackRevertPolicy`             | enum    | `cooldown-expiry` | `cooldown-expiry` returns to the primary model once its suppression window ends; `never` stays on the fallback until switched manually.                                                                                                                                                                                                                                                                                                                                                     |
| `providers.anthropic.serverSideFallback` | boolean | `false`           | Opt in to Anthropic's `server-side-fallback-2026-06-01` beta. Only direct `anthropic` provider requests using the `anthropic-messages` API for Claude Fable or Mythos models are eligible. On an Anthropic safety-classifier block, the provider may retry server-side with `claude-opus-4-8`; every other provider, API, and model is unaffected.                                                                                                                                          |
| `providers.openai-codex.codeMode`           | enum    | `off`             | Codex Code Mode for `code_mode_only` models (GPT-5.6 Sol/Terra/Luna), mirroring codex-rs: the direct tool surface collapses to `eval`/`ask`/`todo` and every other session tool is invoked from `eval` cells via its `tool.<name>()` bridge, collapsing multi-step tool work into one model round trip. `auto` follows the model catalog's `tool_mode` flag; `on` forces it for any Codex model; `off` (default) leaves the full direct surface. The turn metadata carries codex-rs's `tool_namespaces_info` exposure snapshot while active. |
| `providers.openai-codex.codeModeDirectTools` | array   | `[]`              | Extra tool names to keep directly callable alongside `eval`/`ask`/`todo` when Codex Code Mode is active; entries that are not enabled in the session are ignored. |

When the active model keeps failing (429s, quota walls, provider outages) and `retry.modelFallback` is on, the session picks the chain that owns the failing model, by specificity: an exact `provider/model-id` key, then a `provider/*` wildcard, then the current role's chain, then `default`. If several roles assign the same model, yaml key order does not decide: the live session role wins, and `default` wins over other matching roles when the session is not on those roles. It skips models whose selectors are still cooling down and switches for the rest of the turn. Subagents get their own per-spawn chains when their agent definition lists multiple model patterns — the first resolvable pattern is primary and the rest become its fallbacks; there is no `agent:<name>` key in `fallbackChains`.

### Tools and approvals

```yaml
tools:
  format: auto
  approvalMode: yolo # default
  approval:
    bash: prompt
    edit: allow
  maxTimeout: 0
  intentTracing: true
```

| Key                            | Type    | Default | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.format`                 | enum    | `auto`  | Tool wire format: `auto`, `native`, `glm`, `hermes`, `kimi`, `xml`, `anthropic`, `deepseek`, `harmony`, `qwen3`, `gemini`, `gemma`, or `minimax`. `native` always uses provider-native tool calls. `auto` also uses native calls unless the selected model explicitly has `supportsTools: false`; then it selects the model-family owned dialect, falling back to GLM when no specific family dialect is known. Other values force that owned in-band dialect. `xml` is the [generic XML format](./toolconv/xml.md); `minimax` is the [MiniMax format](./toolconv/minimax.md). Applies on session start. See [GLM](./toolconv/glm-4.5.md), [Qwen3/Hermes](./toolconv/qwen3.md), [Kimi](./toolconv/kimi-k2.md), [Anthropic](./toolconv/anthropic.md), [DeepSeek](./toolconv/deepseek.md), [Harmony](./toolconv/harmony.md), [Gemini](./toolconv/gemini.md), and [Gemma](./toolconv/gemma.md). |
| `tools.approvalMode`           | enum    | `yolo`  | `always-ask` (auto-approve read-only), `write` (auto-approve read + workspace-write), `yolo` (auto-approve all tiers). `--approval-mode` and `--auto-approve`/`--yolo` override per run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tools.approval`               | record  | `{}`    | Per-tool policy keyed by tool name; each value is `allow`, `deny`, or `prompt`. e.g. `omp config set tools.approval '{"bash":"prompt"}'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tools.maxTimeout`             | number  | `0`     | Max tool runtime in seconds; `0` = no cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tools.intentTracing`          | boolean | `true`  | Record per-call intent strings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tools.outputMaxColumns`       | number  | `768`   | Per-line byte cap for streaming output; `0` disables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tools.artifactSpillThreshold` | number  | `50`    | KB of tool output above which output spills to an artifact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tools.artifactHeadBytes`      | number  | `20`    | KB of head kept inline on spill; `0` = tail-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tools.artifactTailBytes`      | number  | `20`    | KB of tail kept inline on spill.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tools.artifactTailLines`      | number  | `500`   | Max tail lines kept inline on spill.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Individual built-in tools are toggled by their own keys, e.g. `bash.enabled`, `launch.enabled`, `eval.py`, `eval.js`, `glob.enabled`, `grep.enabled`, `fetch.enabled`, `browser.enabled`, `computer.enabled`, `astEdit.enabled`, `astGrep.enabled`, and `web_search.enabled`. The `inspect_image` tool is controlled by the tri-state `inspect_image.mode` (`auto`|`on`|`off`, default `auto`): `auto` exposes it only when the active model lacks native image input, and the `/vision` slash command overrides the mode per session.

### Window-scoped computer use

The disabled-by-default `computer` essential tool captures and controls one real host window through native OS APIs. Numeric targets isolate an application without focusing it or moving the real pointer; the synthetic `desktop` target preserves the previous selected-display composite and global input behavior. It remains separate from `browser`, which manages Chromium/CDP tabs and structured page automation.

```yaml
computer:
  enabled: true
  display: all
  maxWidth: 3840
  maxHeight: 2400
```

| Key                  | Type    | Default | Notes                                                                                                                                                                                                                                                        |
| -------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `computer.enabled`   | boolean | `false` | Enable the window-aware computer function tool. Every result lists current numeric window ids plus `desktop`; the `/computer` slash command toggles the tool for the current session only.                                                                   |
| `computer.display`   | string  | `all`   | Controls the `desktop` target only: composite all active displays, or use one numeric display ID.                                                                                                                                                            |
| `computer.maxWidth`  | number  | `3840`  | Maximum composite screenshot width in pixels. Image transports that cannot preserve original detail, including GitHub Copilot Responses and xAI OAuth, cap the effective width at `1280`; Claude-family models use the same cap as a compatibility fallback. |
| `computer.maxHeight` | number  | `2400`  | Maximum composite screenshot height in pixels. Those coordinate-safe transports cap the effective height at `896`; other models retain the configured limit.                                                                                                 |

Computer settings are captured when the desktop controller is created. A model switch that crosses the coordinate-safe sizing boundary recreates the controller and resnapshots those settings; changing config alone does not, so start a new session after a settings change. Every call must name `desktop` or a numeric id from the preceding window list. Switching targets invalidates the prior coordinate frame, so capture the new target before pointer input. Before enabling input, configure `tools.approvalMode` or `tools.approval.computer` and grant platform permissions. See [Window-scoped computer use](computer-use.md).

### Shell, eval, and LSP

```yaml
bash:
  enabled: true
  autoBackground:
    enabled: true
    thresholdMs: 60000

eval:
  py: true
  js: true

python:
  kernelMode: session # session, per-call
  interpreter: ""

lsp:
  enabled: true
  lazy: true
  diagnosticsOnWrite: true
  diagnosticsOnEdit: false
  formatOnWrite: false
```

| Key                               | Type    | Default   | Notes                                                                                                                                                       |
| --------------------------------- | ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash.enabled`                    | boolean | `true`    | Enable the bash tool.                                                                                                                                       |
| `launch.enabled`                  | boolean | `true`    | Enable the launch tool for shared long-running project processes.                                                                                           |
| `bash.autoBackground.enabled`     | boolean | `true`   | Auto-background long-running commands.                                                                                                                      |
| `bash.autoBackground.thresholdMs` | number  | `60000`   | Threshold before auto-backgrounding.                                                                                                                        |
| `eval.py`                         | boolean | `true`    | Python eval backend. `PI_PY=0` disables for the process.                                                                                                    |
| `eval.js`                         | boolean | `true`    | JavaScript eval backend. `PI_JS=0` disables for the process.                                                                                                |
| `python.kernelMode`               | enum    | `session` | `session` (persistent kernel) or `per-call`.                                                                                                                |
| `python.interpreter`              | string  | `""`      | Path to a Python interpreter; empty = auto-detect.                                                                                                          |
| `lsp.enabled`                     | boolean | `true`    | Language-server integration. `--no-lsp` disables for the run.                                                                                               |
| `lsp.lazy`                        | boolean | `true`    | Start servers on demand.                                                                                                                                    |
| `lsp.shared`                      | boolean | `true`    | Share one language server per project across local `omp` processes through the daemon broker; falls back to private servers when the broker is unavailable. |
| `lsp.diagnosticsOnWrite`          | boolean | `true`    | Run diagnostics after a write.                                                                                                                              |
| `lsp.diagnosticsOnEdit`           | boolean | `false`   | Run diagnostics after an edit.                                                                                                                              |
| `lsp.formatOnWrite`               | boolean | `false`   | Format files on write.                                                                                                                                      |
| `lsp.diagnosticsDeduplicate`      | boolean | `true`    | Collapse duplicate diagnostics.                                                                                                                             |
| `shellPath`                       | string  | _(unset)_ | Override the shell binary used by bash.                                                                                                                     |

### Files: editing and reading

```yaml
edit:
  mode: hashline # apply_patch, hashline, patch, replace
  fuzzyMatch: true
  fuzzyThreshold: 0.95
  blockAutoGenerated: true
  blackbox:
    enabled: false

read:
  defaultLimit: 300
  toolResultPreview: false
  summarize:
    enabled: true
    prose: false
```

| Key                       | Type    | Default    | Notes                                             |
| ------------------------- | ------- | ---------- | ------------------------------------------------- |
| `edit.mode`               | enum    | `hashline` | `apply_patch`, `hashline`, `patch`, `replace`.    |
| `edit.fuzzyMatch`         | boolean | `true`     | Allow fuzzy anchor matching.                      |
| `edit.fuzzyThreshold`     | number  | `0.95`     | Similarity threshold for fuzzy matching.          |
| `edit.blockAutoGenerated` | boolean | `true`     | Refuse to edit generated/lockfile-like files.     |
| `edit.streamingAbort`     | boolean | `false`    | Abort on streaming edit mismatch.                 |
| `edit.blackbox.enabled`   | boolean | `false`    | Append full source for AST parse regressions.      |
| `read.defaultLimit`       | number  | `300`      | Default line count for `read` without a selector. |
| `read.summarize.enabled`  | boolean | `true`     | Structural summaries for code reads.              |
| `read.summarize.prose`    | boolean | `false`    | Summarize prose files too.                        |
| `read.toolResultPreview`  | boolean | `false`    | Inline preview of tool results.                   |
| `readLineNumbers`         | boolean | `false`    | Show plain line numbers.                          |

### Context, compaction, and memory

```yaml
contextPromotion:
  enabled: false

compaction:
  enabled: true
  methodOrder: [remote, snapcompact, handoff, shake, soft]
  midTurnEnabled: true # check thresholds between tool-loop provider requests
  thresholdPercent: -1 # -1 = default reserve-based behavior
  thresholdTokens: -1 # fixed token limit when > 0
memory:
  backend: off # off, local, hindsight, mnemopi
```

| Key                           | Type    | Default                                  | Notes                                                                                                                                                                                                                                     |
| ----------------------------- | ------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contextPromotion.enabled`    | boolean | `false`                                  | Promote to the active model's explicit `contextPromotionTarget` on context overflow.                                                                                                                                                      |
| `compaction.enabled`          | boolean | `true`                                   | Automatic conversation compaction.                                                                                                                                                                                                        |
| `compaction.asyncEnabled`     | boolean | `true`                                   | Speculatively summarize in the background as context nears the compaction threshold, then splice the ready result in when the threshold is crossed.                                                                                        |
| `compaction.midTurnEnabled`   | boolean | `true`                                   | Check thresholds at safe mid-turn tool-loop boundaries before the next provider request.                                                                                                                                                  |
| `compaction.methodOrder`      | array   | `remote, snapcompact, handoff, shake, soft` | Ordered fallbacks. `remote` uses provider-native OpenAI-compatible server compaction; unavailable or failed methods advance. |
| `compaction.thresholdPercent` | number  | `-1`                                     | Percent-of-context trigger; `-1` = reserve-based default.                                                                                                                                                                                 |
| `compaction.thresholdTokens`  | number  | `-1`                                     | Fixed token trigger when `> 0`.                                                                                                                                                                                                           |
| `compaction.reserveTokens`    | number  | _(unset)_                                | Absolute reserve floor. When unset, the effective reserve is the larger of `16384` and 15% of the context window; if that default would leave no practical small-window budget, it falls back to the 15% reserve.                         |
| `compaction.keepRecentTokens` | number  | `20000`                                  | Recent tokens always preserved.                                                                                                                                                                                                           |
| `compaction.autoContinue`     | boolean | `true`                                   | Continue automatically after compaction.                                                                                                                                                                                                  |
| `memory.backend`              | enum    | `off`                                    | `off`, `local`, `hindsight`, `mnemopi`. Each backend has its own `hindsight.*` / `mnemopi.*` / `memories.*` tuning keys.                                                                                                                  |
| `autolearn.enabled`           | boolean | `false`       | Experimental: after the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills under `~/.omp/agent/managed-skills`. Enables the `manage_skill` tool (and `learn` when a memory backend is active). |
| `autolearn.autoContinue`      | boolean | `false`       | When `autolearn.enabled`, auto-run one capture turn at stop (uses extra tokens). Off = a passive reminder rides your next turn.                                                                                                           |
| `autolearn.minToolCalls`      | number  | `5`           | Only nudge after a turn that used at least this many tools.                                                                                                                                                                               |

`compaction` has additional tuning keys (idle compaction, supersede/drop heuristics) visible in `omp config list`. See [Compaction](./compaction.md) for the full strategy reference.

### Appearance and terminal

```yaml
theme:
  dark: titanium
  light: light
symbolPreset: unicode # unicode, nerd, ascii
colorBlindMode: false

statusLine:
  preset: default # default, minimal, compact, full, nerd, ascii, custom
  separator: powerline-thin
  transparent: false
  showHookStatus: true

terminal:
  showImages: true
images:
  autoResize: true
  blockImages: false
tui:
  hyperlinks: auto # off, auto, always
```

| Key                         | Type    | Default          | Values                                                                    |
| --------------------------- | ------- | ---------------- | ------------------------------------------------------------------------- |
| `theme.dark`                | string  | `titanium`       | Theme used on a dark terminal background.                                 |
| `theme.light`               | string  | `light`          | Theme used on a light terminal background.                                |
| `symbolPreset`              | enum    | `unicode`        | `unicode`, `nerd`, `ascii`.                                               |
| `colorBlindMode`            | boolean | `false`          | Use blue instead of green for diff additions.                             |
| `showHardwareCursor`        | boolean | `true`           | Show the terminal hardware cursor.                                        |
| `statusLine.preset`         | enum    | `default`        | `default`, `minimal`, `compact`, `full`, `nerd`, `ascii`, `custom`.       |
| `statusLine.separator`      | enum    | `powerline-thin` | `powerline`, `powerline-thin`, `slash`, `pipe`, `block`, `none`, `ascii`. |
| `statusLine.sessionAccent`  | boolean | `true`           | Tint the editor border with the session color.                            |
| `statusLine.transparent`    | boolean | `false`          | Use the terminal background for the status line.                          |
| `statusLine.showHookStatus` | boolean | `true`           | Show hook status messages.                                                |
| `terminal.showImages`       | boolean | `true`           | Render images inline (when the terminal supports it).                     |
| `images.autoResize`         | boolean | `true`           | Resize large images for model compatibility.                              |
| `images.blockImages`        | boolean | `false`          | Never send images to providers.                                           |
| `tui.hyperlinks`            | enum    | `auto`           | `off`, `auto`, `always`.                                                  |
| `tui.resizeScrollback`      | enum    | `rebuild`        | How a settled width resize refreshes transcript rows kept in terminal scrollback: `append` replays the transcript at the new width below retained history, `rebuild` erases pane scrollback then replays one current-width copy, `preserve` repaints only the viewport. |

For a custom status line, set `statusLine.preset: custom` and configure `statusLine.leftSegments`, `statusLine.rightSegments`, and `statusLine.segmentOptions`.

### Interaction

| Key                    | Type    | Default         | Values                                                                                                  |
| ---------------------- | ------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `steeringMode`         | enum    | `one-at-a-time` | `all`, `one-at-a-time`. How queued steering messages are delivered.                                     |
| `followUpMode`         | enum    | `one-at-a-time` | `all`, `one-at-a-time`.                                                                                 |
| `interruptMode`        | enum    | `immediate`     | `immediate`, `wait`.                                                                                    |
| `doubleEscapeAction`   | enum    | `rewind`          | `rewind`, `none`.                                                                               |
| `autoResume`           | boolean | `false`         | Auto-resume the most recent session in the cwd.                                                         |
| `plan.enabled`         | boolean | `true`          | Enable plan mode.                                                                                       |
| `plan.defaultOnStartup` | boolean | `false`         | Start each fresh interactive session in plan mode when plan mode is enabled. Print/JSON (`--print`) mode ignores this and prints a note; use `--plan-yolo` for a headless plan flow. |
| `ask.timeout`          | number  | `0`             | Seconds before an `ask` prompt times out; `0` = no timeout. (Legacy ms values are migrated to seconds.) |
| `ask.notify`           | enum    | `on`            | `on`, `off`.                                                                                            |

### Providers and services

```yaml
providers:
  webSearchOrder: [perplexity, exa, gemini]
  imageOrder: [openai, xai]
  fetch: auto
  webSearchGeminiModel: gemini-2.5-flash
  tinyModel: online
  tinyModelDevice: default
  tinyModelDtype: default
  openaiWebsockets: auto
  openrouterVariant: default
  kimiApiFormat: auto
  cacheRetention: auto
  maxInFlightRequests:
    anthropic: 2

provider:
  appendOnlyContext: auto # auto, on, off

exa:
  enabled: true
  searchDelayMs: 1000

searxng:
  endpoint: https://search.example.com
  token: SEARXNG_TOKEN
```

| Key                                 | Type    | Default   | Values / notes                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers.webSearchOrder`          | array   | `[]`      | Provider IDs in priority order for `web_search` (`perplexity`, `gemini`, `anthropic`, `codex`, `xai`, `zai`, `exa`, `tinyfish`, `jina`, `kagi`, `tavily`, `firecrawl`, `brave`, `kimi`, `parallel`, `synthetic`, `searxng`, `startpage`, `duckduckgo`, `ecosia`, `google`, `mojeek`, `public`). Duplicates and unknown IDs are ignored; unlisted providers retain their built-in relative order afterward. Empty = built-in order. Replaces the removed `providers.webSearch` enum (a legacy value migrates to the head of this list). |
| `providers.webSearchExclude`        | array   | `[]`      | Search provider IDs that `web_search` must never use, even as fallbacks. Accepts the same provider IDs as `providers.webSearchOrder`.                                                                                                                                                                                                                                                                                              |
| `providers.webSearchTimeoutSeconds` | number  | `60`      | Hard timeout in seconds supplied to each `web_search` provider transport before the automatic chain advances to the next fallback. Use a larger value for slower model-backed providers; values above `300` are capped at five minutes. This is not a whole-chain deadline, and provider-specific upstream or aggregate limits may still be shorter.                                                                                   |
| `providers.webSearchGeminiModel`    | string  | _(unset)_ | Gemini model ID for Google Search grounding when `web_search` uses Gemini; defaults to `gemini-2.5-flash`, overridden by `GEMINI_SEARCH_MODEL`.                                                                                                                                                                                                                                                                                        |
| `providers.imageOrder`              | array   | `[]`      | Image-generation provider IDs in priority order (`openai`, `openai-codex`, `antigravity`, `xai`, `gemini`, `openrouter`). Unlisted providers follow the active session provider and the built-in order. Replaces the removed `providers.image` enum (a legacy value migrates to the head of this list).                                                                                                                                |
| `providers.fetch`                   | enum    | `auto`    | `auto`, `native`, `trafilatura`, `lynx`, `parallel`, `jina`.                                                                                                                                                                                                                                                                                                                                                                           |
| `providers.tinyModel`               | enum    | `online`  | `online` or a local model (`lfm2-350m`, `qwen3-0.6b`, `gemma-270m`, `qwen2.5-0.5b`, `lfm2-700m`).                                                                                                                                                                                                                                                                                                                                      |
| `providers.tinyModelDevice`         | enum    | `default` | ONNX execution provider for local tiny models. Overridden by `PI_TINY_DEVICE`.                                                                                                                                                                                                                                                                                                                                                         |
| `providers.maxInFlightRequests`     | record  | `{}`      | Positive per-provider concurrency limits for LLM HTTP requests, shared across local `omp` processes using the same config root. Omitted providers are unlimited. `omp config set` rejects non-positive or non-numeric values.                                                                                                                                                                                                          |
| `providers.tinyModelDtype`          | enum    | `default` | ONNX precision for local tiny models. Overridden by `PI_TINY_DTYPE`.                                                                                                                                                                                                                                                                                                                                                                   |
| `providers.openaiWebsockets`        | enum    | `auto`    | `auto`, `off`, `on`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `providers.openrouterVariant`       | enum    | `default` | `default`, `nitro`, `floor`, `online`, `exacto`.                                                                                                                                                                                                                                                                                                                                                                                       |
| `providers.kimiApiFormat`           | enum    | `auto`    | `auto`, `openai`, `anthropic`. `auto` follows live model metadata.                                                                                                                                                                                                                                                                                                                                                                     |
| `providers.cacheRetention`          | enum    | `auto`    | `auto`, `short`, `long`, `none`. Prompt-cache retention forwarded to providers that support it. `auto` keeps provider defaults (Anthropic: 5m entries + idle keep-alive refreshes) and honors `PI_CACHE_RETENTION`; `short` forces 5m; `long` uses 1h TTLs where supported and disables keep-alive refreshes; `none` disables prompt caching and cache-affinity routing.                                                                 |
| `provider.appendOnlyContext`        | enum    | `auto`    | `auto`, `on`, `off`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exa.enabled`                       | boolean | `true`    | Enable the Exa web search provider.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `exa.searchDelayMs`                 | number  | `1000`    | Minimum delay between Exa web search requests in milliseconds; set `0` to disable pacing.                                                                                                                                                                                                                                                                                                                                               |
| `searxng.endpoint`                  | string  | _(unset)_ | SearXNG instance URL.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `searxng.token`                     | string  | _(unset)_ | SearXNG token; also `searxng.basicUsername`/`searxng.basicPassword`/`searxng.categories`/`searxng.language`/`searxng.engines` (comma-separated engine names or bang shortcuts, e.g. `ddg, br, startpage`, sent as the API's `engines=` parameter)/`searxng.safesearch`.                                                                                                                                                                                                                                                                                                 |
| `auth.broker.url`                   | string  | _(unset)_ | Auth-broker URL. Overridden by `OMP_AUTH_BROKER_URL`.                                                                                                                                                                                                                                                                                                                                                                                  |
| `auth.broker.token`                 | string  | _(unset)_ | Auth-broker token. Overridden by `OMP_AUTH_BROKER_TOKEN`.                                                                                                                                                                                                                                                                                                                                                                              |
| `secrets.enabled`                   | boolean | `false`   | Enable configured secret obfuscation and built-in credential-shaped token redaction before provider requests. See [Secret obfuscation](./secrets.md).                                                                                                                                                                                                                                                                                  |

Provider credentials and custom model definitions are configured separately — see [Providers](./providers.md) and [Models](./models.md).

### Other groups

Every schema path not individually tabulated in this catalog is explicitly deferred to `omp config list`. Additional groups include:

- Agent behavior and safety: `ask.*`, `eval.*`, `features.*`, `goal.*`, `loop.*`, `model.loopGuard.*`, `model.toolCallLoopGuard.*`, `prewalk.*`, `recap.*`, `tools.*`, and `vault.*`.
- Execution and content: `commit.*`, `completion.*`, `edit.*`, `error.*`, `extensionHandlers.*`, `generate_image.*`, `git.*`, `images.*`, `live.*`, `paste.*`, `power.*`, `read.*`, `shellMinimizer.*`, `speech.*`, `terminal.*`, and `title.*`.
- Interface and startup: `display.*`, `statusLine.*`, `startup.*`, `stt.*`, `tui.*`, and `ttsr.*`.
- Integrations, storage, and discovery: `async.*`, `bashInterceptor.*`, `codexResets.*`, `collab.*`, `commands.*`, `dev.*`, `exa.*`, `gc.*`, `github.*`, `hindsight.*`, `magicKeywords.*`, `mcp.*`, `memories.*`, `mnemopi.*`, `providers.*`, `searxng.*`, `share.*`, `skills.*`, `task.*` (including the subagent wrap-up guard: `task.softRequestBudget` with the `task.softRequestBudgetNotice` steering notice), `todo.*`, `tts.*`, and `workspace.*`.
- Ungrouped keys: `setupVersion`, `proseOnlyThinking`, `omitThinking`, `externalThinking`, `includeWorkspaceTree`, `autocompleteMaxVisible`, `emojiAutocomplete`, `extendedContext`, `disabledExtensions`, `inlineToolDescriptors`, and `treeFilterMode`.

These settings follow the same schema-defined type and default rules shown above.

## Legacy migration

`omp` migrates older config shapes automatically. None of these require action; they are listed so you know what changes you may see in `config.yml`.

### Startup migration to `config.yml`

When neither `~/.omp/agent/config.yml` nor the compatible `config.yaml` exists, startup builds canonical `config.yml` once from legacy sources, then writes the result:

1. `~/.omp/agent/settings.json` (renamed to `settings.json.bak` after a successful parse).
2. Settings persisted in `agent.db`.

After either main YAML file exists, these legacy sources are no longer consulted. The generic config loader also performs `.json` -> `.yml` migration for other config files when only the `.json` form is present.

### Field-level migrations

Applied whenever raw settings are loaded (global, project, overlays, and runtime overrides):

| Old                                                                      | New                                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `inspect_image.enabled` boolean                                          | `inspect_image.mode` (`true` → `on`, `false` → `off`)                                                        |
| `queueMode`                                                              | `steeringMode`                                                                                               |
| `ask.timeout` in milliseconds (value `> 1000`)                           | seconds (divided by 1000)                                                                                    |
| flat `theme: "<name>"` string                                            | `theme.dark` / `theme.light` (slot chosen by luminance; built-in `light`/`dark` are dropped to use defaults) |
| `task.isolation.enabled: true/false`                                     | `task.isolation.mode: auto/none`                                                                             |
| `task.simple`                                                            | removed                                                                                                      |
| legacy `task.isolation.mode` (`worktree`, `fuse-overlay`, `fuse-projfs`) | `rcopy`, `overlayfs`, `projfs`                                                                               |
| `lastChangelogVersion`                                                   | moved to a marker file and stripped from `config.yml`                                                        |

## Troubleshooting

### A project setting is not taking effect

- Start `omp` from the directory that contains `.omp/config.yml`. Settings discovery only checks the current working directory's `.omp/`, not ancestor directories.
- Ensure `.omp/` is non-empty; empty config directories are ignored.
- Confirm the file is valid YAML and its top level is a mapping.
- Run `omp config get <key>` from that directory to see the effective value.
- Remember that `--config` overlays and runtime flags override project config.

### A global array disappeared in a project

Arrays replace; they do not append. If a project sets `disabledProviders`, `enabledModels`, `cycleOrder`, `extensions`, or any other array, include the **complete** desired value in the project layer — the global array is fully replaced.

### A provider is still available after editing config

- Check whether you disabled the model provider id (e.g. `anthropic`) or a discovery source id (e.g. `claude`) — they are different namespaces with different effects.
- Check for a project (or overlay) `disabledProviders` array replacing your global one.
- Credentials can still come from environment variables, `.env`, OAuth, stored auth, or `models.yml`; disabling a provider blocks selection regardless, but verify you edited the right layer. See [Providers](./providers.md).
- Restart the session if the model list was already initialized.

### `omp config set` changed the wrong file

`omp config set` and `omp config reset` always write the global `config.yml` under the active agent directory. Run `omp config path` to print it. For project-local settings, edit `<repo>/.omp/config.yml` directly.

### `omp config reset` did not remove my key

`reset` writes the schema **default** value into the global config — it persists the default rather than deleting the key. To stop overriding a project value from global config, delete the key from `~/.omp/agent/config.yml` by hand.

### A `--config` overlay fails at startup

`--config` files are process-local YAML mappings. A missing file, invalid YAML, or a top-level array/scalar is a hard error — it does not silently fall back to lower-precedence settings. Fix the path or contents.

### An environment variable beats my config

Some settings (model roles, eval backends, tiny-model device/precision, auth broker, PTY) are overridable by env vars or CLI flags for per-machine convenience, and those take precedence over `config.yml`. Unset the variable or drop the flag to let the persisted value win. See [Environment overrides](#environment-overrides) and [Environment variables](./environment-variables.md).

### `omp config set <key>` says "Unknown setting"

Keys must match a schema path exactly, with no shorthand. Use `theme.dark`, not `theme`. Run `omp config list` to see every valid key.
