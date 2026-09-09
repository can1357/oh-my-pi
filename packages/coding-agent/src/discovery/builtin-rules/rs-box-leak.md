---
description: Never use Box::leak - it intentionally leaks memory
condition: "Box::leak"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: never
---

Never use `Box::leak` to satisfy a lifetime. It intentionally leaks the allocation for the rest of the process.

## Why

- The allocation is never freed.
- It hides ownership bugs.
- It turns lifetime errors into process lifetime growth.
- It makes tests pass while production memory grows.

## Use instead

|Need|Use|
|---|---|
|Shared async/thread data|`Arc<T>` or owned values|
|Global lazy state|`LazyLock<T>` or `OnceLock<T>`|
|Text escaping a scope|`String` / `Arc<str>`|
|`'static` callback|`move` closure with owned captures|
|FFI pointer|Explicit owner that frees on drop|

## Examples

```rust
// Bad — leaking to manufacture 'static.
fn label(id: u64) -> &'static str {
    Box::leak(Box::new(format!("item_{id}")))
}

// Good — return owned data.
fn label(id: u64) -> String {
    format!("item_{id}")
}

// Bad — leaking before spawn.
let state = Box::leak(Box::new(state));
tokio::spawn(async move { use_state(state) });

// Good — share owned state.
let state = Arc::new(state);
tokio::spawn(async move { use_state(&state) });
```

If `Box::leak` looks necessary, fix ownership instead.
