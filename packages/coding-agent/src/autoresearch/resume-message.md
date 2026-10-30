Continue the autoresearch loop now.

- Re-read your notes and the recent-runs context above before deciding the next direction.
- Inspect recent git history for context.
{{#if has_pending_run}}
- A previous benchmark run completed but was never logged. Finish `log_experiment` before starting a new run.
{{/if}}
- Continue from the most promising unfinished direction.
- Keep iterating until interrupted or until the configured iteration cap is reached.
- Preserve correctness and do not game the benchmark.
