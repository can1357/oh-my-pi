Pool `{{pool}}` unit ledger: {{summary.accepted}}/{{summary.total}} accepted ({{summary.verified}} with passed verification), {{summary.residual}} residual, {{summary.cancelled}} cancelled.
{{#each units}}

## [{{id}}] {{state}}{{#if verified}} · verified{{/if}}{{#if reason}} · {{reason}}{{/if}} — {{label}}
{{#if detail}}Detail: {{detail}}
{{/if}}{{#if valueJson}}Value: {{valueJson}}
{{/if}}{{#if evidence}}Evidence: {{join evidence "; "}}
{{/if}}{{#if verification}}Verification: {{verification.status}}{{#if verification.commands}} via {{join verification.commands "; "}}{{/if}}{{#if verification.details}} — {{verification.details}}{{/if}}
{{/if}}Attempts:{{#each attempts}} #{{attempt}} {{agentId}}/{{batchId}} → {{result}};{{/each}}
{{/each}}
