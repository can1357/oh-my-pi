# @oh-my-pi/pi-agent-core

Stateful agent with tool execution and event streaming. Built on `@oh-my-pi/pi-ai`.

## Installation

```bash
npm install @oh-my-pi/pi-agent-core
```

## Quick Start

```typescript
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getModel } from "@oh-my-pi/pi-ai";

const agent = new Agent({
	initialState: {
		systemPrompt: ["You are a helpful assistant."],
		model: getModel("anthropic", "claude-sonnet-4-20250514"),
	},
});

agent.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		// Stream just the new text chunk
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await agent.prompt("Hello!");
```

## Core Concepts

### AgentMessage vs LLM Message

The agent works with `AgentMessage`, a flexible type that can include:

- Standard LLM messages (`user`, `assistant`, `toolResult`)
- Custom app-specific message types via declaration merging

LLMs only understand `user`, `assistant`, and `toolResult`. The `convertToLlm` function bridges this gap by filtering and transforming messages before each LLM call.

### Message Flow

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
                    (optional)                           (required)
```

1. **transformContext**: Prune old messages, inject external context
2. **convertToLlm**: Filter out UI-only messages, convert custom types to LLM format

## Event Flow

The agent emits events for UI updates. Understanding the event sequence helps build responsive interfaces.

### prompt() Event Sequence

When you call `prompt("Hello")`:

```
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // Your prompt
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM starts responding
├─ message_update  { message: partial... }       // Streaming chunks
├─ message_update  { message: partial... }
├─ message_end     { message: assistantMessage } // Complete response
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```

### With Tool Calls

If the assistant calls tools, the loop continues:

```
prompt("Read config.json")
├─ agent_start
├─ turn_start
├─ message_start/end  { userMessage }
├─ message_start      { assistantMessage with toolCall }
├─ message_update...
├─ message_end        { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }           // If tool streams
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end           { message, toolResults: [toolResult] }
│
├─ turn_start                                        // Next turn
├─ message_start      { assistantMessage }           // LLM responds to tool result
├─ message_update...
├─ message_end
├─ turn_end
└─ agent_end
```

### continue() Event Sequence

`continue()` resumes from existing context without adding a new message. Use it for retries after errors.

```typescript
// After an error, retry from current state
await agent.continue();
```

The last message in context must be `user` or `toolResult` (not `assistant`).

### Event Types

| Event                   | Description                                                     |
| ----------------------- | --------------------------------------------------------------- |
| `agent_start`           | Agent begins processing                                         |
| `agent_end`             | Agent completes with all new messages                           |
| `turn_start`            | New turn begins (one LLM call + tool executions)                |
| `turn_end`              | Turn completes with assistant message and tool results          |
| `message_start`         | Any message begins (user, assistant, toolResult)                |
| `message_update`        | **Assistant only.** Includes `assistantMessageEvent` with delta |
| `message_end`           | Message completes                                               |
| `tool_execution_start`  | Tool begins                                                     |
| `tool_execution_update` | Tool streams progress                                           |
| `tool_execution_end`    | Tool completes                                                  |

## Agent Options

```typescript
const agent = new Agent({
  // Initial state
  initialState: {
    systemPrompt: string[],
    model: Model,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  // Convert AgentMessage[] to LLM Message[] (required for custom message types)
  convertToLlm: (messages) => messages.filter(...),

  // Transform context before convertToLlm (for pruning, compaction)
  transformContext: async (messages, signal) => pruneOldMessages(messages),

  // How to handle queued messages: "one-at-a-time" (default) or "all"
  queueMode: "one-at-a-time",

  // Custom stream function (for proxy backends)
  streamFn: streamProxy,

  // Dynamic model-scoped API key resolution (for expiring OAuth tokens)
  getApiKey: async (model) => tokenForModel(model),

  // Tool execution context (late-bound UI/session access)
  getToolContext: () => ({ /* app-defined */ }),
});
```

## Agent State

```typescript
interface AgentState {
	systemPrompt: string[];
	model: Model;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool<any>[];
	messages: AgentMessage[];
	isStreaming: boolean;
	streamMessage: AgentMessage | null; // Current partial during streaming
	pendingToolCalls: Set<string>;
	error?: string;
}
```

Access via `agent.state`. During streaming, `streamMessage` contains the partial assistant message.

## Methods

### Prompting

```typescript
// Text prompt
await agent.prompt("Hello");

// With images
await agent.prompt("What's in this image?", [{ type: "image", data: base64Data, mimeType: "image/jpeg" }]);

// AgentMessage directly
await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });

