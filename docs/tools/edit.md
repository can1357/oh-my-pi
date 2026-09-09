# edit

> Applies source edits. The default `hashline` mode consumes one line-anchored patch string and edits existing files directly.

## Source
- Entry and mode registration: `packages/coding-agent/src/edit/index.ts`
- Hashline schema: `packages/coding-agent/src/edit/hashline/params.ts`
- Model-facing hashline prompt: `packages/hashline/src/prompt.md`
- Canonical constrained-decoding grammar: `packages/hashline/src/grammar.lark`
- Parser and application: `packages/hashline/src/input.ts`, `packages/hashline/src/parser.ts`, `packages/hashline/src/apply.ts`
- Snapshot validation/recovery: `packages/hashline/src/snapshots.ts`, `packages/hashline/src/patcher.ts`, `packages/hashline/src/recovery.ts`
- Coding-agent execution/result shaping: `packages/coding-agent/src/edit/hashline/execute.ts`
- Streaming preview strategy: `packages/coding-agent/src/edit/streaming.ts`, `packages/coding-agent/src/edit/hashline/diff.ts`

## Mode selection and availability

`edit` is an essential built-in tool. `resolveEditMode()` selects the active wire contract in this order:

1. model-specific configured variant;
2. `PI_EDIT_VARIANT`;
3. `edit.mode`;
4. default `hashline`.

Supported modes are `hashline`, `apply_patch`, `patch`, and `replace`. Unless `PI_STRICT_EDIT_MODE` is set, a short model exclusion list can replace the default hashline contract with `replace`. This page documents the default hashline contract; the tool's schema, prompt, examples, renderer, and optional custom Lark format all switch with the selected mode. In `apply_patch` custom-tool mode the wire name is `apply_patch`; dispatch still reaches the same internal tool.

## Input

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | One or more `[PATH#TAG]` sections containing hashline operations. The strict custom-tool grammar wraps the sections in `*** Begin Patch` / `*** End Patch`; the normal parser also accepts an unwrapped payload. |

Each section edits one existing file and MUST copy the four-uppercase-hex snapshot tag from the latest anchored `read`, `grep`, or successful `edit` result:

```text
[src/example.ts#1A2B]
PUT 4.=4:
+const value = 2;
```

Use `write` to create or wholly overwrite a file. Hashline rejects untagged anchored edits at application time.

## Canonical patch language

All line numbers refer to the original tagged snapshot, not to earlier hunks in the same call.

| Form | Effect |
| --- | --- |
| `PUT N.=M:` | Replace inclusive original lines `N..M` with the following `+TEXT` rows. |
| `PUT N*:` | Replace the multi-line syntactic block beginning on line `N`. |
| `PUT <N:` / `PUT >N:` | Insert body rows immediately before / after line `N`. `PUT <1:` is file head. |
| `PUT >$:` | Append body rows at file tail. |
| `PUT >N*:` | Insert after the syntactic block beginning on line `N`. |
| `CUT N.=M` / `CUT N*` | Delete and capture an inclusive range or resolved block. Add `@name` to write a named register. |
| `PUT <N` / `PUT >N` / `PUT >$` | Paste the anonymous register into a gap. |
| `PUT <N @name` / `PUT >N @name` / `PUT >$ @name` | Paste a named register into a gap. |
| `PUT N.=M @name` / `PUT N* @name` | Replace a range or block with a named register. Named registers are required for span/block paste. |
| `REM` | Delete the section file. |
| `MV DEST` | Move/rename the section file after any preceding edits in that section. Quote destinations containing spaces. |

Register names contain ASCII letters, digits, `_`, or `-`. The anonymous register is batch-local and starts empty on every call. Named registers persist for the session and are published only after their writes land. Operations run top-to-bottom across sections, so a cut in an earlier section can feed a later paste. Repeating a paste does not consume its register.

