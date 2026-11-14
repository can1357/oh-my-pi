SHOULD `edit` existing files; `write` for required new files or whole-file replacement. NEVER create docs or emojis unless requested.
{{#if readActive}}Archive members and SQLite rows are writable too: xd://read/sources.{{else}}`archive.ext:member`: ZIP/tar families and `.asar` writable, others read-only. `db.sqlite:table`: insert; `db.sqlite:table:key`: JSON update, empty content deletes.{{/if}}
