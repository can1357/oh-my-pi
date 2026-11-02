# brush-parser (vendored)

Vendored copy of [brush-parser](https://github.com/reubeno/brush) 0.4.0, the
tokenizer and parsers behind the embedded shell (`crates/vendor/brush-core`).
The workspace `Cargo.toml` routes the registry dependency here through
`[patch.crates-io]`. MIT licensed; see `LICENSE`.

## Local changes

- `src/word.rs`, `src/tokenizer.rs`: the word grammar delimits `$(...)` with
  the tokenizer's here-document-aware scan (`command_substitution_body_len`)
  instead of re-parsing the body as words. Re-parsing let quotes and
  parentheses inside a quoted here-document body end the substitution early
  or swallow its closer; `"$(...)"` then fell back to literal text and ran
  backtick spans from the body (oh-my-pi#13307). Upstream tracks this family
  as [reubeno/brush#1066](https://github.com/reubeno/brush/issues/1066).
- `src/tokenizer.rs`: a newline token cut short by a construct's terminating
  char (`)` in `$(...)`) is delimited as a newline, not as the terminator, so
  a here-document body starting with `)` no longer closes the substitution.
- `src/parser/peg.rs`, `src/tokenizer.rs`, `src/arithmetic.rs`: text between
  arithmetic `((` and `))` delimiters is read as arithmetic, without comments
  or extended globs. An arithmetic `for` header is split into its three
  expressions at every `;`, including each `;` of the `;;`, `;;&` and `;&`
  operators the tokenizer forms, so `for ((;;))` parses; an arithmetic command
  keeps its semicolons as arithmetic text; the tokenizer leaves arithmetic
  while it scans a nested command substitution and after the parenthesis that
  closes the bare `((`; an expression of only spaces, tabs and newlines is 0.
  The upstream `;;` fix is
  [reubeno/brush#1418](https://github.com/reubeno/brush/pull/1418).
- `Cargo.toml`: `publish = false`; the `miette`/`serde` examples, the
  `criterion` bench, and the dev-dependencies only they used (`criterion`,
  `miette`, `serde_yaml`, insta's `glob`/`yaml` features) are dropped.
- `src/snapshot_tests.rs`: dropped; it globbed test cases from the sibling
  `brush-shell` crate, which is not vendored.
- The crates.io `Cargo.lock` and VCS metadata are dropped; `BUILD.bazel` and
  `rustfmt.toml` are workspace wiring.

Everything else is byte-identical to the 0.4.0 release.

Remove this directory and its `[patch.crates-io]` entry once a brush-parser
release delimits command substitutions containing here-documents correctly
and reads `((` ... `))` text as Bash does.
