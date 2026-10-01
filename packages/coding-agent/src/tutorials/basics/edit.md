`bun src/main.ts` crashes with a TypeError. Ask:
`fix the crash in cartTotal in src/cart.ts`
omp edits with hashline patches: each patch names the lines it replaces plus a snapshot tag from its last read, so an edit against a stale view fails instead of landing in the wrong place.
Watch the diff it prints; that is the whole change.
