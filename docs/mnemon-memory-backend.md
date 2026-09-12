# Mnemon memory backend

Oh My Pi can use the native [Mnemon](https://github.com/mnemon-dev/mnemon) CLI as a long-term memory backend.

```yaml
memory:
  backend: mnemon
mnemon:
  autoRecall: true
  recallLimit: 3
```

This is **not** Mnemopi. It talks to `~/.mnemon` through `mnemon` on PATH. Homebrew 0.2.0 is enough for recall/retain/link/related/forget. Do **not** set `mnemopi.dbPath` to that database — the schemas differ and can corrupt the store.

## Why switch from Mnemopi

| | Mnemopi | Mnemon |
|---|---|---|
| Store | Separate SQLite under the agent dir | The `~/.mnemon` graph already used by Claude, Codex, OpenClaw, Pi |
| First-turn recall | Up to 8 hits / ~5000 tokens | High-score only, 3×320 clips |
| Writes | Auto-retain every N turns + sleep/extract | Auto-retain raw transcript tails every N turns + LLM-supervised `retain` / `mnemon_remember` |
| Graph | Optional episodic linking | Typed causal/semantic/temporal/entity/**supersedes** |
| `/memory clear` | Deletes bank files | Refused |

Recalled rows are background leads, not instructions.

## Agent tools

- `recall` — native hybrid recall; optional `limit` (default 10)
- `retain` — `mnemon remember`; optional `category` / `importance` / `entities`; receipt includes id and candidates
- `link` — typed edge, including `supersedes`
- `related` — graph neighbors of an id
- `forget` — soft-delete one id (`approval = write`)
- `learn` — same write path when `autolearn.enabled` is on

`reflect` and `memory_edit` stay Mnemopi/Hindsight-only. `read memory://<id>` is not supported; use `recall` / `related` ids.



## Settings

| Setting | Default | Description |
|---|---|---|
| `memory.backend` | `off` | Set to `mnemon` |
| `mnemon.cliPath` | PATH | Optional absolute `mnemon` binary |
| `mnemon.autoRecall` | `true` | First-turn silent high-only recall |
| `mnemon.recallLimit` | `3` | Silent clip cap |
| `mnemon.autoRetain` | `true` | Retain completed conversation turns after agent turns |
| `mnemon.retainEveryNTurns` | `4` | Minimum user turns between automatic retain writes |

## Operations

- Auto-retain stores the unretained transcript tail as one `context` insight (`--cat context --imp 2 --source agent --no-diff`) after each agent turn, no more often than `mnemon.retainEveryNTurns` user turns. It is a raw transcript record, not an LLM distillation — the model's explicit `retain`/`learn` writes remain the curated layer.
- `/memory stats` and `/memory diagnose` report native insight/edge counts and the resolved CLI path.
- `/memory enqueue` forces retention of the current transcript tail regardless of the turn cadence.
- `/memory clear` throws. Use `forget` or `mnemon gc`.
- Subagents do not auto-recall or auto-retain. `recall` / `retain` / `link` / `related` / `forget` still work via the CLI.

Requires `mnemon` on PATH. Homebrew 0.2.0 is enough for recall/retain/link/related/forget. `link type=supersedes` falls back to `causal` until the CLI admits the fifth type ([mnemon-dev/mnemon#98](https://github.com/mnemon-dev/mnemon/pull/98)).

