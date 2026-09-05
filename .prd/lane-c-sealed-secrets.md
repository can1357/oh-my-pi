# Lane C — Sealed secrets at the prompt-build boundary [[parallel-builder]]

## 1. Mission + read-first

You are the `[parallel-builder]` sub-agent for oh-my-pk at
`C:/dev/infra/oh-my-pk`. Close the two leaks in the existing sealing
machinery so secrets never reach model context.

**Read first** (each in full):
- `.prd/exomode-orchestration.md` — pipeline context + ownership matrix
- `packages/coding-agent/src/secrets/index.ts` — secret sources
- `packages/coding-agent/src/secrets/obfuscator.ts` (esp. ~lines 394-433,
  the systemPrompt pass-through)
- `packages/coding-agent/src/system-prompt.ts` — `getEnvironmentInfo` block
- `.prd/exomode-decision.md` — frozen contract + gates

## 2. Owned files

You may ONLY edit these files:
- `packages/coding-agent/src/secrets/index.ts` (existing)
- `packages/coding-agent/src/secrets/obfuscator.ts` (existing)
- `packages/coding-agent/src/system-prompt.ts` (existing)
- `packages/coding-agent/src/secrets/__tests__/sealed-secrets.test.ts` (new)

You may NOT edit any other file, including `packages/coding-agent/src/sdk.ts`
(D owns it), `settings-schema.ts`, `routing/*`, `session/*`, or
`packages/stats/*`.

## 3. Gap (verbatim from the table)

> C — Sealed secrets at the prompt-build boundary: Close the two leaks in
> the existing sealing machinery: (1) auth.json credential values are NOT
> currently a secret source — loadSecrets reads only .ompk/secrets.yml +
> global secrets.yml, and collectEnvSecrets covers env
> (packages/coding-agent/src/secrets/index.ts; wired at sdk.ts:1360-1366);
> add auth-storage-derived entries. (2) obfuscateProviderContext rewrites
> ONLY context.messages and explicitly passes the system prompt through
> unchanged (packages/coding-agent/src/secrets/obfuscator.ts:402-407) —
> extend sealing to the outbound systemPrompt (string | string[]), and scrub
> secret-shaped values from system-prompt.ts's getEnvironmentInfo block at
> build time. Test: fake token fed via auth.json + env never appears
> anywhere in the assembled provider Context (messages AND systemPrompt).
> (0% complete) [SMALL] depends on: A (contract only — C consumes nothing;
> shares no files) | files: packages/coding-agent/src/secrets/index.ts,
> packages/coding-agent/src/secrets/obfuscator.ts,
> packages/coding-agent/src/system-prompt.ts,
> packages/coding-agent/src/secrets/__tests__/sealed-secrets.test.ts (new)

## 4. What to build

1. `secrets/index.ts`: add auth-storage-derived credential values as a third
   `SecretEntry` source alongside secrets.yml + env.
2. `obfuscator.ts`: extend `obfuscateProviderContext` to rewrite
   `context.systemPrompt` (string | string[]) with the same deterministic
   same-length placeholders; remove the pass-through.
3. `system-prompt.ts`: scrub secret-shaped values from the
   `getEnvironmentInfo` block at build time.
4. Test file: fake token via auth.json + env asserts absent from every part
   of the assembled provider Context (messages AND systemPrompt).

## 5. Hard constraints

1. No new npm dependencies.
2. Lane-scoped typecheck must pass (no repo-wide gates from this lane).
3. No edits outside the owned-files list. Verify via `git diff --name-only`.
4. No breaking changes to existing exports. Additive extensions only.
5. Placeholders stay deterministic same-length (existing obfuscator idiom).
6. If you discover a needed `sdk.ts` change, DO NOT make it: record it in
   your final report under Flags; it bundles into lane D.
7. OMP subagent hint: skip project-wide build/test/lint/format. Only run
   the verification commands in section 6.

## 6. Verification

Run before declaring done:
```bash
bun test packages/coding-agent/src/secrets/__tests__/sealed-secrets.test.ts
git diff --name-only
```

Expected:
- test exit 0 (fake-token absence assertions)
- `git diff --name-only` lists ONLY the 4 owned files

## 7. Commit message

`fix(secrets): seal auth.json + systemPrompt at prompt boundary (Gap C)`

## 8. Final report

Fill in and return at the end of your response:
```
### Lane C final report
- Files modified / created:
- Public exports added (signatures):
- @ts-expect-error suppressors added (count + which imports): none expected
- Lines added / removed:
- Verification:
  - bun test (lane file) exit: ___
  - git diff --name-only: ___
- Flags / blockers (incl. any sdk.ts change request for lane D):
```
