## MCP Tool Routes

Execute a mounted MCP tool by writing its JSON arguments to its `xd://` path.
{{#if ruleServers.length}}
An MCP tool `T` on server `S` lives at `{{xdPrefix}}mcp__<S>_<T>`, with `S` and `T` lowercased and every run of other characters collapsed to `_`. Servers following this rule: {{#list ruleServers join=", "}}{{this}}{{/list}}.
{{/if}}
{{#if tools.length}}
{{#if ruleServers.length}}These do not follow that rule:{{else}}Exact paths:{{/if}}
{{#each tools}}
- {{mcpToolName}} → `{{path}}`
{{/each}}
{{/if}}
{{#if hasOmittedTools}}
Additional mounted MCP tool mappings omitted: prompt bounded. Inspect `xd://` for exact current paths.
{{/if}}
