---
type: Synthesis
title: "oh-my-pi fork recent history — 2026-07"
description: "Committed July history covering browser agents, context evidence, orchestration contracts, desktop operations, side-agent coordination, remote workspaces, environments-cloud routing, the Claude Code-style agent hub, multi-agent fork collaboration policy, and the privacy-first activity-journal ledger with the gopk capture-daemon bridge."
resource: "oh-my-pi-fork git history 9ed73a788..0e110b9d9"
timestamp: 2026-07-13T19:30:00-06:00
tags: [oh-my-pi, history, orchestration, remote-workspace, side-agent, context-oracle, activity-journal, linear-agent, irc, snapcompact-removal]
status: current
---

# oh-my-pi fork recent history

The project `.wiki/log.md` records wiki-maintenance events and the focused concept pages record individual designs. This page joins those records to the committed product history.

## July 8: model routing, browser agents, and evidence

- Model/catalog work added Qwen nitro and OpenRouter nitro-priority options, then added Grok 4.5 SuperGrok metadata and browser-control roles (`9ed73a788`, `61677b1d0`, `f8d4937d8`, `36a99e74b`, `c95096eb9`, `94a4b3e97`).
- Browser-operation agents gained an IX Bridge-backed tool rather than hand-written daemon HTTP calls; `/delegate browser` and the browser-control agent now share the routed browser surface (`c591d990f`, `b5a56f0f3`).
- WikiGraph reads were tightened to cwd/configured wiki roots, and offload-trace artifact evidence received round-trip coverage (`06315c823`).
- The typed context oracle, evidence compression, persistent session cache, symbol caching, and StepContext-aware router traces landed (`c4346bc72`, `f5539b9de`, `949e33ea1`, `45cf1f1a4`, `c84e3f5c8`).

## July 9–10: orchestration becomes an explicit runtime

- Fusion sidekick lifecycle/status was hardened and a local-fast route predictor was added (`1555ecd89`, `3507be454`).
- Small-model execution profiles established spawn selection, mutable policy boundaries, optional Qwen spawn policy, tool/collaboration ceilings, verifiable task contracts, terminal recovery, and evidence-aware adapter failure handling (`d199516a8`, `19fa88655`, `b3f9bc0eb`, `8fa652872`, `752a79306`, `0dedf407a`, `56ea79077`, `c9c35d70f`, `ebb3a85ae`).
- Public operational infrastructure added a durable gateway/runner/store/cron/notification/trajectory layer, plus a secure Desktop Tag capture/routing surface and Windows host crate (`515bb1e4e`, `e23aa16b3`, `0d98358f8`).
- Task tooling gained parent-selected harnesses, tool-profile resolution, web-search capability, background-session persistence/adoption, and stronger cancellation/settlement ordering (`02dab06b0`, `d7b1010ee`).
- The TUI now exposes fast-mode status beside the model (`0d6c3f1fb`).

## July 11: coordination, contracts, and isolated execution

- Context-policy synthesis, sibling findings, spawn/approach telemetry, search budgets, completion gates, and hardened orchestration contracts landed (`575afc5c0`, `f820ff9fc`, `ed5077d89`, `2461c114d`).
- The Phase 0A planning foundation added `ReasoningPlanV1`, `EvidenceLedger`, `ModuleRegistry`, and a self-discovery classifier (`2461c114d`).
- The collab web workspace was redesigned and hosted cross-platform releases were enabled (`bb411b177`, `0db5c605a`).
- The side-agent protocol became race-safe and cross-platform: atomic claim directories, double result-write fencing, DAG validation, stale-claim recovery, heartbeat liveness, write-once results, and Windows-safe timestamps (`7f755a2d3`, `4232bd655`).
- `packages/remote-workspace` became a reliable Docker-isolated execution package with artifact/credential handling, SQLite jobs, cancellation, cleanup, and contract tests (`9b33ae030`, `20f91fbe2`).
- Task-contract runtime orchestration connected ambiguity scoring, intent compilation, prompt injection, reasoning-plan gates, retry/compaction persistence, and advisor presentation; 86 contract tests were added (`a7b803d14`, `6087ea0b0`).
- Follow-up commits stabilized orchestration integration, archive-text obfuscation, and collab tool-view generation (`3ceb06932`, `bd07e8f67`).

