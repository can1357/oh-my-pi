---
name: pi-dev
description: Develop custom tools and hooks for pi using oh-my-pi (omp) as the plugin manager. Use when creating, modifying, or debugging pi/omp custom tools or hooks. Covers CustomToolFactory patterns, execute signatures, streaming updates, renderCall/renderResult rendering, Theme usage, state management via onSession, UI interactions, HookAPI event subscriptions, slash commands, session persistence, and omp manifest structure.
---

# pi Extension Development

Create custom tools and hooks for pi using oh-my-pi (omp) as the plugin manager.

## Extension Types

| Type             | Purpose                                                   | Location                             |
| ---------------- | --------------------------------------------------------- | ------------------------------------ |
| **Custom Tools** | Add new agent capabilities                                | `~/.pi/agent/tools/` or omp plugin   |
| **Hooks**        | Intercept lifecycle events, prompt users, modify behavior | `~/.pi/agent/hooks/` or `.pi/hooks/` |

Both are TypeScript modules loaded via jiti (no build step needed).

---

## Custom Tools Quick Start

```typescript
import type { CustomToolFactory } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'

const factory: CustomToolFactory = pi => ({
   name: 'hello',
   label: 'Hello',
   description: 'A simple greeting tool',
   parameters: Type.Object({
      name: Type.String({ description: 'Name to greet' }),
   }),
   async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
      return {
         content: [{ type: 'text', text: `Hello, ${params.name}!` }],
         details: { greeted: params.name },
      }
   },
})

export default factory
```

**Factory Pattern**: Tools export a default `CustomToolFactory` function that receives `ToolAPI` and returns tool(s).

**Return Types**:

- Single tool: `CustomAgentTool`
- Multiple tools: `CustomAgentTool[]`
- Async setup: `Promise<CustomAgentTool | CustomAgentTool[] | null>`
- Return `null` when unavailable (missing API key, etc.)

---

## Hooks Quick Start

Create `~/.pi/agent/hooks/my-hook.ts`:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'

