# Architecture alternatives (post–EGM)

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff`.  
Selected after streams A–D and [09](09-egm-design-review.md).

| Area | Selected | Rejected |
|---|---|---|
| Skills | REUSE discovery; optional field retention for portability | Second registry; skill-YAML typed preflight; cohesive `allowed-tools` enforcement |
| Requirements | Native catalogs / routing / envd enforce | Metadata or sidecar as gates |
| Hooks | REUSE HookGate phases | Parallel Pluggy stack; Bub firstresult core |
| Structured ops | REUSE bash + in-process jq | Embed sHEL / second interpreter |
| Experts | skills + classes + extensions + **ADW** | ExpertPackage runtime; soft `omp.workflows` as expert packaging |

Owner still answers Q1–Q7 before production slices.