## July 12: environments-cloud split

- `1895db95e` wired pure MSI root/skill/handoff resolvers and the `ompk-remote environments` CLI, auto-included environments-cloud skills, and documented the split: Docker remote-workspace owns local sandbox jobs; `pkscloudenvs` owns mesh/cloud/auth/codespace-style launch. See [environments-cloud routing](environments-cloud-routing.md).

## July 13: agent hub, help, and fork policy

- A Claude Code-style agent hub landed in `coding-agent` and a follow-up restored missing exports broken on main (`62850eebb`, `884fb0a52`, `ad5066d8a`). The hub exposes folder → session → subagent tree navigation with kanban sync (per `e2f4ccaba`, `5c21b2878`, `f57d3aad6` upstream lineage).
- Built-in feature help is now a first-class `/help <question>` recommender that ranks built-in capabilities deterministically and falls through to a normal prompt on miss (`3d5629333`); see `docs/help.md`.
- A multi-agent fork-collaboration policy was formalized to keep the fork single-track: one shared fork, one Linear child issue = one owning agent = one branch = one worktree = one PR (`linear/<issue-key>-<slug>`), with a single dispatcher owning admission/WIP and a single merge owner serializing into main. Per-agent forks are explicitly rejected (`7e6947641`; see `docs/multi-agent-fork-collaboration.md`).
- Local runtime artifacts were ignored (`6333e6019`), and the wiki was summarized in `bb97a3733` so the recent fork history is one click away from the knowledge bundle.
- Linear-agent worker and relay were hardened against injection, replay, and race findings (`0ed13b80e`); the ompk-linear-agent Cloudflare Worker reads `model:<combo-id>` from Linear labels, queues jobs in the `JobQueue` Durable Object (the legacy `JOBS` KV queue was removed), and posts relay results back as Linear comments.
- Wrangler dev secrets are now git-ignored (`a309a22c1`) so cloudflare-runtime `.dev.vars` files never reach the remote.

## July 13: activity-journal ledger and gopk bridge

- `feat(activity-journal): add privacy-first evidence ledger` (`72d9dd96d`) introduced `packages/activity-journal/` and `packages/context-policy/`.
  - The ledger is a local-only SQLite source of truth (`SqliteActivityLedger`) for already-redacted activity evidence; raw media bytes never enter the database, but a short-lived local pointer is retained so the configured lifecycle can delete the source file (`packages/activity-journal/src/ledger.ts`).
  - `importJournalJsonl` ingests timestamped OMP, Codex, and Claude Code JSONL events without retaining prompt, tool, or response content; idle gaps are bounded by `maximumIdleMs` (default 5 min) (`journal-import.ts`).
  - `buildActivityTimeline` splits a requested window at evidence boundaries so simultaneous sources never inflate the reported duration (`timeline.ts`).
  - The gopk-clips adapter (`gopk-clips.ts`) accepts only redacted `GopkClipAnalysis` derivatives, validates the consent record via `authorizeCapture`, emits ledger ids as `gopk_clips:<clipId>`, and caps screen confidence at `medium` to prevent over-trust in corroborating evidence.
  - `createGopkActivitySink` (`gopk-sink.ts`) is the cross-repo handoff from the gopk capture daemon: it namespaces `clipId` with the session before passing it to the adapter, so the resulting ledger ids are session-namespaced; it deletes a raw clip only when `ingestGopkClip` returns `rejected`. Session mismatches, missing `sanitized` attestation, containment failures, and invalid timestamps return before removal and those clips are never ledgered.
  - `createConstrainedRawClipRemover` re-validates `realpath` containment before `unlink`, swallows ENOENT, and propagates other errors so the sink stays fire-and-forget but never escapes capture root.
  - `purgeExpiredRawClips` (`retention.ts`) removes each expired raw file first (`remover.remove`), then marks the ledger (`markRawClipDeleted`); if marking fails after removal, the file is deleted but remains unmarked in the ledger.
  - The companion `packages/context-policy/` package declares `ContextRetentionPolicy`, `ConsentRecord`, and `authorizeCapture`; its default policy (`policy/default-policy.v1.json`) declares `denyRawPromptInjection` and `cascadeDeletion` as policy fields, but no repository consumer enforces them. `authorizeCapture` only rejects future persistent capture after consent revocation.
  - The downstream counterpart in `gopk-clips` is `b3d2d66` (`feat: add privacy-first activity journal bridge`): the capture daemon's sanitizer, foreground-app resolver, and chunk-sink wiring all satisfy the receiving contract.

