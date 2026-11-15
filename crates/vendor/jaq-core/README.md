# jaq-core (vendored)

Vendored copy of [jaq-core 3.1.1](https://crates.io/crates/jaq-core/3.1.1), licensed under MIT. The workspace's `[patch.crates-io]` routes `pi-builtins`, `jaq-std` and `jaq-json` through this copy so they share the same interpreter types.

## Why

pi's `jq` builtin (`crates/pi-builtins/src/jq.rs`) must behave like jq 1.8.2, not like jaq: the same grammar, evaluation order, error messages and exit statuses. The interpreter changes below follow jq's sources (`src/lexer.l`, `src/parser.y`, `src/compile.c`, `src/linker.c`, `src/execute.c`, `src/builtin.jq`), and each names the function it mirrors.

## Local changes

- `src/data.rs`: `DataT` exposes an opt-in cancellation predicate; existing consumers do not pay for polling. It also exposes `may_recurse`, which a host overrides to bound evaluation depth (the default always allows).
- `src/filter.rs`:
  - `Id::run`, `Id::paths`, and `Id::update` fail with `filter recursion too deep` when `may_recurse` refuses, so unbounded recursion (`def f: 1 + f; f`) errors instead of overflowing the host's stack. They also poll before each yielded value, which interrupts nested streams feeding array collection, reductions, recursion, and path updates even when the outer filter has not produced its first output. Cancellation ends iteration without reporting a jq error; the host shell reports its own abort or timeout status. The polling wrapper keeps its stream's size bound, so single-output updates still move values instead of copying them.
  - `p |= f` runs jq's `_modify`: values are updated path by path, and paths where `f` yields nothing are deleted together at the end.
  - Operators evaluate their right operand first, as jq does; comparisons go through `ValT::cmp_op`, which may fail (jq's depth limits).
  - Path expressions report jq's `Invalid path expression …` errors; `?//` destructuring alternatives, `$__loc__`, `$name::name` data imports and `$param` called as a filter are supported.
- `src/load/`: jq's lexer, its bison grammar (the LALR tables of jq 1.8.2's `parser.c`, driven by a port of `yyparse` with its error messages), constant folding for object keys and module metadata, and jq's module search and messages.
- `src/compile.rs`: jq's compile errors (`$x is not defined`, `f/1 is not defined`, …).
- `src/val.rs`: `ValT` gains `getpath`, `setpath`, `delpaths`, `cmp_op` and `null`.
- `Cargo.toml` and `BUILD.bazel`: workspace build wiring. The original crate's examples, standalone tests, `arbitrary` support and operator-precedence parser are omitted.

Remove this fork only together with the jq-parity requirement.
