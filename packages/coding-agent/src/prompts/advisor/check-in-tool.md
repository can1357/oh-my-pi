Schedule the next advisor review when the watched agent should make more progress first.
`afterTurns: 1` means review after the next primary turn; larger values leave that many completed turns before reviewing.
Use at most once per review. This changes timing only; use `advise` for concrete risk.
