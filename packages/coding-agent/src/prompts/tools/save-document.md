Save a document into long-term memory. The server chunks it, embeds the chunks and keeps their provenance (title, heading, chunk position), so later `recall` pulls exact pieces and the auto-recall block carries one index line per document.

Use when the user asks to remember a file, a web page, or a piece of documentation — or when a document is worth keeping reachable across sessions.

Provide exactly one source: `path` (local file), `url` (web page), or `text` (literal content). `media_type` is inferred from the source when omitted. `document_id` is stable across saves: re-saving the same id replaces the document in place; when omitted, the server deduplicates by content hash.
