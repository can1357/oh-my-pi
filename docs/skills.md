# Skills

Skills are file-backed capability packs discovered at startup and exposed to the model as:

- lightweight metadata in the system prompt (name + description)
- on-demand content via the `read` tool against `skill://...`
- optional interactive `/skill:<name>` commands

This document covers current runtime behavior in `packages/coding-agent/src/extensibility/skills.ts`, `packages/coding-agent/src/discovery/builtin.ts`, `packages/coding-agent/src/internal-urls/skill-protocol.ts`, and `packages/coding-agent/src/discovery/agents-md.ts`.

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
  - native `.omp` provider skill discovery (`requireDescription: true`)
  - `omp-plugins` extension-package skills and the `github` provider (`.github/skills/`), which also pass `requireDescription: true`
  - `skills.customDirectories` scans via `scanSkillsFromDir` in `src/discovery/helpers.ts` (non-recursive)
- the claude/codex/agents/opencode/claude-plugins providers can load skills without description

## Discovery pipeline

`loadSkills()` in `packages/coding-agent/src/extensibility/skills.ts` does three passes:

1. **Capability providers** via `loadCapability("skills")` (the managed/auto-learn provider's skills are skipped here and handled in pass 3)
2. **Custom directories** via `scanSkillsFromDir(..., { requireDescription: true })` (one-level directory enumeration). A custom-directory skill overrides a same-named default provider skill; duplicate custom-directory names remain first-wins.
3. **Managed (auto-learn) skills** (`omp-managed` provider) resolved dead-last, so any same-named enabled authored skill from a provider or custom directory takes precedence

If `skills.enabled` is `false`, discovery returns no skills.

### Built-in skill providers and precedence

Provider ordering is priority-first (higher wins), then registration order for ties.

Current registered skill providers:

1. `native` (priority 100) — `.omp` user/project skills via `src/discovery/builtin.ts`
2. `omp-plugins` (priority 90) — `skills/` bundled next to extension packages loaded through `extensions:`, `--extension`/`-e`, or installed plugins under `~/.omp/plugins/node_modules`
3. `claude` (priority 80)
4. priority 70 group (in registration order):
   - `claude-plugins`
   - `agents`
   - `codex`
5. `opencode` (priority 55)
6. `github` (priority 30) — `.github/skills/<name>/SKILL.md` (GitHub Agent Skills layout, project-only)
7. `omp-managed` (priority 5) — auto-learn skills under `~/.omp/agent/managed-skills`, registered in `src/discovery/builtin.ts` and discovered unconditionally (only writing/nudging is gated by `autolearn.enabled`); always defers to a same-named authored skill

Dedup key is skill name. First item with a given name wins.

### Source toggles and filtering

`loadSkills()` applies these controls:

- source toggles: `enableCodexUser`, `enableClaudeUser`, `enableClaudeProject`, `enablePiUser`, `enablePiProject`, `enableAgentsUser`, `enableAgentsProject`
- `disabledExtensions` entries with `skill:<name>`
- `ignoredSkills` (exclude; glob patterns)
- `includeSkills` (include allowlist; glob patterns; empty means include all)

Filter order is:

1. not disabled by `disabledExtensions`
2. source enabled
3. not ignored
4. included (if include list present)

The `agents` provider (`.agent[s]/skills`) is the canonical OMP-native location and has its own `enableAgentsUser`/`enableAgentsProject` toggles — disabling Claude/Codex/Pi does **not** turn it off. Foreign user-level providers are opt-in through `enabledProviders`; their project roots still load by default. Native OMP sources and marketplace plugins registered under `~/.omp/plugins` also load by default. For `claude-plugins`, the opt-in controls only plugins from Claude Code's own user registry.

### Collision and duplicate handling

- Capability dedup already keeps first skill per name (highest-precedence provider)
- `extensibility/skills.ts` additionally:
  - de-duplicates identical files by `realpath` (symlink-safe)
  - emits collision warnings when a later skill name conflicts
  - keeps the convenience `loadSkillsFromDir({ dir, source })` API as a thin adapter over `scanSkillsFromDir`
- Custom-directory skills are merged after provider skills and override same-named default-path provider skills. Among custom directories, the first same-named skill wins.

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

- recognizes the traditional leading form and a whitespace-delimited `/skill:<name>` token embedded in ordinary prose
- for an embedded token, removes the token and passes the surrounding prose as arguments
- does not treat embedded tokens as invocations when the draft starts with another slash command or a local bash/Python execution sigil
- reads the skill file directly from `filePath`
- strips frontmatter
- wraps the body with skill name, base directory, and optional user arguments, then injects it as a custom message
- delivery mode follows the **submission keybinding**:
  - **Enter** → invokes the skill on the `steer` queue while streaming (matches free-text Enter, which also steers), or as a normal idle prompt when the agent is not streaming
  - **Ctrl+Enter** (`app.message.followUp`) → invokes the skill on the `followUp` queue while streaming, or as a normal idle prompt when the agent is not streaming

There is no flag, mode-selector, or frontmatter knob to override delivery mode — the keybinding _is_ the choice, identical to free-text routing during streaming. Both submission paths dispatch through `#invokeSkillCommand` in `input-controller.ts`, which delegates to `invokeSkillCommandFromText` in `src/modes/skill-command.ts`.

Invoked skill content is identified by invocation kind, each with its own prompt template (in `src/prompts/skills/`, rendered by `buildSkillPromptMessage` in `src/extensibility/skills.ts`):

- **User-invoked** (`user-invocation.md`, used by `/skill:<name>`): the message opens by announcing that the user invoked the skill, embeds the skill body, and appends the skill directory (`[Skill directory: <baseDir>]`) with instructions to resolve the skill's relative paths (scripts, templates) against it, plus optional `User: <args>`.
- **Autoloaded** (`autoload.md`): a minimal provenance-only format — body followed by `Skill: <path>` and optional `User: <args>` — used when subagents auto-inject skills declared via the `autoloadSkills` agent frontmatter field; these hidden messages must not claim the user invoked them.

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

`src/discovery/agents-md.ts` walks ancestor directories from `cwd` to discover standalone `AGENTS.md` files. For repositories nested under the user's home directory, it continues through enclosing workspace directories up to but not including the home directory. With no repository root under home, the home boundary remains included. Otherwise it stops at the repository root, or at the filesystem root when no repository root is known outside home. Files in hidden owner directories are skipped.

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