## July 13: linear-agent relay, IRC, and slash-command fixes

- The IRC subsystem became cross-process peer-discovery aware via same-CWD discovery, broadcast suppression, and Windows-correct wait timeouts (`9f310589e`, `0e110b9d9`).
- `/help` registration lost a race during a concurrent commit and was restored as a dedicated fix (`8bd3a2716`) — relevant because the help recommender (above) now relies on it.

## July 14: Snapcompact removal

- The uncommitted working tree removes the experimental Snapcompact compaction path in full: the shape-preview renderer and its doc (`packages/coding-agent/src/modes/components/snapcompact-shape-preview{.ts,-doc.md}`), the five prompt stub/note markdown files under `packages/coding-agent/src/prompts/system/snapcompact-*.md`, the inline-compaction and savings-journal modules (`packages/coding-agent/src/session/snapcompact-{inline,savings-journal}.ts`), and their three dedicated test files (`test/agent-session-snapcompact-budget.test.ts`, `test/snapcompact-inline.test.ts`, `test/snapcompact-savings-journal.test.ts`).
- **Justification** (`packages/coding-agent/CHANGELOG.md`, `[Unreleased]` → `### Removed`): Snapcompact was an unsafe experimental imaging path that rendered system prompts, conversation history, and tool results into images for compaction. It is removed outright rather than deprecated; any stale persisted `Snapcompact` compaction-mode setting now migrates automatically to the native-text `context-full` mode, so no user-facing config break occurs.
- Removal is threaded through the surrounding surfaces rather than deleted in isolation: `session/compact-modes.ts`, `session/agent-session.ts`, `session/session-context.ts`, and `session/messages.ts` drop the mode branch and its wiring; `modes/utils/context-usage.ts`, `modes/components/compaction-summary-message.ts`, and `modes/components/settings-selector.ts` drop the corresponding UI/telemetry paths; `config/settings-schema.ts` and `config/settings.ts` drop the setting and add the migration shim; `slash-commands/builtin-registry.ts` and `slash-commands/helpers/context-report.ts` drop the mode from user-facing surfaces.
- Lane D (docs/test remediation) confirmed no separate CHANGELOG or wiki justification entry existed prior to this pass and that the remaining test-file deletions (`test/modes/context-usage.test.ts` divider-related cases) were stale coverage for the removed mode, not accidental collateral.

## July 13: trusted actor and quota docs

- Trusted actor settings for `robomp` were documented as part of the multi-agent fork collaboration policy rollout (`bb20843de`).
- `feat(context-storage): add quota and artifact contracts` (`cd72f3538`) formalized quota and artifact contracts for the persistent context layer, pairing with `infra/context-storage/lifecycle.s3.json` (uncommitted at time of writing).

## Working-tree boundary

The current checkout also contains uncommitted work (including `packages/ompk-linear-agent`, `packages/collab-relay`, `packages/coding-agent/src/modes/components/composer/`, `packages/coding-agent/src/session/hub-service.ts`, `infra/context-storage/lifecycle.s3.json`, and the Snapcompact removal above). Those changes are intentionally not presented as committed history; see `git status` before relying on them.

## Source links

- [Knowledge bundle index](../index.md)
- [Bundle update log](../log.md)
- [Remote workspace](remote-workspace.md)
- [Task-contract orchestration](task-contract-orchestration.md)
- [Multi-agent fork collaboration](../../docs/multi-agent-fork-collaboration.md)