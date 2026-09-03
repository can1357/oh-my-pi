# @oh-my-pi/hashline

A compact, line-anchored patch language and applier.

Hashline is a diff format designed for LLM-driven file edits. It binds every
hunk to a file-content hash so stale anchors are rejected before they corrupt
code, and it abstracts over the filesystem so the same patcher works on disk,
in memory, over the network, or against any custom backend.

## Quick start

```ts
import {
	Filesystem,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patcher,
	Patch,
} from "@oh-my-pi/hashline";

const fs = new InMemoryFilesystem();
const snapshots = new InMemorySnapshotStore();
const before = `const greeting = "hi";\nexport { greeting };\n`;
await fs.writeText("hello.ts", before);

const tag = snapshots.record("hello.ts", before);
const patcher = new Patcher({ fs, snapshots });
const patch = Patch.parse(String.raw`[hello.ts#${tag}]
PUT 1.=1:
+const greeting = "hello";`);
const result = await patcher.apply(patch);

console.log(result.sections[0].op); // "update"
console.log(await fs.readText("hello.ts"));
```

## Format

See [`src/prompt.md`](./src/prompt.md) for the user-facing description and
[`src/grammar.lark`](./src/grammar.lark) for the formal grammar.

Each file section starts with `[PATH#TAG]`. The tag is a 4-hex
content hash of the full normalized file text recorded by the
`SnapshotStore`, and it is not meaningful outside that store. The patcher
protects against stale anchors by resolving the tag, verifying the live file
still matches the recorded content hash, and refusing or attempting
session-aware recovery on mismatch.

Inside a section:
- `PUT A.=B:` — replace lines A through B (inclusive) with following `+TEXT` body rows.
- `PUT A*:` — replace the syntactic block beginning on line A.
- `PUT <A:` / `PUT >A:` — insert following body rows before/after line A (`<1` = head, `>$` = tail).
- `PUT >A*:` — insert following body rows after the resolved block's last line.
- `PUT <A` / `PUT >A` / `PUT A.=B @name` / `PUT A* @name` — paste a captured register at a gap, over a range, or over a resolved block (no `:` header or body rows; `@name` is optional only at gaps).
- `CUT A.=B` / `CUT A*` — delete concrete lines or a resolved block and capture them (anonymous, or `@name` when given).
- `REM` — delete the whole file named by the section header.
- `MV DEST` — move/rename the section file to `DEST` (optionally after line edits).
- `+TEXT` — literal body row (use `+` alone for a blank line).

## Abstractions

### `Filesystem`

Read and write text by path. The default implementations:

- `InMemoryFilesystem` — backed by a `Map`. Tests, sandboxes.
- `NodeFilesystem` — disk-backed via `Bun.file`/`Bun.write`. Default for CLIs.

Subclass `Filesystem` to wire hashline into any storage: VFS, S3, an LSP
text-document protocol, a Git tree, anything.

### `SnapshotStore`

Required. Hashline tags are full-file content hashes recorded per path, so
`Patcher` must receive the store that observed them. Recovery replays edits
against the cached pre-edit snapshot and 3-way-merges onto current content
when the live file diverged.

### `Patcher`

The orchestration class. Reads, normalizes line endings + BOM, applies edits,
restores line endings, and writes via the configured `Filesystem`. Multi-section
patches are preflighted up front so a partial batch never lands.
