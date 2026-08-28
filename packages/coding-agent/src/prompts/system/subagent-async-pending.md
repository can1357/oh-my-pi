Your `yield` recorded; {{count}} background job{{#if multiple}}s{{/if}} you own {{#if multiple}}are{{else}}is{{/if}} still running: {{jobs}}.

This run completes only after jobs settle AND you submit a fresh `yield` that accounts for results. Job results arrive as follow-up messages; a result after your `yield` supersedes it — it will NOT be accepted as final report. Decide now:
- Need results? Wait (`hub` op:"wait"), then submit a fresh `yield` that incorporates them.
- Job no longer needed? Cancel (`hub` op:"cancel", ids:[…]); re-yield.
- Otherwise stand by; when each result arrives, submit a fresh `yield` (repeat report unchanged if result does not affect it).
