## Existing Plan

Approved plan inlined below; durable copy at `{{planFilePath}}` (identical content).

<plan path="{{planFilePath}}">
{{planContent}}
</plan>

<instruction>
Relevant to current work and incomplete → MUST continue executing.
Stale or unrelated → MUST ignore.
NEVER re-read `{{planFilePath}}` while the inline plan is intact.
Inline content compressed, expired, or unrecoverable → NEVER stop; read `{{planFilePath}}`.
</instruction>
