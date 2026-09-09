# Core concepts

The extension API is deliberately narrower than ordinary application Python. Keep this model in mind and you will know where declarations belong, when work may run, and why resource access is always mediated.

## A frozen API surface

`omp` ships inside the application binary with a frozen standard library and runs on embedded free-threaded CPython 3.14t. You target the API levels in `omp.API_LEVELS`, not whichever `omp` package happens to be available from a package index. The extension manifest's `omp_api` value is checked before import.

Frozen describes the host contract, not your extension code: your modules and resolved wheels live in the admitted site tree. See [Installation](installation.md) and the [`omp` reference](../reference/omp.md).

## One supervised extension host

Extension Python runs outside the agent core in a supervised child process. A child has its own interpreter and imports, so a crash, hang, cancellation escalation, or hot reload can be handled by replacing that generation instead of taking down the agent.

A replacement starts a new generation and imports the extension again. During a live callback, `omp.Context.current().generation` identifies that generation. `omp.restart_reason()` reports the host-provided `RestartReason`, or `None` when there is no restart cause. Keep durable state outside module globals and make activation work safe to repeat. See [Agents and Sessions](../guides/agents-and-sessions.md) and [`omp.sessions`](../reference/omp.sessions.md).

## Import declares; FREEZE seals

Module import is the declaration phase. Decorators such as `@omp.device`, `@omp.tool`, `@omp.hook`, and `@omp.command` register static facts while their modules execute. Import must not depend on filesystem, network, subprocess, Environment, CONTROL, or DATA operations.

After all manifest-named modules are imported, FREEZE seals the registry. A declaration attempted later raises `DeclarationSealed`. The host can then verify the complete declaration set against `omp.toml`. Put conditional runtime behavior in handlers or supported availability predicates, not in late imports. See [Devices](../guides/devices.md) and [Hooks](../guides/hooks.md).

## Capabilities are a closed vocabulary

Manifest capabilities are explicit grants selected from [`omp.Capability`](../reference/omp.md#ompcapability). They are not arbitrary labels and they do not become valid because an extension calls an API with the same-looking string. Use `omp.require(...)` when a code path should fail immediately unless its grants include specific capabilities.

Authorization still depends on the active invocation and operation phase. A manifest grant says an extension may request an operation; it does not provide ambient authority. See [Environment](../guides/environment.md) and [`omp.env`](../reference/omp.env.md).

## Verdicts carry outcomes

A device does not need to flatten every outcome into text. The verdict vocabulary represents successful values, durable faults, updates, detached jobs, recorded calls, and prompt projections. At the interaction boundary, `resolve`, `reject`, and `propose` distinguish accepting a result, refusing an invalid request, and offering a proposed change for review.

Use the typed verdict classes when the caller needs more than a plain return value. See [Verdicts](../reference/verdicts.md) and [`omp.params`](../reference/omp.params.md).

## CONTROL mediates host resources

Extension code never reaches into agent-core resources directly. The host installs a CONTROL bridge for the active invocation; APIs for UI, sessions, agents, journal operations, secrets, and similar services send typed requests through it. Calling a bridged operation without an active host connection raises `HostDisconnected` or `NotWiredError`, depending on the surface.

Workspace files, execution, processes, and blobs are likewise exposed through the scoped Environment API rather than ambient local access. This distinction matters for remote workspaces: the active environment may be on another machine. See [Environment](../guides/environment.md), [User Interface](../guides/ui.md), and [Agents and Sessions](../guides/agents-and-sessions.md).

## Async first

Most operations that cross CONTROL or reach the Environment are asynchronous. Declare asynchronous handlers when they await host work:

```python
@omp.tool
async def extension_state_directory() -> str:
    return str(await omp.state_dir())
```

Await calls exactly as their reference signatures require. Synchronous declarations and pure helpers remain useful, but blocking work in a handler occupies that extension's callback lane. Cancellation is delivered cooperatively at await points before the supervisor escalates. See [Environment](../guides/environment.md) and the owning API reference page for each call.

## Placement follows the resource

A declaration's placement controls where its body executes. Host placement is the default. Environment and worker placement move computation toward workspace data or a named worker while preserving explicit capability and serialization boundaries. Code running on a worker has a narrower host surface than code running in the extension child.

Discovery scope and execution placement are related but different: a client-side installation may call into a workspace or worker, while a workspace-layer extension already runs beside that environment. See [Placement and Packaging](../guides/placement-and-packaging.md) and [`omp.placement`](../reference/omp.placement.md).
