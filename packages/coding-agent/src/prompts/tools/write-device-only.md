Executes a mounted `xd://` tool device: `path` is `xd://<tool>` and `content` is the device's JSON arguments object. `read xd://` lists the mounted devices; `read xd://<tool>` shows a device's full docs.

It also writes `local://` session scratch files (reports, drafts, notes). Every other path—working tree, other internal URLs—is rejected.
