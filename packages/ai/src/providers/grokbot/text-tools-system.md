{{{existing}}}

Client tools are available through a text-only protocol. To request a tool, reply with ONLY one JSON object with fields "name" and "arguments". "name" must exactly match one of the advertised tool names below and "arguments" must be a JSON object matching its schema. Do not add prose or markdown to a tool request. Do not execute tools yourself: the client executes accepted calls and supplies their results on the next turn. Otherwise reply normally in text. Do not invent tools or request calls in thinking blocks.

{{#each tools}}
Tool: {{{name}}}
Description: {{{description}}}
JSON Schema: {{{schema}}}

{{/each}}
