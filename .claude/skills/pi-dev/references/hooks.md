# Hook Patterns & Examples

Complete patterns for pi hooks development.

## Minimal Hook

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'

export default function (pi: HookAPI) {
   pi.on('session_start', async (_event, ctx) => {
      ctx.ui.notify('Hook loaded!', 'info')
   })
}
```

## Permission Gate

Block dangerous commands with user confirmation:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'

export default function (pi: HookAPI) {
   const dangerous = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i]

   pi.on('tool_call', async (event, ctx) => {
      if (event.toolName !== 'bash') return

      const cmd = event.input.command as string
      if (dangerous.some(p => p.test(cmd))) {
         if (!ctx.hasUI) {
            return { block: true, reason: 'Dangerous (no UI)' }
         }
         const ok = await ctx.ui.confirm('Dangerous!', `Allow: ${cmd}?`)
         if (!ok) return { block: true, reason: 'Blocked by user' }
      }
   })
}
```

## Protected Paths

Block writes to sensitive paths:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'

export default function (pi: HookAPI) {
   const protectedPaths = ['.env', '.git/', 'node_modules/']

   pi.on('tool_call', async (event, ctx) => {
      if (event.toolName !== 'write' && event.toolName !== 'edit') return

      const path = event.input.path as string
      if (protectedPaths.some(p => path.includes(p))) {
         ctx.ui.notify(`Blocked: ${path}`, 'warning')
         return { block: true, reason: `Protected: ${path}` }
      }
   })
}
```

## Git Checkpoint

Stash code state at each turn, restore on branch:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'

export default function (pi: HookAPI) {
   const checkpoints = new Map<string, string>()
   let currentEntryId: string | undefined

   pi.on('tool_result', async (_event, ctx) => {
      const leaf = ctx.sessionManager.getLeafEntry()
      if (leaf) currentEntryId = leaf.id
   })

   pi.on('turn_start', async () => {
      const { stdout } = await pi.exec('git', ['stash', 'create'])
      if (stdout.trim() && currentEntryId) {
         checkpoints.set(currentEntryId, stdout.trim())
      }
   })

   pi.on('session_before_branch', async (event, ctx) => {
      const ref = checkpoints.get(event.entryId)
      if (!ref || !ctx.hasUI) return

      const ok = await ctx.ui.confirm('Restore?', 'Restore code to checkpoint?')
      if (ok) {
         await pi.exec('git', ['stash', 'apply', ref])
         ctx.ui.notify('Code restored', 'info')
      }
   })

   pi.on('agent_end', () => checkpoints.clear())
}
```

## Dirty Repo Guard

Warn before working in dirty git repo:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'

export default function (pi: HookAPI) {
   pi.on('session_start', async (_event, ctx) => {
      const { stdout, code } = await pi.exec('git', ['status', '--porcelain'])
      if (code === 0 && stdout.trim()) {
         ctx.ui.notify('Warning: Git repo has uncommitted changes', 'warning')
      }
   })
}
```

## Auto-Commit on Exit

Commit changes when exiting:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'

export default function (pi: HookAPI) {
   pi.on('session_shutdown', async (_event, ctx) => {
      const { stdout, code } = await pi.exec('git', ['status', '--porcelain'])
      if (code !== 0 || !stdout.trim()) return

      if (!ctx.hasUI) return

      const ok = await ctx.ui.confirm('Commit?', 'Commit changes before exit?')
      if (!ok) return

      const msg = await ctx.ui.input('Commit message:', 'auto-commit')
      if (!msg) return

      await pi.exec('git', ['add', '-A'])
      await pi.exec('git', ['commit', '-m', msg])
      ctx.ui.notify('Changes committed', 'info')
   })
}
```

## File Trigger

Inject context when specific files are accessed:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'

export default function (pi: HookAPI) {
   pi.on('tool_result', async (event, ctx) => {
      if (event.toolName !== 'read') return

      const path = event.input.path as string
      if (path.endsWith('package.json')) {
         pi.sendMessage({
            customType: 'file-trigger',
            content: 'Note: This is a Node.js project. Check for existing scripts in package.json before adding new tooling.',
            display: false, // Hidden in TUI but sent to LLM
         })
      }
   })
}
```

## Custom Slash Command

Register a command that extracts questions from last response:

```typescript
import { complete, type UserMessage } from '@mariozechner/pi-ai'
import type { HookAPI } from '@mariozechner/pi-coding-agent'
import { BorderedLoader } from '@mariozechner/pi-coding-agent'

const SYSTEM_PROMPT = `Extract questions from text. Format:
Q: <question>
A: 

Q: <question>
A: `

