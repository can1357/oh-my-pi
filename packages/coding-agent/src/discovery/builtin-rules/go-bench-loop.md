---
description: "Use for b.Loop() in benchmarks instead of the for i := 0; i < b.N; i++ loop (Go 1.24)"
interruptMode: never
scope: "tool:edit(*_test.go), tool:write(*_test.go)"
astCondition:
  - "func $F($B *testing.B) { $$$PRE for $I := 0; $I < $B.N; $I++ { $$$BODY } $$$POST }"
---

Go 1.24 added `testing.B.Loop`. Write `for b.Loop() { ... }` instead of looping over `b.N`.

## Why

- Setup and teardown outside the loop run exactly once per `-count`, not once per `b.N` re-estimation, so expensive fixtures are no longer timed or repeated.
- The compiler keeps the loop's parameters and results alive, so it can't optimize away the body you are trying to measure — a classic `b.N` benchmarking footgun.

## Avoid

```go
func BenchmarkEncode(b *testing.B) {
	for i := 0; i < b.N; i++ {
		Encode(input)
	}
}
```

## Use

```go
func BenchmarkEncode(b *testing.B) {
	for b.Loop() {
		Encode(input)
	}
}
```

Requires Go 1.24+. If the module targets an older Go, keep the `b.N` loop.
