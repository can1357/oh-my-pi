Anchored edit patch.

<ops>
- `*** Edit File: path` opens a file; bare `*** Edit File:` continues it. Repeat for more files; all edits apply atomically. Append ` all` to either opener to change every match. JSON-quote ambiguous paths.
- `*** Find` MUST match once unless `all`. Copy exact text/indentation from the latest verbatim file read, not Markdown, diffs, or summaries. Use the smallest unique anchor; ambiguity requires parent context, NEVER retry the bare line.
- Follow Find with `*** Replace` (complete final text; empty deletes), `*** Insert Before` (add lines before first matched line), or `*** Insert After` (add lines after last matched line). Inserts keep the match. Replacement MUST quote part of the changed line; insertion MUST quote adjacent anchor and contain new lines. Changing an anchor requires Replace. Omitting an action does not delete.
- Headers MUST stand alone; bodies are raw lines until next header or EOF, no closing delimiter or `*** End …` line. NEVER use diff prefixes `+`/`-`/space or `@@` hunks. Edits address the original file, not positions shifted by earlier edits.
- Find `…` captures omitted text: mid-line gaps stay on that line; line-end gaps span lines. Each Replace `…` re-emits the next capture. A whole `…` line without a capture errors: type those lines out. Insert `…` is literal. Avoid retyping unchanged lines: use Insert or captures.
- Replace/Insert indentation verbatim; whitespace, operators, delimiters are NEVER repaired. Failure applies nothing: resend its complete copy-ready corrected payload verbatim. “No change” means Replace already equals file text; look elsewhere. File contains a standalone edit header? Use `write`.
</ops>

<example>
```text
*** Edit File: "src/all" all
*** Find
item();
*** Insert After
log();
*** Edit File: src/b.ts
*** Find
load(…);
…
return old(…);
*** Replace
load(…);
…
return fresh(…);
```
</example>
