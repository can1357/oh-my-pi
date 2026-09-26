# brush-parser (vendored)

Vendored copy of [brush-parser](https://github.com/reubeno/brush) 0.4.0, the
tokenizer and parsers behind the embedded shell (`crates/vendor/brush-core`).
The workspace `Cargo.toml` routes the registry dependency here through
`[patch.crates-io]`. MIT licensed; see `LICENSE`.

## Local changes

- `Cargo.toml`: `publish = false`; the `miette`/`serde` examples, the
  `criterion` bench, and the dev-dependencies only they used (`criterion`,
  `miette`, `serde_yaml`, insta's `glob`/`yaml` features) are dropped.
- `src/snapshot_tests.rs`: dropped; it globbed test cases from the sibling
  `brush-shell` crate, which is not vendored.
- The crates.io `Cargo.lock` and VCS metadata are dropped; `BUILD.bazel` and
  `rustfmt.toml` are workspace wiring.

Everything else is byte-identical to the 0.4.0 release.
