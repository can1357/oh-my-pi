# Dynamic Python Tool Documentation

## Problem

`packages/coding-agent/src/prompts/tools/python.md` contains hardcoded documentation for prelude helpers:

```markdown
### File I/O
- `read(path, limit=None)` — read file, optional char limit
- `write(path, content)` — write file (creates parents)
...
```

This duplicates information already present in `python-prelude.py` (function signatures and docstrings). When the prelude changes, the markdown must be manually updated — they drift.

## Goal

Extract helper documentation from the running Python environment via runtime introspection, then populate `python.md` using Handlebars templating (same system as `system-prompt.md`).

## Current Flow

```
startup
  └─> checkPythonKernelAvailability(cwd)  // just checks if kernel_gateway is installed
        └─> returns { ok: true/false, reason }

createTools(session)
  └─> if python available && mode != "bash-only"
        └─> createPythonTool(session)
              └─> description: renderPromptTemplate(pythonDescription)  // no context, static
```

## Proposed Flow

```
startup
  └─> warmPythonKernel(cwd)
        ├─> start kernel gateway + kernel
        ├─> run prelude
        ├─> run introspection snippet
        │     └─> returns JSON: [{ name, signature, docstring, category }, ...]
        ├─> cache extracted docs in module-level state
        └─> returns { ok, reason, kernel }

createTools(session)
  └─> if python available && mode != "bash-only"
        └─> createPythonTool(session)
              └─> description: renderPromptTemplate(pythonDescription, { helpers: cachedDocs })

session reset
  └─> kernel.restart()  // reuse same gateway, just restart kernel
```

## Key Changes

### 1. `python-kernel.ts` — Add introspection method

```typescript
interface PreludeHelper {
  name: string;
  signature: string;
  docstring: string;
}

class PythonKernel {
  // existing...
  
  async introspectPrelude(): Promise<PreludeHelper[]> {
    const result = await this.execute(INTROSPECTION_SNIPPET);
    return JSON.parse(result.output);
  }
}
```

### 2. `python-executor.ts` — Expose warm kernel + cached docs

```typescript
let cachedPreludeDocs: PreludeHelper[] | null = null;

export async function warmPythonEnvironment(cwd: string): Promise<{
  ok: boolean;
  reason?: string;
  docs: PreludeHelper[];
}> {
  // 1. Check availability (existing)
  // 2. Start kernel (new - currently deferred to first execute)
  // 3. Run prelude (already happens on kernel start)
  // 4. Introspect and cache
  // 5. Return docs
}

export function getPreludeDocs(): PreludeHelper[] {
  return cachedPreludeDocs ?? [];
}
```

### 3. `tools/index.ts` — Warm kernel during tool creation

```typescript
export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
  // ...existing python availability check...
  
  if (shouldCheckPython) {
    const warmup = await warmPythonEnvironment(session.cwd);
    pythonAvailable = warmup.ok;
    // docs now cached for use by createPythonTool
  }
  
  // ...rest unchanged...
}
```

### 4. `tools/python.ts` — Pass docs to template

```typescript
import { getPreludeDocs } from "../python-executor";

export function createPythonTool(session: ToolSession): AgentTool<typeof pythonSchema> {
  const helpers = getPreludeDocs();
  const categories = groupByCategory(helpers);  // group into File I/O, Navigation, etc.
  
  return {
    name: "python",
    description: renderPromptTemplate(pythonDescription, { categories }),
    // ...
  };
}
```

### 5. `prompts/tools/python.md` — Use Handlebars

```markdown
## Prelude helpers

All helpers auto-print results and return values for chaining.

{{#each categories}}
### {{name}}
{{#each functions}}
- `{{name}}{{signature}}` — {{docstring}}
{{/each}}

{{/each}}
```

## Introspection Snippet

