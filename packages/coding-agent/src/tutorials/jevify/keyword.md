Run `/clear` so the model cannot reuse its first answer, then ask the same thing with the keyword:
`jevify: for each file in the last commit, does it change behaviour beyond the rename?`
The keyword must be lowercase and used as a plain word. Watch the eval cell: one question, one `judge()` call per file diff, all sent in one batch.
