Globs files, directories, and path-backed internal URLs with fast pattern matching.

<instruction>
- `path`: glob, file, directory, or path-backed internal URL; separate targets with `;` (`src/**/*.ts; test/**/*.ts`).
- `memory://` glob patterns are supported. `ssh://` has no local path; use `read`. Other internal URLs accept exact paths only.
- `gitignore` defaults `true`. Set `false` for ignored files such as `.env*`, logs, or build output.
- `hidden` defaults `true`; pair it with `gitignore: false` for ignored dotfiles.
</instruction>

<output>
Matches are newest-first and grouped by directory; directories end in `/`.
</output>

{{#if eagerDelegation}}
<avoid>
Open-ended multi-round discovery → {{#if scoutAvailable}}Task + scout.{{else}}Task.{{/if}}
</avoid>
{{/if}}
