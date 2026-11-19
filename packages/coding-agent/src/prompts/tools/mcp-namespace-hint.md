Write one routing hint of at most 15 words: WHEN to call these functions; WHEN NOT only if it prevents confusion with local tools. Retain recognizable trigger words for the service and its main capabilities. Name the service only if `{{name}}` does not make it obvious. Do not list function names or market it. Output one line without bullets or quotes.

Namespace: {{name}} (MCP server {{#each servers}}{{this}}{{#unless @last}}, {{/unless}}{{/each}})
Functions:
{{#each methods}}
- {{name}}: {{description}}
{{/each}}
