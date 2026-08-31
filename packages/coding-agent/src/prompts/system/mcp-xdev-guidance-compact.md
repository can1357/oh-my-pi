## MCP Tool Routes

Execute a mounted MCP tool by writing its JSON arguments to its `xd://` path.
{{#if ruleServers.length}}
An MCP tool `T` on server `S` lives at `{{xdPrefix}}mcp__<S>_<T>`. Lowercase both names, replace each run outside `a-z` or `_` with `_`, collapse and trim underscores, and use `server` or `tool` if a name becomes empty. If normalized `T` starts with normalized `S` plus `_`, drop that redundant server prefix. Servers following this rule: {{#list ruleServers join=", "}}{{this}}{{/list}}.
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
