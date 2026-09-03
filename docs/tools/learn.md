# learn

> Capture a reusable lesson into long-term memory and optionally create or update a managed skill.

## Source
- Entry: `packages/coding-agent/src/tools/learn.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/learn.md`
- Managed-skill helper: `packages/coding-agent/src/autolearn/managed-skills.ts`
- Local memory backend: `packages/coding-agent/src/memory-backend/local-backend.ts`
- Local lesson persistence: `packages/coding-agent/src/memories/index.ts` (`saveLearnedLesson(...)`)

## Registration / Visibility
- `loadMode = "essential"` and `strict = true`, so the tool remains top-level rather than mounting under `xd://`.
- Approval is dynamic: a call containing `skill`, or any call while `memory.backend = "local"`, has `approval = "write"`; a memory-only Hindsight/Mnemopi call has `approval = "read"`.
- Registration requires `autolearn.enabled = true` (default `false`) and `memory.backend` equal to `"hindsight"`, `"mnemopi"`, or `"local"`.
- Enabled top-level sessions auto-include `learn` in an ordinary explicit tool list. Subagents do not discover or auto-receive it, but may use it when their requested-tools/frontmatter list explicitly includes it.
- Execution is single-shot and emits no progress updates.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `memory` | `string` | Yes | Durable, self-contained lesson to remember: what, when, and why. The schema has no minimum length; backend-specific sanitization/storage determines whether an empty value succeeds. |
| `context` | `string` | No | Source context for the lesson. |
| `skill` | `{ action: "create" \| "update"; name: string; description: string; body: string }` | No | Managed skill to create or enhance after the lesson succeeds. `body` is Markdown without frontmatter. |

## Outputs
- Lesson only:
  - `content[0].text = "Lesson stored."` or `"Lesson queued for retention."`
  - `details = { skill: null }`
- Lesson plus skill:
  - `content[0].text = "<lesson result>. Created managed skill \"<name>\"."` or `"... Updated ..."`
  - `details = { skill: "<name>" }`
- Authored-skill name conflict returns `isError: true` after storing/queueing the lesson and reports `details = { skill: null, shadowed: true }`.

## Flow
1. `LearnTool.createIf(...)` exposes the tool only when `autolearn.enabled` is true and `memory.backend` is `"hindsight"`, `"mnemopi"`, or `"local"`.
2. `execute(...)` stores the lesson before attempting any skill mutation:
   - Mnemopi: calls `rememberScoped(...)` with `source: "coding-agent-learn"`, `importance: 0.8`, `scope: "bank"`, extraction enabled, `veracity: "tool"`, `memoryType: "fact"`, and session/cwd/context metadata; an absent returned id is treated as failure.
   - Local backend: calls `localBackend.save(...)`, which normalizes and writes a project-scoped `learned.md`; `stored === 0` is treated as failure.
   - Hindsight: enqueues retention with `state.enqueueRetain(memory, context)` and reports the lesson as queued.
3. If `skill` is absent, the tool returns after the memory write/queue.
4. If `skill.action == "create"`, the tool checks the lowercased/validated name against active authored skills. A conflict returns an error result after the lesson has already been stored or queued.
5. Otherwise, it calls `writeManagedSkill(...)`. Skill-write failure is rethrown as a partial outcome because lesson persistence already happened.
6. Unlike `manage_skill`, `learn` does not call the session's `refreshSkills` callback after writing. The managed skill is discovered on a later skill refresh/session.

## Modes / Variants
- Memory-only lesson capture.
- Lesson plus managed skill create/update for repeatable procedures worth codifying as `SKILL.md`.
- Backend-specific persistence: queued Hindsight, scoped Mnemopi SQLite, or project-scoped local `learned.md`.
- `create` fails if the managed skill file exists; `update` fails if it does not. Same-name in-process mutations are serialized.

## Side Effects
- Filesystem:
  - Local backend writes `<agent-dir>/memories/<encoded-cwd>/learned.md`.
  - Managed skills write `<agent-dir>/managed-skills/<sanitized-name>/SKILL.md`; the default agent directory is `~/.omp/agent`.
  - Mnemopi writes its scoped SQLite database.
- Network: Hindsight queue flushes to the configured server later. Mnemopi can schedule configured embedding/fact-extraction provider work after the synchronous row write; local file-backed storage itself is offline.
- Session state: reads backend state, settings, cwd, and session id. A skill created here is not immediately injected into the active skill list.
- Background work: Hindsight retention and Mnemopi extraction/embedding can continue after the tool result.

## Limits & Caps
- Availability requires `autolearn.enabled` plus a supported memory backend; both settings default to disabled/off.
- Managed skill names are trimmed and lowercased, then must match `[a-z0-9][a-z0-9-]{0,63}`.
- Managed descriptions are collapsed to one line and stripped of control/format characters, angle brackets, backticks, and repeated tildes.
- Final managed `SKILL.md` content, including generated frontmatter and description, is capped at `64_000` UTF-8 bytes.
- Managed skills never override authored skills; authored names win discovery.
- Local lessons are newest-first and deduplicated by normalized rendered line, with at most 100 lesson bullets. Lesson content is capped at 2,000 characters and context at 400 after prompt-injection neutralization and secret redaction.

## Errors
- `Mnemopi backend is not initialised for this session.` when Mnemopi state is missing.
- `Mnemopi did not store the lesson (no memory id returned).` when the local Mnemopi write returns no id; the optional skill is not attempted.
- `Lesson was empty after sanitization; nothing stored.` when local-backend normalization yields no lesson; the optional skill is not attempted.
- `Hindsight backend is not initialised for this session.` when Hindsight state is missing.
- Authored-name conflict on `skill.action = "create"` returns `isError: true`, `details = { skill: null, shadowed: true }`, after the lesson succeeds.
- Managed-skill validation, create/update, safety, or size failures throw `<lesson result>, but the managed skill could not be written: <reason>` after the lesson succeeds.

## Notes
- Use this tool sparingly. One precise reusable lesson is better than several vague memories.
- Put `skill` only on repeatable procedures; ordinary facts should remain memory-only.
- Managed skill frontmatter is generated from the normalized name and sanitized description; `body` must not include frontmatter.
- Managed skills are isolated from authored skills. `learn` writes them for a later discovery refresh; use `manage_skill` when the active session must refresh immediately after a mutation.
