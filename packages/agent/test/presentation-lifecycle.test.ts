import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolContext,
	ToolCallContext,
} from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { ToolPresentationProducer } from "../src/presentation";
import { createLiveTerminalBinding, factId } from "../src/presentation";
import type { ToolPresentationAdapter } from "../src/types";
import { createUserMessage } from "./helpers";

/**
 * `started -> settled` totality for the presentation protocol.
 *
 * The property under test is an *ownership* property, not a producer obligation:
 * once the loop announces a call on the presentation protocol, exactly one typed
 * settlement must follow **on every exception path**, because the ACP layer
 * deliberately skips the legacy `tool_execution_end` for such a call. A missing
 * settlement is therefore not a degraded card — it is a card that never resolves.
 */

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const toolSchema = type({ value: "string" });

interface StreamingToolOptions {
	readonly selects?: () => boolean;
	readonly start?: () => void;
	readonly onExecute?: (producer: NonNullable<ToolCallContext["progress"]>) => Promise<void> | void;
}

/** A tool on the presentation protocol whose adapter callbacks can be made to throw. */
function streamingTool(options: StreamingToolOptions = {}): AgentTool<typeof toolSchema, { value: string }> {
	const presentation: ToolPresentationAdapter<typeof toolSchema, { value: string }> = {
		selects: () => {
			options.selects?.();
			return true;
		},
		start: (toolCallId, params) => {
			options.start?.();
			return { toolCallId, toolName: "stream", title: params.value, kind: "execute" };
		},
	};
	return {
		name: "stream",
		label: "Stream",
		description: "Streaming tool",
		parameters: toolSchema,
		presentation,
		async execute(_toolCallId, params, _signal, _onUpdate, context) {
			const progress = context?.toolCall?.progress;
			if (progress !== undefined) await options.onExecute?.(progress);
			return {
				content: [{ type: "text", text: `ran: ${params.value}` }],
				details: { value: params.value },
				outcome: { kind: "succeeded", process: { kind: "exited", code: 0 } },
			};
		},
	};
}

/** A host that threads the loop's per-call context, the way `ToolContextStore` does. */
function threadingHost(): (toolCall?: ToolCallContext) => AgentToolContext | undefined {
	return toolCall => ({ toolCall });
}

async function runLoop(
	tool: AgentTool<typeof toolSchema, { value: string }>,
	options: {
		readonly getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;
		readonly afterToolCall?: AgentLoopConfig["afterToolCall"];
	} = {},
): Promise<AgentEvent[]> {
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "call-1", name: "stream", arguments: { value: "hello" } }] },
			{ content: ["done"] },
		],
	});
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: identityConverter,
		...(options.getToolContext === undefined ? {} : { getToolContext: options.getToolContext }),
		...(options.afterToolCall === undefined ? {} : { afterToolCall: options.afterToolCall }),
	};
	const events: AgentEvent[] = [];
	const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
	try {
		for await (const event of stream) events.push(event);
	} catch {
		// A lifecycle failure may propagate; the settlement assertions are the point.
	}
	return events;
}

function presentationEvents(events: readonly AgentEvent[]): Extract<AgentEvent, { type: "tool_presentation" }>[] {
	return events.filter(
		(event): event is Extract<AgentEvent, { type: "tool_presentation" }> => event.type === "tool_presentation",
	);
}

function lifecycle(events: readonly AgentEvent[]): string[] {
	return presentationEvents(events)
		.map(event => event.event.type)
		.filter(type => type === "started" || type === "settled");
}

function settlements(events: readonly AgentEvent[]): Extract<AgentEvent, { type: "tool_presentation" }>[] {
	return presentationEvents(events).filter(event => event.event.type === "settled");
}

function startProtocol(events: readonly AgentEvent[]): string | undefined {
	const start = events.find(event => event.type === "tool_execution_start");
	return start?.type === "tool_execution_start" ? (start.progressProtocol ?? "legacy_snapshot") : undefined;
}

