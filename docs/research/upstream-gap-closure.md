# Upstream gap closure (OMPv1 c308970263 to omp2)

This ledger tracks each functional gap between omp2 and upstream OMPv1 at
can1357/oh-my-pi `c308970263` (v18.20.0, 2026-11-13). Each gap has a research
note under `docs/research/`. Gaps classified as a port or a proposal also have
an ADR. The mission brief is
[upstream-gap-closure-brief.md](upstream-gap-closure-brief.md); it is the
authority for the method, and a resuming session continues from the first gap
whose status is not "Closed".

Classes: **a** already covered, **b** not needed, **c** port, **d** propose.

Review outcomes: **reviewed** = EGM review done with no blocker left open;
**changes required** = round 1 found issues that are not yet resolved in the
ADR; **blocker open** = a blocker survived round 3, the gap stops at its ADR;
**machine-reviewed** = no blocker after the final round, implementation may
proceed behind a default-off `cap-*` feature or convar, not owner-approved.
Gaps 6, 7, 8 and 15 are data or small mechanical additions and skip EGM per the
brief.

| # | Gap | Class | Research | ADR | Review | Status | PRs |
|---|---|---|---|---|---|---|---|
| 1 | Subagent isolation (CoW backends, ovnfs) | d (cache carry for `/wt`), b (ovnfs) | [subagent-isolation](subagent-isolation.md) | [0071](../adr/0071-subagent-isolation.md) | machine-reviewed (EGM, 3 rounds), not owner-approved | ADR done; S0 is a measurement on an APFS Mac (owner), S1 behind `sv_worktree_clone` only if S0 passes | #622 (merged) |
| 2 | Mnemopi model-free fact extraction | c | [mnemopi-fact-extraction](mnemopi-fact-extraction.md) | [0062](../adr/0062-mnemopi-fact-extraction.md) | machine-reviewed (EGM, 3 rounds), not owner-approved; round-3 blockers closed by scope cuts and factual corrections (the clause-split fix is a judgement call for the owner) | ADR done; S1-S4 behind `sv_memory_session_retention` (default off), not started; S4 waits on owner O3; tool observations and model lanes (Apple FM) deferred to a follow-up ADR | #625 (merged) |
| 3 | Semantic find | d | [semantic-find](semantic-find.md) | [0060](../adr/0060-semantic-find.md) | reviewed | Ready to implement (S0 spike first) | |
| 4 | Desktop intervention guard and XKB | c | [desktop-intervention-guard](desktop-intervention-guard.md) | [0063](../adr/0063-desktop-intervention-guard.md) | machine-reviewed (EGM, 3 rounds), not owner-approved; round-3 blocker closed by deferring libei release | ADR done; A1, A2 behind `sv_computer_xkb_layout`, C1 behind `sv_computer_release_on_abort` (default off), not started; macOS guard deferred to its own record | #624 (merged) |
| 5 | Automatic reasoning effort | c | [auto-reasoning-effort](auto-reasoning-effort.md) | [0064](../adr/0064-auto-reasoning-effort.md) | machine-reviewed (EGM, 3 rounds), not owner-approved | ADR done; S1-S4 behind `ai_auto_effort` (default off), not started; S0a/S0b ungated fixes wait on owner O7 | #637 (merged) |
| 6 | In-process shell builtins | c (rsync b) | [shell-builtins](shell-builtins.md) | [0054](../adr/0054-shell-builtins.md) | reviewed (EGM not required) | Ready to implement | |
| 7 | Config discovery | c | [config-discovery](config-discovery.md) | [0065](../adr/0065-config-discovery.md) | findings resolved (EGM not required) | ADR done; S1-S4 behind `sv_discover_copilot` / `sv_ssh_import_openssh` (default off), not started | #621 (merged) |
| 8 | Web readers and search backends | a (readers) + c | [web-readers](web-readers.md) | [0055](../adr/0055-web-search-backends-and-reader-fidelity.md) | reviewed (EGM not required) | Ready to implement | |
| 9 | Subagent tools | c (/seance), d (probe) | [subagent-tools](subagent-tools.md) | [0056](../adr/0056-subagent-consult-tools.md) | reviewed | Ready to implement | |
| 10 | Session tools | c, d, b | [session-tools](session-tools.md) | [0057](../adr/0057-session-tools.md) | reviewed | Ready to implement | |
| 11 | Context tools | a, b, d | [context-tools](context-tools.md) | [0058](../adr/0058-context-url-schemes.md) | reviewed | Ready to implement (`cfg://`); `out://` waits on ADR 0050 S2-S4 | |
| 12 | TUI job widgets and charts | c (widgets), c deferred (auto-graph) | [tui-job-widgets](tui-job-widgets.md) | [0066](../adr/0066-tui-job-widgets.md) | machine-reviewed (EGM, 3 rounds), not owner-approved; round-3 blocker (multi-line `<pre>` in the `/hub` inspector) closed by cutting the output window to single-row entries | ADR done; S1 (newest output line of the selected async `bash` job in `/hub`) behind `cl_hub_job_output` (default off), not started; O5 (foreground coverage) should be settled before S1 merges; widgets, sparkline and auto-graph deferred | #639 (merged) |
| 13 | Browser inspection, ABKit | c (React, a11y), b (ABKit) | [browser-inspection](browser-inspection.md) | [0067](../adr/0067-browser-inspection.md) | machine-reviewed (EGM, 3 rounds), not owner-approved; round-2 blocker closed by cutting the audit to axe-core only | ADR done; S1 (Chromium init scripts, `just test-browser`, CI step) ungated with no caller, S2 (React tree/inspect helpers) behind `sv_browser_inspect` (default off), not started; S3-S5 wait on owner O6 (browser@3 revision), S4 axe-core also on O3 | #641 (merged) |
| 14 | Memory backends | c (decision files), b (Hindsight as extension only) | [memory-backends](memory-backends.md) | [0068](../adr/0068-decision-memory.md) | machine-reviewed (EGM, 3 rounds), not owner-approved; round-3 blockers closed by a factual correction (secret snapshot built at composition as `/share` does) and scope cuts (no extension rules; extraction off while any extension or plugin hook can deny or rewrite `before_agent_start`) | ADR done; S0-S5 behind `ai_decision_memory` (default off), not started; O1-O24 open | #644 (merged) |
| 15 | Providers and sign-in | c, d | [providers-signin](providers-signin.md) | [0059](../adr/0059-provider-catalog-additions.md) | reviewed (EGM not required) | Ready to implement | |
| 16 | Ratchet and skillshare | a (skillshare) + d (ratchet) | [ratchet-skillshare](ratchet-skillshare.md) | [0061](../adr/0061-ratchet-policy.md) | reviewed | Blocked on an ADR 0006 amendment for a bridged op (owner) | |
| 17 | Forge URL schemes out of core | a (goal) + b (literal move) | [forge-url-schemes](forge-url-schemes.md) | none | not required | Closed: ADR 0049 D2.5 already routes pr:// and issue:// to forge extensions; moving the spellings is forbidden by ADR 0050 D1 and the additive rule | |
| 18 | Generated RPC clients | d | [rpc-clients](rpc-clients.md) | [0069](../adr/0069-rpc-clients.md) | machine-reviewed (EGM, 3 rounds), not owner-approved; round-3 blockers closed by removing the bundle crate and the SDK probe harness | Closed for this pass: research and deferral only, no implementation slices; clients wait on a named consumer (O1) | #643 (merged) |
| 19 | VM sandbox fallback, Windows CI | d (research and ADR only) | [platform-sandbox-ci](platform-sandbox-ci.md) | [0070](../adr/0070-platform-sandbox-ci.md) | research-only, machine-reviewed (EGM, 2 rounds), not owner-approved | Closed for this pass: concrete reopen triggers recorded; no implementation | #623 (merged) |

