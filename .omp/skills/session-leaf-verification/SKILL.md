---
name: session-leaf-verification
description: Exhaustively checks the session-tree leaf contract (replay, off-branch writes, persistence) for changes to SessionManager, session entries, or resume. Use before touching session leaf/branch/replay code.
---

# Session leaf verification

## What is verified

Two promises the session journal makes to a user:

1. Reopening a session lands on the branch the user was on when it closed. A
   late result from a branch the user already left (a background bash result, a
   usage record) must never steal the leaf.
2. Every entry the manager hands out belongs to a chain that reaches the root,
   and replaying the journal in file order reproduces the live leaf.

Breaking either loses the user's place or shows them the wrong conversation
after a resume. `packages/coding-agent/test/session/off-branch-leaf-replay.test.ts`
pins the one reported case; this check covers the interleavings around it.

## Run it

From the repository root:

```sh
bun .omp/skills/session-leaf-verification/verify.ts        # depth 4, ~2 s, 1554 sequences
bun .omp/skills/session-leaf-verification/verify.ts 6      # depth 6, 55986 sequences
```

Exit 0 prints `OK: N operation sequences up to depth D held ...`. Exit 1 prints
the shortest failing sequence, the property it broke, and the entry dump. Use
depth 5 or 6 before shipping a change here; depth 4 is the quick loop.

To rerun one printed sequence with a per-step trace:

```sh
VERIFY_SEQUENCE='append user|append answer|branch to first user|off-branch result on first answer' \
  bun .omp/skills/session-leaf-verification/verify.ts 4
```

## How it works

The script drives the real `SessionManager` (no model of it) through every
sequence of six operations up to the requested depth, replayed from scratch in
a fresh temp directory:

| Step | Call |
| --- | --- |
| append user | `appendMessage(user)` |
| append answer | `appendMessage(assistant)` |
| branch to first user | `branch(firstUser)` |
| off-branch result on first answer | `appendMessageToBranch(late, firstAnswer)` |
| off-branch usage on first answer | `appendModelUsage(usage, { sessionId, parentId: firstAnswer })` |
| reopen | `ensureOnDisk()`, `close()`, `SessionManager.open(file)` |

After every step it asserts:

- **P0 off-branch write** an `appendMessageToBranch()` without
  `preserveActiveLeaf: false` leaves `getLeafId()` unchanged. This is the
  reported bug class. `preserveActiveLeaf: false` is the re-answered `ask` path
  and is intentionally not exercised here. The same holds for an
  `appendModelUsage()` whose parent is not the current leaf (usage recorded on
  its initiating branch after the user moved on).
- **P1 replay agreement** `resolveSessionLeafId(getEntries())` equals
  `getLeafId()` after any step that appended an entry.
- **P2 no dangling leaf** the leaf is null or names a stored entry.
- **P3 branch is a chain** `getBranch()` walks parent links back to the root and
  ends at the leaf.
- **P4 persistence** after `ensureOnDisk()` and `close()`, reopening reproduces
  the same leaf and the same branch entry types.

Deliberate non-goals:

- A bare `branch()` is transient by design (`SessionManager.branch`: "Existing
  entries are never modified or deleted"). P1 and P4 are only asserted after a
  step that actually appended, so a rewind that wrote nothing is not treated as
  a failure.
- A session with no assistant message and no `ensureOnDisk()` call has no file
  yet, so P4 is skipped until one exists.
- Concurrency: the harness is single-threaded and does not model two writers,
  file locks, or crash-during-write. Those live in the storage layer.

## Proven able to fail

Each check was run against a deliberately broken tree and failed as expected,
then the tree was restored:

| Break | Result |
| --- | --- |
| `appendMessageToBranch` stops recording `activeLeafId` (the pre-#16483 shape) | P0 fails at depth 2: `off-branch append moved the leaf: c719a85e -> 3657a0a7` |
| `appendModelUsage` stops recording `activeLeafId` | P1 fails at depth 3: `append answer -> append user -> off-branch usage on first answer` |
| `resolveSessionLeafId` ignores the captured leaf | P1 fails at depth 2: `live leaf bf16ee5c, replayed leaf f4fea7cd` |

P2 and P3 are structural assertions on the same data. They guard against an
index bug (a stale leaf id, a broken parent link) rather than a rule change, so
no separate break was staged for them.

## Coverage

| Code | Role |
| --- | --- |
| `packages/coding-agent/src/session/session-manager.ts` | `appendMessage`, `appendMessageToBranch`, `appendModelUsage`, `branch`, `ensureOnDisk`, `close`, `getLeafId`, `getBranch`, `getEntries` |
| `packages/coding-agent/src/session/session-entries.ts` | `sessionEntryLeafId`, `resolveSessionLeafId`, `SessionEntryBase.activeLeafId` |
| `packages/coding-agent/src/session/session-index.ts` | `insert`, `rebuild`, leaf tracking |
| `packages/coding-agent/src/session/session-loader.ts` | the reopen path used by `SessionManager.open` |

`packages/coding-agent/test/session/session-leaf-exhaustive.test.ts` runs the
harness at depth 3 under `bun test`, and the package typecheck compiles
`verify.ts` through that import, so a rename or signature change in the session
modules fails CI instead of waiting for a manual run.

## When the code changes

1. Run depth 5. A failure prints the sequence and the property. Reproduce it
   with `VERIFY_SEQUENCE`, then check whether the code or the harness is wrong.
2. A real failure means the leaf rule changed or the journal lost a field.
   Fix the code, not the assertion, unless the product decision changed.
3. New leaf-selection API (another append path, another entry type that selects
   a leaf) belongs in `STEPS`; add it with the same "appended" detection so P1
   and P4 stay scoped to real writes.
4. Intended behavior change (for example a new durable rewind marker) updates
   the non-goals in this file in the same commit.
5. Keep the depth-3 `bun test` green; it is the sync check for this file.
