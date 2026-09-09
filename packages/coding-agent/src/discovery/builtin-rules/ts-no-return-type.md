---
description: "Do not use `ReturnType<typeof fn>` — name the type explicitly"
condition: "ReturnType<"
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
interruptMode: never
---

Do not publish contracts through `ReturnType<typeof fn>`. Name the type at the module that owns the value and import that name at consumers.

## Why

- Named types document the contract directly.
- Consumers stop coupling to implementation helpers.
- JSDoc and changelog notes attach to the exported type.
- Type errors point at the intended API boundary.

## Avoid

```typescript
// Bad — opaque and coupled to implementation names.
type Config = Awaited<ReturnType<typeof loadConfig>>;
type Message = ReturnType<typeof buildMessage>["message"];
let service: ReturnType<typeof createService> | undefined;
```

## Use

```typescript
// In the module that owns the function:
export interface LoadedConfig {
	path: string;
	values: Record<string, unknown>;
}

export function loadConfig(path: string): Promise<LoadedConfig> { ... }

// At the consumer:
import type { LoadedConfig } from "./config";
```

## Exceptions

- Generic type utilities where the function is a type parameter.

Concrete function? Export a concrete type.
