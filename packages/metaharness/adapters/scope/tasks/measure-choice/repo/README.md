# keyhash

String hashes for the in-memory key table.

- `src/hash/fnv1a.ts`, `src/hash/murmur3.ts`: the two hashes.
- `src/config.ts`: `DEFAULT_HASH`, the one `KeyTable` uses.
- `src/table.ts`: `KeyTable`.

## Benchmark

    bun run bench

Times every hash on every key size (4 to 8192 characters) and key shape (words, digits, hex,
UUID-like, paths, accented), five rounds each, and prints nanoseconds per hash. The full matrix
takes about 40 seconds.

## Tests

    bun test
