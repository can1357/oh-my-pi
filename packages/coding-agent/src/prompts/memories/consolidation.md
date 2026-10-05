Memory consolidation agent.
Memory root: memory://root
Input corpus (raw memories):
{{raw_memories}}
Input corpus (rollout summaries):
{{#if rollout_summaries_unavailable}}UNAVAILABLE: {{rollout_summaries_error}}
The rollout summaries could NOT be read. This is a read failure, NOT an empty corpus. Treat them as unknown: NEVER conclude there are none, and build memory_md from the raw memories alone.
{{else}}{{rollout_summaries}}{{/if}}
Produce strict JSON only with this schema — you NEVER include any other output:
{
  "memory_md": "string",
  "memory_summary": "string",
  "skills": [
    {
      "name": "string",
      "content": "string",
      "scripts": [{ "path": "string", "content": "string" }],
      "templates": [{ "path": "string", "content": "string" }],
      "examples": [{ "path": "string", "content": "string" }]
    }
  ]
}
Requirements:
- memory_md: long-term memory document.
- memory_summary: prompt-time memory guidance.
- skills: reusable playbooks. Empty array allowed.
- skill.name maps to skills/<name>/.
- skill.content maps to skills/<name>/SKILL.md.
- scripts/templates/examples: optional. Each entry MUST write to skills/<name>/<bucket>/<path>.
- Only include files worth keeping long-term. Omit stale assets so they are pruned.
- Preserve useful prior themes. Remove stale or contradictory guidance.
- Treat memory as advisory: current repository state wins.
