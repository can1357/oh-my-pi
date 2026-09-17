# session-stats

Ad-hoc analyses over the local agent session corpus
(`~/.omp/agent/sessions/`). SQLite-backed; data is synced once into the same
`~/.omp/stats.db` that `packages/stats` uses, then queried by short Python
scripts.

## Layout

```
scripts/session-stats/
  sync.py          # walks ~/.omp/agent/sessions/ and populates ss_* tables
  analyze.py       # tools | edits | followups subcommands over the synced db
  audit.ts         # LLM-assisted token-usage audit (no sync needed)
  audit-prompt.md  # system prompt for the audit classifier
```

## One-time prep

```sh
pip install tiktoken
```

## Sync

```sh
bun run stats:sync                  # incremental
python3 scripts/session-stats/sync.py --workers 16 --full     # rebuild all
python3 scripts/session-stats/sync.py --limit 200             # newest 200 only
```

The sync is incremental: per-file `mtime`, `size`, `byte_offset`, and
`parser_version` are tracked in `ss_sessions`. Re-runs only parse new bytes
and only re-tokenize / re-classify what changed. A bump of `EDIT_PARSER_VERSION`
in `sync.py` invalidates `ss_edit_*` rows on next sync.

Tokenization is `o200k_base` (GPT-4o / GPT-5 family) via tiktoken — well
within ~5–10% of Claude's BPE in aggregate.

## Schema

All tables are prefixed `ss_` to avoid collision with `packages/stats`.

|Table|Granularity|
|---|---|
|`ss_sessions`|one row per `.jsonl`; carries sync state + session metadata|
|`ss_tool_calls`|one row per `toolCall` content block (`arg_json`, `arg_tokens`)|
|`ss_tool_results`|one row per `toolResult` message (`result_text`, `result_tokens`, `is_error`)|
|`ss_assistant_msgs`|per assistant message text + thinking blobs and token counts|
|`ss_user_msgs`|per user message text and token count|
|`ss_edit_calls`|per `edit` call: `success`, `warnings`, `raw_input_len`|
|`ss_edit_sections`|per `¶PATH` section in an edit; precomputed `longest_repeat_*`, `dup_anchors`. Legacy `§PATH` sections from pre-2026-05 sessions still parse.|

Indexes on `(tool_name, timestamp)` and `(session_file, seq)` make per-tool
aggregations and ordered session walks cheap.

## Analyses

```sh
bun run stats:tools                        # per-tool token totals
bun run stats:tools -- --by d --top 8      # bucket by day, top 8 tools each
bun run stats:edits                        # edit-tool reliability audit
bun run stats:edits -- --since w           # edit sub-types over the last week
bun run stats:followups                    # five hashline-edit detectors
bun run stats:followups -- --max-fix 2 --min-dup 8 --show 20
```

All three accept `-n N` / `--folder SUBSTR` to scope the query, plus
`--since <h|d|w|m|Nh|Nd|Nw>` to keep only calls newer than a time window
(per-call `timestamp`, so it slices long sessions precisely). The `edits`
audit reads each call's `is_error` flag as the authoritative success/failure
signal and decodes hashline op kinds (`replace`, `insert after`, `delete`,
`replace_block`, …) into the verb distribution.

## Usage audit (`audit.ts`)

Standalone Bun script — reads session JSONL directly (no `sync.py` / tiktoken
needed) and uses the *real* per-request usage recorded in each assistant
message (input/output/cacheRead/cacheWrite + nominal cost) instead of
re-tokenizing.

```sh
bun run stats:audit                          # last week, scan + LLM analysis
bun run stats:audit -- --no-llm              # scan-only report
bun run stats:audit -- --since 3d --folder Projects-pi
bun run stats:audit -- --min-cost 5 --max-llm 8 --json /tmp/audit.json
bun run stats:audit -- --digest-dir /tmp/digests   # inspect classifier inputs
bun run stats:audit -- --session parser            # classify sessions matching id/title (ignores --min-cost)
bun run stats:audit -- --no-cache                  # force fresh LLM verdicts
```

The scan phase reports the main-vs-subagent usage split, per-folder and
per-session cost, per-tool traffic (estimated arg/result tokens plus a
*context-residency* metric: result tokens × subsequent requests), repeated
reads of the same file, the largest single tool results, compactions, and
edit-failure churn.

The LLM phase (default `anthropic/claude-sonnet-4-6` via `@oh-my-pi/pi-ai`,
credentials resolved through omp's auth storage — stored key, OAuth, or env
var) classifies the costliest sessions: multi-topic sessions that should have
been split or handed off, task spawns that were wasteful or failed to transfer
context, and the biggest waste sources with concrete fixes. A final aggregate
call distills systemic findings and quick wins across sessions.

Verdicts are cached in `~/.omp/stats-audit-cache.json` (keyed by session id +
digest hash + model + prompt hash, so any change to the transcript, digest
format, or `audit-prompt.md` invalidates the entry automatically). Re-runs
reuse cached verdicts for free; `--no-cache` bypasses reads but still writes
fresh results.

The Rust crate that previously lived here was retired in favor of this
SQLite-backed flow. The schema persists everything the analyses used to
recompute on every run (token counts, hashline parse output, success flags),
so subsequent invocations are sub-second over the full corpus.
