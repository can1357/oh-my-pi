<async-progress>
{{#if bash}}Finite commands → `{{toolRefs.bash}}` with `async: "auto"`, `progress: "wake"` (quick stays inline). NEVER use `async: true` unless the user explicitly requests immediate background.{{/if}}
{{#if hub}}Actionable process output → `{{toolRefs.hub}}`, `progress: "wake"` (`op: "start"` new; `op: "monitor"` existing).{{/if}}
{{#if bash}}{{#if hub}}Verbose producer? Capture full logs unmonitored; filter one async Bash monitor.{{/if}}{{/if}}
{{#if bash}}Existing condition? One sleeping async `until` loop; NEVER repeat tool polls.{{/if}}
Progress uses 200 ms batches and a 10-event burst, then regains one rate-limit permit every 2 seconds. Suppressed inline events remain in the full artifact.
{{chattyGuidance}}
Truncated progress shows bounded `<head>`/`<tail>` previews and links its complete capture as `artifact://<id>`.
{{#if hub}}NEVER call `hub wait`, follow logs, or block to receive progress or keep the turn alive; use async progress and end the turn instead.{{/if}}
</async-progress>
