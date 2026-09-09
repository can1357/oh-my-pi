# omp-edit

`omp-edit` is the shared edit engine for five wire modes: `replace`, `patch`, `apply_patch`, `hashline`, and `sloppy`. It supports incremental argument streaming, progressive previews, atomic in-memory staging, and final writes through a host-owned `EditWriter`.

The mode engines are pure over `FileSource` and `EditStore`. A `Session` owns streamed arguments and drives preview, stage, and apply, while the host retains ownership of persisted bytes. Model-facing errors remain byte-identical to the TypeScript implementation because models are trained on those messages.

## Module map

- `diff` and `diff_string`: jsdiff-compatible primitives and model-facing diff rendering.
- `engine`: shared edit modes, staged files, previews, and inspection types.
- `modes`: the five parsers and mode engines.
- `session`: streaming preview and host-writer orchestration.
- `files`, `path_policy`, and `notebook`: source access, path policy, and notebook projection.
- `store`: snapshots, hashline tags, clipboard state, and no-op detection.
- `stream_json`: incremental JSON argument recovery.
- `fuzzy` and `text`: matching and text-normalization utilities.
