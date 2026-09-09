# omp-session

`omp-session` owns the journal-to-DOM fold for one OMP session. Every live write is preflighted, appended to the raw-SSE journal, then folded from the exact returned entry. Opening simulates every historical file-prefix operation and prior jump, reproducing the selected DOM and allocator history exactly.

The crate deliberately keeps one authority. Durable component state lives below `<meta>`, conversational state below explicit `<turn>` elements in `<body>`, and actor input below `<queues>`. Rewind selects an ancestor through the journal's `prior` links, re-derives the tree while preserving the handle high-water mark, and reports lifecycle work as a DOM snapshot diff. Renderers and inference consume pure DOM projections or the snapshot-plus-event subscription; reset events make replicas converge across rewind without inspecting the journal.
