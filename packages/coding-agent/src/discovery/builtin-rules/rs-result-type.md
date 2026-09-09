---
description: Result type aliases must include a defaulted error type parameter
condition: "type\\s+Result<[A-Za-z_]\\w*>\\s*="
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: never
---

`Result` aliases must expose the error type as a defaulted parameter.

```rust
pub type Result<T, E = anyhow::Error> = std::result::Result<T, E>;
```

Never write:

```rust
type Result<T> = std::result::Result<T, anyhow::Error>;
```

The default keeps common call sites short while preserving escape hatches for precise errors.
