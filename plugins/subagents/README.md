# Subagents Plugin

Task delegation system with specialized subagents for pi.

## Installation

```bash
omp install @oh-my-pi/subagents
```

## Contents

### Tool

- `tools/task/index.ts` - The Task tool for launching subagents

### Agents

- `agents/task.md` - General-purpose subagent for delegated tasks
- `agents/planner.md` - Software architect for designing implementation plans
- `agents/explore.md` - Fast read-only codebase scout
- `agents/reviewer.md` - Expert code reviewer
- `agents/browser.md` - Single-URL content fetcher and extractor

### Commands

- `commands/implement.md` - Implement a feature
- `commands/implement-with-critic.md` - Implement with critic review loop
- `commands/architect-plan.md` - Create an architecture plan
