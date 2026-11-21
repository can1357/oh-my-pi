Edit existing files by describing the changes. A fast model types each file's patch; the result is the applied diffs.

{{#if xml}}
Payload: one `<edit file="path">` element per file. The lines inside it say what changes in that file; `</edit>` on its own line closes it. Batch every file of a change into one call.
{{else}}
Payload: one section per file. A `# path` line opens it; the lines after it say what changes in that file. Batch every file of a change into one call.
{{/if}}

- Changes: mechanical instructions that someone holding only that file can carry out with no decisions left to make.
- The fast model reads the file itself, with line numbers, and finds what you name. NEVER `read` a file or list a directory just to locate or describe a change you can already name (a rename; deleting, moving or swapping a block by its first line): edit directly. A given path works; a wrong one is reported.
- Name each site by its original text; include known line numbers.
- Quote only genuinely new text. For deletion, movement, or indentation, name the existing range and state the operation; NEVER retype its contents.
- For an exact target, compare the affected file range and include every difference in one call.
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
In `drain()`, swap the two lines `const batch = queue.take(limit);` and `const limit = queue.size();`.
Swap the function starting `export function stop(` with the function after it, starting `function flush(`.
</edit>
<edit file="src/parse.ts">
Rename every `retrunValue` to `returnValue`.
In `parseHeader`, replace `return fields.slice(1);` with `return fields.slice(0);`.
</edit>
<edit file="src/server.ts">
Delete the second, duplicated `if (req.method === "OPTIONS") { ... }` block in `handle()` (the copy starting near line 88); keep the first.
</edit>
{{else}}
# src/jobs.ts
In `drain()`, swap the two lines `const batch = queue.take(limit);` and `const limit = queue.size();`.
Swap the function starting `export function stop(` with the function after it, starting `function flush(`.
# src/parse.ts
Rename every `retrunValue` to `returnValue`.
In `parseHeader`, replace `return fields.slice(1);` with `return fields.slice(0);`.
# src/server.ts
Delete the second, duplicated `if (req.method === "OPTIONS") { ... }` block in `handle()` (the copy starting near line 88); keep the first.
{{/if}}
</example>
