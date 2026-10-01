---
name: init
description: Generate AGENTS.md for current codebase
thinking-level: medium
---

Use parallel `task` research agents: core src, tests, configs/build, scripts/docs; synthesize findings into one AGENTS.md.

<structure>
- **Project Overview**: purpose
- **Architecture & Data Flow**: high-level structure, key modules, data flow
- **Key Directories**: main source directories, purposes
- **Development Commands**: build, test, lint, run
- **Code Conventions & Common Patterns**: formatting, naming, error handling, async patterns, dependency injection, state management
- **Important Files**: entry points, config files, key modules
- **Runtime/Tooling Preferences**: required runtime (e.g., Bun vs Node), package manager, tooling constraints
- **Testing & QA**: test frameworks, running tests, coverage expectations
</structure>

<directives>
- MUST title document "Repository Guidelines"
- MUST use Markdown headings
- MUST concise and practical
- MUST focus on AI-assistant-relevant codebase help
- SHOULD include helpful examples: commands, paths, naming patterns
- SHOULD include relevant file paths
- MUST explicitly call out architecture and code patterns
- SHOULD omit code-structure-obvious information
</directives>

<output>
After analysis: MUST write AGENTS.md to project root.
</output>