describe("presentation lifecycle totality", () => {
	it("settles a normal presentation call exactly once", async () => {
		const events = await runLoop(streamingTool(), { getToolContext: threadingHost() });
		expect(startProtocol(events)).toBe("presentation_events");
		expect(lifecycle(events)).toEqual(["started", "settled"]);
	});

	it("falls back to legacy when the adapter's start descriptor throws", async () => {
		// `adapter.start()` threw *after* `tool_execution_start` had already declared
		// `presentation_events`, so the ACP layer skipped the legacy pair for a call it
		// never saw announced on the new protocol either: the call vanished entirely.
		const events = await runLoop(
			streamingTool({
				start: () => {
					throw new Error("descriptor exploded");
				},
			}),
			{ getToolContext: threadingHost() },
		);
		expect(startProtocol(events)).toBe("legacy_snapshot");
		expect(presentationEvents(events)).toHaveLength(0);
		// The legacy pair still describes the call, so nothing is lost.
		expect(events.some(event => event.type === "tool_execution_end")).toBe(true);
	});

	it("falls back to legacy when the selector throws", async () => {
		const events = await runLoop(
			streamingTool({
				selects: () => {
					throw new Error("selector exploded");
				},
			}),
			{ getToolContext: threadingHost() },
		);
		expect(startProtocol(events)).toBe("legacy_snapshot");
		expect(presentationEvents(events)).toHaveLength(0);
	});

	it("settles exactly once when coercing a poisoned outcome throws", async () => {
		// The adapter's own `outcome` hook is gone: a producer now
		// returns `outcome` as a plain field on its result, which `coerceToolResult`
		// reads once immediately after `execute()` returns and never re-reads at
		// settlement -- so a throw here is caught by the same try/catch that already
		// wraps `tool.execute()` (`completedToolExecution` is already true, hence
		// reason `"hook"`, matching the label that branch already uses for any
		// post-execute fault, not only an `afterToolCall` throw) rather than by
		// `deriveToolOutcome`'s own catch. Exercised via a poisoned `outcome`
		// getter instead of the removed adapter injection point.
		const tool = streamingTool();
		const poisoned: AgentTool<typeof toolSchema, { value: string }> = {
			...tool,
			async execute(...args) {
				const result: { content: unknown; details: unknown; outcome?: unknown } = {
					content: [{ type: "text", text: "ran" }],
					details: { value: "poisoned" },
				};
				Object.defineProperty(result, "outcome", {
					enumerable: true,
					get() {
						throw new Error("outcome exploded");
					},
				});
				void args;
				return result as never;
			},
		};
		const events = await runLoop(poisoned, { getToolContext: threadingHost() });
		expect(lifecycle(events)).toEqual(["started", "settled"]);
		const settled = settlements(events)[0]?.event;
		if (settled?.type !== "settled") throw new Error("expected a settlement");
		// A typed synthetic failure, not a skipped settlement.
		expect(settled.outcome.kind).toBe("failed");
		if (settled.outcome.kind !== "failed") throw new Error("expected a failure");
		expect(settled.outcome.failure.reason).toBe("hook");
		expect(settled.outcome.failure.message).toContain("outcome exploded");
	});

	it("settles exactly once when the executor throws", async () => {
		const tool = streamingTool();
		const throwing: AgentTool<typeof toolSchema, { value: string }> = {
			...tool,
			async execute() {
				throw new Error("executor exploded");
			},
		};
		const events = await runLoop(throwing, { getToolContext: threadingHost() });
		expect(lifecycle(events)).toEqual(["started", "settled"]);
		const settled = settlements(events)[0]?.event;
		if (settled?.type !== "settled") throw new Error("expected a settlement");
		expect(settled.outcome.kind).toBe("failed");
	});

	it("settles exactly once when a registered flusher throws during freeze", async () => {
		const events = await runLoop(
			streamingTool({
				onExecute: progress => {
					if (progress.kind !== "presentation_events") throw new Error("expected the presentation arm");
					progress.presentation.appendTerminal("before-flush\n");
					progress.presentation.registerFlusher(_scope => {
						throw new Error("flusher exploded");
					});
				},
			}),
			{ getToolContext: threadingHost() },
		);
		expect(lifecycle(events)).toEqual(["started", "settled"]);
		const appended = presentationEvents(events).filter(event => event.event.type === "terminal_append");
		expect(appended).toHaveLength(1);
	});

	it("runs every flusher even when one throws, and still ends frozen", async () => {
		const flushed: string[] = [];
		let captured: ToolPresentationProducer | undefined;
		const events = await runLoop(
			streamingTool({
				onExecute: progress => {
					if (progress.kind !== "presentation_events") throw new Error("expected the presentation arm");
					const producer = progress.presentation;
					captured = producer;
					producer.registerFlusher(_scope => {
						flushed.push("first");
						throw new Error("first flusher exploded");
					});
					producer.registerFlusher(scope => {
						// A later flusher owns a *different* pending buffer, so skipping it
						// would drop bytes that were still deliverable.
						flushed.push("second");
						scope.appendTerminal("second-flush\n");
					});
				},
			}),
			{ getToolContext: threadingHost() },
		);
		expect(flushed).toEqual(["first", "second"]);
		expect(lifecycle(events)).toEqual(["started", "settled"]);
		expect(
			presentationEvents(events)
				.filter(event => event.event.type === "terminal_append")
				.map(event => (event.event.type === "terminal_append" ? event.event.data : "")),
		).toEqual(["second-flush\n"]);

		// The stream ends frozen even though a flusher threw — previously `#frozen` was
		// only set on the success path, so a settled call was still appendable.
		const producer = captured;
		if (producer === undefined) throw new Error("expected the tool to receive a producer");
		expect(producer.frozen).toBe(true);
		// Every producer mutation is refused after the barrier, not just appends.
		expect(() => producer.appendTerminal("late\n")).toThrow(/after freeze/);
		expect(() => producer.fact({ kind: "wall_time", ms: 1 })).toThrow(/after freeze/);
		expect(() => producer.attachment({ kind: "image", data: "AAAA", mimeType: "image/png" })).toThrow(/after freeze/);
		expect(() => producer.attachLiveTerminal(createLiveTerminalBinding("term-1"))).toThrow(/after freeze/);
		expect(() => producer.registerFlusher(() => undefined)).toThrow(/after freeze/);
		// ...and no mutation leaked an event past the settlement.
		expect(lifecycle(events)).toEqual(["started", "settled"]);
		expect(presentationEvents(events).at(-1)?.event.type).toBe("settled");
	});
});

