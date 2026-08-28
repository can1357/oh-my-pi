Prepare to execute approved plan.

MUST distill plan-mode discussion.
Preserve:
- Plan rationale; explicitly rejected alternatives.
- Key decisions; driving constraints.
- Discovered files, symbols, code paths executor needs.
- User preferences expressed during planning.

Drop:
- Tool-call noise (file reads, searches) if result captured in plan or plan-mode discussion.
- Superseded plan drafts.
- Context restated in plan file.

{{#if planFilePath}}
Approved plan file: `{{planFilePath}}`; authoritative source of truth. MUST preserve this durable path; executor MUST read it directly after compaction.
{{/if}}
