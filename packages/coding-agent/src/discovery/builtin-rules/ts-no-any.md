---
description: "Never use `any` in TypeScript annotations or assertions — use `unknown`, generics, a schema parse at trust boundaries, or the actual type"
condition: ": any|as any"
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
interruptMode: never
---

Never use `: any` or `as any`. They disable type checking exactly where the boundary needs precision.

## Use instead

- `unknown` for unvalidated input.
- A schema parse (Zod, Valibot, …; e.g. Zod v4 when it is already in the project) for untrusted or external input — validate once, then consume a typed value.
- A domain type when the shape is known.
- A generic when the caller supplies the shape.
- A type guard when runtime checks establish shape.
- `satisfies` for object literals that must match a contract.

## Parameters and returns

```typescript
// Bad
function readId(value: any): any {
	return value.id;
}

// Good — validate unknown input.
function readId(value: unknown): string | undefined {
	if (value && typeof value === "object" && "id" in value) {
		const candidate = value.id; // `in` narrowing types this as unknown — no cast needed
		return typeof candidate === "string" ? candidate : undefined;
	}
}
```

## Assertions

```typescript
// Bad
const root = document.getElementById("root") as any;
root.innerText = "ready";

// Good
const root = document.getElementById("root") as HTMLElement | null;
root?.innerText = "ready";
```

## Object literals

```typescript
// Bad
const config = { port: 3000 } as any as ServerConfig;

// Good
const config = { port: 3000 } satisfies ServerConfig;
```

## Choosing: guard vs schema vs unchecked cast

|Situation|Reach for|
|---|---|
|Data from outside your control — network/RPC, parsed JSON, config files, env vars, CLI/IPC, persisted blobs — or a shape reused across the codebase|**Schema parse** (Zod/Valibot/…): runtime validation, typed output, and a clear error on bad shape|
|In-process value the compiler merely lost track of — an `unknown` from a generic, a union to discriminate, a one-off read of a field or two|**Type guard** (`in` / `typeof`): no dependency, but it only checks what you write, so keep the checked surface small|
|You genuinely know more than the compiler *and* a runtime check is impossible or meaningless — a well-known DOM node (`as HTMLElement`), structurally-identical types inference can't unify, a library type that is wrong or unexpressible, `as const`|**Unchecked cast** (`as` / `as unknown as T`): assign to a named const with a one-line reason; never for raw external input|

If a library boundary truly requires an unchecked cast, use `as unknown as T` with a short reason. Never leave a bare `any`.
