# Unified capability matrix

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff`.  
Sources: streams [A](02-agentskills-compliance.md)–[D](06-expert-package-composition.md).  
EGM design review of recommendations: pending ([09](09-egm-design-review.md)).

Recommendation classes: **REUSE** · **EXTEND** · **IMPLEMENT** · **DEFER** · **REJECT**.

| Capability | Current owner | Status | Gap | Existing alternative | Standard impact | Security | Complexity | Evidence | Recommendation |
|---|---|---|---|---|---|---|---|---|---|
| Skill discovery + progressive disclosure | `driver/discovery/skills.rs` | Implemented | — | — | Portable | Containment OK | Low | Stream A | **REUSE** |
| Retain Agent Skills optional fields | same + `Skill` shape | Partial | license/compatibility/metadata dropped | Document divergence | Portability | Low | Low | Stream A | **EXTEND** |
| Align default name rules with spec | default vs plugin parsers | Partial | Dual regimes | Plugin path already strict | Spec conformance | Low | Low | Stream A | **EXTEND** or document |
| Enforce `allowed-tools` | parse-only on plugins | Absent | No admission wire | ApprovalBook + roster | Experimental field | Must not grant | Med | Stream A | **IMPLEMENT** only if product wants; else document non-enforcement |
| Second skill registry | — | Absent | — | ActiveSkills | Breaks single owner | High risk of split brain | High | Stream A | **REJECT** |
| Model/tool reqs via metadata/sidecar | advisory only | Proposed | No typed preflight from skills | catalog + `omp-ai` + envd | Prefer string metadata | Skills must not authorize | Med | `03` | **EXTEND** B+D direction pending owner |
| Five-phase HookGate | `contract/hooks.rs`, envd compose | Implemented | — | — | N/A | Phase legality | Med | Stream B | **REUSE** |
| Parallel Pluggy middleware stack | — | Absent | Shape differs by design | HookGate phases | N/A | Would widen attack surface | High | Stream B | **REJECT** |
| Emit `user_input` family | catalog only | Partial | No Rust emit | `before_agent_start` | N/A | Prompt gate | Med | Stream B | **EXTEND** if product needs |
| Replay re-admission | `retry_tool_tail` | Partial | Skips tool_call gate | Intentional for journal fidelity | N/A | Policy vs replay | Med | Stream B | **EXTEND** only if policy requires |
| Parallel Precheck/Review | docs claim | Partial | Sequential impl | Sequential compose | N/A | Perf only | Med | Stream B | **DEFER** |
| `agent_settled` rev mismatch | catalog vs payload | Partial | rev 2 vs 1 | TASKS.md open | N/A | Schema drift | Low | Stream B | **EXTEND** before schema work |
| In-process `jq` (jaq) | `shell-builtins/jq.rs` | Implemented | — | — | N/A | PathPolicy | Low | Stream C | **REUSE** |
| Embed sHEL / second interpreter | — | Absent | Wrong domain (cmd.exe workstation; AGPL) | bash+jq+spill | N/A | New trust + license surface | High | Stream C (×2) | **REJECT** |
| Nested-eval tool hook emission | envd/kernel | Partial | Nested path skips tool hooks | Documented gap | N/A | Policy blind spot | Med | Stream B | **EXTEND** if policy requires |
| Bub firstresult prompt/model replace | — | Absent | — | Core-owned prompt/inference | N/A | Would invert authority | High | Stream B | **REJECT** (Locked Deviation) |
| Live jq minimizer in envd | minimizer crate | Partial | cargo-only live | Spill/projection | N/A | Token vs fidelity | Low | Stream C | **DEFER** |
| yq-like YAML/CSV transform | — | Absent | No builtin | serde for config only | N/A | Path/injection | Med | Stream C | **DEFER** |
| ExpertPackage runtime | — | Absent | Composition desire | skills+ADW+ext+classes | Would fork standards story | Authority confusion | High | Stream D | **REJECT** |
| Skill-only extension packs | ADR 0061 | Proposed | Packaging | Extensions | Compatible | Trust grants stay native | Med | Stream D | **EXTEND** (existing ADR) |
| PR webhook → expert pipeline | forge/ci Dyn | Partial | No push webhook subscriber | poll/watch + schedules | N/A | Ingress auth | Med | Stream D | **EXTEND** ingress/recipes only |

## Cross-stream dependencies

1. Skill metadata retention (A) before typed requirement preflight (A/`03`).  
2. Hook emit gaps (B) independent of skills — do not couple.  
3. Structured ops (C) independent — no blocker for A/B/D decisions.  
4. Expert packages (D) **REJECT** removes a large false dependency on A–C.  
5. Owner gate required before any production EXTEND/IMPLEMENT.

## Cohesive architecture (Elephant draft, pre-Goldfish)

- **Portable layer:** Agent Skills as standardized; optional string `metadata` / `compatibility`.  
- **Native enforcement:** catalogs, routing, HookGate, ApprovalBook, envd — never skill YAML.  
- **Composition:** skills + agent classes + extensions + ADW (no ExpertPackage).  
- **Structured data:** bash + in-process `jq` + spill; no sHEL.  
