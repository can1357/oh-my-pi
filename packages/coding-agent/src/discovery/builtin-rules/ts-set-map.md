---
description: Prefer Record<K, V> for small static literals; use Set/Map for anything dynamic
condition: "\\bnew\\s+(Set|Map)\\b"
scope: "tool:edit(**/*.{ts,tsx}), tool:write(**/*.{ts,tsx})"
interruptMode: never
---

Small, static string-keyed lookup tables: `Record<K, V>` / `Record<K, true>`.

`Set` / `Map`: dynamic/non-string keys; runtime insertion/deletion; `.size`, `.clear()`, stable insertion order, or iterator APIs.

```typescript
// Static literal → Record
const LABEL_BY_KIND: Record<string, string> = {
	text: "Text",
	json: "JSON",
	binary: "Binary",
};

// Dynamic membership → Set
const seen = new Set<string>();
for (const item of items) {
	if (seen.has(item.id)) continue;
	seen.add(item.id);
}
```
