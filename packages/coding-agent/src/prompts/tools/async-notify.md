<system-notice>
{{#each reports}}
{{#if service}}Supervised process {{id}}{{else}}Background job {{id}} ({{command}}){{/if}} {{#if running}}is still running{{else}}has since ended{{/if}}. Its output matched /{{pattern}}/:
{{#each lines}}
{{this}}
{{/each}}
{{#if omitted}}
… plus {{omitted}} not shown; read proc://{{id}} for the output.
{{/if}}
{{#if stopped}}
It matched too often: `notify` is off for it and later matches are not reported.
{{/if}}
{{/each}}
</system-notice>
