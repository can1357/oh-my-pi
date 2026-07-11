# edit

> Applies source edits; default mode is the hashline patch language consumed from a single `input` string.

## Source
- Entry: `packages/coding-agent/src/edit/index.ts`
- Model-facing prompt: `packages/hashline/src/prompt.md`
- Key collaborators:
  - `packages/coding-agent/src/utils/edit-mode.ts` — selects active edit mode
  - `packages/hashline/src/grammar.lark` — canonical constrained-decoding grammar
  - `packages/hashline/src/format.ts` — sigils and header constants (`[`, `]`, `#`, `+`, `SWAP`, `DEL`, `INS`)
  - `packages/hashline/src/input.ts` — parses `[PATH#TAG]` sections
  - `packages/hashline/src/tokenizer.ts` / `packages/hashline/src/parser.ts` — tokenizes and parses ops
  - `packages/hashline/src/apply.ts` — applies parsed edits to file text
  - `packages/hashline/src/mismatch.ts` — stale-anchor mismatch formatting
  - `packages/hashline/src/recovery.ts` — snapshot-based stale-anchor recovery
  - `packages/hashline/src/snapshots.ts` — mints and resolves per-path opaque snapshot tags

## Inputs

### Hashline mode (default)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | One or more file sections. Anchored sections must start with `[PATH#TAG]`; `TAG` is the four-hex snapshot tag emitted by the latest `read`/`grep`/`write`/successful `edit`. Optional `*** Begin Patch` / `*** End Patch` envelope is ignored if present. |

Patch language inside `input`:

- **File header**: `[PATH#TAG]`. `TAG` is four uppercase-hex chars — a content-derived hash of the whole normalized file (`computeFileHash()`), recorded in the session snapshot store.
- **Operations**:
  - `SWAP N.=M:` — replace original lines N.=M with the body rows below.
  - `SWAP.BLK N:` — replace the whole tree-sitter block beginning on line N (its header line through its closing line) with the body rows. The line span is resolved at apply time from the file's parse tree; point N at the line that opens the construct. The resolved span is exactly the node that begins on line N — a leading decorator, attribute, or doc-comment is a separate node and is not included; point N at the first decorator line (Python wraps `@dec` + `def` as one block) or fall back to `SWAP N.=M:` to take a leading line-comment that parses as its own node (e.g. Rust `///`). On success the result echoes the matched span (`SWAP.BLK N → resolved lines A-B`). Errors (and steers to `SWAP N.=M:`) when the language is unsupported, line N is blank or a closing delimiter, no node begins there, or the resolved block has a syntax error.
  - `DEL N.=M` — delete original lines N.=M. No body.
  - `DEL.BLK N` — delete the whole tree-sitter block beginning on line N (resolved like `SWAP.BLK N`, with the same decorator/comment caveat). No body. On success the result echoes the matched span (`DEL.BLK N → resolved lines A-B`). Same resolution failure modes and `DEL N.=M` fallback.
  - `INS.PRE N:` — insert body rows immediately before line N.
  - `INS.POST N:` — insert body rows immediately after line N.
  - `INS.BLK.POST N:` — insert body rows after the last line of the tree-sitter block beginning on line N. Point N at the line that opens the construct, never its closing delimiter / last visible line; if you can see the last line already, use plain `INS.POST M:`. An anchor that can't resolve to a block is lowered to plain `INS.POST N:` with a warning instead of failing the patch.
  - **Markdown sections**: tree-sitter-md nests a heading and its body (including deeper subsections) in one `section` node, so all three block ops anchored on a `#`/`##`/`###` heading line resolve the whole section — heading through every nested deeper heading, up to the next same-or-higher heading. `DEL.BLK` drops the section, `SWAP.BLK` rewrites it, `INS.BLK.POST` lands after it. A heading with no body resolves to a single line and falls back to the plain op like any other single-line block.
  - `INS.HEAD:` — insert body rows at the start of the file.
  - `INS.TAIL:` — insert body rows at the end of the file.
- **Body rows**:
  - Only body-bearing headers end in `:`.
  - Every body row is `+TEXT`; `+` alone adds a blank line.
  - `DEL` never has body rows.
  - There is no repeat row kind. To keep a line, leave it out of every range; split edits into multiple hunks when needed.
  - `-` rows are invalid. Literal text beginning with `-` or `+` must be written as `+-text` / `++text`.

Anchors come from `read`/`grep` output. `read` emits a `[PATH#TAG]` header from the session snapshot store and lines as `LINE:TEXT`; copy the header into the edit section and copy only the line number into hunk headers.

### Tolerated input shapes (lenient parsing)

The canonical grammar is strict, but the hand parser accepts a few non-dangerous variants:

