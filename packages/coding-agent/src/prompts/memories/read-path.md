# Memory Guidance
Root: memory://root
Rules:
{{#if memory_summary}}
- Read `memory://root/memory_summary.md` first.
- If needed, inspect `memory://root/MEMORY.md` and `memory://root/skills/<name>/SKILL.md`.
{{/if}}
- Memory: heuristics/process context; current repo files, runtime output, user instruction: factual state/final decisions.
- Memory changes plan → cite artifact path (e.g. `memory://root/skills/<name>/SKILL.md`) and current-repo evidence.
- Memory disagreement with repo state/user instruction → stale; corrected behavior, then update/regenerate memory artifacts.
- Confidence only after repository verification; memory alone NEVER sufficient proof.
{{#if memory_summary}}
Memory summary:
{{memory_summary}}
{{/if}}
{{#if learned}}
Learned lessons (`learn`-captured; durable but may be stale—verify against repo before relying):
{{learned}}
{{/if}}
