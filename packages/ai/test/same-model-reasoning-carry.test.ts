/**
 * Reasoning carry between hosts of the same model.
 *
 * An earlier turn's reasoning replays natively on a different host when the
 * family declares `portable-reasoning` in KDL, both hosts classify to the same
 * class/family/revision, the target's encoder already replays its own
 * reasoning natively, and the stored text is the trace rather than a
 * provider-written summary. Everything else keeps today's demotion to visible
 * `<think>` text.
 *
 * Models are built from specs so the KDL rules, not baked rows, decide.
 */
import { describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
	GetUserJwtResponseSchema,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const TRACE = "Earlier reasoning: read foo.ts, then patch bar().";
const THINK = `<think>\n${TRACE}\n</think>`;
const DEMOTED = `${THINK}\nPatched.`;

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Source = Pick<AssistantMessage, "provider" | "api" | "model">;

function priorTurn(source: Source, thinking: { thinkingSignature?: string; summary?: boolean } = {}): AssistantMessage {
	return {
		role: "assistant",
		...source,
		content: [
			{ type: "thinking", thinking: TRACE, summary: false, ...thinking },
			{ type: "text", text: "Patched." },
		],
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: 1,
	};
}

function history(prior: AssistantMessage): Message[] {
	return [
		{ role: "user", content: "fix the bug", timestamp: 0 },
		prior,
		{ role: "user", content: "continue", timestamp: 2 },
	];
}

function target<TApi extends Api>(
	api: TApi,
	provider: string,
	id: string,
	compat?: ModelSpec<TApi>["compat"],
): Model<TApi> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 32_768,
		...(compat && { compat }),
	} as ModelSpec<TApi>);
}

function completionsAssistant(model: Model<"openai-completions">, messages: Message[]): Record<string, unknown> {
	const assistant = convertMessages(model, { messages }, model.compat).find(message => message.role === "assistant");
	if (!assistant) throw new Error("assistant message missing");
	return assistant as unknown as Record<string, unknown>;
}

/**
 * The assistant-side input items of the Responses request omp sends on a fresh
 * provider session (the state right after a host switch), captured before any
 * network call.
 */
async function responsesAssistantItems(
	model: Model<"openrouter">,
	messages: Message[],
	options: { filterReasoningHistory?: boolean } = {},
): Promise<unknown[]> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const controller = new AbortController();
	controller.abort();
	// OpenRouter's default wire is the Responses transport.
	const responsesModel = model as unknown as Model<"openai-responses">;
	streamOpenAIResponses(
		responsesModel,
		{ messages },
		{
			apiKey: "test-key",
			signal: controller.signal,
			providerSessionState: new Map(),
			reasoning: "low",
			...options,
			onPayload: payload => resolve(payload),
		},
	);
	const payload = await promise;
	const input = payload && typeof payload === "object" && "input" in payload ? payload.input : undefined;
	if (!Array.isArray(input)) throw new Error("Responses input missing");
	return input.filter(
		(item: unknown) =>
			typeof item === "object" &&
			item !== null &&
			(("type" in item && item.type === "reasoning") || ("role" in item && item.role === "assistant")),
	);
}

/** Captures the Cascade request omp's Devin provider sends, without a model call. */
async function devinRequest(model: Model<"devin-agent">, messages: Message[]) {
	const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
	let requestPayload: Uint8Array | undefined;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		if (String(input).includes("GetUserJwt")) return new Response(authPayload);
		requestPayload = new Uint8Array(init?.body as ArrayBuffer);
		return new Response(new Uint8Array());
	}) as typeof fetch;
	await streamDevin(model, { messages }, { apiKey: "token", fetch: fetchImpl }).result();
	if (!requestPayload) throw new Error("Devin chat request was not captured");
	const view = new DataView(requestPayload.buffer, requestPayload.byteOffset, requestPayload.byteLength);
	const compressed = requestPayload.subarray(5, 5 + view.getUint32(1, false));
	return fromBinary(GetChatMessageRequestSchema, gunzipSync(compressed));
}

const moonshotK3 = () => target("openai-completions", "moonshot", "kimi-k3");
const openRouterK3 = () => target("openrouter", "openrouter", "moonshotai/kimi-k3");
const factoryK3: Source = { provider: "factory-droid", api: "openai-completions", model: "kimi-k3" };
const fieldSignature = { thinkingSignature: "reasoning_content" };

