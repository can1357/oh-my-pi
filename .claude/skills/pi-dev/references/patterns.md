# Code Patterns

Real-world patterns from pi-mono and oh-my-pi plugins.

## Minimal Tool

```typescript
import type { CustomToolFactory } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'

const factory: CustomToolFactory = _pi => ({
   name: 'hello',
   label: 'Hello',
   description: 'Greet someone by name',
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

## Tool with UI Interaction

```typescript
import type { CustomTool, CustomToolFactory } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'

const QuestionParams = Type.Object({
   question: Type.String({ description: 'Question to ask' }),
   options: Type.Array(Type.String(), { minItems: 2, description: 'Options to choose from' }),
})

interface QuestionDetails {
   answer: string | null
}

const factory: CustomToolFactory = pi => {
   const tool: CustomTool<typeof QuestionParams, QuestionDetails> = {
      name: 'question',
      label: 'Question',
      description: 'Ask the user a question with multiple choice options',
      parameters: QuestionParams,

      async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
         if (!pi.hasUI) {
            return {
               content: [{ type: 'text', text: 'Error: Interactive mode required' }],
               details: { answer: null },
            }
         }

         const answer = await pi.ui.select(params.question, params.options)
         if (!answer) {
            return {
               content: [{ type: 'text', text: 'User cancelled' }],
               details: { answer: null },
            }
         }

         return {
            content: [{ type: 'text', text: `User selected: ${answer}` }],
            details: { answer },
         }
      },

      renderCall(args, theme) {
         let text = theme.fg('toolTitle', '? ') + theme.fg('accent', args.question)
         for (const opt of args.options ?? []) {
            text += `\n${theme.fg('dim', '  ○ ')}${theme.fg('muted', opt)}`
         }
         return new Text(text, 0, 0)
      },

      renderResult(result, _opts, theme) {
         const { details } = result
         if (details?.answer) {
            return new Text(theme.fg('success', '✓ ') + theme.fg('accent', details.answer), 0, 0)
         }
         return new Text(theme.fg('warning', 'Cancelled'), 0, 0)
      },
   }

   return tool
}

export default factory
```

## Tool with State Management

```typescript
import type { CustomToolFactory, CustomToolSessionEvent, CustomToolContext } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'
import { StringEnum } from '@mariozechner/pi-ai'

interface Todo {
   id: number
   text: string
   done: boolean
}

interface TodoDetails {
   todos: Todo[]
   nextId: number
   error?: string
}

const TodoParams = Type.Object({
   action: StringEnum(['add', 'toggle', 'remove', 'list'] as const),
   text: Type.Optional(Type.String({ description: 'Todo text for add action' })),
   id: Type.Optional(Type.Number({ description: 'Todo ID for toggle/remove' })),
})

const factory: CustomToolFactory = _pi => {
   let todos: Todo[] = []
   let nextId = 1

   const reconstructState = (_event: CustomToolSessionEvent, ctx: CustomToolContext) => {
      todos = []
      nextId = 1

      for (const entry of ctx.sessionManager.getBranch()) {
         if (entry.type !== 'message') continue
         if (entry.message.role !== 'toolResult') continue
         if (entry.message.toolName !== 'todo') continue

         const details = entry.message.details as TodoDetails | undefined
         if (details) {
            todos = details.todos
            nextId = details.nextId
         }
      }
   }

   return {
      name: 'todo',
      label: 'Todo',
      description: 'Manage a todo list (add, toggle, remove, list)',
      parameters: TodoParams,

      onSession: reconstructState,

      async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
         const { action, text, id } = params

         switch (action) {
            case 'add':
               if (!text)
                  return { content: [{ type: 'text', text: 'Error: text required' }], details: { todos, nextId, error: 'text required' } }
               todos.push({ id: nextId++, text, done: false })
               break
            case 'toggle':
               const todo = todos.find(t => t.id === id)
               if (todo) todo.done = !todo.done
               break
            case 'remove':
               todos = todos.filter(t => t.id !== id)
               break
         }

         const summary = todos.map(t => `${t.done ? '✓' : '○'} #${t.id}: ${t.text}`).join('\n') || 'No todos'
         return {
            content: [{ type: 'text', text: summary }],
            details: { todos: [...todos], nextId },
         }
      },

      renderResult(result, { expanded }, theme) {
         const { details } = result
         if (details?.error) return new Text(theme.fg('error', `Error: ${details.error}`), 0, 0)

         const count = details?.todos?.length ?? 0
         const doneCount = details?.todos?.filter(t => t.done).length ?? 0
         let text = theme.fg('toolTitle', 'Todos') + theme.fg('dim', ` (${doneCount}/${count} done)`)

         if (expanded && details?.todos) {
            for (const t of details.todos) {
               const check = t.done ? theme.fg('success', '✓') : theme.fg('dim', '○')
               text += `\n${check} ${theme.fg('accent', `#${t.id}`)} ${t.done ? theme.fg('dim', t.text) : t.text}`
            }
         }

         return new Text(text, 0, 0)
      },
   }
}

