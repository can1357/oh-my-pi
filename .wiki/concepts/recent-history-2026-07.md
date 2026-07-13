---
type: Synthesis
title: "oh-my-pi fork recent history — 2026-07"
description: "Committed July history covering browser agents, context evidence, orchestration contracts, desktop operations, side-agent coordination, remote workspaces, and environments-cloud routing."
resource: "oh-my-pi-fork git history 9ed73a788..1895db95e"
timestamp: 2026-07-12T20:59:50-06:00
tags: [oh-my-pi, history, orchestration, remote-workspace, side-agent, context-oracle]
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

## Working-tree boundary

The current checkout also contains uncommitted work (including `packages/ompk-linear-agent`, `packages/collab-relay`, help recommendations, and multi-agent collaboration docs). Those changes are intentionally not presented as committed history; see `git status` before relying on them.

## Source links

- [Knowledge bundle index](../index.md)
- [Bundle update log](../log.md)
- [Remote workspace](remote-workspace.md)
- [Task-contract orchestration](task-contract-orchestration.md)