describe("same-model reasoning carry", () => {
	it("replays another K3 host's reasoning in Moonshot's reasoning_content", () => {
		const wire = completionsAssistant(moonshotK3(), history(priorTurn(factoryK3, fieldSignature)));

		expect(wire.reasoning_content).toBe(TRACE);
		expect(wire.content).toBe("Patched.");
	});

	it("drops another host's Responses item and replays only its text", () => {
		const openRouterItem = JSON.stringify({
			id: "rs_tmp_abc123",
			type: "reasoning",
			status: "completed",
			content: [{ type: "reasoning_text", text: TRACE }],
			summary: [],
		});
		const source: Source = { provider: "openrouter", api: "openrouter", model: "moonshotai/kimi-k3" };

		const wire = completionsAssistant(
			moonshotK3(),
			history(priorTurn(source, { thinkingSignature: openRouterItem })),
		);

		expect(wire.reasoning_content).toBe(TRACE);
		expect(wire.content).toBe("Patched.");
	});

	it("replays carried reasoning as an id-less plaintext item on a fresh OpenRouter Responses session", async () => {
		const items = await responsesAssistantItems(openRouterK3(), history(priorTurn(factoryK3, fieldSignature)));

		expect(items).toEqual([
			{ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: TRACE }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Patched.", annotations: [] }],
				status: "completed",
			},
		]);
	});

	it("demotes instead of dropping when the request filters reasoning history", async () => {
		const items = await responsesAssistantItems(openRouterK3(), history(priorTurn(factoryK3, fieldSignature)), {
			filterReasoningHistory: true,
		});

		expect(JSON.stringify(items)).toContain(`"text":${JSON.stringify(THINK)}`);
	});

	it("sends carried reasoning in Devin's thinking field", async () => {
		const request = await devinRequest(
			target("devin-agent", "devin", "kimi-k3"),
			history(priorTurn(factoryK3, fieldSignature)),
		);

		expect(request.chatMessagePrompts[1]).toMatchObject({ prompt: "Patched.", thinking: TRACE, signature: "" });
	});

	it("still demotes on a host whose encoder drops its own reasoning", () => {
		// No flag makes this host's encoder write reasoning for its own turns,
		// so it has no native slot to carry into either.
		const noSlot = target("openai-completions", "custom-k3", "kimi-k3", {
			thinkingFormat: "openai",
			requiresReasoningContentForToolCalls: false,
		});
		const ownSource: Source = { provider: "custom-k3", api: "openai-completions", model: "kimi-k3" };
		expect(
			completionsAssistant(noSlot, history(priorTurn(ownSource, fieldSignature))).reasoning_content,
		).toBeUndefined();

		const carried = completionsAssistant(noSlot, history(priorTurn(factoryK3, fieldSignature)));

		expect(carried.reasoning_content).toBeUndefined();
		expect(carried.content).toBe(DEMOTED);
	});

	it("never carries reasoning from a host that opts out", () => {
		const cursorK3: Source = { provider: "cursor", api: "cursor-agent", model: "kimi-k3" };

		const wire = completionsAssistant(moonshotK3(), history(priorTurn(cursorK3)));

		expect(wire.reasoning_content).not.toBe(TRACE);
		expect(wire.content).toBe(DEMOTED);
	});

	it("never carries reasoning from modified weights that classify as the base model", async () => {
		// Abliteration's Large is an abliterated GLM 5.2 and classifies as GLM 5.2.
		const abliterated: Source = {
			provider: "abliteration",
			api: "openai-responses",
			model: "abliterated-model-large",
		};

		const items = await responsesAssistantItems(
			target("openrouter", "openrouter", "z-ai/glm-5.2"),
			history(priorTurn(abliterated)),
		);

		expect(JSON.stringify(items)).toContain(`"text":${JSON.stringify(THINK)}`);
	});

	it("never carries a provider-written summary", () => {
		const source: Source = { provider: "openrouter", api: "openrouter", model: "moonshotai/kimi-k3" };

		const wire = completionsAssistant(moonshotK3(), history(priorTurn(source, { summary: true })));

		expect(wire.reasoning_content).not.toBe(TRACE);
		expect(wire.content).toBe(DEMOTED);
	});

	describe("reasoning recorded before parsers confirmed the trace stays text", () => {
		const source: Source = { provider: "openrouter", api: "openrouter", model: "moonshotai/kimi-k3" };
		const summaryItem = {
			id: "rs_legacy",
			type: "reasoning",
			summary: [{ type: "summary_text", text: TRACE }],
		};
		const unconfirmed = { summary: undefined };

		it("with its item in the signature", () => {
			const prior = JSON.parse(
				JSON.stringify(priorTurn(source, { ...unconfirmed, thinkingSignature: JSON.stringify(summaryItem) })),
			) as AssistantMessage;

			const wire = completionsAssistant(moonshotK3(), history(prior));

			expect(wire.reasoning_content).not.toBe(TRACE);
			expect(wire.content).toBe(DEMOTED);
		});

		it("keyed by item id", () => {
			const prior = priorTurn(source);
			prior.content[0] = { type: "thinking", thinking: TRACE, itemId: summaryItem.id };
			prior.providerPayload = { type: "openaiResponsesHistory", items: [summaryItem] };

			const wire = completionsAssistant(moonshotK3(), history(prior));

			expect(wire.content).toBe(DEMOTED);
		});

		it("with no item id, its summary only in the native-history payload", () => {
			const prior = priorTurn(source, unconfirmed);
			prior.providerPayload = { type: "openaiResponsesHistory", items: [summaryItem] };

			const wire = completionsAssistant(moonshotK3(), history(prior));

			expect(wire.content).toBe(DEMOTED);
		});

		it("already reparented, with neither signature nor payload", () => {
			const wire = completionsAssistant(moonshotK3(), history(priorTurn(source, unconfirmed)));

			expect(wire.content).toBe(DEMOTED);
		});
	});

	it("keeps an errored turn's reasoning as text on a Responses host", async () => {
		const prior = priorTurn(factoryK3, fieldSignature);
		prior.stopReason = "error";

		const items = await responsesAssistantItems(openRouterK3(), history(prior));

		expect(JSON.stringify(items)).toContain(`"text":${JSON.stringify(THINK)}`);
	});

	it("judges a routed turn by the model that actually served it", () => {
		const devinK3: Source = { provider: "devin", api: "devin-agent", model: "kimi-k3" };
		const servedElsewhere = { ...priorTurn(devinK3), upstreamModel: "MODEL_GOOGLE_GEMINI_3_PRO" };
		const servedByK3 = { ...priorTurn(devinK3), upstreamModel: "kimi-k3" };

		expect(completionsAssistant(moonshotK3(), history(servedElsewhere)).content).toBe(DEMOTED);
		expect(completionsAssistant(moonshotK3(), history(servedByK3)).reasoning_content).toBe(TRACE);
	});

	it("carries the same DeepSeek revision between hosts", () => {
		const source: Source = { provider: "openrouter", api: "openrouter", model: "deepseek/deepseek-v4-flash" };

		const wire = completionsAssistant(
			target("openai-completions", "deepseek", "deepseek-v4-flash"),
			history(priorTurn(source, fieldSignature)),
		);

		expect(wire.reasoning_content).toBe(TRACE);
		expect(wire.content).toBe("Patched.");
	});

	it("still demotes reasoning from a different revision of the family", () => {
		const source: Source = { provider: "openrouter", api: "openrouter", model: "deepseek/deepseek-v4-flash" };

		const wire = completionsAssistant(
			target("openai-completions", "deepseek", "deepseek-v4.1-flash"),
			history(priorTurn(source, fieldSignature)),
		);

		expect(wire.reasoning_content).not.toBe(TRACE);
		expect(wire.content).toBe(DEMOTED);
	});

	it("keeps demoting a family that is not declared portable, even with a matching identity", async () => {
		// gpt-5.6-sol and gpt-5.6-terra share class/family/revision; GPT reasoning
		// reaches omp as summaries plus encrypted content, so it is not declared.
		const terra: Source = { provider: "openai-codex", api: "openai-codex-responses", model: "gpt-5.6-terra" };

		const items = await responsesAssistantItems(
			target("openrouter", "openrouter", "openai/gpt-5.6-sol"),
			history(priorTurn(terra)),
		);
		const wire = JSON.stringify(items);

		expect(wire).not.toContain(`"reasoning_text","text":${JSON.stringify(TRACE)}`);
		expect(wire).toContain(`"text":${JSON.stringify(THINK)}`);
	});
});

