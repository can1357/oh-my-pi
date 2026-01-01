# Type Definitions

Complete type definitions for pi custom tool and hook development.

## Core Imports

```typescript
// Tools
import type { CustomAgentTool, CustomToolFactory, ToolAPI } from '@mariozechner/pi-coding-agent'
import type { AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core'

// Hooks
import type { HookAPI, HookContext, HookUIContext } from '@mariozechner/pi-coding-agent'

// TUI
import { Text, Markdown, Container } from '@mariozechner/pi-tui'
import type { Theme } from '@mariozechner/pi-coding-agent'

// Schemas
import { Type } from '@sinclair/typebox'
import type { Static, TSchema } from '@sinclair/typebox'
import { StringEnum } from '@mariozechner/pi-ai'
```

---

## Custom Tool Types

### CustomToolFactory

```typescript
type CustomToolFactory = (pi: CustomToolAPI) => CustomTool | CustomTool[] | Promise<CustomTool | CustomTool[] | null>
```

### CustomToolAPI (ToolAPI)

Passed to factory, stable across sessions:

```typescript
interface CustomToolAPI {
   cwd: string
   exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>
   ui: CustomToolUIContext
   hasUI: boolean
}

interface ExecOptions {
   signal?: AbortSignal
   timeout?: number
   cwd?: string
}

interface ExecResult {
   stdout: string
   stderr: string
   code: number
   killed: boolean
}

interface CustomToolUIContext {
   select(title: string, options: string[]): Promise<string | undefined>
   confirm(title: string, message: string): Promise<boolean>
   input(title: string, placeholder?: string): Promise<string | undefined>
   notify(message: string, type?: 'info' | 'warning' | 'error'): void
   custom(component: Component & { dispose?(): void }): { close: () => void; requestRender: () => void }
}
```

### CustomTool (CustomAgentTool)

```typescript
interface CustomTool<TParams extends TSchema = TSchema, TDetails = any> {
   name: string
   label: string
   description: string // Can be getter for dynamic description
   parameters: TParams

   execute(
      toolCallId: string,
      params: Static<TParams>,
      onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
      ctx: CustomToolContext,
      signal?: AbortSignal
   ): Promise<AgentToolResult<TDetails>>

   onSession?: (event: CustomToolSessionEvent, ctx: CustomToolContext) => void | Promise<void>
   renderCall?: (args: Static<TParams>, theme: Theme) => Component
   renderResult?: (result: CustomToolResult<TDetails>, options: RenderResultOptions, theme: Theme) => Component
   dispose?: () => void
}
```

### CustomToolContext

Passed to execute and onSession:

```typescript
interface CustomToolContext {
   sessionManager: ReadonlySessionManager
   modelRegistry: ModelRegistry
   model: Model<any> | undefined
}

type ReadonlySessionManager = Pick<
   SessionManager,
   | 'getCwd'
   | 'getSessionDir'
   | 'getSessionId'
   | 'getSessionFile'
   | 'getLeafId'
   | 'getLeafEntry'
   | 'getEntry'
   | 'getLabel'
   | 'getBranch'
   | 'getHeader'
   | 'getEntries'
   | 'getTree'
>
```

### CustomToolSessionEvent

```typescript
interface CustomToolSessionEvent {
   reason: 'start' | 'switch' | 'branch' | 'new' | 'tree' | 'shutdown'
   previousSessionFile: string | undefined
}
```

### AgentToolResult

```typescript
interface AgentToolResult<T> {
   content: (TextContent | ImageContent)[]
   details: T
}

interface TextContent {
   type: 'text'
   text: string
   textSignature?: string
}

interface ImageContent {
   type: 'image'
   data: string // base64
   mimeType: string // 'image/png', 'image/jpeg', etc.
}

type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void
```

### RenderResultOptions

```typescript
interface RenderResultOptions {
   expanded: boolean // User toggled with Ctrl+O
   isPartial: boolean // True during streaming (onUpdate calls)
}

type CustomToolResult<TDetails = any> = AgentToolResult<TDetails>
```

---

## Hook Types

