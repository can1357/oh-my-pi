# Agent Skills vs OMP discovery (current behavior)

Owner: `crates/driver/src/discovery/skills.rs`.  
Spec reference: [agentskills.io/specification](https://agentskills.io/specification).  
This document locks **observable discovery behavior**. It does not authorize tools, models, or network access. Skill YAML never expands admission authority.

## Dual frontmatter regimes

| Field / rule | Default / Claude / agents path (`SkillHeader`) | Agent Plugins path (`AgentPluginSkillHeader`) |
|---|---|---|
| `name` | Optional; directory fallback; may include `_` `.` and mixed case | Required; kebab + directory match rules (plugin layout) |
| `description` | Required to admit; **no** 1024-char length clamp | Required; no 1024 clamp |
| `license` | Ignored (unknown → dropped) | Validated (non-empty if present) then **discarded** |
| `compatibility` | Ignored | Validated (≤500 chars if present) then **discarded** |
| `metadata` | Ignored | Validated (no empty keys) then **discarded** |
| `allowed-tools` | Ignored | Empty string rejected; otherwise parsed then **discarded**; **not enforced** on admission |
| Unknown keys | Silently dropped | `deny_unknown_fields` → hard fail |
| OMP `enabled` / `hide` / `disable-model-invocation` | Honored | Unknown on plugin header → hard fail |

Stored `Skill` retains: name, description, paths, provider, level, hidden, body. Optional Agent Skills fields are **not** retained today.

## Progressive disclosure

Prompt facts expose name + description. Bodies load via `/skill:` / `skill://`. Source ladder and first-wins collision policy live in `discover` / `ActiveSkills`.

## Intentional non-goals (until an ADR says otherwise)

- Wiring `allowed-tools` into ApprovalBook / roster admission.  
- Treating `compatibility` or `metadata` as model/tool preflight gates.  
- A second skill registry outside driver discovery.
