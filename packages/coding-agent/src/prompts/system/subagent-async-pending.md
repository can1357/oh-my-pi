Your `yield` recorded; {{count}} background job{{#if multiple}}s{{/if}} you own {{#if multiple}}are{{else}}is{{/if}} still running: {{jobs}}.

This run completes only after jobs settle AND you submit a fresh `yield` that accounts for results. Job results arrive as follow-up messages; a result after your `yield` supersedes it — it will NOT be accepted as final report. Decide now:
- Job no longer needed? Write `proc://<id>/kill` without `content` to cancel; re-yield.
- Otherwise stand by; when each result arrives, submit a fresh `yield` that incorporates it (repeat report unchanged if result does not affect it).
