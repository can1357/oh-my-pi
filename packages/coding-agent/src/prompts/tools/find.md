Semantic grep: describe what you are looking for in plain language; returns the files and line ranges that implement it, each with a calibrated 0–1 relevance score. No index; searches the live workspace tree on every call, or the embedded harness docs when `path` is an `omp://` URL.

<instruction>
- `query`: a concept or behavior ("where do we verify JWT tokens?", "retry budget for failed requests"), not a regex.
- `grep_keywords`: identifiers, symbols, or terms likely to appear verbatim in matching source; they steer the lexical pre-ranking. Pass `[]` when nothing specific comes to mind. Quoted phrases in `query` are also matched whole.
- `path`: one directory to search, or an `omp://` docs scope (`omp://` for all harness docs, `omp://<file>.md` for one); omit for the workspace root. Narrow it when you already know the subsystem — fewer files to rank means cheaper, sharper results. No `:start-end` selectors — `find` judges whole files.
- Results are strongest first as `path:start-end score snippet` (paths relative to the workspace, or `omp://` URLs for docs scopes); open ranges with `read` (`read` resolves `omp://` hits, including `:start-end` selectors).
- Scores are absolute yes/no probabilities: comparable across calls; below ~0.4 is weak evidence, so widen the query or fall back to `grep` before concluding absence.
</instruction>

<critical>
- MUST be the first call when you do not already know where a behavior lives: one `find` replaces a chain of guessed `grep` patterns and `glob` sweeps followed by speculative reads. NEVER grep/glob blindly for a concept you can describe.
- `grep` is for exact strings, regexes, and known symbols; `glob` is for file names. Reach for them after `find` has narrowed the files, or when the target is literally a string.
- Every call spends judge requests over the whole workspace; batch related questions into one descriptive `query` instead of many narrow calls.
</critical>