### HookFactory

```typescript
type HookFactory = (pi: HookAPI) => void
```

### HookAPI

```typescript
interface HookAPI {
   // Session events
   on(event: 'session_start', handler: HookHandler<SessionStartEvent>): void
   on(event: 'session_before_switch', handler: HookHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>): void
   on(event: 'session_switch', handler: HookHandler<SessionSwitchEvent>): void
   on(event: 'session_before_new', handler: HookHandler<SessionBeforeNewEvent, SessionBeforeNewResult>): void
   on(event: 'session_new', handler: HookHandler<SessionNewEvent>): void
   on(event: 'session_before_branch', handler: HookHandler<SessionBeforeBranchEvent, SessionBeforeBranchResult>): void
   on(event: 'session_branch', handler: HookHandler<SessionBranchEvent>): void
   on(event: 'session_before_compact', handler: HookHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>): void
   on(event: 'session_compact', handler: HookHandler<SessionCompactEvent>): void
   on(event: 'session_shutdown', handler: HookHandler<SessionShutdownEvent>): void
   on(event: 'session_before_tree', handler: HookHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void
   on(event: 'session_tree', handler: HookHandler<SessionTreeEvent>): void

   // Context and agent events
   on(event: 'context', handler: HookHandler<ContextEvent, ContextEventResult>): void
   on(event: 'before_agent_start', handler: HookHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void
   on(event: 'agent_start', handler: HookHandler<AgentStartEvent>): void
   on(event: 'agent_end', handler: HookHandler<AgentEndEvent>): void
   on(event: 'turn_start', handler: HookHandler<TurnStartEvent>): void
   on(event: 'turn_end', handler: HookHandler<TurnEndEvent>): void
   on(event: 'tool_call', handler: HookHandler<ToolCallEvent, ToolCallEventResult>): void
   on(event: 'tool_result', handler: HookHandler<ToolResultEvent, ToolResultEventResult>): void

   sendMessage<T = unknown>(message: HookMessage<T>, triggerTurn?: boolean): void
   appendEntry<T = unknown>(customType: string, data?: T): void
   registerMessageRenderer<T = unknown>(customType: string, renderer: HookMessageRenderer<T>): void
   registerCommand(name: string, options: { description?: string; handler: RegisteredCommand['handler'] }): void
   exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>
}

type HookHandler<E, R = undefined> = (event: E, ctx: HookContext) => Promise<R | void> | R | void
```

### HookContext

```typescript
interface HookContext {
   ui: HookUIContext
   hasUI: boolean
   cwd: string
   sessionManager: ReadonlySessionManager
   modelRegistry: ModelRegistry
   model: Model<any> | undefined
}
```

### HookUIContext

```typescript
interface HookUIContext {
   select(title: string, options: string[]): Promise<string | undefined>
   confirm(title: string, message: string): Promise<boolean>
   input(title: string, placeholder?: string): Promise<string | undefined>
   notify(message: string, type?: 'info' | 'warning' | 'error'): void
   custom<T>(factory: (tui: TUI, theme: Theme, done: (result: T) => void) => Component): Promise<T>
   setEditorText(text: string): void
   getEditorText(): string
}
```

### HookMessage

```typescript
interface HookMessage<T = unknown> {
   customType: string
   content: string | (TextContent | ImageContent)[]
   display: boolean
   details?: T
}
```

### RegisteredCommand

```typescript
interface RegisteredCommand {
   name: string
   description?: string
   handler: (args: string, ctx: HookContext) => Promise<void>
}
```

### HookMessageRenderer

```typescript
type HookMessageRenderer<T = unknown> = (message: HookMessage<T>, options: { expanded: boolean }, theme: Theme) => Component | undefined
```

---

## Event Types

### Session Events

