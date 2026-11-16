# EGM Goldfish design review

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff`.  
Reviewer: [EGM Goldfish design review](bc-8ca267e4-34a7-5eb1-a7df-7cf32cf87d5f) (`egm-zoom-out`, fresh context).  
Second Goldfish (codebase-details) may still be pending; this file records the first closed review.

## Verdict (reviewer)

Do **not** treat the cohesive architecture as owner-ready until authority clarity and synthesis hygiene are fixed. The four REJECT axes are correct YAGNI.

## Finding dispositions (Elephant)

| ID | Severity | Disposition | Design change |
|---|---|---|---|
| F1 | Blocker | **Confirm** | Remove “IMPLEMENT allowed-tools if product wants” from cohesive draft; Q3 default → **document parse-only** unless ADR proves intersect-only (skill never expands authority) |
| F2 | Blocker | **Confirm** | Cohesive default = **native registries only (D)** for enforcement; metadata retention is portability/docs (Q1), not a requirements runtime; defer sidecar |
| F3 | Major | **Confirm** | Explicit rule: durable experts → **ADW only**; `omp.workflows` = optional long-tail extension, not expert packaging |
| F4 | Major | **Confirm** | Mark missing index docs; sync `01` stream status; keep Q7 research-only |
| F5 | Major | **Confirm** | Reframe B: **REJECT second stack (YAGNI)** + **REUSE HookGate**; do not claim Pluggy parity |
| F6 | Minor/Major | **Confirm** | Keep REJECT embed sHEL; Alternative A = “default absent measured gap,” not “sufficient for sHEL” |
| F7 | Major | **Confirm** | Dual parsers remain the conformance root; P0 prefer document matrix until Q2 Align vs Document |
| F8 | Minor | **Confirm** | ADR 0061 = **proposed** packaging direction, not landed capability |
| F9 | Minor | **Confirm** | Matrix evidence = `source-inventoried` unless commands executed |

## Unresolved / owner

Q1–Q7 in [16-open-questions.md](16-open-questions.md). F1/F2 corrections are Elephant design revisions; they do **not** substitute for owner Q7 authorization.

## Acceptance scorecard (post-revision intent)

| Criterion | After Elephant revisions |
|---|---|
| Native first / four REJECTs | Pass; plus ADW-vs-`omp.workflows` clarity (F3) |
| Skills do not grant authority | Pass once F1/F2 applied |
| Agent Skills portability | Incomplete until Q2 (F7) |
| Evidence-backed | Pass presentation once F5/F6/F9 applied |
