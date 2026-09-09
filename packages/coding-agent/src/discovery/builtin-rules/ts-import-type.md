---
description: "Use `import type`, not `import('pkg').Type` in type positions"
condition: "import\\("
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
interruptMode: never
---

Use top-level `import type` declarations for type-only dependencies. NEVER write `import("pkg").Type` inside source annotations.

## Why

- Top-level imports expose dependencies immediately.
- Import sorting and deduplication can manage them.
- Signatures stay readable and reviewable.
- Re-exports do not inherit noisy inline paths.

## Avoid

```typescript
// Bad — inline imports hide dependencies in signatures.
function run(client: import("some-sdk").Client, input: import("arktype").infer<Schema>): Promise<Output>;

// Bad — annotations become path dumps.
const options: import("some-sdk/config").ClientOptions = { ... };
```

## Use

```typescript
import type { Client } from "some-sdk";
import type { ClientOptions } from "some-sdk/config";
import type { infer as Infer } from "arktype";

function run(client: Client, input: Infer<Schema>): Promise<Output>;
const options: ClientOptions = { ... };
```

## Exceptions

- Ambient `.d.ts` globals that must not become modules.
- Generated files whose generator owns import management.

In normal `.ts` / `.tsx` source, use `import type`.
