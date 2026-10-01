# Tutorials

`/tutorial` runs short, vimtutor-style lessons inside a real omp session. Each lesson copies a demo project into a throwaway git repo, opens a fresh session there, and pins a lesson card above the composer. You type real prompts on your default model; after every turn omp checks the current step against what actually happened and advances.

```
/tutorial                 list lessons (✓ = completed, in-progress lessons show their step)
/tutorial <id>            start or resume a lesson (tab-completes ids)
/tutorial hint            hint for the current step
/tutorial skip            mark the current step done and advance
/tutorial exit            leave the lesson and resume the session you came from
omp tutorial [<id>]       same, from the shell
```

Lessons: `basics` (read selectors, hashline edit, undo with git), `btw` (side questions while a turn runs), `jevify` (bulk judgment over a 40-file commit), `ttsr` (stream rules). Lessons whose required tools are disabled are greyed out in the list.

## Where things live

- Sandboxes: `~/.omp/tutorials/<id>-<timestamp>/`. Your projects are never touched; delete old sandboxes freely.
- Progress: `~/.omp/agent/tutorials.json`.
- The tutorial session is an ordinary session in the sandbox directory, tagged with the session it parked, so `/tutorial exit` switches back to it exactly (or starts a new session in the original directory if that session no longer exists).

## Writing a lesson

A lesson is data in `packages/coding-agent/src/tutorials/<id>/`:

- `lesson.md` — YAML frontmatter (`id`, `title`, `minutes`, `requires` tool names, optional `history` of `{dir, message}` overlay commits, `steps`) and an intro body.
- `<stepId>.md` per step and `when.md` for the closing "when to reach for this" card. All text is Handlebars; `{{dir}}` is the sandbox path.
- `fixture/` — committed as the initial commit; `commits/<name>/` overlays are committed in `history` order.

Register the markdown files in `src/tutorials/catalog.ts`. Fixture trees are read from disk in source checkouts and embedded by `bun run gen:tutorials` for the npm bundle and compiled binary.

Each step has `hint`, `done` (one-line "what happened" note), and `check` — one check or a list that must all pass:

| check | passes when |
|---|---|
| `turn` | a turn finished since the step started |
| `keyword: <word>` | your message used that magic keyword |
| `tool: <name>` (+ `match: <regex>`) | that tool ran; `match` is tested against the JSON call arguments |
| `command: /<name>` | that slash command was used |
| `file: <path>` + `matches: <regex>` | the sandbox file matches after the turn |
| `reply: <regex>` | the assistant's final text matches |

Regexes are case-insensitive JavaScript regexes without the `m` flag, so `^(?![\s\S]*foo)` means "does not contain foo". Checks run after every finished turn and right after a slash command while idle; when a step passes, the next step's checks run immediately against the repo.
