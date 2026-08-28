---
description: Do not guard clearTimeout/clearInterval/clearImmediate with a truthiness or null/undefined check — they accept null and undefined
scope: "tool:edit(*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}), tool:write(*.{ts,tsx,js,jsx,mts,cts,mjs,cjs})"
interruptMode: never
astCondition:
  - "if ($X) clearTimeout($X)"
  - "if ($X) { clearTimeout($X) }"
  - "if ($X) clearInterval($X)"
  - "if ($X) { clearInterval($X) }"
  - "if ($X) clearImmediate($X)"
  - "if ($X) { clearImmediate($X) }"
  - "if ($X !== null) clearTimeout($X)"
  - "if ($X !== null) { clearTimeout($X) }"
  - "if ($X !== null) clearInterval($X)"
  - "if ($X !== null) { clearInterval($X) }"
  - "if ($X !== null) clearImmediate($X)"
  - "if ($X !== null) { clearImmediate($X) }"
  - "if ($X != null) clearTimeout($X)"
  - "if ($X != null) { clearTimeout($X) }"
  - "if ($X != null) clearInterval($X)"
  - "if ($X != null) { clearInterval($X) }"
  - "if ($X != null) clearImmediate($X)"
  - "if ($X != null) { clearImmediate($X) }"
  - "if ($X !== undefined) clearTimeout($X)"
  - "if ($X !== undefined) { clearTimeout($X) }"
  - "if ($X !== undefined) clearInterval($X)"
  - "if ($X !== undefined) { clearInterval($X) }"
  - "if ($X !== undefined) clearImmediate($X)"
  - "if ($X !== undefined) { clearImmediate($X) }"
  - "if ($X != undefined) clearTimeout($X)"
  - "if ($X != undefined) { clearTimeout($X) }"
  - "if ($X != undefined) clearInterval($X)"
  - "if ($X != undefined) { clearInterval($X) }"
  - "if ($X != undefined) clearImmediate($X)"
  - "if ($X != undefined) { clearImmediate($X) }"
---

**Do not guard `clearTimeout` / `clearInterval` / `clearImmediate` with truthiness or `null`/`undefined` checks.** Per WHATWG/Node timers spec, calls no-op for `null`, `undefined`, or values without a live timer; guards cannot change behavior, add branches readers must reason about, inflate code, hide the line that matters, and signal timer-API misunderstanding.

## Avoid

```ts
if (this.timer) clearTimeout(this.timer);
if (handle !== null) clearInterval(handle);
if (id != undefined) {
	clearImmediate(id);
}
```

## Use

```ts
clearTimeout(this.timer);
clearInterval(handle);
clearImmediate(id);
```

## When a guard *is* warranted

Keep it only if the body does more than clear, e.g. reassigns the handle or runs other cleanup:

```ts
if (this.timer) {
	clearTimeout(this.timer);
	this.timer = undefined; // extra work → guard is not purely redundant
}
```

Rule fires only if the clear call is the guarded branch's sole statement; legitimate cases are left alone.
