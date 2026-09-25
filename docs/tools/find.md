# find

> Semantic grep: describe what you are looking for and get back files and line ranges that implement it, each with a calibrated relevance score. Shown as `Find` in the UI.

## Source
- Entry: `packages/coding-agent/src/tools/jfind/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/find.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/jfind/cascade.ts` — the search strategy and its bounded-parallel request dispatcher
  - `packages/coding-agent/src/tools/jfind/keywords.ts` — query → lexical keywords (quoted phrases, stopword removal, cheap stemming)
  - `packages/coding-agent/src/tools/jfind/lexical.ts` — native grep keyword index, IDF weights, file scoring
  - `packages/coding-agent/src/tools/jfind/tree.ts` — eligible file listing (deny lists, credential filter) and the tagged tree rendering
  - `packages/coding-agent/src/tools/jfind/passages.ts` — byte-bounded windows, sketches, heat-range merging
  - `packages/coding-agent/src/tools/jfind/questions.ts` — the three judgment request shapes; question text in `packages/coding-agent/src/prompts/tools/find-*-question.md`
  - `packages/coding-agent/src/judgment/index.ts` — resolves the `judge` model role that answers every question
  - `packages/tui/src/tools/find.ts` — transcript renderer (score gauges, hyperlinked ranges, live phase progress) and the `FindToolDetails` type

