---
type: Concept
title: PR 45 pull-over inventory
description: Forward-only checklist for pulling the remaining proven PR 45 behaviors into main without replaying work main already contains.
tags: [pr-45, convergence, main, caching, fusion, collab]
timestamp: 2026-08-30T00:00:00Z
---

# PR 45 pull-over inventory

## Direction

Move forward from `main`. PR 45 and `codex/pr45-minimal-reconciliation`
provide donor evidence; they are not branches to merge, rebase, or restore as a
whole. For every item below, start from current `main`, port only the missing
observable behavior, and use the donor commit to understand intent.

The reviewed donor commits are:

| Commit | Evidence supplied |
|---|---|
| `9a97bcf323` | Anthropic cache anchoring and compiled updater behavior |
| `4478e53563` | CoLab external link-file contract |
| `b950cf479a` | Fusion prompt placement, lifecycle concurrency, and failure-state hardening |

## Pull into main

These are the remaining bounded deltas found by comparing the donor branch to
current `main`.

### 1. Keep Anthropic cache breakpoints on real turns

Port the donor's synthetic-pad handling in `applyPromptCaching()`. When
Anthropic appends a terminal user message containing `Continue.` after an
assistant turn, calculate the rolling two-message cache window from the real
assistant turn rather than the pad. The transient pad must not consume a cache
breakpoint.

Required contract:

- the last two real, eligible conversation turns receive the rolling cache
  breakpoints;
- a thinking-only assistant block is skipped and the preceding eligible real
  turn receives the fallback breakpoint;
- the synthetic `Continue.` message remains present but unmarked;
- the existing four-breakpoint ceiling, TTL ordering, caller overrides, OAuth
  billing-header protection, and cache opt-out behavior remain unchanged.

Donor: `9a97bcf323`.

### 2. Put dynamic Fusion guidance after the stable prompt prefix

Extract the conditional Fusion sidekick guidance from the middle of the stable
system-prompt template and append it as the final conditional system block.
Changing Fusion mode, sidekick availability, or sidekick model must not alter
the bytes of preceding base, project, and active-repository prompt blocks.

Required contract:

- the common prompt prefix is byte-identical with Fusion on and off;
- the Fusion block is present only when enabled, applicable, and backed by the
  required tool capability;
- no instruction, tool schema, or safety context is removed for cacheability;
- provider serializers retain their current cache controls and limits.

Donor: the focused system-prompt/Fusion hunks in `b950cf479a`, not its unrelated
prompt, GPU, personality, or task changes.

### 3. Make Fusion sidekick lifecycle concurrency-safe

Port the bounded lifecycle protections from the donor's
`session/fusion-sidekick.ts` into current `main`:

- one ensure/spawn operation in flight per main session;
- concurrent startup hooks join the same operation;
- a forced replacement queues behind an ordinary ensure;
- model reconciliation waits for an in-flight ensure;
- releases use the expected registry reference and recheck the registry so a
  same-ID concurrent replacement is retained;
- sidekick creation, absence, or failure refreshes the base prompt so the
  terminal Fusion block accurately reflects live capability.

Preserve the current non-forcing post-commit session hooks: `AgentSession` owns
switch teardown, so an immediate forced ensure must not release the replacement
it just preserved.

Donor: the focused Fusion lifecycle hunks and concurrency tests in
`b950cf479a`.

### 4. Scope Fusion failure streaks to the active downgraded route

Port the provider-independent auto-downgraded-route predicate and its focused
tests. A tool failure should advance the Fusion escalation streak only while
the current model is the active automatically selected cheaper route. Reset the
streak when the model changes, compaction begins a fresh routing epoch, or a new
route verdict supersedes the old one.

Required contract:

- failures on the frontier model do not pre-load a later cheap-route streak;
- delegate mode, manual override, disabled routing, and unrelated provider
  state cannot trigger auto-escalation;
- a successful tool result still clears the streak;
- the configured threshold escalates only a genuine consecutive failure epoch.

Donor: the focused `fusion-router.ts`, `agent-session.ts`, and failure-epoch
tests in `b950cf479a`.

### 5. Add the missing CoLab bridge regression contract

Current `main` already calls `writeCollabLinkFile()` after `/collab` starts.
Pull over only the focused slash-command assertion proving the published object
contains `webLink`, `webViewLink`, `link`, `viewLink`, and the selected `view`
mode. Do not replay the production hunk.

The file remains local coordination state for Pi Speak and adjacent
telnet/service consumers. It is not a public upload.

Donor: the focused test hunk in `4478e53563`.

## Already in main — do not pull again

The comparison found these donor behaviors already implemented, or superseded
by a newer `main` equivalent:

| Behavior | Current `main` state |
|---|---|
| Compiled `omp` / `ompk` updater targeting | `resolveInvokedBinaryPath()` and its alias tests already cover both executable names. |
| Anthropic stable-system caching | The final system block, stable first system block, four-breakpoint accounting, Claude OAuth billing protection, TTL normalization, opt-out, and rolling message cache already exist. |
| OpenAI/xAI/OpenRouter cache affinity | Current session-routing and prompt-cache metadata contracts already cover these providers. |
| CoLab link publication | `/collab` already writes the local bridge payload; only the direct regression assertion is missing. |
| CoLab transport boundaries | Protocol v3, trusted browser hosts, `/collab`, `/remote-control`, `X-OMP-*`, and extension-owned `/remote` remain distinct. |
| Core Fusion surface | Fusion settings, commands, sidekick spawning, compaction routing, model roles, and baseline lifecycle tests already exist. Pull only the hardening items above. |
| Current model/catalog/release policy | `main` remains canonical; do not replace these graphs from the donor commit. |

## Boundaries that must not converge

- CoLab browser/relay sessions, Hub/IRC coordination, Pi Speak `/remote`, SSH,
  roboomp, and remote-workspace retain separate commands, credentials,
  endpoints, state directories, and lifetimes.
- Keep the CoLab browser at
  `https://oh-my-pk.pkking.computer/collab/`, the encrypted relay at
  `wss://collab.pkking.computer`, and exact protocol-v3 negotiation. Deploy a
  matching v3 browser client; do not weaken the host to accept v2 silently.
- Keep `PI_SPEAK_CONFIG_DIR/collab.json` (or the platform Pi Speak config
  directory) as local bridge state for external apps.
- Do not collapse package identities, generated catalogs, lockfiles, provider
  registries, or release graphs into a convergence lane.

## Implementation order

1. Anthropic synthetic-pad cache anchoring.
2. Terminal Fusion prompt block and byte-stable prefix test.
3. Fusion singleflight/CAS lifecycle hardening.
4. Fusion failure-epoch gating and resets.
5. CoLab link-file regression test.

Each item is its own reviewable change. Before editing, reproduce the missing
contract on current `main`; after editing, run the focused observable tests,
the affected package typecheck and Biome checks, and finally the combined union
gate on an up-to-date `main` branch.

## Explicit non-goals

- No merge or rebase of PR 45 or the reconciliation branch into `main`.
- No whole-commit cherry-pick when a donor commit mixes unrelated systems.
- No backward restoration of superseded registry, provider, task, SDK, MCP,
  identity, release, or generated-data architecture.
- No weakening of security, protocol, tool-schema, or instruction contracts to
  improve cache metrics.
- No cost, latency, or accuracy claim without a measured before/after result.
