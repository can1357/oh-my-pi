# Unified capability matrix

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff`.  
Sources: streams [A](02-agentskills-compliance.md)–[D](06-expert-package-composition.md).  
EGM: [09-egm-design-review.md](09-egm-design-review.md) (F1–F9 applied below).

Evidence column: **SI** = source-inventoried (tests not re-run). Recommendation classes: **REUSE** · **EXTEND** · **IMPLEMENT** · **DEFER** · **REJECT**.

| Capability | Current owner | Status | Gap | Existing alternative | Standard impact | Security | Complexity | Evidence | Recommendation |
|---|---|---|---|---|---|---|---|---|---|
| Skill discovery + progressive disclosure | `driver/discovery/skills.rs` | Implemented | — | — | Portable | Containment OK | Low | SI A | **REUSE** |
| Retain Agent Skills optional fields | same + `Skill` shape | Partial | fields dropped | Document divergence | Portability | Low | Low | SI A | **EXTEND** retention only (not a gate) |
| Align default name rules with spec | dual parsers | Partial | Dual regimes | Plugin path strict | Spec conformance | Low | Low | SI A | **EXTEND** or **document** (Q2) |
| Enforce `allowed-tools` | parse-only plugins | Absent | unused | ApprovalBook + roster | Experimental | Skill must not grant | Med | SI A | **REJECT** as cohesive default; **document** parse-only (Q3); ADR required before any intersect-only wire |
| Second skill registry | — | Absent | — | ActiveSkills | Breaks owner | Split brain | High | SI A | **REJECT** |
| Model/tool reqs from skill metadata | advisory | Proposed | — | catalog + `omp-ai` + envd | Nonstandard if gated | Skills must not authorize | Med | SI `03` | **REUSE** native enforcement (D); **DEFER** sidecar; no skill-YAML preflight runtime |
| Five-phase HookGate | contract + **agent Kernel** emit + envd compose | Implemented | — | — | N/A | Phase legality | Med | SI B + G2 | **REUSE** (tool/session admission) |
| Parallel Pluggy middleware stack | — | Absent | — | HookGate | N/A | Attack surface | High | SI B | **REJECT** (YAGNI; not “parity achieved”) |
| Emit `user_input` family | catalog only | Partial | No Rust emit | `before_agent_start` | N/A | Prompt gate | Med | SI B | **EXTEND** if product needs |
| Replay re-admission | `retry_tool_tail` | Partial | Skips gate | Journal fidelity | N/A | Policy vs replay | Med | SI B | **EXTEND** only if policy requires |
| Parallel Precheck/Review | docs claim | Partial | Sequential | Sequential compose | N/A | Perf | Med | SI B | **DEFER** or fix docs |
| `agent_settled` rev mismatch | catalog vs payload | Partial | rev 2 vs 1 | TASKS.md | N/A | Schema drift | Low | SI B | **EXTEND** before schema work |
| Nested-eval tool hooks | envd/kernel | Partial | Nested skips | Documented | N/A | Policy blind spot | Med | SI B | **EXTEND** if policy requires |
| Bub firstresult prompt/model | — | Absent | — | Core-owned | N/A | Authority invert | High | SI B | **REJECT** |
| In-process `jq` (jaq) | `shell-builtins/jq.rs` | Implemented | — | — | N/A | PathPolicy | Low | SI C | **REUSE** |
| Embed sHEL | — | Absent | Wrong domain | bash+jq+spill | N/A | Trust + AGPL | High | SI C | **REJECT**; native default = absent measured gap |
| Live jq minimizer | minimizer / envd | Partial | cargo-only | Spill | N/A | Token vs fidelity | Low | SI C | **DEFER** |
| yq-like YAML/CSV | — | Absent | — | config serde | N/A | Injection | Med | SI C | **DEFER** |
| ExpertPackage runtime | — | Absent | — | skills+ADW+ext+classes | Fork story | Authority | High | SI D | **REJECT** |
| Soft `omp.workflows` DAG | extension device | Implemented (II) | Second DAG vs ADW | ADW for durable experts | N/A | Resume confusion | Med | SI D | **REUSE** as optional long-tail only; **not** expert packaging |
| Skill-only extension packs | ADR 0061 | Proposed | O8 open | Extensions | Compatible | Trust native | Med | SI D | **DEFER**/proposed packaging — not landed |
| PR webhook → expert pipeline | forge/ci | Partial | No push webhook; schedules **disarmed** | ci@1 `watch` poll | N/A | Ingress | Med | SI D + G1 | **EXTEND** ingress/recipes; do **not** rely on durable schedules |
| Durable schedule delivery | envd schedules | Partial / disarmed | No production `bind_schedule_delivery` | ci watch / external cron | N/A | N/A | Med | G1 | **DEFER** as expert glue until armed |

## Cross-stream dependencies

1. Skill metadata retention (A) before typed requirement preflight (A/`03`).  
2. Hook emit gaps (B) independent of skills — do not couple.  
3. Structured ops (C) independent — no blocker for A/B/D decisions.  
4. Expert packages (D) **REJECT** removes a large false dependency on A–C.  
5. Owner gate required before any production EXTEND/IMPLEMENT.

## Cohesive architecture (Elephant draft, post–Goldfish F1–F9)

- **Portable layer:** Agent Skills as standardized prose; optional field **retention** for portability (Q1) — not gates.  
- **Native enforcement only:** catalogs, routing, HookGate, ApprovalBook, envd — skill YAML never expands authority.  
- **Composition:** skills + agent classes + extensions + **ADW for durable gated experts**; `omp.workflows` optional long-tail, not the expert story; no ExpertPackage.  
- **Structured data:** bash + in-process `jq` + spill; no sHEL embed.  
- **Hooks:** REUSE HookGate; REJECT second stack without claiming Pluggy parity.  
