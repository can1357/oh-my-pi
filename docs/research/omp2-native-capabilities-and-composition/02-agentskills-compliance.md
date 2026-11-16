# Stream A — Agent Skills compliance

Pin: `a8762fd997ca754b30ea7d3344cbd5c656aa5dff` (2026-11-16 UTC).  
Spec: [agentskills.io/specification](https://agentskills.io/specification) (fetched 2026-11-16).  
Auditor: [Audit Agent Skills discovery](bc-be4b2539-bf91-5a16-8d5a-e5b5d4d13a61).  
Tests cited were inventoried from source; they were **not** re-run in this audit.

## Study

Can OMP2 keep portable Agent Skills compatibility while expressing richer requirements?

## Inventory (owner: `crates/driver/src/discovery/skills.rs`)

| Concern | Status | Notes |
|---|---|---|
| Source ladder + convar policy | IV | native → config → claude → agent-plugins → agents → … → managed |
| Discovery / first-wins / containment | IV | `discover`, `load_skill`, `SkillResolver` |
| Progressive disclosure | IV | prompt facts = name+description; body via `/skill:` / `skill://` |
| Composition wiring | IV | `compose_kernel` → resolvers + `skills` prompt facts |
| Default frontmatter (`SkillHeader`) | II | unknown keys silently dropped; name rules looser than spec |
| Agent-plugin frontmatter | II | `deny_unknown_fields`; validates then **discards** license/metadata/compatibility/allowed-tools |
| Stored `Skill` shape | II | name, description, path, body, flags only — no optional Agent Skills retention |
| `allowed-tools` enforcement | A | parse-only on plugins; never gates admission |
| `compatibility` as gate | A | not used for model/OS preflight |
| E2E skill proof | A | unit + trust gates exist; no e2e skill path |

### Spec field matrix

| Spec field | General path | Agent-plugins path |
|---|---|---|
| `name` | optional; dir fallback; allows `_` `.` case | enforced kebab + dir match + ≤64 |
| `description` | required; **no 1024 length cap** on any path (EGM G6); managed only sanitizes | required; no 1024 cap |
| `license` / `compatibility` / `metadata` | ignored | validated then discarded (empty license rejected; `compatibility` ≤500; empty metadata keys rejected) |
| `allowed-tools` | ignored | empty rejected; else discarded; **not enforced** |
| Unknown keys | dropped | hard fail (`deny_unknown_fields`) |

OMP-specific fields (`enabled`, `hide`/`hidden`, …) exist on the **default** path; on the **plugin** header they are unknown → **hard fail** (EGM G5).

## Classify

**c/d hybrid:** discovery/read/invoke are covered (**REUSE**). Portable optional-field preservation and dual-parser divergence are real gaps (**EXTEND**). Do not add a second registry (**REJECT**).

## Recommendations

| Action | Target |
|---|---|
| **REUSE** | `ActiveSkills`, `SkillResolver`, progressive disclosure, containment, convar policy |
| **EXTEND** | Optionally retain `license`, `compatibility`, string `metadata` on `Skill` / prompt facts |
| **EXTEND** or document | Align default naming with Agent Skills, or record intentional divergence |
| **REJECT** as cohesive default (EGM F1) | Do not wire `allowed-tools` into admission without an ADR proving intersect-only (skill never expands authority); **document** parse-only until then |
| **DEFER** | Soften plugin `deny_unknown_fields` toward “ignore unknown” (owner/plugin-compat decision) |
| **DEFER** | E2E skill proof until a product gate requires it |
| **REJECT** | Parallel skill loader / second registry |

## Implications for model/tool requirements (→ `03-…`)

- Prefer **string `metadata` keys** or a **sidecar** validated independently — not nonstandard top-level fields.  
- `compatibility` is the standards-shaped place for environment prose; it must not grant authority.  
- `allowed-tools` must never authorize beyond existing admission/approvals if implemented.  
- Capability-based model/tool preflight belongs in native catalogs/routing, not in silently dropped YAML.

## Next slice (only if authorized)

Single docs/behavior PR: (1) publish omp vs Agent Skills field matrix, (2) decide non-plugin kebab/1024/dir-match, (3) either drop or truly enforce `allowed-tools`.
