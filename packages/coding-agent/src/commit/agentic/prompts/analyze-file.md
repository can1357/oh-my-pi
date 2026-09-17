Analyze {{file}}.

Goal:
{{#if goal}}
{{goal}}
{{else}}
Summarize purpose and commit-relevant changes.
{{/if}}

Return concise JSON object:
- summary: 1-sentence file-role description
- highlights: 2-5 bullets, notable behaviors or changes
- risks: edge cases or risks worth noting; [] if none

{{#if related_files}}
## Other Files in This Change
{{related_files}}

Relate file changes to these files.
{{/if}}

Call yield tool with JSON payload.
