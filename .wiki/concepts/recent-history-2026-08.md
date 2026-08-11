---
type: Synthesis
title: "oh-my-pi fork recent history — 2026-08"
description: "Committed history from late July through 2026-08-06 covering gopk OCR consent enforcement, repo-relative context-file disable IDs, the @ompk GitHub mention agent and relay isolation tranche, discovery canonicalization fixes, the system-prompt slim and per-package AGENTS.md split, stored-credential skill probes, the 16.4.0 release, native-addon embed validation, the Prime Agent control-plane plan, and the ClinePass subscription provider."
resource: "oh-my-pi-fork git history be5d67797..82460fc8b"
timestamp: 2026-08-06T00:00:00-06:00
tags: [oh-my-pi, history, gopk, context-files, ompk-mention, relay, discovery, prompts, cline-pass, natives]
status: current
---

# oh-my-pi fork recent history — 2026-08

Continues [Recent History — 2026-07](recent-history-2026-07.md). Coverage begins at the wiki-CI-state merge (`4b1fb96d2` / `be5d67797`, July 29) and runs through `82460fc8b` (August 6).

## July 29–30: gopk OCR consent and handoff sanitization

- `feat(gopk): enforce OCR consent and sanitize handoffs` (`05d8bf1bd`) extended the activity-journal ingestion contract and the coding-agent gopk bridge:
  - `GopkClipAnalysis` gained an optional `ocrSnippet` (non-empty, ≤ 280 chars), rejected outright when the resolved capture policy has `ocrEnabled: false` — OCR text is consent-gated content, not free-form metadata.
  - Handoff text is sanitized on receipt: `redactGopkHandoffText` strips private-key blocks and common token shapes (`sk-…`, `ghp_…`, `github_pat_…`, `gpat_…`), and a supplied `redactedDigest` that still redacts further is rejected rather than silently re-redacted.
  - `resolveSharedGopkClipsCapturePolicy()` (`packages/coding-agent/src/gopk-clips/paths.ts`) reads the shared capture config **fail-closed** for the standalone ingester: unparseable or consent-less config resolves to `{ enabled: false, ocrEnabled: false }`.
- `fix(gopk): recheck OCR consent per handoff (Gap C)` (`3c2e10d88`) moved the gopk-clips session state from caching consent once to re-resolving it on every handoff, so a consent revocation mid-session stops OCR-bearing clips at the next handoff rather than at the next session.
- Two `Update VOUCHED` commits (`374d884b2`, `bc55781d1`) refreshed the vouched-discussion list.

## July 30 – August 5: context-file disable IDs land

