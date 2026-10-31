import { describe, expect, it, vi } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { completeSimple } from "@oh-my-pi/pi-ai/stream";

import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import {
	bedrockAnthropicChunkEvent,
	bedrockHappyPathFrames,
	bedrockStreamExceptionFrame,
	bedrockTestModel,
	BEDROCK_TEST_CONTEXT,
	withSkippedBedrockAuth,
} from "./helpers/bedrock-stream";
import { withEnv } from "./helpers";

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
}

function captureFetch(response: () => Response): { fetch: FetchImpl; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const rawBody = init?.body;
			const bodyText = rawBody instanceof Uint8Array ? new TextDecoder().decode(rawBody) : String(rawBody ?? "");
			const parsed: unknown = JSON.parse(bodyText);
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("Expected a JSON object request body");
			}
			requests.push({
				url: String(input),
				headers: new Headers(init?.headers),
				body: parsed as Record<string, unknown>,
			});
			return response();
		},
		{ preconnect: globalThis.fetch.preconnect },
	) as FetchImpl;
	return { fetch, requests };
}

function fetchWaitingForAbort(): { fetch: FetchImpl; requestSignal: Promise<AbortSignal> } {
	const requestStarted = Promise.withResolvers<AbortSignal>();
	const fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const signal = init?.signal;
			if (!signal) throw new Error("Expected Bedrock request signal");
			const pending = Promise.withResolvers<Response>();
			if (signal.aborted) pending.reject(signal.reason);
			else signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
			requestStarted.resolve(signal);
			return pending.promise;
		},
		{ preconnect: globalThis.fetch.preconnect },
	) as FetchImpl;
	return { fetch, requestSignal: requestStarted.promise };
}

function fetchWithStalledHttpErrorBody(): {
	fetch: FetchImpl;
	requestSignal: Promise<AbortSignal>;
	bodyRead: Promise<void>;
} {
	const requestStarted = Promise.withResolvers<AbortSignal>();
	const bodyReadStarted = Promise.withResolvers<void>();
	const bodyGate = Promise.withResolvers<void>();
	const fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const signal = init?.signal;
			if (!signal) throw new Error("Expected Bedrock request signal");
			requestStarted.resolve(signal);
			let pulls = 0;
			const body = new ReadableStream<Uint8Array>(
				{
					start(controller) {
						const onAbort = () => {
							controller.error(signal.reason);
							bodyGate.resolve();
						};
						if (signal.aborted) onAbort();
						else signal.addEventListener("abort", onAbort, { once: true });
					},
					pull(controller) {
						if (pulls++ === 0) {
							controller.enqueue(new TextEncoder().encode("Access denied"));
							return;
						}
						bodyReadStarted.resolve();
						return bodyGate.promise;
					},
					cancel() {
						bodyGate.resolve();
					},
				},
				{ highWaterMark: 0 },
			);
			return new Response(body, { status: 403 });
		},
		{ preconnect: globalThis.fetch.preconnect },
	) as FetchImpl;
	return { fetch, requestSignal: requestStarted.promise, bodyRead: bodyReadStarted.promise };
}

function fetchWithStalledEventStream(initialFrames: Uint8Array[] = []): {
	fetch: FetchImpl;
	requestSignal: Promise<AbortSignal>;
	bodyRead: Promise<void>;
	idleRead: Promise<void>;
} {
	const requestStarted = Promise.withResolvers<AbortSignal>();
	const bodyReadStarted = Promise.withResolvers<void>();
	const idleReadStarted = Promise.withResolvers<void>();
	const pullGate = Promise.withResolvers<void>();
	let onAbort: (() => void) | undefined;
	const fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const signal = init?.signal;
			if (!signal) throw new Error("Expected Bedrock request signal");
			requestStarted.resolve(signal);
			return new Response(
				new ReadableStream<Uint8Array>(
					{
						start(controller) {
							onAbort = () => {
								controller.error(signal.reason);
								pullGate.resolve();
							};
							if (signal.aborted) onAbort();
							else signal.addEventListener("abort", onAbort, { once: true });
						},
						pull(controller) {
							bodyReadStarted.resolve();
							const frame = initialFrames.shift();
							if (frame) controller.enqueue(frame);
							else {
								idleReadStarted.resolve();
								return pullGate.promise;
							}
						},
						cancel() {
							pullGate.resolve();
						},
					},
					{ highWaterMark: 0 },
				),
				{ headers: { "content-type": "application/vnd.amazon.eventstream" } },
			);
		},
		{ preconnect: globalThis.fetch.preconnect },
	) as FetchImpl;
	return {
		fetch,
		requestSignal: requestStarted.promise,
		bodyRead: bodyReadStarted.promise,
		idleRead: idleReadStarted.promise,
	};
}