// Continue from current context (last message must be user or toolResult)
await agent.continue();
```

### State Management

```typescript
agent.setSystemPrompt("New prompt");
agent.setModel(getModel("openai", "gpt-4o"));
agent.setThinkingLevel("medium");
agent.setTools([myTool]);
agent.replaceMessages(newMessages);
agent.appendMessage(message);
agent.clearMessages();
agent.reset(); // Clear everything
```

### Control

```typescript
agent.abort(); // Cancel current operation
await agent.waitForIdle(); // Wait for completion
```

### Events

```typescript
const unsubscribe = agent.subscribe((event) => {
	console.log(event.type);
});
unsubscribe();
```

## Steering & Follow-up

Queue messages to inject during tool execution (steering) or after the agent would otherwise stop (follow-up):

```typescript
agent.setSteeringMode("one-at-a-time");
agent.setInterruptMode("immediate");

// While agent is running tools
agent.steer({
	role: "user",
	content: "Stop! Do this instead.",
	timestamp: Date.now(),
});

// Queue a follow-up to run after the current turn completes
agent.followUp({
	role: "user",
	content: "After that, summarize the changes.",
	timestamp: Date.now(),
});
```

Steering messages are checked after each tool call by default. Set `interruptMode` to `"wait"` to defer
steering until the current turn completes.

## Custom Message Types

Extend `AgentMessage` via declaration merging:

```typescript
declare module "@oh-my-pi/pi-agent-core" {
	interface CustomAgentMessages {
		notification: { role: "notification"; text: string; timestamp: number };
	}
}

// Now valid
const msg: AgentMessage = { role: "notification", text: "Info", timestamp: Date.now() };
```

Handle custom types in `convertToLlm`:

```typescript
const agent = new Agent({
	convertToLlm: (messages) =>
		messages.flatMap((m) => {
			if (m.role === "notification") return []; // Filter out
			return [m];
		}),
});
```

## Tools

Define tools using `AgentTool` with an omptype parameter schema.

```typescript
import { type } from "@oh-my-pi/omptype";

const readFileTool: AgentTool = {
	name: "read_file",
	label: "Read File", // For UI display
	description: "Read a file's contents",
	parameters: type({
		path: type("string").describe("File path"),
	}),
	execute: async (toolCallId, params, signal, onUpdate, context) => {
		const content = await fs.readFile(params.path, "utf-8");

		// Optional: stream progress
		onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });

		return {
			content: [{ type: "text", text: content }],
			details: { path: params.path, size: content.length },
		};
	},
};

agent.setTools([readFileTool]);
```

### Error Handling

**Throw an error** when a tool fails. Do not return error messages as content.

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
	if (!fs.existsSync(params.path)) {
		throw new Error(`File not found: ${params.path}`);
	}
	// Return content only on success
	return { content: [{ type: "text", text: "..." }] };
};
```

Thrown errors are caught by the agent and reported to the LLM as tool errors with `isError: true`.

## Proxy Usage

For browser apps that proxy through a backend:

```typescript
import { Agent, streamProxy } from "@oh-my-pi/pi-agent-core";

const agent = new Agent({
	streamFn: (model, context, options) =>
		streamProxy(model, context, {
			...options,
			authToken: "...",
			proxyUrl: "https://your-server.com",
		}),
});
```

