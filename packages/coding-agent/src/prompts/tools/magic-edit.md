Edit existing files by describing the changes. A fast model types each file's patch; the result is the applied diffs.

{{#if xml}}
Payload: one `<edit file="path">` element per file. The lines inside it say what changes in that file; `</edit>` on its own line closes it. Batch every file of a change into one call.
{{else}}
Payload: one section per file. A `# path` line opens it; the lines after it say what changes in that file. Batch every file of a change into one call.
{{/if}}

- Changes: mechanical instructions that someone holding only that file can carry out with no decisions left to make.
- Name every site by its text: the function, the statement, a quoted fragment. Line numbers from your latest read MAY be added.
- New or changed code: give it verbatim. Deleting, moving, swapping: say which lines and where they go.
- NEVER describe a goal ("fix the bug", "handle the error"): decide the fix yourself, then describe the text change.
{{#if xml}}
- NEVER put text outside the elements.
{{else}}
- NEVER start a change line with `# `: it opens the next file.
{{/if}}
- Files apply independently: one that fails stays unchanged and is reported; the others still apply.
- You MUST check the returned diffs. Wrong or not applied? Send that file again with a more exact instruction.
- New files: `write`.

<example>
{{#if xml}}
<edit file="src/jobs.ts">
In `drain()`, swap the two lines `const batch = queue.take(limit);` and `const limit = queue.size();` so `limit` is declared first.
</edit>
<edit file="src/parse.ts">
Rename every `retrunValue` to `returnValue`.
In `parseHeader`, replace `return fields.slice(1);` with `return fields.slice(0);`.
</edit>
<edit file="src/server.ts">
Delete the second, duplicated `if (req.method === "OPTIONS") { … }` block in `handle()` (the copy starting near line 88); keep the first.
</edit>
{{else}}
# src/jobs.ts
In `drain()`, swap the two lines `const batch = queue.take(limit);` and `const limit = queue.size();` so `limit` is declared first.
# src/parse.ts
Rename every `retrunValue` to `returnValue`.
In `parseHeader`, replace `return fields.slice(1);` with `return fields.slice(0);`.
# src/server.ts
Delete the second, duplicated `if (req.method === "OPTIONS") { … }` block in `handle()` (the copy starting near line 88); keep the first.
{{/if}}
</example>
