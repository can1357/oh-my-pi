Executes a mounted `xd://` tool device: `path` is `xd://<tool>` and `content` is the device's JSON arguments object. `read xd://` lists the mounted devices; `read xd://<tool>` shows a device's full docs.

Outside active plan mode, this `write` tool rejects every non-`xd://` path. During plan mode, it can also write `local://` sandbox drafts required by that workflow; working-tree paths remain rejected.