- `SWAP N:` — accepted as `SWAP N.=N:`.
- `DEL N` — accepted as single-line delete.
- Missing trailing colon on `SWAP` or `INS` — accepted.
- `SWAP N-M:`, `SWAP N…M:`, `SWAP N M:`, and legacy `SWAP N..M:` — accepted as `SWAP N.=M:`.
- Bare body rows with no `+` prefix are auto-prepended with `+` and a `BARE_BODY_AUTO_PIPED_WARNING` is appended.
- `*** Begin Patch` / `*** End Patch` envelopes are silently consumed. `*** Abort` terminates parsing silently — ops parsed before the marker still apply, no warning surfaced.
- Some malformed bracketed headers are recovered after stripping apply-patch path noise such as `Update File:` / `Add File:` and extra `***`, but the recovered header still needs a valid four-hex tag for the patcher to apply it.
- `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:` apply_patch sentinels inside the diff body throw an `apply_patch sentinel … is not valid in hashline` error.
- `@@`-bracketed hunk headers are rejected with guidance to write a verb header.
- Bare `N` and bare `N M` / `N.=M` headers are rejected with guidance to write `SWAP` or `DEL`.
- `DEL N.=M:` and any body rows under `DEL` / `DEL.BLK` are rejected.
- Empty `INS` / `SWAP.BLK` hunks are rejected; an empty `SWAP N.=M:` (no body rows) is treated as `DEL N.=M`.
- `-` body rows are rejected with `MINUS_ROW_REJECTED`.
- `SWAP.BLK N:` / `DEL.BLK N` / `INS.BLK.POST N:` require a wired tree-sitter resolver; `SWAP.BLK` and `INS.BLK.POST` additionally need at least one `+TEXT` body row, while `DEL.BLK` takes none. An unresolvable block (unsupported language, blank/closing-delimiter line, no node beginning on N, or a syntax error in the resolved block) rejects a `SWAP.BLK` / `DEL.BLK` on the apply/final-preview path (the streaming preview silently drops it instead). `INS.BLK.POST N:` is never rejected this way — it is lowered to plain `INS.POST N:` with a warning: a closing-delimiter-anchor warning when line N is a pure closer (inserting after that end is exactly what the plain form does), a generic unresolved-anchor warning otherwise.

## Outputs
- Single-shot tool result; hashline mode does not use a `resolve` preview/apply handshake.
- `content` contains one text block per call. For a successful single-file edit it is the post-edit `[path#TAG]` section header (a fresh snapshot tag for the written content), followed by a compact diff preview from `packages/hashline/src/diff-preview.ts` when one is emitted.
- When the patch used `SWAP.BLK`/`DEL.BLK`/`INS.BLK.POST` ops (and the apply matched the tagged content), one `SWAP.BLK N → resolved lines A-B (K lines)` line per block op (single-line spans render `resolved line A (1 line)`; INS.BLK.POST appends `; body lands after line B`) is inserted between the `[PATH#TAG]` header and the diff preview, so the caller can confirm tree-sitter resolved the construct it intended.
- Parse, apply, or recovery warnings are appended as:

```text
Warnings:
...
```

- `details` is `EditToolDetails` from `packages/coding-agent/src/edit/renderer.ts`:
  - `diff`: unified diff string
  - `firstChangedLine`: first changed post-edit line
  - `diagnostics`: LSP/format result if available
  - `op`: `"create"` or `"update"` for hashline mode
  - `meta`: output metadata
  - `perFileResults`: present for multi-section input
- Multi-section input returns one aggregated result with combined text and per-file details.

## Worked examples

Reference file (the exact shape `read` returns):

```text
[a.ts#0A3B]
1:const X = "a";
2:const Y = X;
3:
4:console.log(X);
5:console.log(Y);
6:export { X, Y };
```

Replace line 1 with two lines:

```text
[a.ts#0A3B]
SWAP 1.=1:
+const X = "b";
+export const Y = X;
```

Insert below line 5:

```text
[a.ts#0A3B]
INS.POST 5:
+console.log(X + Y);
```

Insert above line 5:

```text
[a.ts#0A3B]
INS.PRE 5:
+console.log(X + Y);
```

Delete lines 4.=5 entirely:

```text
[a.ts#0A3B]
DEL 4.=5
```

Insert at start and end of file:

```text
[a.ts#0A3B]
INS.HEAD:
+// header
INS.TAIL:
+// trailer
```

Multi-file:
```text
[src/a.ts#0A3B]
SWAP 4.=4:
+const enabled = true;
[src/b.ts#1F7C]
DEL 20
```

## Limits & Caps
- File snapshot tags are exactly four uppercase-hex chars — content-derived hashes (`computeFileHash()`) recorded in the per-session snapshot store.
- The visible mismatch report shows 2 lines of context on each side (`MISMATCH_CONTEXT`) in `packages/hashline/src/messages.ts`.
- Stale-anchor recovery uses `fuzzFactor: 0` in `packages/hashline/src/recovery.ts`.
- `HL_FILE_PREFIX` is `[`, `HL_FILE_SUFFIX` is `]`, `HL_PAYLOAD_REPLACE` is `+`, `HL_RANGE_SEP` is `.=`, `HL_FILE_HASH_SEP` is `#`, and hunk keyword constants are `SWAP` / `DEL` / `INS` (`packages/hashline/src/format.ts`).