## Low-Level API

For direct control without the Agent class:

```typescript
import { agentLoop, agentLoopContinue } from "@oh-my-pi/pi-agent-core";

const context: AgentContext = {
	systemPrompt: ["You are helpful."],
	messages: [],
	tools: [],
};

const config: AgentLoopConfig = {
	model: getModel("openai", "gpt-4o"),
	convertToLlm: (msgs) => msgs.filter((m) => ["user", "assistant", "toolResult"].includes(m.role)),
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };

for await (const event of agentLoop([userMessage], context, config)) {
	console.log(event.type);
}

// Continue from existing context
for await (const event of agentLoopContinue(context, config)) {
	console.log(event.type);
}
```

## Run-level telemetry
Every `invoke_agent` produces two values alongside the OTEL spans:

- **`AgentRunSummary`** — chat / tool / usage / cost / error counters bucketed
  by status, with per-tool-name breakdowns. Pure aggregation, safe to
  persist, diff, or assert.
- **`AgentRunCoverage`** — sorted+deduped `toolsAvailable` / `toolsInvoked` /
  `toolsUnused` / `modelsUsed` / `providersUsed` arrays. Stable for snapshot
  tests.

Three delivery channels (use whichever fits):

### `agent_end` event (additive)

```typescript
for await (const event of agentLoop([userMessage], context, {
	...config,
	telemetry: {},
})) {
	if (event.type === "agent_end" && event.telemetry) {
		console.log("tokens:", event.telemetry.usage.totalTokens);
		console.log("unused tools:", event.coverage?.toolsUnused);
	}
}
```

The `messages` field is unchanged. Consumers that ignore `telemetry`/
`coverage` continue to work.

### `onRunEnd` hook (non-fatal)

```typescript
const stream = agentLoop([userMessage], context, {
	...config,
	telemetry: {
		onRunEnd: (summary, coverage) => {
			await persistRunSummary(summary, coverage);
		},
	},
});
```

Exceptions thrown from `onRunEnd` are caught and logged via `console.warn`;
a misbehaving telemetry consumer can **never** turn a successful agent run
into a failed one.

### `agentLoopDetailed` (typed `detailed()` result)

Convenience wrapper that preserves the existing stream API and exposes the
rollup as a typed value:

```typescript
const { stream, detailed } = agentLoopDetailed([userMessage], context, {
	...config,
	telemetry: {}, // required to populate telemetry/coverage
});

for await (const event of stream) {
	// existing event handling
}

const { messages, telemetry, coverage } = await detailed();
```

`stream.result()` still resolves to `AgentMessage[]` — no breaking change.

### Multi-run aggregation

Callers that drive the loop multiple times (verify pass, benchmark harness)
fold N summaries with `aggregateAgentRunSummaries` / `aggregateAgentRunCoverage`:

```typescript
import {
	aggregateAgentRunSummaries,
	aggregateAgentRunCoverage,
} from "@oh-my-pi/pi-agent-core";

const summaries: AgentRunSummary[] = [];
const coverages: AgentRunCoverage[] = [];
for (const target of targets) {
	const { detailed } = agentLoopDetailed(/* ... */);
	const result = await detailed();
	if (result.telemetry) summaries.push(result.telemetry);
	if (result.coverage) coverages.push(result.coverage);
}
const runSummary = aggregateAgentRunSummaries(summaries);
const runCoverage = aggregateAgentRunCoverage(coverages);
```

### Tool status reporting

`execute_tool` spans carry `pi.gen_ai.tool.status` ∈
`"ok" | "error" | "skipped" | "blocked" | "timeout" | "aborted"`.
`beforeToolCall` blocks throw a distinguishable `ToolCallBlockedError`
internally; the catch path reports `status: "blocked"` instead of conflating
with generic tool errors. Pre-run interrupts and tail-sweep skips are
recorded as `"skipped"` even though they never start a span.

## License

MIT
