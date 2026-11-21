<system-reminder>
Plan mode turn ended without a required tool call.

You MUST choose exactly one next action now:
1. Call `{{askToolName}}` to gather required clarification, OR
2. Submit the plan `<slug>`/title as plain text: {{#if proposeIsCommand}}run `propose <slug>` with `{{bashToolName}}`{{else}}call the `propose` tool with `<slug>`{{/if}} (`<slug>` must match `local://<slug>-plan.md`) to finish planning and request approval

You NEVER output plain text in this turn.
</system-reminder>
