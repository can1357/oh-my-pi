# Lane B — One-scan QR connect path [parallel-builder]

## 1. Mission + read-first

You are the `[parallel-builder]` sub-agent for QR/pairing simplicity across `pi-speak-extension` (primary) and oh-my-pi-fork collab QR surfaces (secondary). Make "scan QR on phone → connected" the default path with no manual IP/token entry.

**Read first**:
- `.prd/phone-remote-simplicity-orchestration.md`
- `docs/phone-remote-happy-path.md` (Lane A)
- `C:/Dev/desktop-projects/pi-speak-extension/pairing.ts`
- `C:/Dev/desktop-projects/pi-speak-extension/server-app.ts`
- `C:/Dev/desktop-projects/pi-speak-extension/android-app/app/src/main/java/com/example/PairingRequiredGate.kt`
- `C:/Dev/desktop-projects/pi-speak-extension/android-app/app/src/test/java/com/example/SetupDeepLinkTest.kt`
- `packages/coding-agent/src/slash-commands/helpers/collab-qrcode.ts`

## 2. Owned files

You may ONLY edit:
- `C:/Dev/desktop-projects/pi-speak-extension/pairing.ts`
- `C:/Dev/desktop-projects/pi-speak-extension/server-app.ts`
- `C:/Dev/desktop-projects/pi-speak-extension/control-server.ts` (QR/`/connect` presentation only)
- `C:/Dev/desktop-projects/pi-speak-extension/index.ts` (`/remote` QR presentation only)
- `C:/Dev/desktop-projects/pi-speak-extension/android-app/app/src/main/java/com/example/PairingRequiredGate.kt`
- `C:/Dev/desktop-projects/pi-speak-extension/android-app/app/src/main/java/com/example/PairingQrScanner.kt`
- `C:/Dev/desktop-projects/pi-speak-extension/android-app/app/src/test/java/com/example/SetupDeepLinkTest.kt`
- `packages/coding-agent/src/slash-commands/helpers/collab-qrcode.ts`
- `packages/coding-agent/src/slash-commands/builtin-registry.ts` (collab/remote-control QR/help copy only)

You may NOT edit dashboard, session routing, provider factory, or realtime-gateway tool prompts (lanes C/D).

## 3. Gap (verbatim from the table)

> B — One-scan QR connect: Scanning host QR pairs Android/web with zero manual IP/token typing (LARGE) depends on: A | files: pi-speak pairing/connect/QR + Android Pairing*; ompk collab QR helpers if needed

## 4. What to build

1. Ensure host QR encodes a phone-scannable deep link carrying base URL + install auth token (and optional target/workspace) per Lane A.
2. Android setup path persists token/profile from scan without asking the user to type them.
3. Clarify `/remote` QR vs `/collab`/`/remote-control` QR in user-facing strings so operators pick the persistent phone path by default.
4. Add/extend focused tests for setup deep-link parsing (`SetupDeepLinkTest` or equivalent).

## 5. Hard constraints

1. No new npm/Gradle dependencies unless already present.
2. Do NOT run `npm install` / project-wide gates in worktrees; defer to orchestrator.
3. No edits outside owned files.
4. Preserve existing install-token persistence semantics in `pairing.ts`.
5. Do not break `/collab` encryption/link format.
6. Match existing code style.

## 6. Verification

```bash
# in pi-speak-extension worktree / checkout
node --test tests/setup*.mjs 2>/dev/null || true
# Android unit tests if the local JDK/Gradle harness is already available; otherwise skip and note
git -C C:/Dev/desktop-projects/pi-speak-extension diff --name-only
git -C C:/Dev/desktop-projects/oh-my-pi-fork diff --name-only
```

## 7. Commit message

`feat(remote): one-scan QR pairing without manual token entry (Gap B)`

## 8. Final report

```
### Lane B final report
- Worktree path / branch:
- Files modified / created:
- Public exports added (signatures):
- @ts-expect-error suppressors added: none|list
- Lines added / removed:
- Verification:
  - focused tests: ___
  - git diff --name-only: ___
- Flags / blockers:
```
