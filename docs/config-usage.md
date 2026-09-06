# Configuration Discovery and Resolution

This document describes how the coding-agent resolves configuration today: which roots are scanned, how precedence works, and how resolved config is consumed by settings, skills, hooks, tools, and extensions.

## Scope

Primary implementation:

- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/config/config-file.ts` (re-exported from `config.ts`)
- `packages/coding-agent/src/config/settings.ts`
- `packages/coding-agent/src/config/settings-schema.ts`
- `packages/coding-agent/src/discovery/builtin.ts`
- `packages/coding-agent/src/discovery/helpers.ts`

Key integration points:

- `packages/coding-agent/src/capability/index.ts`
- `packages/coding-agent/src/discovery/index.ts`
- `packages/coding-agent/src/extensibility/skills.ts`
- `packages/coding-agent/src/extensibility/hooks/loader.ts`
- `packages/coding-agent/src/extensibility/custom-tools/loader.ts`
- `packages/coding-agent/src/extensibility/extensions/loader.ts`

---

## Resolution flow (visual)

```text
         Generic helper order (`config.ts`)
┌───────────────────────────────────────┐
│ 1) ~/.omp/agent, ~/.claude, ...       │
│ 2) <cwd>/.omp, <cwd>/.claude, ...     │
└───────────────────────────────────────┘
                    │
                    ▼
        capability providers enumerate items
 (native provider scans project .omp before user .omp;
  other providers have their own loading rules)
                    │
                    ▼
      provider priority sort + capability dedup
                    │
                    ▼
          subsystem-specific consumption
   (settings, skills, hooks, tools, extensions)
