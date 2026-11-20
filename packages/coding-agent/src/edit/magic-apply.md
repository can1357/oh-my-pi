File `{{path}}`. Each line is shown as its number, a tab, then its text; the number and the tab are not part of the file.

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

Reply again with the complete corrected set of blocks.
{{/if}}
