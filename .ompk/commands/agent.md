# Agent Command

Launch a task-agent to plan, execute, and verify a work item using all available tools.

## Arguments

- `$ARGUMENTS` — **required**. A free-text task description: a feature request, bug fix, refactor, research question, or any other goal the agent should pursue. Quote the argument if it contains special characters.

## Steps

### 1. Parse the task

Read `$ARGUMENTS` as the agent's mission. Treat it as the single source of truth for this run — do not expand scope, add side quests, or re-interpret the ask beyond what is stated. If the task is ambiguous, state the ambiguity and make a reasonable default choice rather than asking for clarification (unless the ambiguity is a critical constraint that would make the work non-recoverable).

### 2. Plan before acting

Before touching any files or running any commands, the agent MUST produce a short structured plan:

1. **What** — concrete deliverable (file changed, command run, test added, doc written).
2. **How** — approach in 2–5 steps.
3. **Verify** — how to confirm the deliverable is correct (test, build, screenshot, manual check).

If the task is trivial (single-file edit, one command), the plan may be one sentence.

### 3. Execute

Follow the plan step by step using available tools (`read`, `edit`, `write`, `bash`, `search`, `task`, `eval`, `browser`, or any other tool the harness exposes).

Rules during execution:

- **MUST** read existing code patterns before writing new code.
- **MUST** make surgical edits — change only what the task requires.
- **MUST NOT** run project-wide build, lint, format, or test gates unless the task explicitly asks for them.
- **MUST NOT** leave temporary files, half-written stubs, or `TODO` comments as deliverables.
- **MUST NOT** fabricate outputs or claim results that were not exercised.

### 4. Verify

After executing, confirm the deliverable matches the plan:

- Run the specific test, build command, or inspection that exercises the changed path.
- If the task produces a file, confirm the file exists and its contents are correct.
- If the task fixes a bug, reproduce the bug first (if not already confirmed), then confirm it no longer occurs.

### 5. Report

Print a brief completion report:

```
Task:     <one-line restatement of the goal>
Status:   done | blocked | partial
Changes:  <files touched or commands run>
Result:   <what was produced or confirmed>
Notes:    <anything the human should know>
```

## Examples

```
/agent refactor the JSON-RPC client in packages/wire/src to use typed errors instead of string codes
```

```
/agent investigate why the TUI renders slowly on Windows when scrolling large output
```

```
/agent add a --json flag to the cli that outputs results as NDJSON
```

## Notes

- The agent has full tool access. It may spawn subagents, run shell commands, edit files, and query external services as needed to complete the task.
- The agent should prefer existing patterns and conventions found in the codebase over inventing new ones.
- If blocked by missing information (a dependency, a secret, a decision that is out of scope), state what is missing and return `blocked` rather than silently skipping the work.
