---
description: Prefer math/rand/v2 over the legacy math/rand package
condition: '"math/rand"'
scope: "tool:edit(*.go), tool:write(*.go)"
interruptMode: never
---

Use `math/rand/v2` instead of the legacy `math/rand` package (stable since Go 1.22).

## Why

- No global `Seed`: `math/rand`'s top-level functions read a process-global generator (auto-seeded since Go 1.20), so a fixed seed is global mutable state that's easy to misuse; `v2` drops the global `Seed` entirely.
- Cleaner, better-bounded API: `rand.IntN(n)` / generic `rand.N(n)` replace `rand.Intn(n)`, and `Shuffle`, `Perm`, `Float64` carry over with clearer names.
- Modern generators: `v2` exposes `PCG` and `ChaCha8` sources instead of the old default LCG.

## Migration

```go
// Before
import "math/rand"
n := rand.Intn(100)
f := rand.Float64()

// After
import "math/rand/v2"
n := rand.IntN(100)
f := rand.Float64()
```

| math/rand | math/rand/v2 |
| --- | --- |
| `rand.Intn(n)` | `rand.IntN(n)` |
| `rand.Int63n(n)` | `rand.Int64N(n)` |
| `rand.Intn`/`Int31n` on a `*Rand` | `(*Rand).IntN` / `Int32N` |
| `rand.Seed(x)` | drop it — `v2` has no global seed |
| explicit `rand.New(rand.NewSource(seed))` | `rand.New(rand.NewPCG(s1, s2))` or `rand.NewChaCha8(seed)` |

## Keep math/rand only when

- You need a reproducible stream from a fixed seed via the classic `NewSource`/`Seed` API that a caller already depends on.
- Reach for `crypto/rand` instead when the values are security-sensitive — neither `math/rand` variant is cryptographically secure.
