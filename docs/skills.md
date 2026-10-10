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

The capability validator only requires `name` and `path`; individual providers impose additional frontmatter requirements. Matching quality depends on `description` being meaningful.

## Required layout and SKILL.md expectations

### Directory layout

For conventional provider roots (native/Claude/Codex/Agents/plugins), skills are discovered as **one level under `skills/`**:

- `<skills-root>/<skill-name>/SKILL.md`

Nested patterns like `<skills-root>/group/<skill>/SKILL.md` are not discovered recursively. The Claude-plugin provider also accepts manifest-declared skill directories containing `SKILL.md` directly, in addition to their immediate children. Agent Plugins packages use only the fixed `skills/<name>/SKILL.md` layout; registry-installed Skillshare packages have a root `SKILL.md`.

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
- additional keys are preserved as unknown metadata by conventional scanners
- `enabled: false` skips a skill in conventional scanners and Skillshare discovery

`globs` and `alwaysApply` are metadata here, not automatic skill-invocation controls. Agent Plugins packages use stricter Agent Skills validation instead of the permissive scanner: required name/description, directory-name agreement, valid naming, and a closed frontmatter field set. OMP-specific fields such as `hide` and `enabled` are not accepted there.

Current runtime behavior:

- `name` defaults to the skill directory name
- `description` is required for:
  - native `.omp` provider skill discovery (`requireDescription: true`)
  - `omp-plugins` extension-package skills and the `github` provider (`.github/skills/`), which also pass `requireDescription: true`
  - `skills.customDirectories` scans via `scanSkillsFromDir` in `src/discovery/helpers.ts` (non-recursive)
- the claude/codex/agents/opencode/claude-plugins providers can load skills without description
- `agent-plugins` validates required `name` and `description` against the Agent Skills specification

## Discovery pipeline

`loadSkills()` in `packages/coding-agent/src/extensibility/skills.ts` does three passes:

