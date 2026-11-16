# Decisions and rationale

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff`.  
Status: **proposed research conclusions** — not ADR Accepted; Q7 open.

| Decision | Rationale | EGM |
|---|---|---|
| No second skill registry | ActiveSkills already owns discovery | — |
| Document `allowed-tools` parse-only | Skills must not grant authority | F1 |
| Native-only enforcement for model/tool/runtime | Avoid portable YAML as policy plane | F2 |
| Durable experts → ADW; soft workflows long-tail | Avoid dual expert runtimes | F3 |
| REUSE HookGate; no Pluggy stack | Phased gate already production | F5 |
| No sHEL embed | Wrong domain; unmeasured; AGPL blast | F6 |
| No ExpertPackage type | Composition already covered | Stream D |
| Research-only until owner Q7 | Authorization gate | F4 |

See [16-open-questions.md](16-open-questions.md) for owner choices still required.
