# Settings

`omp` resolves settings from built-in defaults, a persistent global config file, optional project-local config, one-shot CLI overlays, and in-memory runtime overrides. Reach for project settings when one repository needs a different provider set, model role, tool policy, memory backend, or UI behavior than your global defaults — without touching your machine-wide configuration.

Settings are stored as plain YAML mappings. Every key, its type, default, and enum values come from its setting definition (declared with `register(...)` next to the owning feature, e.g. `packages/coding-agent/src/tools/settings.ts`, and collected by `packages/coding-agent/src/config/all-settings.ts`). `omp config` exposes the complete schema; the interactive `/settings` panel exposes entries with supported UI editors. Some entries are conditional, and numbers or arrays without UI choices remain config-file-only.

- For model/provider credentials, `.env` files, and the env-var table that resolves API keys, see [Providers](./providers.md).
- For custom model definitions in `models.yml`, see [Models](./models.md).
- For instruction files discovered into the agent context (`AGENTS.md`, `.omp/`, etc.), see [Context files](./context-files.md).
- For the full catalog of environment variables, see [Environment variables](./environment-variables.md).
- For prompt words that activate specialized per-turn behavior, see [Magic keywords](./magic-keywords.md).

## Where settings live

| Scope             | Path                                                  | Read behavior                                                                                                                            | Write behavior                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global            | `~/.omp/agent/config.yml` (or existing `config.yaml`) | The main persistent settings file. `config.yml` is the canonical write target; an existing `config.yaml` is loaded and updated in place. | `/settings`, `omp config set`, and `omp config reset` write here.                                                                                                                |
| Global legacy     | `~/.omp/agent/settings.json`                          | Considered for migration only when neither main YAML filename exists. | Not written; renamed to `settings.json.bak` after a non-empty migrated YAML file is successfully saved. |
| Project           | `<cwd>/.omp/config.yml` (plus `.omp/settings.json`)   | Loaded when the process working directory has a non-empty `.omp/`.                                                                       | Settings commands do not write arbitrary project keys. With `modelRoleStorage: project`, model-selector role assignments update only `modelRoles` here; edit other keys by hand. |
| Project legacy    | `<cwd>/.omp/settings.json`                            | Still read; project `config.yml` is merged on top of it.                                                                                 | Not written by settings commands.                                                                                                                                                |
| CLI overlay       | Any file passed with `--config <file>`                | Loaded after global and project settings, for that one process. Repeatable.                                                              | Never persisted.                                                                                                                                                                 |
| Runtime overrides | In-memory only                                        | Set by settings overrides such as `--approval-mode`, role flags, and feature env vars. | Never persisted. |

The global paths above describe the default profile. `omp --profile work` selects `~/.omp/profiles/work/agent` instead, isolating settings, auth, sessions, and caches. `OMP_PROFILE` also selects a profile; `PI_PROFILE` is its compatibility fallback only when `OMP_PROFILE` is absent. An explicit `--profile` wins over both, and `--profile default` selects the default profile.

`PI_CODING_AGENT_DIR` relocates the default profile's agent directory, including `config.yml` and its agent data. Named profiles derive their own agent directory and ignore this override. Use `omp config path` (or `omp --profile work config path`) to print the active settings directory.

On Linux and macOS, configured `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` can redirect data/state/cache when the corresponding `omp` directories exist. Named profiles require the corresponding `omp/profiles/<name>` directory. This does not move `config.yml`: it stays under the active agent directory, while `agent.db` and other categorized data may live elsewhere. `omp config init-xdg` creates the base directories but does not migrate files or set environment variables.

Native project settings are intentionally scoped to the process working directory's `.omp/` folder — settings discovery does **not** walk ancestor directories looking for the nearest `.omp/`. Other discovery providers (Claude, Codex, Gemini, Cursor, OpenCode) can also contribute project-level settings from their own files; those are read-only from `omp` settings commands and can be turned off by provider id (see [Provider and source disabling](#provider-and-source-disabling)).

## Config file formats

The canonical global file is YAML at `config.yml`; `config.yaml` is accepted as a compatibility filename. The generic config loader used for other files (for example `models.yml`) accepts `.yml`, `.yaml`, `.json`, and `.jsonc`:

- When a `.yml`/`.yaml` path is requested and only a sibling `.json` exists, it is migrated to YAML automatically (idempotent, once per process).
- `.json` and `.jsonc` configs are read as-is, with no migration.
- Empty YAML (or YAML `null`) is treated as an empty settings mapping. Other non-mapping top levels are invalid. On writable startup, `omp` moves a syntactically invalid or non-mapping persistent settings file to a uniquely named `.broken-*` backup and exits with the original error and backup path. A `--config` overlay with a bare array/scalar is also a hard error, but is not moved.
- Invalid values for ordinary schema entries warn and read as their schema defaults. Settings with explicit validators, such as per-agent compaction triggers or provider concurrency limits, can reject the configuration instead. Unknown keys in hand-written files are not a substitute for a registered setting.

## Reading and writing settings

