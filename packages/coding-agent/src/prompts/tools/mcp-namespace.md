MCP server {{#each servers}}`{{this}}`{{#unless @last}}, {{/unless}}{{/each}} as the eval global `{{name}}`: one async method per server tool.

- JavaScript: `await {{name}}.<method>({ …args })`. Python: `await {{name}}.<method>(arg=…)`, or pass one dict.
- A call resolves to the tool's structured content when the server sends it, else its text; images are displayed. A tool error throws.
- Each method runs the session tool it is listed with; that tool's approval policy applies.

{{#each methods}}
## {{../name}}.{{name}} (`{{tool}}`)
{{description}}
```ts
type Args = {{{schema}}};
```

{{/each}}
