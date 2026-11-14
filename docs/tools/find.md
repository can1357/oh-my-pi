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
   - `packages/coding-agent/src/tools/jfind/questions.ts` — the three judgment request shapes; question text in `packages/coding-agent/src/prompts/judge/find.json`
   - `packages/coding-agent/src/judgment/index.ts` — resolves the `judge` model role that answers every question
   - `packages/tui/src/tools/find.ts` — transcript renderer (score gauges, hyperlinked ranges, live phase progress) and the `FindToolDetails` type

The cascade follows the semantic-search strategy of [jegrep](https://github.com/can1357/jegrep): lexical pre-ranking, filename judgments, passage sketches, then full-passage verification.

## CLI

`omp find "<query>" [path] [-k keyword]... [--hidden] [--json] [-q]` runs the same cascade from the shell (`packages/coding-agent/src/cli/find-cli.ts`): progress goes to stderr and the ranked digest (or JSON with hits and stats) to stdout. A host-directory scope supplies the settings/extensions used to resolve the `judge` role; file/URL scopes use the caller's cwd. Hits are cwd-relative within the cwd, absolute outside it, or internal URLs. Exits 1 for an invalid query/root or when every judgment request failed.

## Inputs

| Field           | Type       | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`         | `string`   | Yes      | Plain-language description of the behavior or concept to locate. Quoted phrases are matched whole in the lexical pass. Whitespace-only queries are rejected.                                                                                                                                                                                                                                                              |
| `grep_keywords` | `string[]` | Yes      | Extra identifiers or terms for the lexical pre-ranking, in addition to those derived from `query`. `[]` when nothing specific comes to mind.                                                                                                                                                                                                                                                                              |
| `path`          | `string`   | No       | Directory or single file to search: a host path or an internal URL (`omp://` for all harness docs, `omp://<file>.md` for one doc, `skill://<name>`, `local://notes`). Paths resolve against the session cwd (`~` expanded, a bare `/` means the workspace root). Omitted or empty defaults to the cwd. A missing path is rejected. A trailing `:start-end` selector on a URL is rejected too — `find` judges whole files. |

Internal URLs are searched in place: the native listing and lexical scan and the file reads go through the session's URL filesystem (`InternalUrlFilesystem`, at the call's approval tier: `read`, or `exec` when `path` names `ssh://`, as for `grep`), which is the same one the bash tool uses. Virtual documents need no local files, and file-backed schemes resolve to their host files. Hits under a URL scope are URLs (`omp://tools/read.md`). Open them directly with `read`, including with `:start-end` selectors (`read omp://tools/read.md:50-100`). Hidden files are excluded unless the file is named as the scope. Host hit paths are cwd-relative within the session cwd and absolute outside it, not relative to the searched directory, so `read` and hyperlinks resolve without knowing the scope.

`find.enabled` is `auto` by default: `find` is enabled only when the `judge` model role resolves first to a native System One model (TypeSafe `typesafe/jev-1.14.0`, directly or through OpenRouter), not a prompted on-device or chat model. `on` enables it whichever model judges; `off` disables it. Once enabled it is an essential (top-level) tool, never mounted under `xd://`.

`find.hitThreshold` (a number above 0, up to 1; unset keeps `0.20`) sets τ, the verified-passage probability a file needs before it is reported as a hit, which is also the floor for the line ranges listed. It applies to the tool and to `omp find`. The default suits TypeSafe Jev. Decision models calibrate differently, and a judge whose probabilities run higher on unrelated passages needs a higher τ to keep the same precision.

Use `find` first when the implementing location is unknown. Use `grep` for known literals, regexes, or symbols, and `glob` for names. Scope a known subsystem and batch related questions. Scores below about `0.4` are weak evidence: widen the description or use `grep` before concluding absence. The tool has no hidden-file option; the CLI's `--hidden` is not a tool parameter.

## Outputs

- Single text block, strongest hit first:
   - header `N hit(s) for "query" (τ 0.20), strongest first`
   - per hit: `path  score  N lines judged[, partial]`, then up to three `path:start-end  p  snippet` rows (strongest range first)
   - footer with `listed`, `judged`, files read and bytes sent, request count (plus `N unanswered` when a successful response left questions without a usable answer), input tokens, cost, and wall/API time
   - when anything failed: `failures:` followed by up to five distinct phase-prefixed failure messages
- No hits: `no hits for "query" (τ 0.20)` plus the footer; the result is marked `useless`.
- Some judge requests failed: a `partial: F of R judge requests failed; unjudged files may still match` line follows the header.
- The 20 s budget ran out during verification after at least one hit was verified: the hits verified so far are returned, followed by ``partial: timed out after 20.0s with V of P passages verified; unverified files may still match. Narrow `path` for a complete search.``; `coverage` is `partial`, `details.timeout` holds `verified` and `passages`, and the renderer shows `timed out, V/P passages verified`.
- Every judge request failed (for example no judge configured, or the provider rejects the account): the header reads `find unavailable for "query": all R judge requests failed, nothing was judged. This is not evidence of absence; use grep.` and the result is an error. `omp find` prints the same status and exits 1.
- When `path` narrows the search, the header reads `N hit(s) for "query" in <dir>/ …` and the renderer shows `in <dir>/`.
- `details`: `query`, `keywords` (lexical keywords used), `threshold`, `hits` (`rel` as a readable host path or URL, `nameScore`, `contentScore`, merged `ranges` with `start`/`end`/`p`/`snippet`, `linesSeen`, `truncated`), `coverage` (`complete`, `partial`, or `unavailable`, from `stats.failed` vs `stats.requests`, and `partial` when the budget cut verification short; also in `omp find --json`), `stats` (`failed` counts failed judge requests, `unanswered` counts unusable answers), `timeout` (set when the budget cut verification short), `elapsedMs`, `cwd` (hyperlink base), and `scopePath` (display form of `path`, absent when searching the cwd).
- Streaming: phase progress (`lexical scan`, `filename ranking 64/128`, `verifying 8 passages in 5 files`, …) is emitted through `onUpdate` and shown in the transcript header while the call runs.