export default function (pi: HookAPI) {
   pi.registerCommand('qna', {
      description: 'Extract questions from last assistant message',
      handler: async (_args, ctx) => {
         if (!ctx.hasUI || !ctx.model) {
            ctx.ui.notify('Requires interactive mode with model', 'error')
            return
         }

         // Find last assistant message
         const branch = ctx.sessionManager.getBranch()
         let lastText: string | undefined
         for (let i = branch.length - 1; i >= 0; i--) {
            const entry = branch[i]
            if (entry.type === 'message' && entry.message.role === 'assistant') {
               lastText = entry.message.content
                  .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                  .map(c => c.text)
                  .join('\n')
               break
            }
         }

         if (!lastText) {
            ctx.ui.notify('No assistant message found', 'error')
            return
         }

         // Show loader while extracting
         const result = await ctx.ui.custom<string | null>((tui, theme, done) => {
            const loader = new BorderedLoader(tui, theme, 'Extracting questions...')
            loader.onAbort = () => done(null)

            const doExtract = async () => {
               const apiKey = await ctx.modelRegistry.getApiKey(ctx.model!)
               const response = await complete(
                  ctx.model!,
                  {
                     systemPrompt: SYSTEM_PROMPT,
                     messages: [{ role: 'user', content: [{ type: 'text', text: lastText! }], timestamp: Date.now() }],
                  },
                  { apiKey, signal: loader.signal }
               )
               return response.content
                  .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                  .map(c => c.text)
                  .join('\n')
            }

            doExtract()
               .then(done)
               .catch(() => done(null))
            return loader
         })

         if (result) {
            ctx.ui.setEditorText(result)
            ctx.ui.notify('Questions loaded into editor', 'info')
         }
      },
   })
}
```

## Custom Compaction

Replace default compaction with custom summarization:

```typescript
import { complete, getModel } from '@mariozechner/pi-ai'
import type { HookAPI } from '@mariozechner/pi-coding-agent'
import { convertToLlm, serializeConversation } from '@mariozechner/pi-coding-agent'

export default function (pi: HookAPI) {
   pi.on('session_before_compact', async (event, ctx) => {
      const { preparation, signal } = event
      const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation

      // Use different model for summarization
      const model = getModel('google', 'gemini-2.5-flash')
      if (!model) return

      const apiKey = await ctx.modelRegistry.getApiKey(model)
      if (!apiKey) return

      const allMessages = [...messagesToSummarize, ...turnPrefixMessages]
      const conversationText = serializeConversation(convertToLlm(allMessages))
      const previousContext = previousSummary ? `\nPrevious summary:\n${previousSummary}` : ''

      try {
         const response = await complete(
            model,
            {
               messages: [
                  {
                     role: 'user',
                     content: [
                        { type: 'text', text: `Summarize this conversation comprehensively:${previousContext}\n\n${conversationText}` },
                     ],
                     timestamp: Date.now(),
                  },
               ],
            },
            { apiKey, maxTokens: 8192, signal }
         )

         const summary = response.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map(c => c.text)
            .join('\n')

         if (!summary.trim()) return

         return {
            compaction: {
               summary,
               firstKeptEntryId,
               tokensBefore,
            },
         }
      } catch {
         return // Fall back to default compaction
      }
   })
}
```

## State Persistence with appendEntry

Store and restore hook state across sessions:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'

interface HookState {
   counter: number
   lastAction: string
}

const STATE_TYPE = 'my-hook-state'

export default function (pi: HookAPI) {
   let state: HookState = { counter: 0, lastAction: '' }

   // Restore state on session load
   pi.on('session_start', async (_event, ctx) => {
      const entries = ctx.sessionManager.getEntries()
      for (let i = entries.length - 1; i >= 0; i--) {
         const entry = entries[i]
         if (entry.type === 'custom' && entry.customType === STATE_TYPE) {
            state = entry.data as HookState
            break
         }
      }
      ctx.ui.notify(`State restored: counter=${state.counter}`, 'info')
   })

   // Update and persist state
   pi.on('agent_end', async () => {
      state.counter++
      state.lastAction = new Date().toISOString()
      pi.appendEntry(STATE_TYPE, state)
   })
}
```

## Custom Message Renderer

Style your hook's messages in the TUI:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'
import { Text } from '@mariozechner/pi-tui'

