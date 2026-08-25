import { afterEach, describe, expect, it, mock } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildFactoryDroidModel } from "@oh-my-pi/pi-catalog/discovery";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { streamFactoryDroid } from "../src/providers/factory-droid";
import type { Message, Model } from "../src/types";
import { type CapturedRequest, captureFetch, completionsChunks, kimiK3, nemotron } from "./helpers/factory-droid";

function deepseekFlash(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "deepseek-v4-flash-0731",
			name: "DeepSeek V4 Flash 0731 (Droid Core)",
			wire: "openai-completions",
			contextWindow: 908_928,
			maxTokens: 131_072,
			apiProviders: ["fireworks"],
			supportedReasoningEfforts: [Effort.Low, Effort.High, Effort.Max],
			defaultReasoningEffort: Effort.High,
			noImageSupport: true,
		}),
	);
}

function deepseekPro(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro (Droid Core)",
			wire: "openai-completions",
			contextWindow: 974_464,
			maxTokens: 65_536,
			apiProviders: ["fireworks", "baseten"],
			supportedReasoningEfforts: [Effort.Low, Effort.High, Effort.Max],
			defaultReasoningEffort: Effort.High,
			noImageSupport: true,
		}),
	);
}

function glm52(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel(
			{
				id: "glm-5.2",
				name: "GLM-5.2 (Droid Core)",
				wire: "openai-completions",
				contextWindow: 908_928,
				maxTokens: 131_072,
				apiProviders: ["fireworks", "baseten"],
				supportedReasoningEfforts: [Effort.High, Effort.Max],
				defaultReasoningEffort: Effort.High,
				noImageSupport: true,
			},
			["baseten"],
		),
	);
}

/** Assistant tool-call turn plus its tool result, as stored by a prior turn. */
function toolTurn(key: string): Message[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: `call_${key}`, name: "Read", arguments: { path: "/tmp/x" } }],
			api: "factory-droid-agent",
			provider: "factory-droid",
			model: "droid",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: `call_${key}`,
			toolName: "Read",
			content: [{ type: "text", text: "body" }],
			isError: false,
			timestamp: 3,
		},
	];
}

afterEach(() => {
	mock.restore();
});

