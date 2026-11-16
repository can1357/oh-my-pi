# Implementation slice plan

Pin research: `a8762fd997…`.  
Owner request (2026-11-16 America/Santo_Domingo): plan **and implement** recommendations → **Q7 = authorize P0** (docs + conformance locking current behavior).  
P1 behavioral EXTENDs (field retention, emit seams) stay **blocked** on Q1/Q5/Q6 unless a later message authorizes them.

| Slice | PR unit | Owners | Depends | Acceptance | Tests | Non-goals |
|---|---|---|---|---|---|---|
| **S1** | Agent Skills current-behavior matrix + discovery conformance tests | `docs/architecture/agentskills-omp.md`; `crates/driver/src/discovery/skills.rs` tests | — | Dual-parser matrix published; tests prove optional fields dropped / plugin validators / `allowed-tools` not retained | `just test-pkg omp-driver` (named unit tests) | No `Skill` shape change; no admission wire |
| **S2** | Hook phase doc ↔ Rust truth | `docs/py/05-hooks.md` | — | Phase table + procedure note that Precheck/Review are **sequential in Rust today**; parallel/budgeted marked aspirational | Doc review; existing `omp-contract` / `omp-agent` hook tests unchanged | No parallelize Review; no new HookGate API |
| **S3** | Structured-ops + expert composition notes | `docs/architecture/structured-ops.md`; short ADW vs `omp.workflows` note | S1 optional | Documents bash+jaq path; sHEL non-goal; schedules disarmed; ADW for durable experts | Doc only | No sHEL; no schedule arming |
| **S4** | Optional field **retention** on `Skill` | `skills.rs` + prompt facts | **Q1 = Yes** | Retained license/compatibility/string metadata; still no gates | driver unit + snapshot of facts | No `allowed-tools` enforcement |
| **S5** | Emit / re-admit gaps | agent Kernel + catalog | **Q5/Q6** | Product-chosen seams only | lifecycle_hooks | No Bub firstresult |

## Sequencing

1. Land **S1+S2+S3** on `cursor/capabilities-p0-conformance-632b` (this authorization).  
2. Hold **S4/S5** until Q1/Q5/Q6.  
3. Never: ExpertPackage, Pluggy stack, sHEL embed, skill-YAML admission.
