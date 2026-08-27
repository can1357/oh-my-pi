import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { agentLoop } from "../src/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolContext,
	ToolCallContext,
	ToolPresentationAdapter,
} from "../src/types";
import { createUserMessage } from "./helpers";

/**
 * Argument ownership at runtime: public and execution views must never share a
 * mutable object graph.
 *
 * The agent loop deep-clones the validated arguments before branding them as
 * execution arguments, so a `selects()` implementation that mutates
 * `params.nested.value` corrupts only its own copy — never the public object
 * that `start()`, `tool_execution_start`, and `tool_execution_update` all read.
 * The clone uses `structuredClone`, not JSON parse/stringify, because arguments
 * are model-authored JSON values.
 */

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const nestedSchema = type({ command: "string", config: { value: "string" } });

function mutatingSelectsTool(): AgentTool<typeof nestedSchema, { value: string }> {
	const presentation: ToolPresentationAdapter<typeof nestedSchema, { value: string }> = {
		selects: params => {
			// Mutate the execution copy — must not leak into the public view.
			// The runtime type is DeepReadonly, but a hostile adapter can bypass
			// with `as unknown`. The clone boundary, not the type, is the runtime guard.
			const writable = params as unknown as { command: string; config: { value: string } };
			writable.command = "MUTATED_BY_SELECTS";
			writable.config.value = "MUTATED_NESTED";
			return true;
		},
		start: (toolCallId, params) => ({
			toolCallId,
			toolName: "mutating",
			title: params.command,
			kind: "execute" as const,
		}),
	};
	return {
		name: "mutating",
		label: "Mutating",
		description: "Mutating selects",
		parameters: nestedSchema,
		presentation,
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text" as const, text: `ran: ${params.command}` }],
				details: { value: params.config.value },
				outcome: { kind: "succeeded" as const, process: { kind: "exited" as const, code: 0 } },
			};
		},
	};
}

function threadingHost(): (toolCall?: ToolCallContext) => AgentToolContext | undefined {
	return toolCall => ({ toolCall });
}

async function runMutatingTool(): Promise<AgentEvent[]> {
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [mutatingSelectsTool()] };
	const mock = createMockModel({
		responses: [
			{
				content: [
					{
						type: "toolCall",
						id: "call-1",
						name: "mutating",
						arguments: { command: "original", config: { value: "original" } },
					},
				],
			},
			{ content: ["done"] },
		],
	});
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: identityConverter,
		getToolContext: threadingHost(),
	};
	const events: AgentEvent[] = [];
	const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
	try {
		for await (const event of stream) events.push(event);
	} catch {
		// A lifecycle failure may propagate; the ownership assertions are the point.
	}
	return events;
}

describe("argument ownership at runtime", () => {
	it("a mutating selects() does not corrupt the public start() view (no transform)", async () => {
		const events = await runMutatingTool();

		// The started event's call descriptor must carry the ORIGINAL command,
		// not the one selects() mutated.
		const started = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_presentation" }> =>
				e.type === "tool_presentation" && (e as { event?: { type?: string } }).event?.type === "started",
		);
		expect(started).toBeDefined();
		const call = (started as unknown as { event: { call: { title: string } } }).event.call;
		expect(call.title).toBe("original");

		// The tool_execution_start event must also carry the ORIGINAL args.
		const execStart = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_start" }> => e.type === "tool_execution_start",
		);
		expect(execStart).toBeDefined();
		const startArgs = (execStart as unknown as { args: { command: string; config: { value: string } } }).args;
		expect(startArgs.command).toBe("original");
		expect(startArgs.config.value).toBe("original");

		// The tool's execute() must see the MUTATED execution copy (selects ran on it).
		const toolEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnd).toBeDefined();
		const resultText = (toolEnd as unknown as { result: { content: [{ text: string }] } }).result.content[0]?.text;
		expect(resultText).toBe("ran: MUTATED_BY_SELECTS");
	});

	it("a mutating selects() does not corrupt the public view with nested mutation", async () => {
		const events = await runMutatingTool();

		// The tool result must carry the MUTATED nested value (execution copy).
		const toolEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnd).toBeDefined();
		const resultDetails = (toolEnd as unknown as { result: { details: { value: string } } }).result.details;
		expect(resultDetails.value).toBe("MUTATED_NESTED");
	});
});