```

## 1) Config roots and source order

## Canonical roots

`src/config.ts` defines a fixed source priority list:

1. `.omp` (native)
2. `.claude`
3. `.codex`
4. `.gemini`

User-level bases:

- OMP native: `~/<PI_CONFIG_DIR>/agent` (normally `~/.omp/agent`; a named profile changes this as described below)
- `~/.claude`
- `~/.codex`
- `~/.gemini`

Project-level bases:

- `<cwd>/.omp`
- `<cwd>/.claude`
- `<cwd>/.codex`
- `<cwd>/.gemini`

`CONFIG_DIR_NAME` is `.omp` (`packages/utils/src/dirs.ts`). `PI_CONFIG_DIR` changes the OMP user root used by the generic helpers. `PI_CODING_AGENT_DIR` is different: for the default profile it changes `getAgentDir()` consumers such as native discovery, settings, and runtime state, but it does **not** change the generic `getConfigDirs()` / `findConfigFile()` OMP base. Named profiles ignore `PI_CODING_AGENT_DIR`.

## Profiles

A named profile (`omp --profile <name>`, `OMP_PROFILE`, or the legacy fallback `PI_PROFILE`) relocates the OMP user base. `OMP_PROFILE` wins when it is defined, including when it is explicitly empty; `default`, empty, or whitespace selects the default profile. When a profile is active, every OMP-native user-level path written here as `~/.omp/agent/...` normally resolves to `~/.omp/profiles/<name>/agent/...`. `--alias <command>` does not select a profile by itself: paired with `--profile`, it creates a shell shortcut for that profile.

The relocation is uniform across the native provider (`builtin.ts`) and the generic `config.ts` helpers, so it covers slash commands, rules, prompts, instructions, hooks, tools, extensions, settings, skills, and MCP, plus the top-level `SYSTEM.md` / `RULES.md` / `AGENTS.md` files and runtime state (sessions, blobs, `agent.db`). A profile sees only its own OMP config, never the default profile's agent config.

Keybindings are the one exception: a named profile merges the default profile's `~/.omp/agent/keybindings.*` under its own `~/.omp/profiles/<name>/agent/keybindings.*`, with the profile file overriding per binding ([#4867](https://github.com/can1357/oh-my-pi/issues/4867)). Keybindings describe the terminal/keyboard in front of the user, which doesn't change with the active profile, so user-level remaps keep working in every profile unless the profile explicitly overrides them. The inherited file is read-only for the profile process — legacy-format migration of the default profile's file only happens when the default profile itself runs.

On macOS and Linux, an existing `$XDG_DATA_HOME/omp`, `$XDG_STATE_HOME/omp`, or `$XDG_CACHE_HOME/omp` can relocate the corresponding data, state, or cache paths. For a named profile, OMP uses an XDG category only when that category already contains `omp/profiles/<name>`; otherwise that category remains under `~/.omp/profiles/<name>`. Run `omp config init-xdg` before relying on XDG paths.

The other source bases are not profile-scoped and load identically under every profile: the external-tool bases (`~/.claude`, `~/.codex`, `~/.gemini`) belong to those tools, and the project-level bases (`<cwd>/.omp`, `<cwd>/.claude`, ...) are keyed to the working directory. Throughout this document, read `~/.omp/agent` as shorthand for the active profile's agent directory unless an environment override or XDG path is being discussed.

## Important constraint

The generic helpers in `src/config.ts` do **not** include `.pi` in source discovery order.

---

## 2) Core discovery helpers (`src/config.ts`)

## `getConfigDirs(subpath, options)`

Returns ordered entries:

- User-level entries first (by source priority)
- Then project-level entries (by same source priority)

Options:

- `user` (default `true`)
- `project` (default `true`)
- `cwd` (default `getProjectDir()`)
- `existingOnly` (default `false`)

This API is used for directory-based config lookups (commands, hooks, tools, agents, etc.).

## `findConfigFile(subpath, options)` / `findConfigFileWithMeta(...)`

Searches for the first existing file across ordered bases, returns first match (path-only or path+metadata).

## `findAllNearestProjectConfigDirs(subpath, cwd)`

Walks parent directories upward and returns the **nearest existing directory per source base** (`.omp`, `.claude`, `.codex`, `.gemini`), then sorts results by source priority.

Use this when project config should be inherited from ancestor directories (monorepo/nested workspace behavior).

---

## 3) File config wrapper (`ConfigFile<T>` in `src/config/config-file.ts`, re-exported from `src/config.ts`)

`ConfigFile<T>` is the schema-validated loader for single config files.

Supported formats:

- `.yml` / `.yaml`
- `.json` / `.jsonc`

Behavior:

- Validates parsed data against a provided omptype schema.
- Caches load result until `invalidate()`.
- Returns tri-state result via `tryLoad()`:
  - `ok`
  - `not-found`
  - `error` (`ConfigError` with schema/parse context)

Legacy migration still supported:

- If target path is `.yml`/`.yaml`, a sibling `.json` is auto-migrated once (`migrateJsonToYml`).

---

## 4) Settings resolution model (`src/config/settings.ts`)

The runtime settings model is layered:

1. Global settings: the first present file among `~/.omp/agent/config.yml` and `config.yaml`
2. Project settings: discovered via the settings capability (`settings.json` and `config.yml` from providers)
3. Config overlays: `PI_CONFIG_FILES` (platform path-list), followed by repeated `omp --config <path>` files; all are loaded as `config.yml`-style YAML for this process only
4. Runtime overrides: in-memory, non-persistent
5. Schema defaults: from `SETTINGS_SCHEMA`

Effective precedence:

`defaults <- global <- project <- PI_CONFIG_FILES overlays <- --config overlays <- runtime overrides`

Within either overlay list, later files override earlier files. Overlay paths are resolved relative to the active project directory (after `~` expansion).

Write behavior:

- `settings.set(...)` writes to the **global** layer (the global YAML file selected at startup) and queues a background save.
- Project settings and config overlays are read-only from the settings API.

### Settings load failures

- Missing global/project YAML is treated as empty configuration.
- Invalid global or native-project YAML is moved to a unique `.broken-<timestamp>-<pid>-<uuid>` sibling under a file lock, then startup fails with the original and backup paths. An unreadable file fails without being moved.
- Every `PI_CONFIG_FILES` / `--config` overlay is strict: missing files, invalid YAML, and non-mapping document roots are hard errors. Overlay files are not quarantined.

## Migration behavior still active

On startup, if neither global `config.yml` nor `config.yaml` exists:

1. Migrate from `~/.omp/agent/settings.json` (renamed to `.bak` on success)
2. Merge with legacy DB settings from `agent.db` (DB values win conflicts)
3. Write merged result to `config.yml`

Field-level migrations in `#migrateRawSettings`:

