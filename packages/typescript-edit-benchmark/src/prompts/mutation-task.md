# Fix a bug in `{{filename}}`

{{#when name "==" "swap-comparison"}}
A comparison operator is subtly wrong.
{{/when}}
{{#when name "==" "swap-equality"}}
An equality operator is inverted.
{{/when}}
{{#when name "==" "swap-logical"}}
A boolean operator is incorrect.
{{/when}}
{{#when name "==" "remove-negation"}}
A logical negation (`!`) was accidentally removed.
{{/when}}
{{#when name "==" "swap-increment-decrement"}}
An increment/decrement operator points the wrong direction.
{{/when}}
{{#when name "==" "swap-arithmetic"}}
An arithmetic operator was swapped.
{{/when}}
{{#when name "==" "flip-boolean"}}
A boolean literal is inverted.
{{/when}}
{{#when name "==" "remove-optional-chain"}}
Optional chaining was removed from a property access.
{{/when}}
{{#when name "==" "swap-call-args"}}
Two arguments in a call are swapped.
{{/when}}
{{#when name "==" "swap-nullish"}}
A nullish coalescing operator was swapped.
{{/when}}
{{#when name "==" "swap-regex-quantifier"}}
A regex quantifier was swapped, changing whitespace matching.
{{/when}}
{{#when name "==" "unicode-hyphen"}}
A string literal contains a lookalike unicode dash.
{{/when}}
{{#when name "==" "off-by-one"}}
A numeric boundary has an off-by-one error.
{{/when}}
{{#when name "==" "duplicate-line-flip"}}
One copy of a line that repeats elsewhere in this file was altered.
{{/when}}
{{#when name "==" "composite-multi-edit"}}
This file contains several small, unrelated single-line bugs.
{{/when}}
{{#if functionName}}

The bug is in the `{{functionName}}` function.
{{/if}}
{{#when region "==" "top"}}

The bug is near the top of the file.
{{/when}}
{{#when region "==" "middle"}}

The bug is around the middle of the file.
{{/when}}
{{#when region "==" "end"}}

The bug is near the end of the file.
{{/when}}
{{#each hunks}}
{{#when ../hunkCount ">" 1}}

## Change {{add @index 1}}
{{/when}}

{{#if isDelete}}Delete this block{{#if startLine}} (starting on line {{startLine}}){{/if}}:{{else}}Replace this{{#if startLine}} (starting on line {{startLine}}){{/if}}:{{/if}}

{{../fence}}{{../language}}
{{oldCode}}
{{../fence}}
{{#unless isDelete}}

with:

{{../fence}}{{../language}}
{{newCode}}
{{../fence}}
{{/unless}}
{{/each}}

{{#if nightmare}}This file contains near-identical code in multiple places — edit exactly the block shown and nothing else.{{else}}Make exactly this change; do not modify anything else.{{/if}}
