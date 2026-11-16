# P0 / P1 / P2 roadmap

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff`.  
**No production slice authorized** until owner Q7 (and ADR where required).

## P0 — Standards and native foundation (docs / tests / no semantics change preferred)

1. Publish omp vs Agent Skills field matrix (current behavior) — document dual parsers (Q2).  
2. Document `allowed-tools` parse-only / unused (Q3 Elephant default).  
3. Document HookGate phase legality + sequential Review (fix docs if needed).  
4. Document structured-ops path: bash + jaq `jq` + spill; sHEL non-goal.  
5. Document ADW vs `omp.workflows` expert rule.  
6. Optional: conformance fixtures that **assert current** discovery behavior (SI → executed).

## P1 — Confirmed gaps (only after ADR/owner)

- Optional field **retention** on `Skill` (Q1) without gates.  
- Emit `user_input` family **or** nest-eval tool hooks **if** product needs.  
- `agent_settled` rev alignment.  
- Intersect-only `allowed-tools` **only** with ADR proving no authority expansion.

## P2 — Conditional / deferred

- Sidecar requirements, yq-like builtins, live jq minimizer, PR webhook ingress, ADR 0061 skill-only packs after O8.

## Explicitly not implementing

ExpertPackage runtime; second hook stack; Bub firstresult core; embedded sHEL; skill-YAML preflight as admission.
