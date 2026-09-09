# Eval prelude helpers

`@omp.prelude` lets an extension publish a small, named Python helper into every new eval namespace. The eval-side name is a synchronous function even when the extension implementation is `async def`.

A prelude helper is **not a tool**. It is not inserted into the tool `Registry`, advertised to the model as a tool schema, included in the tool prompt, available as `tool.<name>`, or routed through the `dyn` shell builtin. Use it for an operation that should read naturally inside Python eval code and whose arguments and result have a JSON representation.

Packaging, installation, activation, and the rest of the manifest belong to [14-deploy.md](14-deploy.md). Tool and `dyn` transport semantics belong to [01-devices.md](01-devices.md).

## Declare and package a helper

The complete decorator signature is:

```python
omp.prelude(
    name: str | Callable[..., Any] | None = None,
    *,
    rev: int = 1,
    summary: str | None = None,
)
```

All supported forms return the decorated function unchanged:

```python
import omp

@omp.prelude
def normalize_label(value, *, lowercase=True):
    """Normalize a label for lookup."""
    value = value.strip()
    return value.lower() if lowercase else value

@omp.prelude()
def helper_version():
    return {"version": 1}

@omp.prelude("join_labels", rev=2, summary="Join labels with a separator.")
def join_impl(labels, *, separator=", "):
    return separator.join(labels)
```

`name` defaults to the function's `__name__`. It must match
`^[a-z][a-z0-9_]{0,63}$`, must not be a Python keyword, and must not be an SDK-reserved name; otherwise decoration raises `omp.DeviceNameError`. `rev` must be an `int` (not `bool`) in `1..65535`; other types raise `TypeError` and out-of-range values raise `ValueError`. `summary` must be `str` or `None`; when omitted, omp uses the first line of the inspected docstring (or an empty string).

Only positional-or-keyword and keyword-only parameters are supported, and parameter names must be ASCII Python identifiers (`[A-Za-z_][A-Za-z0-9_]*`). Positional-only parameters, `*args`, `**kwargs`, or non-ASCII parameter names raise `omp.SchemaError` while the module is imported. Every default must be strict JSON data; non-JSON values, `NaN`, and infinities raise `omp.SchemaError`. Annotations are preserved as display text in the eval signature, but do not perform runtime validation.

Declaring the same helper name twice in one extension raises `omp.DuplicateRegistration`. Like other declarations, adding one after the declaration registry has frozen raises `omp.DeclarationSealed`, and the per-extension declaration limit still applies.

Declare the same identity in `omp.toml`. The current authoring syntax reuses a `[[tools]]` row:

```toml
id          = "dev.example.labels"
name        = "Label helpers"
version     = "1.0.0"
omp_api     = 1
entry       = "example_labels"

[[tools]]
name    = "normalize_label"
kind    = "soft"
family  = "prelude"
rev     = 1
module  = "example_labels"
summary = "Normalize a label for lookup."
```

`family = "prelude"` and `rev = 1` authenticate the decorator's `prelude.1` declaration identity. `kind = "soft"` is required by the current `[[tools]]` authoring vocabulary; it does **not** register this declaration as a soft tool or expose it through the `dyn` shell builtin. The manifest name, family, revision, and module must agree with the imported declaration. See [14-deploy.md](14-deploy.md) for authoritative manifest generation, verification, packaging, and deployment rules.

The extension body may be synchronous:

```python
@omp.prelude
def select_fields(record, *, names=None):
    """Return selected JSON object fields."""
    if names is None:
        return record
    return {name: record[name] for name in names if name in record}
```

or asynchronous:

```python
@omp.prelude("lookup_label", rev=3)
async def lookup_label_impl(label, *, exact=False):
    """Look up a label in the extension's existing service."""
    result = await lookup(label, exact=exact)
    return {"label": result.label, "score": result.score}
```

The worker awaits an awaitable returned by the implementation adapter. Both examples must ultimately return a JSON-serializable value.

## What eval receives

