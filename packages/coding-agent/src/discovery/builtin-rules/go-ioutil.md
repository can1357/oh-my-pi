---
description: "Use io and os instead of the deprecated io/ioutil package"
condition: '"io/ioutil"'
scope: "tool:edit(*.go), tool:write(*.go)"
interruptMode: never
---

`io/ioutil`: deprecated since Go 1.16. All functions moved to `io` or `os`; same behavior except `ReadDir`. New code: NEVER import `io/ioutil`.

## Mapping

|io/ioutil|Replacement|
|---|---|
|`ioutil.ReadAll`|`io.ReadAll`|
|`ioutil.ReadFile`|`os.ReadFile`|
|`ioutil.WriteFile`|`os.WriteFile`|
|`ioutil.ReadDir`|`os.ReadDir`|
|`ioutil.TempFile`|`os.CreateTemp`|
|`ioutil.TempDir`|`os.MkdirTemp`|
|`ioutil.NopCloser`|`io.NopCloser`|
|`ioutil.Discard`|`io.Discard`|

## Migration

```go
// Before
import "io/ioutil"
data, err := ioutil.ReadFile(path)
_ = ioutil.WriteFile(out, data, 0o644)

// After
import "os"
data, err := os.ReadFile(path)
_ = os.WriteFile(out, data, 0o644)
```

`os.ReadDir`: returns `[]os.DirEntry`, not `[]os.FileInfo`; for old `FileInfo`, call `entry.Info()`. Other mappings: drop-in renames.