- `queueMode` -> `steeringMode`
- `ask.timeout` milliseconds -> seconds when old value looks like ms (`> 1000`)
- Legacy flat `theme: "..."` -> `theme.dark/theme.light` structure

---

## 5) Capability/discovery integration

Most non-core config loading flows through the capability registry (`src/capability/index.ts` + `src/discovery/index.ts`).

## Provider ordering

Providers are sorted by numeric priority (higher first). Full set:

- Native OMP (`builtin.ts`): `100`
- OMP plugins (`omp-plugins`): `90`
- Claude: `80`
- Agent Plugins standard (`agent-plugins`): `75`
- Codex / agents / Claude plugins marketplace: `70`
- Gemini: `60`
- OpenCode: `55`
- Cursor / Windsurf: `50`
- Cline: `40`
- GitHub Copilot: `30`
- VS Code: `20`
- agents-md (`AGENTS.md` files): `10`
- mcp-json / ssh-json: `5`
- Built-in default rules (`builtin-defaults`): `1`

```text
Provider precedence (higher wins)

native (.omp)           priority 100
omp-plugins             priority  90
claude                  priority  80
agent-plugins           priority  75
codex / agents /
  claude-plugins        priority  70
gemini                  priority  60
opencode                priority  55
cursor / windsurf       priority  50
cline                   priority  40
github                  priority  30
vscode                  priority  20
agents-md               priority  10
mcp-json / ssh-json     priority   5
builtin-defaults        priority   1
```

## Dedup semantics

Capabilities define a `key(item)`:

- same key => first item wins (higher-priority/earlier-loaded item)
- no key (`undefined`) => no dedup, all items retained

Relevant keys:

- skills: `name`
- tools: `name`
- hooks: `${type}:${tool}:${name}`
- extension modules: `name`
- extensions: `name`
- settings: no dedup (all items preserved)

---

## 6) Native `.omp` provider behavior (`packages/coding-agent/src/discovery/builtin.ts`)

Native provider (`id: native`) reads native config from:

- project: `<cwd>/.omp/...`
- user: `~/.omp/agent/...`

### Directory admission rules

- Slash commands, directory rules, prompts, instructions, hooks, tools, extensions, extension modules, and settings use a project/user root only when the root directory exists and is non-empty.
- Skills scan `<ancestor>/.omp/skills` for each ancestor from the current working directory up to the repo root/home boundary, plus `~/.omp/agent/skills`, without requiring the root `.omp` directory itself to be non-empty.
- `SYSTEM.md`, `RULES.md`, and `.omp/AGENTS.md` read user-level files directly and use the nearest non-empty ancestor `.omp` directory for project files. `RULES.md` becomes an always-apply sticky rule. See [`docs/system-prompt-customization.md`](./system-prompt-customization.md) for the full `SYSTEM.md` / `APPEND_SYSTEM.md` contract.
- MCP does not use the non-empty-root admission helper. It reads project `.omp/mcp.json` then `.omp/.mcp.json`, followed by user `mcp.json` then `.mcp.json`, directly.

### Scope-specific loading

- Skills: `<ancestor>/.omp/skills/*/SKILL.md` and `~/.omp/agent/skills/*/SKILL.md`
- Slash commands: `commands/*.md`
- Rules: `rules/*.{md,mdc}` plus top-level `RULES.md`
- Prompts: `prompts/*.md`
- Instructions: `instructions/*.md`
- Hooks: `hooks/pre/*`, `hooks/post/*`
- Tools: `tools/*.{json,md,ts,js,sh,bash,py}` and `tools/<name>/index.ts`
- Extension modules: discovered under `extensions/` (+ legacy `settings.json.extensions` string array)
- Extensions: `extensions/<name>/gemini-extension.json`
- Settings capability: `settings.json`, then `config.yml`
- Context files: `.omp/AGENTS.md`; standalone ancestor `AGENTS.md` files are loaded separately by the low-priority `agents-md` provider

