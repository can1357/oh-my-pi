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
Use enough ` `-prefixed lines to make match unique (usually 2–8). For nested braces/tags/indented regions, include opening and closing lines so the edit stays inside the block.
</instruction>

<parameters>
Per entry: `{ op, [rename,] diff }` where `op` is `"create" | "delete" | "update"`, `rename` is the new path (update only), and `diff` is the hunk body (only `' '|'+'|'-'` prefixed lines, each hunk containing at least one `+` or `-`).
</parameters>

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