describe("Responses reasoning provenance is recorded at parse time", () => {
	/** A turn streamed from OpenRouter's Responses wire through the public `stream()` path. */
	async function parseTurn(events: Record<string, unknown>[]): Promise<AssistantMessage> {
		const all = [
			{ type: "response.created", response: { id: "resp_1", status: "in_progress" } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
			...events,
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "message", id: "msg_1", role: "assistant", content: [] },
			},
			{ type: "response.output_text.delta", output_index: 1, item_id: "msg_1", content_index: 0, delta: "Patched." },
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Patched.", annotations: [] }],
				},
			},
			{ type: "response.completed", response: { id: "resp_1", status: "completed" } },
		];
		const body = all.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
		const fetchImpl = Object.assign(
			async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
			{ preconnect: fetch.preconnect },
		);
		return stream(openRouterK3(), { messages: [] }, { apiKey: "test-key", fetch: fetchImpl }).result();
	}
	const parseReasoning = async (events: Record<string, unknown>[]) => (await parseTurn(events)).content[0];
	const done = (item: Record<string, unknown>) => ({
		type: "response.output_item.done",
		output_index: 0,
		item: { type: "reasoning", id: "rs_1", ...item },
	});
	const delta = (type: string, text: string) => ({
		type,
		output_index: 0,
		item_id: "rs_1",
		content_index: 0,
		summary_index: 0,
		delta: text,
	});

	it("marks summary_text reasoning as a summary", async () => {
		const block = await parseReasoning([
			delta("response.reasoning_summary_text.delta", TRACE),
			done({ summary: [{ type: "summary_text", text: TRACE }] }),
		]);

		expect(block).toMatchObject({ type: "thinking", thinking: TRACE, summary: true });
	});

	it("marks reasoning_text content as the confirmed trace", async () => {
		const block = await parseReasoning([
			delta("response.reasoning_text.delta", TRACE),
			done({ summary: [], content: [{ type: "reasoning_text", text: TRACE }] }),
		]);

		expect(block).toMatchObject({ type: "thinking", thinking: TRACE, summary: false });
	});

	it("keeps a streamed summary out of the next host's reasoning field", async () => {
		const prior = await parseTurn([delta("response.reasoning_summary_text.delta", TRACE), done({ summary: [] })]);

		const wire = completionsAssistant(moonshotK3(), history(prior));

		expect(wire.reasoning_content).not.toBe(TRACE);
		expect(wire.content).toBe(DEMOTED);
	});

	it("judges a done item without text by the streamed event type", async () => {
		const trace = await parseReasoning([delta("response.reasoning_text.delta", TRACE), done({ summary: [] })]);
		const summary = await parseReasoning([
			delta("response.reasoning_summary_text.delta", TRACE),
			done({ summary: [] }),
		]);

		expect(trace).toMatchObject({ type: "thinking", thinking: TRACE, summary: false });
		expect(summary).toMatchObject({ type: "thinking", thinking: TRACE, summary: true });
	});

	it("carries a parsed trace whose done item omits the text to another host", async () => {
		const prior = await parseTurn([delta("response.reasoning_text.delta", TRACE), done({ summary: [] })]);

		const wire = completionsAssistant(moonshotK3(), history(prior));

		expect(wire.reasoning_content).toBe(TRACE);
		expect(wire.content).toBe("Patched.");
	});
});

