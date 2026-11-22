Search files three ways; the arguments you pass pick the mode, and modes do not mix.

- `pattern` (regex over contents; Rust, then PCRE2): exact and complete. Optional `glob` limits which files are searched; `case` (default true = case-sensitive), `gitignore` (default true), `skip` pages by file. Literal `\n` enables cross-line. A file-only selector `src/foo.ts:50-100` limits to those lines. Several terms: one alternation `a|b|c`, not several calls.
- `glob` alone, or `path` alone (names): exact file and directory names, also lists a directory. `hidden`, `gitignore`, `limit` apply. Newest-first by directory; dirs end `/`.
- `query` (+ `grep_keywords`: likely verbatim terms, `[]` if unsure): describe behavior in plain language, get implementing files and line ranges. Judged by a model, so it can miss and takes seconds. Use it only when you have no name, string, or symbol to search for.

`path`: `;`-separated file/dir/glob/URL (omp://, local://, skill://…); default workspace root. A bare glob `*.ts` matches any depth; `dir/*.ts` only `dir`'s direct children (`dir/**/*.ts` recurses). A `!glob` entry excludes matching files and folders below the searched paths (`src;!**/*.test.ts`).
Content and names results are exact. `query` hits are `path:start-end score snippet`, strongest first; scores are 0–1 probabilities and below ~0.4 are weak evidence, so before concluding absence repeat with `pattern`.
