SHOULD `edit` existing files; `write` for required new files or whole-file replacement. NEVER create docs or emojis unless requested.
`archive.ext:member`: ZIP/tar families and `.asar` writable, others read-only. `db.sqlite:table`: insert; `db.sqlite:table:key`: JSON update, empty content deletes.
{{#if thenRun}}
Optional `then_run`: shell command run once after a successful local write, through the bash tool with its own approval. Only the last write/edit of a tool-call batch may carry it. Rejected before mutation for `xd://`, `ssh://`, archive, sqlite, other internal URLs, and remote ACP sessions. Verification fail/cancel/timeout keeps the write; a failed write skips verification.
{{/if}}