export default function (pi: HookAPI) {
   pi.on('session_start', async (_event, ctx) => {
      ctx.ui.notify('Hook loaded!', 'info')
   })

   pi.on('tool_call', async (event, ctx) => {
      if (event.toolName === 'bash' && event.input.command?.includes('rm -rf')) {
         const ok = await ctx.ui.confirm('Dangerous!', 'Allow rm -rf?')
         if (!ok) return { block: true, reason: 'Blocked by user' }
      }
   })
}
```

Test with `--hook` flag:

```bash
pi --hook ./my-hook.ts
```

**Hook Locations**:

- `~/.pi/agent/hooks/*.ts` — Global (all projects)
- `.pi/hooks/*.ts` — Project-local
- `settings.json` `"hooks": ["/path/to/hook.ts"]` — Explicit paths

---

## Hook Events

### Lifecycle Overview

```
pi starts → session_start
user prompt → before_agent_start → agent_start
   ┌─── turn loop ───┐
   │ turn_start      │
   │ context         │  ← modify messages before LLM
   │ tool_call       │  ← block tools
   │ tool_result     │  ← modify results
   │ turn_end        │
   └─────────────────┘
agent_end

Session operations:
  /new    → session_before_new → session_new
  /resume → session_before_switch → session_switch
  /branch → session_before_branch → session_branch
  /compact → session_before_compact → session_compact
  /tree   → session_before_tree → session_tree
  exit    → session_shutdown
```

### Key Events

| Event                    | Can Return                      | Purpose                     |
| ------------------------ | ------------------------------- | --------------------------- |
| `session_start`          | —                               | Initial load, restore state |
| `tool_call`              | `{ block, reason }`             | Gate tool execution         |
| `tool_result`            | `{ content, details, isError }` | Modify tool output          |
| `context`                | `{ messages }`                  | Transform LLM context       |
| `before_agent_start`     | `{ message }`                   | Inject persistent message   |
| `session_before_*`       | `{ cancel }`                    | Cancel session operations   |
| `session_before_compact` | `{ cancel, compaction }`        | Custom summarization        |

---

## HookContext

Every handler receives `ctx: HookContext`:

```typescript
interface HookContext {
   ui: HookUIContext // UI methods (select, confirm, input, notify, custom)
   hasUI: boolean // false in print/RPC mode
   cwd: string // Working directory
   sessionManager: ReadonlySessionManager // Read session state
   modelRegistry: ModelRegistry // Get API keys, models
   model: Model | undefined // Current model
}
```

### UI Methods

```typescript
// Built-in dialogs
const choice = await ctx.ui.select('Pick:', ['A', 'B', 'C'])
const ok = await ctx.ui.confirm('Delete?', 'Cannot undo')
const name = await ctx.ui.input('Name:', 'placeholder')
ctx.ui.notify('Done!', 'info') // "info" | "warning" | "error"

// Editor control
ctx.ui.setEditorText('Pre-fill prompt...')
const current = ctx.ui.getEditorText()

// Custom TUI component
const result = await ctx.ui.custom((tui, theme, done) => {
   const component = new MyComponent(tui, theme)
   component.onFinish = value => done(value)
   return component
})
```

---

## HookAPI Methods

| Method                                 | Purpose                              |
| -------------------------------------- | ------------------------------------ |
| `pi.on(event, handler)`                | Subscribe to events                  |
| `pi.sendMessage(msg, triggerTurn?)`    | Inject message into LLM context      |
| `pi.appendEntry(type, data)`           | Persist hook state (not sent to LLM) |
| `pi.registerCommand(name, opts)`       | Register `/slash` command            |
| `pi.registerMessageRenderer(type, fn)` | Custom TUI for messages              |
| `pi.exec(cmd, args, opts)`             | Execute shell command                |

### Slash Commands

```typescript
pi.registerCommand('stats', {
   description: 'Show session statistics',
   handler: async (args, ctx) => {
      const count = ctx.sessionManager.getEntries().length
      ctx.ui.notify(`${count} entries`, 'info')
   },
})
```

### Session Persistence

```typescript
// Save state (survives restart)
pi.appendEntry('my-hook-state', { count: 42 })

// Restore on reload
pi.on('session_start', async (_event, ctx) => {
   for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === 'custom' && entry.customType === 'my-hook-state') {
         myState = entry.data
      }
   }
})
```

### Injecting Messages

```typescript
// Message visible to LLM and optionally in TUI
pi.sendMessage({
   customType: "my-hook",
   content: "Context for LLM",
   display: true,  // Show in TUI
   details: { ... },  // Metadata (not sent to LLM)
}, triggerTurn);  // If true, triggers LLM response
```

---

## Tool Execute Signature

```typescript
execute(
   toolCallId: string,           // Unique ID for this invocation
   params: Static<TParams>,      // Parsed parameters (TypeBox schema)
   onUpdate: AgentToolUpdateCallback<TDetails> | undefined,  // Streaming UI updates
   ctx: CustomToolContext,       // Session/model access
   signal?: AbortSignal,         // Cancellation support (ESC key)
): Promise<AgentToolResult<TDetails>>
```

**Return structure**:

```typescript
{
   content: [{ type: 'text', text: '...' }],  // Sent to LLM
   details: { ... },                           // For UI only (renderResult)
}
```

---

## Streaming Updates (Tools)

```typescript
async execute(_id, params, onUpdate, _ctx, signal) {
   for (let i = 0; i <= 100; i += 10) {
      if (signal?.aborted) return { content: [{ type: 'text', text: 'Aborted' }], details: null }
      onUpdate?.({
         content: [{ type: 'text', text: `Progress: ${i}%` }],
         details: { progress: i },
      })
      await new Promise(r => setTimeout(r, 100))
   }
   return { content: [{ type: 'text', text: 'Done' }], details: { progress: 100 } }
}
```

---

## Custom Rendering (Tools)

```typescript
import { Text } from '@mariozechner/pi-tui'

renderCall(args, theme) {
   return new Text(theme.fg('toolTitle', theme.bold('mytool ')) + theme.fg('accent', args.query), 0, 0)
},

renderResult(result, { expanded, isPartial }, theme) {
   const icon = isPartial ? theme.fg('warning', '◐') : theme.fg('success', '●')
   const hint = expanded ? '' : theme.fg('dim', ' (Ctrl+O to expand)')
   let text = `${icon} ${theme.fg('toolTitle', 'Result')}${hint}`
   if (expanded) { /* full output */ }
   return new Text(text, 0, 0)
}
```

---

## Theme Colors

| Category | Keys                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------ |
| Status   | `success`, `error`, `warning`, `accent`                                                          |
| Text     | `text`, `muted`, `dim`, `toolTitle`, `toolOutput`                                                |
| Links    | `link`, `mdLink`, `mdLinkUrl`                                                                    |
| Diff     | `toolDiffAdded`, `toolDiffRemoved`, `toolDiffContext`                                            |
| Syntax   | `syntaxKeyword`, `syntaxString`, `syntaxNumber`, `syntaxFunction`, `syntaxType`, `syntaxComment` |

---

## State Management (Tools)

```typescript
const factory: CustomToolFactory = (_pi) => {
   let items: Item[] = []

   return {
      name: 'my_tool',
      onSession(_event, ctx) {
         items = []
         for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type !== 'message') continue
            if (entry.message.role !== 'toolResult') continue
            if (entry.message.toolName !== 'my_tool') continue
            items = (entry.message.details as { items: Item[] })?.items ?? []
         }
      },
      async execute(_id, params, _onUpdate, _ctx, _signal) {
         items.push({ ...params })
         return { content: [...], details: { items: [...items] } }
      },
   }
}
```

---

## Plugin package.json (omp)

```json
{
   "name": "@oh-my-pi/my-plugin",
   "omp": {
      "tools": "tools",
      "hooks": "hooks",
      "runtime": "tools/runtime.json",
      "variables": {
         "apiKey": { "type": "string", "env": "MY_API_KEY", "required": true }
      },
      "features": {
         "basic": { "description": "Core functionality", "default": true }
      },
      "install": [{ "src": "agents/my-agent.md", "dest": "agent/agents/my-agent.md" }]
   },
   "files": ["tools", "hooks", "agents"],
   "dependencies": {
      "cli-highlight": "^2.1.11"
   }
}
```

**Important**:

- `tools` and `hooks` fields load TypeScript factories via the omp loader (from node_modules)
- `install` is ONLY for static files (agents, commands, themes) — NOT for tools or hooks
- omp plugins support npm dependencies!

---

## Scaffolding

Use `omp create` to scaffold a new plugin:

```bash
omp create my-plugin
omp create @my-scope/my-plugin  # scoped
```

This creates a directory with `package.json`, example agent, example tool, and standard structure.

---

## References

- **Type definitions**: See [references/types.md](references/types.md)
- **Code patterns**: See [references/patterns.md](references/patterns.md)
- **Hook patterns**: See [references/hooks.md](references/hooks.md)
- **OMP manifest**: See [references/omp-manifest.md](references/omp-manifest.md)
