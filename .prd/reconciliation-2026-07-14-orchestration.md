# Reconciliation Orchestration — 2026-07-14

## 1. Purpose

Close the 7 P1 and 9 P2 findings from the parallel code review of the uncommitted
composer/Ask-mode + snapcompact-removal changes. Parallel dispatch is justified:
findings span four disjoint subsystems (session/compaction, interactive composer,
TUI editor, docs/tests) with an empty file-ownership intersection.

Worktree isolation is intentionally NOT used: the changes under reconciliation are
uncommitted, so worktrees cannot see them. All lanes edit the shared working tree
under strict disjoint file ownership.

## 2. Letter-group dispatch table

| Letter | Lane | Archetype | Effort | Depends on | Files |
|---|---|---|---|---|---|
| A | Session & compaction | `[remediation]` | LARGE | none | compact-modes.ts, agent-session.ts, session-context.ts, builtin-registry.ts, shared-events.ts, custom-tools/types.ts, compact tests |
| B | Composer & Ask mode | `[remediation]` | LARGE | none | interactive-mode.ts, input-controller.ts, composer/work-modes.ts, selector/command/extension-ui/mcp controllers, composer.test.ts |
| C | TUI editor | `[remediation]` | MEDIUM | none | packages/tui/src/components/editor.ts, editor-bottom-section.test.ts |
| D | Docs & stale UI tests | `[remediation]` | SMALL | none | .wiki/concepts/recent-history-2026-07.md, context-usage.test.ts, compaction-divider.test.ts |
| E | Acceptance gate | `[acceptance-gate]` | MEDIUM | A–D | main agent: project-wide `bun check`/tests |

## 3. File-ownership matrix (parallel intersection must be empty)

| File | A | B | C | D |
|---|---|---|---|---|
| packages/coding-agent/src/session/compact-modes.ts | own | – | – | – |
| packages/coding-agent/src/session/agent-session.ts | own | – | – | – |
| packages/coding-agent/src/session/session-context.ts | own | – | – | – |
| packages/coding-agent/src/slash-commands/builtin-registry.ts | own | – | – | – |
| packages/coding-agent/src/extensibility/shared-events.ts | own | – | – | – |
| packages/coding-agent/src/extensibility/custom-tools/types.ts | own | – | – | – |
| packages/coding-agent/test/compact-modes.test.ts | own | – | – | – |
| packages/coding-agent/test/slash-commands/compact.test.ts | own | – | – | – |
| packages/coding-agent/src/modes/interactive-mode.ts | – | own | – | – |
| packages/coding-agent/src/modes/controllers/*.ts | – | own | – | – |
| packages/coding-agent/src/modes/components/composer/work-modes.ts | – | own | – | – |
| packages/coding-agent/src/modes/types.ts | – | own | – | – |
| packages/coding-agent/src/debug/index.ts | – | own | – | – |
| packages/coding-agent/test/composer.test.ts | – | own | – | – |
| packages/tui/src/components/editor.ts | – | – | own | – |
| packages/tui/test/editor-bottom-section.test.ts | – | – | own | – |
| .wiki/concepts/recent-history-2026-07.md | – | – | – | own |
| packages/coding-agent/test/modes/context-usage.test.ts | – | – | – | own |
| packages/coding-agent/test/modes/components/compaction-divider.test.ts | – | – | – | own |

## 4. Execution sequence

1. Lanes A–D dispatched in ONE `task` call (`tasks[]`), shared working tree, disjoint ownership.
2. Main agent (Lane E) runs project-wide gates after all lanes yield:
   `bun --cwd=packages/coding-agent test <targeted files>`, `bun --cwd=packages/tui test`,
   type checks limited to changed packages, `git diff --name-only` audit.
3. No commits (user did not request one).

## 5. Acceptance criteria checklist

- [ ] `bun test packages/coding-agent/test/compact-modes.test.ts` exits 0
- [ ] `bun test packages/coding-agent/test/slash-commands/compact.test.ts` exits 0
- [ ] `bun test packages/coding-agent/test/modes/context-usage.test.ts` exits 0 (or file deleted)
- [ ] `bun test packages/coding-agent/test/modes/components/compaction-divider.test.ts` exits 0
- [ ] `bun test packages/coding-agent/test/composer.test.ts` exits 0 and asserts retain/memory_edit exclusion
- [ ] `bun test packages/tui/test/editor-bottom-section.test.ts` exits 0 with maxHeight-cap + narrow-width tests
- [ ] `computeAskModeTools` excludes retain/memory_edit (work-modes.ts)
- [ ] Every editorContainer restore path remounts the full composer (grep shows restore helper usage)
- [ ] Ask exits before Plan/Goal entry; session switch never applies source Ask snapshot
- [ ] `.wiki` lines 50/59/60/62/63 corrected to match implementation
- [ ] `AutoCompaction*`/`CustomToolSessionEvent` unions keep deprecated "snapcompact" literal