describe("presentation producer reachability", () => {
	it("keeps a standalone host with no getToolContext on the legacy protocol", async () => {
		// The producer can only reach a tool through the host-built `AgentToolContext`.
		// A standalone `Agent` supplies no `getToolContext` at all, so selecting the
		// presentation protocol left the call with no progress channel whatsoever —
		// the presentation arm deliberately passes no `onUpdate`.
		const seen: Array<string | undefined> = [];
		const tool = streamingTool();
		const observing: AgentTool<typeof toolSchema, { value: string }> = {
			...tool,
			async execute(_toolCallId, params, _signal, onUpdate, context) {
				seen.push(context?.toolCall?.progress?.kind);
				expect(typeof onUpdate).toBe("function");
				return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
			},
		};
		const events = await runLoop(observing);
		expect(startProtocol(events)).toBe("legacy_snapshot");
		expect(presentationEvents(events)).toHaveLength(0);
		expect(seen).toEqual([undefined]);
	});

	it("keeps a host that drops the per-call context on the legacy protocol", async () => {
		// `sdk.ts` has both `getToolContext: () => store.getContext()` and
		// `tc => store.getContext(tc)`; the first drops `toolCall` entirely.
		const tool = streamingTool();
		let receivedOnUpdate = false;
		const observing: AgentTool<typeof toolSchema, { value: string }> = {
			...tool,
			async execute(_toolCallId, params, _signal, onUpdate) {
				receivedOnUpdate = typeof onUpdate === "function";
				return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
			},
		};
		const events = await runLoop(observing, { getToolContext: () => ({}) });
		expect(startProtocol(events)).toBe("legacy_snapshot");
		expect(presentationEvents(events)).toHaveLength(0);
		// Output has a channel: exactly one, and it is the legacy one.
		expect(receivedOnUpdate).toBe(true);
	});

	it("gives the tool a producer whenever it declares the presentation protocol", async () => {
		const observed: Array<{ kind: string; hasProducer: boolean; hasOnUpdate: boolean }> = [];
		const tool = streamingTool();
		const observing: AgentTool<typeof toolSchema, { value: string }> = {
			...tool,
			async execute(_toolCallId, params, _signal, onUpdate, context) {
				const progress = context?.toolCall?.progress;
				observed.push({
					kind: progress?.kind ?? "none",
					hasProducer: progress?.kind === "presentation_events",
					hasOnUpdate: typeof onUpdate === "function",
				});
				return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
			},
		};
		const events = await runLoop(observing, { getToolContext: threadingHost() });
		expect(startProtocol(events)).toBe("presentation_events");
		// Exactly one protocol, and it is the declared one.
		expect(observed).toEqual([{ kind: "presentation_events", hasProducer: true, hasOnUpdate: false }]);
	});

	it("selects the protocol from the transformed arguments the tool will actually receive", async () => {
		// A transform that changes a route-deciding argument must be visible to
		// `selects`, or the dispatcher picks a protocol for a route the tool never
		// takes and the output has no channel at all.
		const seenBySelects: unknown[] = [];
		const seenByExecute: unknown[] = [];
		const tool = streamingTool();
		const observing: AgentTool<typeof toolSchema, { value: string }> = {
			...tool,
			presentation: {
				selects: (params: { value: string }) => {
					seenBySelects.push(params.value);
					return params.value !== "transformed";
				},
				start: (toolCallId: string, params: { value: string }) => ({
					toolCallId,
					toolName: "stream",
					title: params.value,
					kind: "execute" as const,
				}),
			},
			async execute(_toolCallId, params) {
				seenByExecute.push(params.value);
				return {
					content: [{ type: "text", text: params.value }],
					details: { value: params.value },
					outcome: { kind: "succeeded" as const, process: { kind: "exited" as const, code: 0 as const } },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [observing] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "call-1", name: "stream", arguments: { value: "original" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolContext: threadingHost(),
			transformToolCallArguments: () => ({ value: "transformed" }),
		};
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
		for await (const event of stream) events.push(event);

		expect(seenBySelects).toEqual(["transformed"]);
		expect(seenByExecute).toEqual(["transformed"]);
		expect(startProtocol(events)).toBe("legacy_snapshot");
		expect(presentationEvents(events)).toHaveLength(0);
	});

	it("passes a display-safe execution-route witness to start without exposing transformed arguments", async () => {
		const seenByStart: Array<{ value: string; routing: unknown }> = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "stream",
			label: "Stream",
			description: "Streaming tool",
			parameters: toolSchema,
			presentation: {
				selects: (params: { value: string }) =>
					params.value === "transformed-client"
						? { kind: "presentation_events", routing: "client_terminal" }
						: false,
				start: (toolCallId: string, params: { value: string }, routing: unknown) => {
					seenByStart.push({ value: params.value, routing });
					return {
						toolCallId,
						toolName: "stream",
						title: params.value,
						kind: "execute" as const,
						...(routing === "client_terminal" ? { awaitsLiveTerminal: true } : {}),
					};
				},
			},
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: params.value }],
					details: { value: params.value },
					outcome: { kind: "succeeded" as const, process: { kind: "exited" as const, code: 0 as const } },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "call-1", name: "stream", arguments: { value: "public" } }] },
				{ content: ["done"] },
			],
		});
		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			[createUserMessage("go")],
			context,
			{
				model: mock.model,
				convertToLlm: identityConverter,
				getToolContext: threadingHost(),
				transformToolCallArguments: () => ({ value: "transformed-client" }),
			},
			undefined,
			mock.stream,
		)) {
			events.push(event);
		}

		expect(seenByStart).toEqual([{ value: "public", routing: "client_terminal" }]);
		const started = presentationEvents(events).find(event => event.event.type === "started");
		if (started?.event.type !== "started") throw new Error("expected a started presentation event");
		expect(started.event.call.awaitsLiveTerminal).toBe(true);
		expect(JSON.stringify(started.event.call)).not.toContain("transformed-client");
	});

	it("hands the adapter's start() the pre-transform arguments, never the host's transformed ones", async () => {
		// The leak this guards against: `transformToolCallArguments` can deobfuscate a
		// secret placeholder before execution. If `adapter.start()` received that
		// transformed value, a tool that echoes its argument into `title`/`rawInput`
		// (bash does, verbatim) would publish the deobfuscated secret to every ACP
		// client. `selects`/`execute` still need the transformed value — a transform can
		// flip a route-deciding argument — so only `start()` must see the original.
		const seenByStart: unknown[] = [];
		const seenBySelects: unknown[] = [];
		const seenByExecute: unknown[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "stream",
			label: "Stream",
			description: "Streaming tool",
			parameters: toolSchema,
			presentation: {
				selects: (params: { value: string }) => {
					seenBySelects.push(params.value);
					return true;
				},
				start: (toolCallId: string, params: { value: string }) => {
					seenByStart.push(params.value);
					return {
						toolCallId,
						toolName: "stream",
						title: params.value,
						kind: "execute" as const,
						rawInput: { value: params.value },
					};
				},
			},
			async execute(_toolCallId, params) {
				seenByExecute.push(params.value);
				return {
					content: [{ type: "text", text: params.value }],
					details: { value: params.value },
					outcome: { kind: "succeeded" as const, process: { kind: "exited" as const, code: 0 as const } },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "call-1", name: "stream", arguments: { value: "$$SECRET$$" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolContext: threadingHost(),
			transformToolCallArguments: () => ({ value: "s3cr3t-plaintext" }),
		};
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
		for await (const event of stream) events.push(event);

		// Execution runs with the deobfuscated value.
		expect(seenBySelects).toEqual(["s3cr3t-plaintext"]);
		expect(seenByExecute).toEqual(["s3cr3t-plaintext"]);
		// The presentation descriptor — what the ACP wire will actually carry — never
		// sees it.
		expect(seenByStart).toEqual(["$$SECRET$$"]);

		const started = presentationEvents(events).find(event => event.event.type === "started");
		if (started?.event.type !== "started") throw new Error("expected a started presentation event");
		expect(started.event.call.title).toBe("$$SECRET$$");
		expect(started.event.call.rawInput).toEqual({ value: "$$SECRET$$" });
		const serialized = JSON.stringify(started.event.call);
		expect(serialized).toContain("$$SECRET$$");
		expect(serialized).not.toContain("s3cr3t-plaintext");

		// The legacy `tool_execution_start`/`tool_execution_update` events are the same
		// boundary for unmigrated tools: they must not carry the transformed value either.
		const start = events.find(event => event.type === "tool_execution_start");
		expect(start?.type === "tool_execution_start" ? start.args : undefined).toEqual({ value: "$$SECRET$$" });
	});

	it("isolates an in-place mutating transform from the public arguments view, including a nested field", async () => {
		// `transformToolCallArguments` is untyped host code and the contract does not
		// prohibit mutation. If the transform's input were the same object this loop
		// later brands "public" (the adapter's `start()`, `tool_execution_start`),
		// an in-place write — including a nested field, not just a top-level one —
		// would leak into every publish-facing event, corrupting the nominal brand's
		// promise that `PublicToolArguments` never carries a host transform's output.
		const nestedToolSchema = type({ value: "string", nested: { value: "string" } });
		const seenByExecute: unknown[] = [];
		const tool: AgentTool<typeof nestedToolSchema, { value: string }> = {
			name: "stream",
			label: "Stream",
			description: "Streaming tool",
			parameters: nestedToolSchema,
			presentation: {
				selects: () => true,
				start: (toolCallId: string, params: { value: string; nested: { value: string } }) => ({
					toolCallId,
					toolName: "stream",
					title: params.value,
					kind: "execute" as const,
					rawInput: params,
				}),
			},
			async execute(_toolCallId, params) {
				seenByExecute.push(structuredClone(params));
				return {
					content: [{ type: "text", text: params.value }],
					details: { value: params.value },
					outcome: { kind: "succeeded" as const, process: { kind: "exited" as const, code: 0 as const } },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "stream",
							arguments: { value: "PLACEHOLDER", nested: { value: "PLACEHOLDER" } },
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
			transformToolCallArguments: args => {
				// In-place, top-level AND nested — a shallow-clone defense would still
				// leak this nested write into the public view. Named cast (not inline):
				// `args` is `Record<string, unknown>` at this boundary, and the mock
				// model above is what actually guarantees this shape at runtime.
				const typed = args as { value: string; nested: { value: string } };
				typed.value = "PLAINTEXT";
				typed.nested.value = "PLAINTEXT";
				return args;
			},
		};
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
		for await (const event of stream) events.push(event);

		// Execution sees the mutated value at both levels.
		expect(seenByExecute).toEqual([{ value: "PLAINTEXT", nested: { value: "PLAINTEXT" } }]);

		// The presentation descriptor and the legacy start event both keep the
		// original, pre-transform value at both levels: the transform's in-place
		// write landed only on its own clone, never on the object these events read.
		const started = presentationEvents(events).find(event => event.event.type === "started");
		if (started?.event.type !== "started") throw new Error("expected a started presentation event");
		expect(started.event.call.rawInput).toEqual({ value: "PLACEHOLDER", nested: { value: "PLACEHOLDER" } });

		const start = events.find(event => event.type === "tool_execution_start");
		expect(start?.type === "tool_execution_start" ? start.args : undefined).toEqual({
			value: "PLACEHOLDER",
			nested: { value: "PLACEHOLDER" },
		});
	});

	it("keeps the legacy tool_execution_update event on the pre-transform arguments too, including a nested field", async () => {
		// Same isolation property, exercised on the *legacy* protocol: `emitLegacyUpdate`
		// reads `effectiveArgs` (the loop's own pre-transform snapshot), so it must be
		// just as immune to the transform's in-place write as `tool_execution_start`.
		const nestedToolSchema = type({ value: "string", nested: { value: "string" } });
		const tool: AgentTool<typeof nestedToolSchema, { value: string }> = {
			name: "stream",
			label: "Stream",
			description: "Streaming tool",
			parameters: nestedToolSchema,
			presentation: {
				selects: () => false, // force the legacy protocol
				start: (toolCallId: string, params: { value: string }) => ({
					toolCallId,
					toolName: "stream",
					title: params.value,
					kind: "execute" as const,
				}),
			},
			async execute(_toolCallId, params, _signal, onUpdate) {
				onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { value: params.value } });
				return {
					content: [{ type: "text", text: params.value }],
					details: { value: params.value },
					outcome: { kind: "succeeded" as const, process: { kind: "exited" as const, code: 0 as const } },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "stream",
							arguments: { value: "PLACEHOLDER", nested: { value: "PLACEHOLDER" } },
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
			transformToolCallArguments: args => {
				const typed = args as { value: string; nested: { value: string } };
				typed.value = "PLAINTEXT";
				typed.nested.value = "PLAINTEXT";
				return args;
			},
		};
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
		for await (const event of stream) events.push(event);

		expect(startProtocol(events)).toBe("legacy_snapshot");
		const update = events.find(event => event.type === "tool_execution_update");
		expect(update?.type === "tool_execution_update" ? update.args : undefined).toEqual({
			value: "PLACEHOLDER",
			nested: { value: "PLACEHOLDER" },
		});
	});
});

describe("presentation lifecycle under scaffolding and cancellation failures", () => {
	it("settles exactly once when the telemetry span constructor throws, with modelContent matching what the tail sweep actually emits", async () => {
		// `startExecuteToolSpan()` runs *after* the announcement. When it threw, the
		// exception unwound past the settlement block entirely, leaving an announced
		// call with no `settled` event — and the ACP layer skips the legacy
		// `tool_execution_end` for presentation calls, so its card never resolved.
		//
		// Regression: `execute()` never runs on this path (the throw happens
		// before it), so `result` still holds its untouched `{ content: [], details:
		// {} }` default at the moment `settlePresentation` runs inside the `catch`
		// block. `emitToolResult` is never reached before the rethrow either, so the
		// loop's own tail sweep (after `Promise.allSettled`) is the ONE place this
		// record's `ToolResultMessage` actually gets emitted — always
		// `createSkippedToolResult(interruptState.source, false)`, never the empty
		// default `result`. `modelContent` must match that, not `[]`.
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [streamingTool()] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "call-1", name: "stream", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		let spanCalls = 0;
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolContext: threadingHost(),
			telemetry: {
				tracer: {
					startSpan: (name: string) => {
						spanCalls++;
						if (name.includes("execute_tool")) throw new Error("tracer exploded");
						return undefined as never;
					},
					startActiveSpan: () => undefined as never,
				} as never,
			},
		};
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
		try {
			for await (const event of stream) events.push(event);
		} catch {
			// The scaffolding failure may propagate; the settlement must have happened first.
		}
		expect(spanCalls).toBeGreaterThan(0);
		expect(lifecycle(events)).toEqual(["started", "settled"]);
		const settled = settlements(events)[0]?.event;
		if (settled?.type !== "settled") throw new Error("expected a settlement");
		expect(settled.outcome.kind).toBe("failed");

		// The persisted `modelContent` must be the real skipped-tool placeholder text
		// — never the pre-override `result`'s empty `content: []` default, and never
		// `undefined` (this is the agent loop's own producer; it always supplies it).
		if (settled.modelContent === undefined)
			throw new Error("expected modelContent on the agent loop's own settled event");
		expect(settled.modelContent.length).toBeGreaterThan(0);
		const modelText = settled.modelContent.find(block => block.type === "text");
		expect(modelText?.type === "text" ? modelText.text : undefined).toContain(
			"Do not count this skipped result as completed work or verification",
		);

		// The tool result message actually emitted to history carries the identical
		// text — the two must never disagree.
		const toolResultEvent = events.find(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "toolResult",
		);
		if (toolResultEvent?.type !== "message_end" || toolResultEvent.message.role !== "toolResult") {
			throw new Error("expected a toolResult message to have been emitted");
		}
		const emittedTextBlock = toolResultEvent.message.content.find(
			(block): block is { type: "text"; text: string } => block.type === "text",
		);
		expect(emittedTextBlock?.text).toBe(modelText?.type === "text" ? modelText.text : undefined);
	});

	it("keeps the persisted modelContent aligned with the tail sweep's actual emission when interruptState.source changes concurrently", async () => {
		// Regression: `record.emittedResultOverride` is stored on the shared
		// per-call record specifically so the *outer* tail sweep in `executeToolCalls`
		// (a different function than `runTool`, running only after
		// `Promise.allSettled` resolves for the WHOLE batch) reuses the exact value
		// `runTool`'s own lifecycle-rejection `catch` block already froze, instead of
		// independently recomputing `createSkippedToolResult(interruptState.source,
		// false)` there. This test constructs a real, controlled race: a concurrent
		// steering interrupt lands (changing `interruptState.source` from `undefined`
		// to `"user"`) strictly *after* the "explode" call's `modelContent` has
		// already been frozen with `source === undefined`, but *before* the whole
		// batch (which a second, slower tool call keeps alive) finishes and the outer
		// tail sweep runs. A stale recomputation there would emit "queued user
		// message" phrasing while `modelContent` already recorded the generic
		// "pending steering message" phrasing — a genuine mismatch a pre-fix build
		// cannot avoid.
		// "slow" is deliberately interruptible and never resolves on its own within
		// this test's timeframe: it is kept alive purely by the real steering
		// interrupt this test constructs, which is what proves the interrupt
		// genuinely fired (rather than merely flipping a flag nothing observes).
		const slowTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "slow",
			label: "Slow",
			description: "Slow tool",
			parameters: toolSchema,
			interruptible: true,
			async execute(_toolCallId, params, signal) {
				await new Promise<void>((_resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("aborted before start"));
						return;
					}
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
				return { content: [{ type: "text", text: `ran: ${params.value}` }], details: { value: params.value } };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [streamingTool(), slowTool] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "call-explode", name: "stream", arguments: { value: "boom" } },
						{ type: "toolCall", id: "call-slow", name: "slow", arguments: { value: "steady" } },
					],
				},
				{ content: ["done"] },
			],
		});
		// `false` until the test observes "explode"'s settled event, so the
		// event-driven steering watch's very first (immediate) `checkSteering()`
		// call cannot fire the interrupt before that freeze happens.
		let steeringShouldFire = false;
		const steeringGate = Promise.withResolvers<void>();
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolContext: threadingHost(),
			interruptMode: "immediate",
			hasSteeringMessages: () => steeringShouldFire,
			getSteeringMessages: async () => [],
			waitForSteeringMessages: async () => {
				await steeringGate.promise;
			},
			telemetry: {
				tracer: {
					// Only the "stream" tool's execute_tool span throws — `startExecuteToolSpan`
					// embeds the tool name into the span's own `name` (`execute_tool ${toolName}`),
					// so "slow" is unaffected and runs for real, kept alive purely by its own
					// unresolved abort-listener promise until the steering interrupt fires.
					startSpan: (name: string) => {
						if (name === "execute_tool stream") throw new Error("tracer exploded");
						return undefined as never;
					},
					startActiveSpan: () => undefined as never,
				} as never,
			},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, undefined, mock.stream);
		try {
			for await (const event of stream) {
				events.push(event);
				if (
					event.type === "tool_presentation" &&
					event.toolCallId === "call-explode" &&
					event.event.type === "settled"
				) {
					// `modelContent` is already frozen into this very event at this point.
					// Only now let the concurrent steering watcher observe a queued
					// message and flip `interruptState.source` — exactly the race window
					// the review described — then let "slow" finish so the batch can end.
					steeringShouldFire = true;
					steeringGate.resolve();
				}
			}
		} catch {
			// The scaffolding failure may propagate; the settlement must have happened first.
		}

		const explodeSettled = presentationEvents(events).find(
			event => event.toolCallId === "call-explode" && event.event.type === "settled",
		)?.event;
		if (explodeSettled?.type !== "settled") throw new Error("expected a settlement for call-explode");
		if (explodeSettled.modelContent === undefined)
			throw new Error("expected modelContent on call-explode's settlement");
		const frozenText = explodeSettled.modelContent.find(block => block.type === "text");
		if (frozenText?.type !== "text") throw new Error("expected a text block in the frozen modelContent");

		// The interrupt must have genuinely changed `interruptState.source` during
		// the run — otherwise this test would not be exercising the race at all.
		// "slow" was genuinely mid-execution (blocked on its own unresolved
		// abort-listener promise) when the interrupt fired and aborted its
		// interruptible signal, so its own tool result must show the interrupt's
		// "user"-sourced skipped-tool phrasing.
		const slowResult = events.find(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" &&
				event.message.role === "toolResult" &&
				event.message.toolCallId === "call-slow",
		);
		if (slowResult?.type !== "message_end" || slowResult.message.role !== "toolResult") {
			throw new Error("expected a toolResult message for call-slow");
		}
		const slowText = slowResult.message.content.find(
			(block): block is { type: "text"; text: string } => block.type === "text",
		);
		expect(slowText?.text).toContain("Skipped due to queued user message");

		// "explode"'s frozen `modelContent` must still show the ORIGINAL,
		// undefined-source phrasing — proving it was reused from the record's
		// stored override, not recomputed against the now-changed
		// `interruptState.source` by the outer tail sweep.
		expect(frozenText.text).toContain("Skipped due to pending steering message");
		expect(frozenText.text).not.toContain("queued user message");

		// The actual `ToolResultMessage` emitted to history for "explode" — built
		// by the outer tail sweep, in a different function, after the race — must
		// carry the identical text: the whole point of storing the override on the
		// record instead of recomputing it there.
		const explodeResult = events.find(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" &&
				event.message.role === "toolResult" &&
				event.message.toolCallId === "call-explode",
		);
		if (explodeResult?.type !== "message_end" || explodeResult.message.role !== "toolResult") {
			throw new Error("expected a toolResult message for call-explode");
		}
		const explodeEmittedText = explodeResult.message.content.find(
			(block): block is { type: "text"; text: string } => block.type === "text",
		);
		expect(explodeEmittedText?.text).toBe(frozenText.text);
	});

	it("classifies a session cancellation as interrupted, not as a thrown failure", async () => {
		// ACP `session/cancel` aborts the tool signal without touching the steering/IRC
		// `interruptState`, so requiring `interruptState.triggered` made every user
		// cancellation a `failed`/`thrown` outcome.
		const controller = new AbortController();
		const tool = streamingTool();
		const cancelling: AgentTool<typeof toolSchema, { value: string }> = {
			...tool,
			async execute(_toolCallId, _params, signal) {
				controller.abort("User interrupted the run");
				await Bun.sleep(1);
				throw new Error(signal?.aborted === true ? "aborted mid-flight" : "not aborted");
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [cancelling] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "call-1", name: "stream", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			getToolContext: threadingHost(),
		};
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("go")], context, config, controller.signal, mock.stream);
		try {
			for await (const event of stream) events.push(event);
		} catch {
			// The run is aborted; the settlement classification is what matters.
		}
		const settled = settlements(events)[0]?.event;
		if (settled?.type !== "settled") throw new Error("expected a settlement");
		expect(settled.outcome.kind).toBe("interrupted");
		if (settled.outcome.kind !== "interrupted") throw new Error("expected an interruption");
		expect(settled.outcome.reason).toBe("User interrupted the run");
	});

	it("keeps a genuine executor failure classified as failed", async () => {
		const tool = streamingTool();
		const failing: AgentTool<typeof toolSchema, { value: string }> = {
			...tool,
			async execute() {
				throw new Error("the tool itself is broken");
			},
		};
		const events = await runLoop(failing, { getToolContext: threadingHost() });
		const settled = settlements(events)[0]?.event;
		if (settled?.type !== "settled") throw new Error("expected a settlement");
		expect(settled.outcome.kind).toBe("failed");
		if (settled.outcome.kind !== "failed") throw new Error("expected a failure");
		expect(settled.outcome.failure.reason).toBe("thrown");
	});
});

