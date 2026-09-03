/**
 * Tests for OpenTelemetry instrumentation in the agent loop.
 *
 * Uses InMemorySpanExporter to capture spans synchronously and assert on
 * span names, attributes, parent/child relationships, status codes, and
 * lifecycle hook dispatch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import {
	type AgentTelemetryConfig,
	type ChatUsageEvent,
	classifyGatewayResponseCacheStatus,
	detectGatewayFromHeaders,
	GenAIAttr,
	GenAIOperation,
	OpenAIAttr,
	PiGenAIAttr,
	recordHandoff,
	recordManualChatTelemetry,
	resolveTelemetry,
	type TelemetryHookContext,
} from "@oh-my-pi/pi-agent-core/telemetry";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { EventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createUserMessage } from "./helpers";

const MOCK_IDENT = { id: "mock-model", provider: "mock-provider" } as const;

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;

beforeAll(() => {
	trace.disable();
	context.disable();
	contextManager = new AsyncLocalStorageContextManager().enable();
	context.setGlobalContextManager(contextManager);
	provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
	exporter.reset();
});

afterAll(async () => {
	await provider.shutdown();
	context.disable();
	trace.disable();
});

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

async function runAndDrain(stream: EventStream<AgentEvent, AgentMessage[]>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
	return spans.find(s => s.name === name);
}

function spansByName(spans: ReadableSpan[], name: string): ReadableSpan[] {
	return spans.filter(s => s.name === name);
}

describe("agent-loop OTEL instrumentation", () => {
	it("emits no spans when telemetry is unset (zero-cost path)", async () => {
		const mock = createMockModel({ ...MOCK_IDENT, responses: [{ content: ["ok"] }] });
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		expect(exporter.getFinishedSpans()).toHaveLength(0);
	});

	it("emits invoke_agent → chat hierarchy with OTEL and pi.gen_ai extension attributes", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [
				{
					content: ["hello"],
					stopReason: "stop",
					usage: {
						input: 12,
						output: 34,
						cacheRead: 5,
						cacheWrite: 7,
						totalTokens: 58,
						reasoningTokens: 11,
					},
				},
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			sessionId: "conv-42",
			temperature: 0.7,
			topP: 0.95,
			maxTokens: 1024,
			presencePenalty: 0.1,
			telemetry: { agent: { id: "agent-1", name: "researcher", description: "test-agent" } },
		};
		const ctx: AgentContext = { systemPrompt: ["you are helpful"], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const finished = exporter.getFinishedSpans();
		const invoke = findSpan(finished, "invoke_agent researcher");
		const chat = findSpan(finished, "chat mock-model");
		expect(invoke).toBeDefined();
		expect(chat).toBeDefined();
		expect(chat?.parentSpanContext?.spanId).toBe(invoke?.spanContext().spanId);

		// invoke_agent envelope
		expect(invoke?.attributes[GenAIAttr.OperationName]).toBe(GenAIOperation.InvokeAgent);
		expect(invoke?.attributes[GenAIAttr.AgentId]).toBe("agent-1");
		expect(invoke?.attributes[GenAIAttr.AgentName]).toBe("researcher");
		expect(invoke?.attributes[GenAIAttr.AgentDescription]).toBe("test-agent");
		expect(invoke?.attributes[GenAIAttr.ConversationId]).toBe("conv-42");
		expect(invoke?.attributes[PiGenAIAttr.AgentStepCount]).toBe(1);

		// chat envelope
		expect(chat?.attributes[GenAIAttr.OperationName]).toBe(GenAIOperation.Chat);
		expect(chat?.attributes[GenAIAttr.ProviderName]).toBe("mock-provider");
		expect(chat?.attributes[GenAIAttr.RequestModel]).toBe("mock-model");
		expect(chat?.attributes[GenAIAttr.RequestMaxTokens]).toBe(1024);
		expect(chat?.attributes[GenAIAttr.RequestTemperature]).toBe(0.7);
		expect(chat?.attributes[GenAIAttr.RequestTopP]).toBe(0.95);
		expect(chat?.attributes[GenAIAttr.RequestPresencePenalty]).toBe(0.1);
		expect(chat?.attributes[GenAIAttr.RequestChoiceCount]).toBeUndefined();
		expect(chat?.attributes[PiGenAIAttr.AgentStepNumber]).toBe(0);
		expect(chat?.attributes[GenAIAttr.RequestStream]).toBe(true);
		expect(chat?.attributes[GenAIAttr.OutputType]).toBe("text");

		// chat response/usage
		expect(chat?.attributes[GenAIAttr.ResponseModel]).toBe("mock-model");
		expect(chat?.attributes[GenAIAttr.ResponseFinishReasons]).toEqual(["stop"]);
		expect(chat?.attributes[GenAIAttr.UsageInputTokens]).toBe(24);
		expect(chat?.attributes[GenAIAttr.UsageOutputTokens]).toBe(34);
		expect(chat?.attributes[PiGenAIAttr.UsageTotalTokens]).toBe(58);
		expect(chat?.attributes[GenAIAttr.UsageCacheReadInputTokens]).toBe(5);
		expect(chat?.attributes[GenAIAttr.UsageCacheCreationInputTokens]).toBe(7);
		expect(chat?.attributes[GenAIAttr.UsageReasoningOutputTokens]).toBe(11);
	});

	it("normalizes provider and service-tier attributes to OTEL keys", async () => {
		const googleMock = createMockModel({
			id: "gemini-mock",
			provider: "google",
			responses: [{ content: ["ok"] }],
		});
		await runAndDrain(
			agentLoop(
				[createUserMessage("hi")],
				{ systemPrompt: [], messages: [], tools: [] },
				{ model: googleMock.model, convertToLlm: identityConverter, telemetry: {} },
				undefined,
				googleMock.stream,
			),
		);

		const googleChat = findSpan(exporter.getFinishedSpans(), "chat gemini-mock");
		expect(googleChat?.attributes[GenAIAttr.ProviderName]).toBe("gcp.gemini");
		expect(googleChat?.attributes["gen_ai.system"]).toBeUndefined();

		exporter.reset();
		const openAiMock = createMockModel({
			id: "gpt-mock",
			provider: "openai",
			responses: [{ content: ["ok"] }],
		});
		await runAndDrain(
			agentLoop(
				[createUserMessage("hi")],
				{ systemPrompt: [], messages: [], tools: [] },
				{
					model: openAiMock.model,
					convertToLlm: identityConverter,
					serviceTier: "priority",
					telemetry: {},
				},
				undefined,
				openAiMock.stream,
			),
		);

		const openAiChat = findSpan(exporter.getFinishedSpans(), "chat gpt-mock");
		expect(openAiChat?.attributes[OpenAIAttr.RequestServiceTier]).toBe("priority");
		expect(openAiChat?.attributes["gen_ai.request.service_tier"]).toBeUndefined();
	});

	it("emits execute_tool spans parented to invoke_agent (not chat) per semconv", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [
				{ content: [{ type: "toolCall", id: "tc-1", name: "alpha", arguments: { value: "x" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: {},
		};
		const alphaSchema = type({ value: type("string") });
		const alphaTool: AgentTool<typeof alphaSchema> = {
			name: "alpha",
			label: "Alpha",
			description: "echoes input",
			parameters: alphaSchema,
			execute: async () => ({ content: [{ type: "text", text: "alpha-result" }], details: {} }),
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [alphaTool] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const finished = exporter.getFinishedSpans();
		const invoke = findSpan(finished, "invoke_agent");
		const tool = findSpan(finished, "execute_tool alpha");
		const chatSpans = spansByName(finished, "chat mock-model");
		expect(invoke).toBeDefined();
		expect(tool).toBeDefined();
		expect(chatSpans).toHaveLength(2); // tool turn + follow-up

		expect(tool?.parentSpanContext?.spanId).toBe(invoke?.spanContext().spanId);
		expect(tool?.attributes[GenAIAttr.OperationName]).toBe(GenAIOperation.ExecuteTool);
		expect(tool?.attributes[GenAIAttr.ToolName]).toBe("alpha");
		expect(tool?.attributes[GenAIAttr.ToolCallId]).toBe("tc-1");
		expect(tool?.attributes[GenAIAttr.ToolType]).toBe("function");
		expect(tool?.attributes[GenAIAttr.ToolDescription]).toBe("echoes input");
		expect(tool?.status.code).toBe(SpanStatusCode.UNSET);

		// pi.gen_ai.agent.step.count counts chat completions
		expect(invoke?.attributes[PiGenAIAttr.AgentStepCount]).toBe(2);
	});

	it("parents downstream spans created during tool execution (active-context propagation)", async () => {
		const userTracer = trace.getTracer("user-tool");
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [
				{ content: [{ type: "toolCall", id: "tc-1", name: "probe", arguments: { value: "x" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: {},
		};
		const probeSchema = type({ value: type("string") });
		const probeTool: AgentTool<typeof probeSchema> = {
			name: "probe",
			label: "Probe",
			description: "creates a child span during execute",
			parameters: probeSchema,
			execute: async () => {
				const inner = userTracer.startSpan("user-work-inside-tool");
				inner.end();
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [probeTool] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const finished = exporter.getFinishedSpans();
		const tool = findSpan(finished, "execute_tool probe");
		const userInner = findSpan(finished, "user-work-inside-tool");
		expect(tool).toBeDefined();
		expect(userInner).toBeDefined();
		expect(userInner?.parentSpanContext?.spanId).toBe(tool?.spanContext().spanId);
	});

	it("records ERROR status + exception when a tool throws", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [
				{ content: [{ type: "toolCall", id: "tc-1", name: "fail", arguments: { value: "x" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: {},
		};
		const failSchema = type({ value: type("string") });
		const failTool: AgentTool<typeof failSchema> = {
			name: "fail",
			label: "Fail",
			description: "throws",
			parameters: failSchema,
			execute: async () => {
				throw new Error("boom");
			},
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [failTool] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const tool = findSpan(exporter.getFinishedSpans(), "execute_tool fail");
		expect(tool).toBeDefined();
		expect(tool?.status.code).toBe(SpanStatusCode.ERROR);
		expect(tool?.attributes[GenAIAttr.ErrorType]).toBe("Error");
		expect(tool?.events.some(e => e.name === "exception")).toBe(true);
	});

	it("emits ERROR status on chat spans when stopReason is error", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [{ throw: "provider returned 500" }],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: {},
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(chat).toBeDefined();
		expect(chat?.status.code).toBe(SpanStatusCode.ERROR);
		expect(chat?.attributes[GenAIAttr.ErrorType]).toBe("error");
		expect(chat?.attributes[GenAIAttr.ResponseFinishReasons]).toEqual(["error"]);
	});

	it("captures request/response content when captureMessageContent is true", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [{ content: ["hi back"], stopReason: "stop" }],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: { captureMessageContent: true },
		};
		const ctx: AgentContext = { systemPrompt: ["sys-instruction"], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		const inputs = chat?.attributes[GenAIAttr.InputMessages] as string | undefined;
		const outputs = chat?.attributes[GenAIAttr.OutputMessages] as string | undefined;
		const systemAttr = chat?.attributes[GenAIAttr.SystemInstructions] as string | undefined;
		expect(typeof inputs).toBe("string");
		expect(JSON.parse(inputs!)).toEqual([{ role: "user", parts: [{ type: "text", content: "hi" }] }]);
		expect(typeof outputs).toBe("string");
		expect(JSON.parse(outputs!)).toEqual([
			{ role: "assistant", parts: [{ type: "text", content: "hi back" }], finish_reason: "stop" },
		]);
		expect(JSON.parse(systemAttr!)).toEqual([{ type: "text", content: "sys-instruction" }]);
	});

	it("captures string systemPrompt without crashing when captureMessageContent is true", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [{ content: ["hi back"], stopReason: "stop" }],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: { captureMessageContent: true },
		};
		// Providers normalize systemPrompt to `string | string[]`; telemetry must accept a bare string.
		const ctx: AgentContext = { systemPrompt: "sys-as-string" as unknown as string[], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(chat).toBeDefined();
		expect(chat?.status.code).not.toBe(SpanStatusCode.ERROR);
		const systemAttr = chat?.attributes[GenAIAttr.SystemInstructions] as string | undefined;
		expect(JSON.parse(systemAttr!)).toEqual([{ type: "text", content: "sys-as-string" }]);
		const request = JSON.parse(chat?.attributes[PiGenAIAttr.RequestMessages] as string) as Array<{
			content: unknown;
			role: string;
		}>;
		expect(request.filter(message => message.role === "system")).toHaveLength(1);
	});

	it("captures bounded dashboard summary content when requested", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [{ content: ["hi back"], stopReason: "stop" }],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: { captureMessageContent: "summary" },
		};
		const ctx: AgentContext = { systemPrompt: ["sys-instruction"], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		const request = JSON.parse(chat?.attributes[PiGenAIAttr.RequestMessages] as string) as Array<{
			content: unknown;
			role: string;
		}>;
		const responseText = JSON.parse(chat?.attributes[PiGenAIAttr.ResponseText] as string);
		expect(request.map(message => message.role)).toEqual(["system", "user"]);
		expect(responseText).toEqual(["hi back"]);
		expect(chat?.attributes[GenAIAttr.InputMessages]).toBeUndefined();
		expect(chat?.attributes[GenAIAttr.OutputMessages]).toBeUndefined();
	});

	it("invokes costEstimator and stamps pi.gen_ai.cost.estimated_usd", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [
				{
					content: ["ok"],
					stopReason: "stop",
					usage: {
						input: 1000,
						output: 500,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1500,
					},
				},
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: {
				costEstimator: input => ({
					usd: (input.usage.inputTokens / 1_000_000) * 3 + (input.usage.outputTokens / 1_000_000) * 15,
					inputUsd: (input.usage.inputTokens / 1_000_000) * 3,
					outputUsd: (input.usage.outputTokens / 1_000_000) * 15,
				}),
			},
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(chat?.attributes[PiGenAIAttr.CostEstimatedUsd]).toBeCloseTo(0.0105, 6);
		expect(chat?.attributes[PiGenAIAttr.CostInputUsd]).toBeCloseTo(0.003, 6);
		expect(chat?.attributes[PiGenAIAttr.CostOutputUsd]).toBeCloseTo(0.0075, 6);
	});

	it("applies dynamic attributes, normalization hooks, and cost deltas", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [
				{
					content: ["ok"],
					stopReason: "stop",
					usage: {
						input: 200,
						output: 100,
						cacheRead: 5,
						cacheWrite: 0,
						totalTokens: 305,
					},
				},
			],
		});
		const deltas: Array<{
			costUsd: number | undefined;
			model: string;
			provider: string;
			stepNumber: number | undefined;
		}> = [];

		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: {
				agent: { name: "prefix.worker" },
				normalizeAgentName: name => name?.replace(/^prefix\./, ""),
				normalizeProvider: provider => (provider === "mock-provider" ? "normalized-provider" : provider),
				resolveAttributes: ctx => ({ "tenant.id": "tenant-1", "telemetry.kind": ctx.kind }),
				costEstimator: () => ({ usd: 0.25 }),
				onCostDelta: delta => deltas.push(delta),
			},
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const invoke = findSpan(exporter.getFinishedSpans(), "invoke_agent worker");
		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(invoke?.attributes[GenAIAttr.AgentName]).toBe("worker");
		expect(chat?.attributes[GenAIAttr.ProviderName]).toBe("normalized-provider");
		expect(chat?.attributes["tenant.id"]).toBe("tenant-1");
		expect(deltas).toHaveLength(1);
		expect(deltas[0]?.costUsd).toBe(0.25);
		expect(deltas[0]?.model).toBe("mock-model");
		expect(deltas[0]?.provider).toBe("normalized-provider");
		expect(deltas[0]?.stepNumber).toBe(0);
	});

	it("emits pi.gen_ai.cost.unavailable_reason when the estimator declines", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [{ content: ["ok"], stopReason: "stop" }],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: { costEstimator: () => ({ unavailable: "unsupported_tier" }) },
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(chat?.attributes[PiGenAIAttr.CostUnavailableReason]).toBe("unsupported_tier");
		expect(chat?.attributes[PiGenAIAttr.CostEstimatedUsd]).toBeUndefined();
	});

	it("fires onChatUsage for every chat step regardless of cost estimator", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [
				{
					content: ["ok"],
					stopReason: "stop",
					usage: { input: 50, output: 25, cacheRead: 10, totalTokens: 85 },
				},
			],
		});
		const events: ChatUsageEvent[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: {
				agent: { id: "agent-1", name: "worker" },
				resolveAttributes: ctx => ({ "tenant.id": "tenant-7", "telemetry.kind": ctx.kind }),
				normalizeProvider: provider => (provider === "mock-provider" ? "normalized-provider" : provider),
				onChatUsage: event => {
					events.push(event);
				},
			},
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		expect(events).toHaveLength(1);
		const ev = events[0];
		expect(ev?.model).toBe("mock-model");
		expect(ev?.provider).toBe("normalized-provider");
		expect(ev?.stepNumber).toBe(0);
		expect(ev?.agent).toEqual({ id: "agent-1", name: "worker" });
		expect(ev?.usage.inputTokens).toBe(60);
		expect(ev?.usage.outputTokens).toBe(25);
		expect(ev?.usage.cachedInputTokens).toBe(10);
		expect(ev?.usage.totalTokens).toBe(85);
		expect(ev?.cost).toBeUndefined();
		expect(ev?.attributes?.["tenant.id"]).toBe("tenant-7");
		expect(ev?.attributes?.["telemetry.kind"]).toBe("chat");
		expect(ev?.span).toBeDefined();
	});

	it("forwards cost estimate to onChatUsage when estimator is configured", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [{ content: ["ok"], stopReason: "stop", usage: { input: 100, output: 50, totalTokens: 150 } }],
		});
		const events: ChatUsageEvent[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: {
				costEstimator: () => ({ usd: 0.05, inputUsd: 0.01, outputUsd: 0.04 }),
				onChatUsage: event => {
					events.push(event);
				},
			},
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		expect(events).toHaveLength(1);
		const cost = events[0]?.cost;
		expect(cost && "usd" in cost ? cost.usd : undefined).toBe(0.05);
		expect(cost && "usd" in cost ? cost.inputUsd : undefined).toBe(0.01);
		expect(cost && "usd" in cost ? cost.outputUsd : undefined).toBe(0.04);
	});

	it("propagates unavailable cost reason to onChatUsage", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [{ content: ["ok"], stopReason: "stop", usage: { input: 10, output: 5, totalTokens: 15 } }],
		});
		const events: ChatUsageEvent[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: {
				costEstimator: () => ({ unavailable: "unsupported_tier" }),
				onChatUsage: event => {
					events.push(event);
				},
			},
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		expect(events).toHaveLength(1);
		const cost = events[0]?.cost;
		expect(cost && "unavailable" in cost ? cost.unavailable : undefined).toBe("unsupported_tier");
	});

	it("skips onChatUsage in recordManualChatTelemetry when usage is undefined", async () => {
		const events: ChatUsageEvent[] = [];
		const telemetry = resolveTelemetry(
			{
				onChatUsage: event => {
					events.push(event);
				},
			},
			undefined,
		);
		const mock = createMockModel({ ...MOCK_IDENT, responses: [] });
		await recordManualChatTelemetry(telemetry, {
			model: mock.model,
			responseModel: "manual-model",
			stepNumber: 0,
		});
		expect(events).toHaveLength(0);

		await recordManualChatTelemetry(telemetry, {
			model: mock.model,
			responseModel: "manual-model",
			usage: {
				input: 7,
				output: 3,
				totalTokens: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stepNumber: 1,
		});
		expect(events).toHaveLength(1);
		expect(events[0]?.model).toBe("manual-model");
		expect(events[0]?.stepNumber).toBe(1);
		expect(events[0]?.usage.inputTokens).toBe(7);
	});

	it("captures async onChatUsage rejections via onTelemetryWarning", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [{ content: ["ok"], stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2 } }],
		});
		const warnings: string[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: {
				onChatUsage: async () => {
					throw new Error("async boom");
				},
				onTelemetryWarning: warning => warnings.push(warning.code),
			},
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));
		await Bun.sleep(1);

		expect(warnings).toContain("on_chat_usage_failed");
	});

	it("fires onSpanStart and onSpanEnd for every kind", async () => {
		const starts: TelemetryHookContext[] = [];
		const ends: TelemetryHookContext[] = [];
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [
				{ content: [{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "x" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: {
				agent: { id: "a", name: "main" },
				onSpanStart: ctx => starts.push(ctx),
				onSpanEnd: ctx => ends.push(ctx),
			},
		};
		const echoSchema = type({ value: type("string") });
		const echoTool: AgentTool<typeof echoSchema> = {
			name: "echo",
			label: "Echo",
			description: "echo",
			parameters: echoSchema,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [echoTool] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const startKinds = starts.map(s => s.kind);
		const endKinds = ends.map(s => s.kind);
		expect(startKinds).toEqual(["invoke_agent", "chat", "execute_tool", "chat"]);
		expect(endKinds).toEqual(["chat", "execute_tool", "chat", "invoke_agent"]);
		expect(starts.find(s => s.kind === "execute_tool")?.toolName).toBe("echo");
		expect(starts.find(s => s.kind === "execute_tool")?.toolCallId).toBe("tc-1");
	});

	it("recordHandoff emits a one-shot handoff span with from/to agent identity", async () => {
		const telemetry = resolveTelemetry({}, "conv-1");
		expect(telemetry).toBeDefined();
		recordHandoff(telemetry, {
			fromAgent: { id: "a", name: "main" },
			toAgent: { id: "b", name: "specialist" },
		});

		const span = findSpan(exporter.getFinishedSpans(), "handoff main → specialist");
		expect(span).toBeDefined();
		expect(span?.attributes[GenAIAttr.OperationName]).toBe(GenAIOperation.Handoff);
		expect(span?.attributes[PiGenAIAttr.HandoffFromAgentName]).toBe("main");
		expect(span?.attributes[PiGenAIAttr.HandoffToAgentName]).toBe("specialist");
		expect(span?.attributes[GenAIAttr.ConversationId]).toBe("conv-1");
	});

	it("records manual chat telemetry for non-loop model calls", async () => {
		const telemetry = resolveTelemetry(
			{
				costEstimator: () => ({ usd: 0.02 }),
			},
			"manual-conv",
		);
		expect(telemetry).toBeDefined();

		const mock = createMockModel({ ...MOCK_IDENT });
		await recordManualChatTelemetry(telemetry, {
			model: mock.model,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 2,
				cacheWrite: 0,
				totalTokens: 17,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			finishReason: "stop",
			responseText: "manual ok",
			stepNumber: 7,
		});

		const span = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(span?.attributes[GenAIAttr.ConversationId]).toBe("manual-conv");
		expect(span?.attributes[PiGenAIAttr.AgentStepNumber]).toBe(7);
		expect(span?.attributes[PiGenAIAttr.UsageTotalTokens]).toBe(17);
		expect(span?.attributes[PiGenAIAttr.CostEstimatedUsd]).toBe(0.02);
		expect(JSON.parse(span?.attributes[PiGenAIAttr.ResponseText] as string)).toEqual(["manual ok"]);
	});

	it("reads OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT once at first resolveTelemetry call", () => {
		// The env var is parsed once and cached for the lifetime of the process so
		// every span pays the same lookup cost. Once an earlier test has hit
		// `resolveTelemetry`, the cache is already primed; covering this contract
		// requires only that the explicit `captureMessageContent` field on the
		// config still wins over the cached env value.
		const before = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
		try {
			process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "true";
			const overridden = resolveTelemetry({ captureMessageContent: false }, undefined);
			expect(overridden?.captureMessageContent).toBe(false);
			const enabled = resolveTelemetry({ captureMessageContent: true }, undefined);
			expect(enabled?.captureMessageContent).toBe(true);
		} finally {
			if (before === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
			else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = before;
		}
	});

	it("attaches user-supplied attributes to every span", async () => {
		const cfg: AgentTelemetryConfig = {
			attributes: { "deployment.environment": "prod", "service.name": "test-svc" },
		};
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [
				{ content: [{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "x" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: cfg,
		};
		const echoSchema = type({ value: type("string") });
		const tool: AgentTool<typeof echoSchema> = {
			name: "echo",
			label: "Echo",
			description: "",
			parameters: echoSchema,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [tool] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		for (const span of exporter.getFinishedSpans()) {
			expect(span.attributes["deployment.environment"]).toBe("prod");
			expect(span.attributes["service.name"]).toBe("test-svc");
		}
	});
});

describe("detectGatewayFromHeaders", () => {
	it("identifies LiteLLM via x-litellm-call-id and resolves routed_to from x-litellm-model-id", () => {
		const detection = detectGatewayFromHeaders({
			"x-litellm-call-id": "call-abc-123",
			"x-litellm-model-id": "anthropic/claude-sonnet-4-7",
			"x-litellm-version": "1.59.2",
		});
		expect(detection).toEqual({
			name: "litellm",
			callId: "call-abc-123",
			routedTo: "anthropic/claude-sonnet-4-7",
		});
	});

	it("falls back to x-litellm-model-group when model-id is absent", () => {
		const detection = detectGatewayFromHeaders({
			"x-litellm-call-id": "call-xyz",
			"x-litellm-model-group": "claude-fast",
		});
		expect(detection?.routedTo).toBe("claude-fast");
	});

	it("identifies Helicone via helicone-id", () => {
		const detection = detectGatewayFromHeaders({
			"helicone-id": "req_42",
			"helicone-target-provider": "openai",
		});
		expect(detection).toEqual({ name: "helicone", callId: "req_42", routedTo: "openai" });
	});

	it("identifies Portkey via x-portkey-trace-id with provider routing", () => {
		const detection = detectGatewayFromHeaders({
			"x-portkey-trace-id": "trace_99",
			"x-portkey-llm-provider": "anthropic",
		});
		expect(detection).toEqual({ name: "portkey", callId: "trace_99", routedTo: "anthropic" });
	});

	it("identifies OpenRouter via x-generation-id with gen- prefix", () => {
		expect(detectGatewayFromHeaders({ "x-generation-id": "gen-1234567890" })).toEqual({
			name: "openrouter",
			callId: "gen-1234567890",
			routedTo: undefined,
		});
	});

	it("ignores x-generation-id without the OpenRouter gen- prefix", () => {
		expect(detectGatewayFromHeaders({ "x-generation-id": "1234567890" })).toBeUndefined();
	});

	it("falls back to x-portkey-request-id when trace id is absent", () => {
		expect(detectGatewayFromHeaders({ "x-portkey-request-id": "rq_1" })?.callId).toBe("rq_1");
	});

	it("returns undefined when no known gateway header is present", () => {
		expect(detectGatewayFromHeaders({})).toBeUndefined();
		expect(
			detectGatewayFromHeaders({
				"content-type": "application/json",
				"x-request-id": "rid",
			}),
		).toBeUndefined();
		expect(detectGatewayFromHeaders(undefined)).toBeUndefined();
	});

	it("prefers LiteLLM detection over Helicone when both header families are present", () => {
		const detection = detectGatewayFromHeaders({
			"x-litellm-call-id": "ll-1",
			"helicone-id": "he-1",
		});
		expect(detection?.name).toBe("litellm");
	});

	it("still identifies known gateways when Cloudflare response-cache headers are also present", () => {
		expect(
			detectGatewayFromHeaders({
				"x-litellm-call-id": "ll-cf",
				"cf-aig-cache-status": "HIT",
			})?.name,
		).toBe("litellm");
		expect(
			detectGatewayFromHeaders({
				"helicone-id": "he-cf",
				"cf-aig-cache-status": "MISS",
			})?.name,
		).toBe("helicone");
		expect(
			detectGatewayFromHeaders({
				"x-portkey-trace-id": "pk-cf",
				"cf-aig-cache-status": "BYPASS",
			})?.name,
		).toBe("portkey");
		expect(
			detectGatewayFromHeaders({
				"x-generation-id": "gen-cf-1",
				"cf-aig-cache-status": "HIT",
			})?.name,
		).toBe("openrouter");
	});
});

describe("classifyGatewayResponseCacheStatus", () => {
	it("case-normalizes HIT/MISS/BYPASS to bounded response-cache statuses", () => {
		expect(classifyGatewayResponseCacheStatus({ "cf-aig-cache-status": "HIT" })).toBe("hit");
		expect(classifyGatewayResponseCacheStatus({ "cf-aig-cache-status": " miss " })).toBe("miss");
		expect(classifyGatewayResponseCacheStatus({ "cf-aig-cache-status": "ByPaSs" })).toBe("bypass");
	});

	it("maps unrecognized present values to unknown", () => {
		expect(classifyGatewayResponseCacheStatus({ "cf-aig-cache-status": "EXPIRED" })).toBe("unknown");
		expect(classifyGatewayResponseCacheStatus({ "cf-aig-cache-status": "" })).toBe("unknown");
	});

	it("ignores non-allow-listed Cloudflare headers and absent maps", () => {
		expect(
			classifyGatewayResponseCacheStatus({
				"cf-aig-cache-ttl": "3600",
				"cf-aig-skip-cache": "true",
				"cf-aig-cache-key": "k1",
				"cf-ray": "abc",
			}),
		).toBeUndefined();
		expect(classifyGatewayResponseCacheStatus({})).toBeUndefined();
		expect(classifyGatewayResponseCacheStatus(undefined)).toBeUndefined();
	});
});

describe("ChatUsageEvent.headers and pi.gen_ai.gateway.* span attributes", () => {
	it("forwards captured response headers to onChatUsage", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [
				{
					content: ["ok"],
					usage: { input: 10, output: 5, totalTokens: 15 },
					responseHeaders: {
						"X-Request-Id": "upstream-req-77",
						"content-type": "application/json",
					},
				},
			],
		});
		const events: ChatUsageEvent[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: { onChatUsage: event => void events.push(event) },
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		expect(events).toHaveLength(1);
		// Header keys are normalized to lowercase to match `ProviderResponseMetadata.headers`.
		expect(events[0]?.headers).toEqual({
			"x-request-id": "upstream-req-77",
			"content-type": "application/json",
		});
	});

	it("leaves ChatUsageEvent.headers undefined when the provider does not surface headers", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [{ content: ["ok"], usage: { input: 1, output: 1, totalTokens: 2 } }],
		});
		const events: ChatUsageEvent[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: { onChatUsage: event => void events.push(event) },
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		expect(events).toHaveLength(1);
		expect(events[0]?.headers).toBeUndefined();
	});

	it("auto-stamps pi.gen_ai.gateway.* on the chat span when LiteLLM headers are present", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [
				{
					content: ["ok"],
					usage: { input: 4, output: 2, totalTokens: 6 },
					responseHeaders: {
						"x-litellm-call-id": "ll-call-abc",
						"x-litellm-model-id": "anthropic/claude-sonnet-4-7",
						"x-litellm-version": "1.59.2",
					},
				},
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: {},
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(chat?.attributes[PiGenAIAttr.GatewayName]).toBe("litellm");
		expect(chat?.attributes[PiGenAIAttr.GatewayCallId]).toBe("ll-call-abc");
		expect(chat?.attributes[PiGenAIAttr.GatewayRoutedTo]).toBe("anthropic/claude-sonnet-4-7");
		expect(chat?.attributes[PiGenAIAttr.GatewayEndpoint]).toBe(mock.model.baseUrl);
	});

	it("does not stamp gateway attributes when headers carry no known pattern", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [
				{
					content: ["ok"],
					usage: { input: 4, output: 2, totalTokens: 6 },
					responseHeaders: { "x-request-id": "rid-1" },
				},
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: {},
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(chat?.attributes[PiGenAIAttr.GatewayName]).toBeUndefined();
		expect(chat?.attributes[PiGenAIAttr.GatewayCallId]).toBeUndefined();
		expect(chat?.attributes[PiGenAIAttr.GatewayEndpoint]).toBeUndefined();
	});

	it("still invokes the user-supplied onResponse alongside header capture", async () => {
		const seen: Array<Record<string, string>> = [];
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [
				{
					content: ["ok"],
					usage: { input: 1, output: 1, totalTokens: 2 },
					responseHeaders: { "x-litellm-call-id": "ll-2" },
				},
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			onResponse: response => {
				seen.push({ ...response.headers });
			},
			telemetry: {},
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		expect(seen).toHaveLength(1);
		expect(seen[0]?.["x-litellm-call-id"]).toBe("ll-2");
		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(chat?.attributes[PiGenAIAttr.GatewayName]).toBe("litellm");
	});

	it("stamps pi.gen_ai.gateway.response_cache.status from cf-aig-cache-status without prompt-cache attrs", async () => {
		const mock = createMockModel({
			...MOCK_IDENT,
			responses: [
				{
					content: ["ok"],
					usage: { input: 4, output: 2, totalTokens: 6 },
					responseHeaders: {
						"cf-aig-cache-status": "HIT",
						"cf-aig-cache-ttl": "3600",
						"cf-aig-cache-key": "secret-key",
						"cf-ray": "ray-should-not-leak",
						"x-custom-secret": "nope",
					},
				},
			],
		});
		const events: ChatUsageEvent[] = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			telemetry: { onChatUsage: event => void events.push(event) },
		};
		const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));

		const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
		expect(chat?.attributes[PiGenAIAttr.GatewayResponseCacheStatus]).toBe("hit");
		// Response replay must not inflate or invent provider prompt-cache token counters.
		// Mock usage defaults cacheRead/cacheWrite to 0; HIT must leave them at zero, not promote a hit.
		expect(chat?.attributes[GenAIAttr.UsageCacheReadInputTokens]).toBe(0);
		expect(chat?.attributes[GenAIAttr.UsageCacheCreationInputTokens]).toBe(0);
		// Only allow-listed classification — raw Cloudflare/custom headers stay off the span.
		expect(chat?.attributes["cf-aig-cache-status"]).toBeUndefined();
		expect(chat?.attributes["cf-aig-cache-ttl"]).toBeUndefined();
		expect(chat?.attributes["cf-aig-cache-key"]).toBeUndefined();
		expect(chat?.attributes["cf-ray"]).toBeUndefined();
		expect(chat?.attributes["x-custom-secret"]).toBeUndefined();
		// ChatUsageEvent.headers still forwards the full captured map unchanged.
		expect(events[0]?.headers?.["cf-aig-cache-status"]).toBe("HIT");
		expect(events[0]?.headers?.["cf-aig-cache-key"]).toBe("secret-key");
		expect(events[0]?.headers?.["x-custom-secret"]).toBe("nope");
	});

	it("classifies miss/bypass/unknown response-cache statuses on the chat span", async () => {
		const cases = [
			{ header: "MISS", expected: "miss" },
			{ header: "bypass", expected: "bypass" },
			{ header: "DYNAMIC", expected: "unknown" },
		] as const;
		for (const { header, expected } of cases) {
			exporter.reset();
			const mock = createMockModel({
				...MOCK_IDENT,
				responses: [
					{
						content: ["ok"],
						usage: { input: 1, output: 1, totalTokens: 2 },
						responseHeaders: { "cf-aig-cache-status": header },
					},
				],
			});
			const config: AgentLoopConfig = {
				model: mock.model,
				convertToLlm: identityConverter,
				telemetry: {},
			};
			const ctx: AgentContext = { systemPrompt: [], messages: [], tools: [] };
			await runAndDrain(agentLoop([createUserMessage("hi")], ctx, config, undefined, mock.stream));
			const chat = findSpan(exporter.getFinishedSpans(), "chat mock-model");
			expect(chat?.attributes[PiGenAIAttr.GatewayResponseCacheStatus]).toBe(expected);
		}
	});
});
