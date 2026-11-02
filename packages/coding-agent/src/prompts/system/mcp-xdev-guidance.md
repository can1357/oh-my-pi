## MCP Tool Routes

{{#if tools.length}}
Execute each mounted tool: write JSON arguments to its path.{{#if hasCatalogOnlyTools}} Paths with a summary: read for docs + JSON schema before first use.{{/if}}
{{#each tools}}
- {{mcpToolName}} → `{{path}}`{{#if summary}} — {{summary}}{{/if}}
{{/each}}
{{/if}}
{{#if hasOmittedTools}}
Additional mounted MCP tool mappings omitted: prompt bounded. Inspect `xd://` for exact current paths.
{{/if}}
