# Skills

Skills are file-backed capability packs discovered at startup and exposed to the model as:

- lightweight metadata in the system prompt (name + description)
- on-demand content via the `read` tool against `skill://...`
- optional interactive `/skill:<name>` commands

This document covers current runtime behavior in `src/extensibility/skills.ts`, `src/discovery/builtin.ts`, `src/internal-urls/skill-protocol.ts`, and `src/discovery/agents-md.ts`.

## Mesh / cloud skills (environments-cloud)

Mesh and Colab warmup skills are **not** authored in the OMPK monorepo. On MSI-1 they live under:

```text
C:\dev\desktop-infra\environments-cloud\.agents\skills\
```

`loadSkills()` auto-merges that directory when it exists (`src/config/environments-cloud-skills.ts`). Override with `OMPK_ENVIRONMENTS_CLOUD_ROOT` or `PKS_ENVIRONMENTS_CLOUD_ROOT`. Pass `environmentsCloudRoot: null` to disable (tests). Details: [`environments-cloud.md`](./environments-cloud.md).

## What a skill is in this codebase

A discovered skill is represented as:

- `name`
- `description`
- `filePath` (the `SKILL.md` path)
- `baseDir` (skill directory)
- source metadata (`provider`, `level`, path)

The runtime only requires `name` and `path` for validity. In practice, matching quality depends on `description` being meaningful.

## Required layout and SKILL.md expectations

### Directory layout

For provider-based discovery (native/Claude/Codex/Agents/plugin providers), skills are discovered as **one level under `skills/`**:

- `<skills-root>/<skill-name>/SKILL.md`

Nested patterns like `<skills-root>/group/<skill>/SKILL.md` are not discovered by provider loaders.

For `skills.customDirectories`, scanning uses the same non-recursive layout (`*/SKILL.md`).

```text
Provider-discovered layout (non-recursive under skills/):

<root>/skills/
  ├─ postgres/
  │   └─ SKILL.md      ✅ discovered
  ├─ pdf/
  │   └─ SKILL.md      ✅ discovered
  └─ team/
      └─ internal/
          └─ SKILL.md  ❌ not discovered by provider loaders

Custom-directory scanning is also non-recursive, so nested paths are ignored unless you point `customDirectories` at that nested parent.
```

### `SKILL.md` frontmatter

Supported frontmatter fields on the skill type:

- `name?: string`
- `description?: string`
- `globs?: string[]`
- `alwaysApply?: boolean`
- `hide?: boolean`
- `disableModelInvocation?: boolean` (Agent Skills equivalent of `hide`; normalized from kebab-case `disable-model-invocation`)
- additional keys are preserved as unknown metadata

Current runtime behavior:

- `name` defaults to the skill directory name
- `description` is required for:
  - native `.ompk` provider skill discovery (`requireDescription: true`)
  - `omp-plugins` extension-package skills and the `github` provider (`.github/skills/`), which also pass `requireDescription: true`
  - `skills.customDirectories` scans via `scanSkillsFromDir` in `src/discovery/helpers.ts` (non-recursive)
- the claude/codex/agents/opencode/claude-plugins providers can load skills without description

## Discovery pipeline

`loadSkills()` in `src/extensibility/skills.ts` does three passes:

