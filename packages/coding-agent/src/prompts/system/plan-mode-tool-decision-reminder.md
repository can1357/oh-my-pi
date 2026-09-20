<system-reminder>
Plan mode turn ended without a required tool call.

You MUST choose exactly one next action now:
1. Call `{{askToolName}}` to gather required clarification, OR
2. For an implementation request, write the plan slug/title (`<slug>`, matching `local://<slug>-plan.md`) as plain text to `xd://propose` with `{{writeToolName}}` to finish planning and request explicit implementation approval, OR
3. For a design-only request, write the plan slug/title (`<slug>`, matching `local://<slug>-plan.md`) as plain text to `xd://deliver-plan` with `{{writeToolName}}` to deliver the design. Delivery does not authorize implementation or exit plan mode.

NEVER output plain text in this turn. Do not use `xd://propose` for a design-only request or `xd://deliver-plan` for an implementation request.
</system-reminder>
