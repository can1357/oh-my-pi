# jaq-core (vendored)

Vendored copy of [jaq-core 3.1.1](https://crates.io/crates/jaq-core/3.1.1), licensed under MIT. The workspace's `[patch.crates-io]` routes `pi-builtins`, `jaq-std`, `jaq-json`, and `jaq-fmts` through this copy so they share the same interpreter types.

## Local changes

- `src/data.rs`: `DataT` exposes an opt-in cancellation predicate; existing consumers do not pay for polling.
- `src/filter.rs`: `Id::run`, `Id::paths`, and `Id::update` poll before each yielded value. This interrupts nested streams feeding array collection, reductions, recursion, and path updates even when the outer filter has not produced its first output. Cancellation ends iteration without reporting a jq error; the host shell reports its own abort or timeout status.
- `Cargo.toml` and `BUILD.bazel`: workspace build wiring. The original crate's examples and standalone tests are omitted; its interpreter source is unchanged beyond the cancellation hook.

Remove this fork when upstream exposes an equivalent per-invocation cancellation hook.
