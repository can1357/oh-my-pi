# platform

| package | what it is |
|---|---|
| `packages/cache` | in-memory TTL cache |
| `packages/gateway` | token-bucket rate limiter for outbound calls |
| `packages/sync` | polling loop that mirrors a remote list |
| `packages/util` | clocks shared by the others |

## Tests

    bun test

From the root this runs every package's suite, about 20 seconds: gateway and sync run on real
timers. A package's suite also runs alone from its own directory (`cd packages/cache && bun test`).
