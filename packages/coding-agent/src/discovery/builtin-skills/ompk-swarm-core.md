---
name: ompk-swarm-core
description: Use OMPK native task subagents for parallel delegation, review separation, and swarm-style workflows.
---

# OMPK Swarm Workflow

Use when the user asks for subagents, parallel agent work, swarm delegation, or explicit parallelization in OMPK.

## Native runtime

Use OMPK `task` tool. Do not use Claude Code `Agent` syntax. Do not shell out to Codex/Ruflo delegation scripts unless the user explicitly needs Ruflo-only topology, hive-mind, or external registry features.

## Agent mapping

| Need | Use |
|---|---|
| Read-only code scouting | `agent: "explore"` |
| General implementation | `agent: "task"` |
| Senior implementation/debugging | `agent: "oracle"` |
| Code review | `agent: "reviewer"` or specific `ce-*reviewer` |
| Repo convention research | `agent: "ce-repo-research-analyst"` |
| External library source research | `agent: "librarian"` |
| Web research | `agent: "ce-web-researcher"` |

## Fanout rules

- Batch all independent tasks in one `task` call with multiple `tasks[]`.
- Use tailored `role` for each subagent. Avoid generic clones.
- Put shared background once in `context` using sections: `# Goal`, `# Constraints`, `# Contract`.
- Put exact target/change/acceptance in each `assignment` using sections: `# Target`, `# Change`, `# Acceptance`.
- Subagents have no conversation memory. Include every needed file path, symbol, constraint, and output shape.
- Prefer disjoint file ownership. If overlap is likely, instruct agents to coordinate via IRC before editing.
- Subagents must skip project-wide test/lint/format. Main agent runs final verification once.
- Keep authoring and review separate. Writer does not approve own work.

## Prompt template

```text
# Goal
One sentence describing batch outcome.

# Constraints
- Repo rules and non-goals.
- Skip project-wide commands.
- Preserve unrelated user work.

# Contract
Shared APIs/types/decisions, if any.
```

Assignment template:

```text
# Target
Exact files, symbols, and non-goals.

# Change
Concrete steps. Say whether to edit or only research.

# Acceptance
Observable result and concise report shape. No project-wide commands.
```

## Review pass

After implementation agents finish, spawn independent reviewer agents only when diff is non-trivial, risky, or user requested review. Use targeted reviewers for security, API contracts, migrations, performance, or frontend races. Main agent still verifies files and runs final package-local checks.

## Example

```ts
task({
  i: "Delegating prompt audit",
  agent: "task",
  context: `# Goal
Reduce context bloat in oh-my-pi-fork harness.

# Constraints
Do not edit AGENTS.md. Skip project-wide tests/lint/format. Report changed files and risks only.

# Contract
Compression changes must preserve exact raw output via artifact/read recovery path.`,
  tasks: [
    {
      id: "PromptBudgetScout",
      role: "System prompt budget analyst",
      description: "Measure prompt bloat sources",
      assignment: `# Target
packages/coding-agent/src/system-prompt.ts and prompt assembly code.

# Change
Identify always-loaded sections and token-heavy injections. Do not edit.

# Acceptance
Report top bloat sources with file paths and safest removal strategy under 300 words.`
    },
    {
      id: "ToolOutputScout",
      role: "Tool output compression analyst",
      description: "Find tool output bloat paths",
      assignment: `# Target
Tool result formatting and transcript rebuild paths in packages/coding-agent.

# Change
Find where read/search/bash outputs enter model context. Do not edit.

# Acceptance
Report exact symbols/files and safest compression insertion point under 300 words.`
    }
  ]
})
```

## Hard stops

- Never call Claude Code `Agent` tool syntax in OMPK.
- Never use Codex-native delegate scripts from OMPK unless explicitly requested.
- Never let implementation agent self-approve.
- Never report success without checking actual file changes and verification output.
