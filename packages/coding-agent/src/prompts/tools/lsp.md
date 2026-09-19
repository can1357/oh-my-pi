Symbol-aware code intelligence from language servers — navigation, refactors, and diagnostics where text tools miss callsites.

<operations>
- Position-based: `file` + `line` + `symbol` (substring; `#N` for Nth match). `line` is 1-indexed.
- `rename` — applies by default; `apply: false` previews. Project-aware lookups ERROR without `symbol` — no silent fallback on missing/ambiguous matches.
- `code_actions` — lists by default; apply ONE with `apply: true` + `query` (title substring or index).
- `rename_file` — moves file AND rewrites all imports/references; applies by default.
- `diagnostics` — path, glob (`src/**/*.ts`), or `file: "*"` for workspace.
- `symbols` — `file` lists file symbols; `file: "*"` + `query` searches workspace.
- `reload` — restart one server (`file`) or all (`*`); `reload *` re-reads LSP config.
- `request` — raw: `query` = method, `payload` = JSON params (else auto-built).
</operations>

<efficient-use>
- Use a file or narrow glob for diagnostics after a coherent edit, not after every line. `file: "*"` runs workspace checks; reserve it for workspace-wide verification.
- For navigation, request the symbol operation directly; do not run diagnostics or reload as a prerequisite.
- Keep servers warm. Use `status` to investigate failures; reload only after configuration changes or evidence of a stuck server.
- A timeout or incomplete result is not a clean check. Inspect the failed server or use the project's focused checker; do not repeatedly increase timeouts or rerun unchanged checks.
- Prefer `diagnostics` over raw server-specific requests; the native tool handles diagnostic completion and normalization.
</efficient-use>

<critical>
- Symbol-aware work (rename, references, definition, code actions) MUST use `lsp` whenever a server is available.
  It follows shadowing, re-exports, and cross-file usages text tools miss.
- NEVER do a cross-file rename with `ast_edit`/`sed`/hand edits when `lsp` `rename`/`rename_file` can — text renames silently drop callsites.
- Reach for `code_actions` on imports, quick-fixes, and server-known refactors before editing by hand.
</critical>
