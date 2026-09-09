# `omp.limits`

`omp.limits` exposes the fixed compatibility, protocol, capacity, and timing ceilings enforced by the host. Read these constants when an extension needs to size work or reject an incompatible runtime before starting it.

```python
import omp

if omp.limits.API_LEVEL not in omp.limits.API_LEVELS:
    raise RuntimeError("unsupported omp API level")

print(omp.limits.MAX_FRAME_BYTES)
```

The values are host facts, not extension configuration. For per-process resource ceilings, use [`ResourceBudget`](omp.policy.md#omppolicyresourcebudget).

### omp.limits.ACTIVATION_TIMEOUT

```python
ACTIVATION_TIMEOUT: Final[Duration] = Duration("10s")
```

Allows ten seconds for one extension activation before degradation.

### omp.limits.API_LEVEL

```python
API_LEVEL: Final[int] = 1
```

Identifies the current extension API level.

### omp.limits.API_LEVELS

```python
API_LEVELS: Final[frozenset[int]] = frozenset({API_LEVEL})
```

Lists extension API levels accepted by this host; currently `{1}`.

### omp.limits.CANCEL_GRACE

```python
CANCEL_GRACE: Final[Duration] = Duration("150ms")
```

Allows 150 milliseconds between cooperative task cancellation and thread interruption.

### omp.limits.DOCS_TOTAL_BUDGET

```python
DOCS_TOTAL_BUDGET: Final[int] = 48_000
```

Caps the total documentation characters across one extension's device tree.

### omp.limits.HEALTH_TIMEOUT

```python
HEALTH_TIMEOUT: Final[Duration] = Duration("5s")
```

Allows five seconds for health checks, handshakes, and frame reads.

### omp.limits.HOST_VERSION

```python
HOST_VERSION: Final[str] = "0.1.0"
```

Reports the build-stamped omp host version.

### omp.limits.INTERACTIVE_CAP

```python
INTERACTIVE_CAP: Final[Duration] = Duration("15m")
```

Caps one interactive operation at fifteen minutes.

### omp.limits.MAX_FRAME_BYTES

```python
MAX_FRAME_BYTES: Final[int] = 67_108_864
```

Caps an encoded CONTROL or DATA frame at 64 MiB.

### omp.limits.MAX_HOST_CHILDREN

```python
MAX_HOST_CHILDREN: Final[int] = 32
```

Caps live extension-host children in one session at 32.

### omp.limits.MAX_PENDING_EFFECTS

```python
MAX_PENDING_EFFECTS: Final[int] = 1024
```

Caps pending CONTROL requests plus fire-and-forget effects for each child at 1,024.

### omp.limits.MODIFY_ROUNDS

```python
MODIFY_ROUNDS: Final[int] = 1
```

Allows one hook modification round.

### omp.limits.OBSERVE_CAP

```python
OBSERVE_CAP: Final[int] = 64
```

Caps observation handlers at 64.

### omp.limits.PING_INTERVAL

```python
PING_INTERVAL: Final[Duration] = Duration("15s")
```

Sets the idle interval between host health probes to fifteen seconds.

### omp.limits.PYTHON_REV

```python
PYTHON_REV: Final[str] = "3.14t"
```

Names the required free-threaded Python ABI revision.

### omp.limits.REENTRANCY_DEPTH

```python
REENTRANCY_DEPTH: Final[int] = 4
```

Caps nested reentrant host operations at four levels.

### omp.limits.SCHEMA_REV

```python
SCHEMA_REV: Final[int] = 7
```

Names the wire schema revision shared with `omp_proto::SCHEMA_REV`.

### omp.limits.SETTLE_CONTINUATION_CAP

```python
SETTLE_CONTINUATION_CAP: Final[int] = 8
```

Caps settlement continuations at eight.

### omp.limits.SHUTDOWN_BUDGET

```python
SHUTDOWN_BUDGET: Final[Duration] = Duration("2s")
```

Budgets two seconds for shutdown work.

### omp.limits.SHUTDOWN_GRACE

```python
SHUTDOWN_GRACE: Final[Duration] = Duration("2s")
```

Allows authorized work up to two seconds to settle during shutdown.

> **Note** `SHUTDOWN_BUDGET` and `SHUTDOWN_GRACE` currently have equal values but describe separate host limits.
