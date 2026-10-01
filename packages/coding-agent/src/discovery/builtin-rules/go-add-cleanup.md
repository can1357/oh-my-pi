---
description: "Prefer runtime.AddCleanup over runtime.SetFinalizer for new code (Go 1.24)"
condition: 'runtime\.SetFinalizer'
scope: "tool:edit(*.go), tool:write(*.go)"
interruptMode: never
---

Go 1.24 added `runtime.AddCleanup`; new code SHOULD prefer it over `runtime.SetFinalizer`.

## Why AddCleanup wins

- One object — multiple cleanups; `SetFinalizer`: one.
- Cleanups MAY attach to interior pointers.
- Reference cycles: cleanups run; finalizers leak.
- Cleanup neither resurrects object nor delays freeing it or its referents an extra GC cycle.

## Migration

```go
// Before
runtime.SetFinalizer(obj, func(o *T) { o.release() })

// After — the cleanup func receives a value you supply, NOT the object,
// so it cannot accidentally keep the object alive.
runtime.AddCleanup(obj, func(h handle) { h.release() }, obj.handle)
```

Cleanup argument MUST NOT reference `obj` itself: it remains reachable forever. Capture only needed data: file descriptor, handle, or pointer independent of `obj`.

## Keep SetFinalizer only when

- Module targets Go <1.24.
- Finalizer-specific behavior required, e.g. object resurrection, which `AddCleanup` does not provide.