It is a TypeScript port of the default (`cascade`) strategy of [jegrep](https://github.com/can1357/jegrep); request shapes, budgets, and ordering match the reference so benchmark results carry over.

## CLI
`omp find "<query>" [path] [-k keyword]... [--hidden] [--json] [-q]` runs the same cascade from the shell (`packages/coding-agent/src/cli/find-cli.ts`): the judge resolves from your settings' `judge` role, progress goes to stderr, and the ranked digest (or `--json` with hits and stats) to stdout. `path` takes the same host paths and internal URLs as the tool, and hits print relative to the shell cwd. Exits 1 when every judgment request failed.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Plain-language description of the behavior or concept to locate. Quoted phrases are matched whole in the lexical pass. Whitespace-only queries are rejected. |
| `grep_keywords` | `string[]` | Yes | Extra identifiers or terms for the lexical pre-ranking, in addition to those derived from `query`. `[]` when nothing specific comes to mind. |
| `path` | `string` | No | Directory or single file to search: a host path or an internal URL (`omp://` for all harness docs, `omp://<file>.md` for one doc, `skill://<name>`, `local://notes`). Paths resolve against the session cwd (`~` expanded, a bare `/` means the workspace root). Omitted or empty defaults to the cwd. A missing path is rejected. A trailing `:start-end` selector on a URL is rejected too — `find` judges whole files. |

Internal URLs are searched in place: the native listing and lexical scan and the file reads go through the session's URL filesystem (`InternalUrlFilesystem`, read tier), which is the same one the bash tool uses. Virtual documents need no local files, and file-backed schemes resolve to their host files. Hits under a URL scope are URLs (`omp://tools/read.md`). Open them directly with `read`, including with `:start-end` selectors (`read omp://tools/read.md:50-100`). Hidden files are excluded unless the file is named as the scope. Other hit paths are reported relative to the session cwd, not the searched directory, so `read` and hyperlinks resolve without knowing the scope.

`find.enabled` is `auto` by default: `find` is enabled only when the `judge` model role resolves first to a native System One model (TypeSafe `typesafe/jev-latest`, directly or through OpenRouter), not a prompted on-device or chat model. `on` enables it whichever model judges; `off` disables it. Once enabled it is an essential (top-level) tool, never mounted under `xd://`.

## Outputs
- Single text block, strongest hit first:
  - header `N hit(s) for "query" (τ 0.20), strongest first`
  - per hit: `path  score  N lines judged[, partial]`, then up to three `path:start-end  p  snippet` rows (strongest range first)
  - footer with `listed`, `judged`, files read and bytes sent, request count, input tokens, cost, and wall/API time
  - when requests failed: `E of R requests failed:` followed by up to five distinct phase-prefixed failure messages
- No hits: `no hits for "query" (τ 0.20)` plus the footer; the result is marked `useless`.
- Every request failed (for example no judge configured): the result is an error carrying the failure messages.
- When `path` narrows the search, the header reads `N hit(s) for "query" in <dir>/ …` and the renderer shows `in <dir>/`.
- `details`: `query`, `keywords` (lexical keywords used), `threshold`, `hits` (cwd-relative `rel`, `nameScore`, `contentScore`, merged `ranges` with `start`/`end`/`p`/`snippet`, `linesSeen`, `truncated`), `stats`, `elapsedMs`, `cwd` (hyperlink base), and `scopePath` (display form of `path`, absent when searching the cwd).
- Streaming: phase progress (`lexical scan`, `filename ranking 64/128`, `verifying 8 passages in 5 files`, …) is emitted through `onUpdate` and shown in the transcript header while the call runs.

## Flow
1. **Lexical scan.** `listFiles()` walks the root (gitignore-aware, no hidden files, no symlinks) and drops build output, lockfiles, binary extensions, and credential files. A file root is its only entry. `grepIndex()` runs one native grep for all keywords and counts per-keyword occurrences on matching lines. Both run concurrently. `idf()` weights rare keywords higher (clamped to `[0.5, 6]`); `fileScore()` ranks every file by weighted log-frequency plus a bonus for keywords in the path.
2. **Filename ranking.** The top 128 lexical candidates are judged by name in batches of 64: one noul per file over a prefix-folded tree listing (`# e017 name (size)`) and shared criteria.
3. **Passage scoring.** Twenty files are read (the two strongest lexical candidates unconditionally, the rest by name score then lexical rank): up to 4 MB each, cut into 8 KB whole-line windows tagged `L<n>| `, keeping the 24 best-scoring windows (spread evenly through the file when no keyword matches). Each window becomes a 384-byte sketch of its most keyword-dense verbatim lines; sketches are packed 46 per request across files and judged.
4. **Verification.** Sketches scoring ≥ 0.45 (at most 40) are verified as complete passages, grouped per file three to a request. Only verified passages produce ranges; positive ranges (≥ τ = 0.20) that touch or overlap are merged, keeping the max probability. A file is a hit when its best verified passage reaches τ.

Each judged phase drains through a dispatcher with 16 requests in flight before the next begins, so the critical path is three dependent waves.

## Side Effects
- Filesystem: reads up to 20 candidate files (4 MB each); never writes.
- Network: judgment requests through the session's judge role; usage is summarized in the result footer.
- Cancellation: the tool abort signal stops the native scan and in-flight judgments.

## Limits & Caps
- Candidates judged by name: 128; files read: 20; windows per file: 24; window size: 8 KB; sketch: 384 B; passages verified: 40; sketch cutoff 0.45; hit threshold 0.20 (`packages/coding-agent/src/tools/jfind/cascade.ts`).
- Native scan timeout: 30 s. Judge attempts time out per `TypeSafeJudge` (10 s, three attempts).
- Files over 4 MB are scanned by the lexical pass only up to the native grep cap and read only up to 4 MB (trimmed to the last full line).

## Errors
- `ToolError` for an empty `query`, a `path` that does not exist (`Path not found: …`) or is neither a file nor a directory, a URL `:start-end` selector, or a session without a model registry.
- Judge failures are not thrown: a failed request leaves its entries unjudged (filename and verification) or routes them onward as unknown (sketch scoring, so an outage never prunes). Failures are listed in the footer; the result becomes an error only when every request failed.

## Notes
- Scores are absolute yes/no probabilities from the judge, so they are comparable across calls and batches.
- Keyword extraction lowercases, drops tokens shorter than three bytes, stopwords, and pure numbers, and stems `-ing`/`-ed`/`-es`/`-s` when the stem keeps at least four characters.
- Directory folders are never judged; the tree shown to the judge is structure only, which is why the filename batch carries `criteria.folder` for parity with the reference request shape.
