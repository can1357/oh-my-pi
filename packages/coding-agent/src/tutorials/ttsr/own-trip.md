New rules load only at session start or on `/clear`. Run `/clear`, then:
`add src/token.ts with isExpired(expiresAt: number) that checks it against the current time`
Look for "Injecting rule: use-clock" in the transcript. Then confirm that the final file calls `now()`.
