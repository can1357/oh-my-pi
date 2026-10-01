---
description: "Don't assert an inline object type and immediately read a property — `(x as { y: T }).y` trusts an unchecked shape; validate with a schema parse at trust boundaries, narrow with `in`/`typeof`, or use a validated named type"
scope: "tool:edit(*.{ts,tsx,mts,cts}), tool:write(*.{ts,tsx,mts,cts})"
interruptMode: never
astCondition:
  - "($X as { $$$BODY }).$PROP"
  - "($X as { $$$BODY })?.$PROP"
  - "($X as { $$$BODY })[$IDX]"
---

## Don't inline-cast an object type for member access

`(value as { content: unknown }).content` fabricates an unchecked shape, then trusts it for the access. If `value` lacks that shape, the read is silently wrong; no type error fires.

## Why

- Unchecked assertion: suppresses the error; proves no shape.
- Localizes the lie; readers cannot tell whether `value` was validated.
- Usually replace with runtime narrowing or a validated boundary type.

## Avoid

```ts
const content = (value as { content: unknown }).content;
const id = (resp as { data: { id: string } }).data.id;
const name = (payload as { name?: string })?.name;
const flag = (opts as { enabled: boolean })["enabled"];
```

## Use

At a boundary, prefer a schema parse when a validator exists: validate once, then read a fully typed value.

```ts
import { type } from "@oh-my-pi/omptype";

const Resp = type({ data: { id: "string" } });

const resp = Resp.assert(raw); // throws on bad input; resp.data.id is typed string
const id = resp.data.id;
```

For a one-off field read, narrow with `in` / `typeof`; access is checked. After `"content" in value`, TypeScript infers the property as `unknown`:

```ts
if (value && typeof value === "object" && "content" in value) {
	const content = value.content; // unknown — validate before use
}
```

## Choose: guard vs schema vs unchecked cast

- Outside-controlled data—network/RPC, parsed JSON, config files, env vars, CLI/IPC, persisted blobs—or codebase-reused shapes: **Schema parse** (Zod/Valibot/…): runtime validation, typed output, clear bad-shape error.
- In-process values the compiler lost—generic `unknown`, union discrimination, one-off reads of one or two fields: **Type guard** (`in` / `typeof`): no dependency; checks only what you write, so keep its surface small.
- You know more than the compiler **and** runtime checking is impossible or meaningless—well-known DOM node (`as HTMLElement`), structurally-identical types inference cannot unify, wrong or unexpressible library type, `as const`: **Unchecked cast** (`as`): assign to a named const with a one-line reason; never raw external input or inline member access.
