Git is your undo button: this project started as a clean commit. Ask:
`undo that change with git`
omp runs something like `git checkout -- src/cart.ts` and the original line is back, bug included.
Review before you undo with `show me git diff`; throw away a whole session of edits with one `git checkout -- .`.
