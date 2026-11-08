import { describe, expect, it, vi } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import {
	createOpenAIResponsesHistoryPayload,
	sanitizeOpenAIResponsesHistoryItemsForReplay,
} from "@oh-my-pi/pi-ai/utils";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Switching models mid-session to a reasoning model served through a proxy that
// translates Responses requests into chat completions made that proxy fabricate
// `reasoning_content: "[reasoning unavailable]"` for every replayed tool-call
// turn that carried no reasoning item. The model echoed the placeholder back as
// its own thinking, omp displayed it, and the recorded item kept the next turn
// pinned to the same text.
//
// The replay must therefore carry reasoning the proxy can forward: a reasoning
// item on every tool-call turn, with a summary the proxy actually reads.

const PLACEHOLDER = "[reasoning unavailable]";

const gatewayModel = buildModel({
	id: "nvidia/mistral-large-4-1t-a52b",
	name: "Mistral Large (NVIDIA NIM via proxy)",
	api: "openai-responses",
	provider: "cliproxy",
	baseUrl: "http://127.0.0.1:8317/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 16384,
	// The proxy serves `/v1/responses` by translating the request into chat
	// completions, so it fabricates `[reasoning unavailable]` for a replayed
	// tool-call turn that carries no reasoning item.
	compat: { translatesResponsesToChatCompletions: true },
}) as Model<"openai-responses">;

const officialModel = getBundledModel("openai", "gpt-5.5") as Model<"openai-responses">;

/** The same proxy without the translation flag: a plain Responses endpoint. */
const plainProxyModel = buildModel({
	id: "nvidia/mistral-large-4-1t-a52b",
	name: "Mistral Large (plain Responses proxy)",
	api: "openai-responses",
	provider: "cliproxy",
	baseUrl: "http://127.0.0.1:8317/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 16384,
}) as Model<"openai-responses">;

interface SummaryPart {
	type: string;
	text: string;
}

interface InputItem {
	type: string;
	id?: string;
	summary?: SummaryPart[];
	content?: Array<{ type: string; text?: string }>;
	encrypted_content?: string;
	call_id?: string;
	name?: string;
	role?: string;
}

interface ResponsesPayload {
	input?: InputItem[];
	reasoning?: { effort?: string; summary?: string };
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

async function capture(
	context: Context,
	model: Model<"openai-responses"> = gatewayModel,
	reasoning: "high" | null = "high",
): Promise<ResponsesPayload> {
	const { promise, resolve } = Promise.withResolvers<ResponsesPayload>();
	const controller = new AbortController();
	controller.abort();
	streamOpenAIResponses(model, context, {
		apiKey: "sk-test",
		...(reasoning ? { reasoning } : {}),
		signal: controller.signal,
		onPayload: payload => resolve(payload as ResponsesPayload),
	});
	return promise;
}

function reasoningItems(payload: ResponsesPayload): InputItem[] {
	return (payload.input ?? []).filter(item => item.type === "reasoning");
}

function summaryTextOf(item: InputItem): string {
	return (item.summary ?? [])
		.filter(part => part.type === "summary_text")
		.map(part => part.text)
		.join("");
}

/** The assistant turn of a session that switched to another model mid-run. */
function switchedModelTurn(): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "cliproxy",
		model: "nvidia/minimax-m3.1-flash",
		stopReason: "toolUse",
		usage,
		content: [
			{ type: "thinking", thinking: "The previous model thought about the catalog." },
			{ type: "toolCall", id: "call_1", name: "grep", arguments: { pattern: "course" } },
		],
		timestamp: Date.now(),
	};
}

/** A session that switched to another model mid-run, with a tool call to replay. */
function switchedContext(): Context {
	return {
		messages: [
			{ role: "user", content: "Find the course", timestamp: Date.now() },
			switchedModelTurn(),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "grep",
				content: [{ type: "text", text: "hit" }],
				isError: false,
				timestamp: Date.now(),
			},
			{ role: "user", content: "Continue", timestamp: Date.now() },
		],
	};
}

