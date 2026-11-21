File `{{path}}`. Each line is shown as its number, a tab, then its text; the number and the tab are not part of the file. A line that opens a block shows the block's first and last line instead of its number: `20-49` opens a block that ends on line 49.
{{#if partial}}
`⋮` marks omitted lines. If the change needs omitted lines, reply `CANNOT: <what is missing>`.
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
