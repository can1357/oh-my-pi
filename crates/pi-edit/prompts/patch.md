Patches files given diff hunks. Primary tool for existing-file edits.

<instruction>
**Hunk Headers:**
- `@@` — bare header when context lines unique
- `@@ $ANCHOR` — anchor copied verbatim from file (full line or unique substring)
**Anchor Selection:**
1. Prefer bare `@@` when context lines alone are unique; otherwise choose highly specific anchor copied from file:
   - full function signature
   - class declaration
   - unique string literal/error message
   - config key with uncommon name
2. On "Found multiple matches": add context lines, use multiple hunks with separate anchors, or use longer anchor substring
**Context Lines:**
Use enough ` `-prefixed lines to make match unique (usually 2–8)
When editing structured blocks (nested braces, tags, indented regions), include opening and closing lines so edit stays inside block
</instruction>

<parameters>
```ts
// Input is { path: string, edits: Entry[] }. `path` is required and applies to every entry.
type Entry =
   // Diff is one or more hunks for the top-level path.
   // - Each hunk begins with "@@" (anchor optional).
   // - Each hunk body only has lines starting with ' ' | '+' | '-'.
   // - Each hunk includes at least one change (+ or -).
   | { op: "update", diff: string }
   // Diff is full file content, no prefixes.
   | { op: "create", diff: string }
   // No diff for delete.
   | { op: "delete" }
   // New path for update+move from the top-level path.
   | { op: "update", rename: string, diff: string }
```
</parameters>

<output>
Returns success/failure; on failure, error message indicates:
- "Found multiple matches" — anchor/context not unique enough
- "No match found" — context lines don't exist in file (wrong content or stale read)
- Syntax errors in diff format
</output>

<critical>
- You MUST read the target file before editing
- You MUST copy anchors and context lines verbatim (including whitespace)
- You NEVER use anchors as comments (no line numbers, location labels, placeholders like `@@ @@`)
- You NEVER place new lines outside the intended block
- If edit fails or breaks structure, you MUST re-read the file and produce a new patch from current content — you NEVER retry the same diff
- NEVER use edit to fix indentation, whitespace, or reformat code. Formatting is a single command run once at the end (`bun fmt`, `cargo fmt`, `prettier --write`, etc.) — not N individual edits. If you see inconsistent indentation after an edit, leave it; the formatter will fix all of it in one pass.
</critical>

<avoid>
- Generic anchors: `import`, `export`, `describe`, `function`, `const`
- Repeating same addition in multiple hunks (duplicate blocks)
- Full-file overwrites for minor changes (acceptable for major restructures or short files)
</avoid>