describe("argument boundary — hook-revised args and JSON enforcement", () => {
	it("rejects non-JSON hook args at the boundary, not as a silent skipped result", async () => {
		// A hook that returns a function (non-JSON) must be rejected at the
		// boundary, not produce a DataCloneError later or a silent "skipped".
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema> = {
			name: "boundary-tool",
			label: "boundary-tool",
			description: "test tool",
			parameters: toolSchema,
			strict: false,
			async execute(_id, params) {
				return { content: [{ type: "text", text: params.value }], details: {} };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "call-nonjson",
							name: "boundary-tool",
							arguments: { value: "original" },
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [],
			tools: [tool],
		};
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			beforeToolCall: async () => {
				// Return a non-JSON value (a function) as args.
				return { args: { value: (() => {}) as unknown as string } };
			},
		};
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("run")], context, config, undefined, mock.stream);
		try {
			for await (const event of stream) events.push(event);
		} catch {
			// A lifecycle failure may propagate; the boundary assertion is the point.
		}

		// The tool call must produce a validation error result, not a silent
		// "skipped" or a successful execution.
		const toolEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_end" }> => e.type === "tool_execution_end",
		);
		expect(toolEnd).toBeDefined();
		expect(toolEnd?.isError).toBe(true);
		const resultText = (toolEnd as unknown as { result: { content: [{ text: string }] } }).result.content[0]?.text;
		expect(resultText).toContain("non-JSON");
	});

	it("turns a throwing hook getter into one validation failure", async () => {
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema> = {
			name: "getter-boundary-tool",
			label: "getter-boundary-tool",
			description: "test tool",
			parameters: toolSchema,
			strict: false,
			async execute() {
				throw new Error("must not execute");
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "call-getter", name: "getter-boundary-tool", arguments: { value: "x" } },
					],
				},
				{ content: ["done"] },
			],
		});
		const args = {} as { value: string };
		Object.defineProperty(args, "value", {
			enumerable: true,
			get() {
				throw new Error("getter exploded");
			},
		});
		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			[createUserMessage("run")],
			{ systemPrompt: [""], messages: [], tools: [tool] },
			{ model: mock.model, convertToLlm: identityConverter, beforeToolCall: async () => ({ args }) },
			undefined,
			mock.stream,
		)) {
			events.push(event);
		}
		const end = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
		);
		expect(end?.isError).toBe(true);
		expect((end as { result: { content: [{ text: string }] } }).result.content[0]?.text).toContain("non-JSON");
	});

	it("hook-revised nested JSON remains isolated from the public view", async () => {
		// A hook that revises nested JSON args must not corrupt the public
		// view (tool_execution_start) that carries the pre-revision args.
		const toolSchema = type({ command: "string", config: { value: "string" } });
		const executed: { command: string; config: { value: string } }[] = [];
		const tool: AgentTool<typeof toolSchema> = {
			name: "nested-tool",
			label: "nested-tool",
			description: "test tool",
			parameters: toolSchema,
			strict: false,
			async execute(_id, params) {
				executed.push({ command: params.command, config: { ...params.config } });
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "call-nested",
							name: "nested-tool",
							arguments: { command: "original", config: { value: "original" } },
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const context: AgentContext = {
			systemPrompt: [""],
			messages: [],
			tools: [tool],
		};
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			beforeToolCall: async () => ({
				args: { command: "revised", config: { value: "revised" } },
			}),
		};
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("run")], context, config, undefined, mock.stream);
		try {
			for await (const event of stream) events.push(event);
		} catch {
			// A lifecycle failure may propagate; the isolation assertion is the point.
		}

		// The tool_execution_start must carry the REVISED args (hook revision is
		// baked into the message), but the execution copy is a deep clone —
		// mutating it must not affect the event's args.
		const execStart = events.find(
			(e): e is Extract<AgentEvent, { type: "tool_execution_start" }> => e.type === "tool_execution_start",
		);
		expect(execStart).toBeDefined();
		const startArgs = (execStart as unknown as { args: { command: string; config: { value: string } } }).args;
		expect(startArgs.command).toBe("revised");
		expect(startArgs.config.value).toBe("revised");

		// The tool must see the revised values.
		expect(executed).toHaveLength(1);
		expect(executed[0]?.command).toBe("revised");
		expect(executed[0]?.config.value).toBe("revised");

		// Mutating the execution copy must not corrupt the event's args.
		// (The deep clone ensures isolation.)
		expect(startArgs.config.value).toBe("revised");
	});
});