```typescript
interface SessionStartEvent {
   type: 'session_start'
}

interface SessionBeforeSwitchEvent {
   type: 'session_before_switch'
   targetSessionFile: string
}
interface SessionBeforeSwitchResult {
   cancel?: boolean
}

interface SessionSwitchEvent {
   type: 'session_switch'
   previousSessionFile: string | undefined
}

interface SessionBeforeNewEvent {
   type: 'session_before_new'
}
interface SessionBeforeNewResult {
   cancel?: boolean
}

interface SessionNewEvent {
   type: 'session_new'
}

interface SessionBeforeBranchEvent {
   type: 'session_before_branch'
   entryId: string
}
interface SessionBeforeBranchResult {
   cancel?: boolean
   skipConversationRestore?: boolean
}

interface SessionBranchEvent {
   type: 'session_branch'
   previousSessionFile: string | undefined
}

interface SessionBeforeCompactEvent {
   type: 'session_before_compact'
   preparation: CompactionPreparation
   branchEntries: SessionEntry[]
   customInstructions?: string
   signal: AbortSignal
}
interface SessionBeforeCompactResult {
   cancel?: boolean
   compaction?: CompactionResult
}

interface SessionCompactEvent {
   type: 'session_compact'
   compactionEntry: CompactionEntry
   fromHook: boolean
}

interface SessionShutdownEvent {
   type: 'session_shutdown'
}

interface SessionBeforeTreeEvent {
   type: 'session_before_tree'
   preparation: TreePreparation
   signal: AbortSignal
}
interface SessionBeforeTreeResult {
   cancel?: boolean
   summary?: { summary: string; details?: unknown }
}

interface SessionTreeEvent {
   type: 'session_tree'
   newLeafId: string | null
   oldLeafId: string | null
   summaryEntry?: BranchSummaryEntry
   fromHook?: boolean
}
```

### Agent Events

```typescript
interface BeforeAgentStartEvent {
   type: 'before_agent_start'
   prompt: string
   images?: ImageContent[]
}
interface BeforeAgentStartEventResult {
   message?: Pick<HookMessage, 'customType' | 'content' | 'display' | 'details'>
}

interface AgentStartEvent {
   type: 'agent_start'
}

interface AgentEndEvent {
   type: 'agent_end'
   messages: AgentMessage[]
}

interface TurnStartEvent {
   type: 'turn_start'
   turnIndex: number
   timestamp: number
}

interface TurnEndEvent {
   type: 'turn_end'
   turnIndex: number
   message: AgentMessage
   toolResults: ToolResultMessage[]
}

interface ContextEvent {
   type: 'context'
   messages: AgentMessage[]
}
interface ContextEventResult {
   messages?: Message[]
}
```

### Tool Events

```typescript
interface ToolCallEvent {
   type: "tool_call"
   toolName: string
   toolCallId: string
   input: Record<string, unknown>
}
interface ToolCallEventResult {
   block?: boolean
   reason?: string
}

// Base tool result
interface ToolResultEventBase {
   type: "tool_result"
   toolCallId: string
   input: Record<string, unknown>
   content: (TextContent | ImageContent)[]
   isError: boolean
}

// Typed variants
interface BashToolResultEvent extends ToolResultEventBase {
   toolName: "bash"
   details: BashToolDetails | undefined
}
interface ReadToolResultEvent extends ToolResultEventBase {
   toolName: "read"
   details: ReadToolDetails | undefined
}
interface EditToolResultEvent extends ToolResultEventBase {
   toolName: "edit"
   details: EditToolDetails | undefined
}
// ... etc for write, grep, find, ls

interface CustomToolResultEvent extends ToolResultEventBase {
   toolName: string
   details: unknown
}

type ToolResultEvent = BashToolResultEvent | ReadToolResultEvent | EditToolResultEvent | ...

interface ToolResultEventResult {
   content?: (TextContent | ImageContent)[]
   details?: unknown
   isError?: boolean
}

// Type guards
function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent
function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent
function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent
function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent
function isGrepToolResult(e: ToolResultEvent): e is GrepToolResultEvent
function isFindToolResult(e: ToolResultEvent): e is FindToolResultEvent
function isLsToolResult(e: ToolResultEvent): e is LsToolResultEvent
```

---

## TUI Types

### Component Interface

