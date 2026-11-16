# P0 / P1 / P2 roadmap

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff`.  
**P0 authorized** (owner: plan + implementation). Slice table: [17-slice-plan.md](17-slice-plan.md).

## P0 — S1–S3 (in progress)

1. **S1** — omp vs Agent Skills field matrix + discovery conformance tests (Q2 document divergence; Q3 document parse-only).  
2. **S2** — HookGate phase doc aligned with sequential Rust Review.  
3. **S3** — Structured-ops + ADW vs `omp.workflows` notes; schedules disarmed.

## P1 — Confirmed gaps (still need Q1/Q5/Q6 or ADR)

- **S4** Optional field **retention** on `Skill` (Q1) without gates.  
- **S5** Emit `user_input` family **or** nest-eval tool hooks (Q5); optional re-admit (Q6).  
- `agent_settled` rev alignment (existing TASKS open).  
- Intersect-only `allowed-tools` **only** with ADR proving no authority expansion.

## P2 — Conditional / deferred

- Sidecar requirements, yq-like builtins, live jq minimizer, PR webhook ingress, ADR 0061 skill-only packs after O8.

## Explicitly not implementing

ExpertPackage runtime; second hook stack; Bub firstresult core; embedded sHEL; skill-YAML preflight as admission.
