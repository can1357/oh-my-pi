# Quickstart

This walkthrough creates one typed tool and one observation hook in a single module. The tool counts words; the hook writes a structured debug record after each completed turn.

## 1. Create the files

Create this layout:

```text
word-tools/
├── omp.toml
└── word_tools.py
```

Put the static declarations in `omp.toml`:

```toml
id = "dev.example.word-tools"
name = "Word tools"
version = "0.1.0"
omp_api = 1
entry = "word_tools"
capabilities = []

[[tools]]
name = "word_count"
kind = "soft"
family = "dev.example.word-tools"
rev = 1
module = "word_tools"
summary = "Count words in text"

[[hooks]]
event = "turn_end"
phase = "observe"
module = "word_tools"
```

The manifest advertises both surfaces before Python starts. The imported decorators must declare the same tool name, family, revision, event, and phase.

## 2. Implement the extension

Write `word_tools.py`:

```python
from typing import Annotated

import omp


@omp.tool(kind="soft", rev=1)
async def word_count(
    text: Annotated[str, omp.Field("Text whose words should be counted")],
    lowercase: Annotated[
        bool,
        omp.Field("Normalize the text before counting"),
    ] = False,
) -> dict[str, int]:
    if lowercase:
        text = text.lower()
    return {"words": len(text.split())}


@omp.hook("turn_end", phase=omp.HookPhase.OBSERVE)
async def record_turn(event: omp.TurnEndEvent) -> None:
    omp.Context.current().log(
        omp.LogLevel.DEBUG,
        "turn completed",
        turn=event.turn_index,
        calls=len(event.calls),
    )
```

`@omp.tool` supports both `@omp.tool` and `@omp.tool(...)` forms. Its exact signature is:

```python
def tool(
    name: str | Callable[..., Any] | None = None,
    *,
    kind: str = "soft",
    effects: Effects | None = None,
    tier: Tier | None = None,
    rev: int = 1,
    constraint: ToolConstraint | None = None,
    serial: bool = False,
) -> Callable[[Callable[..., Any]], Device] | Device:
    ...
```

`Annotated` metadata becomes part of the argument schema. The decorated function may be asynchronous, and you must `await` any asynchronous omp API it calls. An observation hook may return only `None`.

## 3. Link and enable it

From the extension directory, run:

```console
$ omp ext link "$PWD"
$ omp ext enable dev.example.word-tools
```

A fresh session discovers the manifest. The Python child remains lazy until the tool is inspected or invoked, or the subscribed event first occurs.

## 4. Invoke the tool

Use the device catalog through the `dyn` shell builtin:

```console
$ dyn word_count --text "one two three"
{"words": 3}
```

If the catalog qualifies names by extension family in your session, use the path shown by `dyn` when you list the catalog. The result is the value returned by `word_count`; omp performs schema decoding before the function runs.

Complete a turn and inspect the extension logs to observe the `"turn completed"` record from the hook. Its fields include the zero-based turn index and number of calls.

## Next steps

- Add richer schemas and availability rules in [Devices](../guides/devices.md).
- Learn decision phases and failure behavior in [Hooks](../guides/hooks.md).
- Package the extension for other users in [Placement and Packaging](../guides/placement-and-packaging.md).
