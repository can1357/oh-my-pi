Regex: Rust, then PCRE2. `path`: `;`-separated file/dir/glob/URL; default `.`. Default case-sensitive, gitignore respected; `skip` paginates files.
File-only selector: `src/foo.ts:50-100`. Literal `\n`/`\\n` enables cross-line.
Bare glob `*.ts` matches any depth; `dir/*.ts` only `dir`'s direct children (`dir/**/*.ts` recurses).
{{#if hasFind}}Behavior/unknown symbol → `find`; literals/regex → `grep`.{{/if}}
{{#if eagerDelegation}}Multi-round search MUST use {{#if scoutAvailable}}Task + scout{{else}}Task{{/if}}, not chained calls.{{/if}}
