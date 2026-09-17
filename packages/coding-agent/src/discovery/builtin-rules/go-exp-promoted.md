---
description: "Use the standard library slices and maps packages instead of golang.org/x/exp/{slices,maps}"
condition:
  - '"golang.org/x/exp/slices"'
  - '"golang.org/x/exp/maps"'
scope: "tool:edit(*.go), tool:write(*.go)"
interruptMode: never
---

Go 1.21: `golang.org/x/exp/slices` and `golang.org/x/exp/maps` → stdlib `slices` and `maps`. New code: stdlib imports, not experimental.

## Migration

```go
// Before
import (
	"golang.org/x/exp/slices"
	"golang.org/x/exp/maps"
)

// After
import (
	"slices"
	"maps"
)
```

Most call sites unchanged: `slices.Sort`, `slices.Contains`, `slices.Index`, `slices.Equal`, `maps.Clone`, etc.

## Signature differences

Promoted APIs tweaked; blind path swap can break the build:

- `x/exp/maps.Keys(m)` and `x/exp/maps.Values(m)`: slice; stdlib `maps.Keys(m)` and `maps.Values(m)`: iterator (`iter.Seq`). Recover a slice: `slices.Collect(maps.Keys(m))`; or range over the iterator.
- `slices.SortFunc`: comparison returns `int` (cmp-style), matching stdlib signature.

## Keep x/exp when

- Module `go` directive below 1.21 → stdlib `slices`/`maps` do not exist.
- Need an unpromoted `x/exp` helper, e.g. parts of `x/exp/constraints` remain outside stdlib.
