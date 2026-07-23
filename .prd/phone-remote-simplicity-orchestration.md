# Phone / Collab / Remote simplicity — orchestration overview

## 1. Purpose

Make `/collab`, `/remote-control`, `/remote` (pk-speak), and the Android phone app feel like one simple path:

1. Scan a QR on the phone → connected.
2. Phone auto-loads the same pk-mesh / Agent Hub sessions you see in ompk (`←←` / `/background`), with optional `sm` lookup.
3. Voice agent stays comfortable in a global workspace unless asked to navigate or drop into a session.
4. Pickup/continue from phone matches desktop Agent Hub lanes.

This spans two repos with disjoint ownership:

- `C:/Dev/desktop-projects/oh-my-pi-fork` — collab QR, `/remote-control`, TUI Agent Hub, collab-web guest surface
- `C:/Dev/desktop-projects/pi-speak-extension` — `/remote` gateway, pairing QR, Android app, Agent Hub dashboard merge, voice/CWD path

Parallel dispatch is justified because pairing UX, session discovery, and voice-CWD/hub parity touch different files and can ship behind one frozen contract.

## 2. Letter-group dispatch table

| Letter | Lane | Archetype | Effort | Depends on | File |
|---|---|---|---|---|---|
| A | Shared pairing + session-list contract | `[pre-phase]` | MEDIUM | none | `.prd/phone-remote-simplicity-lane-a.md` |
| B | One-scan QR connect path | `[parallel-builder]` | LARGE | A | `.prd/phone-remote-simplicity-lane-b.md` |
| C | Auto-load mesh sessions + `sm` lookup | `[parallel-builder]` | LARGE | A | `.prd/phone-remote-simplicity-lane-c.md` |
| D | Voice global-CWD + Agent Hub phone parity | `[parallel-builder]` | LARGE | A | `.prd/phone-remote-simplicity-lane-d.md` |
| E | Cross-repo acceptance + evidence | `[acceptance-gate]` | MEDIUM | A,B,C,D | `.prd/phone-remote-simplicity-lane-e.md` |

## 3. 5-row dispatch table (operational form)

| Lane | Gap letters | Owned files | Effort | Model | Subagent | Isolation | Depends on | Verify commands |
|---|---|---|---|---|---|---|---|---|
| Contract | A | `docs/phone-remote-happy-path.md`, `.prd/phone-remote-simplicity-ownership.json` | MEDIUM | sonnet | task | main checkout | none | file exists + schema keys present |
| QR connect | B | pi-speak pairing/connect + Android deep-link path; ompk collab QR helpers if needed | LARGE | sonnet | task | worktree (pi-speak primary) | A | focused unit tests listed in lane B |
| Session auto-load | C | `agent-hub-dashboard.ts`, session target/routing merge, focused tests | LARGE | sonnet | task | worktree (pi-speak) | A | dashboard/session tests |
| Voice CWD + hub parity | D | provider factory, session cwd helpers, realtime defaults, hub action glue | LARGE | sonnet | task | worktree (pi-speak) | A | focused provider/gateway tests |
| Acceptance | E | evidence doc + findings cleanup | MEDIUM | sonnet | task / oracle | main checkouts | B,C,D | both-repo focused tests + `git diff --check` |

## 4. File-ownership matrix

