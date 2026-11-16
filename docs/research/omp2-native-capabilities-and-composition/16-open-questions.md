# Open questions (owner decisions required)

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff`.  
EGM agreement does **not** answer these.

| ID | Question | Options | Blocks |
|---|---|---|---|
| Q1 | Retain Agent Skills optional fields (`license`, `compatibility`, string `metadata`) on discovered skills? | Yes EXTEND / No document-only | P0 docs vs code slice |
| Q2 | Align non-plugin skill naming with Agent Skills (kebab, dir match, description length) or document intentional divergence? | Align / Document | Conformance story |
| Q3 | Enforce experimental `allowed-tools`, or explicitly document parse-only / unused? | Document unused (**Elephant default post-F1**) / ADR for intersect-only only | Must not grant authority |
| Q4 | Prefer namespaced string `metadata` vs sidecar vs native-only for requirements? | Retain metadata for portability / Sidecar / **Native-only enforcement (Elephant default post-F2)** | `03` design |
| Q5 | Emit catalog `user_input` family gates, or keep `before_agent_start` as the prompt seam? | Emit / Keep | Stream B EXTEND |
| Q6 | Should `retry_tool_tail` re-enter `tool_call` admission? | Re-admit / Keep skip (replay fidelity) | Policy vs journal |
| Q7 | Authorize any P0 production slice now, or research-only until ADR amendment? | **Authorize P0 (S1–S3)** — owner asked for plan + implementation 2026-11-16 | Implementation |

**Q7 resolved for P0:** documentation + conformance tests that lock current behavior (no semantics change). Q1/Q5/Q6 still block P1 S4/S5.
