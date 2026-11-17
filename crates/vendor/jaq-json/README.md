# jaq-json (vendored)

Vendored copy of [jaq-json 2.0.3](https://crates.io/crates/jaq-json/2.0.3), licensed under MIT. The workspace's `[patch.crates-io]` routes `pi-builtins` through this copy.

## Why

pi's `jq` builtin (`crates/pi-builtins/src/jq.rs`) must behave like jq 1.8.2, not like jaq: the same output bytes, error messages and exit statuses. jaq-json defines the value type, number semantics, JSON reading and writing, so most of that parity lives here. Each change names the jq 1.8.2 function it mirrors. pi's `jq` also runs inside the host process, where a stack overflow kills it, so recursion over nested values is bounded as jq bounds it.

## Local changes

- `src/num.rs`: jq's number model. Literals (from programs, input and `tonumber`) keep their exact decimal value and print in decNumber's canonical form (`1E+3`, `1.000`, `-0`); arithmetic is IEEE double arithmetic; computed doubles print like `jvp_dtoa_fmt` (`1e+17`, NaN as `null`, infinities clamped). Literals compare exactly against literals, everything else as doubles, NaN below every number.
- `src/lib.rs`: jq's operators (`+ - * / %`, string repeat and split, deep merge), indexing, slicing, iteration and update (float and NaN indices, null autovivification, negative indices), `getpath`/`setpath`/`delpaths` (also behind jaq-core's `ValT`, for `|=`), objects that reject non-string keys, depth-limited equality and ordering, and every one of their error messages.
- `src/msg.rs`: jq's descriptions of values in error messages (`jv_kind_name`, `jv_dump_string_trunc`, `type_error`, `type_error2`).
- `src/read.rs`, `src/read/`: a port of jq's incremental parser (`jv_parse.c`) with its error messages and positions, `--seq`, `--stream`, `--stream-errors`, number literals as jq's decimal library reads them, and UTF-8 repair. Parsing fails past `MAX_DEPTH` (10000, jq's `MAX_PARSING_DEPTH`) nested arrays and objects. Replaces the hifijson-based reader.
- `src/write.rs`: jq's string escaping (`jvp_dump_string`), including invalid UTF-8 repair and `--ascii-output`. A value nested deeper than `MAX_DEPTH` (10000, jq's `MAX_PRINT_DEPTH`) prints as `TOO_DEEP` (`<skipped: too deep>`), which bounds the recursion of `Display`, `tojson` and `write`.
- `src/funs.rs`: `fromjson`, `tojson` and `tostring` as jq's natives.
- `Cargo.toml` and `BUILD.bazel`: workspace build wiring. The original crate's tests and its `serde` feature are omitted.

Remove this fork only together with the jq-parity requirement.
