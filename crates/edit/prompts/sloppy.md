One `input` string = one complete patch. Start `*** Edit File: path`; repeat operations under it. Use current text from a read or the user's quote. Read only for missing context.

**Whole function, conditional, class or multiline call:** put the action and the start of its opening line in ONE header. The tool locates the closing line. NEVER quote the old body, even when rewriting or dedenting every line.

```text
*** Edit File: queue.ts
*** Replace Block: if (useLegacyQueue) {
if (useLegacyQueue) {
  drain(queue);
}
*** Delete Block: function obsolete(
*** Cut Block: async function flushPending(
*** Paste Before Block: export function shutdown(
```

`Replace Block:` uses the header only to locate the old block. Give the complete final code below it, including the opening line if it stays. `Delete Block:` has no body. To remove one of two adjacent identical copies, name the duplicated opener. Otherwise the opening-line prefix must be unique. Cut takes whole lines; paste once in the same file. To land beside one line instead of a block use `*** Find` plus `*** Paste Before`/`*** Paste After`.

**Small changes:** `*** Find` is the old side, not a search call. Append the action AND its body to the SAME string before sending. Use the shortest unique fragment. Editing a one-line doc comment? Quote its actual delimiters, not a ` * ` continuation. `*** Find all` renames every whole-word match of a bare identifier:

```text
*** Edit File: jobs.ts
*** Find all
retrunValue
*** Replace
returnValue
```

For arbitrary ranges or unsupported syntax, Find the first line, a literal `…` line, then the last line. Add a distinctive neighbour if ambiguous, not the middle of the block. `*** Replace` writes the new span (header alone deletes); `…` in a text Replace reuses its Find capture. `*** Insert Before` / `*** Insert After` keeps the anchor; supply only new lines. `*** Cut` followed by a destination Find/Paste moves a text range. Indentation is literal.