## Errors
- Missing section header:
  - `input must begin with "[PATH#HASH]" on the first non-blank line for anchored edits; got: ...`
- Missing tag for any section:
  - `Missing hashline snapshot tag for <path>; use \`[<path>#tag]\` from your latest read/search output. To create a new file, use the write tool.`
- Stray payload line:
  - `line N: payload line has no preceding hunk header. Use \`SWAP N.=M:\`, \`DEL N.=M\`, or \`INS.PRE|POST|HEAD|TAIL:\` above the body. Got "...".`
- Minus row:
  - ``line N: `-` rows are not valid; the range already names the lines being changed. For a literal `-` line, write `+-…`.``
- Empty body-bearing hunk:
  - `line N: \`INS\` needs at least one \`+TEXT\` body row.`
  - `line N: \`SWAP.BLK N:\` needs at least one \`+TEXT\` body row. To delete a block, use \`DEL.BLK N\`.`
- Unresolvable block anchor — `SWAP.BLK` / `DEL.BLK` only (apply / final-preview path; the streaming preview silently drops the op instead):
  - `line N: \`SWAP.BLK X:\` could not resolve a syntactic block beginning on line X (unsupported language, blank/closer line, or parse error). Use \`SWAP X.=M:\` with explicit lines.` — followed by a blank line and numbered `*`-marked context rows around line X (same shape as the mismatch preview). `DEL.BLK X` produces the same message with a `DEL X.=M` fallback.
  - `INS.BLK.POST X:` never reaches this error — an unresolvable anchor is lowered to plain `INS.POST X:` with a warning (see Tolerated input shapes).
- Delete with body:
  - `line N: \`DEL N.=M\` does not take body rows. Remove the body, or use \`SWAP N.=M:\`.`
  - `line N: \`DEL.BLK N\` does not take body rows. Remove the body, or use \`SWAP.BLK N:\`.`
- Range out of order:
  - `line N: range A.=B ends before it starts.`
- Overlapping hunks on the same anchor:
  - `line N: anchor line X is already targeted by another hunk on line Y. Issue ONE hunk per range; payload is only the final desired content, never a before/after pair.`
- apply_patch / unified-diff contamination:
  - `line N: apply_patch sentinel "*** …" is not valid in hashline. File sections start with \`[path#HASH]\` (no \`Update File:\` / \`Add File:\` keyword). Use \`SWAP N.=M:\`, \`DEL N.=M\`, or \`INS.PRE|POST|HEAD|TAIL:\` ops.`
  - `line N: unified-diff hunk header (\`@@ -N,M +N,M @@\`) is not valid in hashline. Use \`SWAP N.=M:\`, \`DEL N.=M\`, or \`INS.PRE|POST|HEAD|TAIL:\` ops.`
  - `line N: \`@@\`-bracketed hunk header "@@ …" is not valid in hashline. Drop the \`@@ ... @@\` brackets and write a verb header such as \`SWAP N.=M:\`.`
  - `line N: hunk headers need a verb. Use \`SWAP N.=N:\` to replace, or \`DEL N\` to delete.`
  - `line N: bare range hunk header "N M" is not valid. Hunk headers need a verb: write \`SWAP ${bareRange[1]}.=${bareRange[2]}:\` or \`DEL ${bareRange[1]}.=${bareRange[2]}\`.`
- Out-of-range anchor:
  - `Line N does not exist (file has M lines)`
- Stale snapshot tag: the `Patcher` first attempts snapshot-based recovery. When recovery cannot prove a valid result it throws `MismatchError`, which distinguishes recognized-but-drifted hashes from never-recorded hashes. The error includes the current file hash plus context around each anchor.
- No-op edit:
  - `Edits to <path> parsed and applied cleanly, but produced no change: your body row(s) are byte-identical to the file at the targeted lines. The bug is somewhere else — re-read the file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor first.`
  - After `NOOP_HARD_LIMIT = 3` consecutive byte-identical no-ops of the same payload on the same file, the soft text result escalates to a `ToolError` (`STOP. Edits to <path> have been a byte-identical no-op N times in a row …`) from `packages/coding-agent/src/edit/hashline/noop-loop-guard.ts`.
- Recovery failure is silent internally: if cache-based merge cannot prove a valid result, the mismatch error is surfaced unchanged.

## Warnings
- `Auto-prefixed bare body row(s) with +. Body rows must be +TEXT literal lines …` (`BARE_BODY_AUTO_PIPED_WARNING`)
- Recovery banners: `RECOVERY_EXTERNAL_WARNING`, `RECOVERY_SESSION_CHAIN_WARNING`, `RECOVERY_SESSION_REPLAY_WARNING` (`packages/hashline/src/messages.ts`).