Use the interactive `/settings` panel inside a session, or the `omp config` command from a shell. The CLI reads effective values including setting environment variables. The panel shows and edits merged settings-layer values, not environment-supplied values; descriptions note active env overrides so env credentials are never pre-filled or persisted. Ordinary persistent writes land in the **global** file; model-selector role changes are the exception when `modelRoleStorage: project` (see [Where writes go](#where-writes-go)).

```bash
omp config list                 # all settings with current effective values
omp config list --json          # same, machine-readable
omp config get theme.dark       # one value
omp config get theme.dark --json
omp config set compaction.enabled false
omp config set defaultThinkingLevel medium
omp config reset steeringMode   # remove a key from config.yml so its default applies
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
| `omp config set <key> <value>` | Parse `<value>` against the key's schema type, write it to the global main YAML file, and print the value written. When another source still supplies the effective value, it says which instead (`--json`: `overriddenBy` is the env var name, or `project`, `overlay`, or `runtime`; `fallbackEnv` names a fallback env var used while the saved value is blank). |
| `omp config reset <key>`       | Delete the global key, allowing another configured layer or the schema default to apply. Prints the resulting effective value, masking non-empty credentials as `********`; JSON omits a credential's `value` and emits `{ key, redacted: true }`. |
| `omp config path`              | Print the active agent directory (honors `PI_CODING_AGENT_DIR`).                                                                                                                                                                                                                                  |
| `omp config init-xdg`          | On Linux and macOS, create the `omp` directories under the effective XDG data, state, and cache homes. It does not move existing files or set the XDG environment variables. Other platforms exit non-zero.                                                                                       |

`omp config` with no subcommand lists settings. `--help` or `-h` displays command help. The `--json` flag is accepted by `list`, `get`, `set`, and `reset`.

### Value parsing

`omp config set` parses the value string according to the target key's schema type. The string is trimmed first.

| Type    | Accepted input                                      | Notes                                                             |
| ------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| boolean | `true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0` | Case-insensitive. Anything else is rejected.                      |
| number  | Any finite JavaScript number                        | `Infinity`/`NaN` are rejected.                                    |
| enum    | One of the key's allowed values, bare or JSON-quoted | Must match exactly; the error lists the valid values.             |
| array   | A JSON array                                        | e.g. `'["anthropic","openai"]'`. Must parse and be an array.      |
| record  | A JSON object                                       | e.g. `'{"bash":"prompt"}'`. Must parse and be a non-array object. |
| string  | Bare text or a JSON-quoted string                    | Bare text is trimmed; JSON string contents are decoded. Multi-word arguments are joined with spaces. |

Keys must match a real schema path exactly. There is no shorthand — set `theme.dark`, not `theme`.

Setting-specific normalization and validation still apply after parsing. For example, provider concurrency limits must be positive numbers and are floored to whole requests.

### Where writes go

`omp config set`, `omp config reset`, `/settings`, and persistent runtime settings changes write the global main YAML file under the active agent directory. Runtime-only overrides are not saved. Settings commands do not write arbitrary keys to `<cwd>/.omp/config.yml`. Model-role assignment or clearing with `modelRoleStorage: project` updates only the affected roles there; missing project roles fall back to global roles. To create another project-local override, edit the project file directly (see [Project-local config](#project-local-config)).

Saves are debounced and re-read the file under a lock. Disjoint external edits are preserved. If an external writer changed the same global setting or model role after a local change was staged, the stale local change is skipped with a warning rather than overwriting the newer file value.

Saves through a symlinked main config preserve the link and update its resolved target. Targets containing `.` or `..` follow the operating system's rules: Windows collapses those segments before following intermediate links, while POSIX traverses each component on disk. A target such as `alias/../config.yml` can therefore name different files on the two platforms.

### Live file changes

Interactive sessions and RPC/RPC-UI hosts watch the main global file, project settings sources, and config overlays. Changes are reloaded after a short debounce, preserving runtime overrides. A layer that fails to parse or validate keeps its last good values and logs a warning; other valid layers can still refresh. Live reload does not move the invalid file to a `.broken-*` backup.

Symlinked configs follow edits to their target and replacement of any intermediate file or directory symlink, including profile links. After a link switches targets, subsequent edits to the new target are watched too.

Reloading changes the settings values available to consumers; startup-only work is not rerun. Provider-source switches take effect on the next discovery pass. Task/eval dispatch also reloads persisted settings before resolving a subagent's policy.

Routing changes to `modelRoles`, `retry.fallbackChains`, and `task.agentModelOverrides` apply to subsequent subagent launches and fallback decisions without restarting the host. `auth.accountPolicies` and `retry.usageReservePct` also update the long-lived account router for subsequent credential selection and quota checks. Reloading does not restart running subagents or switch a healthy active session's model; explicit runtime overrides still take precedence.

## Precedence

From lowest to highest priority, the effective value of a setting is built as:

```text
built-in defaults  <-  global config  <-  project config  <-  CLI overlays  <-  runtime overrides  <-  setting env var
```

From highest to lowest:

1. **Setting env var** — an environment variable declared on the setting's definition (for example `PI_PY` for `eval.py`, `OMP_AUTH_BROKER_URL` for `auth.broker.url`). Parsed by the setting's type unless it declares a custom parser; unparseable text (such as `PI_EDIT_VARIANT=auto`) counts as unset. Booleans follow the `parseFlag` convention: empty counts as unset, `1`/`y`/`true`/`yes`/`on` (all-lowercase or all-uppercase) mean true, and any other value means false. A few are declared as fallbacks instead (`SEARXNG_*`, `MNEMOPI_EMBEDDING_MODEL`): they only replace the built-in default, so any configured layer wins over them — except a configured `null`, which counts as unset. `SEARXNG_ENDPOINT`, `SEARXNG_TOKEN`, and `MNEMOPI_EMBEDDING_MODEL` also apply when the setting is a blank string.
2. **Runtime overrides** — settings applied in memory for the current process, including `--smol`, `--slow`, `--plan`, `--approval-mode`, `--auto-approve`/`--yolo`, `--hide-thinking`, `--advisor`, `--external-thinking`, and protocol-mode defaults. Never persisted. Other one-shot options such as `--model`, `--thinking`, `--service-tier`, `--no-lsp`, `--no-pty`, and `--api-key` affect session/model/transport options rather than all being registry settings. Protocol-mode defaults (RPC/ACP) hold only while nothing else configures the setting: a settings write or reset of it, a `config.yml` or project edit picked up by a reload, or an ACP session's own project config replaces them.
3. **CLI config overlays** — each `--config <file>`; later overlay files override earlier ones.
4. **Project settings** — `<cwd>/.omp/settings.json` then `<cwd>/.omp/config.yml` (and contributions from other discovery providers at project level).
5. **Global settings** — the active agent/profile directory's `config.yml` (or existing `config.yaml`).
6. **Built-in defaults** — from the setting definition.

A key that is unset at every layer resolves to its default at read time.

### Environment overrides

Environment variables are never written back to `config.yml`. Variables declared on a setting definition form the top layer described above; others are read directly by the feature that owns the value (`PI_NO_PTY`) or applied as runtime overrides (`PI_SMOL_MODEL` sets the `smol` model role for the process). Relevant setting overrides and configuration selectors:

| Env var                 | Overrides setting           | Notes                                                                                             |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `PI_SMOL_MODEL`         | `modelRoles.smol`           | Also exposed as `--smol`.                                                                         |
| `PI_SLOW_MODEL`         | `modelRoles.slow`           | Also exposed as `--slow`.                                                                         |
| `PI_PLAN_MODEL`         | `modelRoles.plan`           | Also exposed as `--plan`.                                                                         |
| `PI_NO_PTY=1`           | (disables PTY bash)         | Equivalent to `--no-pty` for the process.                                                         |
| `PI_PY`                 | `eval.py`                   | `PI_PY=0` disables the Python eval backend.                                                       |
| `PI_JS`                 | `eval.js`                   | `PI_JS=0` disables the JavaScript eval backend.                                                   |
| `PI_TINY_DEVICE`        | `providers.tinyModelDevice` | ONNX execution provider or `mlx` backend for local tiny models.                                   |
| `PI_TINY_DTYPE`         | `providers.tinyModelDtype`  | ONNX precision for local tiny models.                                                             |
| `OMP_AUTH_BROKER_URL`   | `auth.broker.url`           | Env value takes precedence over config.                                                           |
| `OMP_AUTH_BROKER_TOKEN` | `auth.broker.token`         | Env value takes precedence over config.                                                           |
| `PI_CODING_AGENT_DIR`   | (relocates default-profile agent dir) | Named profiles ignore this override. |
| `OMP_PROFILE` / `PI_PROFILE` | (selects profile) | `OMP_PROFILE` wins when present; `--profile` wins over env. |
| `PI_EDIT_VARIANT` | `edit.mode` | `apply_patch`, `hashline`, `patch`, `replace`, or `sloppy`; `auto` is unset. |
| `PI_EDIT_FUZZY` | `edit.fuzzyMatch` | Exact lowercase `1`/`true` enables; `0`/`false` disables; other text defers to config. |
| `PI_EDIT_FUZZY_THRESHOLD` | `edit.fuzzyThreshold` | Parsed floating-point threshold from 0–1; invalid/out-of-range values are unset. |
| `PI_INTENT_TRACING` | `tools.intentTracing` | Uses the boolean env parser. |
| `PI_AUTO_QA` | `dev.autoqa` | Enables/disables automated tool issue reporting, subject to saved consent. |
| `PI_NO_THINKING_LOOP_GUARD` | `model.loopGuard.enabled` | Only `1` disables; other values do not override the setting. |
| `SEARXNG_ENDPOINT` / `SEARXNG_TOKEN` | `searxng.endpoint` / `searxng.token` | Fallbacks when the setting is absent, null, or blank. |
| `SEARXNG_BASIC_USERNAME` / `SEARXNG_BASIC_PASSWORD` | `searxng.basicUsername` / `searxng.basicPassword` | Fallbacks only when absent or null; configured empty strings remain valid credentials. |
| `MNEMOPI_EMBEDDING_MODEL` | `mnemopi.embeddingModel` | Fallback when absent, null, or blank. |
| `PI_CONFIG_FILES`       | CLI config overlays         | Platform path-list (`:` on Unix, `;` on Windows); files load in order before `--config` overlays. |

Provider API keys are resolved separately (stored auth, OAuth, `models.yml`, environment, and `.env` files); see [Providers](./providers.md) and the full [Environment variables](./environment-variables.md) reference.

## Merge rules

Layers are combined with a deep merge:

- **Objects are deep-merged** — keys present only in a lower layer are kept; keys present in a higher layer override.
- **Scalars and arrays are replaced wholesale** by the higher-precedence layer. A higher layer's array does not append to a lower layer's array.
- **A configured `null` counts as unset at read time**, so the schema default (or a fallback env var) applies rather than a lower-layer value. Project `modelRoles` entries are an exception: cleared/null project roles fall back to global roles.
- **Named model presets are resolved whole**, not deep-merged across layers. A project preset of the same name replaces the global preset. Runtime/overlay `null` entries can hide a lower-layer preset.

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

`tools.approval` is a record keyed by tool name; dotted forms such as `tools.approval.eval` and `tools.approval.computer` identify entries in that record, not separate setting ids. Each entry sets that tool's default policy. For bash, you can add ordered command rules with `bash.patterns`; the first matching rule wins. Patterns support literal text plus `*` as a wildcard. Whitespace is the exception: before matching, every run of spaces, tabs, or newlines in both the pattern and the command collapses to a single space, and leading/trailing whitespace is trimmed. A newline in a pattern therefore matches any whitespace: `match: "*\n*"` behaves like `"* *"` and matches every command containing a space. A newline-specific rule is unnecessary to catch dangerous commands in a newline-separated list: `deny` and `prompt` rules check each segment (see below). `allow` rules reject unquoted newline command separators, but can approve commands containing quoted or escaped literal newlines when the full command matches.

By default, an `allow` rule must match the entire command and cannot approve a compound line. Set `bash.allowCompoundCommands: true` to also evaluate conservative chains of two or more literal commands joined only by `&&`:

```yaml
tools:
  approvalMode: write
  approval:
    bash: allow

bash:
  allowCompoundCommands: true
  patterns:
    - match: "rm -f *"
      approval: allow
```

With this configuration, `cmp tmp/result.json artifacts/result.json && rm -f tmp/result.json` can run without a prompt. OMP resolves the ordered rules independently for each original segment: `rm` is explicitly allowed, while the unmatched `cmp` segment inherits the normal standalone bash policy. When any segment is unmatched, the command retains the `exec` tier with no explicit policy, so the generic resolver applies `tools.approval.bash` and then the active approval mode. An unmatched segment therefore prompts only if that tool-wide policy or mode requires it.

Explicit restrictions are combined conservatively across the chain: a resolved `deny` wins, otherwise a resolved `prompt` wins. A `deny` or `prompt` rule that matches the complete chain but no individual segment remains a whole-chain restriction (for example, `cmp * && rm *`). All matching whole-chain restrictions are considered: a later whole-chain `deny` overrides an earlier whole-chain `prompt`. Otherwise, segment rules retain first-match ordering: an earlier `git status` allow is not overridden by a later `git *` deny when evaluating `git status && git status`.

Enabling this setting can therefore allow a compound command that the default policy denied when an earlier narrow segment allow precedes a broad catch-all deny. Put segment denies that must always apply before overlapping allows.

The opt-in accepts only a flat `&&` chain with literal arguments, including quoted literal arguments. It rejects expansions, variable assignments, other control flow, redirections, globbing, newlines, malformed syntax, and shell-state-changing commands such as `cd`, `source`, and `eval`. Rejected forms keep the legacy approval behavior; enabling the setting never broadens which non-chain commands an `allow` pattern can approve. Explicit chain and segment restrictions resolve before the existing raw and canonical critical-command checks, which still inspect the whole command and every segment so a broad allow cannot hide a critical later segment.

The opt-in requires a positively identified POSIX-quoting shell: `sh`, `bash`, `dash`, `ash`, `ksh`, or `zsh`, including their `.exe` names. The centralized classifier checks the executable basename across Windows and POSIX paths. Other shells, including cmd, PowerShell, fish, and unknown wrappers, retain legacy approval behavior. Their quoting can differ from the recognizer: fish treats `\'` inside single quotes as an escaped quote, while POSIX shells do not.

Valid rule approvals are `allow`, `prompt`, and `deny`. Regardless of the opt-in, `deny` and `prompt` rules can match the whole command or a tokenized segment of other compound forms (split on `&&`, `||`, `;`, `|`, a single `&`, subshells, and newlines). This lets `match: "rm -rf *"` deny `cd /tmp && rm -rf build` and `sleep 1 & rm -rf build`.

`bash.patterns` is an approval policy, not containment. An allowed program still has the bash process's filesystem, network, and subprocess access, and a seemingly narrow program can perform broader actions through its own options or configuration. The rules govern the `bash` tool only; they do not cover shells started through `eval`. To close that path, add a `tools.approval.eval` policy (`prompt` or `deny`) as well; see [Tool approval mode](./approval-mode.md).

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
  methodOrder: [snapcompact, remote, soft]
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

`--config` is accepted by the default launch command, `acp`, `models`, and `dry-balance`. For `models` and `dry-balance`, put it after the command name (`omp dry-balance --config ./policy.yml`); placed before the command name, it is dropped.

Wrappers may instead set `PI_CONFIG_FILES` to a platform-delimited path list (`:` on Unix, `;` on Windows). Environment overlays load in listed order before explicit `--config` overlays.

Overlay paths are resolved relative to the process working directory (and `~` is expanded). Each overlay must parse as a YAML mapping; a missing file, invalid YAML, or a top-level array/scalar is a hard error — it does **not** silently fall back to lower-precedence settings.

## Path-scoped arrays

Three array settings — `enabledModels`, `enabledProviders`, and `disabledProviders` — accept path-scoped entries in addition to bare strings, so a single global config can behave differently per directory:

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

- `models` (for `enabledModels`) or `providers` (for `enabledProviders` and `disabledProviders`)
- `values` or `items` (for any setting)

Only string values are kept; malformed scoped entries are ignored. Path scoping is resolved **after** the layer merge, so it reads the final effective array.

## Provider and source disabling

`enabledProviders` opts foreign user-level configuration sources into discovery. Its default is empty, so user roots from Cursor, Codex, Claude, Claude marketplace plugins, Gemini, OpenCode, Windsurf, and GitHub are normally excluded until their provider id is listed (or `*`/`all` is listed). Enabling `claude` also enables `claude-plugins`; an explicit `CLAUDE_CONFIG_DIR` opts Claude's user root in without a list entry. Explicitly selected discovery roots can also opt in. `disabledProviders` still wins.

Project roots remain enabled. Native OMP and `.agents` roots—including native marketplace plugins—are not foreign and do not require an entry.

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

Native project `modelRoles` are also read directly from `.omp/config.yml`; disabling the `native` discovery provider does not suppress that model-role layer.

## Settings catalog

The catalog below highlights common settings; it is not the complete schema. `omp config list` is the authoritative reference for every key, current value, type, and description. Defaults and enum values shown here come from the schema. Settings that accept an env or flag override are noted; those overrides are process-local and not persisted.

### Models

`modelRoles` assigns the primary selector for each workload. `retry.fallbackChains` supplies its ordered fallbacks; keep provider/backend choice out of service-specific settings. Chat selectors may carry a thinking suffix (`:off`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`, `:auto`, or `:inherit`). Non-chat runners do not use chat thinking budgets. Role values can also contain ordered comma-separated selectors or role aliases such as `@smol`; the role's fallback chain is configured separately.

```yaml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high
  vision: google/gemini-3.1-pro-preview
  plan: anthropic/claude-opus-4-5
  advisor: anthropic/claude-sonnet-4-5:medium

  # Lightweight chat/tiny workloads
  tiny: local/lfm2.5-230m
  memory: local/lfm2-1.2b

  # Model-kind workloads
  image: openai/gpt-image-2
  web: web/duckduckgo
  speech: local/kokoro
  dictation: local/parakeet-tdt-0.6b-v3
  judge: typesafe/jev-latest

retry:
  fallbackChains:
    tiny: [] # explicit empty chain: do not fall back
    memory:
      - openai/gpt-4.1-mini
    web:
      - web/parallel
      - web/perplexity
      - web/exa
      - web/firecrawl
    speech: []
    dictation: []
    judge:
      - typesafe/jev-preview
      - "@tiny"
      - "@smol"
      - "@default"

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

Built-in chat roles are `default`, `smol`, `slow`, `vision`, `plan`, `commit`, `tiny`, `memory`, `task`, and `advisor`. The `tiny` and `memory` roles accept both `tiny` catalog models and ordinary chat models. Built-in model-kind roles are `image`, `web`, `speech`, `dictation`, and `judge`; they select image, search/grounded-chat, TTS, STT, and judgment runners respectively. `judge` also accepts tiny and chat models, which is why aliases such as `@tiny` are valid fallbacks. Catalog kinds are `chat`, `tiny`, `image`, `tts`, `stt`, `search`, and `judge`; a custom model with no `kind` remains a chat model.

Open `/model` and enter the **Roles** view to assign roles and edit their fallback rows. Chat roles and model-kind roles appear in separate capability sections, and the picker filters assignments to models accepted by the selected role. List the same catalog directly with `omp models --kind chat`, `omp models --kind tiny`, `omp models --kind image`, `omp models --kind tts`, `omp models --kind stt`, `omp models --kind search`, or `omp models --kind judge`; use `--kind all` for everything.

For a role, `modelRoles.<role>` is the primary and `retry.fallbackChains.<role>` is the fallback list. For model-kind roles, an unset chain uses that role's built-in priority list; `[]` explicitly means **no fallbacks**. The `retry.fallbackChains.default` chain is for chat-role/session fallback and never replaces a model-kind role's own chain. Explicit search entries such as `web/parallel`, `web/perplexity`, `web/exa`, and `web/firecrawl` are attempted as configured candidates, including their supported anonymous modes; missing required credentials still produce an availability error for that explicit entry.

For one-shot searches, `omp search`, `omp q`, and `omp web-search` accept a catalog selector through `--model`, for example `omp web-search --model web/duckduckgo "current Bun release"`. The in-session `web_search` tool has no per-call model override: it follows `modelRoles.web` and `retry.fallbackChains.web`.

Image selection likewise uses full catalog model selectors, not provider names: set `modelRoles.image`, its fallback chain, or the `generate_image` request's optional `model`. OpenRouter image models run through OpenRouter's native images API.

Existing configs are migrated automatically when loaded. Retired backend selectors under `providers` (`webSearch`, `webSearchOrder`, `webSearchExclude`, `webSearchGeminiModel`, `image`, `imageOrder`, `tts`, `judgmentProvider`, `autoThinkingModel`, `unexpectedStopModel`, `tinyModel`, and `memoryModel`) are translated where applicable into `modelRoles` and `retry.fallbackChains`, then removed. The retired `tts.localModel` key is removed (Kokoro is the canonical local TTS model), and `stt.modelName` values are migrated to a canonical `modelRoles.dictation` selector before removal. Other service controls—devices, dtypes, voices, timeouts, and `live.*` behavior—remain ordinary settings.

| Key                    | Type    | Default                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelRoles`           | record  | `{}`                        | Map of role name to primary selector or ordered primary candidates. Custom chat roles can be introduced through assignments, `modelTags`, or `cycleOrder`. `--smol`/`--slow`/`--plan` and their `PI_*_MODEL` vars override those roles for a run; `--model` selects the active chat model.                                                                                                                                                                                       |
| `modelRoleStorage`     | enum    | `global`                    | `global` saves model-selector role assignments in the active global/profile config; `project` saves only those role assignments in `<cwd>/.omp/config.yml`. Missing project roles fall back to global roles.                                                                                                                                                                                                     |
| `modelPresets`         | record  | `{}`                        | Named model presets, each `{ modelRoles, defaultThinkingLevel }`. Written by `/modelpreset save` and the `/models` Roles view (`s`); applied by `/modelpreset switch`. Saves write only the named entry to the global config; project-defined presets are listed and applied but never copied globally. See [Model presets](./models.md#model-presets). |
| `modelTags`            | record  | `{}`                        | Custom role/tag metadata; can introduce additional chat roles.                                                                                                                                                                                                                                                                                                                                                   |
| `modelProviderOrder`   | array   | `[]`                        | Preferred provider order when a model id is ambiguous.                                                                                                                                                                                                                                                                                                                                                           |
| `cycleOrder`           | array   | `["smol","default","slow"]` | Chat roles cycled by the model switcher.                                                                                                                                                                                                                                                                                                                                                                         |
| `enabledModels`        | array   | `[]`                        | Allow-list of models; supports [path-scoped entries](#path-scoped-arrays). Empty means all available models.                                                                                                                                                                                                                                                                                                     |
| `enabledProviders`     | array   | `[]`                        | Foreign user-level discovery sources to load; supports path-scoped entries. See [above](#provider-and-source-disabling).                                                                                                                                                                                                                                                                                          |
| `disabledProviders`    | array   | `[]`                        | Disabled model/discovery providers; supports [path-scoped entries](#path-scoped-arrays). See [above](#provider-and-source-disabling).                                                                                                                                                                                                                                                                             |
| `includeModelInPrompt` | boolean | `true`                      | Include the active model name in the system prompt.                                                                                                                                                                                                                                                                                                                                                              |

See [Models](./models.md) for the `models.yml` schema and custom-provider definitions.

#### Task/eval model requests

`task` items, eval `agent()`, and `workpool()` accept a raw `model` selector or ordered, non-empty array. `agent` chooses semantic instructions/tools; `model` independently chooses a routing role/model. Precedence within approved routes is request → exact `task.agentModelOverrides[agentName]` → agent frontmatter → actual live parent. Put task batch selections on each `tasks[]` item, never the container.

Concrete models must already be authorized by the current operator's configured roles/fallbacks, the selected agent's frontmatter or exact model override, or the actual live parent. Availability, authentication, enabled/catalog membership, `modelTags`, and project recommendations alone do not authorize a worker. Real custom configured roles support suffixes such as `@review:high`; no automatic-classifier roster is an allowlist.

Role aliases retain identity and may use their currently configured approved fallback chains. Raw literals stay inside the requested candidate closure instead of acquiring an unrelated role/default/auth chain; list additional literal candidates explicitly. `@default` selects the exact live parent with its actual effort, not `modelRoles.default` or a parent-role fallback chain; `@default:high` changes only effort. `@inherit` and bare `default`/`inherit` (also with suffixes) are invalid.

A requested fixed suffix outranks agent defaults and the supported task coarse `effort` field (`lo`/`med`/`hi`), is not clamped or discarded, and fails when unsupported. Unqualified routes permit runtime effort selection; configured `auto` remains `auto`. Explicit invalid, unauthorized, unavailable, or exhausted selection stops without dropping `model` or substituting another source. Hooks may narrow, never enlarge, the approved closure; retries and revival revalidate current permission within it. Pools select models at worker creation; follow-ups retain each worker's model/effort contract.

For example, this operator configuration authorizes a custom `review` chain:

```yaml
modelRoles:
  review: openai/gpt-5.4:high
retry:
  fallbackChains:
    review:
      - openai/gpt-5.5:high
```

```js
const review = await agent("Review the change", { agent: "reviewer", model: "@review:high" });
const sameParent = await agent("Analyze on the live parent", { model: "@default" });
```

The alias may use its approved configured chain; an approved exact `openai/gpt-5.4:high` request stays on that model. See [Task/eval worker routing](./models.md#taskeval-worker-routing).


### Advisor

Advisors review primary turns on a configurable cadence and can inject advice. Enable them with `advisor.enabled`, `/advisor on`, or `--advisor`. For the default single advisor, `modelRoles.advisor` selects its model; when unset, resolution uses a configured `slow` role or the built-in slow-model priorities. An unavailable explicit advisor assignment does not silently select another model.

`WATCHDOG.yml` (or `WATCHDOG.yaml`) can define a roster of named advisors with their own models, tools, instructions, note budgets, review cadence, and catch-up policy. See [Advisor configuration](./advisor-watchdog.md) for that schema, shared `WATCHDOG.md` instructions, cadence controls, and catch-up semantics.

| Key                   | Type    | Default | Notes                                                                                                                                                |
| --------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advisor.enabled`     | boolean | `false` | Enable the advisor runtime when `modelRoles.advisor` resolves to an available model.                                                                 |
| `task.agentAdvisor`   | record  | `{}`    | Per-agent subagent advisor: agent name → `"on"` / `"off"` / advisor model pattern. Overrides agent frontmatter `advisor`; configured from the `/agents` hub. |
| `advisor.syncBacklog` | enum    | `off`   | Default catch-up policy. `off` never waits; `1`, `3`, or `5` wait up to 30 seconds at that backlog threshold; `strict` waits for scheduled reviews without a wall-clock cap. Abort, failure, quota pause, transition, and disposal release waits. Optional `WATCHDOG.yml` per-advisor `syncBacklog` overrides this policy; omission inherits it. |
| `advisor.immuneTurns` | number  | `3`     | After a concern or blocker interrupts, route further concerns as non-interrupting asides for this many primary turns, including tool-loop continuations. Blockers remain exempt. |
| `advisor.reviewMode` | enum | `turn` | Default advisor cadence when no `WATCHDOG.yml` roster exists: review every primary turn, or only final yields with `agent-end`. Roster entries set their own `reviewMode` (default `turn`). Applies live. |
| `advisor.reviewInterval` | number | `1` | Default advisor only: review every Nth eligible update. Skipped updates are sent with the next scheduled review; pending advice delivery never depends on cadence. Applies live. |
| `advisor.maxNotesPerUpdate` | number | `4` | Non-blocker notes accepted per advisor review, from 1–32. Higher-severity notes can replace only pending notes from the same review. `WATCHDOG.yml` top-level or per-advisor values override this default. |
| `advisor.evictStaleResults` | boolean | `true` | Before each review, replace the advisor's `read`/`grep`/`glob` output from older reviews with a short placeholder. The latest review is kept. |

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

`thinkingBudgets.<level>` overrides the token budget for the selected thinking level on transports that accept a reasoning token budget (including Anthropic, Google/Gemini, Bedrock Claude, GitLab Duo's Anthropic path, the Anthropic shim, the auth gateway, and budget-mode `cline-pass`). It does not control effort-based OpenAI-compatible requests: `openai-completions` providers such as local llama.cpp and Ollama use their own thinking/effort controls instead, so changing these budgets has no effect on their request bodies. Use `defaultThinkingLevel` or `--thinking` to select an available effort level for those models.

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

For the numeric sampling settings, a negative value (normally `-1`) means "use the provider/model default" — `omp` does not send that parameter.

| Key                 | Type   | Default   | Notes                                                                                                                                                                                                                                                                          |
| ------------------- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `temperature`       | number | `-1`      | Sampling temperature.                                                                                                                                                                                                                                                          |
| `topP`              | number | `-1`      | Nucleus sampling.                                                                                                                                                                                                                                                              |
| `topK`              | number | `-1`      | Top-K sampling.                                                                                                                                                                                                                                                                |
| `minP`              | number | `-1`      | Minimum-probability cutoff.                                                                                                                                                                                                                                                    |
| `presencePenalty`   | number | `-1`      | Presence penalty.                                                                                                                                                                                                                                                              |
| `repetitionPenalty` | number | `-1`      | Repetition penalty.                                                                                                                                                                                                                                                            |
| `textVerbosity`     | enum   | `medium`  | `low`, `medium`, `high`. Sent by OpenAI Responses; Codex forwards it only when explicitly configured, otherwise leaving its model/provider default.                                                                                                                                                                                  |
| `tier.openai`       | enum   | `none`    | `none`, `auto`, `default`, `flex`, `scale`, `priority`, `ultrafast`. Sent as `service_tier` for OpenAI / OpenAI-Codex and OpenAI-family OpenRouter models. `ultrafast` is sent only to the OpenAI API and to Codex models whose discovery advertises it (`/fast ultra`). Launch with `--service-tier <value>` for a one-session OpenAI override; the flag is not persisted (`none` omits `service_tier`). |
| `tier.anthropic`    | enum   | `none`    | `none`, `priority`. `priority` realizes fast mode on supported direct Claude models (ignored on Bedrock/Vertex and via OpenRouter).                                                                                                                                            |
| `tier.google`       | enum   | `none`    | `none`, `flex`, `priority`. Gemini API sends it in the body; Vertex sends `priority` via header (`flex` is a no-op on Vertex).                                                                                                                                                 |
| `tier.subagent`     | enum   | `inherit` | `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`, `ultrafast`. Applied to the spawned model's family; `inherit` tracks the main agent.                                                                                                                                     |
| `task.agentServiceTierOverrides` | record | `{}` | Sparse exact-name overrides for agents spawned by task/eval dispatch (Vibe workers keep `tier.subagent`). Values: `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`, `ultrafast`. An entry overrides `tier.subagent`; concrete values apply only when supported by the resolved model's provider family. A non-mapping value fails settings load. |
| `tier.advisor`      | enum   | `none`    | `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`, `ultrafast`. Applied to the advisor model's family.                                                                                                                                                                      |
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
    # Chat roles without their own chain may inherit "default". Model-kind
    # roles use their own built-in defaults instead.
    default:
      - anthropic/claude-opus-4-5
      - openai/gpt-5.5
      - google/gemini-3-pro
    # Per-role chains override inherited or built-in fallbacks. An explicit
    # [] disables fallback for that role. Chat selectors accept an optional
    # thinking suffix, e.g. openai/gpt-5.5:low.
    smol:
      - openai/gpt-5.5-mini
      - anthropic/claude-haiku-4-5
    web: []
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
| `retry.maxDelayMs`                       | number  | `300000`          | Backoff ceiling (5 min). Provider-stated waits longer than this fail fast when no credential or model fallback succeeds, unless `retry.waitForUsageReset` admits an authoritative quota-reset wait. `0` disables the cap.                                                                                                                                                                                                                                                                                                                  |
| `retry.modelFallback`                    | boolean | `true`            | Fall back to another chat model when one is unavailable. Role-driven helpers that honor this switch, including online session-title generation, stop after their first resolvable candidate when it is `false`.                                                                                                                                                                                                                                                                                                                                  |
| `retry.fallbackChains`                   | record  | `{}`              | Maps roles, model selectors, or `provider/*` wildcards to ordered fallback selectors. Keys containing `/` are model-oriented and win over roles: `provider/model-id` matches that exact model, `provider/*` matches every model of the provider. A `provider/*` _entry_ keeps the failing model's id and swaps the provider. Model-kind roles use their built-in chain when unset and no fallbacks when set to `[]`; the `default` chain never applies to them. Unknown models/providers or malformed chains are reported as config warnings at startup. |
| `retry.fallbackRevertPolicy`             | enum    | `cooldown-expiry` | `cooldown-expiry` returns to the primary model once its suppression window ends; `never` stays on the fallback until switched manually.                                                                                                                                                                                                                                                                                                                                                     |
| `retry.waitForUsageReset` | boolean | `false` | Allow provider-stated usage-limit waits past `retry.maxDelayMs` when a reset hint or complete usage report supplies authoritative timing. Waits are abortable but can also hold subagents. |
| `retry.usageAwareFallback` | boolean | `false` | Before a turn, use reliable coding-plan quota reports to prefer healthy same-provider accounts and then configured fallback models. Unknown usage keeps the current model; ordinary API keys are excluded. |
| `retry.usageReservePct` | number | `10` | Remaining quota percentage protected by usage-aware fallback. |
| `retry.usageReservePolicy` | enum | `confirm` | `confirm`, `auto`, `fail-closed`. At reserve, `confirm` asks when an interactive confirmer is available and otherwise auto-falls back; exhausted quota can fall back without confirmation. `fail-closed` blocks known reserve/depleted quota rather than spending it. |
| `providers.anthropic.serverSideFallback` | boolean | `false`           | Opt in to Anthropic's `server-side-fallback-2026-06-01` beta for eligible direct Claude Fable/Mythos requests. The catalog-owned server-side chain currently targets `claude-opus-5`, not `claude-opus-5-5`; unsupported models and hosts have no chain.                                                                                                                                          |
| `providers.openai-codex.codeMode`           | enum    | `off`             | Codex Code Mode for `code_mode_only` models, mirroring codex-rs: the direct tool surface collapses to `eval`/`ask`/`todo` and every other session tool is invoked from `eval` cells via its `tool.<name>()` bridge, collapsing multi-step tool work into one model round trip. `auto` follows the model catalog's `tool_mode` flag; `on` forces it for any Codex model; `off` (default) leaves the full direct surface. The turn metadata carries codex-rs's `tool_namespaces_info` exposure snapshot while active. |
| `providers.openai-codex.codeModeDirectTools` | array   | `[]`              | Extra tool names to keep directly callable alongside `eval`/`ask`/`todo` when Codex Code Mode is active; entries that are not enabled in the session are ignored. |

For ordinary sessions, when the active chat model keeps failing (429s, quota walls, provider outages) and `retry.modelFallback` is on, the session picks the chain that owns the failing model, by specificity: an exact `provider/model-id` key, then a `provider/*` wildcard, then the current role's chain, then `default` — which also owns a live model that belongs to no role (`/model` switch, ephemeral hop). The effective chain is the owning role's primary followed by its configured entries, and a live selector that appears nowhere in it is offered the whole chain. If several roles assign the same model, yaml key order does not decide: the live session role wins, and `default` wins over other matching chat roles when the session is not on those roles. It skips chat candidates whose selectors are still cooling down and switches for the rest of the turn. Model-kind runners resolve their named role chain separately and never consume `default`. Task/eval workers instead retain their approved per-spawn candidate closure, including any permitted configured role chain; raw literals and `@default` do not acquire unrelated session fallbacks. There is no `agent:<name>` key in `fallbackChains`.

A prefixed wildcard such as `openrouter/google/*` can be used as a chain key or entry: it matches ids under that prefix or prepends the prefix to the failing model's bare id when changing providers. In ordinary sessions, bare fallback entries inherit the failing turn's thinking level; an explicit suffix can replace it. When a chain is exhausted, ordinary recovery can consult the current fallback model's own chain as well, and each hop still consumes a retry attempt. Task/eval recovery cannot enlarge its approved candidate closure or weaken fixed requested effort. See [Retry policy](./non-compaction-retry-policy.md) for recovery ordering and quota behavior.

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
| `tools.format`                 | enum    | `auto`  | Tool wire format: `auto`, `native`, `glm`, `hermes`, `kimi`, `xml`, `anthropic`, `deepseek`, `harmony`, `qwen3`, `gemini`, `gemma`, or `minimax`. `native` always uses provider-native tool calls. `auto` also uses native calls unless the selected model explicitly has `supportsTools: false`; then it selects the model-family owned dialect, falling back to GLM when no specific family dialect is known. Other values force that owned in-band dialect. `xml` is the [generic XML format](./toolconv/xml.md); `minimax` is the [MiniMax format](./toolconv/minimax.md). See [GLM](./toolconv/glm-4.5.md), [Qwen3/Hermes](./toolconv/qwen3.md), [Kimi](./toolconv/kimi-k2.md), [Anthropic](./toolconv/anthropic.md), [DeepSeek](./toolconv/deepseek.md), [Harmony](./toolconv/harmony.md), [Gemini](./toolconv/gemini.md), and [Gemma](./toolconv/gemma.md). |
| `tools.approvalMode`           | enum    | `yolo`  | `always-ask` (auto-approve read-only), `write` (auto-approve read + workspace-write), `yolo` (auto-approve all tiers). `--approval-mode` and `--auto-approve`/`--yolo` override per run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tools.approval`               | record  | `{}`    | Per-tool policy keyed by tool name; each value is `allow`, `deny`, or `prompt`. e.g. `omp config set tools.approval '{"bash":"prompt"}'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tools.maxTimeout`             | number  | `0`     | Maximum timeout the agent may request, in seconds; `0` = no settings cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tools.intentTracing`          | boolean | `true`  | Ask the agent to describe each tool call's intent. `PI_INTENT_TRACING` overrides it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tools.outputMaxColumns`       | number  | `768`   | Per-line byte cap for streaming output; `0` disables.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tools.artifactSpillThreshold` | number  | `50`    | KB of tool output above which output spills to an artifact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tools.artifactHeadBytes`      | number  | `20`    | KB of head kept inline on spill; `0` = tail-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tools.artifactTailBytes`      | number  | `20`    | KB of tail kept inline on spill.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tools.artifactTailLines`      | number  | `500`   | Max tail lines kept inline on spill.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tools.artifactMaxBytes` | number | `16` | MB cap on the artifact file saved for streaming tool output (bash, python, js eval); larger output keeps its beginning (up to 3 MB) and most recent remainder around a truncation notice. `0` = unlimited. |
| `tools.xdev` | boolean | `true` | Mount discoverable tools under `xd://` device URLs instead of exposing every schema directly. Disabling it exposes enabled tools top-level. |
| `tools.xdevDocs` | enum | `catalog` | `inline` includes all mounted docs/schemas, `builtins` inlines built-ins only, `catalog` lists devices with docs fetched on demand. |
| `tools.xdevInlineDevices` | array | `[]` | Dynamic-device name globs to inline in `builtins` mode; ignored in `catalog` mode. |
| `async.enabled` | boolean | `true` | Enable async bash commands and background task execution. |
| `async.maxJobs` | number | `100` | Running background-job cap, floored to at least 1; parked/queued jobs do not consume execution slots. |

Mounting still follows the session's explicit tool allow-list. A session that permits `read` but omits `write` can receive a device-only write transport; this does not grant filesystem writes.

Individual built-in tools and Eval preludes are toggled by their own keys, e.g. `bash.enabled`, `launch.enabled`, `eval.py`, `eval.js`, `glob.enabled`, `grep.enabled`, `fetch.enabled`, `browser.enabled`, `computer.enabled`, `ratchet.enabled` (default `false`; the `ratchet(flow)` eval/hillclimb prelude, which `/ratchet` turns on for the current session only), `archive.enabled` (default `true`; the read-only `archive` eval prelude over prompt history, recent projects, past sessions, and recaps), `astEdit.enabled`, `astGrep.enabled`, `find.enabled` (`auto`/`on`/`off`; `auto` enables `find` only when the `judge` role resolves to a native TypeSafe jev model), and `web_search.enabled`. Image questions use `read <image>?q=<question>` and honor `images.questionTimeoutMs`.

### Window-scoped computer use

The disabled-by-default `computer` Eval prelude captures and controls real host windows through native OS APIs. Window handles isolate an application without focusing it or moving the real pointer; the `desktop` object preserves selected-display composite and global input behavior. It remains separate from the `browser` Eval prelude, which manages Chromium/CDP tabs and structured page automation.

```yaml
computer:
  enabled: true
  display: all
  maxWidth: 3840
  maxHeight: 2400
```

| Key                  | Type    | Default | Notes                                                                                                                                                                                                                                                        |
| -------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `computer.enabled`   | boolean | `false` | Enable the window-aware `computer` Eval prelude; the `/computer` slash command toggles it for the current session only.                                                                        |
| `computer.display`   | string  | `all`   | Controls the `desktop` target only: composite all active displays, or use one numeric display ID.                                                                                                                                                            |
| `computer.maxWidth`  | number  | `3840`  | Maximum composite screenshot width in pixels. Image transports that cannot preserve original detail, including GitHub Copilot Responses and xAI OAuth, cap the effective width at `1280`; Claude-family models use the same cap as a compatibility fallback. |
| `computer.maxHeight` | number  | `2400`  | Maximum composite screenshot height in pixels. Those coordinate-safe transports cap the effective height at `896`; other models retain the configured limit.                                                                                                 |

Computer settings and the active model's coordinate-safe image limits are read for every call; runtime changes and successfully reloaded file edits apply to the next call. Direct `computer` helpers and code passed to `computer.run(fnOrCode, options)` select a target through the desktop root or `window(...)`. Switching targets invalidates the prior coordinate frame, so capture the new target before pointer input. Before enabling input, configure `tools.approvalMode` or `tools.approval.computer` and grant platform permissions. See [Window-scoped computer use](computer-use.md).

### Shell, eval, and LSP

```yaml
bash:
  enabled: true
  allowCompoundCommands: false
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
| `bash.allowCompoundCommands`      | boolean | `false`   | Evaluate flat, literal `&&` chains per segment; unmatched segments inherit normal bash approval policy and mode.                                            |
| `bash.gitGuard`                   | boolean | `false`   | For checkouts shared by concurrent agents: refuse `git stash` (except `list`/`show`), `reset --hard`, `reset` to another commit, and `checkout`/`switch`/working-tree `restore` unless a merge or rebase conflict is being resolved. Unstaging stays allowed. Enforced by the embedded shell's `git` builtin, so it sees expanded commands and the real cwd; services, client terminals, `pty` calls, and git started by path or through another program are not guarded. |
| `launch.enabled`                  | boolean | `true`    | Enable named `bash` services and `proc://` supervision for shared long-running project processes; there is no separate launch tool.                                                                                           |
| `bash.autoBackground.enabled`     | boolean | `true`   | Auto-background long-running commands.                                                                                                                      |
| `bash.autoBackground.thresholdMs` | number  | `60000`   | Threshold before auto-backgrounding.                                                                                                                        |
| `bash.direnv` | enum | `auto` | `auto` loads an allowed repository `.envrc` into the embedded bash session; `off` disables integration. It never bypasses `direnv allow`. |
| `bash.direnvLoadTimeoutMs` | number | `30000` | Maximum wait for initial `direnv export`; a timeout leaves the session without the direnv environment. |
| `eval.py`                         | boolean | `true`    | Python eval backend. `PI_PY=0` disables for the process.                                                                                                    |
| `eval.js`                         | boolean | `true`    | JavaScript eval backend. `PI_JS=0` disables for the process.                                                                                                |
| `eval.autoProvision`              | boolean | `true`    | Create the managed JavaScript eval package environment on first `%bun add`.                                                                                 |
| `eval.tools.enabled`              | boolean | `true`    | Expose kernel-defined `@tool` / `tool(fn)` functions to `task`, `agent()`, and `workpool()` subagents.                                                      |
| `eval.workpool.freshAgents`       | boolean | `false`   | Spawn a new workpool agent for every item instead of reusing idle workers or batching queued items.                                                        |
| `python.kernelMode`               | enum    | `session` | `session` (persistent kernel) or `per-call`.                                                                                                                |
| `python.interpreter`              | string  | `""`      | Path to a Python interpreter; empty = auto-detect.                                                                                                          |
| `lsp.enabled`                     | boolean | `true`    | Language-server integration. `--no-lsp` disables for the run.                                                                                               |
| `lsp.lazy`                        | boolean | `true`    | Start servers on demand.                                                                                                                                    |
| `lsp.shared`                      | boolean | `true`    | Share one language server per project across local `omp` processes through the daemon broker; falls back to private servers when the broker is unavailable. |
| `lsp.diagnosticsOnWrite`          | boolean | `true`    | Run diagnostics after a write.                                                                                                                              |
| `lsp.diagnosticsOnEdit`           | boolean | `false`   | Run diagnostics after an edit.                                                                                                                              |
| `lsp.formatOnWrite`               | boolean | `false`   | Format files on write.                                                                                                                                      |
| `lsp.diagnosticsDeduplicate`      | boolean | `true`    | Collapse duplicate diagnostics.                                                                                                                             |
| `shellPath`                       | string  | _(unset)_ | External shell for services, terminals, and `!`; plain bash tool calls use embedded brush.                                                                  |

### Files: editing and reading

```yaml
edit:
  mode: hashline # apply_patch, hashline, patch, replace, sloppy
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
| `edit.mode`               | enum    | `hashline` | `apply_patch`, `hashline`, `patch`, `replace`, `sloppy`. `PI_EDIT_VARIANT` pins the mode. |
| `edit.modelVariants` | record | `{}` | Ordered, case-insensitive model-selector substring → edit mode; the first matching entry wins. |
| `edit.fuzzyMatch`         | boolean | `true`     | Allow fuzzy anchor matching.                      |
| `edit.fuzzyThreshold`     | number  | `0.95`     | Similarity threshold for fuzzy matching.          |
| `edit.blockAutoGenerated` | boolean | `true`     | Refuse to edit generated/lockfile-like files.     |
| `edit.streamingAbort`     | boolean | `false`    | Abort on streaming edit mismatch.                 |
| `edit.enforceSeenLines` | boolean | `true` | Reject edits anchored on lines a prior read/search never displayed in full. |
| `edit.recoverInlineEdits` | boolean | `true` | Recover recognized edit snippets from assistant text. |
| `edit.autoRepair.enabled` | boolean | `false` | Ask the `smol` model to repair an introduced AST parse regression; accept only a reparsed repair, otherwise warn. |
| `edit.blackbox.enabled`   | boolean | `false`    | Append full source for AST parse regressions.      |
| `read.defaultLimit`       | number  | `300`      | Default line count for `read` without a selector. |
| `read.summarize.enabled`  | boolean | `true`     | Structural summaries for code reads.              |
| `read.summarize.prose`    | boolean | `false`    | Summarize prose files too.                        |
| `read.toolResultPreview`  | boolean | `false`    | Inline preview of tool results.                   |
| `read.renderMarkdown` | boolean | `false` | Render Markdown document reads in the TUI. |
| `readLineNumbers`         | boolean | `false`    | Show plain line numbers.                          |

### Context, compaction, and memory

`/extended-context on` opts in to larger context windows; `/extended-context off` restores standard windows and premium-pricing caps. For `openai-codex/gpt-6-astra`, `openai-codex/gpt-6.1-sol`, and their `-wm` routes, off uses 272,000 tokens and on uses the curated 922,000-token input window (1.05M total context with 128K output), or a higher discovered maximum. The curated maximum corrects stale lower discovery values. Explicit per-model `contextWindow` overrides in `models.yml` take precedence in both modes; remove an override if you want the toggle to control that model again. Codex overrides still clamp to the effective server-honored ceiling, allowing the curated or higher live maximum rather than an arbitrary larger window.

Custom providers can opt into the same toggle by setting `contextWindow` (normal)
and `maxContextWindow` (extended) on a model or `modelOverrides` entry in
`models.yml`. A `contextWindow` override without `maxContextWindow` remains
fixed in both modes. See [model configuration](models.md); these values control
local budgeting, not the upstream endpoint's accepted request size.

Compaction headroom is separate from this opt-in. With the default 15% reserve, Astra's documented extended window has an auto-compaction threshold of 783,700 tokens. A larger window can consume more usage even when there is no additional long-context pricing multiplier.

```yaml
extendedContext: false

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
| `extendedContext` | boolean | `false` | Opt in to larger model windows; `/extended-context on`, `off`, or `status`. |
| `workspace.additionalDirectories` | array | `[]` | Additional workspace roots added to every session; relative paths resolve from cwd. `/add-dir` and `/remove-dir` manage them live. |
| `contextPromotion.enabled`    | boolean | `false`                                  | Promote to the active model's explicit `contextPromotionTarget` on context overflow.                                                                                                                                                      |
| `compaction.enabled`          | boolean | `true`                                   | Automatic conversation compaction.                                                                                                                                                                                                        |
| `compaction.asyncEnabled`     | boolean | `true`                                   | Speculatively summarize in the background as context nears the compaction threshold, then splice the ready result in when the threshold is crossed.                                                                                        |
| `compaction.midTurnEnabled`   | boolean | `true`                                   | Check thresholds at safe mid-turn tool-loop boundaries before the next provider request. Setting it to `false` affects only the session it is configured on; subagents always check, since their whole assignment is one turn.                |
| `compaction.methodOrder`      | array   | `remote, snapcompact, handoff, shake, soft` | Ordered fallbacks. `remote` uses provider-native server compaction (OpenAI Responses compact, Anthropic compaction beta); unavailable or failed methods advance. |
| `compaction.thresholdPercent` | number  | `-1`                                     | Percent-of-context trigger; `-1` = reserve-based default.                                                                                                                                                                                 |
| `compaction.thresholdTokens`  | number  | `-1`                                     | Fixed token trigger when `> 0`.                                                                                                                                                                                                           |
| `compaction.modelThresholds`  | record  | `{}`                                     | Per-model compaction limit keyed by `provider/model-id` or a `*`-terminated prefix (`deepseek/*`): a token base the compaction policy scales (`90000`), a fixed token trigger (`"f90000"`), or a percentage of the window (`"80%"`). See below. |
| `compaction.modelThresholdsEnabled` | boolean | `true`                             | Whether `compaction.modelThresholds` applies. Subagents with a `task.agentCompactionThresholdOverrides` entry run with it off. |
| `task.agentCompactionThresholdOverrides` | record | `{}` | Exact-name task/eval agent → compaction trigger: a positive token count (`90000`) or a percentage string (`"80%"`). See below. |
| `compaction.reserveTokens`    | number  | _(unset)_                                | Absolute reserve floor. When unset, the effective reserve is the larger of `16384` and 15% of the context window; if that default would leave no practical small-window budget, it falls back to the 15% reserve.                         |
| `compaction.keepRecentTokens` | number  | `20000`                                  | Recent-history token budget for summary compaction.                                                                                                                                                                                                           |
| `compaction.autoContinue`     | boolean | `true`                                   | Continue automatically after compaction.                                                                                                                                                                                                  |
| `memory.backend`              | enum    | `off`                                    | `off`, `local`, `hindsight`, `mnemopi`. Each backend has its own `hindsight.*` / `mnemopi.*` / `memories.*` tuning keys.                                                                                                                  |
| `autolearn.enabled`           | boolean | `false`       | Experimental: enable standing lesson-capture guidance and `manage_skill` (plus `learn` when a memory backend is active). Managed skills live under `<agent dir>/managed-skills`. |
| `autolearn.autoContinue`      | boolean | `false`       | After an eligible primary stop, run a private capture turn (uses extra tokens). Off keeps only standing guidance; no hidden reminder is inserted into the next turn. Aborted, plan-mode, and goal-loop turns are skipped.                                                                                                           |
| `autolearn.minToolCalls`      | number  | `5`           | Minimum completed tool calls in a primary turn before automatic capture is eligible.                                                                                                                                                                               |

A positive `compaction.thresholdTokens` wins over `thresholdPercent` and is clamped below the context window. Otherwise, a positive percentage is clamped to 1–99%; non-positive percentages use the reserve-based threshold.

`compaction` has additional tuning keys (idle compaction, supersede/drop heuristics) visible in `omp config list`. See [Compaction](./compaction.md) for the full strategy reference.

Per-model compaction limits apply to the models they match. A token count is the base the usual policy scales: omp treats it as the model's window when computing the threshold, so with defaults it compacts at the base minus the reserve (85% for bases above ~109k) and with `compaction.thresholdPercent: 80` at 80% of it; a global `compaction.thresholdTokens` does not apply to that model. Prefix the count with `f` (`f400k`, stored as `"f400000"`) to make it the exact trigger instead. A percentage entry replaces both `compaction.threshold*` settings and scales the real window. Requests and overflow handling still use the real window. The `/models` preview shows where each model compacts; to set a limit, select a role or fallback row in the **Roles** view and press `k` (or click **Compaction limit**), then type `400k`, `f400k`, `1M`, or `80%` (empty input resets). That writes the exact `provider/model-id` key to the global config. By hand:

```yaml
compaction:
  thresholdPercent: 80
  modelThresholds:
    "deepseek/*": 90000
    "openrouter/anthropic/*": "60%"
    anthropic/claude-opus-5.5: 150000 # base: compacts at 80% of 150k
    openai/gpt-5.6-terra: "f400000" # fixed: compacts at exactly 400k
```

- An exact `provider/model-id` key wins; otherwise the longest matching `*`-terminated prefix applies. `*` is only allowed at the end, and every key needs a `provider/` part.
- Entry values are parsed like `task.agentCompactionThresholdOverrides` below (`null` clears a lower-layer entry), plus the `"fN"` fixed form; an agent entry's token count is always the exact trigger, and the `f` prefix is not accepted there.
- The trigger follows the active model: switching models, context promotion, and advisors each use their own model's entry.
- A `task.agentCompactionThresholdOverrides` entry outranks model entries for that agent, including entries added while it runs.
- The hub refuses an edit when the project config sets the same model key; change it in the project config instead.
- A token base larger than the model's standard window, or a fixed trigger at or past it, opts that model into its extended window (the window `extendedContext` would give it, including long-context pricing tiers) without turning `extendedContext` on. A base is the window size you want, so it opens the extended window even when its scaled trigger lands inside the standard one (a `300k` base on a 272K model compacts at 255K but runs on the larger window, keeping the reserve as headroom); use a base at or below the standard window, or an `f` trigger below it, to stay on the standard window. The hub warns first and saves on a second Enter; it rejects a base larger than the largest window the model can run with, and a fixed trigger at or past it. A subagent whose `task.agentCompactionThresholdOverrides` entry applies ignores model entries, so it keeps the standard window.

Per-agent compaction triggers for task/eval subagents. This keeps the main session at 40,000 tokens while `scout` compacts at 80% of its window and `task` at 90,000 tokens:

```yaml
compaction:
  thresholdTokens: 40000

task:
  agentCompactionThresholdOverrides:
    scout: "80%"
    task: 90000
```

- Keys are exact, case-sensitive agent names (`scout` does not match `Scout`).
- A number is a fixed token trigger (positive integer); a `"N%"` string is a percentage of the context window, `0 < N ≤ 100`. An entry replaces both `compaction.thresholdTokens` and `compaction.thresholdPercent` for that agent.
- `null` clears an entry set by a lower-priority settings layer. Any other value fails settings load.
- Agents without an entry — including agents spawned by an overridden agent — use the main session's `compaction.*` thresholds. The main session and Vibe workers are unaffected.
- The resolved trigger is stored with the subagent session and reused when it is revived.

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

| Key                           | Type    | Default          | Values                                                                    |
| ----------------------------- | ------- | ---------------- | ------------------------------------------------------------------------- |
| `theme.dark`                  | string  | `titanium`       | Theme used on a dark terminal background.                                 |
| `theme.light`                 | string  | `light`          | Theme used on a light terminal background.                                |
| `symbolPreset`                | enum    | `unicode`        | `unicode`, `nerd`, `ascii`.                                               |
| `colorBlindMode`              | boolean | `false`          | Use blue instead of green for diff additions.                             |
| `showHardwareCursor`          | boolean | `true`           | Show the terminal hardware cursor.                                        |
| `statusLine.preset`           | enum    | `default`        | `default`, `minimal`, `compact`, `full`, `nerd`, `ascii`, `custom`.       |
| `statusLine.separator`        | enum    | `powerline-thin` | `powerline`, `powerline-thin`, `slash`, `pipe`, `block`, `none`, `ascii`. |
| `statusLine.sessionAccent`    | boolean | `true`           | Tint the editor border with the session color.                            |
| `statusLine.transparent`      | boolean | `false`          | Use the terminal background for the status line.                          |
| `statusLine.showHookStatus`   | boolean | `true`           | Show hook status messages.                                                |
| `terminal.showImages`         | boolean | `true`           | Render images inline (when the terminal supports it).                     |
| `images.autoResize`           | boolean | `true`           | Resize large images for model compatibility.                              |
| `images.blockImages`          | boolean | `false`          | Never send images to providers.                                           |
| `tui.hyperlinks`              | enum    | `auto`           | `off`, `auto`, `always`.                                                  |
| `tui.autoGraph`               | enum    | `always`         | Chart numeric tables in the agent's answers, in the theme's colors, on terminals that show graphics: `always` uses the built-in best guess, `smart` lets the judge model pick the chart kind and columns for tables with several numeric columns, `off` leaves tables alone. Tern receives the chart as SVG. Applies to the main session in the TUI only: subagent transcripts, print, RPC, and ACP output stay plain, and their system prompts omit the diagram and chart guidance. |
| `tui.mouse`                   | boolean | `false`          | Capture mouse clicks in the main session so live subagent cards and HUD rows focus on click, with a hover highlight on the target. Native text selection becomes Shift+drag and wheel scroll becomes Shift+wheel while on. |
| `display.pinnedAgents`        | enum    | `collapsed`      | Pinned live-agent jump list above the editor: `off` hides it, `collapsed` shows a few rows with an expander, `full` lists all. |
| `display.subagentLivePreview` | boolean | `false`          | Show each pinned subagent's current (or most recent) tool call beneath its jump-list row. |
| `tui.resizeScrollback`        | enum    | `rebuild`        | How a settled width resize refreshes transcript rows kept in terminal scrollback: `append` replays the transcript at the new width below retained history, `rebuild` erases pane scrollback then replays one current-width copy, `preserve` repaints only the viewport. |

For a custom status line, set `statusLine.preset: custom` and configure `statusLine.leftSegments`, `statusLine.rightSegments`, and `statusLine.segmentOptions`. Include `status` in either segment list to render extension statuses registered through `ctx.ui.setStatus()`, ordered by key and joined inline. Set `statusLine.showHookStatus: false` to suppress the same statuses in the footer.

The `path` segment abbreviates the home directory to `~`. On Windows, shared path formatting recognizes both the long home name and its existing 8.3 aliases (such as `ADMINI~1`), including in tool labels and error text. Only the home prefix is abbreviated; remaining path components keep their spelling, and formatting does not change the working directory or environment. Set `statusLine.segmentOptions.path.abbreviate: false` to keep the full path in the status line.

The `cost` segment shows recorded session costs. For an active provider/model with scheduled pricing, it appends `↑` during peak hours or `↓` off-peak, refreshing at boundaries even while idle. The arrow reflects the current tariff, not past spending; flat-price models and explicit cost overrides have no arrow. See [usage costs and time-based pricing](models.md#usage-costs-and-time-based-pricing) for the UTC schedule and estimation semantics.

### Interaction

| Key                    | Type    | Default         | Values                                                                                                  |
| ---------------------- | ------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `steeringMode`         | enum    | `one-at-a-time` | `all`, `one-at-a-time`. How queued steering messages are delivered.                                     |
| `followUpMode`         | enum    | `one-at-a-time` | `all`, `one-at-a-time`.                                                                                 |
| `interruptMode`        | enum    | `immediate`     | `immediate`, `wait`.                                                                                    |
| `doubleEscapeAction`   | enum    | `rewind`          | `rewind`, `tree`, `none`: open the rewind selector, open the session tree, or do nothing. |
| `autoResume`           | boolean | `false`         | Auto-resume the most recent session in the cwd.                                                         |
| `plan.enabled`         | boolean | `true`          | Enable plan mode.                                                                                       |
| `plan.defaultOnStartup` | boolean | `false`         | Start each fresh interactive session in plan mode when plan mode is enabled. Print/JSON (`--print`) mode ignores this and prints a note; use `--plan-yolo` for a headless plan flow. |
| `ask.timeout`          | number  | `0`             | Auto-select the recommended ask option after this many seconds; `0` disables automatic selection. |
| `ask.notify`           | enum    | `on`            | `on`, `off`.                                                                                            |
| `input.bareExitOnEmptySession` | boolean | `true` | Submitting exactly `exit`, `quit`, or `q` (case-insensitive) before the first message quits. |
| `input.bareSlashCommands` | boolean | `false` | Run an exact command name without `/`; after session messages exist, Enter must be pressed twice to confirm. |
| `tui.vimMode` | boolean | `false` | Enable modal prompt editing; `tui.vimModeDisplay` selects `text`, `icon`, or `none` (default `text`). |
| `startup.quiet` | boolean | `false` | Suppress welcome/startup chrome, including the splash. |
| `startup.showSplash` | boolean | `false` | Show the full setup animation on ordinary interactive startup without rerunning setup. |
| `startup.changelogMode` | enum | `summary` | `summary`, `expanded`, `hidden`: choose startup release-note presentation. |
| `startup.setupWizard` | boolean | `true` | Show newly added onboarding steps once per setup version. |

### Providers and services

Model/backend ordering for image generation, web search, speech, dictation, and judgments is configured through the corresponding `modelRoles` and `retry.fallbackChains` entries in [Models](#models). This section contains transport and service behavior that remains independent of model selection.

```yaml
providers:
  fetch: auto
  webSearchTimeoutSeconds: 60
  tinyModelDevice: default
  tinyModelDtype: default
  openaiWebsockets: auto
  openaiLiveSteering: true
  openrouterVariant: default
  kimiApiFormat: auto
  cacheRetention: auto
  maxInFlightRequests:
    anthropic: 2

provider:
  appendOnlyContext: auto # auto, on, off

tts:
  localVoice: af_heart
  localSpeed: 1

speech:
  enabled: false
  voice: af_heart
  speed: 1

stt:
  enabled: false
  language: en
  submitTrigger: never

exa:
  enabled: true
  searchDelayMs: 1000

searxng:
  endpoint: https://search.example.com
  token: SEARXNG_TOKEN
```

| Key                                 | Type    | Default   | Values / notes                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers.webSearchTimeoutSeconds` | number  | `60`      | Per-candidate web-search transport timeout. Values above `300` are capped at five minutes. This is not a whole-chain deadline; the `web` role advances to its next candidate after a timeout.                                                                                                                                                                                                                                                                                                         |
| `providers.fetch`                   | enum    | `auto`    | `auto`, `native`, `trafilatura`, `lynx`, `parallel`, `firecrawl`, `jina`.                                                                                                                                                                                                                                                                                                                                                              |
| `providers.tinyModelDevice`         | enum    | `default` | ONNX execution provider, or `mlx` (Apple silicon, via mlx-lm), for local tiny models. Overridden by `PI_TINY_DEVICE`.                                                                                                                                                                                                                                                                                                                                                         |
| `providers.maxInFlightRequests`     | record  | `{}`      | Positive per-provider concurrency limits for LLM HTTP requests, shared across local `omp` processes using the same config root. Omitted providers are unlimited. `omp config set` rejects non-positive or non-numeric values.                                                                                                                                                                                                          |
| `providers.tinyModelDtype`          | enum    | `default` | ONNX precision for local tiny models. Overridden by `PI_TINY_DTYPE`.                                                                                                                                                                                                                                                                                                                                                                   |
| `tts.localVoice`                    | enum    | `af_heart` | Voice used by the local Kokoro TTS runner. Available local voices remain configurable independently of `modelRoles.speech`.                                                                                                                                                                                                                                                                                                           |
| `tts.localSpeed`                    | number  | `1`       | Speaking rate of the local Kokoro TTS runner (`tts` tool, `omp say`). `1` is normal; values are clamped to `0.5`–`2.5`.                                                                                                                                                                                                                                                                                                              |
| `speech.voice`                      | enum    | `af_heart` | Kokoro voice used when assistant-output vocalization is enabled.                                                                                                                                                                                                                                                                                                                                                                     |
| `speech.speed`                      | number  | `1`       | Speaking rate for assistant-output vocalization. `1` is normal; values are clamped to `0.5`–`2.5`.                                                                                                                                                                                                                                                                                                                                   |
| `stt.enabled`                       | boolean | `false`   | Enable microphone speech-to-text; choose the recognition model with `modelRoles.dictation`.                                                                                                                                                                                                                                                                                                                                           |
| `stt.language`                      | string  | `en`      | Source language hint for speech-to-text.                                                                                                                                                                                                                                                                                                                                                                                               |
| `stt.submitTrigger`                 | enum    | `never`   | When completed dictation auto-submits: `never`, `release`, `release-complete`, or `say-submit`.                                                                                                                                                                                                                                                                                                                                        |
| `providers.openaiWebsockets`        | enum    | `auto`    | `auto`, `off`, `on`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `providers.streamFirstEventTimeoutSeconds` | number | `-1` | First stream-event watchdog: `-1` uses provider/env defaults, `0` disables, positive values set seconds. |
| `providers.streamIdleTimeoutSeconds` | number | `-1` | Maximum silence between stream events, with the same `-1`/`0` conventions. |
| `providers.anthropic.slowMode` | enum | `off` | `off`, `auto`. Anthropic subscription low-priority recovery when a 5-hour limit is reached and the lane is offered; `/slow on` enables it. |
| `providers.openaiLiveSteering`      | boolean | `true`    | Deliver messages typed while a GPT-6 response streams into that response (`response.steer` over the Codex WebSocket) instead of waiting for the next tool boundary.                                                                                                                                                                                                                                                                    |
| `providers.openrouterVariant`       | enum    | `default` | `default`, `nitro`, `floor`, `online`, `exacto`.                                                                                                                                                                                                                                                                                                                                                                                       |
| `providers.kimiApiFormat`           | enum    | `auto`    | `auto`, `openai`, `anthropic`. `auto` follows live model metadata.                                                                                                                                                                                                                                                                                                                                                                     |
| `providers.cacheRetention`          | enum    | `auto`    | `auto`, `short`, `long`, `none`. Prompt-cache retention forwarded to providers that support it. `auto` keeps provider defaults (Anthropic: 1h entries on OAuth subscriber sessions, 5m entries on API keys) and honors `PI_CACHE_RETENTION`; `short` forces 5m; `long` uses 1h TTLs where supported; `none` disables prompt caching and cache-affinity routing.         |
| `providers.cacheWarming`            | enum    | `idle`    | `off`, `streaming`, `idle`. Prompt-cache warming replays the last request shortly before its cache entry expires with a one-token output budget: Anthropic Messages stops at its first generated output; Converse completes a one-total-token request to consume terminal cache usage. Warming runs only when the expected avoided-miss cost exceeds the refresh cost by at least $0.05. A refresh that misses the cache or fails ends warming until the next real request. `off` disables warming; `streaming` protects prefixes during long tool executions and stops when the agent settles; `idle` also refreshes between runs (15% continuation probability) until 30 minutes after the last real request, so it covers only cache lifetimes shorter than that window (Anthropic and AWS Claude 5m entries, not 1h entries such as OAuth subscriber sessions). Warming follows the lifetime of the retention tier actually used; `providers.cacheRetention: none` suppresses warming. Models without a declared lifetime for the retention tier used (see [Models](./models.md)) are never warmed. |
| `provider.appendOnlyContext`        | enum    | `auto`    | `auto`, `on`, `off`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exa.enabled`                       | boolean | `true`    | Enable the Exa web search provider.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `exa.searchDelayMs`                 | number  | `1000`    | Minimum delay between Exa web search requests in milliseconds; set `0` to disable pacing.                                                                                                                                                                                                                                                                                                                                               |
| `searxng.endpoint`                  | string  | _(unset)_ | SearXNG instance URL.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `searxng.token`                     | string  | _(unset)_ | SearXNG token; also `searxng.basicUsername`/`searxng.basicPassword`/`searxng.categories`/`searxng.language`/`searxng.engines` (comma-separated engine names or bang shortcuts, e.g. `ddg, br, startpage`, sent as the API's `engines=` parameter)/`searxng.safesearch`.                                                                                                                                                                                                                                                                                                 |
| `auth.broker.url`                   | string  | _(unset)_ | Auth-broker URL. The actual credential connection uses env then the main global config, not project/config-overlay values.                                                                                                                                                                                                                                                                                                                                                                                  |
| `auth.broker.token`                 | string  | _(unset)_ | Auth-broker token. `OMP_AUTH_BROKER_TOKEN` wins over the main global config; the broker token file is a fallback. Project/config-overlay values do not redirect credentials.                                                                                                                                                                                                                                                                                                                                                                              |
| `task.agentAccountPools`            | record  | `{}`      | Exact-name task/eval agent → provider id → OAuth identity keys (the `identityKey` values of [client account pools](./auth-broker-gateway.md#client-account-pools-routing-not-authorization), e.g. `email:<address>\|org:<id>` for Anthropic; `omp usage accounts` lists them). The agent authenticates for each listed provider only with those accounts, never another account or an API key, and fails when none can serve; an empty list allows no account. A malformed entry fails settings load. See [Task agent discovery](./task-agent-discovery.md#model-and-structured-output-precedence). |
| `secrets.enabled`                   | boolean | `false`   | Enable configured secret obfuscation and built-in credential-shaped token redaction before provider requests. See [Secret obfuscation](./secrets.md).                                                                                                                                                                                                                                                                                  |

Provider credentials and custom model definitions are configured separately — see [Providers](./providers.md) and [Models](./models.md).

#### Saved reset auto-consumption

`codexResets.autoRedeem` and `claudeResets.autoRedeem` independently control saved-reset consumption: `yes` enables automatic spending, `no` disables it, and `unset` requires consent before the first spend. Headless sessions never spend while consent is unset.

When a usage refresh detects an eligible banked reset expiring within the next **5 minutes**, auto-consumption attempts it even with little or no usage, a credit reserve, or `salvageHorizonHours: 0`. Provider eligibility, covered-limit requirements, cooldowns, and duplicate-spend protections still apply.

`salvageHorizonHours` controls earlier, usage-based salvage; setting it to `0` leaves the five-minute last-chance rule active. Set the provider's `autoRedeem` to `no` to disable all automatic spending.

### Other groups

Every schema path not individually tabulated in this catalog is explicitly deferred to `omp config list`. Additional groups include:

- Agent behavior and safety: `ask.*`, `dev.*`, `eval.*`, `features.*`, `goal.*`, `loop.*`, `model.loopGuard.*`, `model.toolCallLoopGuard.*`, `prewalk.*`, `recap.*`, `sharpshooter.*`, `task.*`, `tools.*`, and `vault.*`.
- Execution and content: `commit.*`, `completion.*`, `edit.*`, `error.*`, `extensionHandlers.*`, `generate_image.*`, `git.*`, `images.*`, `live.*`, `paste.*`, `power.*`, `read.*`, `shellMinimizer.*`, `speech.*`, `terminal.*`, and `title.*`.
- Interface and startup: `composer.*`, `display.*`, `input.*`, `marketplace.*`, `spelling.*`, `statusLine.*`, `startup.*`, `stt.*`, `tui.*`, `ttsr.*`, and `update.*`.
- Discovery, sharing, and auth: `auth.*`, `browser.*`, `claudeResets.*`, `codexResets.*`, `collab.*`, `commands.*`, `gc.*`, `ida.*`, `mcp.*`, `share.*`, `skills.*`, `stream.*`, and `telemetry.*`.
- Ungrouped keys: `setupVersion`, `proseOnlyThinking`, `omitThinking`, `externalThinking`, `includeWorkspaceTree`, `autocompleteMaxVisible`, `emojiAutocomplete`, `disabledExtensions`, `inlineToolDescriptors`, and `treeFilterMode`.

These settings follow the same schema-defined type and default rules shown above.

## Legacy migration

`omp` migrates older config shapes automatically. None of these require action; they are listed so you know what changes you may see in `config.yml`.

### Startup migration to `config.yml`

When neither `config.yml` nor the compatible `config.yaml` exists under the active agent directory, writable startup merges legacy sources in this order:

1. `<agent dir>/settings.json`.
2. Settings persisted in `agent.db` (these override conflicting JSON values).

A non-empty migrated result is written to `config.yml`. Only after that write succeeds is the parsed legacy JSON renamed to `settings.json.bak` and migrated database settings cleared. An empty result does not create a YAML file.

After either main YAML file exists, these legacy sources are no longer consulted. The generic config loader also performs `.json` -> `.yml` migration for other config files when only the `.json` form is present.

### Field-level migrations

Selected migrations applied whenever raw settings are loaded (global, project, overlays, and constructor overrides); canonical changes reach the file on a later save:

| Old                                                                      | New                                                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `inspect_image.enabled` / `inspect_image.mode`                           | removed                                                                                                      |
| `inspect_image.timeoutMs`                                                | `images.questionTimeoutMs`                                                                                   |
| `queueMode`                                                              | `steeringMode`                                                                                               |
| flat `theme: "<name>"` string                                            | `theme.dark` / `theme.light` (slot chosen by luminance; built-in `light`/`dark` are dropped to use defaults) |
| legacy `task.isolation.mode: none`                                       | `task.isolation.enabled: false`                                                                              |
| legacy `task.isolation.mode: <backend>`                                  | `task.isolation.enabled: true` + `isolation.backend: <backend>`                                              |
| `task.simple`                                                            | removed                                                                                                      |
| legacy isolation backends (`worktree`, `fuse-overlay`, `fuse-projfs`)    | `rcopy`, `overlayfs`, `projfs`                                                                               |
| `lastChangelogVersion`                                                   | moved to a marker file and stripped from `config.yml`                                                        |
| `doubleEscapeAction: branch` | `doubleEscapeAction: rewind` |
| `collapseChangelog` | `startup.changelogMode` (`true` → `summary`, `false` → `expanded`) |
| `edit.mode` / `edit.modelVariants` values `atom`, `vim` | `hashline` |
| `readHashLines` | removed; hash anchors follow `edit.mode` |
| `compaction.strategy` / `compaction.remoteEnabled` | `compaction.methodOrder`, preserving explicit strategy/remote opt-outs |
| `snapcompact.systemPrompt` boolean | `all` / `none` |
| `task.eager` / `todo.eager` boolean | `always` / `default` |
| `features.unexpectedStopDetection` boolean | `smart` / `none` |
| `inlineToolDescriptors` / `find.enabled` boolean | `on` / `off` |
| `spelling.autocomplete` boolean | `auto` / `off` |
| `search.enabled` / `search.contextBefore` / `search.contextAfter` | corresponding `grep.*` keys |
| `serviceTier` / `serviceTierSubagent` / `serviceTierAdvisor` | per-family `tier.*`; `fastModeScope` removed |
| `advisor.subagents` | `task.agentAdvisor.task` (`on` / `off`) |
| `dev.autoqa.consent` / `todo.reminders.max` | `dev.autoqaConsent` / `todo.remindersMax` |
| `providers.parallelFetch` | removed; use `providers.fetch` |
| `providers` model/backend selectors, `tts.localModel`, `stt.modelName` | role/chain migrations described in [Models](#models); retired keys removed |
| `exa.enableSearch` / `exa.enableResearcher` / `exa.enableWebsets` | search enablement folded into `exa.enabled`; researcher/websets toggles removed |
| `computer.backend`, `tools.discoveryMode`, `tools.essentialOverride`, `mcp.discoveryMode`, `mcp.discoveryDefaultServers` | removed |

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

- Check whether you disabled the model provider id (e.g. `anthropic`) or a discovery source id (e.g. `claude`) — they are different ids in the shared `disabledProviders` namespace, with different effects.
- Check for a project (or overlay) `disabledProviders` array replacing your global one.
- Credentials can still come from environment variables, `.env`, OAuth, stored auth, or `models.yml`; disabling a provider blocks selection regardless, but verify you edited the right layer. See [Providers](./providers.md).
- Check for a warning that a live reload retained the last good layer. Provider-source switches affect the next discovery pass; an already-open catalog/picker may need refreshing.

### `omp config set` changed the wrong file

`omp config set` and `omp config reset` write the main global YAML file (`config.yml`, or the existing compatible `config.yaml`) under the active agent/profile directory. Run `omp config path` to print that directory and check `--profile`, `OMP_PROFILE`, and `PI_CODING_AGENT_DIR`. For project-local keys, edit `<repo>/.omp/config.yml` directly.

### A `--config` overlay fails at startup

`--config` files are process-local YAML mappings. A missing file, invalid YAML, or a top-level array/scalar is a hard error — it does not silently fall back to lower-precedence settings. Fix the path or contents.

### An environment variable beats my config

Some settings (model roles, eval backends, tiny-model device/precision, auth broker, PTY) are overridable by env vars or CLI flags for per-machine convenience, and those take precedence over `config.yml`. Unset the variable or drop the flag to let the persisted value win. See [Environment overrides](#environment-overrides) and [Environment variables](./environment-variables.md).

### `omp config set <key>` says "Unknown setting"

Keys must match a schema path exactly, with no shorthand. Use `theme.dark`, not `theme`. Run `omp config list` to see every valid key.