| File | A | B | C | D | E |
|---|---|---|---|---|---|
| `docs/phone-remote-happy-path.md` | own | – | – | – | own (link only) |
| `.prd/phone-remote-simplicity-ownership.json` | own | – | – | – | – |
| `pi-speak-extension/pairing.ts` | – | own | – | – | – |
| `pi-speak-extension/server-app.ts` | – | own | – | – | – |
| `pi-speak-extension/control-server.ts` (`/connect` QR only) | – | own | – | – | – |
| `pi-speak-extension/index.ts` (`/remote` QR presentation only) | – | own | – | – | – |
| `pi-speak-extension/android-app/.../Pairing*` + setup deep-link tests | – | own | – | – | – |
| `packages/coding-agent/src/slash-commands/helpers/collab-qrcode.ts` | – | own | – | – | – |
| `packages/coding-agent/src/slash-commands/builtin-registry.ts` (collab/remote-control QR/help only) | – | own | – | – | – |
| `pi-speak-extension/agent-hub-dashboard.ts` | – | – | own | – | – |
| `pi-speak-extension/session-routing.ts` (dashboard merge hooks only) | – | – | own | – | – |
| `pi-speak-extension/realtime-session-target.ts` | – | – | own | – | – |
| `pi-speak-extension/tests/*session*|*dashboard*` owned/new | – | – | own | – | – |
| `pi-speak-extension/agent-provider-factory.ts` | – | – | – | own | – |
| `pi-speak-extension/session-working-directory.ts` | – | – | – | own | – |
| `pi-speak-extension/realtime-gateway.ts` (voice prompt + default cwd only) | – | – | – | own | – |
| `pi-speak-extension/agent-hub-actions.ts` (parity glue only) | – | – | – | own | – |
| `packages/coding-agent/src/modes/components/agent-hub*.ts` (only if parity requires) | – | – | – | own | – |
| `docs/phone-remote-acceptance.md` | – | – | – | – | own |
| `findings-*.md` scratch | – | – | – | – | delete |

Parallel lanes B/C/D must keep an empty file intersection.

## 5. Execution sequence

1. Phase 0 / Lane A solo on main checkouts. Freeze happy-path contract + ownership JSON. Block.
2. Phase 1 / Lanes B, C, D in one OMP `task` fan-out with worktree isolation beside each repo (never nested under long artifact trees). Windows: `core.longpaths=true` already set.
3. Phase 1.5 sequential `git merge --no-ff` per lane branch. Remove `@ts-expect-error` bridges. Reconcile field-name drift against Lane A.
4. Phase 2 / Lane E solo. Focused verification, acceptance evidence, delete `findings-*.md`.

## 6. Acceptance criteria checklist

- [ ] `docs/phone-remote-happy-path.md` names exactly one primary phone pairing path and distinguishes `/collab` vs `/remote-control` vs `/remote` without contradicting `docs/collab.md`
- [ ] Phone connects by scanning host QR with no manual IP/token entry (Lane B tests / Android setup deep-link tests)
- [ ] Connected phone session list includes oh-my-pk background / Agent Hub lanes from `buildOhMyPiAgentHubDashboardCached` / merge helpers
- [ ] `sm sessions list` / `sm get` lookup path is documented; if code-wired, covered by a focused test or CLI smoke note
- [ ] Voice turns with no explicit `cwd` use global/default workspace and do not force project navigate unless asked
- [ ] `docs/phone-remote-acceptance.md` links each claim to a concrete file or test name
- [ ] Subagents skip project-wide gates; main agent runs focused tests after merge

## [A to Z Gaps]

| Letter | Name | Archetype | Remaining work | Effort | Depends on | Files |
|---|---|---|---|---|---|---|
| A | Shared pairing + session-list contract | `[pre-phase]` | Freeze one happy-path pairing URL/token contract and shared session-list fields | MEDIUM | none | `docs/phone-remote-happy-path.md`, `.prd/phone-remote-simplicity-ownership.json` |
| B | One-scan QR connect | `[parallel-builder]` | Scanning host QR pairs Android/web with zero manual IP/token typing | LARGE | A | pi-speak pairing/connect/QR + Android Pairing*; ompk collab QR helpers if needed |
| C | Mesh session auto-load + `sm` | `[parallel-builder]` | Auto-load pk-mesh/omp sessions into phone dashboard; expose/document `sm` lookup | LARGE | A | `agent-hub-dashboard.ts`, session target/routing, tests |
| D | Voice global-CWD + hub parity | `[parallel-builder]` | Default voice to global workspace; phone hub matches ompk `←←` / `/background` | LARGE | A | provider factory, cwd helpers, realtime defaults, hub actions |
| E | Acceptance gate | `[acceptance-gate]` | Integrate, verify, evidence, delete findings | MEDIUM | A–D | `docs/phone-remote-acceptance.md` |

## Conductor stance

Existing workflow only: `.conductor/complete-ompk-prs.yaml` (unrelated).

Per `skill://conductor`: do **not** create a new workflow YAML unless the user explicitly asks. After PRD authoring, either run/validate a named existing workflow or wait for an explicit create request.
