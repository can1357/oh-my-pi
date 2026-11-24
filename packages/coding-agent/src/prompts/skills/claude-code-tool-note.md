{{#if body}}{{body}}

{{/if}}This skill was written for Claude Code. In omp: {{#each tools}}{{claude}} → {{omp}}{{#unless @last}}, {{/unless}}{{/each}}.