1. **Capability providers** via `loadCapability("skills")` (the managed/auto-learn provider's skills are skipped here and handled in pass 3)
2. **Custom directories** via `scanSkillsFromDir(..., { requireDescription: true })` (one-level directory enumeration). A custom-directory skill overrides a same-named default provider skill; the displaced provider skill stays reachable under its namespaced name unless its body is identical.
3. **Managed (auto-learn) skills** (`omp-managed` provider) resolved dead-last, so any same-named enabled authored skill from a provider or custom directory takes precedence

If `skills.enabled` is `false`, discovery returns no skills.

### Built-in skill providers and precedence

Provider ordering is priority-first (higher wins), then registration order for ties.

Current registered skill providers:

1. `native` (priority 100) — `.omp` user/project skills via `src/discovery/builtin.ts`
2. `skillshare` (priority 95) — packages pinned in project `.omp/skills.lock.json` or the user agent directory's `skills.lock.json`, loaded from the Skillshare store; authored skills still outrank these on name collisions
3. `omp-plugins` (priority 90) — `skills/` bundled next to extension packages loaded through `extensions:`, `--extension`/`-e`, or installed plugins under `~/.omp/plugins/node_modules`
4. `claude` (priority 80)
5. `agent-plugins` (priority 75) — portable packages with a standard root `plugin.json`; conventional plugin providers defer their skills/MCP discovery to this provider
6. priority 70 group (in registration order):
   - `claude-plugins`
   - `agents`
   - `codex`
7. `opencode` (priority 55)
8. `github` (priority 30) — `.github/skills/<name>/SKILL.md` (GitHub Agent Skills layout, project-only)
9. `omp-managed` (priority 5) — auto-learn skills under `~/.omp/agent/managed-skills`, registered in `src/discovery/builtin.ts` and discovered unconditionally (only writing/nudging is gated by `autolearn.enabled`); always defers to a same-named authored skill

Capability dedup key is skill name; the first item with a given name wins in the deduped `items` view. `loadSkills()` resolves same-name collisions itself (see "Collision and duplicate handling").

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

The `agents` provider (`.agent[s]/skills`) has its own `enableAgentsUser`/`enableAgentsProject` toggles — disabling Claude/Codex/Pi does **not** turn it off. Foreign user-level providers are opt-in through `enabledProviders`; their project roots still load by default. Native OMP sources and marketplace plugins registered under `~/.omp/plugins` also load by default. For `claude-plugins`, the opt-in controls only plugins from Claude Code's own user registry.

### Collision and duplicate handling

- Capability dedup keeps the first skill per name (highest-precedence provider) for the deduped `items` view; `loadSkills()` works from the pre-dedup superset so lower-precedence copies can still be examined.
- `extensibility/skills.ts` then:
  - de-duplicates identical files by `realpath` (symlink-safe)
  - drops a later same-named skill silently when its body is identical and its parsed frontmatter is deeply equal to a loaded one (the same skill installed twice, e.g. a plugin copy mirrored into `~/.agents/skills`). When the incoming skill outranks the bare holder (below), the identical copies it supersedes (the bare holder and any namespaced aliases) are dropped instead, so an override never re-admits its own duplicate
  - optionally treats differing same-name plugin skills as one lineage when their manifests declare the same normalized `repository`. Set `skills.dedupeSameOrigin` to `true` to keep only the highest-precedence variant; it defaults to `false`, because repository metadata is self-declared and does not prove authenticity. The repository identity includes `repository.directory` for monorepos
  - when same-named skills differ and same-origin resolution is not enabled or does not match, the higher-precedence skill keeps the bare name and every other variant receives a `<namespace>/<name>` suffix, with collision warnings naming the paths. Precedence: an authored skill outranks a registry-installed package (the `skillshare` provider, `omp skill install`); a custom-directory skill outranks a provider skill (#7190); otherwise whichever was admitted first — provider-priority order for providers, array order within `skills.customDirectories` for custom directories — keeps the bare name. The namespace is the plugin identity from provider metadata when the provider tracks one (every registry-backed provider supplies one: `claude-plugins` and `agent-plugins` use the plugin name, `omp-plugins` the extension package directory name, and `skillshare` the registry package name), falling back to the path root/provider when absent
  - rejects a raw frontmatter `name` containing `/` or `\` (with a warning) for every provider and custom directory: the separator is reserved for the namespaced form and for `skill://<name>/<path>` resolution, so a raw name cannot claim a namespaced address
  - keeps the convenience `loadSkillsFromDir({ dir, source })` API as a thin adapter over `scanSkillsFromDir`
- Namespaced skills resolve through `skill://<namespace>/<name>[/<path>]` and the `/skill:<namespace>/<name>` token, both leading and mid-prompt (a mid-prompt token accepts exactly one `/`; deeper paths are left as prose). Because skill names never contain `/`, an exact `<host>/<first segment>` match is unambiguous and takes precedence over reading that segment as a path relative to a bare skill of the same name as the namespace.
- Custom-directory skills are merged after provider skills and outrank a same-named default-path provider skill regardless of admission order (#7190): the custom-directory skill keeps the bare name, and the provider skill is re-admitted under its namespaced name (suffixed if that slot is taken) when it differs or dropped when it is identical. Among two custom directories, the first one in `skills.customDirectories` keeps the bare name and the other is namespaced.
- `disabledExtensions` (`skill:<name>`) and `skills.ignoredSkills` are applied to both the raw and the final name, so a namespaced alias cannot bypass an exclusion. `skills.includeSkills` is applied to the final listing only, after every name is resolved, so `second/*` selects a namespaced skill even though the bare skill it collided with is not itself included.

### Startup diagnostics

The interactive TUI shows a grouped startup notice when enabled skill sources
contain conflicting same-name variants or distinct identical copies. Conflicts
are warnings; successfully deduplicated copies are informational. Symlinks to the
same real file do not count as redundant installations, and filtered-out variants
do not produce conflict notices.

Run `/skills diagnostics` to open the diagnostics panel, a navigable list of
every loaded skill with its issues and analysis state. Selecting a skill shows
the bare default (when included), namespaced variants, redundant copies, their
backing paths and sources, declared source repositories and versions when
available, and the selection rule. A shared name or self-declared repository
does not establish authenticity. See [Assisted diagnostics](#assisted-diagnostics).

RPC hosts can inspect the same resolution through `get_skill_diagnostics`,
`get_state.skillDiagnostics`, and `skill_diagnostics_update` frames, including
when notices are off. `set_skill_startup_diagnostics` changes the same native
preference and returns its effective value. See the [RPC contract](rpc.md#skill-diagnostics).

Startup notices are enabled by default, including when `startup.quiet` hides the
welcome banner. Disable them in `/settings` → Tasks → Commands & Skills →
**Skill Startup Notices**, or persist the setting from a shell:

```bash
omp config set skills.showStartupDiagnostics false
```

This setting only controls the automatic TUI notice. `/skills diagnostics`,
`omp skill list [dir] --json`, skill selection, and existing discovery warnings
are unchanged. Diagnostics are never added to model instructions or session
history.

Same-origin resolution is disabled by default. Opt in from `/settings` → Tasks →
Commands & Skills → **Dedupe Same-Origin Skills**, or persist it:

```bash
omp config set skills.dedupeSameOrigin true
```

When enabled, differing same-name skills supplied by plugins that declare the
same normalized source repository are resolved like redundant copies: existing
provider precedence selects one active skill, while diagnostics retain the hidden
variant and its version. Skills without repository metadata and skills declaring
different repositories continue to receive namespaced aliases.

### Assisted diagnostics

`/skills diagnostics` opens a navigable list of loaded skills, their conflicts,
redundant installations, and missing provenance. Use **Up/Down** to select a skill
and inspect its variants and retained analysis. Press **Enter** to analyze the
selected competing copies, **C** to cancel an active analysis, **A** to apply an
eligible recommendation, or **Esc** to close. Single-copy skills explain why
relationship analysis is unavailable.

Before sending any resource content, OMP names the model, shows the selected
resource paths, payload size, and incomplete coverage, then asks for consent.
Analysis uses the configured `smol` model role and may incur provider charges.
Opening the panel, navigating it, querying RPC diagnostics, and startup notices
do not trigger analysis. Consented work can finish after the panel closes;
reopening it shows the results. Changing sessions discards that session's plans
and results.

RPC hosts use the same session-owned plans and results: prepare a selected skill
with `prepare_skill_diagnostic_analysis`, explicitly consent with
`analyze_skill_diagnostics`, and separately confirm an application with
`apply_skill_diagnostic_analysis`. `cancel_skill_diagnostic_analysis` cancels a
prepared or running plan. Snapshots and `skill_diagnostics_update` events carry
per-skill status and results, including bounded verbatim evidence excerpts from
the analyzed skill files; clients never submit resource contents or paths.
See [RPC documentation](rpc.md) for the wire contract.

The advisory result separates an inferred relationship, cited file evidence,
meaningful differences, and a recommendation. It can recommend keeping all
copies or preferring one for OMP. Inferences do not establish authorship, origin,
authenticity, or interchangeable runtime behavior. Supporting scripts and
references are inspected as data, never executed; the main conversation and
session system prompt are not sent. Reviewed contents are checked again before
sending and immediately before a preference is saved. Changed contents invalidate
the analysis record; any completed result stays visible but cannot be applied.

Known credential files and secret patterns are filtered, but a resource may still
contain private information that detection cannot identify. Review the selected
files before agreeing to send them to a model provider.

Applying a preference requires a **second confirmation**. A confirmed choice
hides the other reviewed copies in OMP only; nothing is uninstalled and other
harnesses' files are untouched. The decision records fingerprints for every
reviewed copy, including the preferred one. Changes to any copy invalidate the
decision and allow it to load again. Incomplete reviews cannot authorize hiding
copies. Only user-owned global approval records are honored: repository, launch,
and runtime configuration layers cannot create approvals. Invalid records are
ignored with a warning. Preferences do not override independent enable/disable
or skill inclusion rules.

Restore all globally saved choices with:

```bash
omp config reset diagnostics.resourceExclusions
```

#### Extension and plugin analysis

The existing plugin health command offers the same read-only analyzer:

```bash
omp plugin doctor --analyze plugin-a plugin-b
omp plugin doctor --analyze ./generic-extension.ts ./omp-extension.ts --model provider/model-id
```

Selecting an entrypoint inside a known extension package is refused: select its
owning package so a confirmed exclusion covers all of its hooks, tools, skills,
and other capabilities. Standalone extension files remain selectable.


Select exactly two installed names or paths to extension files/package
directories. OMP asks before sending their contents. `--yes` supplies **analysis
consent only**, enabling non-interactive reports:

```bash
omp plugin doctor --analyze plugin-a plugin-b --yes --json
```

`--apply` requests a separate interactive confirmation after the report; it is
refused with `--json` or without a terminal. `--fix` cannot be combined with
`--analyze`: existing deterministic repairs never authorize AI-driven choices.
Confirmed extension exclusions take effect on discovery/loading, including
explicit paths. Restart existing sessions to unload extensions, hooks, tools,
or MCP servers they already loaded.

Snapshots are bounded to 40 files, 40 KiB per file, and 80 KiB of file content
per resource. The aggregate resource-data budget is 400 KiB for two to eight
copies, checked before consent. Symlinks, credential files, dependencies, binary
payloads, and uninspected code are reported as omissions. Known provider tokens,
secret-named assignments, and URL passwords are redacted. Incomplete coverage
forces a keep-all recommendation.

Code checks are deliberately bounded:

- Runtime JavaScript/TypeScript imports use the transpiler's scanner; type-only
  imports are ignored. Absolute, `file:`, `#`, `~`, nonliteral, and uninspected
  external-package imports make coverage incomplete.
- Node/Bun builtins, the Pi/OMP host APIs, and the host's TypeBox schema API are
  platform assumptions; their implementations are not inspected.
- Python imports must be known standard-library modules or actual local module
  paths. Shell external/dynamic sourcing and unsupported code languages are
  reported as incomplete.
- Checks do not execute code, resolve a full module graph, simulate search paths,
  or inspect programs merely launched by scripts. Static checks can conservatively
  reject valid code.

These are source-content comparisons, not a sandbox, a provenance attestation,
or proof of interchangeable runtime behavior or safety.


## Runtime usage behavior

### System prompt exposure

System prompt construction (`src/system-prompt.ts`) uses discovered skills as follows:

- if an active tool declares `readsSkillUris: true`:
  - include the discovered skills list, excluding hidden skills
  - mounted `xd://` tools count when their capability metadata is projected
- otherwise:
  - omit the discovered list

When no tool metadata is supplied, the prompt builder uses the presence of `read` as a compatibility fallback.

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
  - **Ctrl+Q / Ctrl+Enter** (default `app.message.followUp` bindings) → invokes the skill on the `followUp` queue while streaming, or as a normal idle prompt when the agent is not streaming

There is no flag, mode-selector, or frontmatter knob to override delivery mode — the keybinding _is_ the choice, identical to free-text routing during streaming. Both submission paths dispatch through `#invokeSkillCommand` in `input-controller.ts`, which delegates to `invokeSkillCommandFromText` in `src/modes/skill-command.ts`.

Invoked skill content is identified by invocation kind, each with its own prompt template (in `src/prompts/skills/`, rendered by `buildSkillPromptMessage` in `src/extensibility/skills.ts`):

- **User-invoked** (`user-invocation.md`, used by `/skill:<name>`): the message opens by announcing that the user invoked the skill, embeds the skill body, and appends the skill directory (`[Skill directory: <baseDir>]`) with instructions to resolve the skill's relative paths (scripts, templates) against it, plus optional `User: <args>`.
- **Autoloaded** (`autoload.md`): a minimal provenance-only format — body followed by `Skill: <path>` and optional `User: <args>` — used when subagents auto-inject skills declared via the `autoloadSkills` agent frontmatter field; these hidden messages must not claim the user invoked them.

## `skill://` URL behavior

`src/internal-urls/skill-protocol.ts` supports:

- `skill://<name>` → resolves to that skill's `SKILL.md` for `read`; in `bash` it is the skill directory (instructions at `skill://<name>/SKILL.md`), and `realpath`/`readlink` print the physical path
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
- resolved path must remain lexically within `baseDir`
- Agent Plugins and Skillshare skills also realpath-check containment within their package root, preventing symlink escapes; symlinks to another location inside that package are allowed
- directories return directory listings
- missing files return an explicit `File not found` error

Content type:

- Markdown paths => `text/markdown`
- `.json` => `application/json`
- other files => `text/plain`

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
- On a name collision, the higher-precedence skill keeps the bare name; identical copies collapse, and differing copies remain reachable under a namespace.
