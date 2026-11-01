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
- `src/word.rs`: a backquoted command's body loses the backslash before `$`,
  `` ` `` and `\`, every backslash-newline, and, when the backquotes are in
  double quotes, the backslash before `"`, as in Bash; a body left ending in a
  lone backslash gets it escaped so it stays literal. 0.4.0 removed only the
  backslash before a backquote, so `\\` and `\$` reached the body unchanged
  and backquotes nested three or more levels deep ran the wrong commands.
  Upstream made the `$`, `` ` ``, `\` and trailing-backslash part of this
  change in [reubeno/brush#1421](https://github.com/reubeno/brush/pull/1421),
  after 0.4.0, and removes line continuations in its tokenizer instead.
  `word::parse_double_quoted_parameter_word` is new: brush-core expands the
  word of a `${...}` inside double quotes by parsing it wrapped in `"`, or
  without its quotes when the whole word is one double-quoted string. In that
  word Bash keeps `\"` in backquoted commands, drops the backslash before any
  character but `$`, `` ` ``, `"`, `\` and newline in a backquoted command
  inside the word's own double quotes, and takes no leading `~` as a tilde
  expansion.
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
and unescapes backquoted bodies as described above.
