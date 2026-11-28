{{#if declined}}
User declined changing `{{path}}`; it stays {{previous}}. NEVER retry unless the user asks.
{{/if}}
{{#if unchanged}}
`{{path}}` {{#if patch}}already has{{else}}is already{{/if}} {{value}}; nothing changed.
{{/if}}
{{#if saved}}
Saved `{{path}}` {{#if patch}}entries{{else}}={{/if}} {{value}} to the global config (was {{previous}}).
{{#if effective}}
Effective value is still {{effective}}: the {{provenance}} takes precedence over the global config, so the saved value does not take effect. Tell the user.
{{/if}}
{{/if}}
{{#if applied}}
Set `{{path}}` {{#if patch}}entries{{else}}={{/if}} {{value}} for this session only (was {{previous}}); NOT saved.
{{#if effective}}
Effective value is still {{effective}}: the {{provenance}} takes precedence over session overrides and the global config, so neither this change nor saving it takes effect. Tell the user; NEVER retry.
{{else}}
Ask the user whether they are happy with it. Yes → `write {{saveUrl}}` with the same content to persist. No → restore by writing {{previous}} to `{{url}}`.
{{/if}}
{{/if}}
