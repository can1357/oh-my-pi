---
description: "Do not leave `@deprecated` shims behind after refactors — update call sites and remove the old API"
condition: "@deprecated"
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
interruptMode: never
---

Never use `@deprecated` instead of completing a refactor. Obsolete APIs in code you control: update every call site; remove the old name in the same change.

## Why

- Deprecated aliases: two live contracts.
- Future maintainers preserve behavior nobody should call.
- Tests pass while production uses the old path.
- Next refactor unwinds real API and compatibility layer.

## Avoid

```typescript
// Bad — leaves a stale compatibility name instead of finishing the cutover.
/** @deprecated Use loadSettings instead. */
export const loadConfig = loadSettings;

// Bad — preserves an obsolete wrapper after callers can be updated.
/** @deprecated Use createClient instead. */
export function makeClient(options: ClientOptions): Client {
	return createClient(options);
}
```

## Use

```typescript
// Update all imports and call sites to the durable name.
export function loadSettings(path: string): Settings { ... }
export function createClient(options: ClientOptions): Client { ... }
```

## Exceptions

- Public package APIs with a documented migration window.
- Third-party declarations whose deprecated marker reflects an external contract.
- Tests intentionally verifying deprecated API behavior during a supported transition.

If an exception applies, state the external compatibility requirement. Otherwise complete the refactor; delete the deprecated symbol.