## Flow

1. **Lexical scan.** `listFiles()` walks the root (gitignore-aware, no hidden files) and drops build output, lockfiles, binary extensions, credential files, and empty files. Linked regular files use their target's size rather than being mistaken for empty files; dangling links are excluded. Explicit `skill://` scopes also descend contained directory links with cycle detection, preserving skill URLs; host scopes do not descend directory links. A named file bypasses hidden-file exclusion but still must pass the credential/binary/empty-file filter. `grepIndex()` runs one native grep for all keywords and counts per-keyword occurrences on matching lines. Both run concurrently. `idf()` weights rare keywords higher (clamped to `[0.5, 6]`); `fileScore()` ranks every file by weighted log-frequency plus a bonus for keywords in the path.
2. **Filename ranking.** The top 128 lexical candidates are judged by name in batches of 64: one noul per file over a prefix-folded tree listing (`# e017 name (size)`) and shared criteria.
3. **Passage scoring.** Twenty files are read (the two strongest lexical candidates unconditionally, the rest by name score then lexical rank): up to 4 MB each, cut into 8 KB whole-line windows tagged `L<n>| `, keeping the 24 best-scoring windows (spread evenly through the file when no keyword matches). Each window becomes a 384-byte sketch of its most keyword-dense verbatim lines; sketches are packed 46 per request across files and judged.
4. **Verification.** Sketches scoring ≥ 0.45 (at most 40) are verified as complete passages, grouped per file three to a request. Only verified passages produce ranges; positive ranges (≥ τ = 0.20) that touch or overlap are merged, keeping the max probability. A file is a hit when its best verified passage reaches τ.

Each judged phase drains through a dispatcher with 16 requests in flight before the next begins, so the critical path is three dependent waves.

`find.verifyModel` (unset by default) takes a model role value, for example `openrouter/liquid/d1-ultra` or `nace/drex-max-v1.1`. Only verification uses it; filename and sketch routing stay on `judge`. The selector resolves against the judge role's candidates and is tried first as an explicit candidate, then the `judge` chain without duplicates, under the same fallback rules: a native-only tail after the first native candidate, an attempt timeout while a configured fallback remains, and cooldowns. A selector matching nothing logs a warning and the plain `judge` chain verifies; empty or whitespace-only values are unset. Native decision models are recommended because τ assumes calibrated probabilities. Footer stats and coverage span both judges, while `find.enabled: auto` still gates on `judge` alone. `omp find` reads the setting from the same project settings as the judge role. A slower verifier makes the tool's 20 s partial timeout more likely.

## Side Effects

- Filesystem: reads up to 20 candidate files (4 MB each); never writes.
- Network: judgment requests through the session's judge role; usage is summarized in the result footer.
- Cancellation: the tool abort signal stops the native scan and in-flight judgments.

## Limits & Caps

- Candidates judged by name: 128; files read: 20; windows per file: 24; window size: 8 KB; sketch: 384 B; passages verified: 40; sketch cutoff 0.45; hit threshold 0.20, or `find.hitThreshold` (`packages/coding-agent/src/tools/jfind/cascade.ts`).
- Native lexical scan timeout: 30 s. Native judgments use `NativeJudge` (10 s per attempt, up to three attempts); the tool's 20 s wall budget can abort them earlier.
- Per-call wall-clock budget: `20_000ms` (`FIND_TIMEOUT_MS` in `packages/coding-agent/src/tools/jfind/index.ts`), so a stalled judge never blocks the turn. Running out during verification returns the hits verified so far, marked partial; running out earlier, or before any hit was verified, raises a timeout error. The `omp find` CLI is not bounded this way.
- Files over 4 MB are scanned by the lexical pass only up to the native grep cap and read only up to 4 MB (trimmed to the last full line).

## Errors

- `ToolError` for an empty `query`, a `path` that does not exist (`Path not found: …`) or is neither a file nor a directory, a URL `:start-end` selector, or a session without a model registry.
- Judge failures are not thrown: a failed request leaves its entries unjudged (filename and verification) or routes them onward as unknown (sketch scoring, so an outage never prunes). Failures are listed in the footer; the result becomes an error only when every request failed.
- ``find timed out after 20.0s at "<phase>", before any hit was verified. Narrow `path` to a smaller tree, or use grep.`` when the `FIND_TIMEOUT_MS` (20 s) wall-clock budget elapses with nothing verified; `<phase>` is the last progress message (`lexical scan`, `filename ranking 64/128`, …). A caller abort is rethrown as-is, not converted.

## Notes

- Scores are absolute yes/no probabilities from the judge, so they are comparable across calls and batches.
- Keyword extraction lowercases, drops tokens shorter than three bytes, stopwords, and pure numbers, and stems `-ing`/`-ed`/`-es`/`-s` when the stem keeps at least four characters.
- Directory folders are never judged; the tree shown to the judge is structure only, which is why the filename batch carries `criteria.folder` for parity with the reference request shape.
- The lexical scan lists the tree through native `glob()`, so below an ovnfs checkout the ovnfs daemon serving it answers the listing instead of a walk of its NFS mount (`crates/pi-walker/src/ovnfs.rs`), falling back to the native walk on any daemon failure.