describe("chat-completions and Devin parsers confirm their reasoning as the trace", () => {
	it("carries a Moonshot reasoning_content turn to OpenRouter", async () => {
		const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
			`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "kimi-k3", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		const body = [
			chunk({ role: "assistant", reasoning_content: TRACE }),
			chunk({ content: "Patched." }),
			chunk({}, "stop"),
			"data: [DONE]\n\n",
		].join("");
		const fetchImpl = Object.assign(
			async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
			{ preconnect: fetch.preconnect },
		);
		const prior = await stream(moonshotK3(), { messages: [] }, { apiKey: "test-key", fetch: fetchImpl }).result();

		expect(prior.content[0]).toMatchObject({ type: "thinking", thinking: TRACE, summary: false });
		const items = await responsesAssistantItems(openRouterK3(), history(prior));
		expect(items[0]).toEqual({ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: TRACE }] });
	});

	it("carries a Devin thinking turn to Moonshot", async () => {
		const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
		const frame = (fields: { deltaThinking?: string; deltaText?: string }) => {
			const payload = toBinary(
				GetChatMessageResponseSchema,
				create(GetChatMessageResponseSchema, { messageId: "m1", ...fields }),
			);
			const out = new Uint8Array(5 + payload.length);
			new DataView(out.buffer).setUint32(1, payload.length, false);
			out.set(payload, 5);
			return out;
		};
		const body = new Uint8Array([...frame({ deltaThinking: TRACE }), ...frame({ deltaText: "Patched." })]);
		const fetchImpl = (async (input: string | URL | Request) =>
			new Response(String(input).includes("GetUserJwt") ? authPayload : body)) as typeof fetch;
		const prior = await streamDevin(
			target("devin-agent", "devin", "kimi-k3"),
			{ messages: [{ role: "user", content: "fix the bug", timestamp: 0 }] },
			{ apiKey: "token", fetch: fetchImpl },
		).result();

		expect(prior.content[0]).toMatchObject({ type: "thinking", thinking: TRACE, summary: false });
		expect(completionsAssistant(moonshotK3(), history(prior)).reasoning_content).toBe(TRACE);
	});
});