describe("Factory Droid completions reasoning matrix", () => {
	it("omits the stainless helper-method header and lets the watchdog own the timeout", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: "workos-token", fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")) },
		).result();

		// droid streams through `create({ stream: true })`, not the SDK's
		// `.stream()` helper, so no helper-method header rides the wire.
		expect(captured[0].headers["x-stainless-helper-method"]).toBeUndefined();
		// The timeout header is the transport's real first-event budget rather
		// than a provider-invented constant, so it tracks the watchdog default.
		expect(captured[0].headers["x-stainless-timeout"]).toBe("300");
		expect(captured[0].headers["x-provider-routing-source"]).toBe("configured_order");
	});

	it("pins temperature to 1 on the completions body and lets a caller override it", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: "workos-token", fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")) },
		).result();
		expect(captured[0].body.temperature).toBe(1);

		await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")),
				temperature: 0.2,
			},
		).result();
		expect(captured[1].body.temperature).toBe(0.2);
	});

	it("forwards the caller's first-event timeout to X-Stainless-Timeout", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")),
				// Only the first-event budget rides the wire as X-Stainless-Timeout;
				// abbreviating the idle budget alone does not shorten the header.
				streamFirstEventTimeoutMs: 90_000,
			},
		).result();

		// OMP's watchdog is honest about its own budget: the forwarded 90s
		// first-event deadline surfaces as "90" where droid sends nothing.
		expect(captured[0].headers["x-stainless-timeout"]).toBe("90");
	});

	it("aborts a stalled completions stream via the forwarded idle watchdog", async () => {
		// One valid chunk, then a stall: the first-event budget (huge here) must
		// be released once the first SSE event arrived, so the steady-state idle
		// watchdog governs the next wait and aborts fast. If the forwarded idle
		// budget leaked, the stream would hang until the 60s first-event deadline.
		const encoder = new TextEncoder();
		let releaseAfterFirst: ((reason: unknown) => void) | undefined;
		const partial = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							id: "chatcmpl-test",
							object: "chat.completion.chunk",
							created: 1,
							model: "kimi-k3",
							choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }],
						})}\n\n`,
					),
				);
				releaseAfterFirst = (reason: unknown) => controller.error(reason);
			},
			cancel() {
				releaseAfterFirst?.(new DOMException("Aborted", "AbortError"));
			},
		});
		const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			(init?.signal as AbortSignal | undefined)?.addEventListener("abort", () =>
				releaseAfterFirst?.(new DOMException("Aborted", "AbortError")),
			);
			return new Response(partial, { status: 200, headers: { "Content-Type": "text/event-stream" } });
		});
		const stream = streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				streamIdleTimeoutMs: 50,
				streamFirstEventTimeoutMs: 60_000,
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		const events: string[] = [];
		for await (const event of stream) {
			events.push(event.type);
		}
		// The watchdog fires and the client surfaces a provider error, not a hang.
		expect(events).toContain("text_delta");
		expect(events).toContain("error");
		expect(events).not.toContain("done");
	});

	it("keys reasoning_history by model family on Fireworks", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			deepseekFlash(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "deepseek-v4-flash-0731")),
				reasoning: Effort.Max,
			},
		).result();

		expect(captured[0].body.reasoning_effort).toBe("max");
		// DeepSeek's Fireworks builder is the interleaved variant.
		expect(captured[0].body.reasoning_history).toBe("interleaved");
	});

	it("emits reasoning_effort verbatim without chat_template_args on Baseten reasoning-effort models", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			glm52(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "glm-5.2")),
				reasoning: Effort.Max,
			},
		).result();

		expect(captured[0].headers["x-api-provider"]).toBe("baseten");
		// "max" passes verbatim on the completions route (no max -> xhigh mapping).
		expect(captured[0].body.reasoning_effort).toBe("max");
		expect(captured[0].body.chat_template_args).toBeUndefined();
		expect(captured[0].body.reasoning_history).toBeUndefined();
	});

	it("emits reasoning_effort none when disabled on Baseten reasoning-effort models", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			glm52(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "glm-5.2")),
				disableReasoning: true,
			},
		).result();

		expect(captured[0].body.reasoning_effort).toBe("none");
		expect(captured[0].body.chat_template_args).toBeUndefined();
		expect(captured[0].body.reasoning_history).toBeUndefined();
	});

	it("never sends reasoning_history on the mistral upstream", async () => {
		const captured: CapturedRequest[] = [];
		const routed = glm52();
		routed.factoryDroidApiProviders = ["mistral"];
		await streamFactoryDroid(
			routed,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "glm-5.2")),
				reasoning: Effort.Max,
			},
		).result();

		expect(captured[0].headers["x-api-provider"]).toBe("mistral");
		// Mistral takes the effort verbatim but advertises no reasoning-history
		// support, so the field the Fireworks rotation would carry is dropped.
		expect(captured[0].body.reasoning_effort).toBe("max");
		expect(captured[0].body.reasoning_history).toBeUndefined();
		expect(captured[0].body.chat_template_args).toBeUndefined();
	});

	it("coerces disabled Baseten thinking to low for forced-on deepseek", async () => {
		const captured: CapturedRequest[] = [];
		const pro = deepseekPro();
		pro.factoryDroidApiProviders = ["baseten"];
		await streamFactoryDroid(
			pro,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "deepseek-v4-pro")),
				disableReasoning: true,
			},
		).result();

		expect(captured[0].headers["x-api-provider"]).toBe("baseten");
		// DeepSeek on Baseten is forced-on: off still reasons (coerced to low).
		expect(captured[0].body.reasoning_effort).toBe("low");
		expect(captured[0].body.chat_template_args).toBeUndefined();
		expect(captured[0].body.reasoning_history).toBeUndefined();
	});

	it("expresses disabled thinking on Baseten opt-in models by omission (native fah)", async () => {
		const captured: CapturedRequest[] = [];
		const kimi = kimiK3();
		kimi.factoryDroidApiProviders = ["baseten"];
		await streamFactoryDroid(
			kimi,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")),
				disableReasoning: true,
			},
		).result();

		// Opt-in Baseten templates default to thinking-off; the CLI's fah
		// short-circuit sends an empty body for off/none rather than
		// enable_thinking: false.
		expect(captured[0].body.chat_template_args).toBeUndefined();
		expect(captured[0].body.reasoning_effort).toBeUndefined();
	});

	it("does not suppress reasoning when a named tool is forced (kimi)", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			kimiK3(),
			{
				messages: [{ role: "user", content: "read the file", timestamp: 1 }],
				tools: [
					{
						name: "Read",
						description: "read a file",
						parameters: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			},
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")),
				reasoning: Effort.High,
				toolChoice: { type: "tool", name: "Read" },
			},
		).result();

		expect(captured[0].body.tool_choice).toEqual({ type: "function", function: { name: "Read" } });
		expect(captured[0].body.reasoning_effort).toBe("high");
		expect(captured[0].body.reasoning_history).toBe("preserved");
	});

	it("does not invent synthetic reasoning_content or content for kimi tool-call history", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			kimiK3(),
			{
				messages: [
					{ role: "user", content: "read the file", timestamp: 1 },
					...toolTurn("k"),
					{ role: "user", content: "now summarize", timestamp: 4 },
				],
			},
			{ apiKey: "workos-token", fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")) },
		).result();

		const messages = captured[0].body.messages as Array<{
			role: string;
			content?: unknown;
			tool_calls?: unknown;
			reasoning_content?: unknown;
		}>;
		const toolCallTurn = messages.find(message => message.role === "assistant" && message.tool_calls);
		expect(toolCallTurn).toBeDefined();
		expect(toolCallTurn?.reasoning_content).toBeUndefined();
		// Empty assistant content is normalized to "" for the wire, never ".".
		expect(toolCallTurn?.content).not.toBe(".");
	});

	it("replays stored reasoning_content on assistant turns for glm-5.2", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			glm52(),
			{
				messages: [
					{ role: "user", content: "think hard", timestamp: 1 },
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "stored reasoning", thinkingSignature: "reasoning_content" },
							{ type: "text", text: "the answer" },
						],
						api: "openai-completions",
						provider: "factory-droid",
						model: "glm-5.2",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
					{ role: "user", content: "continue", timestamp: 3 },
				],
			},
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "glm-5.2")),
				reasoning: Effort.High,
			},
		).result();

		expect(captured[0].headers["x-api-provider"]).toBe("baseten");
		const messages = captured[0].body.messages as Array<{ role: string; reasoning_content?: unknown }>;
		const assistantTurn = messages.find(message => message.role === "assistant");
		expect(assistantTurn?.reasoning_content).toBe("stored reasoning");
	});

	it("forces a single-space reasoning_content only on deepseek tool-call turns", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			deepseekFlash(),
			{
				messages: [
					{ role: "user", content: "read the file", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "text", text: "answer with no reasoning" }],
						api: "openai-completions",
						provider: "factory-droid",
						model: "deepseek-v4-flash-0731",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
					{ role: "user", content: "now call the tool", timestamp: 3 },
					...toolTurn("d"),
					{ role: "user", content: "summarize", timestamp: 6 },
				],
			},
			{ apiKey: "workos-token", fetch: captureFetch(captured, completionsChunks("OK", "deepseek-v4-flash-0731")) },
		).result();

		const messages = captured[0].body.messages as Array<{
			role: string;
			content?: unknown;
			tool_calls?: unknown;
			reasoning_content?: unknown;
		}>;
		const plainAssistants = messages.filter(
			message => message.role === "assistant" && typeof message.content === "string" && !message.tool_calls,
		);
		// Plain assistant turns (no tool calls, no stored reasoning) carry no forced field.
		for (const turn of plainAssistants) {
			expect(turn.reasoning_content).toBeUndefined();
		}
		const toolCallTurn = messages.find(message => message.role === "assistant" && message.tool_calls);
		expect(toolCallTurn).toBeDefined();
		// Tool-call turns force the native single-space placeholder, not "".
		expect(toolCallTurn?.reasoning_content).toBe(" ");
	});

	it("replays stored reasoning_content for nemotron while keeping the Baseten template switch", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			nemotron(),
			{
				messages: [
					{ role: "user", content: "think hard", timestamp: 1 },
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "nemotron reasoning", thinkingSignature: "reasoning_content" },
							{ type: "text", text: "the answer" },
						],
						api: "openai-completions",
						provider: "factory-droid",
						model: "nemotron-3-ultra",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
					{ role: "user", content: "continue", timestamp: 3 },
				],
			},
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "nemotron-3-ultra")),
				reasoning: Effort.High,
			},
		).result();

		expect(captured[0].headers["x-api-provider"]).toBe("baseten");
		// Nemotron is opt-in on Baseten: the template switch stays, and the
		// captured reasoning replays on the assistant turn.
		expect(captured[0].body.chat_template_args).toEqual({ enable_thinking: true });
		const messages = captured[0].body.messages as Array<{ role: string; reasoning_content?: unknown }>;
		const assistantTurn = messages.find(message => message.role === "assistant");
		expect(assistantTurn?.reasoning_content).toBe("nemotron reasoning");
	});
});