At eval-child startup, omp installs one named synchronous stub per admitted helper:

```python
>>> import inspect
>>> inspect.signature(normalize_label)
<Signature (value, *, lowercase=True)>
>>> normalize_label("  Mixed Case  ")
'mixed case'
```

The stub has the declared name and docstring and a real `inspect.Signature`, so `help(normalize_label)` works. Calling it first runs `Signature.bind` locally. Missing, extra, duplicate, or wrongly positional arguments therefore raise Python `TypeError` in the eval child without invoking the extension. The stub then applies defaults and sends all bound arguments—including defaulted keyword-only arguments—as one JSON object. Results cross back through the same JSON boundary.

Annotations shown by `inspect.signature` and `help` are documentation, not a codec. Arguments and return values must still be JSON values. Worker rejection, an exception, cancellation, protocol failure, an invalid/non-JSON result, or a result spilled to a blob surfaces in the eval cell as `RuntimeError`.

## Call path and lifecycle

No Python objects or interpreter state are shared. A call crosses three processes:

```text
eval child (generated sync stub)
  -> envd session bridge
  -> extension worker child (sync or async implementation)
  -> JSON result along the reverse path
```

The helper set and signatures are a snapshot taken when an eval child starts. Starting or resetting an eval child obtains a fresh snapshot. An extension restart does not patch an already-running eval namespace, so its existing stubs remain the startup snapshot; calls still route to the current worker generation for the declared identity. A changed declaration becomes visible only in a newly started eval child after successful admission and verification.

Each call has a 600-second host deadline. While the bridge call is in flight, it is governed by that deadline rather than the ordinary eval-cell watchdog. Cancelling the eval call drops the worker invocation; worker cancellation and restart semantics then apply. Extension progress updates are intentionally discarded: a prelude helper is request/response only and returns one terminal JSON result.

## Startup failures and debugging

Helper names are session-global. Startup fails deterministically if two extensions declare the same prelude helper name, if a helper shadows a built-in eval-prelude global, or if a helper and an ordinary worker tool share a name. The eval installer independently rejects an invalid name or any collision in its namespace as a drift guard. Fix the declaration or manifest rather than trying to select one by import order.

For a failure before a body runs, inspect the local `TypeError` and `inspect.signature(helper)`. For a `RuntimeError`, inspect the extension worker failure: the call crossed the bridge and failed through rejection, the implementation, JSON result encoding, cancellation, deadline, or worker protocol. If the helper is absent, start a new eval child and check that the manifest identity matches the decorator and that extension startup/verification succeeded.

`omp.agents.*` remains `NotWired` in extension workers. A prelude body may use only SDK surfaces already wired for extensions; declaring a helper does not grant agent APIs, capabilities, or an indirect route to them. Agent APIs are outside this feature's boundary.

**Revision 2.2** — the `dyn` shell-builtin transport ruling: the dedicated `dyn` core tool and its `do_` envelope are deleted. Devices are discovered, documented, and dispatched through the `dyn` builtin of the embedded shell, inside the core `shell` tool: `dyn` lists the catalog (`dyn --q <text>` searches), `dyn <device> --help` returns docs plus schema-derived CLI usage, and `dyn <device> [args…]` (or `dyn <device> --json '<payload>'`) invokes — arguments arrive as one nested JSON document mapped from the CLI ([01-devices.md](01-devices.md) owns the schema→CLI grammar). Staged-proposal resolution is `dyn resolve "<reason>"` / `dyn reject "<reason>"`. The `do_`/trailing-underscore reserved-parameter rule is deleted with the envelope. The one-gate rule transfers intact: an `dyn` device dispatch fires one `tool_call` with the RESOLVED `target=DeviceCall(...)`; catalog and docs reads fire `target=CoreTool("shell")` — the builtin is transport, never the policy subject. The model's tool array shrinks by the `dyn` slot; a device still has no schema in the request.

In this file, the live exclusions now state that prelude helpers are not routed through or exposed by the `dyn` shell builtin.
