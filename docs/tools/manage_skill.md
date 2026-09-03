# manage_skill

> Create, update, or delete an isolated managed skill.

## Source
- Entry: `packages/coding-agent/src/tools/manage-skill.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/manage-skill.md`
- Managed-skill helper: `packages/coding-agent/src/autolearn/managed-skills.ts`
- Skill discovery: `packages/coding-agent/src/extensibility/skills.ts`

## Registration / Visibility
- Tool metadata: `approval = "write"`, `strict = true`, `loadMode = "essential"`. It stays top-level rather than mounting under `xd://`.
- Registration requires `autolearn.enabled = true` (default `false`) but is independent of `memory.backend`.
- Enabled top-level sessions auto-include it in an ordinary explicit tool list. Subagents do not discover or auto-receive it, but may use it when their requested-tools/frontmatter list explicitly includes it.
- Execution is single-shot and emits no progress updates.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `action` | `"create" \| "update" \| "delete"` | Yes | Managed-skill mutation. |
| `name` | `string` | Yes | Kebab-case managed skill name. |
| `description` | `string` | Create/update | One-line description used for skill discovery. |
| `body` | `string` | Create/update | Markdown body for `SKILL.md`; do not include frontmatter. |

## Outputs
- `delete`: `content[0].text = "Deleted managed skill \"<name>\"."`, `details = { action: "delete", name }`
- `create`: `content[0].text = "Created managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`, `details = { action: "create", name }`
- `update`: `content[0].text = "Updated managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`, `details = { action: "update", name }`
- Authored-skill shadowing on create returns `isError: true` with `details = { action: "create", name, shadowed: true }`.

## Flow
1. `ManageSkillTool.createIf(...)` exposes the tool only when `autolearn.enabled` is true and captures the session's optional `refreshSkills` callback.
2. Schema validation requires both `description` and `body` for `create` / `update`; `delete` needs only `name`.
3. `delete` calls `deleteManagedSkill(name)`, then refreshes active skills when the callback exists.
4. `create` normalizes the name and checks whether an active authored skill already owns it; if yes, it returns an error result without writing.
5. `create` / `update` call `writeManagedSkill(...)`, which normalizes/validates the name, sanitizes generated frontmatter, serializes same-name in-process writes, and writes `SKILL.md` under the managed-skills root.
6. After a successful create/update, the tool refreshes active skills when the callback exists, so an interactive session can discover the change immediately.

## Modes / Variants
- `create`: atomically creates `SKILL.md` with exclusive-create semantics; fails if it already exists.
- `update`: overwrites an existing regular, single-link managed `SKILL.md`; fails if it does not exist.
- `delete`: recursively removes an existing managed skill directory; fails if it does not exist.
- Mutations of the same normalized name are serialized in-process in submission order; different names may proceed in parallel. Cross-process races are not serialized.

## Side Effects
- Filesystem: writes or deletes `<agent-dir>/managed-skills/<name>/SKILL.md`; the default agent directory is `~/.omp/agent`.
- Network: none.
- Session state: reads `autolearn.enabled` during tool creation and refreshes the active skill list after a successful mutation when `refreshSkills` is available.
- Background work: none.

## Limits & Caps
- Availability requires `autolearn.enabled = true`.
- Names are trimmed and lowercased, then must match `[a-z0-9][a-z0-9-]{0,63}`.
- Descriptions are sanitized to one line and stripped of control/format characters, angle brackets, backticks, and repeated tildes.
- Bodies are trimmed and must remain non-empty; generated frontmatter contains only normalized `name` and sanitized `description`.
- Final managed `SKILL.md` content is capped at `64_000` UTF-8 bytes, including frontmatter and description.
- The managed-skills root, skill directory, and file are checked to prevent symlink escapes; update also rejects non-regular or multiply hard-linked files.

## Errors
- Invalid names throw `Invalid skill name "<raw>"...`.
- Create/update without both `description` and `body` is rejected by schema validation; the execute-time defensive error is `"<action>" requires both "description" and "body".`
- Empty sanitized descriptions throw `Managed skill "<name>" needs a non-empty description.`
- Empty trimmed bodies throw `Managed skill "<name>" needs a non-empty body.`
- Oversized final files throw `Managed skill is <bytes> bytes; the limit is 64000.`
- `create` on an existing managed file and `update`/`delete` on a missing target throw action-specific helper errors.
- Authored-name shadowing on `create` is a normal tool result with `isError: true` and `details.shadowed = true`; no file is written.
- Unsafe roots, symlinked directories/files, non-regular files, and multiply hard-linked update files throw safety errors.

## Notes
- Managed skills are generated under `<agent-dir>/managed-skills` and never edit authored skills.
- Do not include YAML frontmatter in `body`; `writeManagedSkill(...)` generates normalized `name` and sanitized `description` frontmatter.
- `update` does not bypass authored-skill precedence: if an authored skill has the same name, the managed skill remains shadowed in discovery.
