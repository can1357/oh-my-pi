# `omp-dom`

`omp-dom` is omp's authoritative materialized session tree. Every durable feature is represented below the fixed `<session><meta/><body/><queues/></session>` root, and every mutation is an atomic transaction caused by a journal entry.

Handles are monotonic and never reused. Transactions validate against the sequential post-state through a touched-node scratch overlay before changing the live tree. Snapshots use deterministic handle order and include both handle and stream-id high-water marks. Actors receive one snapshot followed by lossless patch, stream-delta, and reset events; append-only text streams materialize their buffer only for snapshots and close, so append work is proportional to the incoming delta.

The crate depends on `omp-journal` only for `EntryId` and shares `Tag`, `PropId`, and their custom-name wrappers with terminal consumers through `omp-vocab`.
