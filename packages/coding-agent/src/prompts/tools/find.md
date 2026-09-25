Describe behavior, get implementing files and line ranges. MUST use first for unknown locations; known strings/regex/symbols → `grep`, names → `glob`.
`query`: plain language, not regex; quoted phrases match whole. `grep_keywords`: likely verbatim terms, `[]` if unsure.
`path`: one directory or file, host path or internal URL (`omp://`, `omp://<file>.md`, `skill://<name>`, `local://…`); omitted = workspace root. Scope known subsystem; batch related questions. Searches live files, no index; no `:start-end` selector (judges whole files).
Hits strongest first: `path:start-end score snippet` (workspace-relative, or URL under URL scope); read returned ranges. Scores: absolute comparable 0–1 probability; below ~0.4 = weak evidence, so widen query or use `grep` before concluding absence.
