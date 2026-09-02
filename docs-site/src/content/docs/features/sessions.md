---
title: Sessions
description: How omp stores sessions and how to resume, fork, branch, share, export, and hand off work between them.
coverage: B
---

Every conversation you have with omp is a session: an append-only log stored on disk that you can resume later, fork into a copy, branch within, export, or share. Sessions are scoped to the project directory they were started in, so returning to a project brings its history back with it.

## Where sessions are stored

Sessions live under `~/.omp/agent/sessions/`, in one directory per project:

```text
~/.omp/agent/sessions/<dir-encoded>/<timestamp>_<sessionId>.jsonl
```

Each session is a single JSONL file: a header line (session id, timestamp, working directory, optional title) followed by one JSON object per entry — messages, model changes, compaction summaries, labels, and so on. Entries are append-only; history is never rewritten in place.

Starting omp with `--no-session` runs an in-memory session instead: nothing is written to disk, and resume/fork operations are unavailable (export and dump still work — see the sharp edges below).

## Resuming and continuing

The fastest way back into previous work is `--continue`, which reopens the session you last used in this terminal:

```bash
omp --continue
```

`--continue` first checks a terminal-scoped breadcrumb (which session this terminal was last attached to) and falls back to the most recently modified session for the current directory. If neither exists, a new session is created. There is no interactive `/continue` command — it is a startup flag only.

Other resume paths:

| Command | Behavior |
| --- | --- |
| `omp --resume` | Opens an interactive picker of this project's sessions. If the project has none, the picker opens directly in all-projects scope. |
| `omp --resume <id\|path>` | Resumes a specific session by id prefix, filename prefix, or path, without a picker. |
| `/resume` | Same picker, from inside a running session. |
| `omp --continue` | Reopens the terminal's last session (see above). |

In the picker:

- Arrow keys navigate, `Enter` selects, `Esc` cancels, `Delete` deletes a session after confirmation.
- `Tab` toggles between current-folder and all-projects scope.
- Typing runs a fuzzy search across session id, title, directory, and message text.

Cross-project resumes: if the session you pick belongs to a different project, omp switches into that project's directory. With `--resume <id>`, a match in another project prompts instead: if the session's recorded directory no longer exists (moved or renamed), omp offers to re-root it into the current directory (`[Y/n]`); otherwise it offers to fork a copy into the current project (`[y/N]`). Declining cancels the resume.

## Starting over: `/new`, `/drop`, `/fresh`

Three different ways to get a clean slate, in increasing order of preservation:

- `/fresh` keeps the visible conversation but resets the provider-side stream state — use it to recover from a wedged provider session (stale prompt cache, mid-turn glitch) while losing nothing you can see. It is rejected while the agent is streaming.
- `/new` starts a brand-new empty session.
- `/drop` deletes the current session and starts a new one.

## Forking and branching

### Fork: a new session file

`/fork` creates a new session that starts as an exact copy of the current one and switches you into it. The new file records the previous session as its parent; the original is untouched. Use it to explore an alternative direction without disturbing the main line. `/fork` is rejected while the agent is streaming.

`omp --fork <id|path>` does the same at startup: it resolves the source session (same matching rules as `--resume`), copies it into the current project, and starts there.

### `/tree` and `/branch`: navigating inside a session

A session is internally a tree: rewinding to an earlier point and continuing creates a branch rather than erasing the abandoned path.

- `/tree` opens an interactive view of the session tree and moves the conversation pointer to the entry you select. Selecting a user message prefills its text into the editor so you can rephrase it. The abandoned path stays in the file and can be summarized into a branch summary that travels with the new direction (when `branchSummary.enabled` is on; see [Compaction](/oh-my-pi/features/compaction/)).
- `/branch` creates a new session file that forks the history at a user message you pick, with the selected text prefilled for editing.

Both open selectors; `/branch` restricts the choice to user messages.

## Handoff

`/handoff [focus instructions]` ends the current session and starts a fresh one whose context is a generated handoff document instead of the full transcript. The original session keeps its transcript unchanged; the new session records it as its parent.

Details:

- Requires at least two messages in the session (`Nothing to hand off` otherwise) and is refused while a response is streaming.
- While the document is generated, a cancellable loader is shown (`esc to cancel`).
- On success the new session opens with the handoff document as its starting context; the chat reports `New session started with handoff context`.
- Optional focus instructions steer what the handoff emphasizes: `/handoff focus on the migration plan`.

## Export, dump, and share

### `/export [path]` and `--export`

`/export` writes the current session as a self-contained HTML file and opens it in the browser. The HTML includes the full conversation, tool-call rendering, and any subagent transcripts as navigable overlays.

```bash
# From inside a session
/export review.html

# Directly from the shell, without starting a session
omp --export ~/.omp/agent/sessions/<dir-encoded>/<file>.jsonl review.html
```

The CLI form prints `Exported to: ...` and exits; it never starts an interactive session.

### `/dump`

`/dump` copies a plain-text rendering of the session to the clipboard — system prompt, active model, tool definitions, messages, thinking blocks, and tool calls included. Use it when you want the conversation as text rather than a page.

### `/share`

`/share` publishes an end-to-end encrypted snapshot of the session and prints a viewer link. The snapshot is encrypted locally with a fresh AES-256-GCM key; the key travels only in the URL fragment (`#...`) and is never sent to any server, so the host stores only ciphertext.

By default the encrypted blob is uploaded to the share server (`https://my.omp.sh/s`). If you have `gh` installed and authenticated, `share.store: "gist"` stores the blob as a secret gist instead, falling back to the share server when `gh` is unusable. When `share.redactSecrets` is enabled (the default) and secrets are configured, configured secrets in the snapshot are replaced with placeholders before encryption. Unlike `/export`, `/share` also works in `--no-session` mode.

:::caution
If a custom share script exists in `~/.omp/agent` (`share.ts`, `share.js`, or `share.mjs`), it takes over `/share` entirely: the session is written to a temporary HTML file and handed to your script. If that script fails to load or throws, the command errors out — it does **not** fall back to the encrypted default flow.
:::

## Sharp edges

- `--resume <id>` matching accepts case-insensitive id prefixes, filename prefixes, and the id suffix after the timestamp. The first match by recency wins; there is no ambiguity prompt if several sessions share a prefix.
- `/export` splits its argument on whitespace, so quoted paths containing spaces are not preserved.
- In `--no-session` mode, `/export` fails (`Cannot export in-memory session to HTML`) and `/fork` fails because there is no session file to copy; `/dump` and `/share` still work.
- Sessions that never produced an assistant response are not persisted to disk.
- Very large message content is truncated at 500,000 characters when persisted (with a `[Session persistence truncated large content]` notice), and inline images are moved to a blob store under `~/.omp/agent/blobs/` and re-inlined on load.
