Glob files/dirs: `;`-separated paths or internal URLs (`local://*.md`, `omp://**/*.md`); default workspace root.
`gitignore` and `hidden` default true; ignored dotfiles need `gitignore: false`. Newest-first by directory; dirs end `/`.
{{#ifAny eagerDelegation hasFind}}
{{#if hasFind}}Behavior search → `find`.{{/if}}
{{#if eagerDelegation}}Multi-round discovery → {{#if scoutAvailable}}Task + scout{{else}}Task{{/if}}.{{/if}}
{{/ifAny}}
