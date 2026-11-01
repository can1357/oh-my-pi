SHOULD `edit` existing files; `write` for required new files or whole-file replacement. NEVER create docs or emojis unless requested.
For file targets, an empty `content` is refused unless you pass `allowEmpty: true`; use that only to deliberately create or truncate a zero-byte file. SQLite row writes keep using empty content to delete, and `proc://` keeps it as empty stdin.
`archive.ext:member`: ZIP/tar families and `.asar` writable, others read-only. `db.sqlite:table`: insert; `db.sqlite:table:key`: JSON update, empty content deletes.