export default factory
```

## Tool with Streaming Progress

```typescript
import type { CustomToolFactory } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'

interface ProgressDetails {
   current: number
   total: number
   items: string[]
}

const factory: CustomToolFactory = _pi => ({
   name: 'process',
   label: 'Process',
   description: 'Process items with progress updates',
   parameters: Type.Object({
      items: Type.Array(Type.String(), { description: 'Items to process' }),
   }),

   async execute(_toolCallId, params, onUpdate, _ctx, signal) {
      const results: string[] = []
      const total = params.items.length

      for (let i = 0; i < total; i++) {
         if (signal?.aborted) {
            return {
               content: [{ type: 'text', text: `Aborted after ${i}/${total}` }],
               details: { current: i, total, items: results },
            }
         }

         // Simulate work
         await new Promise(r => setTimeout(r, 500))
         results.push(`Processed: ${params.items[i]}`)

         // Emit streaming update
         onUpdate?.({
            content: [{ type: 'text', text: `Processing ${i + 1}/${total}...` }],
            details: { current: i + 1, total, items: [...results] },
         })
      }

      return {
         content: [{ type: 'text', text: results.join('\n') }],
         details: { current: total, total, items: results },
      }
   },

   renderResult(result, { expanded, isPartial }, theme) {
      const { details } = result
      const icon = isPartial ? theme.fg('warning', '◐') : theme.fg('success', '●')
      const status = isPartial ? 'Processing...' : 'Complete'
      const hint = expanded || isPartial ? '' : theme.fg('dim', ' (Ctrl+O to expand)')

      let text = `${icon} ${theme.fg('toolTitle', status)} ${theme.fg('dim', `${details?.current ?? 0}/${details?.total ?? 0}`)}${hint}`

      if (expanded && details?.items) {
         for (const item of details.items) {
            text += `\n${theme.fg('dim', '└─')} ${theme.fg('muted', item)}`
         }
      }

      return new Text(text, 0, 0)
   },
})

