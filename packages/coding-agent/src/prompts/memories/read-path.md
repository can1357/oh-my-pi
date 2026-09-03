# Memory Guidance
Root: memory://root
Rules:
1. Read `memory://root` first. It resolves to the current summary when available.
2. If it is unavailable or more detail is needed, inspect `memory://root/MEMORY.md` and `memory://root/skills/<name>/SKILL.md`.
3. Memory: heuristics/process context; current repo files, runtime output, user instruction: factual state/final decisions.
4. Memory changes plan → cite artifact path (e.g. `memory://root/skills/<name>/SKILL.md`) and current-repo evidence.
5. Memory disagreement with repo state/user instruction → stale; corrected behavior, then update/regenerate memory artifacts.
6. Confidence only after repository verification; memory alone NEVER sufficient proof.
{{#if memory_summary}}
Memory summary:
{{memory_summary}}
{{/if}}
{{#if learned}}
Learned lessons (`learn`-captured; durable but may be stale—verify against repo before relying):
{{learned}}
{{/if}}