function fetchWithPausedEventStream(): {
	fetch: FetchImpl;
	requestSignal: Promise<AbortSignal>;
	bodyRead: Promise<void>;
	resume: () => void;
} {
	const requestStarted = Promise.withResolvers<AbortSignal>();
	const bodyReadStarted = Promise.withResolvers<void>();
	const pullGate = Promise.withResolvers<void>();
	let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
	let onAbort: (() => void) | undefined;
	let bodySignal: AbortSignal | undefined;
	const fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const signal = init?.signal;
			if (!signal) throw new Error("Expected Bedrock request signal");
			requestStarted.resolve(signal);
			return new Response(
				new ReadableStream<Uint8Array>(
					{
						start(controller) {
							bodyController = controller;
							bodySignal = signal;
							onAbort = () => {
								controller.error(signal.reason);
								pullGate.resolve();
							};
							if (signal.aborted) onAbort();
							else signal.addEventListener("abort", onAbort, { once: true });
						},
						pull() {
							bodyReadStarted.resolve();
							return pullGate.promise;
						},
					},
					{ highWaterMark: 0 },
				),
				{ headers: { "content-type": "application/vnd.amazon.eventstream" } },
			);
		},
		{ preconnect: globalThis.fetch.preconnect },
	) as FetchImpl;
	const resume = (): void => {
		if (!bodyController) throw new Error("Converse response body has not started");
		for (const frame of bedrockHappyPathFrames()) bodyController.enqueue(frame);
		if (bodySignal && onAbort) bodySignal.removeEventListener("abort", onAbort);
		bodyController.close();
		pullGate.resolve();
	};
	return {
		fetch,
		requestSignal: requestStarted.promise,
		bodyRead: bodyReadStarted.promise,
		resume,
	};
}

function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => {
			if (typeof block !== "object" || block === null || !("text" in block)) return "";
			const text = block.text;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

function eventStreamResponse(): Response {
	const frames = bedrockHappyPathFrames();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const frame of frames) controller.enqueue(frame);
				controller.close();
			},
		}),
		{ headers: { "content-type": "application/vnd.amazon.eventstream" } },
	);
}

function compactionModel(remoteCompaction?: { enabled?: boolean }) {
	return bedrockTestModel({
		compat: { supportsServerCompaction: true },
		...(remoteCompaction === undefined ? {} : { remoteCompaction }),
	});
}
const SIGNED_TOOL_CHANGES: Record<string, unknown>[] = [
	{
		type: "tool_addition",
		tool: { type: "tool_reference", name: "search" },
		opaque: { key: "bedrock-signed-add", details: ["opaque", { revision: 4 }] },
	},
	{
		type: "tool_removal",
		tool: { type: "tool_reference", name: "legacy_search" },
		opaque: { key: "bedrock-signed-remove", details: ["opaque", { revision: 9 }] },
	},
];

const compactionResponse = {
	id: "msg_compaction",
	model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
	content: [
		{
			type: "compaction",
			content: "Signed compacted context",
			signature: "opaque-bedrock-signature",
			tool_changes: SIGNED_TOOL_CHANGES,
		},
	],
	stop_reason: "compaction",
	usage: {
		input_tokens: 1,
		output_tokens: 0,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
		iterations: [
			{ type: "message", input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 2 },
			{
				type: "compaction",
				input_tokens: 20,
				output_tokens: 3,
				cache_read_input_tokens: 4,
				cache_creation_input_tokens: 1,
			},
		],
	},
};
interface CompactionStreamFixture {
	id: string;
	model: string;
	content: Record<string, unknown>[];
	stop_reason: string;
	usage: { input_tokens: number; [key: string]: unknown };
}

function eventStreamResponseFromFrames(frames: Uint8Array[]): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const frame of frames) controller.enqueue(frame);
				controller.close();
			},
		}),
		{ headers: { "content-type": "application/vnd.amazon.eventstream" } },
	);
}
function concatenateFrames(frames: readonly Uint8Array[]): Uint8Array {
	const bytes = new Uint8Array(frames.reduce((total, frame) => total + frame.length, 0));
	let offset = 0;
	for (const frame of frames) {
		bytes.set(frame, offset);
		offset += frame.length;
	}
	return bytes;
}