/** The same tool, minus a `presentation` adapter — dispatches on the legacy protocol. */
function legacyTool(): AgentTool<typeof toolSchema, { value: string }> {
	const tool = streamingTool();
	return { ...tool, presentation: undefined };
}

describe("add_guidance_fact effect", () => {
	const guidanceEffect: AgentLoopConfig["afterToolCall"] = async () => ({
		kind: "add_guidance_fact",
		fact: { kind: "model_guidance", source: "ttsr", text: "<reminder>run the tests</reminder>" },
	});

	it("declares exactly one model_guidance fact on the open presentation stream before settled", async () => {
		const events = await runLoop(streamingTool(), {
			getToolContext: threadingHost(),
			afterToolCall: guidanceEffect,
		});
		const presentation = presentationEvents(events);
		const factIndices = presentation
			.map((event, index) => ({ event, index }))
			.filter(({ event }) => event.event.type === "fact");
		expect(factIndices).toHaveLength(1);
		const factEvent = factIndices[0]!.event.event;
		if (factEvent.type !== "fact") throw new Error("expected a fact event");
		expect(factEvent.fact.kind).toBe("model_guidance");
		// The stream (not the coordinator) mints the id, keyed off its own streamId.
		expect(factEvent.fact.id).toBe(factId("call-1:f0"));
		const settledIndex = presentation.findIndex(event => event.event.type === "settled");
		expect(settledIndex).toBeGreaterThan(-1);
		expect(factIndices[0]!.index).toBeLessThan(settledIndex);
		// Goldens unchanged: the text is still prepended into the emitted result content.
		const settledEvent = presentation[settledIndex]?.event;
		if (settledEvent?.type !== "settled") throw new Error("expected a settlement");
		const modelContent = settledEvent.modelContent ?? [];
		const text = modelContent
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map(part => part.text)
			.join("\n");
		expect(text).toContain("<reminder>run the tests</reminder>");
	});

	it("declares no fact for a legacy call — the guidance text still only lands in content", async () => {
		const events = await runLoop(legacyTool(), { afterToolCall: guidanceEffect });
		expect(startProtocol(events)).toBe("legacy_snapshot");
		const factEvents = presentationEvents(events).filter(event => event.event.type === "fact");
		expect(factEvents).toHaveLength(0);
		const end = events.find(event => event.type === "tool_execution_end");
		if (end?.type !== "tool_execution_end") throw new Error("expected a legacy tool_execution_end");
		const content = end.result.content as readonly { type: string; text?: string }[];
		const text = content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map(part => part.text)
			.join("\n");
		expect(text).toContain("<reminder>run the tests</reminder>");
	});

	it("keeps a thrown tool's failure through the guidance re-coercion — annotates, never absolves", async () => {
		const tool = streamingTool();
		const throwing: AgentTool<typeof toolSchema, { value: string }> = {
			...tool,
			async execute() {
				throw new Error("the tool itself is broken");
			},
		};
		const events = await runLoop(throwing, {
			getToolContext: threadingHost(),
			afterToolCall: guidanceEffect,
		});
		// The caught throw's synthesized result carries no isError field of its
		// own; the guidance-only effect must re-coerce from the derived failure
		// state, not launder the call into a success.
		const end = events.find(event => event.type === "tool_execution_end");
		if (end?.type !== "tool_execution_end") throw new Error("expected a tool_execution_end");
		expect(end.isError).toBe(true);
		const settled = settlements(events)[0]?.event;
		if (settled?.type !== "settled") throw new Error("expected a settlement");
		expect(settled.outcome.kind).toBe("failed");
		// The guidance text still rides the (failed) result content.
		const content = end.result.content as readonly { type: string; text?: string }[];
		const text = content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
		expect(text).toContain("<reminder>run the tests</reminder>");
		expect(text).toContain("the tool itself is broken");
	});
});
