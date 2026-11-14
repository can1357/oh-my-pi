# jaq-std (vendored)

Vendored copy of [jaq-std 3.0.3](https://crates.io/crates/jaq-std/3.0.3), licensed under MIT. The workspace's `[patch.crates-io]` routes `pi-builtins` and the vendored `jaq-json` through this copy.

## Why

pi's `jq` builtin (`crates/pi-builtins/src/jq.rs`) must behave like jq 1.8.2, not like jaq. jaq-std holds the standard library, so the builtins' results and error messages are brought in line with jq's `src/builtin.jq` and `src/builtin.c` here.

## Local changes

- `src/defs.jq`: jq 1.8.2's own `builtin.jq` definitions, ported verbatim where the grammar allows, plus `have_decnum`, `have_literal_numbers` and `@base32d`/`format` as jq 1.8.2 has them.
- `src/lib.rs`: natives ported from `builtin.c` (sorting and grouping with jq's depth-limited comparison, string functions, `implode`/`explode`, the `@` formats with lenient `@base64d`, `limit`/`skip`/`nth` errors), and `ValT::type_error`, `type_error2`, `try_cmp` and `try_eq`.
- `src/regex.rs`: Oniguruma (the `onig` crate, as jq) with jq's options, capture output for non-participating groups, empty-match stepping and messages.
- `src/time.rs`: jq's date functions on top of the C library's semantics (`timegm`, `mktime`, `strftime`, `strptime`) and jq's messages.
- `src/math.rs`: jq's full set of math builtins, taking the functions jq gets from the C library from `libm`.
- `src/input.rs`: `input` raises `"break"` once the inputs run out, as jq's `f_input`.
- `Cargo.toml` and `BUILD.bazel`: workspace build wiring. The original crate's tests and the `regex-bites`, `aho-corasick`, `base64`, `urlencoding` and `log` dependencies are dropped.

Remove this fork only together with the jq-parity requirement.
