---
title: Merge Conflict Resolution
description: Resolve merge conflicts one URL at a time with conflict://.
coverage: B
---

omp resolves Git merge conflicts one block at a time, without rewriting the whole file. The `read` tool spots conflict markers as they are read and registers each block with a stable id; the `write` tool then splices a replacement for that block using the `conflict://<id>` URI. Scoped reads (`conflict://<id>/ours`, `/theirs`, `/base`) are read-only.

## How conflicts are surfaced

When you `read` a file containing unresolved Git merge conflicts, the collected lines are scanned for well-formed `<<<<<<<` / `=======` / `>>>>>>>` blocks. Each completed block is registered with the session's `ConflictHistory`, which assigns a stable numeric id. The file text is returned verbatim, with a short footer naming every conflict id surfaced by that read.

Strict marker shape: only column-0 markers of the exact prefix length, followed by either end-of-line or a single space + label, count. Lines that merely start with `<` or `=` never match. Diff3-style conflicts (with a `|||||||` base section) are recognised, and the base side is recorded when the marker is present.

For a heavily conflicted file, append `:conflicts` to the read path to get a one-line-per-block index instead of the full body:

```text
path: src/auth.ts:conflicts
```

## Read scopes (read-only)

A registered conflict is also addressable by URL for read-only inspection:

```text
read conflict://<id>          // the recorded marker block with labels
read conflict://<id>/ours     // just the ours side
read conflict://<id>/theirs   // just the theirs side
read conflict://<id>/base     // just the base side (diff3 only)
```

Scopes are read-only. A `write` whose `path` is `conflict://<id>/ours` (or `/theirs` / `/base`) is rejected.

## Resolving a conflict

Write your replacement to `conflict://<id>` with the chosen content. The write splices the new content over the recorded marker block only — it never repeats the surrounding lines:

```text
path: "conflict://3"
content: "return value.toUpperCase();"
```

If the URI was mixed with a file path (for example `path/to/file.ts:conflict://3`), the leading prefix is recovered and ignored.

### Side shorthand

A line that is exactly `@ours`, `@theirs`, `@base`, or `@both` (after CRLF normalisation) expands to the recorded section of that name. Other lines pass through verbatim, so a comment followed by one of these tokens is written literally:

```text
path: "conflict://5"
content: "// keep both\n@ours\n@theirs"
```

Token behaviour:

| Token | Expands to |
| --- | --- |
| `@ours` | The recorded `oursLines`, in order. |
| `@theirs` | The recorded `theirsLines`, in order. |
| `@base` | The recorded `baseLines`; fails if the conflict has no base section (2-way merge). |
| `@both` | `oursLines` then `theirsLines` with no separator. Only for additive conflicts where each side adds something different; never for competing edits of the same lines. |

Resolve a block faithfully: keep one side (`@ours` / `@theirs`), or combine them when both intents apply. Never invent content beyond the recorded sides, and never stack both sides of competing edits.

### Bulk resolution

To resolve many conflicts in one call, write to `conflict://*` with `<id>: @side` lines:

```text
path: "conflict://*"
content: "1: @ours\n2: @theirs\n5: @both\n7: // prefer ours\n@ours"
```

Each listed id is resolved with its specified side in a single call. Unlisted ids stay registered, so you can peck off the safe ones first and come back to the hard ones later.

## Stable ids and retries

`ConflictHistory` is per-session and append-only. Ids stay valid even after other blocks in the same file are resolved, so a retry does not need to re-read the file. The splice re-locates the recorded region by content, so any earlier writes (including other resolved blocks) are taken into account automatically.

When a `write` resolves a conflict, that entry is dropped from the history. Solving the last block in a file clears the history for that path.

## Typical agent flow

1. `read` the conflicted file. The tool returns the file with a footer listing the registered conflict ids.
2. For each id, inspect the recorded region — `conflict://<id>` for the full block, or scope reads (`/ours`, `/theirs`, `/base`) for one side at a time. Use `:conflicts` to skim an index first when the file is large.
3. Pick a resolution per block and `write` it to `conflict://<id>`. Use shorthand tokens (`@ours`, `@theirs`, `@base`, `@both`) for pick-one conflicts, or write the combined text by hand for additive ones.
4. Use `conflict://*` with `<id>: @side` lines when many blocks share the same resolution.
5. Resolve several blocks in one assistant turn by issuing multiple `write` calls — ids remain valid as earlier blocks are resolved.

## Sharp edges

- **Scopes are read-only.** Writing to `conflict://<id>/ours`, `/theirs`, or `/base` is rejected; always omit the scope on writes.
- **`@base` is diff3-only.** On a 2-way conflict with no `|||||||` marker, a `@base` token throws; pick another side or write the merged text.
- **`@both` is not a tiebreaker.** It just concatenates ours-then-theirs. Use it only when the two sides add different things; for competing edits of the same lines, pick one side or write the combined text.
- **Windowed reads.** A `read` that opens inside a conflict block (no closing marker yet in the window) does not register that block. Widen the read past the closing marker first.
- **Splice is marker-based.** The write tool replaces the recorded region verbatim — it does not normalise whitespace around the markers. If you want to re-indent, edit the surrounding lines with the `edit` tool after the conflict is resolved.
