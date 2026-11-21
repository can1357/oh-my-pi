## MCP Tool Commands

{{#if tools.length}}
Run each as a command with the bash tool.{{#if hasCatalogOnlyTools}} Commands with a summary: run `<command> --help` before first use.{{/if}}
{{#each tools}}
- {{mcpToolName}} → `{{path}}`{{#if summary}} — {{summary}}{{/if}}
{{/each}}
{{/if}}
{{#if hasOmittedTools}}
Additional mounted MCP tools omitted: prompt bounded. Further tools are mounted under their `mcp__<server>__<tool>` command names.
{{/if}}
