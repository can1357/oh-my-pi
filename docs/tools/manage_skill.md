# manage_skill

> Create, update, or delete an isolated managed skill.

## Source

- Entry: `packages/coding-agent/src/tools/manage-skill.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/manage-skill.md`
- Managed-skill helper: `packages/coding-agent/src/autolearn/managed-skills.ts`
- Skill discovery: `packages/coding-agent/src/extensibility/skills.ts`

## Registration / Visibility

- Tool metadata: `approval = "write"`, `strict = true`, `loadMode = "essential"`. It stays top-level rather than becoming a tool command.
- Registration requires `autolearn.enabled = true` (default `false`) but is independent of `memory.backend`.
- Enabled top-level sessions auto-include it in an ordinary explicit tool list. Subagents do not discover or auto-receive it, but may use it when their requested-tools/frontmatter list explicitly includes it.
- Execution is single-shot and emits no progress updates.

## Inputs

| Field         | Type                               |      Required | Description                                                                                                                                                                                                                   |
| ------------- | ---------------------------------- | ------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`      | `"create" \| "update" \| "delete"` |           Yes | Managed-skill mutation.                                                                                                                                                                                                       |
| `name`        | `string`                           |           Yes | Managed skill name; trimmed and lowercased before path resolution, then validated against `[a-z0-9][a-z0-9-]{0,63}`.                                                                                                          |
| `scope`       | `"project" \| "global"`            |            No | Selects the store for this call only. Without `scope`, `create` uses global; `update` and `delete` target the visible managed copy (project before global). A linked target causes an error, not a fallback to a hidden copy. |
| `description` | `string`                           | Create/update | One-line description used for skill discovery.                                                                                                                                                                                |
| `body`        | `string`                           | Create/update | Markdown body for `SKILL.md`; do not include frontmatter.                                                                                                                                                                     |

## Outputs

- `delete`: `content[0].text = "Deleted <scope> managed skill \"<name>\"."`, `details = { action: "delete", name, scope }`
- `create`: `content[0].text = "Created <scope> managed skill \"<name>\" (<path relative to agent dir>)."`, `details = { action: "create", name, scope }`
- `update`: `content[0].text = "Updated <scope> managed skill \"<name>\" (<path relative to agent dir>)."`, `details = { action: "update", name, scope }`
- Result names echo the supplied `name`; create/update paths use its normalized on-disk spelling, e.g. `managed-skills/<name>/SKILL.md` or `project-managed-skills/<project-key>/<name>/SKILL.md`.
- Authored-skill shadowing on create returns `isError: true` with `details = { action: "create", name, scope, shadowed: true }`.

## Flow

1. `ManageSkillTool.createIf(...)` exposes the tool only when `autolearn.enabled` is true and captures the session's optional `refreshSkills` callback.
2. Schema validation requires both `description` and `body` for `create` / `update`; `delete` needs only `name`.
3. `delete` removes the target from the selected store, then refreshes active skills when the callback exists.
4. `create` normalizes the name and checks whether an active authored skill already owns it; if yes, it returns an error result without writing.
5. `create` / `update` call `writeManagedSkill(...)` with the scope's store, which normalizes/validates the name, sanitizes generated frontmatter, serializes same-skill in-process writes, and writes `SKILL.md` under that managed root.
6. After a successful create/update, the tool refreshes active skills when the callback exists, so an interactive session can discover the change immediately.
   A refresh failure propagates after the filesystem mutation; it does not roll the skill back.

## Modes / Variants

- `create`: creates `SKILL.md` with exclusive-create (`wx`) semantics; fails if it already exists. Creation is exclusive, not a temp-file/rename transaction.
- `update`: overwrites an existing regular, single-link managed `SKILL.md`; fails if it does not exist.
- `delete`: recursively removes an existing managed skill directory; fails if it does not exist.
- Same-name mutations run in submission order within the process, including store selection. This does not serialize writes across processes.

## Side Effects

- Filesystem: writes or deletes `<agent-dir>/managed-skills/<name>/SKILL.md` (global) or `<agent-dir>/project-managed-skills/<project-key>/<name>/SKILL.md` (project); the default agent directory is `~/.omp/agent`. `<project-key>` is a readable path tail plus a SHA-256 prefix of the canonical project root. Neither store is inside the repository.
- Registered linked worktrees of a standard Git checkout share the primary checkout's store. An unregistered checkout uses its own store. Submodules and separate Git directories do not guarantee sharing. Outside a repository, the working directory identifies the project.
- Network: none.
- Session state: reads `autolearn.enabled` during tool creation and refreshes the active skill list after a successful mutation when `refreshSkills` is available.
- Background work: none.

## Limits & Caps

- Availability requires `autolearn.enabled = true`.
- Names are trimmed and lowercased, then must match `[a-z0-9][a-z0-9-]{0,63}`.
- Descriptions are sanitized to one line and stripped of control/format characters, angle brackets, backticks, and repeated tildes.
- Bodies are trimmed and must remain non-empty; generated frontmatter contains only normalized `name` and sanitized `description`.
- Final managed `SKILL.md` content is capped at `64_000` UTF-8 bytes, including frontmatter and description.
- Only the global store root may be a symlink to an existing directory. The project store root, its `project-managed-skills/` parent, skill directories, and skill files cannot be symlinks. Updates also reject non-regular or multiply hard-linked files.

## Errors

- Invalid names throw `Invalid skill name "<raw>"...`.
- Create/update without both `description` and `body` is rejected by schema validation; the execute-time defensive error is `"<action>" requires both "description" and "body".`
- Empty sanitized descriptions throw `Managed skill "<name>" needs a non-empty description.`
- Empty trimmed bodies throw `Managed skill "<name>" needs a non-empty body.`
- Oversized final files throw `Managed skill is <bytes> bytes; the limit is 64000.`
- `create` on an existing managed file and `update`/`delete` on a missing target throw action-specific helper errors that name the scope, e.g. `Managed skill "<name>" does not exist in the project scope.`
- Authored-name shadowing on `create` is a normal tool result with `isError: true` and `details.shadowed = true`; no file is written.
- Unsafe roots, symlinked directories/files, non-regular files, and multiply hard-linked update files throw safety errors.

## Notes

- A project-scoped managed skill wins over a same-named global one in its project; an authored skill wins over both.
- Do not include YAML frontmatter in `body`; `writeManagedSkill(...)` generates normalized `name` and sanitized `description` frontmatter.
- If an authored skill or a skill with a different directory name owns the visible name, unscoped edits fail. An explicit scope selects the managed copy directly.
- Unscoped edits use the calling session's discovery rules. `ignoredSkills` excludes a skill from those edits; `manualSkills` only hides it from the prompt.
