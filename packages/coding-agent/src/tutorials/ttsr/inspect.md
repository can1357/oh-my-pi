Check which rules are active and whether any existing code already breaks one:
`run omp ttsr list, then omp ttsr scan, and summarise`
To try a condition directly, use `omp ttsr test --path src/x.ts 'console.log(1)'`.
