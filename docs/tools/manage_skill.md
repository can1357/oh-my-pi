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

| Field         | Type                               | Required | Description                                                                                                                                                                                                                      |
| ------------- | ---------------------------------- | -------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`      | `"create" \| "update" \| "delete"` |      Yes | Managed-skill mutation.                                                                                                                                                                                                          |
| `name`        | `string`                           |      Yes | Managed skill name; trimmed and lowercased before path resolution, then validated against `[a-z0-9][a-z0-9-]{0,63}`.                                                                                                             |
| `description` | `string`                           |   Create | One-line description used for skill discovery. `update` needs `description`, `body`, or both; an omitted field keeps its stored value.                                                                                           |
| `body`        | `string`                           |   Create | Markdown body for `SKILL.md`; replaces the whole stored body. Do not include frontmatter: leading YAML-mapping frontmatter blocks are stripped, and a stripped block's `description` is used only when `description` is omitted. |

## Outputs

- `delete`: `content[0].text = "Deleted managed skill \"<name>\"."`, `details = { action: "delete", name }`
- `create`: `content[0].text = "Created managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`, `details = { action: "create", name }`
- `update`: `content[0].text = "Updated managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`, `details = { action: "update", name }`
- Result names echo the supplied `name`; create/update paths use its normalized on-disk spelling.
- Authored-skill shadowing on create returns `isError: true` with `details = { action: "create", name, shadowed: true }`.

## Flow

1. `ManageSkillTool.createIf(...)` exposes the tool only when `autolearn.enabled` is true and keeps the tool session (its optional `refreshSkills` callback, session id, and cwd for provenance).
2. Schema validation requires both `description` and `body` for `create`, and at least one of them for `update`; `delete` needs only `name`.
3. `delete` calls `deleteManagedSkill(name)`, then refreshes active skills when the callback exists.
4. `create` normalizes the name and checks whether an active authored skill already owns it; if yes, it returns an error result without writing.
5. `create` / `update` call `writeManagedSkill(...)`, which normalizes/validates the name, strips leading frontmatter blocks from `body`, fills fields an `update` left out from the stored `SKILL.md`, sanitizes generated frontmatter, stamps provenance (see Notes), serializes same-name in-process writes, and writes `SKILL.md` under the managed-skills root.
6. After a successful create/update, the tool refreshes active skills when the callback exists, so an interactive session can discover the change immediately.
   A refresh failure propagates after the filesystem mutation; it does not roll the skill back.

## Modes / Variants

- `create`: creates `SKILL.md` with exclusive-create (`wx`) semantics; fails if it already exists. Creation is exclusive, not a temp-file/rename transaction.
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
- Bodies are stripped of leading frontmatter blocks, trimmed, and must remain non-empty; generated frontmatter contains normalized `name`, sanitized `description`, and the `x-omp-provenance` block.
- Provenance keeps the 20 most recent contributing session ids and project directories.
- Final managed `SKILL.md` content is capped at `64_000` UTF-8 bytes, including frontmatter and description.
- The managed-skills root, skill directory, and file are checked to prevent symlink escapes; update also rejects non-regular or multiply hard-linked files.

## Errors

- Invalid names throw `Invalid skill name "<raw>"...`.
- Missing fields are rejected by schema validation (`create` without both `description` and `body`, `update` with neither). The execute-time defensive errors are `"create" requires both "description" and "body".` and `"update" requires "description", "body", or both.`
- Empty sanitized descriptions throw `Managed skill "<name>" needs a non-empty description.`
- Empty trimmed bodies throw `Managed skill "<name>" needs a non-empty body.`
- Oversized final files throw `Managed skill is <bytes> bytes; the limit is 64000.`
- `create` on an existing managed file and `update`/`delete` on a missing target throw action-specific helper errors.
- Authored-name shadowing on `create` is a normal tool result with `isError: true` and `details.shadowed = true`; no file is written.
- Unsafe roots, symlinked directories/files, non-regular files, and multiply hard-linked update files throw safety errors.

## Notes

- Managed skills are generated under `<agent-dir>/managed-skills` and never edit authored skills.
- Do not include YAML frontmatter in `body`; `writeManagedSkill(...)` generates normalized `name` and sanitized `description` frontmatter plus provenance. Leading `---` blocks that parse as a YAML mapping are stripped from `body` (a leading horizontal rule that is not a mapping stays). The explicit `name` and `description` win; the first stripped block carrying a `description` supplies a fallback when `description` is omitted, and on `update` that fallback replaces the stored description.
- Provenance frontmatter (`x-omp-provenance`, never rendered into the system prompt): `generator` (`manage_skill` or `learn`, the last writer), `created` (absent for skills written before provenance existed), `updated`, and `sessions` / `projects` — the contributing session ids and working directories, oldest first; a repeat contributor moves to the end. `update` carries the stored block forward.
- Users review managed skills and their provenance with `/skills learned` and delete one with `/skills forget <name>`.
- `update` does not bypass authored-skill precedence: if an authored skill has the same name, the managed skill remains shadowed in discovery.
