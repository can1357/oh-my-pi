Run deep multi-step web research on a question and return a comprehensive markdown report with citations.

This tool launches a supervised research pipeline: a supervisor breaks the question into subtopics, parallel researcher sub-agents search the web (via the configured web search providers), findings are compressed and merged, and a final report is written. Runs typically take a few minutes and make many model calls — prefer it over repeated `web_search` calls when the user wants a thorough, cited answer on a complex topic.

Before calling:
- Make sure the research question is specific and self-contained. If the user's request is ambiguous (unclear scope, acronyms, missing constraints), ask the user for clarification FIRST, then call this tool with the refined question — the pipeline runs autonomously and cannot ask questions mid-run.
- Do not use this tool for simple fact lookups; use `web_search` instead.

The question should be a single, detailed paragraph describing exactly what the report should cover.

Optional parameters:
- `model`: run the whole pipeline on a specific model as `provider/model-id` (any model available to omp), instead of the session's active model. Per-role overrides come from the `deepResearch.*` settings.
- `max_total_tokens`: overall token budget for the run. When crossed, research winds down gracefully and the report is written from findings gathered so far (a cooldown pause also slows calls near the limit). Overrides the `deepResearch.maxTotalTokens` setting.
- `max_researchers`: cap on concurrent researcher sub-agents (default 5).
