Glob files/dirs: `;`-separated paths or internal URLs (`local://*.md`, `omp://**/*.md`); default workspace root.
`gitignore` and `hidden` default true; `gitignore: false` also lists ignored files and `node_modules`. `git: true` lists inside `.git`. Newest-first by directory; dirs end `/`.
`depth: N` stops N levels below each root (1 = direct children), like `find -maxdepth N`: `{"path":"proofs/**/dune","depth":3}`. Large or slow tree? Set `depth`.
More than `limit` matches? Page with `skip` (the result names the next `skip`).
{{#ifAny eagerDelegation hasFind}}
{{#if hasFind}}Behavior search → `find`.{{/if}}
{{#if eagerDelegation}}Multi-round discovery → {{#if scoutAvailable}}Task + scout{{else}}Task{{/if}}.{{/if}}
{{/ifAny}}
