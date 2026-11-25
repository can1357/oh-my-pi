# mdlite

Renders a small Markdown subset to HTML.

```sh
bun src/cli.ts notes.md > notes.html
```

Inline syntax is documented in [docs/syntax.md](docs/syntax.md). Each inline construct is a rule in
`src/rules/`, applied in the order `src/rules/index.ts` lists them.

Before pushing, run `bun run ci`.