1. **Capability providers** via `loadCapability("skills")` (the managed/auto-learn provider's skills are skipped here and handled in pass 3)
2. **Custom directories** via `scanSkillsFromDir(..., { requireDescription: true })` (one-level directory enumeration)
3. **Managed (auto-learn) skills** (`omp-managed` provider) resolved dead-last with first-wins, so any same-named authored skill from any provider or custom directory takes precedence

If `skills.enabled` is `false`, discovery returns no skills.

### Built-in skill providers and precedence

Provider ordering is priority-first (higher wins), then registration order for ties.

Current registered skill providers:

1. `native` (priority 100) — `.ompk` user/project skills via `src/discovery/builtin.ts`
2. `omp-plugins` (priority 90) — `skills/` bundled next to extension packages loaded through `extensions:`, `--extension`/`-e`, or installed plugins under `~/.ompk/plugins/node_modules`
3. `claude` (priority 80)
4. priority 70 group (in registration order):
   - `claude-plugins`
   - `agents`
   - `codex`
5. `opencode` (priority 55)
6. `github` (priority 30) — `.github/skills/<name>/SKILL.md` (GitHub Agent Skills layout, project-only)
7. `omp-managed` (priority 5) — auto-learn skills under `~/.ompk/agent/managed-skills`, registered in `src/discovery/builtin.ts` and discovered unconditionally (only writing/nudging is gated by `autolearn.enabled`); always defers to a same-named authored skill
8. `builtin-skills` (priority 1) — bundled skills (`agentic-mapreduce`, `ompk-swarm-core`, `promptbtw-handoff`, `tree-of-thoughts`) embedded into the binary from `src/discovery/builtin-skills/`, registered in `src/discovery/builtin-defaults.ts`. Served in-memory via `Skill.embeddedContent` (no on-disk file; `skill://<name>/<relative>` sub-paths are rejected). Lowest priority, so any same-named skill from any other provider overrides them. Gated by `skills.enableBuiltinSkills` (default `true`); individual skills disable via `disabledExtensions: ["skill:<name>"]` or `ignoredSkills`.

Dedup key is skill name. First item with a given name wins.

### Source toggles and filtering

`loadSkills()` applies these controls:

- source toggles: `enableCodexUser`, `enableClaudeUser`, `enableClaudeProject`, `enablePiUser`, `enablePiProject`, `enableAgentsUser`, `enableAgentsProject`, `enableBuiltinSkills` (embedded builtin skills; not affected by the third-party fallback)
- `disabledExtensions` entries with `skill:<name>`
- `ignoredSkills` (exclude; glob patterns)
- `includeSkills` (include allowlist; glob patterns; empty means include all)

Filter order is:

1. not disabled by `disabledExtensions`
2. source enabled
3. not ignored
4. included (if include list present)

The `agents` provider (`.agent[s]/skills`) is the canonical OMP-native location and has its own `enableAgentsUser`/`enableAgentsProject` toggles — disabling Claude/Codex/Pi does **not** turn it off. For providers without a dedicated toggle (`claude-plugins`, `opencode`, `gemini`, `github`, …), enablement falls back to: enabled if **any** named source toggle is enabled.

### Collision and duplicate handling

- Capability dedup already keeps first skill per name (highest-precedence provider)
- `extensibility/skills.ts` additionally:
  - de-duplicates identical files by `realpath` (symlink-safe)
  - emits collision warnings when a later skill name conflicts
  - keeps the convenience `loadSkillsFromDir({ dir, source })` API as a thin adapter over `scanSkillsFromDir`
- Custom-directory skills are merged after provider skills and follow the same collision behavior

## Runtime usage behavior

### System prompt exposure

System prompt construction (`src/system-prompt.ts`) uses discovered skills as follows:

- if `read` tool is available:
  - include discovered skills list in prompt, excluding skills with `hide: true`
- otherwise:
  - omit discovered list

`hide: true` does not disable the skill. Hidden skills are still loaded and remain reachable through `skill://<name>` and `/skill:<name>` when skill commands are enabled.

Task tool subagents receive the session's discovered/provided skills list via normal session creation; there is no per-task skill pinning override.

### Interactive `/skill:<name>` commands

If `skills.enableSkillCommands` is true, interactive mode registers one slash command per discovered skill.

`/skill:<name> [args]` behavior:

- reads the skill file directly from `filePath`
- strips frontmatter
- injects skill body as a custom message
- delivery mode follows the **submission keybinding**:
  - **Enter** → invokes the skill on the `steer` queue while streaming (matches free-text Enter, which also steers), or as a normal idle prompt when the agent is not streaming
  - **Ctrl+Enter** (`app.message.followUp`) → invokes the skill on the `followUp` queue while streaming, or as a normal idle prompt when the agent is not streaming
- appends metadata (`Skill: <path>`, optional `User: <args>`)

There is no flag, mode-selector, or frontmatter knob to override this — the keybinding _is_ the choice, identical to how free text is routed during streaming (`input-controller.ts:562-568` for Enter, `input-controller.ts:961-966` for Ctrl+Enter; both dispatch through `#invokeSkillCommand`).

## `skill://` URL behavior

`src/internal-urls/skill-protocol.ts` supports:

- `skill://<name>` → resolves to that skill's `SKILL.md`
- `skill://<name>/<relative-path>` → resolves inside that skill directory

```text
skill:// URL resolution

skill://pdf
  -> <pdf-base>/SKILL.md

skill://pdf/references/tables.md
  -> <pdf-base>/references/tables.md

Guards:
- reject absolute paths
- reject `..` traversal
- reject any resolved path escaping <pdf-base>
```

Resolution details:

- skill name must match exactly
- relative paths are URL-decoded
- absolute paths are rejected
- path traversal (`..`) is rejected
- resolved path must remain within `baseDir`
- missing files return an explicit `File not found` error

Content type:

- `.md` => `text/markdown`
- everything else => `text/plain`

No fallback search is performed for missing assets.

## Skills vs AGENTS.md, commands, tools, hooks

### Skills vs AGENTS.md

- **Skills**: named, optional capability packs selected by task context or explicitly requested
- **AGENTS.md/context files**: persistent instruction files loaded as context-file capability and merged by level/depth rules

`src/discovery/agents-md.ts` specifically walks ancestor directories from `cwd` to discover standalone `AGENTS.md` files (stopping at the repo root, or home when no repo root is known), skipping files whose containing directory name starts with a dot.

### Skills vs slash commands

- **Skills**: model-readable knowledge/workflow content
- **Slash commands**: user-invoked command entry points
- `/skill:<name>` is a convenience wrapper that injects skill text; it does not change skill discovery semantics

### Skills vs custom tools

- **Skills**: documentation/workflow content loaded through prompt context and `read`
- **Custom tools**: executable tool APIs callable by the model with schemas and runtime side effects

### Skills vs hooks

- **Skills**: passive content
- **Hooks**: event-driven runtime interceptors that can block/modify behavior during execution

## Practical authoring guidance tied to discovery logic

- Put each skill in its own directory: `<skills-root>/<skill-name>/SKILL.md`
- Always include explicit `name` and `description` frontmatter
- Keep referenced assets under the same skill directory and access with `skill://<name>/...`
- For nested taxonomy (`team/domain/skill`), point `skills.customDirectories` to the nested parent directory; scanning itself remains non-recursive
- Avoid duplicate skill names across sources; first match wins by provider precedence
