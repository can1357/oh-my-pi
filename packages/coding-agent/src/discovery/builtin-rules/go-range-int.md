---
description: "Use for i := range n instead of the C-style for i := 0; i < n; i++ loop (Go 1.22)"
interruptMode: never
scope: "tool:edit(*.go), tool:write(*.go)"
astCondition:
  - "for $I := 0; $I < $N; $I++ { $$$BODY }"
---

Go 1.22: `for` ranges integers. For `i := 0; i < n; i++`, prefer `for i := range n`; if index unused, `for range n`.

## Avoid

```go
for i := 0; i < n; i++ {
	use(i)
}

for i := 0; i < len(s); i++ {
	use(s[i])
}
```

## Use

```go
for i := range n {
	use(i)
}

// Ranging the slice directly is usually clearer than indexing.
for i := range s {
	use(s[i])
}

// Index unused → drop it entirely.
for range n {
	tick()
}
```

## Exceptions

- Keep explicit: non-zero start; step other than `++`; descending (`for i := n - 1; i >= 0; i--`).
- Keep explicit if body reassigns loop variable or depends on `i` surviving past loop.
- Requires Go 1.22+. If module `go` directive older, keep classic loop.