export default function (pi: HookAPI) {
   pi.registerMessageRenderer('my-hook', (message, options, theme) => {
      const label = message.details?.label ?? 'INFO'
      const prefix = theme.fg('accent', `[${label}] `)

      const content =
         typeof message.content === 'string' ? message.content : message.content.map(c => (c.type === 'text' ? c.text : '[image]')).join('')

      let text = prefix + theme.fg('text', content)

      if (options.expanded && message.details?.extra) {
         text += `\n${theme.fg('dim', message.details.extra)}`
      }

      return new Text(text, 0, 0)
   })

   pi.on('before_agent_start', async (event, _ctx) => {
      if (event.prompt.includes('deploy')) {
         return {
            message: {
               customType: 'my-hook',
               content: 'Deployment requested - checking prerequisites...',
               display: true,
               details: { label: 'DEPLOY', extra: 'Additional deployment context here' },
            },
         }
      }
   })
}
```

## Custom TUI Component (Game)

Full keyboard-interactive component:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'
import { isEscape, isArrowUp, isArrowDown } from '@mariozechner/pi-tui'

class MenuComponent {
   private selected = 0
   private options: string[]
   private tui: { requestRender: () => void }
   private onSelect: (choice: string | null) => void

   constructor(tui: { requestRender: () => void }, options: string[], onSelect: (choice: string | null) => void) {
      this.tui = tui
      this.options = options
      this.onSelect = onSelect
   }

   handleInput(data: string): void {
      if (isEscape(data)) {
         this.onSelect(null)
         return
      }
      if (isArrowUp(data)) {
         this.selected = Math.max(0, this.selected - 1)
         this.tui.requestRender()
      } else if (isArrowDown(data)) {
         this.selected = Math.min(this.options.length - 1, this.selected + 1)
         this.tui.requestRender()
      } else if (data === '\r' || data === '\n') {
         this.onSelect(this.options[this.selected])
      }
   }

   invalidate(): void {}

   render(width: number): string[] {
      return this.options.map((opt, i) => {
         const prefix = i === this.selected ? '> ' : '  '
         return prefix + opt
      })
   }

   dispose(): void {}
}

export default function (pi: HookAPI) {
   pi.registerCommand('menu', {
      description: 'Show custom menu',
      handler: async (_args, ctx) => {
         if (!ctx.hasUI) return

         const choice = await ctx.ui.custom<string | null>((tui, _theme, done) => {
            return new MenuComponent(tui, ['Option A', 'Option B', 'Option C'], done)
         })

         if (choice) {
            ctx.ui.notify(`Selected: ${choice}`, 'info')
         }
      },
   })
}
```

## Tool Result Modification

Transform or enrich tool outputs:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'
import { isBashToolResult } from '@mariozechner/pi-coding-agent'

export default function (pi: HookAPI) {
   pi.on('tool_result', async (event, ctx) => {
      // Add context to bash errors
      if (isBashToolResult(event) && event.isError) {
         const cmd = event.input.command as string
         const hint = cmd.includes('npm') ? "\nHint: Try running 'npm install' first." : ''

         return {
            content: [...event.content, { type: 'text', text: hint }],
            details: event.details,
            isError: true,
         }
      }
   })
}
```

## Context Modification

Filter or transform messages before LLM call:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'

export default function (pi: HookAPI) {
   pi.on('context', async (event, _ctx) => {
      // Remove verbose tool results to save tokens
      const filtered = event.messages.map(msg => {
         if (msg.role === 'toolResult') {
            const content = msg.content.filter(c => {
               if (c.type === 'text' && c.text.length > 10000) {
                  return false // Remove very large outputs
               }
               return true
            })
            return { ...msg, content }
         }
         return msg
      })

      return { messages: filtered }
   })
}
```

## Multiple Event Handlers

Hooks can subscribe to multiple events:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'

export default function (pi: HookAPI) {
   let turnCount = 0
   let toolCallCount = 0

   pi.on('agent_start', async () => {
      turnCount = 0
      toolCallCount = 0
   })

   pi.on('turn_start', async () => {
      turnCount++
   })

   pi.on('tool_call', async () => {
      toolCallCount++
   })

   pi.on('agent_end', async (_event, ctx) => {
      ctx.ui.notify(`Completed: ${turnCount} turns, ${toolCallCount} tool calls`, 'info')
   })
}
```

## Error Handling

Hook errors are logged but don't crash the agent:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'

export default function (pi: HookAPI) {
   pi.on('tool_call', async (event, ctx) => {
      try {
         // Risky operation
         const result = await someAsyncOperation(event)
         if (!result.valid) {
            return { block: true, reason: 'Validation failed' }
         }
      } catch (err) {
         // Log but don't crash
         ctx.ui.notify(`Hook error: ${err}`, 'warning')
         // Return nothing = don't block
      }
   })
}
```

## Mode-Aware Hooks

Handle print mode gracefully:

```typescript
import type { HookAPI } from '@mariozechner/pi-coding-agent'

export default function (pi: HookAPI) {
   pi.on('tool_call', async (event, ctx) => {
      if (event.toolName !== 'bash') return

      const cmd = event.input.command as string
      if (!cmd.includes('sudo')) return

      // In print mode (no UI), block dangerous commands
      if (!ctx.hasUI) {
         return { block: true, reason: 'sudo blocked in non-interactive mode' }
      }

      // In interactive mode, prompt user
      const ok = await ctx.ui.confirm('Sudo?', `Allow: ${cmd}`)
      if (!ok) return { block: true, reason: 'Blocked by user' }
   })
}
```
