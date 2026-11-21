# edit

> Applies source edits. The default `hashline` mode consumes one line-anchored patch string and edits existing files directly.

## Source

- Entry and mode registration: `packages/coding-agent/src/edit/index.ts`
- Mode schemas: `packages/coding-agent/src/edit/schemas.ts`
- Model-facing prompts: `crates/edit/prompts/`; compact hashline variant: `packages/coding-agent/src/edit/hashline-compact.md`
- Constrained-decoding grammars: `crates/edit/grammars/`
- Native bridge: `crates/natives/src/edit.rs` — `EditSession`, `EditStore`, inspection, prompt/grammar exports
- Hashline parser/application: `crates/edit/src/modes/hashline/`
- Snapshot/register state: `crates/edit/src/store.rs`; staging, streaming previews, and result shaping: `crates/edit/src/session.rs`
- Host writes, LSP integration, and parse-regression handling: `packages/coding-agent/src/edit/index.ts`
- Mode selection/settings: `packages/coding-agent/src/utils/edit-mode.ts`, `packages/coding-agent/src/edit/settings.ts`

## Mode selection and availability

`edit` is an essential built-in tool. `resolveEditMode()` selects the active wire contract in this order:

1. model-specific configured variant;
2. `PI_EDIT_VARIANT`;
3. `edit.mode`;
4. default `hashline`.

Supported modes are `hashline`, `apply_patch`, `patch`, `replace`, and `sloppy`. `edit.mode: none` (or `PI_EDIT_VARIANT=none`) instead unregisters `edit`, wins over `edit.modelVariants`, turns off hashline anchors, and keeps `bash` registered regardless of `bash.enabled`; explicit tool lists still get `bash` only when they name it. `edit.modelVariants` uses the longest case-insensitive substring match against the active model string; equal-length matches keep config order. `PI_EDIT_VARIANT` pins the mode exactly; for settings-derived `hashline`, `PI_STRICT_EDIT_MODE` disables the model-family fallback to `replace` (Kimi, MiMo, MiniMax, DeepSeek, StepFun, Codex Spark, and GLM 5.3 Flash).

This page primarily documents hashline. The schema, prompt, examples, renderer, and optional Lark format switch with the mode. Models with `editPromptVariant: "compact"` receive the compact hashline prompt. In `apply_patch` custom-tool mode the wire name is `apply_patch`; dispatch, including `xd://apply_patch`, still reaches the same internal tool. The tool is strict, essential, and uses exclusive concurrency.

## `magic` mode

`edit.mode: magic` (or `PI_EDIT_VARIANT=magic`) keeps the `edit` tool but changes its contract: the payload describes the changes in words, one section per file, and an auxiliary model writes each file's patch. `edit.modelVariants` cannot select it. Source: `packages/coding-agent/src/edit/magic.ts`; model-facing prompt: `packages/coding-agent/src/prompts/tools/magic-edit.md`.

```text
# src/jobs.ts
- In `drain()`, declare `limit` before `batch`.
# src/parse.ts
- Rename every `retrunValue` to `returnValue`.
```

The schema is `{ input: string }`. Providers with custom-tool grammars receive the payload's Lark grammar and send it raw, as in `hashline` mode. A line starting with `# ` opens the next file unless it sits inside a code fence; text before the first `# path` line is rejected. Sections naming the same path merge.

1. Each file is read and shown to the apply model with a line-number gutter, together with its changes. A line that opens a block shows the block's span instead of its number (`20-49`), so the model copies where a block ends instead of counting. A file of 200 lines or more is first shown as an excerpt when that leaves out at least half of it: the lines the change quotes, names by identifier, or gives by number, each with the block it opens and twelve lines of context, plus the head and tail of the file; `⋮ lines A-B not shown` marks each gap. A reply that is rejected or declines against an excerpt is asked for again with the whole file.
2. It answers with line operations, one JSON array per line, numbered against the file as shown: `["delete",12,14]`, `["replace",9,9,"text"]`, `["sub",7,"old","new"]` (`"all"` instead of a line for every occurrence in the file), `["insert","after",15,"text"]`, `["move",20,41,"before",3]`, `["swap",20,49,51,74]`, `["indent",13,17,2]` / `["dedent",…]`. Existing text is never retyped, so deleting, moving or re-indenting a block costs a few tokens whatever its size. A first line `CANNOT: <reason>` declines the change. Fences, an outer array, quoted numbers and commentary after the operations are accepted; operations after commentary are not. Source: `packages/coding-agent/src/edit/magic-lines.ts`.
3. The operations compile into one exact replacement of the lines they span. Blank lines between blocks are separators the compiler places itself: a deleted block leaves one behind, a moved block is set off again where it lands, and a range that is one blank line off gives the same result. Operations that touch the same lines, name a line outside the file or the shown excerpt, or remove indentation that is not there are rejected.
4. Before writing, two checks send a doubtful reply back to the model instead of applying it: the file parsed and would no longer parse; or a deleted, moved or swapped range starts a block and stops inside it or runs past it. The second is a question: the same operations sent again are applied. The write is one atomic `replace`-mode batch and is refused if the file changed after it was read. Writes go one file at a time; plan-mode policy, LSP diagnostics and the result diff are the same as for any other mode.
5. A rejected reply goes back to the model with the rejection: three completions per file inside one 120 second budget for the call. The output limit of a completion is sized to the shown file and the change.

