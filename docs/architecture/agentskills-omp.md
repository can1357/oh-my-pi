# Agent Skills vs OMP discovery (current behavior)

Owner: `crates/driver/src/discovery/skills.rs`.  
Spec reference: [agentskills.io/specification](https://agentskills.io/specification).  
This document locks **observable discovery behavior**. It does not authorize tools, models, or network access. Skill YAML never expands admission authority.

## Dual frontmatter regimes

| Field / rule | Default / Claude / agents path (`SkillHeader`) | Agent Plugins path (`AgentPluginSkillHeader`) |
|---|---|---|
| `name` | Optional; directory fallback; may include `_` `.` and mixed case | Required; kebab + directory match rules (plugin layout) |
| `description` | Required to admit; **no** 1024-char length clamp | Required; no 1024 clamp |
| `license` | Retained on `Skill` when non-empty | Validated (non-empty if present) then **retained** |
| `compatibility` | Retained on `Skill` when non-empty | Validated (≤500 chars if present) then **retained** |
| `metadata` | Retained string→string map (empty keys dropped) | Validated (no empty keys) then **retained** |
| `allowed-tools` | Ignored (not retained; not enforced) | Empty string rejected; otherwise parsed then **discarded**; **not enforced** on admission |
| Unknown keys | Silently dropped | `deny_unknown_fields` → hard fail |
| OMP `enabled` / `hide` / `disable-model-invocation` | Honored | Unknown on plugin header → hard fail |

Stored `Skill` retains: name, description, optional license/compatibility/metadata, paths, provider, level, hidden, body.

## Progressive disclosure

Prompt facts expose **name + description only**. Bodies load via `/skill:` / `skill://`. Retained license/compatibility/metadata are for portability and diagnostics — they are **not** model/tool preflight gates and do not appear in `<skills>` prompt facts.

Source ladder and first-wins collision policy live in `discover` / `ActiveSkills`.

## Intentional non-goals (until an ADR says otherwise)

- Wiring `allowed-tools` into ApprovalBook / roster admission.  
- Treating `compatibility` or `metadata` as model/tool preflight gates.  
- A second skill registry outside driver discovery.