describe("Responses replay behind a chat-completions proxy", () => {
	it("gives a tool-call turn a reasoning item with a summary after a model switch", async () => {
		const payload = await capture(switchedContext());
		const reasoning = reasoningItems(payload);
		expect(reasoning.length).toBeGreaterThan(0);
		for (const item of reasoning) {
			const summary = summaryTextOf(item);
			expect(summary.length).toBeGreaterThan(0);
			expect(summary).not.toBe(PLACEHOLDER);
		}
		// A usable summary is what keeps the proxy from substituting its own
		// placeholder for the turn.
		expect(JSON.stringify(payload.input ?? [])).not.toContain(PLACEHOLDER);
	});

	it("carries the turn's own thinking into the summary", async () => {
		// The previous turn's thinking survived the switch, so the summary has to
		// carry it: the proxy forwards the summary and ignores everything else.
		const turn: AssistantMessage = {
			...switchedModelTurn(),
			model: gatewayModel.id,
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Find the course", timestamp: Date.now() },
				turn,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "grep",
					content: [{ type: "text", text: "hit" }],
					isError: false,
					timestamp: Date.now(),
				},
				{ role: "user", content: "Continue", timestamp: Date.now() },
			],
		};

		const payload = await capture(context);
		const reasoning = reasoningItems(payload);
		expect(reasoning.length).toBeGreaterThan(0);
		expect(summaryTextOf(reasoning[0]!)).toContain("The previous model thought about the catalog.");
	});

	it("replaces a recorded placeholder item with a forwardable one", async () => {
		// The proxy recorded its own placeholder as the turn's reasoning. Replaying
		// it would feed the placeholder back to the model.
		const prior: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "cliproxy",
			model: gatewayModel.id,
			stopReason: "toolUse",
			usage,
			content: [{ type: "toolCall", id: "call_1", name: "grep", arguments: { pattern: "course" } }],
			providerPayload: createOpenAIResponsesHistoryPayload(
				"cliproxy",
				[
					{
						id: "rs_chatcmpl-eb1e4735_0",
						type: "reasoning",
						encrypted_content: "",
						summary: [{ type: "summary_text", text: PLACEHOLDER }],
					},
					{
						id: "fc_766e4e4fc",
						type: "function_call",
						status: "completed",
						arguments: '{"pattern":"course"}',
						call_id: "call_1",
						name: "grep",
					},
				],
				true,
			),
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Find the course", timestamp: Date.now() },
				prior,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "grep",
					content: [{ type: "text", text: "hit" }],
					isError: false,
					timestamp: Date.now(),
				},
				{ role: "user", content: "Continue", timestamp: Date.now() },
			],
		};

		const payload = await capture(context);
		const reasoning = reasoningItems(payload);
		expect(reasoning.length).toBeGreaterThan(0);
		for (const item of reasoning) {
			expect(summaryTextOf(item)).not.toBe(PLACEHOLDER);
			expect(summaryTextOf(item).length).toBeGreaterThan(0);
		}
		const serialized = JSON.stringify(payload.input ?? []);
		expect(serialized).not.toContain(PLACEHOLDER);
	});

	it("leaves official endpoints without a synthesized reasoning item", async () => {
		const payload = await capture(switchedContext(), officialModel, "high");
		expect(reasoningItems(payload)).toHaveLength(0);
	});

	it("leaves an endpoint without the translation flag untouched", async () => {
		// The synthesized reasoning item is a wire-shape change: only endpoints
		// declared as Responses-to-chat-completions bridges get it.
		const payload = await capture(switchedContext(), plainProxyModel, "high");
		expect(reasoningItems(payload)).toHaveLength(0);
	});

	it("leaves a request without a reasoning effort untouched", async () => {
		// The proxy only fabricates the placeholder while the request engages
		// reasoning; without an effort there is nothing to preempt.
		const payload = await capture(switchedContext(), gatewayModel, null);
		expect(reasoningItems(payload)).toHaveLength(0);
	});

	it("does not keep a gateway placeholder as the turn's thinking", async () => {
		// The proxy answered with its own placeholder. Storing it would show the
		// text as the model's thinking and pin the next turn to it.
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { id: "rs_1", type: "reasoning", summary: [] },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					id: "rs_1",
					type: "reasoning",
					summary: [{ type: "summary_text", text: PLACEHOLDER }],
					content: [{ type: "reasoning_text", text: PLACEHOLDER }],
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		];
		const sse = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
		const fetchMock = vi.fn(
			async () =>
				new Response(new TextEncoder().encode(sse), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);

		const result = await streamOpenAIResponses(
			gatewayModel,
			{ messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
			{
				apiKey: "sk-test",
				reasoning: "high",
				fetch: fetchMock as unknown as typeof fetch,
			},
		).result();

		const thinking = result.content.find(block => block.type === "thinking");
		expect(thinking?.type === "thinking" ? thinking.thinking : "").not.toContain(PLACEHOLDER);
		expect(thinking?.type === "thinking" ? thinking.thinkingSignature : undefined).toBeUndefined();
	});
});

