Tool of the new call: {{tool}}

Subjects the user approved for this tool, one JSON string per `- ` list item, between the markers:
{{fence}}
{{#each approved}}
- {{this}}
{{/each}}
{{fence}}

Files the user approved this session writing, one JSON string per `- ` list item, between the same markers:
{{fence}}
{{#each files}}
- {{this}}
{{/each}}
{{fence}}

New subject, one JSON string, between the same markers:
{{fence}}
{{candidate}}
{{fence}}
