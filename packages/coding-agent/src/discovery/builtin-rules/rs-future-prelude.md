---
description: Use Future not std::future::Future - it's in the prelude
condition: "std::future::Future"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: never
---

Type positions: use `Future`, not `std::future::Future`.

Rust 2024 standard prelude: `Future`.
Pre-2024: add once at top: `use std::future::Future;`.
Repeated fully qualified paths: harder-to-read signatures, no added safety.

## Examples

```rust
// Bad — fully qualified in every signature.
fn fetch() -> impl std::future::Future<Output = Result<Data>> { ... }
fn poll(fut: Pin<&mut dyn std::future::Future<Output = i32>>) { ... }

// Good — use the prelude or one import.
fn fetch() -> impl Future<Output = Result<Data>> { ... }
fn poll(fut: Pin<&mut dyn Future<Output = i32>>) { ... }
```
