# Stream D — Reproducible expert packages

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff` (2026-11-16 UTC).  
Auditor: isolated Cursor explore Task [Audit skills workflows composition](bc-97f582bf-612b-5c48-a40e-12cdc6950d34).  
Coordinator classification below; Goldfish review of the whole architecture is still pending.

## Study

Question: does OMP2 need a new declarative “expert package” layer over skills, tools, and workflows?

## Inventory (source-verified in auditor report)

| Primitive | Role | Status |
|---|---|---|
| Skills (`SKILL.md` → prompt / `skill://`) | Instruction material | IV |
| Agent classes (`.cfg`, ADR 0013) | Spawn roster / model / convars | IV |
| ADW (`omp-adw` + `driver/src/adw` + `.omp/workflows/*.toml`) | Durable phase DAG, posture, accept/reject | IV |
| Soft `omp.workflows` extension | Separate subagent DAG; not ADW | II |
| Directors / Components | Cross-turn control + journal fold | IV |
| Extensions + grants | Tools, hooks, trust | IV |
| Claude / Agent Plugins | Closest installable bundle; plugin `agents/`/`tools/` unsupported | II |
| forge@1 / ci@1 | PR/CI Dyn mounts (request/response, CI watch poll) | IV |
| `.claude/skills` omp-pre-pr / omp-evidence-review | Dev-aid prompt packs | IV as text; not runtime monitors |

Zero matches for `expert package` / `ExpertPackage` at the pin. ADR 0061 already proposes skill-only `omp ext` packs (packaging, not a new composition runtime).

## Classify

**a — Already covered by equivalents** for composition of experts: extension + skills + agent class + ADW.

## Research decision

| Claim | Recommendation |
|---|---|
| New runtime `ExpertPackage` type | **REJECT** — duplicates extensions, ADW, skills, agent classes |
| Skills as prompt guidance | **REUSE** |
| ADW for multi-phase gated runs | **REUSE** |
| Extensions for tools/hooks/trust | **REUSE** |
| Directors for cross-turn control | **REUSE** |
| Skill-only extension packs | **EXTEND** (ADR 0061 D4), not a new abstraction |
| Skills declaring required tools/workflows | **DEFER** until Agent Skills compliance (stream A) forces metadata design |
| Unify ADW with soft `workflow@1` | **REJECT** merge; durable gated experts → **ADW only**; `omp.workflows` = optional long-tail extension, **not** the expert packaging story (EGM F3) |
| Skill-only packs (ADR 0061) | **Proposed** packaging direction — not a landed load-path capability (EGM F8) |
| PR push webhooks → expert pipeline | **EXTEND** ingress or schedule/poll recipes; pull/poll already **REUSE** |

## PR-monitoring example

| Need | Feasible |
|---|---|
| Read/comment known PR | Yes — forge@1 / `pr://` |
| Wait for CI | Yes — ci@1 `watch` poll |
| Periodic checks | Yes — schedules + forge search + optional ADW |
| Native `pull_request` webhook subscriber | No — request/response Dyn only |
| Skills alone as monitors | No |

## Non-goals

- Do not invent a parallel composition runtime, second workflow engine, or “expert” crate.
- Do not treat `.claude/skills` checklists as event-driven automation.

## Next (conditional)

If authorized later: a **recipe** document composing ADW + forge/ci + schedules + existing skills for PR monitoring — no new type. Await streams A–C and owner gate before any implementation slice.
