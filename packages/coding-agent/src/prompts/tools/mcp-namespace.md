MCP server {{#each servers}}`{{this}}`{{#unless @last}}, {{/unless}}{{/each}} as the eval global `{{name}}`: one async method per server tool.

- JavaScript: `await {{name}}.<method>({ …args })`. Python: `await {{name}}.<method>(arg=…)`, or pass one dict.
- A call resolves to bare text or structured data when it contains only one of them. Tool errors throw.
- A result with both text and structured data, or with images, audio or resources, resolves to `{ text, structured?, images?, audio?, resources? }`. Read `text` as well as `structured`; the text may contain details absent from the structured summary.
  - `images`/`audio`: `local://mcp/…` files; see an image with `await tool.read({ path })` or the `read` tool.
  - `resources`: `{ uri, name?, description?, mimeType? }` plus `text` (embedded text) or `path` (embedded binary, saved under `local://mcp/`); a link has neither: `await read("mcp://<uri>")` returns its text, `await tool.read({ path: "mcp://<uri>" })` shows an image or document.
- Each method runs the session tool it is listed with; that tool's approval policy applies.

{{#each methods}}
## {{../name}}.{{name}} (`{{tool}}`)
{{description}}
```ts
type Args = {{{schema}}};
```
{{/each}}
{{#if resources.length}}
## Resources
Read one with `await read("mcp://<uri>")`; fill a template's `{placeholders}` first.
{{#each resources}}
- `{{uri}}`{{#if template}} (template){{/if}}{{#if name}} — {{name}}{{/if}}{{#if description}}: {{description}}{{/if}}
{{/each}}
{{#if omittedResources}}
- …and {{omittedResources}} more.
{{/if}}
{{/if}}
