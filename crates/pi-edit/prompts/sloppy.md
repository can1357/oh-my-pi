Anchored edit patch: Find quotes existing text; Replace replaces it; Insert Before/Insert After add lines without replacing it.

<ops>
- Start with `*** Edit File: path`; bare `*** Edit File:` continues that file. Repeat for another file; all edits apply atomically. To change every occurrence: `*** Edit File: path all` or `*** Edit File: all`. Quote ambiguous paths as JSON strings: `*** Edit File: "path ending in all" all`.
- Each `*** Find` MUST match once unless `all`; follow it with `*** Replace` (complete replacement; empty body deletes), `*** Insert Before` (keeps match, inserts body before its first line), or `*** Insert After` (keeps match, inserts body after its last line). Omitting the action never deletes. Inserts need new lines; use Replace when the anchor also changes.
- Headers MUST stand alone. Body = raw lines until next header or EOF; no closing delimiter, no `*** End …` line. In Find, `…` captures omitted text: mid-line gaps stay on that line; a gap at line end spans lines. Each Replace `…` re-emits the next Find capture. A whole `…` line without a capture is an error: type those lines out. In Insert bodies, `…` is literal.
</ops>

<rules>
- Find: copy byte-for-byte from latest verbatim file read, including indentation; never from Markdown, diffs, or agent summaries. Replacement MUST include part of changed line; insertion MUST quote the anchor adjacent to the new lines. Use smallest unique anchor; ambiguous match → add unique parent context, NEVER retry the bare line.
- Not a diff: NEVER prefix lines with `+`/`-`/space or use `@@` hunks.
- Replace/Insert: indentation verbatim; NEVER expect whitespace, operators, or delimiters to be repaired. AVOID retyping unchanged lines: use inserts or Replace captures. Edits address original file, not shifted lines from earlier edits.
- Failure applies nothing: resend its complete copy-ready corrected payload verbatim. “No change” means Replace already equals file text; look elsewhere. File contains a standalone `*** Edit File:`, `*** Find`, `*** Replace`, `*** Insert Before`, or `*** Insert After` line? Use `write` instead.
</rules>

<example>
Replace everywhere, insert in another file, then edit that file again:
```text
*** Edit File: src/a.ts all
*** Find
log.old(
*** Replace
log.new(
*** Edit File: src/b.ts
*** Find
const n = 1;
*** Insert After
const m = 2;
*** Edit File:
*** Find
run();
*** Replace
execute();
```

Move existing code: delete at source with empty Replace, insert ahead of an unchanged anchor:
```text
*** Edit File: src/util.ts
*** Find
const helper = () => 1;
*** Replace
*** Find
run(target);
*** Insert Before
const helper = () => 1;
```

Preserve skipped lines and a skipped part of a line:
```text
*** Edit File: src/users.ts
*** Find
function load(…){
…
return old(…);
}
*** Replace
function load(…){
…
return fresh(…);
}
```
</example>
