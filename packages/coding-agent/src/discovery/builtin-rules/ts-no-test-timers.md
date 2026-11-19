---
description: Do not use real timers (Bun.sleep, setTimeout, setInterval) in tests — drive time with fake timers instead
condition:
  - "Bun\\.sleep\\("
  - "\\bsetInterval\\("
  - "\\bsetTimeout\\("
scope: "tool:edit(*.test.ts), tool:write(*.test.ts)"
interruptMode: never
---

**Avoid real wall-clock timers in test files.** `Bun.sleep(...)`, `setTimeout(...)`, and `setInterval(...)` bind duration to real time → fixed latency each invocation; CI pays every run. “Long enough” sleeps guess at and mask races; under load, races resurface and flake. Fixed waits hide the awaited condition, so failures point to a timeout, not the cause.

## Avoid

```typescript
test("debounce fires once", async () => {
	const fn = debounce(handler, 100);
	fn();
	await Bun.sleep(150); // real delay — slow and timing-dependent
	expect(handler).toHaveBeenCalledTimes(1);
});
```

## Use

Drive time deterministically with fake timers:

```typescript
import { expect, test, vi } from "bun:test";

test("debounce fires once", () => {
	vi.useFakeTimers();
	const fn = debounce(handler, 100);
	fn();
	vi.advanceTimersByTime(150); // advance the clock, no real wait
	expect(handler).toHaveBeenCalledTimes(1);
});
```

When code resolves a promise or emits an event, await that signal, not a guessed duration:

```typescript
await once(emitter, "done"); // await the real event
const value = await pending; // await the promise the code already exposes
```

## Exceptions

Integration tests deliberately exercising real timer behavior against the platform clock may need a genuine delay. Keep rare; add a short comment naming why deterministic time control will not work.