export default factory
```

## Tree Rendering with Proper Connections

```typescript
renderResult(result, { expanded }, theme) {
   const TREE_MID = '├─'
   const TREE_END = '└─'
   const TREE_PIPE = '│'
   const TREE_HOOK = '⎿'

   const items = result.details?.items ?? []
   const icon = items.length ? theme.fg('success', '●') : theme.fg('warning', '●')
   const hint = expanded ? '' : theme.fg('dim', ' (Ctrl+O to expand)')

   let text = `${icon} ${theme.fg('toolTitle', 'Results')} ${theme.fg('dim', `${items.length} items`)}${hint}`

   const display = expanded ? items : items.slice(0, 3)
   for (let i = 0; i < display.length; i++) {
      const isLast = i === display.length - 1 && (expanded || items.length <= 3)
      const branch = isLast ? TREE_END : TREE_MID
      const cont = isLast ? '   ' : `${TREE_PIPE}  `

      text += `\n ${theme.fg('dim', branch)} ${theme.fg('accent', display[i].title)}`
      text += `\n ${theme.fg('dim', cont)}${TREE_HOOK} ${theme.fg('link', display[i].url)}`
   }

   if (!expanded && items.length > 3) {
      text += `\n ${theme.fg('dim', TREE_END)} ${theme.fg('muted', `… ${items.length - 3} more`)}`
   }

   return new Text(text, 0, 0)
}
```

## Grouped Results (References Pattern)

```typescript
renderResult(result, { expanded }, theme) {
   const TREE_MID = '├─', TREE_END = '└─', TREE_PIPE = '│'
   const { details } = result

   // Group by file: { file: [[line, col], ...] }
   const byFile = new Map<string, Array<[string, string]>>()
   for (const ref of details?.refs ?? []) {
      const [file, line, col] = ref.split(':')
      if (!byFile.has(file)) byFile.set(file, [])
      byFile.get(file)!.push([line, col])
   }

   const files = Array.from(byFile.keys())
   const icon = theme.fg('success', '●')
   let text = `${icon} ${theme.fg('toolTitle', 'References')} ${theme.fg('dim', `${details?.refs?.length ?? 0} found`)}`

   const maxFiles = expanded ? files.length : 4
   for (let fi = 0; fi < Math.min(files.length, maxFiles); fi++) {
      const file = files[fi]
      const locs = byFile.get(file)!
      const isLastFile = fi === Math.min(files.length, maxFiles) - 1 && files.length <= maxFiles
      const fileBranch = isLastFile ? TREE_END : TREE_MID
      const fileCont = isLastFile ? '   ' : `${TREE_PIPE}  `

      if (locs.length === 1) {
         text += `\n ${theme.fg('dim', fileBranch)} ${theme.fg('accent', file)}:${theme.fg('muted', `${locs[0][0]}:${locs[0][1]}`)}`
      } else {
         text += `\n ${theme.fg('dim', fileBranch)} ${theme.fg('accent', file)}`
         const maxLocs = expanded ? 30 : 10
         const locsText = locs.slice(0, maxLocs).map(([l, c]) => `${l}:${c}`).join(', ')
         text += `\n ${theme.fg('dim', fileCont)}${theme.fg('dim', TREE_END)} ${theme.fg('muted', locsText)}`
         if (locs.length > maxLocs) {
            text += theme.fg('dim', ` … +${locs.length - maxLocs} more`)
         }
      }
   }

   if (files.length > maxFiles) {
      text += `\n ${theme.fg('dim', TREE_END)} ${theme.fg('muted', `… ${files.length - maxFiles} more files`)}`
   }

   return new Text(text, 0, 0)
}
```

## Multi-Tool Factory

```typescript
import type { CustomToolFactory } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'

const factory: CustomToolFactory = pi => {
   const searchTool = {
      name: 'search',
      label: 'Search',
      description: 'Search for items',
      parameters: Type.Object({ query: Type.String() }),
      async execute(_id, params, _onUpdate, _ctx, _signal) {
         return { content: [{ type: 'text', text: `Results for: ${params.query}` }], details: {} }
      },
   }

   const fetchTool = {
      name: 'fetch',
      label: 'Fetch',
      description: 'Fetch a URL',
      parameters: Type.Object({ url: Type.String() }),
      async execute(_id, params, _onUpdate, _ctx, _signal) {
         return { content: [{ type: 'text', text: `Fetched: ${params.url}` }], details: {} }
      },
   }

   return [searchTool, fetchTool]
}

export default factory
```

## Dispose Pattern (Cleanup)

```typescript
const factory: CustomToolFactory = pi => {
   const clients = new Map<string, Client>()

   return {
      name: 'client_tool',
      // ...
      async execute(_id, params, _onUpdate, _ctx, _signal) {
         const client = clients.get(params.key) ?? createClient(params.key)
         clients.set(params.key, client)
         // use client...
      },

      dispose() {
         for (const client of clients.values()) {
            client.close()
         }
         clients.clear()
      },
   }
}
```

## Dynamic Description

```typescript
const factory: CustomToolFactory = pi => {
   const config = loadConfig(pi.cwd)

   return {
      name: 'configured_tool',
      label: 'Configured Tool',
      get description() {
         const features = config.enabledFeatures.join(', ')
         return `Tool with features: ${features}. Use for X, Y, Z.`
      },
      // ...
   }
}
```

## AbortSignal with Subprocess

```typescript
async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
   const proc = spawn('long-running-command', [params.arg])
   let wasAborted = false

   if (signal) {
      const onAbort = () => {
         wasAborted = true
         proc.kill('SIGTERM')
      }
      if (signal.aborted) {
         onAbort()
      } else {
         signal.addEventListener('abort', onAbort, { once: true })
      }
   }

   return new Promise((resolve) => {
      let output = ''
      proc.stdout.on('data', data => { output += data })
      proc.on('close', (code) => {
         signal?.removeEventListener('abort', onAbort)
         resolve({
            content: [{ type: 'text', text: wasAborted ? 'Aborted' : output }],
            details: { code, aborted: wasAborted },
         })
      })
   })
}
```
