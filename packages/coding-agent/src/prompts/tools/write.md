Creates or overwrites file at specified path.

<conditions>
- Creating new files explicitly required by task
- Replacing entire file contents when editing would be more complex
- Supports `.zip` (and ZIP-based `.jar`/`.war`/`.ear`/`.apk`), `.tar`, `.tar.gz`/`.tgz`, `.tar.zst`, and `.asar` archive entries via `archive.ext:path/inside/archive`; other archive formats (`.rar`, `.7z`, `.iso`, …) are read-only
- Supports SQLite row operations via `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete with empty content)
- Optional `then_run`: a shell command string run after a successful **local filesystem** write, through the bash tool with independent approval. Rejected before mutation for xd://, ssh://, archive, sqlite, other internal URLs, ACP/client-bridge remote sessions, and any non-final write/edit in the same tool-call batch (only the last write/edit may use it, after that call's LSP flush; no deferred queue). JSON hashline/sloppy/apply_patch schemas accept `then_run`; the raw Lark grammar payload cannot encode it. Verification fail/cancel/timeout keeps the write; mutation failure skips verification.

<critical>
- You SHOULD use Edit tool for modifying existing files
- You NEVER create documentation files (*.md, README) unless explicitly requested
- You NEVER use emojis unless requested
</critical>
