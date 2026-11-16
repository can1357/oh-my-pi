# EGM Goldfish design review

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff`.  
Reviewers (fresh contexts):

- [EGM Goldfish design review](bc-8ca267e4-34a7-5eb1-a7df-7cf32cf87d5f) (`egm-zoom-out`) — F1–F9  
- [EGM duplication Goldfish](bc-45573391-d23b-5f36-a859-34b475f57c43) (`egm-codebase-details`) — G1–G10

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

## Codebase-details findings (Elephant)

| ID | Severity | Disposition | Design change |
|---|---|---|---|
| G1 | Blocker | **Confirm** | Schedules are **II/disarmed** — not a live expert/PR periodic path; keep ci@1 `watch` poll |
| G2 | Major | **Confirm** | Add `omp-agent` `Kernel` as HookGate emit/admission/retry owner |
| G3 | Major | **Confirm** | Distinguish jaq CLI-port docs (2.3.0) from locked crates (core 2.2.1 / std 2.1.x) |
| G4 | Major | **Confirm** | Drop “budgeted Review” as implemented; sequential + ordinary timeouts only |
| G5 | Major | **Confirm** | Document full plugin frontmatter validators; omp `enabled`/`hide` fail on plugin path |
| G6 | Major | **Confirm** | No 1024 description cap on any path; managed only sanitizes |
| G7 | Nit/Major | **Confirm** | Name `envd/src/exec.rs` as live cargo-only minimize owner |
| G8 | Nit | **Confirm** | Cite `extensions/workflows/`; do not list armed schedules as glue |
| G9 | Nit | **Confirm** | `user_input` family: Rust+Python catalogued; no Rust emit |
| G10 | Nit | **Confirm** | Keep `01` synced; matrix as summary only |

## Unresolved / owner

Q1–Q7 in [16-open-questions.md](16-open-questions.md). F/G corrections are Elephant design revisions; they do **not** substitute for owner Q7 authorization.

## Acceptance scorecard (post-revision intent)

| Criterion | After Elephant revisions |
|---|---|
| Native first / four REJECTs | Pass; plus ADW-vs-`omp.workflows` clarity (F3) |
| Skills do not grant authority | Pass once F1/F2 applied |
| Agent Skills portability | Incomplete until Q2 (F7) |
| Evidence-backed | Pass presentation once F5/F6/F9 applied |
