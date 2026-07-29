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
│ 1) ~/.ompk/agent, ~/.claude, ...       │
│ 2) <cwd>/.ompk, <cwd>/.claude, ...     │
└───────────────────────────────────────┘
                    │
                    ▼
        capability providers enumerate items
 (native provider scans project .ompk before user .ompk;
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

1. `.ompk` (native)
2. `.claude`
3. `.codex`
4. `.gemini`

User-level bases:

- `~/.ompk/agent`
- `~/.claude`
- `~/.codex`
- `~/.gemini`

Project-level bases:

- `<cwd>/.ompk`
- `<cwd>/.claude`
- `<cwd>/.codex`
- `<cwd>/.gemini`

`CONFIG_DIR_NAME` is `.ompk` (`packages/utils/src/dirs.ts`).

## Profiles

A named profile (`oh-my-pk --profile <name>`, the `--alias` shortcut, or `OMP_PROFILE` / `PI_PROFILE`) relocates the OMP user base. When a profile is active, every OMP-native user-level path written here as `~/.ompk/agent/...` resolves to `~/.ompk/profiles/<name>/agent/...` instead.

The relocation is uniform across the native provider (`builtin.ts`) and the generic `config.ts` helpers, so it covers slash commands, rules, prompts, instructions, hooks, tools, extensions, settings, skills, and MCP, plus the top-level `SYSTEM.md` / `RULES.md` / `AGENTS.md` files and runtime state (sessions, blobs, `agent.db`). A profile sees only its own OMP config, never the default profile's `~/.ompk/agent`.

The other source bases are not profile-scoped and load identically under every profile: the external-tool bases (`~/.claude`, `~/.codex`, `~/.gemini`) belong to those tools, and the project-level bases (`<cwd>/.ompk`, `<cwd>/.claude`, ...) are keyed to the working directory. Throughout this document, read `~/.ompk/agent` as shorthand for the active profile's agent directory.

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

Walks parent directories upward and returns the **nearest existing directory per source base** (`.ompk`, `.claude`, `.codex`, `.gemini`), then sorts results by source priority.

Use this when project config should be inherited from ancestor directories (monorepo/nested workspace behavior).

---

## 3) File config wrapper (`ConfigFile<T>` in `src/config/config-file.ts`, re-exported from `src/config.ts`)

`ConfigFile<T>` is the schema-validated loader for single config files.

Supported formats:

- `.yml` / `.yaml`
- `.json` / `.jsonc`

Behavior:

- Validates parsed data against a provided Zod schema.
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

1. Global settings: `~/.ompk/agent/config.yml`
2. Project settings: discovered via settings capability (`settings.json` and `config.yml` from providers)
3. CLI config overlays: `oh-my-pk --config <path>` / repeated `--config` files, loaded as `config.yml`-style YAML for this process only
4. Runtime overrides: in-memory, non-persistent
5. Schema defaults: from `SETTINGS_SCHEMA`

Effective precedence:

`defaults <- global <- project <- CLI config overlays <- overrides`

Write behavior:

- `settings.set(...)` writes to the **global** layer (`config.yml`) and queues background save.
- Project settings are read-only from capability discovery.

## Migration behavior still active

On startup, if `config.yml` is missing:

1. Migrate from `~/.ompk/agent/settings.json` (renamed to `.bak` on success)
2. Merge with legacy DB settings from `agent.db`
3. Write merged result to `config.yml`

Field-level migrations in `#migrateRawSettings`:

- `queueMode` -> `steeringMode`
- `ask.timeout` milliseconds -> seconds when old value looks like ms (`> 1000`)
- Legacy flat `theme: "..."` -> `theme.dark/theme.light` structure

---

## 5) Capability/discovery integration

Most non-core config loading flows through the capability registry (`src/capability/index.ts` + `src/discovery/index.ts`).

## Provider ordering

Providers are sorted by numeric priority (higher first). Example priorities:

- Native OMP (`builtin.ts`): `100`
- Claude: `80`
- Codex / agents / Claude marketplace: `70`
- Gemini: `60`

```text
Provider precedence (higher wins)

native (.ompk)          priority 100
claude                 priority  80
codex / agents / ...   priority  70
gemini                 priority  60
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

## 6) Native `.ompk` provider behavior (`packages/coding-agent/src/discovery/builtin.ts`)

Native provider (`id: native`) reads native config from:

- project: `<cwd>/.ompk/...`
- user: `~/.ompk/agent/...`

### Directory admission rules

- Slash commands, rules, prompts, instructions, hooks, tools, extensions, extension modules, and settings use a project/user root only when the root directory exists and is non-empty.
- Skills scan `<ancestor>/.ompk/skills` for each ancestor from the current working directory up to the repo root/home boundary, plus `~/.ompk/agent/skills`, without requiring the root `.ompk` directory itself to be non-empty.
- `SYSTEM.md` and `AGENTS.md` read user-level files directly and use nearest-ancestor project `.ompk` lookup for project files, but the project `.ompk` directory must be non-empty. See [`docs/system-prompt-customization.md`](./system-prompt-customization.md) for the full `SYSTEM.md` / `APPEND_SYSTEM.md` contract (replace vs. append, templating).

### Scope-specific loading

- Skills: `<ancestor>/.ompk/skills/*/SKILL.md` and `~/.ompk/agent/skills/*/SKILL.md`
- Slash commands: `commands/*.md`
- Rules: `rules/*.{md,mdc}`
- Prompts: `prompts/*.md`
- Instructions: `instructions/*.md`
- Hooks: `hooks/pre/*`, `hooks/post/*`
- Tools: `tools/*.{json,md,ts,js,sh,bash,py}` and `tools/<name>/index.ts`
- Extension modules: discovered under `extensions/` (+ legacy `settings.json.extensions` string array)
- Extensions: `extensions/<name>/gemini-extension.json`
- Settings capability: `settings.json`, then `config.yml`

### Nearest-project lookup nuance

## For `SYSTEM.md` and `AGENTS.md`, native provider uses nearest-ancestor project `.ompk` directory search (walk-up) and still requires the project `.ompk` dir to be non-empty.

## 7) How major subsystems consume config

## Settings subsystem

- `Settings.init()` loads global `config.yml` + discovered project settings capability items.
- Only capability items with `level === "project"` are merged into project layer.

### Session title prompt override

Create `TITLE_SYSTEM.md` in the same config locations as `SYSTEM.md` / `APPEND_SYSTEM.md`:

```text
# ~/.ompk/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
```

- Missing `TITLE_SYSTEM.md` keeps the bundled title prompts.
- Discovery uses the same project-then-user config directory pattern as `SYSTEM.md`: project `.ompk/TITLE_SYSTEM.md` first, then user `~/.ompk/agent/TITLE_SYSTEM.md` and the other supported config bases.
- The override replaces only the automatic session-title generation system prompt; normal `SYSTEM.md` / `APPEND_SYSTEM.md` prompt customization is unaffected.
- The online path forces the `set_title` tool call when the title model honors a forced `tool_choice`. Tool-choice-less providers (chat-completions hosts without `tool_choice` support, Claude Fable/Mythos) instead receive a marker-based prompt and emit the title wrapped in `<title>...</title>`, which is parsed leniently (a plain sentence or a truncated/unclosed tag still works). A `TITLE_SYSTEM.md` override is reused in both modes; in marker mode the wrap-in-`<title>` instruction is appended after it. The local tiny-title path keeps the `<title>...</title>` prefill/stop wrapper and uses this file as its system turn.

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

- `discoverAndLoadExtensions()` resolves extension modules from extension-module capability plus explicit paths.
- Current implementation intentionally keeps only capability items with `_source.provider === "native"` before loading.

---

## 8) Precedence rules to rely on

Use this mental model:

1. Source directory ordering from `config.ts` determines candidate path order.
2. Capability provider priority determines cross-provider precedence.
3. Capability key dedup determines collision behavior (first wins for keyed capabilities).
4. Subsystem-specific merge logic can further change effective precedence (especially settings).

### Settings-specific caveat

Settings capability items are not deduplicated; `Settings.#loadProjectSettings()` deep-merges project items in returned order. Because merge applies later item values over earlier values, effective override behavior depends on provider emission order, not just capability key semantics.

---

## 9) Legacy/compatibility behaviors still present

- `ConfigFile` JSON -> YAML migration for YAML-targeted files.
- Settings migration from `settings.json` and `agent.db` to `config.yml`.
- Settings key migrations include `queueMode`, `ask.timeout`, flat `theme`, `task.isolation.enabled`, legacy `task.isolation.mode` values, removed edit modes, `statusLine.plan_mode`, `memories.enabled`, and hindsight scoping/name fields.
- Legacy setting names `skills.enablePiUser` / `skills.enablePiProject` are still active gates for native skill source.

If these compatibility paths are removed in code, update this document immediately; several runtime behaviors still depend on them today.
