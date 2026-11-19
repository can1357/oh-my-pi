<system-notice>
{{#if multiple}}Late LSP diagnostics arrived for {{files.length}} files after their edits returned:
{{else}}Late LSP diagnostics arrived after the edit returned:
{{/if}}
{{#each files}}{{this.path}} — {{this.summary}}
{{#each this.messages}}{{this}}
{{/each}}{{#unless @last}}
{{/unless}}{{/each}}</system-notice>
