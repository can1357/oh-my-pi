# Fix a bug in `{{filename}}`

{{#when kind "==" "case-label"}}
In this file's `switch`, the value in `{{label}}` must be handled exactly like the case after it: add a fall-through `{{label}}` label directly before `{{before}}`.
{{/when}}
{{#when kind "==" "duplicate-block"}}
The block starting with `{{head}}` appears twice in a row — the second copy is a copy-paste accident. Delete the second copy and keep the first.
{{/when}}
{{#when kind "==" "move-block"}}
The block starting with `{{head}}` was moved to the wrong place — it currently sits after `{{currentPrev}}`. Move it back so it comes directly before `{{destination}}`.
{{/when}}
{{#when kind "==" "wrap-if"}}
A leftover debugging wrapper is redundant: remove the `if (true) {` on line {{wrapperLine}} together with its closing brace, and dedent the wrapped body one level.
{{/when}}
{{#when kind "==" "swap-blocks"}}
Two adjacent blocks are in the wrong order: the block starting with `{{secondHead}}` belongs before the block starting with `{{firstHead}}`. Swap the two blocks.
{{/when}}
{{#when kind "==" "swap-lines"}}
Two adjacent statements are in the wrong order: `{{secondHead}}` belongs before `{{firstHead}}`. Swap the two statements.
{{/when}}
{{#when kind "==" "swap-if-else"}}
The branch bodies of `{{condition}}` are swapped: the current `else` body belongs under the `if`, and vice versa. Swap the two branch bodies.
{{/when}}

After the fix, the affected {{#when hunkCount ">" 1}}regions must{{else}}region must{{/when}} read exactly:
{{#each hunks}}
{{#if startLine}}

Around line {{startLine}}:
{{/if}}

{{../fence}}{{../language}}
{{newCode}}
{{../fence}}
{{/each}}

Make exactly this change; do not modify anything else.
