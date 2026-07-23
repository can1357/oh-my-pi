# Lane C — Mesh session auto-load + sm lookup [parallel-builder]

## 1. Mission + read-first

You are the `[parallel-builder]` sub-agent for session discovery in `pi-speak-extension`. On phone connect, auto-load pk-mesh / omp sessions and make `sm` lookup usable for recovery.

**Read first**:
- `.prd/phone-remote-simplicity-orchestration.md`
- `docs/phone-remote-happy-path.md`
- `C:/Dev/desktop-projects/pi-speak-extension/agent-hub-dashboard.ts`
- `C:/Dev/desktop-projects/pi-speak-extension/realtime-session-target.ts`
- `C:/Dev/desktop-projects/pi-speak-extension/session-routing.ts`
- `sm --help` / session-manager skill surface (`sm sessions list`, `sm get`)

## 2. Owned files

You may ONLY edit:
- `C:/Dev/desktop-projects/pi-speak-extension/agent-hub-dashboard.ts`
- `C:/Dev/desktop-projects/pi-speak-extension/session-routing.ts` (dashboard merge hooks only)
- `C:/Dev/desktop-projects/pi-speak-extension/realtime-session-target.ts`
- New/existing focused tests under `C:/Dev/desktop-projects/pi-speak-extension/tests/` for dashboard/session auto-load
- Optional small helper module under `pi-speak-extension/` for `sm`-compatible session lookup **only if** needed and listed in your final report as owned

You may NOT edit pairing/QR/Android (B), provider factory / realtime prompt defaults / hub actions (D).

## 3. Gap (verbatim from the table)

> C — Mesh session auto-load + `sm`: Auto-load pk-mesh/omp sessions into phone dashboard; expose/document `sm` lookup (LARGE) depends on: A | files: `agent-hub-dashboard.ts`, session target/routing, tests

## 4. What to build

1. Ensure `defaultOhMyPiSessionRoots` / `buildOhMyPiAgentHubDashboardCached` / `mergeOhMyPiAgentHubSessionsCached` cover the mesh session roots the phone should see by default.
2. Make connect-time dashboard payloads include those sessions without an extra manual refresh step when feasible.
3. Add a documented or coded bridge for `sm` lookup (`sm sessions list` / `sm get`) — prefer a thin helper + test if wiring is straightforward; otherwise leave a precise integration note for Lane E and do not fake an API.
4. Preserve stale-while-revalidate caching behavior.

## 5. Hard constraints

1. No new npm dependencies.
2. No project-wide gates in the worktree.
3. No edits outside owned files.
4. Do not change QR pairing or voice CWD defaults.
5. Additive, backward-compatible dashboard fields only.

## 6. Verification

```bash
cd C:/Dev/desktop-projects/pi-speak-extension
node --test tests/*dashboard*.mjs tests/*session*.mjs 2>/dev/null || bun test tests 2>/dev/null | head
git diff --name-only
```

## 7. Commit message

`feat(remote): auto-load pk-mesh Agent Hub sessions for phone dashboard (Gap C)`

## 8. Final report

```
### Lane C final report
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