Only body-bearing `PUT ...:` headers take body rows. Every body row is `+TEXT`; `+` alone inserts a blank line. The body is final content, never a unified-diff before/after pair. Literal content beginning with `-` or `+` is written as `+-...` or `++...`. `CUT`, register-backed `PUT`, `REM`, and `MV` take no body.

### Block anchors

Block forms resolve from the opening line through the tree-sitter node's end. Anchor the construct opener, never a closing delimiter, last visible line, blank line, or inner statement. A single-line node is rejected with guidance to use the corresponding explicit-line operation. `PUT >N*:` lowers to ordinary `PUT >N:` with a warning when no block resolves; replace/cut block forms fail instead of guessing.

Leading decorators, attributes, and doc-comments may be separate syntax nodes. Anchor the first decorator when the parser groups it with the declaration; otherwise use an explicit range. Standalone line comments are not swept automatically. In Markdown, a heading's block includes its body and deeper subsections through the next heading of equal or higher level.

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

## Output and side effects

Hashline applies in one tool call; it does not use the staged `xd://resolve` / `xd://reject` flow used by `ast_edit`.

A successful section returns a fresh `[path#TAG]` header, optional block-resolution and move lines, a compact post-edit preview when available, and a `Warnings:` block when recovery or normalization produced warnings. `EditToolDetails` can include the unified `diff`, `firstChangedLine`, diagnostics/format results, operation (`update` or `delete` in hashline mode), path/move metadata, snapshots, and per-file results. Multi-section input returns one aggregate result.

The streaming renderer parses complete portions of an in-flight payload and computes read-only diffs. Streaming preview skips transient unresolved blocks, stale tags, and empty pastes rather than presenting partial input as a final failure. Execution re-reads and validates normally.

For multi-section calls, every section is parsed and prepared before writes begin so syntax, anchor, and no-op failures fail fast. Files then write in order; an operating-system write failure can leave the already-landed prefix applied. Named-register session state is advanced only for that landed prefix.

## Limits and validation

- Snapshot tags are four uppercase hexadecimal characters derived from normalized file content and recorded in the session snapshot store.
- `read`/`grep` exposure matters: edits targeting lines outside the recorded visible ranges are rejected. Re-read elided or undisplayed ranges before editing them.
- Ranges are inclusive, must be ordered, and are bounded by a parser amplification limit of 100,000 expanded lines before the target file's actual bounds are checked.
- Overlapping edits or multiple operations targeting the same original anchor are rejected.
- Same-path sections are merged so their original line anchors apply together. Clipboard operations are rejected if interleaved same-path sections would make authored register order ambiguous.
- Stale tags attempt snapshot-based recovery. Recovery applies only when the recorded snapshot chain proves a unique safe result; otherwise a mismatch with current context is returned.
- A byte-identical edit is an error. Repeating the same no-op payload three times escalates through the no-op loop guard.

## Common failures

- Missing/malformed `[PATH#TAG]`, unknown snapshot tag, or a path that no longer exists.
- Anchor outside the file, outside the recorded seen-line ranges, in an elided region, or based on a stale snapshot that cannot be recovered safely.
- Reversed or overlapping ranges.
- Empty body for a body-backed `PUT`, body rows under a bodyless operation, unknown named register, or anonymous paste before an unambiguous anonymous cut.
- Block anchor on an unsupported/invalid syntax tree, blank/closing line, or single-line node.
- Unified-diff contamination (`@@`, apply-patch sentinels, `-old` rows) instead of hashline operations and final-content `+` rows.
- `REM` / `MV` conflicts, invalid move destinations, target collisions, or filesystem write failures.
- A patch that parses and applies to exactly the existing bytes (no change).

The parser has limited recovery for common model slips (optional envelope, benign header noise, some bare rows and range spellings), and surfaces warnings when it repairs input. Callers SHOULD emit only the canonical grammar above; recovery behavior is not a second public syntax.
