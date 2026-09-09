# omp Python extension API

The `omp` package is the frozen Python surface for extending the omp coding agent. It runs on the free-threaded CPython 3.14t interpreter embedded in the `omp` binary, so users do not install a separate Python runtime. Reach for it when you want to add tools and devices, react to agent events, shape regimes, contribute UI behavior, or coordinate agents and sessions.

```python
from typing import Annotated
import omp

@omp.tool(kind="soft", rev=1)
async def word_count(
    text: Annotated[str, omp.Field("Text to count")],
    include_lines: Annotated[
        bool,
        omp.Field("Include a line count in the response"),
    ] = False,
) -> dict[str, int]:
    result = {"words": len(text.split())}
    if include_lines:
        result["lines"] = len(text.splitlines())
    return result
```

## What you can build

- **Tools and devices** with typed parameters, generated schemas, placement controls, and stable revisions.
- **Hooks and regimes** that observe events, participate in admission decisions, or replace the default agent loop.
- **User interfaces** with commands, shortcuts, renderers, completions, and effects.
- **Agent workflows** that create subagents, inspect sessions, and persist durable records.
- **Environment-aware integrations** that request explicit capabilities instead of inheriting ambient machine access.
- **Inference providers and telemetry** that use the same frozen, versioned contract as the rest of the host.

## Where to go next

- [Install or link an extension](getting-started/installation.md).
- [Build a minimal working extension](getting-started/quickstart.md).
- [Learn the runtime mental model](getting-started/concepts.md).
- Follow a task-focused chapter in the [guides](guides/devices.md).
- Look up exact symbols in the [`omp` API reference](reference/omp.md).