```typescript
interface Component {
   render(width: number): string[]
   handleInput?(data: string): void
   invalidate(): void
   dispose?(): void
}
```

### Text Component

```typescript
class Text implements Component {
   constructor(text: string = '', paddingX: number = 0, paddingY: number = 0, customBgFn?: (text: string) => string)
   setText(text: string): void
   invalidate(): void
   render(width: number): string[]
}
```

### Theme Class

```typescript
class Theme {
   fg(color: ThemeColor, text: string): string
   bg(color: ThemeBg, text: string): string
   bold(text: string): string
   italic(text: string): string
   underline(text: string): string
   inverse(text: string): string
   getFgAnsi(color: ThemeColor): string
   getBgAnsi(color: ThemeBg): string
}
```

### ThemeColor Values (37 colors)

```typescript
type ThemeColor =
   // UI colors
   | 'accent'
   | 'border'
   | 'borderAccent'
   | 'borderMuted'
   | 'success'
   | 'error'
   | 'warning'
   | 'muted'
   | 'dim'
   | 'text'
   // Message colors
   | 'thinkingText'
   | 'userMessageText'
   | 'customMessageText'
   | 'customMessageLabel'
   // Tool colors
   | 'toolTitle'
   | 'toolOutput'
   // Markdown colors
   | 'mdHeading'
   | 'mdLink'
   | 'mdLinkUrl'
   | 'mdCode'
   | 'mdCodeBlock'
   | 'mdCodeBlockBorder'
   | 'mdQuote'
   | 'mdQuoteBorder'
   | 'mdHr'
   | 'mdListBullet'
   // Diff colors
   | 'toolDiffAdded'
   | 'toolDiffRemoved'
   | 'toolDiffContext'
   // Syntax highlighting
   | 'syntaxComment'
   | 'syntaxKeyword'
   | 'syntaxFunction'
   | 'syntaxVariable'
   | 'syntaxString'
   | 'syntaxNumber'
   | 'syntaxType'
   | 'syntaxOperator'
   | 'syntaxPunctuation'
   // Thinking level indicators
   | 'thinkingOff'
   | 'thinkingMinimal'
   | 'thinkingLow'
   | 'thinkingMedium'
   | 'thinkingHigh'
   | 'thinkingXhigh'
   | 'bashMode'
```

### ThemeBg Values (6 backgrounds)

```typescript
type ThemeBg = 'selectedBg' | 'userMessageBg' | 'customMessageBg' | 'toolPendingBg' | 'toolSuccessBg' | 'toolErrorBg'
```

---

## TypeBox Schema Patterns

```typescript
// Simple parameters
const Params = Type.Object({
   query: Type.String({ description: 'Search query' }),
   limit: Type.Optional(Type.Number({ description: 'Max results', default: 10 })),
})

// String enums (required for Anthropic/Google API compatibility)
import { StringEnum } from '@mariozechner/pi-ai'
const ActionParam = StringEnum(['create', 'read', 'update', 'delete'] as const, {
   description: 'Action to perform',
   default: 'read',
})

// Union types for literals
const Recency = Type.Optional(Type.Union([Type.Literal('day'), Type.Literal('week'), Type.Literal('month')]))

// Nested objects
const Option = Type.Object({ label: Type.String(), value: Type.String() })
const Params = Type.Object({
   options: Type.Array(Option, { minItems: 1 }),
   multi: Type.Optional(Type.Boolean({ default: false })),
})

// Arrays with constraints
Type.Array(Type.String(), { minItems: 1, maxItems: 10, description: 'File paths' })
```

---

## Utility Imports

```typescript
// Keyboard detection (for custom components)
import { isEscape, isArrowUp, isArrowDown, isArrowLeft, isArrowRight, visibleWidth } from '@mariozechner/pi-tui'

// AI completion (for hooks calling LLMs)
import { complete, getModel } from '@mariozechner/pi-ai'

// Loader component (for async commands)
import { BorderedLoader } from '@mariozechner/pi-coding-agent'

// Conversation serialization (for custom compaction)
import { convertToLlm, serializeConversation } from '@mariozechner/pi-coding-agent'
```
