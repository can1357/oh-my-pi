# Lane A — Shared pairing + session-list contract [pre-phase]

## 1. Mission + read-first

You are the `[pre-phase]` sub-agent for phone/remote simplicity at `C:/Dev/desktop-projects/oh-my-pi-fork` (with read access to `C:/Dev/desktop-projects/pi-speak-extension`). Freeze the shared happy-path contract that lanes B–D implement.

**Read first** (each in full):
- `.prd/phone-remote-simplicity-orchestration.md`
- `docs/collab.md`
- `C:/Dev/desktop-projects/pi-speak-extension/README.md` (pairing + Agent Hub sections)
- `C:/Dev/desktop-projects/pi-speak-extension/SPEC.md` (cwd / turn contract)
- `C:/Dev/desktop-projects/pi-speak-extension/pairing.ts`
- `C:/Dev/desktop-projects/pi-speak-extension/agent-hub-dashboard.ts` (exported types + `defaultOhMyPiSessionRoots`)

## 2. Owned files

You may ONLY edit these files:
- `docs/phone-remote-happy-path.md` (new)
- `.prd/phone-remote-simplicity-ownership.json` (new)

You may NOT edit any other file, including `docs/collab.md`, Android sources, gateway sources, or lane PRDs.

## 3. Gap (verbatim from the table)

> A — Shared pairing + session-list contract: Freeze one happy-path pairing URL/token contract and shared session-list fields (MEDIUM) depends on: none | files: `docs/phone-remote-happy-path.md`, `.prd/phone-remote-simplicity-ownership.json`

## 4. What to build

### `docs/phone-remote-happy-path.md`
Must include:
1. **Primary phone path**: `/remote` / pk-speak gateway QR (`pi-speak://setup?...` or `/connect?token=...`) as the default "scan to connect" path.
2. **Sibling paths** (non-primary): `/collab` and `/remote-control` (ephemeral encrypted relay sharing) — when to use each, and that they are NOT the persistent phone gateway.
3. **QR payload fields**: base URL, install auth token, optional default target/session, optional workspace — no manual IP/token typing after scan.
4. **Session list parity fields** phone must show to match ompk Agent Hub / `←←` / `/background`: id/name, status, cwd/project, background subagents if present, path/resume handle.
5. **CWD policy**: voice/global turns use `AGENT_CWD` → `AGENT_WORKSPACE` → process cwd; only navigate/drop-in when user asks.
6. **`sm` lookup**: document `sm sessions list` / `sm get <id-or-title>` as the offline/CLI recovery path complementary to live dashboard auto-load.

### `.prd/phone-remote-simplicity-ownership.json`
Machine-readable mirror of the orchestration ownership matrix + required deliverables per lane + cleanup globs (`findings-*.md`).

## 5. Hard constraints

1. No new npm dependencies.
2. Docs only — no runtime code changes.
3. No edits outside owned files. Verify via `git diff --name-only`.
4. Do not invent APIs that do not exist; cite real symbols (`getOrCreateInstallAuthToken`, `buildOhMyPiAgentHubDashboardCached`, `resolveAgentWorkspace`).
5. Keep `/collab` vs `/remote` distinction consistent with `docs/collab.md`.
6. OMP subagent hint: skip project-wide build/test/lint/format.

## 6. Verification

```bash
test -f docs/phone-remote-happy-path.md
test -f .prd/phone-remote-simplicity-ownership.json
git diff --name-only
```

Expected:
- both files exist
- `git diff --name-only` lists ONLY the two owned files

## 7. Commit message

`docs(phone-remote): freeze pairing and session-list happy-path contract (Gap A)`

## 8. Final report

```
### Lane A final report
- Worktree path / branch:
- Files modified / created:
- Public exports added (signatures): none
- @ts-expect-error suppressors added: none
- Lines added / removed:
- Verification:
  - files exist: ___
  - git diff --name-only: ___
- Flags / blockers:
```
