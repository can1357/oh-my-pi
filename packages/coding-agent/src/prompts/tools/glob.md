Glob files/dirs: `;`-separated paths or internal URLs (`local://*.md`, `omp://**/*.md`); default workspace root.
`gitignore` and `hidden` default true; ignored dotfiles need `gitignore: false`. Newest-first by directory; dirs end `/`.
`depth: N` stops N levels below each root (1 = direct children), like `find -maxdepth N`: `{"path":"proofs/**/dune","depth":3}`. Large or slow tree? Set `depth`.
{{#ifAny eagerDelegation hasFind}}
{{#if hasFind}}Behavior search → `find`.{{/if}}
{{#if eagerDelegation}}Multi-round discovery → {{#if scoutAvailable}}Task + scout{{else}}Task{{/if}}.{{/if}}
{{/ifAny}}