### Nearest-project lookup nuance

For `SYSTEM.md`, `RULES.md`, and `.omp/AGENTS.md`, the native provider walks upward to the nearest non-empty project `.omp` directory.

## 7) How major subsystems consume config

## Settings subsystem

- `Settings.init()` loads the global YAML file, discovered project settings, `PI_CONFIG_FILES` / `--config` overlays, and runtime overrides in the precedence described above.
- Only capability items with `level === "project"` are merged into the project layer.

### Session title prompt override

Create `TITLE_SYSTEM.md` in any generic config base:

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
```

- Missing `TITLE_SYSTEM.md` keeps the bundled title prompts.
- Discovery checks the current project directory bases first (`<cwd>/.omp`, `.claude`, `.codex`, `.gemini`), then the user bases in the generic helper order. Unlike native `SYSTEM.md`, project title discovery does **not** walk ancestor directories.
- The override replaces only the automatic session-title generation system prompt; normal `SYSTEM.md` / `APPEND_SYSTEM.md` prompt customization is unaffected.
- The online path asks the title model to wrap the title in `<title>...</title>` and parses it leniently from text (a plain sentence, a truncated/unclosed tag, or a stray `{"title": "..."}` JSON echo all still work). A `TITLE_SYSTEM.md` override gets the wrap-in-`<title>` instruction appended after it. The local tiny-title path keeps the `<title>...</title>` prefill/stop wrapper and uses this file as its system turn.

## Skills subsystem

- `extensibility/skills.ts` loads via `loadCapability(skillCapability.id, { cwd })`.
- Applies source toggles and filters (`ignoredSkills`, `includeSkills`, custom dirs).
- Legacy-named toggles still exist (`skills.enablePiUser`, `skills.enablePiProject`) but they gate the native provider (`provider === "native"`).

## Hooks subsystem

- `discoverAndLoadHooks()` resolves hook paths from hook capability + explicit configured paths.
- Then loads modules via Bun import.

## Tools subsystem

- `discoverAndLoadCustomTools()` resolves tool paths from tool capability + plugin tool paths + explicit configured paths.
- Declarative `.md/.json` tool files are metadata only; executable loading expects code modules.

## Extensions subsystem

- `discoverAndLoadExtensions()` loads native extension-module capability items, JS/TS hook factories, installed-plugin entry points, and explicit configured paths.
- Ambient extension-module capability discovery is explicitly restricted to `provider: "native"`; foreign providers are not scanned for this step.

---

## 8) Precedence rules to rely on

Use this mental model:

1. Source directory ordering from `config.ts` determines candidate path order.
2. Capability provider priority determines cross-provider precedence.
3. Capability key dedup determines collision behavior (first wins for keyed capabilities).
4. Subsystem-specific merge logic can further change effective precedence (especially settings).

### Settings-specific caveat

Settings capability items are not deduplicated; `Settings.#loadProjectSettings()` deep-merges project items in returned order, so later items override earlier ones. Providers are visited from highest to lowest priority, which means lower-priority provider settings can override higher-priority settings. Within the native provider, project `config.yml` follows and overrides `settings.json`. Native `.omp/config.yml` model roles are then reapplied as the authoritative project model-role layer.

---

## 9) Legacy/compatibility behaviors still present

- `ConfigFile` JSON -> YAML migration for YAML-targeted files.
- Settings migration from `settings.json` and `agent.db` to `config.yml`.
- Field migrations cover renamed/removed settings and value-shape changes, including `queueMode`, changelog settings, `ask.timeout`, flat `theme`, retired image-tool settings, task isolation/eager settings, removed edit and compaction modes, `inlineToolDescriptors`, status-line segments, provider/search settings, memories/hindsight settings, and nested-leaf renames. Consult `Settings.#migrateRawSettings()` for the current exhaustive list.
- Legacy setting names `skills.enablePiUser` / `skills.enablePiProject` are still active gates for native skill source.

If these compatibility paths are removed in code, update this document immediately; several runtime behaviors still depend on them today.
