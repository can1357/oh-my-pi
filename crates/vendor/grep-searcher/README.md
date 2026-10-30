# grep-searcher (vendored)

Vendored copy of [grep-searcher](https://github.com/BurntSushi/ripgrep/tree/master/crates/searcher)
0.1.17, the crates.io release behind ripgrep's line-oriented search. The
workspace `Cargo.toml` routes the registry dependency here through
`[patch.crates-io]`. Dual-licensed under MIT (`LICENSE-MIT`) or the Unlicense
(`UNLICENSE`).

## Why

The async shell utilities (`rg`, `grep`) search input that arrives in pieces
from readiness-driven descriptors and must not park a thread on a blocking
`io::Read`. Upstream offers `Searcher::search_reader` (blocks inside `read`)
and `Searcher::search_slice` (needs the whole input in memory), nothing that
can be fed bytes as they come.

## Local changes

- `src/searcher/push.rs`: `Searcher::search_push` and `PushSearch`, a search
  fed in chunks (`push`, then `finish`). It runs `ReadByLine` as a resumable
  state machine over the same `Core` and `LineBuffer`, so a search over chunks
  makes the sink calls `search_reader` makes over a reader that returns those
  chunks (one chunk is one `read`; without binary detection the calls do not
  depend on the chunking at all), for every setting: BOM sniffing and explicit
  encodings, binary quit/convert, context, line numbers, byte offsets,
  passthru, invert, sink stop. Multi-line searches gather the decoded input
  and run the multi-line slice search at `finish`. `PushSearch` is `Send` (it
  holds the searcher's exclusive borrow), so it can live across `.await`s in
  spawned tasks. Its tests compare chunked pushes with `search_reader` through
  a recording sink.
- `src/line_buffer.rs`: `push_fill`/`push_eof` (the body of `LineBuffer::fill`
  split so that "no more bytes yet" is not EOF) and wider visibility
  (`pub(crate)`) for the `LineBuffer` methods the push search drives.
- `src/searcher/mod.rs`, `src/lib.rs`: the `push` module and the `PushSearch`
  re-export.
- `Cargo.toml`: `publish = false`. The crates.io `Cargo.toml.orig`, `Cargo.lock`
  and VCS metadata are dropped; `BUILD.bazel` and `rustfmt.toml` are workspace
  wiring.

Everything else is byte-identical to the 0.1.17 release.

Remove this directory and its `[patch.crates-io]` entry once grep-searcher
ships an equivalent chunk-fed search API.
