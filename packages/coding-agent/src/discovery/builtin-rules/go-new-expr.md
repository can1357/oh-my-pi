---
description: "Use new(expr) for pointer-to-value helpers instead of `func ptr[T any](v T) *T { return &v }` (Go 1.26)"
interruptMode: never
scope: "tool:edit(*.go), tool:write(*.go)"
astCondition:
  - "func $F($V $T) *$T { return &$V }"
  - "func $F[$$$TP]($V $T) *$T { return &$V }"
---

Go 1.26: `new(expr)` allocates, stores `expr`, returns `*T`; replaces pointer-value helpers and `x := v; p := &x`.

## Why

- Replaces per-type helpers (`boolPtr`, `strPtr`, `int64Ptr`, …) and `func Ptr[T any](v T) *T`.
- Value constructed directly in allocation: no extra function-call frame or separate heap escape.
- Call-site intent visible: `new(false)`, not a helper name.

## Avoid

```go
// A helper that just takes a value and returns its address.
func boolPtr(v bool) *bool   { return &v }
func strPtr(v string) *string { return &v }
func Ptr[T any](v T) *T       { return &v }

cfg := Config{Enabled: boolPtr(true), Name: strPtr("svc")}
```

## Use

```go
cfg := Config{Enabled: new(true), Name: new("svc")}

// Was: x := int64(300); p := &x
p := new(int64(300))
```

`new(true)` / `new(false)`: `*bool`. `new(expr)`: any expression, including function results (`new(time.Now())`).

## Notes

- Requires Go 1.26+. If the module's `go` directive is older, keep the helper or temp-variable form until the toolchain is bumped.
- Scope: helpers only taking a value and returning its address; functions doing work before taking an address excluded.
- `new(T)` (bare type) unchanged; still zero-initializes.