/** Every native fixture splits one EventStream frame and coalesces later frames in the same chunk. */
function nativeEventStreamResponse(events: Record<string, unknown>[]): Response {
	const frames = events.map(bedrockAnthropicChunkEvent);
	const chunks =
		frames.length >= 2
			? [
					frames[0]!.subarray(0, 5),
					concatenateFrames([frames[0]!.subarray(5), frames[1]!, ...frames.slice(2, 3)]),
					...frames.slice(3),
				]
			: frames;
	let index = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (index < chunks.length) controller.enqueue(chunks[index++]!);
				else controller.close();
			},
		}),
		{ headers: { "content-type": "application/vnd.amazon.eventstream" } },
	);
}

function compactionEvents(response: CompactionStreamFixture, includeMessageStop = true): Record<string, unknown>[] {
	const contentBlock = response.content[0];
	return [
		{
			type: "message_start",
			message: {
				id: response.id,
				type: "message",
				role: "assistant",
				model: response.model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: response.usage.input_tokens, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: contentBlock },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: response.stop_reason, stop_sequence: null },
			usage: response.usage,
		},
		...(includeMessageStop ? [{ type: "message_stop" }] : []),
	];
}

function compactionEventStreamResponse(
	response: CompactionStreamFixture = compactionResponse,
	includeMessageStop = true,
): Response {
	return nativeEventStreamResponse(compactionEvents(response, includeMessageStop));
}

function openEventStreamResponse(frames: Uint8Array[]): {
	response: Response;
	bodyRead: Promise<void>;
	cancelled: Promise<void>;
} {
	const bodyRead = Promise.withResolvers<void>();
	const cancelled = Promise.withResolvers<void>();
	const readGate = Promise.withResolvers<void>();
	let sent = false;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (sent) return readGate.promise;
				sent = true;
				controller.enqueue(concatenateFrames(frames));
				bodyRead.resolve();
			},
			cancel() {
				cancelled.resolve();
				readGate.resolve();
			},
		},
		{ highWaterMark: 0 },
	);
	return {
		response: new Response(body, { headers: { "content-type": "application/vnd.amazon.eventstream" } }),
		bodyRead: bodyRead.promise,
		cancelled: cancelled.promise,
	};
}