Files are independent. A section fails, leaving its file unchanged, when the model declines or no reply applies; when the file is missing or binary; when the file is larger than half the apply model's context window and the change names no part of it to show instead; or when the reply is cut off or the budget runs out. The result then reports `[path] not applied: <reason>` next to the other files' diffs, and the call is an error only when no section applied. The whole call fails when the payload has no section or no apply model resolves.

## Input

| Field   | Type     | Required | Description                                                                                                                                                                                                      |
| ------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input` | `string` | Yes      | One or more `[PATH#TAG]` sections containing hashline operations. The strict custom-tool grammar wraps the sections in `*** Begin Patch` / `*** End Patch`; the normal parser also accepts an unwrapped payload. |

Each section edits one existing file and MUST copy the four-uppercase-hex snapshot tag from the latest anchored `read`, `grep`, or successful `edit` result:

```text
[src/example.ts#1A2B]
PUT 4.=4:
+const value = 2;
```

Use `write` to create or wholly overwrite a file. Hashline rejects untagged anchored edits at application time.

## Canonical patch language

All line numbers refer to the original tagged snapshot, not to earlier hunks in the same call.

| Form                                             | Effect                                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT N.=M:`                                      | Replace inclusive original lines `N..M` with the following `+TEXT` rows.                                                                                  |
| `PUT N*:`                                        | Replace the multi-line syntactic block beginning on line `N`.                                                                                             |
| `PUT <N:` / `PUT >N:`                            | Insert body rows immediately before / after line `N`. `PUT <1:` is file head.                                                                             |
| `PUT >$:`                                        | Append body rows at file tail.                                                                                                                            |
| `PUT >N*:`                                       | Insert after the syntactic block beginning on line `N`.                                                                                                   |
| `CUT N.=M` / `CUT N*`                            | Delete and capture an inclusive range or resolved block. Add `@name` to write a named register.                                                           |
| `PUT <N` / `PUT >N` / `PUT >$`                   | Paste the anonymous register into a gap.                                                                                                                  |
| `PUT <N @name` / `PUT >N @name` / `PUT >$ @name` | Paste a named register into a gap.                                                                                                                        |
| `PUT N.=M @name` / `PUT N* @name`                | Replace a range or block with a named register. Named registers are required for span/block paste.                                                        |
| `REM`                                            | Delete the section file.                                                                                                                                  |
| `MV DEST`                                        | Write the edited file to the destination, then delete the source. Existing destination contents can be overwritten; quote destinations containing spaces. |

Register names contain ASCII letters, digits, `_`, or `-`. The anonymous register is batch-local and starts empty on every call. Named registers persist for the session and are published only after their writes land. Operations run top-to-bottom across sections, so a cut in an earlier section can feed a later paste. Repeating a paste does not consume its register.

Only body-bearing `PUT ...:` headers take body rows. Every body row is `+TEXT`; `+` alone inserts a blank line. The body is final content, never a unified-diff before/after pair. Literal content beginning with `-` or `+` is written as `+-...` or `++...`. `CUT`, register-backed `PUT`, `REM`, and `MV` take no body.

### Block anchors

Block forms resolve from the opening line through the tree-sitter node's end. Anchor the construct opener, never a closing delimiter, last visible line, blank line, or inner statement. A single-line node is rejected with guidance to use the corresponding explicit-line operation. `PUT >N*:` lowers to ordinary `PUT >N:` with a warning when no block resolves; replace/cut block forms fail instead of guessing.

Leading decorators, attributes, and doc-comments may be separate syntax nodes. Anchor the first decorator when the parser groups it with the declaration. In Rust, the first outer attribute (`#[...]`) or outer doc comment (`///`, `/** */`) of an item also resolves through the item, past any further attributes and comments. A later attribute or doc comment of the same item, or one with no item after it, is rejected like a single-line node, however many lines it spans. Otherwise use an explicit range. Standalone line comments are not swept automatically. In Markdown, a heading's block includes its body and deeper subsections through the next heading of equal or higher level.

Use tight ranges and separate non-adjacent changes. Do not use `edit` merely to reformat or restyle code; run the project's formatter after the substantive edit.

## Examples

Given:

```text
[greet.py#A1B2]
1:@cache
2:def greet(name):
3:    print("Hello, " + name)
4:
5:greet("world")
```

Replace the decorated function without touching its caller:

```text
*** Begin Patch
[greet.py#A1B2]
PUT 1*:
+@cache
+def greet(name):
+    print(f"Hi, {name}")
*** End Patch
```

Move it to another previously-read file using a named register:

```text
*** Begin Patch
[greet.py#A1B2]
CUT 1* @fn
[lib/greet.py#3C4D]
PUT <1 @fn
*** End Patch
```

Rename after editing:

```text
*** Begin Patch
[greet.py#A1B2]
PUT 5.=5:
+greet("team")
MV lib/welcome.py
*** End Patch
```

## Other wire contracts

| Mode          | Parameters                                                                                        | Edit form                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `replace`     | `path`, `old_string`, `new_string`, optional `replace_all`                                        | Replace quoted text in one file.                                                                                          |
| `patch`       | `path`, `edits: Array<{ op?: "create" \| "delete" \| "update"; rename?: string; diff?: string }>` | Patch entries all target the top-level `path`; separate calls for different files.                                        |
| `apply_patch` | `input`                                                                                           | Combined `*** Begin Patch` payload with `*** Add File`, `*** Update File`, `*** Move to`, and `*** Delete File` sections. |
| `sloppy`      | `input`                                                                                           | `*** Edit File: path`, then `*** Find` plus `*** Replace`, `*** Insert Before`/`After`, `*** Cut`, or `*** Paste Before`/`After`. |

`sloppy` uses existing-text anchors, not snapshot tags. Find must identify one match unless it is `*** Find all` (or the file header ends in ` all`), which changes every match; for a bare identifier that means whole words. Bodies are raw text, without diff prefixes or closing markers. `…` in Find captures omitted text; Replace re-emits those captures in order. A Find of a first line, a `…` line, and a last line addresses a block, closing at the line that ends that block rather than a nested or continued one. Insert keeps the anchor and treats `…` literally. `*** Cut` takes the matched lines and the next `*** Paste Before`/`*** Paste After` puts them beside its own match; neither has a body, and a paste that fails leaves the block in place. A Find with no action is rejected. Every pair addresses the original file; matching/validation failures occur before writes.

For a whole multiline construct, put the action and the opening-line prefix on one line: `*** Replace Block: opener`, `*** Delete Block: opener`, `*** Cut Block: opener`, or `*** Paste Before Block: opener` / `*** Paste After Block: opener`. The header only locates the old block. Replace takes the complete final code, including the opening line if it stays; the other block actions take no body. An unresolved syntax block, shared closing line, or ambiguous opener is rejected. Use a text Find with distinctive context instead. `Delete Block` also accepts two adjacent byte-identical copies: it keeps the first and removes the separator and second copy.

The mode prompts in `crates/edit/prompts/` define the full syntax.

`apply_patch` matches complete old/context lines in this order: exact, trailing
whitespace trimmed, both ends trimmed, then Unicode punctuation normalized.
It never uses substring or character-similarity matching, regardless of the
fuzzy settings for other modes. Repeated context binds to the first match at
or after the previous hunk; unmatched context rejects the entire envelope
before any writes. Numeric prefixes in old and new lines remain literal text,
not recovered line-number annotations.

An `*** Update File` followed only by `*** Move to:` renames a UTF-8 file
without changing its bytes or permissions. An empty update without a move
still rejects, as do missing sources and occupied destinations.

Envelope sections see the results of earlier sections in order. A move vacates
its source before a later add, and subsequent updates can target the moved
file. Preview and application validate this same virtual namespace before
the first filesystem write; a later invalid section leaves all files unchanged.

## Output and side effects

Hashline applies in one tool call; it does not use the staged `xd://resolve` / `xd://reject` flow used by `ast_edit`.

A successful hashline section returns a fresh `[path#TAG]` header, optional block-resolution and move lines, a compact post-edit preview when available, and a `Warnings:` block when recovery or normalization produced warnings. `EditToolDetails` can include the unified `diff`, `firstChangedLine`, diagnostics, operation (`update` or `delete` in hashline mode), path/move metadata, `oldText` / `newText`, `snapshotsPruned`, and per-file results. Multi-section input returns one aggregate result. Stored before/after snapshot text is capped at 32,768 characters per file and across a multi-file result; later entries may retain their diff but omit snapshot text.

Native parse/match/application and writer failures return `isError: true` with their diagnostic text and `details.errorKind`, the engine's class of the failure: `unseen_lines`, `stale_tag`, `unknown_tag`, `other_file_tag` (a tag this session issued for another file), `missing_tag`, `header_only`, `out_of_range`, `ambiguous_boundary`, `no_change`, `file_not_found`, `parse`, `no_match`, `invalid_utf8`, `plan_mode`, `unresolved_url`, `io`, `write_failed`, or `apply` for the rest; a file's failure in a multi-file call keeps its own class, and `/session` counts failed edits by it. Native bridge failures may throw. Updates run through the ACP bridge or LSP writethrough, so configured formatting can change the persisted text. A newly introduced syntax parse failure does not roll back the edit: it produces a warning, or an additional repair note when `edit.autoRepair.enabled` successfully repairs it.

The streaming renderer parses complete portions of an in-flight payload and computes read-only diffs. Streaming preview skips transient unresolved blocks, stale tags, and empty pastes rather than presenting partial input as a final failure. Execution re-reads and validates normally.

For multi-section calls, every section is parsed and prepared before writes begin so syntax, anchor, and no-op failures fail fast. Files then write in order; an operating-system write failure can leave the already-landed prefix applied. Named-register session state is advanced only for that landed prefix.

## Limits and validation

- Snapshot tags are four uppercase hexadecimal characters derived from normalized file content and recorded in the session snapshot store.
- A section with a placeholder tag (`#AUTO`, `#????`, a bare `#`) or no tag, and input that is only a header with no ops, are rejected without writing. Like an unknown-tag mismatch, the reply carries the file's current tag, plus anchored context when the section has anchors.
- `read`/`grep` exposure matters: with `edit.enforceSeenLines=true` (default), edits targeting lines outside recorded visible ranges are rejected. Re-read elided or undisplayed ranges before editing them. When the store holds no read of the tagged content (new process, evicted snapshot), only anchors on lines longer than the narrowest display column cap (grep's 512 bytes, or a lower `tools.outputMaxColumns`) are rejected, since only those can have been shown cut.
- Ranges are inclusive, must be ordered, and are bounded by a parser amplification limit of 100,000 expanded lines before the target file's actual bounds are checked.
- Conflicting overlapping ranges are rejected. Exact repeated replacement ranges can coalesce to the later body with a warning; author one final-content hunk per range.
- The rows a mismatch reply prints count as seen for a resend under the tag it hands back: content no retained snapshot holds starts from them, and a retained read's seen set gains them. A resend anchored elsewhere gets the seen-line rejection and reveal. Content recorded with no or an empty seen set (as `write` records) stays unrestricted.
- Same-path sections are merged so their original line anchors apply together. Clipboard operations are rejected if interleaved same-path sections would make authored register order ambiguous.
- Stale tags attempt snapshot-based recovery. Recovery applies only when the recorded snapshot chain proves a unique safe result; otherwise a mismatch with current context is returned. A recovery that shifts line numbers is also refused when a replacement body closely matches the current lines at its authored numbers but not the lines the shift targets (a heuristic for numbers read from the current file instead of the tagged read), or when it breaks the syntax of a file that parsed.
- A single-section byte-identical edit returns a no-change diagnostic without writing; the third consecutive identical no-op is an error. In multi-section calls, any no-op rejects the batch before writes.
- `edit.blockAutoGenerated=true` (default) rejects files recognized as generated. Plan mode permits updates only within writable roots and refuses all deletes/moves.
- A target that is not a regular file (FIFO, socket, character or block device, including through a symlink) is refused in every mode: reading it in-process can block forever or never end.
- File-backed mutable internal URLs can be edited. Read-only schemes and handler-owned writes (`agent://`, `proc://`, etc.) are refused; use `write` for those handlers. Partial/line selectors are not edit targets.
- Approval uses the strictest write tier among all targets and move destinations.

## Common failures

- Missing/malformed `[PATH#TAG]`, unknown snapshot tag, or a path that no longer exists.
- Anchor outside the file, outside the recorded seen-line ranges, in an elided region, or based on a stale snapshot that cannot be recovered safely.
- Reversed or overlapping ranges.
- Empty body for a body-backed `PUT`, body rows under a bodyless operation, unknown named register, or anonymous paste before an unambiguous anonymous cut.
- Block anchor on an unsupported/invalid syntax tree, blank/closing line, or single-line node.
- Unified-diff contamination (`@@`, apply-patch sentinels, `-old` rows) instead of hashline operations and final-content `+` rows.
- `REM` / `MV` conflicts, invalid or same-source move destinations, or filesystem write failures.
- A no-change section in a multi-section batch, or the third consecutive identical single-section no-op.
- Non-regular target: `Cannot edit '<path>': it is a <kind>, not a regular file or directory.`

The parser has limited recovery for common model slips (optional envelope, benign header noise, some bare rows and range spellings), and surfaces warnings when it repairs input. Callers SHOULD emit only the canonical grammar above; recovery behavior is not a second public syntax.
