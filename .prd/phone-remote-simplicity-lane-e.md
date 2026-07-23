# Lane E — Cross-repo acceptance + evidence [acceptance-gate]

## 1. Mission + read-first

You are the `[acceptance-gate]` sub-agent. Integrate lane outputs, run focused verification across both repos, write evidence, and delete findings fragments.

**Read first**:
- `.prd/phone-remote-simplicity-orchestration.md`
- `docs/phone-remote-happy-path.md`
- Any `findings-*.md` fragments
- Lane B/C/D final reports

## 2. Owned files

You may ONLY edit:
- `docs/phone-remote-acceptance.md` (new)
- `.prd/phone-remote-simplicity-orchestration.md` (status/checklist ticks only)
- Delete `findings-*.md` scratch fragments wherever they landed
- Minimal remediation in files already owned by B/C/D **only** when a P0/P1 finding requires it (document each)

You may NOT invent new subsystems or expand scope beyond the four user goals.

## 3. Gap (verbatim from the table)

> E — Acceptance gate: Integrate, verify, evidence, delete findings (MEDIUM) depends on: A–D | files: `docs/phone-remote-acceptance.md`

## 4. What to build

1. Fold findings into `docs/phone-remote-acceptance.md` with claim → file/test mapping.
2. Run focused tests for QR/deep-link, dashboard auto-load, cwd defaults.
3. Confirm `/collab` vs `/remote` distinction still matches `docs/collab.md`.
4. Delete findings fragments after folding.
5. Record intentional deferred boundaries (e.g., full Android instrumentation if harness unavailable).

## 5. Hard constraints

1. Every checklist claim links to a concrete path or test name.
2. Do not advance release versions.
3. Do not commit unless the user explicitly asks.
4. Prefer remediation over documenting-around P0/P1 runtime gaps.

## 6. Verification

```bash
# oh-my-pi-fork
git diff --check
# pi-speak-extension focused tests actually touched by B/C/D
cd C:/Dev/desktop-projects/pi-speak-extension && (bun test tests || node --test tests/*.mjs)
test -f docs/phone-remote-acceptance.md
```

## 7. Commit message

`test(phone-remote): acceptance evidence for QR, sessions, cwd, hub parity (Gap E)`

## 8. Final report

```
### Lane E final report
- Worktree path / branch:
- Files modified / created:
- Public exports added: none
- Findings deleted:
- Verification:
  - focused tests: ___
  - git diff --check: ___
- Flags / blockers / deferred:
```
