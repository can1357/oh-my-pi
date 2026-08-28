# Fix a misspelled identifier in `{{filename}}`

A recent edit misspelled the identifier `{{correct}}` as `{{misspelled}}` in {{#when count "==" 1}}one place{{else}}{{count}} places{{/when}}.
{{#if affectedLines}}

Affected line{{#when count ">" 1}}s{{/when}}: {{join affectedLines ", "}}.
{{/if}}

Replace every occurrence of `{{misspelled}}` with `{{correct}}`. Do not change anything else.
