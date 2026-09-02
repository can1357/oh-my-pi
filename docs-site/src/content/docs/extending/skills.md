---
title: Skills
description: File-backed capability packs the model can read on demand and users can invoke via /skill:<name>.
coverage: B
---

A skill is a folder with a `SKILL.md` file plus any supporting assets. omp discovers skills at startup and exposes them to the model as lightweight metadata (name and description in the system prompt) plus on-demand content through the `read` tool against `skill://...` URLs. When skill commands are enabled, every discovered skill is also available as a `/skill:<name>` slash command.

## Skill layout

Provider-based discovery expects one level of skill folders under a skills root:

```text
<root>/skills/
  ├─ postgres/
  │   └─ SKILL.md      ✅ discovered
  ├─ pdf/
  │   └─ SKILL.md      ✅ discovered
  └─ team/
      └─ internal/
          └─ SKILL.md  ❌ not discovered by provider loaders
```

Nested patterns like `<skills-root>/group/<skill>/SKILL.md` are not discovered by provider loaders. `skills.customDirectories` scanning uses the same non-recursive layout — to expose a deeper tree, point `customDirectories` at the nested parent directory.

## `SKILL.md` frontmatter

```md
---
name: pdf
description: Read, extract, and summarize PDF documents.
globs: ["**/*.pdf"]
alwaysApply: false
hide: false
disableModelInvocation: false
---
```

| Field | Default | Purpose |
| --- | --- | --- |
| `name` | Directory name | Skill identifier. Must be unique across all discovered sources. |
| `description` | — | Short summary shown to the model. **Required** for native `.omp`, omp-plugins extension packages, the `github` provider (`.github/skills/`), and any directory passed to `skills.customDirectories`. The claude/codex/agents/opencode/claude-plugins providers can load skills without one. |
| `globs` | — | File-glob hints that describe when the skill applies. |
| `alwaysApply` | `false` | Hint that this skill should be considered for every turn regardless of task. |
| `hide` | `false` | If `true`, the skill is hidden from the system-prompt list. It is still loaded and remains reachable through `skill://<name>` and `/skill:<name>` when skill commands are enabled. |
| `disableModelInvocation` | `false` | Agent Skills equivalent of `hide`. Also accepted as the kebab-case `disable-model-invocation` and normalized to the same field. |

Any additional frontmatter keys are preserved as unknown metadata.

## Discovery

omp runs three passes:

1. **Capability providers** — `native`, `omp-plugins` (skills bundled with installed extension packages), `claude`, `claude-plugins`, `agents`, `codex`, `opencode`, `github`, and `omp-managed`.
2. **Custom directories** listed in `skills.customDirectories`, scanned non-recursively.
3. **Managed (auto-learn) skills** under `~/.omp/agent/managed-skills`, resolved last so any same-named authored skill wins.

### Provider priorities

Provider ordering is priority-first; ties break by registration order:

| Priority | Provider | Source |
| --- | --- | --- |
| 100 | `native` | `.omp` user/project skills |
| 90 | `omp-plugins` | Skills bundled with extension packages loaded through `extensions:`, `--extension`/`-e`, or installed plugins |
| 80 | `claude` | Claude user skills |
| 70 | `claude-plugins`, `agents`, `codex` | Claude plugins, `.agent[s]/skills`, Codex skills |
| 55 | `opencode` | Opencode skills |
| 30 | `github` | `.github/skills/<name>/SKILL.md` (project-only) |
| 5 | `omp-managed` | Auto-learn skills — always defer to a same-named authored skill |

De-duplication is by skill name; the first occurrence (highest priority) wins. Identical files are additionally de-duplicated by `realpath`, and collision conflicts on the same name emit a warning.

### Filtering

`loadSkills()` applies these controls, in order:

1. Not disabled by `disabledExtensions` entries shaped like `skill:<name>`
2. Its source is enabled (`enableCodexUser`, `enableClaudeUser`, `enableClaudeProject`, `enablePiUser`, `enablePiProject`, `enableAgentsUser`, `enableAgentsProject`)
3. Not matched by `ignoredSkills` glob patterns
4. Matched by `includeSkills` glob patterns (empty `includeSkills` means include all)

The `agents` provider (`.agent[s]/skills`) has its own `enableAgentsUser` / `enableAgentsProject` toggles — disabling Claude, Codex, or Pi sources does not turn it off. Providers without a dedicated toggle (`claude-plugins`, `opencode`, `gemini`, `github`, and others) fall back to "enabled if any named source toggle is enabled".

Setting `skills.enabled: false` disables discovery entirely (returns no skills).

## `skill://` URLs

The internal `skill://` protocol lets the model and your extensions fetch a skill's content without knowing its on-disk path:

```text
skill://pdf
  → <pdf-base>/SKILL.md

skill://pdf/references/tables.md
  → <pdf-base>/references/tables.md
```

Resolution rules:

- Skill name must match exactly (case-sensitive).
- Relative paths are URL-decoded.
- Absolute paths are rejected.
- Path traversal (`..`) is rejected.
- The resolved path must remain inside the skill's `baseDir`.
- Missing files return an explicit `File not found` error.

There is no fallback search — only files inside the named skill's directory are reachable. The `read` tool's content type is `text/markdown` for `.md` and `text/plain` for everything else.

## Invoking skills from the prompt

If `skills.enableSkillCommands` is `true`, interactive mode registers one `/skill:<name>` slash command per discovered skill:

```text
/skill:pdf [args]
```

omp reads the skill file from its `filePath`, strips the frontmatter, and injects the body as a custom message. The delivery mode follows the keybinding used to submit:

- **Enter** — invokes the skill on the `steer` queue while the agent is streaming, or as a normal idle prompt when the agent is not streaming.
- **Ctrl-Enter** — invokes the skill on the `followUp` queue while the agent is streaming, or as a normal idle prompt when the agent is not streaming.

There is no flag or frontmatter knob that overrides this — the keybinding *is* the choice.

## Sharp edges

- **`hide: true` does not disable a skill.** Hidden skills are still loaded and reachable; they are only omitted from the system-prompt list.
- **Custom-directory scanning is non-recursive.** For deeper taxonomies, point `skills.customDirectories` at the nested parent directory.
- **No per-task skill pinning.** Task tool subagents inherit the session's discovered skills list at session creation time.
- **AGENTS.md and skills are different.** AGENTS.md files are persistent instruction files merged into context by level/depth rules; skills are optional capability packs selected by task context or explicitly requested.
- **Slash commands and custom tools are different.** Skills are passive content; commands are user-invoked entry points; custom tools are executable model-callable APIs with schemas and runtime side effects.

## Practical authoring tips

- Put each skill in its own directory: `<skills-root>/<skill-name>/SKILL.md`.
- Always include explicit `name` and `description` frontmatter — several providers reject skills without a description.
- Keep referenced assets (schemas, examples, reference docs) inside the skill's directory and link to them with `skill://<name>/...`.
- For nested taxonomies (`team/domain/skill`), point `skills.customDirectories` at the nested parent — provider loaders will not walk into it.
