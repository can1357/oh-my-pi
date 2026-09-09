# omp-collab

`omp-collab` owns OMP's versioned, bounded collaboration relay substrate: room cryptography, revision-3 JSON framing with the browser-compatible four-byte relay envelope, deterministic replication reduction, correlated host UI requests, and reconnect transport state. It deliberately has no application or UI dependencies. The `/r/<room>`, AES-GCM, envelope, and shared frame grammar match `collab-web`; native agent inspection extends that grammar with detached DOM snapshot/event frames so actors never read host journal files.
