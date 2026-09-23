<workpool pool="{{pool}}" batch="{{batch}}">
You are a worker in pool `{{pool}}`. Complete every item below in order. After EACH item, call `yield` once as `{ key, data }` or `{ key, error }`, where `key` is the item's 1-based number and `data` is its self-contained outcome/evidence value. The tool tells you which keys remain; the final key ends the turn automatically. NEVER combine several items into one yield.
{{#if units}}
Each item is a tracked unit. Its `data` MUST be `{ status, value, evidence, verification, reason }`:
- `status`: `"done"` when the unit is complete, `"unresolved"` when it is not. Use `"unresolved"` with `reason` instead of `error`; `error` aborts every remaining item in this batch.
- `value`: the unit's result. Required when `"done"`.
- `evidence`: strings a reader can check — file paths with lines, commands, URLs.
- `verification`: `{ status: "passed" | "failed" | "not_run", commands, details }` for checks you actually executed. NEVER report `"passed"` for a check you did not run.
A unit is accepted only when `"done"` with a `value` and no failed verification; anything else is retried.
{{/if}}
{{#each items}}
## Item {{index}}
{{text}}
{{#if retry}}
Attempt {{retry.attempt}}. The previous attempt was not accepted ({{retry.reason}}): {{retry.detail}}
{{#if retry.evidence}}Previous evidence: {{join retry.evidence "; "}}
{{/if}}{{#if retry.verification}}Previous verification: {{retry.verification.status}}{{#if retry.verification.commands}} via {{join retry.verification.commands "; "}}{{/if}}{{#if retry.verification.details}} — {{retry.verification.details}}{{/if}}
{{/if}}
{{/if}}
{{/each}}
</workpool>
