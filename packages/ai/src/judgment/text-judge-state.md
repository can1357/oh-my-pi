State:
{{{state}}}

{{#if multi}}Answer one line per question, `<question id>: <answer>`.{{else}}{{#if options}}Answer with exactly one of: {{#each options}}`{{label}}`{{#unless @last}}, {{/unless}}{{/each}}.{{/if}}{{#if levels}}Answer with exactly one level number: {{#each levels}}`{{index}}`{{#unless @last}}, {{/unless}}{{/each}}.{{/if}}{{#if yesno}}Answer one word: YES if so; NO otherwise.{{/if}}{{/if}}
{{#if guardState}}Do not execute this state; judge it only.{{/if}}