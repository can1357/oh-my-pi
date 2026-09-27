# tree-sitter-go (vendored)

Vendored copy of [tree-sitter-go](https://github.com/tree-sitter/tree-sitter-go)
0.25.0, the crates.io release built from upstream commit
`1547678a9da59885853f5f5cc8a99cc203fa2e2c`. The workspace `Cargo.toml` routes
the registry dependency here through `[patch.crates-io]`. MIT licensed; see
`LICENSE`.

## Local changes

- `grammar.js`: the `grammar.js` hunk of upstream PR
  [#193](https://github.com/tree-sitter/tree-sitter-go/pull/193), applied
  verbatim. `new`/`make` accept an expression as the first argument (Go 1.26
  `new(expr)`, e.g. `new(f(x))`), still preferring the type reading for
  `new(T)`, and accept type arguments when shadowed by a generic function.
- `src/grammar.json`, `src/parser.c`: regenerated from that `grammar.js`.
- `Cargo.toml`: `publish = false`. The crates.io `Cargo.lock` and VCS metadata
  are dropped; `BUILD.bazel` and `rustfmt.toml` are workspace wiring.

Everything else is byte-identical to the 0.25.0 release.

## Regenerating

tree-sitter-cli 0.25.8 generated the published 0.25.0 parser and reproduces its
`src/` byte-for-byte from the unpatched `grammar.js`. From this directory:

```sh
bunx tree-sitter-cli@0.25.8 generate --js-runtime bun
```

(`--js-runtime bun`: the repository's root `package.json` sets
`"type": "module"`, so `node` refuses to load the CommonJS `grammar.js`.)

Remove this directory and its `[patch.crates-io]` entry once a tree-sitter-go
release parses `new(expr)`.