describe("Bedrock native compaction transport", () => {
	it("uses authenticated InvokeModelWithResponseStream and returns signed summary usage", async () => {
		const { fetch, requests } = captureFetch(compactionEventStreamResponse);
		const model = compactionModel();
		let hookPayload: unknown;
		let hookModel: unknown;
		const result = await completeSimple(model, BEDROCK_TEST_CONTEXT, {
			apiKey: "bedrock-test-token",
			anthropicCompaction: { instructions: "Keep only verified findings." },
			requestMetadata: { run: "compaction" },
			onPayload: (payload, sourceModel) => {
				hookPayload = payload;
				hookModel = sourceModel;
				return payload;
			},
			fetch,
		});
		expect(requests[0]?.url).toBe(
			"https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke-with-response-stream",
		);
		expect(hookModel).toBe(model);
		expect(hookPayload).toMatchObject({
			anthropic_version: "bedrock-2023-05-31",
			compaction: { type: "summarize", instructions: "Keep only verified findings." },
			messages: [{ role: "user" }],
		});
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer bedrock-test-token");
		expect(requests[0]?.headers.get("x-amzn-bedrock-request-metadata")).toBe('{"run":"compaction"}');
		expect(requests[0]?.headers.get("accept")).toBe("application/vnd.amazon.eventstream");
		expect(requests[0]?.headers.get("x-amzn-bedrock-accept")).toBe("application/json");
		expect(requests[0]?.headers.get("content-type")).toBe("application/json");
		const body = requests[0]?.body;
		expect(body).toMatchObject({
			anthropic_version: "bedrock-2023-05-31",
			anthropic_beta: ["compact-2026-09-04"],
			compaction: { type: "summarize", instructions: "Keep only verified findings." },
		});
		const requestMessages = body?.messages;
		expect(Array.isArray(requestMessages)).toBe(true);
		if (!Array.isArray(requestMessages)) throw new Error("Expected Anthropic request messages");
		expect(requestMessages).toHaveLength(1);
		expect(requestMessages[0]).toMatchObject({ role: "user" });
		expect(messageText(requestMessages[0])).toBe("hi");
		expect(body?.model).toBeUndefined();
		expect(body?.stream).toBeUndefined();
		expect(result.stopDetails).toEqual({ type: "compaction" });
		expect(result.providerPayload).toMatchObject({
			type: "anthropicCompaction",
			provider: "amazon-bedrock",
			content: "Signed compacted context",
			signature: "opaque-bedrock-signature",
			toolChanges: SIGNED_TOOL_CHANGES,
		});
		if (result.providerPayload?.type !== "anthropicCompaction") {
			throw new Error("expected signed compaction payload");
		}
		expect(result.providerPayload.toolChanges).toEqual(SIGNED_TOOL_CHANGES);
		expect(result.usage).toMatchObject({ input: 32, output: 4, cacheRead: 6, cacheWrite: 1, totalTokens: 43 });
	});
	it("uses KDL-resolved Opus 5.5 effort and all Anthropic wire-control betas", async () => {
		const model = bedrockTestModel({
			id: "global.anthropic.claude-opus-5-5",
			name: "Claude Opus 5.5",
			reasoning: true,
			compat: { supportsServerCompaction: true },
		});
		const { fetch, requests } = captureFetch(compactionEventStreamResponse);
		await completeSimple(model, BEDROCK_TEST_CONTEXT, {
			apiKey: "bedrock-test-token",
			reasoning: Effort.Low,
			anthropicCompaction: {},
			taskBudget: { type: "tokens", total: 1024, remaining: 512 },
			fetch,
		});

		const body = requests[0]?.body;
		expect(body?.thinking).toMatchObject({
			type: "adaptive",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		});
		expect(body?.output_config).toMatchObject({ effort: "low", task_budget: { type: "tokens", total: 1024 } });
		expect(JSON.stringify(body?.output_config)).not.toContain("remaining");

		const betas = body?.anthropic_beta as string[];
		expect(betas).toContain("compact-2026-09-04");
		expect(betas).toContain("thinking-binding-controls-2026-08-01");
		expect(betas).toContain("effort-2025-11-24");
		expect(betas).toContain("task-budgets-2026-03-13");
	});
	it("preserves Haiku 4.5 High budget defaults and custom thinkingBudgets", async () => {
		const model = bedrockTestModel({
			id: "anthropic.claude-haiku-4-5-20251001-v1:0",
			name: "Claude Haiku 4.5",
			reasoning: true,
			maxTokens: 64_000,
			thinking: {
				mode: "budget",
				efforts: [Effort.Low, Effort.Medium, Effort.High],
				defaultLevel: Effort.High,
			},
			compat: { supportsServerCompaction: true },
		});

		for (const [thinkingBudgets, expectedBudget] of [
			[undefined, 16_384],
			[{ [Effort.High]: 1_234 }, 1_234],
		] as const) {
			const { fetch, requests } = captureFetch(compactionEventStreamResponse);
			await completeSimple(model, BEDROCK_TEST_CONTEXT, {
				apiKey: "bedrock-test-token",
				reasoning: Effort.High,
				thinkingBudgets,
				anthropicCompaction: {},
				fetch,
			});
			expect(requests[0]?.body.thinking).toMatchObject({
				type: "enabled",
				budget_tokens: expectedBudget,
			});
		}
	});

	it("emits the Haiku 5.5 KDL disabled-thinking form without binding controls", async () => {
		const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "global.anthropic.claude-haiku-5-5");
		if (!model) throw new Error("expected bundled Bedrock Haiku 5.5");
		expect(model.compat.disabledThinking).toBe("disabled");

		for (const options of [{}, { disableReasoning: true, reasoning: Effort.High }]) {
			const { fetch, requests } = captureFetch(compactionEventStreamResponse);
			await completeSimple(model, BEDROCK_TEST_CONTEXT, {
				apiKey: "bedrock-test-token",
				...options,
				anthropicCompaction: {},
				fetch,
				taskBudget: { type: "tokens", total: 1024, remaining: 512 },
			});
			const body = requests[0]?.body;
			expect(body?.thinking).toEqual({ type: "disabled" });
			expect(body?.output_config).toMatchObject({
				effort: "low",
				task_budget: { type: "tokens", total: 1024 },
			});
			expect(JSON.stringify(body?.output_config)).not.toContain("remaining");
			const betas = Array.isArray(body?.anthropic_beta) ? body.anthropic_beta : [];
			expect(betas).toContain("effort-2025-11-24");
			expect(betas).not.toContain("thinking-binding-controls-2026-08-01");
		}
	});

	it("keeps the off fields omitted for Bedrock models without a disabled-thinking policy", async () => {
		const model = getBundledModel<"bedrock-converse-stream">("amazon-bedrock", "global.anthropic.claude-opus-5-5");
		if (!model) throw new Error("expected bundled Bedrock Opus 5.5");
		expect(model.compat.disabledThinking).toBeUndefined();

		const { fetch, requests } = captureFetch(compactionEventStreamResponse);
		await completeSimple(model, BEDROCK_TEST_CONTEXT, {
			apiKey: "bedrock-test-token",
			anthropicCompaction: {},
			fetch,
		});
		const body = requests[0]?.body;
		expect(body?.thinking).toBeUndefined();
		expect(body?.output_config).toBeUndefined();
		const betas = Array.isArray(body?.anthropic_beta) ? body.anthropic_beta : [];
		expect(betas).not.toContain("effort-2025-11-24");
		expect(betas).not.toContain("thinking-binding-controls-2026-08-01");
	});

	it("keeps ordinary, unsupported, disabled, and un-opted gateway requests on Converse without compaction beta", async () => {
		const cases = [
			{ model: compactionModel(), options: {} },
			{
				model: bedrockTestModel({ compat: { supportsServerCompaction: false } }),
				options: { anthropicCompaction: {} },
			},
			{ model: compactionModel({ enabled: false }), options: { anthropicCompaction: {} } },
			{
				model: bedrockTestModel({
					baseUrl: "https://llm-gateway.example.com/bedrock",
					compat: { supportsServerCompaction: true },
				}),
				options: { anthropicCompaction: {} },
			},
		];

		for (const entry of cases) {
			const { fetch, requests } = captureFetch(eventStreamResponse);
			await streamBedrock(entry.model, BEDROCK_TEST_CONTEXT, {
				bearerToken: "bedrock-test-token",
				...entry.options,
				fetch,
			}).result();
			expect(requests).toHaveLength(1);
			expect(requests[0]?.url).toEndWith("/converse-stream");
			expect(requests[0]?.headers.get("accept")).toBe("application/vnd.amazon.eventstream");
			expect(requests[0]?.body.compaction).toBeUndefined();
			expect(requests[0]?.body.anthropic_beta).toBeUndefined();
		}
	});

	it("replays signed state natively on later Bedrock compactions and keeps ordinary Converse summaries textual", async () => {
		const producer = compactionModel();
		const produced = await streamBedrock(producer, BEDROCK_TEST_CONTEXT, {
			bearerToken: "bedrock-test-token",
			anthropicCompaction: {},
			fetch: captureFetch(compactionEventStreamResponse).fetch,
		}).result();
		const payload = produced.providerPayload;
		if (payload?.type !== "anthropicCompaction") throw new Error("expected a signed compaction payload");
		const context = {
			messages: [
				{
					role: "user" as const,
					content: "<summary>Signed compacted context</summary>",
					providerPayload: payload,
					timestamp: 1,
				},
				{ role: "user" as const, content: "Continue", timestamp: 2 },
			],
		};

		const sameModel = captureFetch(compactionEventStreamResponse);
		await streamBedrock(producer, context, {
			bearerToken: "bedrock-test-token",
			anthropicCompaction: {},
			fetch: sameModel.fetch,
		}).result();
		const replayMessages = sameModel.requests[0]?.body.messages;
		expect(Array.isArray(replayMessages)).toBe(true);
		if (!Array.isArray(replayMessages)) throw new Error("Expected Anthropic replay messages");
		expect(replayMessages).toHaveLength(2);
		expect(replayMessages[0]).toMatchObject({ role: "assistant" });
		const firstMessage = replayMessages[0];
		const firstContent =
			typeof firstMessage === "object" && firstMessage !== null && "content" in firstMessage
				? firstMessage.content
				: undefined;
		const firstBlock = Array.isArray(firstContent) ? firstContent[0] : undefined;
		expect(firstBlock).toMatchObject({
			type: "compaction",
			content: "Signed compacted context",
			signature: "opaque-bedrock-signature",
		});
		expect(
			typeof firstBlock === "object" && firstBlock !== null && "tool_changes" in firstBlock
				? firstBlock.tool_changes
				: undefined,
		).toEqual(SIGNED_TOOL_CHANGES);
		expect(replayMessages[1]).toMatchObject({ role: "user" });
		expect(messageText(replayMessages[1])).toBe("Continue");

		// Like the Anthropic path, another model of the same provider adopts the block.
		const otherModel = bedrockTestModel({
			id: "anthropic.other-bedrock-model",
			compat: { supportsServerCompaction: true },
		});
		const crossModel = captureFetch(compactionEventStreamResponse);
		await streamBedrock(otherModel, context, {
			bearerToken: "bedrock-test-token",
			anthropicCompaction: {},
			fetch: crossModel.fetch,
		}).result();
		expect(JSON.stringify(crossModel.requests[0]?.body.messages)).toContain("opaque-bedrock-signature");

		const portable = captureFetch(eventStreamResponse);
		await streamBedrock(producer, context, {
			bearerToken: "bedrock-test-token",
			fetch: portable.fetch,
		}).result();
		expect(portable.requests[0]?.url).toEndWith("/converse-stream");
		expect(JSON.stringify(portable.requests[0]?.body.messages)).toContain("Signed compacted context");
		expect(JSON.stringify(portable.requests[0]?.body.messages)).not.toContain("opaque-bedrock-signature");
		expect(JSON.stringify(portable.requests[0]?.body.messages)).not.toContain("tool_changes");
		expect(JSON.stringify(portable.requests[0]?.body.messages)).not.toContain("bedrock-signed-add");
		expect(JSON.stringify(portable.requests[0]?.body.messages)).not.toContain("bedrock-signed-remove");
		expect(JSON.stringify(portable.requests[0]?.body.messages)).not.toContain('"type":"compaction"');
	});

	it("preserves InvokeModelWithResponseStream HTTP failure status and caller cancellation", async () => {
		const failed = captureFetch(() => new Response("Access denied", { status: 403 }));
		const failure = await streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
			bearerToken: "bedrock-test-token",
			anthropicCompaction: {},
			fetch: failed.fetch,
		}).result();
		expect(failure.stopReason).toBe("error");
		expect(failure.errorStatus).toBe(403);
		expect(failed.requests[0]?.url).toEndWith("/invoke-with-response-stream");
		const signed = captureFetch(compactionEventStreamResponse);
		await withSkippedBedrockAuth(async () => {
			await streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
				anthropicCompaction: {},
				fetch: signed.fetch,
			}).result();
		});
		expect(signed.requests[0]?.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
		expect(signed.requests[0]?.headers.get("x-amz-date")).toBeTruthy();

		const controller = new AbortController();
		const { fetch, requestSignal } = fetchWaitingForAbort();
		const pending = streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
			bearerToken: "bedrock-test-token",
			anthropicCompaction: {},
			fetch,
			signal: controller.signal,
		});
		await requestSignal;
		controller.abort();
		expect((await pending.result()).stopReason).toBe("aborted");
	});
	it("maps native EventStream throttling and validation exceptions to their statuses", async () => {
		for (const [exceptionType, expectedStatus] of [
			["throttlingException", 429],
			["validationException", 400],
		] as const) {
			const { fetch, requests } = captureFetch(() =>
				eventStreamResponseFromFrames([bedrockStreamExceptionFrame(exceptionType, `Bedrock ${exceptionType}`)]),
			);
			const result = await streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
				bearerToken: "bedrock-test-token",
				anthropicCompaction: {},
				fetch,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorStatus).toBe(expectedStatus);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.url).toEndWith("/invoke-with-response-stream");
		}
	});

	it("rejects a finite native stream that ends without message_stop", async () => {
		const { fetch, requests } = captureFetch(() => compactionEventStreamResponse(compactionResponse, false));
		const result = await streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
			bearerToken: "bedrock-test-token",
			anthropicCompaction: {},
			fetch,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(requests).toHaveLength(1);
	});

	it("cancels the actual EventStream reader after message_stop and stream exceptions", async () => {
		const completedBody = openEventStreamResponse(
			compactionEvents(compactionResponse).map(bedrockAnthropicChunkEvent),
		);
		const completed = streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
			bearerToken: "bedrock-test-token",
			anthropicCompaction: {},
			streamFirstEventTimeoutMs: 0,
			streamIdleTimeoutMs: 0,
			fetch: captureFetch(() => completedBody.response).fetch,
		});
		await completedBody.bodyRead;
		expect((await completed.result()).stopDetails).toEqual({ type: "compaction" });
		await completedBody.cancelled;

		const failedBody = openEventStreamResponse([
			bedrockStreamExceptionFrame("throttlingException", "temporarily unavailable"),
		]);
		const failedRequest = captureFetch(() => failedBody.response);
		const failed = streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
			bearerToken: "bedrock-test-token",
			anthropicCompaction: {},
			streamFirstEventTimeoutMs: 0,
			streamIdleTimeoutMs: 0,
			fetch: failedRequest.fetch,
		});
		await failedBody.bodyRead;
		expect((await failed.result()).errorStatus).toBe(429);
		expect(failedRequest.requests).toHaveLength(1);
		await failedBody.cancelled;
	});

	it("prices InvokeModelWithResponseStream usage per iteration and falls back to aggregate pricing without iterations", async () => {
		const model = bedrockTestModel({
			compat: { supportsServerCompaction: true },
			cost: {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				longContext: {
					input: 10,
					output: 20,
					cacheRead: 30,
					cacheWrite: 40,
					inputThreshold: 50_000,
				},
			},
		});
		const multipleIterations = await completeSimple(model, BEDROCK_TEST_CONTEXT, {
			apiKey: "bedrock-test-token",
			anthropicCompaction: {},
			fetch: captureFetch(() =>
				compactionEventStreamResponse({
					...compactionResponse,
					usage: {
						input_tokens: 1,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
						iterations: [
							{ type: "message", input_tokens: 30_000, output_tokens: 1 },
							{ type: "compaction", input_tokens: 30_000, output_tokens: 1 },
						],
					},
				}),
			).fetch,
		});
		expect(multipleIterations.usage).toMatchObject({ input: 60_000, output: 2, totalTokens: 60_002 });
		expect(multipleIterations.usage.cost.input).toBeCloseTo(0.06, 12);
		expect(multipleIterations.usage.cost.output).toBeCloseTo(0.000004, 12);
		expect(multipleIterations.usage.cost.total).toBeCloseTo(0.060004, 12);

		const singleIteration = await completeSimple(model, BEDROCK_TEST_CONTEXT, {
			apiKey: "bedrock-test-token",
			anthropicCompaction: {},
			fetch: captureFetch(() =>
				compactionEventStreamResponse({
					...compactionResponse,
					usage: {
						input_tokens: 60_000,
						output_tokens: 1,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
						iterations: [{ type: "compaction", input_tokens: 60_000, output_tokens: 1 }],
					},
				}),
			).fetch,
		});
		expect(singleIteration.usage).toMatchObject({ input: 60_000, output: 1, totalTokens: 60_001 });
		expect(singleIteration.usage.cost.total).toBeCloseTo(0.60002, 12);

		const aggregateFallback = await completeSimple(model, BEDROCK_TEST_CONTEXT, {
			apiKey: "bedrock-test-token",
			anthropicCompaction: {},
			fetch: captureFetch(() =>
				compactionEventStreamResponse({
					...compactionResponse,
					usage: {
						input_tokens: 60_000,
						output_tokens: 1,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			).fetch,
		});
		expect(aggregateFallback.usage).toMatchObject({ input: 60_000, output: 1, totalTokens: 60_001 });
		expect(aggregateFallback.usage.cost.total).toBeCloseTo(0.60002, 12);
	});

	it("preserves HTTP 403 when the pre-header deadline interrupts a stalled error-body read", async () => {
		vi.useFakeTimers();
		try {
			await withEnv(
				{
					PI_STREAM_IDLE_TIMEOUT_MS: undefined,
					PI_OPENAI_STREAM_IDLE_TIMEOUT_MS: undefined,
					PI_STREAM_FIRST_EVENT_TIMEOUT_MS: undefined,
				},
				async () => {
					const timeoutMs = 20;
					const stalled = fetchWithStalledHttpErrorBody();
					const pending = streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
						bearerToken: "bedrock-test-token",
						anthropicCompaction: {},
						fetch: stalled.fetch,
						streamFirstEventTimeoutMs: timeoutMs,
						streamIdleTimeoutMs: 0,
					});
					const signal = await stalled.requestSignal;
					await stalled.bodyRead;
					vi.advanceTimersByTime(timeoutMs - 1);
					expect(signal.aborted).toBe(false);
					vi.advanceTimersByTime(1);
					expect(signal.aborted).toBe(true);
					const result = await pending.result();
					expect(result.stopReason).toBe("error");
					expect(result.errorStatus).toBe(403);
				},
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("resolves pre-header stream deadlines from model and per-call settings, honoring explicit timeout precedence", async () => {
		vi.useFakeTimers();
		try {
			await withEnv(
				{
					PI_STREAM_IDLE_TIMEOUT_MS: undefined,
					PI_OPENAI_STREAM_IDLE_TIMEOUT_MS: undefined,
					PI_STREAM_FIRST_EVENT_TIMEOUT_MS: undefined,
				},
				async () => {
					const model = bedrockTestModel({
						compat: { supportsServerCompaction: true, streamIdleTimeoutMs: 450_000 },
					});
					const assertTimeout = async (
						options: { streamIdleTimeoutMs?: number; streamFirstEventTimeoutMs?: number },
						timeoutMs: number,
					): Promise<void> => {
						const { fetch, requestSignal } = fetchWaitingForAbort();
						const pending = streamBedrock(model, BEDROCK_TEST_CONTEXT, {
							bearerToken: "bedrock-test-token",
							anthropicCompaction: {},
							fetch,
							...options,
						});
						const signal = await requestSignal;
						vi.advanceTimersByTime(timeoutMs - 1);
						expect(signal.aborted).toBe(false);
						vi.advanceTimersByTime(1);
						expect(signal.aborted).toBe(true);
						expect((await pending.result()).stopReason).toBe("error");
					};

					await assertTimeout({}, 450_000);
					// Ordinary Converse turns keep the global pre-header default, not the model idle window.
					{
						const { fetch, requestSignal } = fetchWaitingForAbort();
						const pending = streamBedrock(model, BEDROCK_TEST_CONTEXT, {
							bearerToken: "bedrock-test-token",
							fetch,
						});
						const signal = await requestSignal;
						vi.advanceTimersByTime(299_999);
						expect(signal.aborted).toBe(false);
						vi.advanceTimersByTime(1);
						expect(signal.aborted).toBe(true);
						expect((await pending.result()).stopReason).toBe("error");
					}
					await assertTimeout({ streamIdleTimeoutMs: 600_000 }, 600_000);
					await withEnv({ PI_STREAM_FIRST_EVENT_TIMEOUT_MS: "5" }, async () => {
						await assertTimeout({ streamIdleTimeoutMs: 600_000, streamFirstEventTimeoutMs: 20 }, 20);

						const controller = new AbortController();
						const { fetch, requestSignal } = fetchWaitingForAbort();
						const pending = streamBedrock(model, BEDROCK_TEST_CONTEXT, {
							bearerToken: "bedrock-test-token",
							anthropicCompaction: {},
							fetch,
							signal: controller.signal,
							streamFirstEventTimeoutMs: 0,
						});
						const signal = await requestSignal;
						vi.advanceTimersByTime(100);
						expect(signal.aborted).toBe(false);
						controller.abort();
						expect((await pending.result()).stopReason).toBe("aborted");
					});
				},
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("applies first-event and idle deadlines while waiting for native EventStream chunks", async () => {
		vi.useFakeTimers();
		try {
			await withEnv(
				{
					PI_STREAM_IDLE_TIMEOUT_MS: undefined,
					PI_OPENAI_STREAM_IDLE_TIMEOUT_MS: undefined,
					PI_STREAM_FIRST_EVENT_TIMEOUT_MS: undefined,
				},
				async () => {
					const firstEvent = fetchWithStalledEventStream();
					const firstPending = streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
						bearerToken: "bedrock-test-token",
						anthropicCompaction: {},
						fetch: firstEvent.fetch,
						streamFirstEventTimeoutMs: 20,
						streamIdleTimeoutMs: 0,
					});
					const firstSignal = await firstEvent.requestSignal;
					await firstEvent.bodyRead;
					vi.advanceTimersByTime(19);
					expect(firstSignal.aborted).toBe(false);
					vi.advanceTimersByTime(1);
					expect((await firstPending.result()).stopReason).toBe("error");
					expect(firstSignal.aborted).toBe(true);

					const idle = fetchWithStalledEventStream([
						bedrockAnthropicChunkEvent(compactionEvents(compactionResponse)[0]!),
					]);
					const idlePending = streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
						bearerToken: "bedrock-test-token",
						anthropicCompaction: {},
						fetch: idle.fetch,
						streamFirstEventTimeoutMs: 0,
						streamIdleTimeoutMs: 20,
					});
					const idleSignal = await idle.requestSignal;
					await idle.idleRead;
					vi.advanceTimersByTime(19);
					expect(idleSignal.aborted).toBe(false);
					vi.advanceTimersByTime(1);
					expect((await idlePending.result()).stopReason).toBe("error");
					expect(idleSignal.aborted).toBe(true);
				},
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps caller cancellation active while a native EventStream read is stalled", async () => {
		const controller = new AbortController();
		const { fetch, requestSignal, bodyRead } = fetchWithStalledEventStream();
		const pending = streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
			bearerToken: "bedrock-test-token",
			anthropicCompaction: {},
			fetch,
			signal: controller.signal,
			streamFirstEventTimeoutMs: 0,
		});
		const signal = await requestSignal;
		await bodyRead;
		controller.abort();
		expect(signal.aborted).toBe(true);
		expect((await pending.result()).stopReason).toBe("aborted");
	});

	it("continues an ordinary Converse stream beyond its first-event deadline", async () => {
		vi.useFakeTimers();
		try {
			const { fetch, requestSignal, bodyRead, resume } = fetchWithPausedEventStream();
			const pending = streamBedrock(compactionModel(), BEDROCK_TEST_CONTEXT, {
				bearerToken: "bedrock-test-token",
				fetch,
				streamFirstEventTimeoutMs: 20,
			});
			const signal = await requestSignal;
			await bodyRead;
			vi.advanceTimersByTime(100);
			expect(signal.aborted).toBe(false);
			resume();
			expect((await pending.result()).stopReason).toBe("stop");
		} finally {
			vi.useRealTimers();
		}
	});
});