## Log

- 2026-11-14: ledger brought in line with `docs/adr/STATUS.md` (ADRs 0062-0071
  exist; the previous copy still said "pending" for gaps 1, 13, 14, 18 and 19).
  Bootstrap (brief, EGM skills, `omp-*` skills) in its own PR. EGM rounds 2-3
  started for gaps 1, 2, 4 and 5.
- 2026-11-14 07:10 UTC: bootstrap PR #617 opened (brief, vendored EGM skills at
  google/elephant-goldfish-model `964a4f1`, four `omp-*` skills). Every running
  agent stopped at the 5-hour API limit and was resumed after the reset;
  in-flight ADR edits live only in the gap worktrees until each driver commits.
  Subagents have no Agent tool, so gap drivers resolve round 1 only and the
  orchestrator spawns the fresh-context Goldfish reviewers for rounds 2-3.
- 2026-11-14 12:45 UTC: gap 12 (ADR 0066) finished three EGM rounds; its
  round-3 blocker closed by removing the multi-line output window (rule b).
  Merged as #639. Gap 13 (ADR 0067) finished round 3 with no blocker; its PR
  is pending. Gaps 14 and 18 wait on round 1; implementation slices for gaps
  6, 9 and 15 are in progress on their own branches.
- 2026-11-14 12:55 UTC: gap 13 (ADR 0067) merged as #641 after three EGM
  rounds with no open blocker. Gaps 14 (ADR 0068) and 18 (ADR 0069) resolved
  round 1 on their review branches; Goldfish round 2 is running for both.
- 2026-11-14 13:20 UTC: gaps 14 (ADR 0068, #644) and 18 (ADR 0069, #643)
  finished three EGM rounds with no open blocker. Every gap now has an ADR
  that is reviewed or machine-reviewed (gap 16 waits on an owner ADR 0006
  amendment). The remaining work is implementation slices behind default-off
  gates; in flight: gap 6 S1, gap 9 S0, gap 15 S1.