```python
import inspect, json

CATEGORIES = {
    'read': 'File I/O', 'write': 'File I/O', 'append': 'File I/O', ...
    'cp': 'File operations', 'mv': 'File operations', ...
}

helpers = []
for name, cat in CATEGORIES.items():
    obj = globals().get(name)
    if not callable(obj):
        continue
    sig = str(inspect.signature(obj))
    doc = (inspect.getdoc(obj) or '').split('\n')[0]
    helpers.append({'name': name, 'signature': sig, 'docstring': doc, 'category': cat})

print(json.dumps(helpers))
```

## Category Mapping

Categories are defined in the introspection snippet (Python side), not TypeScript. This keeps the source of truth in one place. Order:

1. File I/O: `read`, `write`, `append`, `touch`, `cat`
2. File operations: `cp`, `mv`, `rm`, `mkdir`
3. Navigation: `pwd`, `cd`, `ls`, `tree`, `stat`
4. Search: `find`, `glob_files`, `grep`, `rgrep`
5. Text processing: `head`, `tail`, `sort_lines`, `uniq`, `cols`, `wc`
6. Find and replace: `replace`, `sed`, `rsed`
7. Batch operations: `batch`, `diff`
8. Shell bridge: `run`, `bash`, `env`

## Session Reset Behavior

Currently: `reset: true` parameter triggers full kernel restart via `restartKernelSession()`.

Proposed: Same behavior, but the pre-warmed kernel is the one being restarted. No change needed — the existing session management already handles this.

## Environment Variable Override

Add `OMP_PY` environment variable to override the settings preference:

| Value | Mode | Description |
|-------|------|-------------|
| `0` or `bash` | bash-only | Disable Python tool, use bash only |
| `1` or `py` | ipy-only | Disable bash tool, use Python only |
| `mix` or `both` | both | Enable both bash and Python tools |

Priority: `OMP_PY` env var > settings preference > default (`ipy-only`)

### Implementation

In `tools/index.ts`:

```typescript
function getPythonModeFromEnv(): "ipy-only" | "bash-only" | "both" | null {
  const value = process.env.OMP_PY?.toLowerCase();
  if (!value) return null;
  
  switch (value) {
    case "0":
    case "bash":
      return "bash-only";
    case "1":
    case "py":
      return "ipy-only";
    case "mix":
    case "both":
      return "both";
    default:
      return null;
  }
}

export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
  // ...
  const pythonMode = getPythonModeFromEnv() ?? session.settings?.getPythonToolMode?.() ?? "ipy-only";
  // ...
}
```

### Use Cases

- `OMP_PY=0 omp` — Force bash mode for compatibility testing
- `OMP_PY=1 omp` — Force Python mode even if settings say otherwise
- `OMP_PY=mix omp` — Enable both for users who want choice

## Fallback

If kernel warmup fails (no Python, no kernel_gateway), `getPreludeDocs()` returns empty array. The template should handle this gracefully:

```markdown
{{#if categories.length}}
## Prelude helpers
...
{{else}}
## Prelude helpers

(Documentation unavailable — Python kernel failed to start)
{{/if}}
```

## Files to Modify

1. `packages/coding-agent/src/core/python-kernel.ts` — Add `introspectPrelude()` method
2. `packages/coding-agent/src/core/python-executor.ts` — Add `warmPythonEnvironment()`, `getPreludeDocs()`
3. `packages/coding-agent/src/core/tools/index.ts` — Call warmup during `createTools()`, add `OMP_PY` env override
4. `packages/coding-agent/src/core/tools/python.ts` — Pass docs context to template
5. `packages/coding-agent/src/prompts/tools/python.md` — Convert to Handlebars template
6. `packages/coding-agent/src/core/python-prelude.py` — Add category markers or rely on introspection snippet

## Testing

1. Unit test: `introspectPrelude()` returns expected structure
2. Unit test: `warmPythonEnvironment()` populates cache
3. Unit test: Template renders correctly with mock docs
4. Integration test: Full flow from startup to tool description containing extracted docs
5. Fallback test: Empty docs when Python unavailable
