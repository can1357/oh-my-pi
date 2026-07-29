# Oh My Pi / OMP Compatibility

This package is compatible with the current OMP extension shape:

```ts
export default function extension(pi) {
  pi.registerTool(...)
  pi.registerCommand(...)
  pi.on("input", ...)
}
```

The extension deliberately avoids a hard runtime import from `@oh-my-pi/pi-coding-agent`. That makes it resilient to forks that rename packages or move type exports. The OMP runtime passes the `pi` object into the default factory; this package uses only runtime methods documented by OMP:

- `setLabel`
- `registerTool`
- `registerCommand`
- `on`
- `setModel`
- `zod`
- `logger`

## Loading modes

### Project-native discovery

Place the built package under:

```text
<repo>/.ompk/extensions/llm-router-agent/
```

OMP can discover extension modules from project `.ompk/extensions` and user `~/.ompk/agent/extensions` paths.

### Explicit config

Add a path to `.ompk/config.yml` or `~/.ompk/agent/config.yml`:

```yaml
extensions:
  - /absolute/path/to/llm-router-agent/dist/extension.js
```

### Package manifest mode

The package contains both current and legacy manifest keys:

```json
{
  "omp": { "extensions": ["./dist/extension.js"] },
  "pi": { "extensions": ["./dist/extension.js"] }
}
```

That supports current OMP and older Pi-compatible manifests.

## Model compatibility strategy

Forks can differ in model role names and resolver behavior. The router therefore stores selectors in config:

```json
{
  "models": {
    "fast": {
      "selector": "pi/smol",
      "fallbackSelectors": ["smol", "default"]
    }
  }
}
```

For `oh-my-pk`, update selectors to match your fork. No code changes should be necessary unless the extension API itself changed.

## Auto-switching

Default mode is conservative:

```json
{ "extension": { "mode": "recommend" } }
```

This records and displays route decisions without changing the active model.

To attempt model switching:

```json
{ "extension": { "mode": "try-set-model" } }
```

The extension tries each selector through `ctx.models.resolve()` when available, then falls back to `pi.setModel(selector)`. Errors are logged and do not block the session.

## Tool-use capture compatibility

The extension exposes two additional tools:

- `router_capture_tool_use` records tool arguments/results/errors as redacted compact telemetry.
- `router_export_tool_training` converts captured telemetry to supervised JSONL examples.

It also registers best-effort listeners for common tool runtime events: `tool_use`, `tool_call`, `tool_start`, `tool_result`, `tool_end`, and `tool_error`. Forks that emit different events can call `router.captureTool(...)` or `ToolUseCaptureLayer.record(...)` directly.
