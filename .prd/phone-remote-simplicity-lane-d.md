# Lane D — Voice global-CWD + Agent Hub phone parity [parallel-builder]

## 1. Mission + read-first

You are the `[parallel-builder]` sub-agent for voice workspace defaults and Agent Hub pickup parity. Voice should be comfortable globally unless asked to navigate/drop into a session; phone hub should mirror ompk `←←` / `/background` lanes.

**Read first**:
- `.prd/phone-remote-simplicity-orchestration.md`
- `docs/phone-remote-happy-path.md`
- `C:/Dev/desktop-projects/pi-speak-extension/agent-provider-factory.ts`
- `C:/Dev/desktop-projects/pi-speak-extension/session-working-directory.ts`
- `C:/Dev/desktop-projects/pi-speak-extension/realtime-gateway.ts` (tool prompt + session tools section)
- `C:/Dev/desktop-projects/pi-speak-extension/agent-hub-actions.ts`
- `packages/coding-agent/src/modes/components/agent-hub.ts` (behavior reference)

## 2. Owned files

You may ONLY edit:
- `C:/Dev/desktop-projects/pi-speak-extension/agent-provider-factory.ts`
- `C:/Dev/desktop-projects/pi-speak-extension/session-working-directory.ts`
- `C:/Dev/desktop-projects/pi-speak-extension/realtime-gateway.ts` (voice tool prompt + default cwd behavior only — keep diffs tight)
- `C:/Dev/desktop-projects/pi-speak-extension/agent-hub-actions.ts` (parity glue only)
- Focused tests you create/update under `pi-speak-extension/tests/` for cwd defaults / hub parity
- `packages/coding-agent/src/modes/components/agent-hub*.ts` **only if** a minimal parity fix is required and listed in the report

You may NOT edit pairing/QR (B) or dashboard session-root merge (C).

## 3. Gap (verbatim from the table)

> D — Voice global-CWD + hub parity: Default voice to global workspace; phone hub matches ompk `←←` / `/background` (LARGE) depends on: A | files: provider factory, cwd helpers, realtime defaults, hub actions

## 4. What to build

1. Confirm/implement default launch path: no explicit turn `cwd` → `AGENT_CWD`/`AGENT_WORKSPACE`/process cwd (global comfort), not a forced project picker.
2. Voice assistant instructions: operate globally; navigate or switch/drop into sessions only when asked.
3. Ensure phone hub actions can pick up/continue the same background lanes Agent Hub shows (chat/steer/revive/archive as already supported — close parity gaps only).
4. Tests for default cwd resolution and at least one hub-parity assertion.

## 5. Hard constraints

1. No new npm dependencies.
2. No project-wide gates in the worktree.
3. Keep realtime-gateway edits minimal and localized.
4. Do not change QR pairing or session-root scanning owned by C.
5. Additive behavior only.

## 6. Verification

```bash
cd C:/Dev/desktop-projects/pi-speak-extension
node --test tests/*cwd*.mjs tests/*provider*.mjs tests/*hub*.mjs 2>/dev/null || true
git diff --name-only
```

## 7. Commit message

`feat(remote): global voice cwd defaults and Agent Hub phone parity (Gap D)`

## 8. Final report

```
### Lane D final report
- Worktree path / branch:
- Files modified / created:
- Public exports added (signatures):
- @ts-expect-error suppressors added:
- Lines added / removed:
- Verification:
  - focused tests: ___
  - git diff --name-only: ___
- Flags / blockers:
```