- `fix(capability): scope context-file extension ids by path and rebind settings` (`853ac1628`, merged as [PR #37](https://github.com/kingkillery/oh-my-pk/pull/37) `a5bc84e7c`) completed the NER-144 follow-up recorded as pending in [Coding-agent reliability hardening](coding-agent-reliability-hardening.md):
  - Newly written `disabledExtensions` IDs are repo-relative and path-qualified; the change also fixed a module-level `Settings` pin that outlived its instance, so `disabledExtensions` filtering now rebinds on every settings swap.
  - `toExtensionId` is context-aware, context files stamp a `_source` id, and the extension dashboard shows parity with what the loader will match.
  - The legacy basename form remains dual-read, so existing user settings keep disabling what they previously matched.
- `merge main: keep repo-relative context-file ids over main's absolute form` (`1eace8324`) reconciled with main, which had landed NER-144 independently. The merge kept main's settings reset-hook mechanism and legacy-id documentation but this branch's repo-relative ID scope (over main's absolute-path form), the context-aware `toExtensionId`, `_source` stamping, dashboard parity, and rebinding on every settings swap.
- `catalog: compact generated models.json` (`ddb6f15f0`) writes `packages/catalog/src/models.json` without pretty-print whitespace (~1.96 MB → ~1.50 MB, ~462 KB saved); no model data changed.
- `chore(coding-agent): refresh legacy bundled registry` (`c24b03a11`, August 3) refreshed the legacy bundled registry.

## August 5: @ompk mention agent

- `feat: add @ompk GitHub mention agent (claude/copilot-style)` (`29cab8001`) and the DI/test refactor (`8598733fe`) shipped the repo-scoped Actions prototype. See [@ompk GitHub mention agent and relay isolation](ompk-github-mention-agent.md) for the full architecture; the prototype was superseded by the GitHub App adapter the next day.

## August 5: discovery, prompts, and skill probes

- `fix(discovery): per-file native walk-up, canonical cwd, robust depth calc` (`be7cf8379`):
  - Native `AGENTS.md`/`RULES.md` walk-up is now **per-file**: a nearer non-empty `.ompk/` lacking the requested file (or holding an empty copy) no longer blocks a farther ancestor's file. `SYSTEM.md` keeps its documented directory-based lookup.
  - `loadCapability` canonicalizes cwd/home (`resolve` + `realpath`) before deriving the repo root, so relative, mixed-separator, case-mismatched, or symlinked cwds no longer walk past the repo root and leak `.ompk` config from directories above the repository.
  - `calculateDepth` uses `path.relative` instead of raw separator counting; gemini/github project files report the depth of the ancestor holding the config dir per the documented shadowing rule.
- `refactor(prompts): slim system/context prompts, split package rules into AGENTS.md files` (`2a68e7383`):
  - The system prompt, default personality, and project prompt were compressed (delivery/workflow prose → Completion/Workflow sections); schema-redundant eval tool prose was dropped after probe validation.
  - Package-specific rules moved from the root `AGENTS.md` into `packages/coding-agent/AGENTS.md` and `packages/catalog/AGENTS.md`; code-style conventions now live in the conditional builtin rulebook. This is the convention going forward: package rules live beside the package, not in the root file.
  - Non-inferable capability surface was deliberately restored in the prompts: `issue://`/`pr://` query params (item `?comments=0`; list `?state` incl. `merged` for PRs, `limit`/`author`/`label`) and `vault://` file/vault op syntax.
- `feat(skills): stored-credential support for tool-prompt schema probes` (`7bfc25a09`) added `--stored-auth` to the tool-prompt-optimization `probe.ts`/`probe-builtin.ts` scripts, using `discoverAuthStorage` including OpenAI Codex OAuth, so schema probes can run against providers the user is logged into without exporting keys.

## August 5–6: release 16.4.0 and native-addon embed validation

- `chore: bump version to 16.4.0` (`984f250f1`).
- `fix(natives): reject stale native addons at embed time` (`69b2fc715`): `embed-native.ts` previously embedded whatever `.node` was on disk. After a version bump without a Rust rebuild, the compiled binary baked in an addon whose `__piNativesV{version}` sentinel predated the loader, crashing every startup — and the size-only extraction cache kept the stale copy in place afterwards. Each candidate addon is now scanned for the current sentinel export at embed time, failing the build with the rebuild command instead.
- README refreshes (`77a10a5d8` hero artwork; `66255160f` feature counts, install notes, and tool naming).

## August 6: Prime Agent plan, GitHub App adapter, relay isolation

- `docs: add Prime Agent control-plane adaptation plan` (`e4633ae68`) added `docs/prime-agent-control-plane-adaptation.md` (~430 lines), the adaptation plan for a Prime Agent control plane.
- `feat(ompk-linear-agent): account-wide GitHub App adapter for @ompk mentions` (`0ac15e66a`) moved the mention agent from the repo-scoped Actions workflow to a `/github/webhook` route on the `ompk-linear-agent` Cloudflare Worker (dedicated deployment `pk-ompk-github`), generalizing the job envelope with `source: linear | github`.
- `feat(ompk-linear-agent): relay isolation tranche — containers, setup hook, clone cache` (`a44130ae3`) and the review-P1 fixes (`8be25d693`) added container-per-job isolation (default off), a credential-free `.ompk/setup.sh` hook, a bare-mirror clone cache, attempt-scoped container teardown, and boundary-aware streaming redaction. Full detail and reusable conventions: [@ompk GitHub mention agent and relay isolation](ompk-github-mention-agent.md).

## August 6: ClinePass subscription provider

- `feat: add ClinePass subscription provider` (`82460fc8b`) registered ClinePass as an independent login and catalog provider:
  - `packages/ai/src/registry/cline-pass.ts` reuses the Cline account device flow (`loginCline`/`refreshClineToken`) under a separate `cline-pass` provider id with a subscription-scoped model catalog.
  - The catalog descriptor (`packages/catalog/src/provider-models/descriptors.ts`) sets `defaultModel: "cline-pass/deepseek-v4-flash"`, `envVars: ["CLINE_API_KEY"]`, and `dynamicModelsAuthoritative: true` — subscription discovery is authoritative, with bundled fallback models and canonical Cline cache isolation in `openai-compat.ts`.
  - CLI help now advertises `/login cline-pass` alongside `/login cline`.

## Working-tree boundary

The current checkout contains uncommitted work that is intentionally not presented as committed history:

- `AGENTS.md` gains a "Kade context" section routing "update the wiki" requests to the Obsidian vaults (`C:\dev\Vaults\Kade` / `C:\dev\Vaults\Design-and-Building`) and naming `kade.md`/`human.md` as the machine-level bootstrap. Note: the project knowledge bundle remains this repo's `.wiki/`; the vaults are currently empty starters.
- New untracked paths: `.agents/skills/kade-hq/` (governance skill) and `.ompk/mapreduce/github-app.selectors.md` (mapreduce selectors for the GitHub App surface).

See `git status` before relying on any of the above.

## Source links

- [Knowledge bundle index](../index.md)
- [Bundle update log](../log.md)
- [Recent History — 2026-07](recent-history-2026-07.md)
- [@ompk GitHub mention agent and relay isolation](ompk-github-mention-agent.md)
- [Coding-agent reliability hardening](coding-agent-reliability-hardening.md)
- [Prime Agent control-plane adaptation plan](../../docs/prime-agent-control-plane-adaptation.md)
