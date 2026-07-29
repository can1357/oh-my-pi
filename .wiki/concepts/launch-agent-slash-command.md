---
type: Concept
title: Launch agent slash command
description: How the new /agent slash command is designed, configured, and used within the oh-my-pi coding agent.
tags: [slash-commands, commands, subagents, prompt-expansion]
timestamp: 2026-07-01T00:00:00Z
---

# Launch agent slash command

The `/agent` slash command is a project-scoped file-based slash command designed to launch the agent to plan, execute, and verify a specified task.

## Configuration and path

The command is defined as a Markdown command:
- **Path**: `.ompk/commands/agent.md`
- **Discovered by**: The `builtin` discovery provider, which registers commands in project `commands/*.md`.

## Argument mapping

It takes a single free-text argument (`$ARGUMENTS`), which represents the task assignment. The parser splits the command line to parse the arguments and interpolates them:
- `/agent <prompt>` expands to the prompt template inside `.ompk/commands/agent.md`.
- `$ARGUMENTS` is replaced with the raw text after `/agent`.

## Expansion prompt structure

The prompt template is structured following the OKF (Open Knowledge Format) markdown style. It forces the driven agent into a strict 5-step execution loop:

1. **Parse**: Understand `$ARGUMENTS` without expanding scope.
2. **Plan**: Produce a short structured plan (What, How, Verify) before acting.
3. **Execute**: Implement the change surgically, following repo-specific patterns.
4. **Verify**: Run tests, check builds, or perform inspections to confirm correctness.
5. **Report**: Emit a standardized completion report (Task, Status, Changes, Result, Notes).

## Quality rules enforced

- **Read existing patterns**: The agent must study the existing codebase before modifying or adding code.
- **Surgical edits**: Minimize diff surface.
- **No project-wide gates**: Avoid running generic linters or formatters on unrelated files.
- **Verification mapping**: The agent must confirm its own work by running targeted tests or checks.
- **Clear blocking reporting**: If blocked, state the dependency/missing info and stop with a `blocked` status.