describe("Gateway placeholder handling off the wire", () => {
	it("drops a placeholder thinking block instead of demoting it to prose", () => {
		// A turn from another model normally demotes its unsigned thinking block
		// to prose. A gateway placeholder must never reach the wire that way: the
		// next turn would replay it as the model's own words.
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "cliproxy",
			model: "other/model",
			stopReason: "stop",
			usage,
			content: [
				{ type: "thinking", thinking: PLACEHOLDER },
				{ type: "text", text: "Done." },
			],
			timestamp: Date.now(),
		};
		const transformed = transformMessages([{ role: "user", content: "hi", timestamp: 1 }, assistant], gatewayModel);
		const blocks = transformed.flatMap(message => (message.role === "assistant" ? message.content : []));
		expect(blocks.some(block => block.type === "text" && block.text.includes(PLACEHOLDER))).toBe(false);
		expect(blocks.some(block => block.type === "thinking" && block.thinking.includes(PLACEHOLDER))).toBe(false);
	});

	it("keeps the upstream reasoning blob but not the placeholder text", () => {
		// The signature carries the upstream item with its opaque reasoning blob:
		// that is the server's own reasoning and replays natively for the model
		// that minted it. The visible text is only the proxy's placeholder.
		const signature = JSON.stringify({
			id: "rs_1",
			type: "reasoning",
			encrypted_content: "opaque-blob",
			summary: [{ type: "summary_text", text: PLACEHOLDER }],
		});
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "cliproxy",
			model: gatewayModel.id,
			stopReason: "stop",
			usage,
			content: [{ type: "thinking", thinking: PLACEHOLDER, thinkingSignature: signature }],
			timestamp: Date.now(),
		};
		const transformed = transformMessages([{ role: "user", content: "hi", timestamp: 1 }, assistant], gatewayModel);
		const thinking = transformed
			.flatMap(message => (message.role === "assistant" ? message.content : []))
			.find(block => block.type === "thinking");
		expect(thinking).toBeDefined();
		expect(thinking?.type === "thinking" ? thinking.thinking : "").toBe("");
		expect(thinking?.type === "thinking" ? thinking.thinkingSignature : undefined).toBe(signature);
	});

	it("strips only the placeholder part from a recorded reasoning item", () => {
		// The upstream item mixes the proxy's placeholder with real reasoning
		// text: replaying the placeholder would feed it back to the model, while
		// dropping the whole item would lose the real reasoning.
		const replayed = sanitizeOpenAIResponsesHistoryItemsForReplay([
			{
				id: "rs_1",
				type: "reasoning",
				summary: [
					{ type: "summary_text", text: PLACEHOLDER },
					{ type: "summary_text", text: "Real reasoning summary." },
				],
				content: [
					{ type: "reasoning_text", text: PLACEHOLDER },
					{ type: "reasoning_text", text: "Real reasoning body." },
				],
			},
		]);
		const serialized = JSON.stringify(replayed);
		expect(serialized).not.toContain(PLACEHOLDER);
		expect(serialized).toContain("Real reasoning summary.");
		expect(serialized).toContain("Real reasoning body.");
	});
});
