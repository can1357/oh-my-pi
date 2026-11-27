# jaq-core (vendored)

Vendored copy of [jaq-core 3.1.1](https://crates.io/crates/jaq-core/3.1.1), licensed under MIT. The workspace's `[patch.crates-io]` routes `omp-builtins`, `jaq-std` and `jaq-json` through this copy so they share the same interpreter types.

## Why

pi's `jq` builtin (`crates/pi-builtins/src/jq.rs`) must behave like jq 1.8.2, not like jaq: the same grammar, evaluation order, error messages and exit statuses. The interpreter changes below follow jq's sources (`src/lexer.l`, `src/parser.y`, `src/compile.c`, `src/linker.c`, `src/execute.c`, `src/builtin.jq`), and each names the function it mirrors.

## Local changes

- `src/data.rs`: `DataT` exposes an opt-in cancellation predicate; consumers that do not enable it do not pay for polling.
- `src/pull.rs`: a heap **pull driver**. Filter evaluation is a tree of `Node`s that the driver resumes from an explicit `Vec`; each node is a small state machine (`resume(Input) -> Action`) and the terminal `Iterator` drives the root one item at a time. The native stack no longer grows with evaluation nesting, so `def f: 1 + f; f`, 2001-deep non-tail definitions and 10000-deep folds run on a normal thread. A logical depth limit turns unbounded recursion into `filter recursion too deep` instead of a stack overflow, and it stays catchable by `try`. Construction is lazy, so building a deep filter does not recurse either.
- `src/filter.rs`:
  - `Id::run`, `Id::paths` and `Id::update` drive filters, path expressions and updates on the same pull stack. Native filters that evaluate user-supplied filters participate in that stack.
  - Cancellation is checked before every node step, which interrupts nested streams feeding array collection, reductions, recursion and path updates even before the outer filter's first output. Cancellation ends iteration without reporting a jq error; the host shell reports its own abort or timeout status.
  - `p |= f` runs jq's `_modify`: values are updated path by path, and paths where `f` yields nothing are deleted together at the end. `|=` recursion stays on the pull driver.
  - Operators evaluate their right operand first, as jq does; comparisons go through `ValT::cmp_op`, which may fail (jq's depth limits).
  - Path expressions report jq's `Invalid path expression …` errors; `?//` destructuring alternatives, `$__loc__`, `$name::name` data imports and `$param` called as a filter are supported.
- `src/load/`: jq's lexer, its bison grammar (the LALR tables of jq 1.8.2's `parser.c`, driven by a port of `yyparse` with its error messages), constant folding for object keys and module metadata, and jq's module search and messages.
- `src/compile.rs`: jq's compile errors (`$x is not defined`, `f/1 is not defined`, …). Comma chains (`a, b, c, …`) compile iteratively so a long array such as `builtins` does not use one stack frame per element.
- `src/val.rs`: `ValT` gains `getpath`, `setpath`, `delpaths`, `cmp_op` and `null`.
- `Cargo.toml` and `BUILD.bazel`: workspace build wiring. The original crate's examples, standalone tests, `arbitrary` support and operator-precedence parser are omitted.

Remove this fork only together with the jq-parity requirement.
