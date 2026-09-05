import { afterEach, describe, expect, test } from "bun:test";
import type { Http2Server, ServerHttp2Session, ServerHttp2Stream } from "node:http2";
import { type } from "@oh-my-pi/omptype";
import { createServer } from "node:http2";
import type {
	InferenceStreamRequest,
	InferenceStreamResponse,
	RunInferenceServerMessage,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import {
	CustomErrorDetailsSchema,
	ErrorDetailsSchema,
	InferenceExtendedUsageInfoSchema,
	InferenceModelConfigSchema,
	InferenceReasoningPartSchema,
	InferenceRequestedModelSchema,
	InferenceResponseInfoSchema,
	InferenceResponseMessageSchema,
	InferenceStreamRequestSchema,
	InferenceStreamResponseSchema,
	InferenceTextStreamPartSchema,
	InferenceThinkingStreamPartSchema,
	InferenceToolCallStreamPartSchema,
	RunInferenceClientMessageSchema,
	RunInferenceErrorDetailSchema,
	RunInferenceInvocationEndSchema,
	RunInferenceInvocationErrorSchema,
	RunInferenceInvocationResponseSchema,
	RunInferenceRunReadySchema,
	RunInferenceServerMessageSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { CONNECT_FLAG_END_STREAM, ConnectFrameDecoder, encodeConnectFrame } from "../src/providers/cursor/connect";
import { type CursorOptions, streamCursor } from "../src/providers/cursor";
import { streamSimple } from "../src/stream";
import type { AssistantMessage, ProviderSessionState } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

let server: Http2Server | undefined;
const sessions = new Set<ServerHttp2Session>();

afterEach(() => {
	for (const session of sessions) session.destroy();
	sessions.clear();
	server?.close();
	server = undefined;
});

function send(stream: ServerHttp2Stream, message: RunInferenceServerMessage): void {
	stream.write(encodeConnectFrame(toBinary(RunInferenceServerMessageSchema, message)));
}

function providerStatusDetail(status: number): Uint8Array {
	return toBinary(
		ErrorDetailsSchema,
		create(ErrorDetailsSchema, {
			details: create(CustomErrorDetailsSchema, { additionalInfo: { providerStatusCode: String(status) } }),
		}),
	);
}

interface LoopbackOptions {
	readonly toolCallName?: string;
	readonly rejectReasoningReplayOnReopenedRun?: boolean;
	readonly alwaysRejectWithProviderStatus?: boolean;
	readonly answerAfterToolResult?: boolean;
}

async function loopback(options: LoopbackOptions = {}): Promise<{
	readonly origin: string;
	readonly runRequests: () => number;
	readonly requestedModels: () => Array<{ readonly modelId: string; readonly parameters: string[] }>;
	readonly invocations: () => number;
	readonly invokeMaxTokens: () => number[];
	readonly invokeReasoningCounts: () => number[];
	readonly invokeStopSequences: () => string[][];
	readonly invokeToolCounts: () => number[];
	readonly sessions: () => number;
	readonly headers: () => Record<string, string> | undefined;
}> {
	const {
		toolCallName,
		rejectReasoningReplayOnReopenedRun = false,
		alwaysRejectWithProviderStatus = false,
		answerAfterToolResult = false,
	} = options;
	let runRequests = 0;
	const requestedModels: Array<{ readonly modelId: string; readonly parameters: string[] }> = [];
	let invocations = 0;
	let capturedHeaders: Record<string, string> | undefined;
	const invokeMaxTokens: number[] = [];
	const invokeReasoningCounts: number[] = [];
	const invokeStopSequences: string[][] = [];
	const invokeToolCounts: number[] = [];
	server = createServer();
	server.on("session", session => sessions.add(session));
	server.on("stream", (stream: ServerHttp2Stream, headers) => {
		let openedRun = 0;
		capturedHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)]));
		stream.respond({ ":status": 200, "content-type": "application/connect+proto", "x-loopback": "ok" });
		const decoder = new ConnectFrameDecoder();
		stream.on("data", (chunk: Uint8Array) => {
			for (const frame of decoder.push(chunk)) {
				const message = fromBinary(RunInferenceClientMessageSchema, frame.body);
				if (message.message.case === "runRequest") {
					openedRun = ++runRequests;
					const requested = message.message.value.requestedModel;
					requestedModels.push({
						modelId: requested?.modelId ?? "",
						parameters: requested?.parameters.map(parameter => `${parameter.id}=${parameter.value}`) ?? [],
					});
					send(
						stream,
						create(RunInferenceServerMessageSchema, {
							message: {
								case: "runReady",
								value: create(RunInferenceRunReadySchema, {
									resolvedModel: create(InferenceRequestedModelSchema, { modelId: "composer-2.5" }),
								}),
							},
						}),
					);
				}
				if (message.message.case === "invokeModel") {
					invocations++;
					const { invocationId, request } = message.message.value;
					const replaysOpaqueReasoning = request?.messages.some(message =>
						message.reasoningParts.some(part => part.signature !== ""),
					);
					invokeReasoningCounts.push(
						request?.messages.reduce((total, message) => total + message.reasoningParts.length, 0) ?? 0,
					);
					if (
						alwaysRejectWithProviderStatus ||
						(rejectReasoningReplayOnReopenedRun && openedRun > 1 && replaysOpaqueReasoning)
					) {
						send(
							stream,
							create(RunInferenceServerMessageSchema, {
								message: {
									case: "invocationEnd",
									value: create(RunInferenceInvocationEndSchema, {
										invocationId,
										error: create(RunInferenceInvocationErrorSchema, {
											code: 8,
											message: "Provider Error",
											details: [
												create(RunInferenceErrorDetailSchema, {
													type: "aiserver.v1.ErrorDetails",
													value: providerStatusDetail(400),
												}),
											],
										}),
									}),
								},
							}),
						);
						continue;
					}
					invokeMaxTokens.push(request?.modelConfig?.maxTokens ?? 0);
					invokeStopSequences.push(request?.modelConfig?.stopSequences ?? []);
					invokeToolCounts.push(request?.tools.length ?? 0);
					const response = (value: Partial<InferenceStreamResponse>) =>
						create(RunInferenceServerMessageSchema, {
							message: {
								case: "invocationResponse",
								value: create(RunInferenceInvocationResponseSchema, {
									invocationId,
									response: create(InferenceStreamResponseSchema, value),
								}),
							},
						});
					if (toolCallName !== undefined && (!answerAfterToolResult || invocations === 1)) {
						send(
							stream,
							response({
								response: {
									case: "toolCallPart",
									value: create(InferenceToolCallStreamPartSchema, {
										toolCallId: "omitted-tool",
										toolName: toolCallName,
										args: "{}",
										isComplete: true,
									}),
								},
							}),
						);
						send(
							stream,
							create(RunInferenceServerMessageSchema, {
								message: {
									case: "invocationEnd",
									value: create(RunInferenceInvocationEndSchema, { invocationId }),
								},
							}),
						);
						continue;
					}
					if (rejectReasoningReplayOnReopenedRun && invocations === 1) {
						send(
							stream,
							response({
								response: {
									case: "thinkingPart",
									value: create(InferenceThinkingStreamPartSchema, {
										signature: "opaque-run-1",
										isFinal: true,
									}),
								},
							}),
						);
					}
					send(
						stream,
						response({
							response: {
								case: "textPart",
								value: create(InferenceTextStreamPartSchema, {
									text: `stream-${invocations}`,
									isFinal: false,
								}),
							},
						}),
					);
					send(
						stream,
						response({
							response: {
								case: "textPart",
								value: create(InferenceTextStreamPartSchema, {
									text: `stream-${invocations}`,
									isFinal: true,
								}),
							},
						}),
					);
					send(
						stream,
						response({
							response: {
								case: "responseInfo",
								value: create(InferenceResponseInfoSchema, {
									id: `response-${invocations}`,
									model: "composer-2.5",
									messages: [
										create(InferenceResponseMessageSchema, {
											content: `final-${invocations}`,
											reasoningParts:
												rejectReasoningReplayOnReopenedRun && invocations === 1
													? [create(InferenceReasoningPartSchema, { signature: "opaque-run-1" })]
													: [],
										}),
									],
								}),
							},
						}),
					);
					send(
						stream,
						response({
							response: {
								case: "extendedUsage",
								value: create(InferenceExtendedUsageInfoSchema, {
									inputTokens: 4,
									outputTokens: 2,
									cacheReadTokens: 1,
								}),
							},
						}),
					);
					send(
						stream,
						create(RunInferenceServerMessageSchema, {
							message: {
								case: "invocationEnd",
								value: create(RunInferenceInvocationEndSchema, { invocationId }),
							},
						}),
					);
					if (rejectReasoningReplayOnReopenedRun && invocations === 1) {
						stream.end(encodeConnectFrame(new TextEncoder().encode("{}"), CONNECT_FLAG_END_STREAM));
					}
				}
				if (message.message.case === "finishRun") {
					stream.end(encodeConnectFrame(new TextEncoder().encode("{}"), CONNECT_FLAG_END_STREAM));
				}
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("loopback has no port");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		runRequests: () => runRequests,
		requestedModels: () => requestedModels,
		invocations: () => invocations,
		invokeMaxTokens: () => invokeMaxTokens,
		invokeReasoningCounts: () => invokeReasoningCounts,
		invokeStopSequences: () => invokeStopSequences,
		invokeToolCounts: () => invokeToolCounts,
		sessions: () => sessions.size,
		headers: () => capturedHeaders,
	};
}

function model(baseUrl: string) {
	return buildModel({
		id: "composer-2.5",
		name: "Composer 2.5",
		provider: "cursor",
		api: "cursor-agent",
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

async function collect(stream: AssistantMessageEventStream): Promise<{
	readonly events: string[];
	readonly result: AssistantMessage;
}> {
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	return { events, result: await stream.result() };
}

function closeProviderState(state: Map<string, ProviderSessionState>): void {
	for (const value of state.values()) value.close();
	state.clear();
}

describe("Cursor provider entrypoint", () => {
	test("surfaces missing credentials through the provider stream", async () => {
		const stream = streamCursor(
			model("http://127.0.0.1:1"),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{},
		);
		const { events, result } = await collect(stream);
		expect(events).toEqual(["start", "error"]);
		expect(result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("Cursor API key") });
	});

	test("classifies an embedded provider 400 instead of outer resource exhaustion", async () => {
		const target = await loopback({ alwaysRejectWithProviderStatus: true });
		const providerSessionState = new Map<string, ProviderSessionState>();
		try {
			const { result } = await collect(
				streamCursor(
					model(target.origin),
					{ messages: [{ role: "user", content: "reject this", timestamp: 1 }] },
					{
						apiKey: "HEADER.PAYLOAD.SIGNATURE",
						sessionId: "omp-provider-status",
						providerSessionState,
					},
				),
			);
			expect(result).toMatchObject({
				stopReason: "error",
				errorStatus: 400,
			});
			expect(result.errorMessage).toContain('"providerStatusCode":"400"');
			expect(result.errorMessage).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u);
		} finally {
			closeProviderState(providerSessionState);
		}
	});

	test("forwards public stop sequences and toolChoice none", async () => {
		const target = await loopback();
		const providerSessionState = new Map<string, ProviderSessionState>();
		try {
			const { result } = await collect(
				streamSimple(
					model(target.origin),
					{
						messages: [{ role: "user", content: "handoff", timestamp: 1 }],
						tools: [
							{
								name: "read",
								description: "Read a file.",
								parameters: { type: "object", properties: {}, additionalProperties: false },
							},
						],
					},
					{
						apiKey: "HEADER.PAYLOAD.SIGNATURE",
						sessionId: "omp-session",
						providerSessionState,
						stopSequences: ["STOP"],
						toolChoice: "none",
					},
				),
			);
			expect(result.content).toEqual([{ type: "text", text: "final-1" }]);
			expect(target.invokeStopSequences()).toEqual([["STOP"]]);
			expect(target.invokeToolCounts()).toEqual([0]);
		} finally {
			closeProviderState(providerSessionState);
		}
	});

	test("omits an unknown catalog output ceiling while forwarding an explicit caller cap", async () => {
		const target = await loopback();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const context = { messages: [{ role: "user" as const, content: "bounded", timestamp: 1 }] };
		const discoveredModel = { ...model(target.origin), maxTokens: null };
		try {
			await collect(
				streamSimple(discoveredModel, context, {
					apiKey: "HEADER.PAYLOAD.SIGNATURE",
					sessionId: "omp-default-cap",
					providerSessionState,
				}),
			);
			await collect(
				streamSimple(discoveredModel, context, {
					apiKey: "HEADER.PAYLOAD.SIGNATURE",
					sessionId: "omp-explicit-cap",
					providerSessionState,
					maxTokens: 321,
				}),
			);
			expect(target.invokeMaxTokens()).toEqual([0, 321]);
		} finally {
			closeProviderState(providerSessionState);
		}
	});

	test("routes the selected effort through the provider entrypoint", async () => {
		const target = await loopback();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const routedModel = buildModel({
			...model(target.origin),
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				effortRouting: {
					[Effort.Low]: "gpt-5.6-sol-low",
					[Effort.Medium]: "gpt-5.6-sol-medium",
					[Effort.High]: "gpt-5.6-sol-high",
					[Effort.XHigh]: "gpt-5.6-sol-xhigh",
				},
			},
			cursorContext: "272k",
		});
		try {
			for (const effort of [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]) {
				await collect(
					streamSimple(
						routedModel,
						{ messages: [{ role: "user", content: effort, timestamp: 1 }] },
						{
							apiKey: "HEADER.PAYLOAD.SIGNATURE",
							sessionId: `omp-effort-${effort}`,
							providerSessionState,
							reasoning: effort,
						},
					),
				);
			}
			expect(target.requestedModels()).toEqual(
				[Effort.Low, Effort.Medium, Effort.High, Effort.XHigh].map(effort => ({
					modelId: "gpt-5.6-sol",
					parameters: [`context=272k`, `reasoning=${effort}`, "fast=false"],
				})),
			);
		} finally {
			closeProviderState(providerSessionState);
		}
	});

	test("rejects tool calls removed by the final payload hook", async () => {
		const target = await loopback({ toolCallName: "read" });
		const providerSessionState = new Map<string, ProviderSessionState>();
		try {
			const { result } = await collect(
				streamCursor(
					model(target.origin),
					{
						messages: [{ role: "user", content: "do not call the removed tool", timestamp: 1 }],
						tools: [
							{
								name: "read",
								description: "Read a file.",
								parameters: { type: "object", properties: {}, additionalProperties: false },
							},
						],
					},
					{
						apiKey: "HEADER.PAYLOAD.SIGNATURE",
						sessionId: "omp-session",
						providerSessionState,
						onPayload: payload => {
							const request = payload as InferenceStreamRequest;
							return create(InferenceStreamRequestSchema, { ...request, tools: [] });
						},
					},
				),
			);
			expect(target.invokeToolCounts()).toEqual([0]);
			expect(result).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringContaining("unadvertised tool 'read'"),
			});
		} finally {
			closeProviderState(providerSessionState);
		}
	});

	test("accepts unadvertised tool names authorized by the final payload hook", async () => {
		const target = await loopback({ toolCallName: "server_known_tool" });
		const providerSessionState = new Map<string, ProviderSessionState>();
		try {
			const { result } = await collect(
				streamCursor(
					model(target.origin),
					{ messages: [{ role: "user", content: "call the server-known tool", timestamp: 1 }] },
					{
						apiKey: "HEADER.PAYLOAD.SIGNATURE",
						sessionId: "omp-session",
						providerSessionState,
						onPayload: payload => {
							const request = payload as InferenceStreamRequest;
							return create(InferenceStreamRequestSchema, {
								...request,
								acceptedUnadvertisedToolNames: ["server_known_tool"],
							});
						},
					},
				),
			);
			expect(result.stopReason).toBe("toolUse");
			expect(result.content).toContainEqual(
				expect.objectContaining({ type: "toolCall", name: "server_known_tool" }),
			);
		} finally {
			closeProviderState(providerSessionState);
		}
	});

	test("keeps opaque reasoning on an active tool continuation", async () => {
		const target = await loopback({ toolCallName: "inspect", answerAfterToolResult: true });
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options: CursorOptions = {
			apiKey: "HEADER.PAYLOAD.SIGNATURE",
			sessionId: "omp-tool-reasoning-session",
			providerSessionState,
		};
		const firstPrompt = { role: "user" as const, content: "inspect first", timestamp: 1 };
		const inspectTool = {
			name: "inspect",
			description: "Inspect the fixture.",
			parameters: type({ "+": "reject" }),
		};
		try {
			const first = await collect(
				streamCursor(model(target.origin), { messages: [firstPrompt], tools: [inspectTool] }, options),
			);
			expect(first.result.stopReason).toBe("toolUse");
			const call = first.result.content.find(part => part.type === "toolCall");
			if (call?.type !== "toolCall") throw new Error("signed continuation tool call missing");
			const assistantWithReasoning: AssistantMessage = {
				...first.result,
				upstreamModel: "composer-2.5",
				content: [
					{ type: "thinking", thinking: "", thinkingSignature: "opaque-tool-run" },
					...first.result.content,
				],
			};
			const second = await collect(
				streamCursor(
					model(target.origin),
					{
						messages: [
							firstPrompt,
							assistantWithReasoning,
							{
								role: "toolResult",
								toolCallId: call.id,
								toolName: call.name,
								content: [{ type: "text", text: "inspected" }],
								isError: false,
								timestamp: 2,
							},
						],
						tools: [inspectTool],
					},
					options,
				),
			);
			expect(second.result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "final-2" }] });
			expect(target.runRequests()).toBe(1);
			expect(target.invokeReasoningCounts()).toEqual([0, 1]);
		} finally {
			closeProviderState(providerSessionState);
		}
	});

	test("omits opaque reasoning when a later user turn opens a replacement run", async () => {
		const target = await loopback({ rejectReasoningReplayOnReopenedRun: true });
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options: CursorOptions = {
			apiKey: "HEADER.PAYLOAD.SIGNATURE",
			sessionId: "omp-reasoning-session",
			providerSessionState,
		};
		try {
			const firstPrompt = { role: "user" as const, content: "reason first", timestamp: 1 };
			const first = await collect(streamCursor(model(target.origin), { messages: [firstPrompt] }, options));
			expect(first.result.content).toContainEqual(
				expect.objectContaining({ type: "thinking", thinkingSignature: "opaque-run-1" }),
			);
			const second = await collect(
				streamCursor(
					model(target.origin),
					{
						messages: [firstPrompt, first.result, { role: "user", content: "continue", timestamp: 2 }],
					},
					options,
				),
			);
			expect(second.result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "final-2" }] });
			expect(target.runRequests()).toBe(2);
			expect(target.invocations()).toBe(2);
			expect(target.invokeReasoningCounts()).toEqual([0, 0]);
		} finally {
			closeProviderState(providerSessionState);
		}
	});

	test("applies hooks and caller headers while reopening later user turns", async () => {
		const target = await loopback();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const responses: number[] = [];
		const options: CursorOptions = {
			apiKey: "HEADER.PAYLOAD.SIGNATURE",
			sessionId: "omp-session",
			providerSessionState,
			headers: { Authorization: "attacker", Connection: "close", "x-caller": "kept" },
			onPayload: (payload: unknown) => {
				const request = payload as InferenceStreamRequest;
				return create(InferenceStreamRequestSchema, {
					...request,
					modelConfig: create(InferenceModelConfigSchema, { maxTokens: 321 }),
				});
			},
			onResponse: (metadata: { readonly status: number }) => {
				responses.push(metadata.status);
			},
		};
		try {
			const first = await collect(
				streamCursor(
					model(target.origin),
					{ messages: [{ role: "user", content: "first", timestamp: 1 }] },
					options,
				),
			);
			const second = await collect(
				streamCursor(
					model(target.origin),
					{ messages: [{ role: "user", content: "second", timestamp: 2 }] },
					options,
				),
			);
			expect(first.events).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
			expect(first.result).toMatchObject({
				content: [{ type: "text", text: "final-1" }],
				responseId: "response-1",
				usage: { input: 4, output: 2, cacheRead: 1, totalTokens: 7 },
				stopReason: "stop",
			});
			expect(second.result.content).toEqual([{ type: "text", text: "final-2" }]);
			expect(target.runRequests()).toBe(2);
			expect(target.invocations()).toBe(2);
			expect(target.invokeMaxTokens()).toEqual([321, 321]);
			expect(responses).toEqual([200, 200]);
			expect(target.headers()).toMatchObject({
				authorization: "Bearer HEADER.PAYLOAD.SIGNATURE",
				"x-caller": "kept",
			});
			expect(target.headers()?.connection).toBeUndefined();
		} finally {
			closeProviderState(providerSessionState);
		}
	});

	test("keeps distinct credential runtimes isolated and reusable", async () => {
		const target = await loopback();
		const providerSessionState = new Map<string, ProviderSessionState>();
		try {
			const context = { messages: [{ role: "user" as const, content: "rotate", timestamp: 1 }] };
			await collect(
				streamCursor(model(target.origin), context, {
					apiKey: "FIRST.PAYLOAD.SIGNATURE",
					sessionId: "first-session",
					providerSessionState,
				}),
			);
			await collect(
				streamCursor(model(target.origin), context, {
					apiKey: "SECOND.PAYLOAD.SIGNATURE",
					sessionId: "second-session",
					providerSessionState,
				}),
			);
			await collect(
				streamCursor(
					model(target.origin),
					{
						messages: [
							...context.messages,
							{
								role: "toolResult",
								toolCallId: "call-1",
								toolName: "read",
								content: [{ type: "text", text: "done" }],
								isError: false,
								timestamp: 2,
							},
						],
					},
					{
						apiKey: "FIRST.PAYLOAD.SIGNATURE",
						sessionId: "first-session",
						providerSessionState,
					},
				),
			);
			expect(target.runRequests()).toBe(2);
			expect(target.invocations()).toBe(3);
		} finally {
			closeProviderState(providerSessionState);
		}
	});

	test("creates one runtime when the same credential starts concurrently", async () => {
		const target = await loopback();
		const providerSessionState = new Map<string, ProviderSessionState>();
		try {
			const options: CursorOptions = {
				apiKey: "SHARED.PAYLOAD.SIGNATURE",
				providerSessionState,
			};
			await Promise.all([
				collect(
					streamCursor(
						model(target.origin),
						{ messages: [{ role: "user", content: "first", timestamp: 1 }] },
						{ ...options, sessionId: "first-session" },
					),
				),
				collect(
					streamCursor(
						model(target.origin),
						{ messages: [{ role: "user", content: "second", timestamp: 2 }] },
						{ ...options, sessionId: "second-session" },
					),
				),
			]);
			expect(target.runRequests()).toBe(2);
			expect(target.invocations()).toBe(2);
			expect(target.sessions()).toBe(1);
		} finally {
			closeProviderState(providerSessionState);
		}
	});
});
