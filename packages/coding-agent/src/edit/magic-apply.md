File `{{path}}`. Each line starts with its line number and a tab (neither is part of the file). A line that opens a block shows its span instead of a single number: `20-49` means line 20 opens a block ending at line 49, and every line from 20 to 49 is still shown below.
{{#if partial}}
`⋮` marks omitted lines. Apply the change if every line it modifies is shown; reply `CANNOT: <what is missing>` only when a line you must edit is inside a `⋮` gap.
{{/if}}

<file>
{{file}}
</file>

Change to make:

{{change}}
{{#if previous}}

Your previous reply was rejected and nothing was applied.

<reply>
{{previous}}
</reply>

<rejection>
{{rejection}}
</rejection>

Reply again with all the corrected operations.
{{/if}}
