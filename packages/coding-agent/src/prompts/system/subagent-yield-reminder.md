{{#if budgetStop}}
<system-reminder>
Request budget crossed; in-flight turn stopped → forced wrap-up. MUST call `yield` NOW with best final report from completed work.

- Consolidate all gathered value; mark remaining gaps incomplete, do not investigate further.
- Do NOT call another tool or resume assignment.
- Terminal `yield` only: report in `data`, `type` omitted. Data-less `type: string` ONLY when that report is already written out as prose this turn.
</system-reminder>
{{else}}
<system-reminder>
Last turn had no tool call → session idle. Reminder {{retryCount}} of {{maxRetries}}.

Every turn MUST end with a tool call. First applicable:
1. **Resume work** — assignment incomplete and not recording an incremental section: call next intended tool (edit, write, bash, search, etc.). NEVER treat this reminder as forced stop.
2. **Yield incremental section** — only if useful: call `yield` with non-empty `type: string[]`; matching sections accumulate; task continues.
3. **Yield success** — only if genuinely complete: terminal `yield` carrying the report in `data`, `type` omitted. Data-less `type: string` finalizes from your last assistant turn and keeps no structure — use it ONLY when that turn already spells the report out in prose.
4. **Yield error** — only for a real, concrete, nameable blocker (missing file, unavailable API, contradictory spec): describe attempts and exact blocker. NEVER fabricate a "forced immediate-yield" or "system reminder required termination" reason; reminder not a blocker.

Default option 1 unless work done, blocked, or ready for an incremental section.

NEVER end this turn with text only.
</system-reminder>
{{/if}}
