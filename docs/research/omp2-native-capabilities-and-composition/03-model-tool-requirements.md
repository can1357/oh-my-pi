# Stream A continuation — Model and tool requirements

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff`.  
Depends on [02-agentskills-compliance.md](02-agentskills-compliance.md).

## Working conclusion (pending Goldfish + owner)

| Requirement class | Portable Agent Skills | OMP2 native owner | Must not |
|---|---|---|---|
| Environment prose | optional `compatibility` string | discovery may surface; envd/trust enforces | grant network/fs by metadata alone |
| Vendor metadata | string→string `metadata` (namespaced keys) | retain if EXTEND lands | nest arbitrary objects in frontmatter |
| Tool allowlists | experimental `allowed-tools` | only if wired to admission | bypass ApprovalBook / roster |
| Model capabilities | not a standard top-level field | catalog + `omp-ai` routing (ADR 0017) | hardcode provider names in skills |
| Runtime OS/arch/exec | `compatibility` or sidecar + host probes | envd / sandbox / posture | skill script as authority |
| Verification / evidence | outside skill YAML | ADW accept/reject, cleanse, evidence skills | treat skill text as proof |

## Alternatives (from program brief)

| Option | Tentative |
|---|---|
| A. Spec-only | **REUSE** baseline; insufficient for typed preflight |
| B. Namespaced `metadata` strings | **EXTEND** preferred for portability |
| C. Requirements sidecar | **DEFER** until B is insufficient |
| D. Native capability registries only | **REUSE** for enforcement; skills stay advisory |
| E. Expert packages | **REJECT** as new runtime (see stream D) |
| F. Combine B+D | **Recommended direction** pending review |

Full decision waits on streams B–C synthesis and EGM review.
