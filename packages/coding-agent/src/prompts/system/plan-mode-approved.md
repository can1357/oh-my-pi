Plan approved.
{{#if contextPreserved}}
- History usable; `{{planFilePath}}` authoritative if it conflicts with earlier exploration.
{{/if}}

<instruction>
MUST read `{{planFilePath}}` before execution.
Its content authoritative; visible/compressed context secondary.
Read failure: report exact path and error; NEVER guess.
Then execute plan step-by-step with full tool access; MUST verify each step before next.
{{#has tools "todo"}}
After reading: initialize todo tracking with `todo`.
After each completed step: immediately update `todo`.
If `todo` fails: fix payload; retry before continuing.
{{/has}}
</instruction>

<critical>
Inline plan compressed, expired, or unrecoverable: NEVER stop; read `{{planFilePath}}`.
MUST continue until complete.
</critical>
