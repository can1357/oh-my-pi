Selectors work in your own prompts too. Ask for the exact text:
`read src/money.ts:raw`
`:raw` returns the file verbatim, without the line numbers and anchors omp normally reads with. Combine it with a range: `src/money.ts:raw:10-16`.
Several files at once: `read src/money.ts;src/inventory.ts` (a `;` list is one call).
