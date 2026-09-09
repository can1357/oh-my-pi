---
description: Prefer std::sync::LazyLock over OnceLock and once_cell
condition:
  - "once_cell::"
  - "OnceLock::new"
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: never
---

Prefer `std::sync::LazyLock` over `OnceLock` and the `once_cell` crate when the initializer is known at declaration time.

`LazyLock` stores the cell and initializer together. There is no separate `init()` function, no repeated `get_or_init`, and no missing initialization path.

## once_cell → std

```rust
// Before
use once_cell::sync::Lazy;
static CONFIG: Lazy<String> = Lazy::new(|| "value".to_string());

// After
use std::sync::LazyLock;
static CONFIG: LazyLock<String> = LazyLock::new(|| "value".to_string());
```

## OnceLock → LazyLock

```rust
// Before — fixed initializer hidden in accessor.
use std::sync::OnceLock;
static SETTINGS: OnceLock<Settings> = OnceLock::new();
fn settings() -> &'static Settings {
    SETTINGS.get_or_init(Settings::load)
}

// After — initializer lives with the static.
use std::sync::LazyLock;
static SETTINGS: LazyLock<Settings> = LazyLock::new(Settings::load);
```

## Keep OnceLock when runtime input is required

```rust
use std::sync::OnceLock;
static DATABASE: OnceLock<Database> = OnceLock::new();

fn init_database(url: &str) {
    let _ = DATABASE.set(Database::connect(url));
}
```

Do not add `once_cell` for new code. Use the standard library equivalent.
