---
description: Use parking_lot instead of std::sync for Mutex/RwLock
condition:
  - "\\.lock\\(\\)\\.unwrap\\(\\)"
  - "\\.read\\(\\)\\.unwrap\\(\\)"
  - "\\.write\\(\\)\\.unwrap\\(\\)"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: never
---

Use `parking_lot::{Mutex, RwLock}` instead of `std::sync::{Mutex, RwLock}` when code immediately unwraps lock results.

## Why

- `lock()`, `read()`, and `write()` return guards directly.
- No poisoning error path to unwrap.
- Guards are smaller and faster in common contention cases.
- The call site shows locking, not error handling boilerplate.

## Migration

```rust
// Before
use std::sync::Mutex;
let data = Mutex::new(Vec::new());
let guard = data.lock().unwrap();

// After
use parking_lot::Mutex;
let data = Mutex::new(Vec::new());
let guard = data.lock();
```

## Equivalents

|std::sync|parking_lot|
|---|---|
|`Mutex<T>`|`Mutex<T>`|
|`RwLock<T>`|`RwLock<T>`|
|`Condvar`|`Condvar`|
|`Once`|`Once`|

## Keep async locks async

Use `tokio::sync::Mutex` / `tokio::sync::RwLock` when a guard is held across `.await` or the lock belongs to async coordination.
