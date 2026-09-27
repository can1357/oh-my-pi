import { describe, expect, it } from "bun:test";
import {
	convertAnthropicMessages,
	streamAnthropic,
	supportsAnthropicCompaction,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Context, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withEnv, withOfficialAnthropicEndpoint } from "./helpers";

const spec: ModelSpec<"anthropic-messages"> = {
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};
const model = buildModel(spec);
const SUMMARY = "## Goal\nAudit the handlers.\n\n## Next Steps\nContinue with chunk 11.";
const SIGNATURE = "sig_opaque_on_demand";
const ENCRYPTED = "enc_opaque_legacy";
const vertexUrl =
	"https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-fable-5:rawPredict";
const context: Context = {
	systemPrompt: ["Keep the audit concise."],
	messages: [{ role: "user", content: "Audit the handlers.", timestamp: 1 }],
};

function summaryMessage(
	state: { signature?: string; encryptedContent?: string; filesText?: string },
	provider = "anthropic",
): UserMessage {
	return {
		role: "user",
		content: `<summary>${SUMMARY}</summary>`,
		providerPayload: { type: "anthropicCompaction", provider, content: SUMMARY, ...state },
		timestamp: 1,
	};
}

async function captureRequest(
	requestModel: Model<"anthropic-messages">,
	options: Parameters<typeof streamAnthropic>[2],
	messages: Context["messages"] = context.messages,
	tools?: Context["tools"],
	inactiveTools?: Context["inactiveTools"],
): Promise<{ beta: string; payload: Record<string, unknown>; message: AssistantMessage }> {
	let beta = "";
	let payload: Record<string, unknown> = {};
	const fetchMock: typeof fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
			const body: unknown = JSON.parse(String(init?.body ?? "{}"));
			payload = body !== null && typeof body === "object" ? { ...body } : {};
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		},
		{ preconnect: fetch.preconnect },
	);
	const message = await streamAnthropic(
		requestModel,
		{ ...context, messages, tools, inactiveTools },
		{
			apiKey: "sk-ant-test",
			...options,
			fetch: fetchMock,
		},
	).result();
	return { beta, payload, message };
}

async function captureInjected(
	requestModel: Model<"anthropic-messages">,
	baseURL: string | undefined,
	options: Parameters<typeof streamAnthropic>[2],
	messages: Context["messages"] = context.messages,
): Promise<{ beta: string; payload: Record<string, unknown> }> {
	let beta = "";
	let payload: Record<string, unknown> = {};
	await streamAnthropic(
		requestModel,
		{ ...context, messages },
		{
			apiKey: "sk-ant-test",
			...options,
			client: {
				...(baseURL ? { baseURL } : {}),
				messages: {
					create: (value, requestOptions) => {
						payload = { ...value };
						beta = new Headers(requestOptions?.headers).get("anthropic-beta") ?? "";
						throw new Error("captured");
					},
				},
			},
		},
	).result();
	return { beta, payload };
}

function mockEvents(stopReason: string, modelId = model.id): Record<string, unknown>[] {
	return [
		{
			type: "message_start",
			message: { id: "msg_compact", model: modelId, usage: { input_tokens: 0, output_tokens: 0 } },
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "compaction", content: SUMMARY, signature: SIGNATURE },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: stopReason },
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				iterations: [
					{ type: "compaction", input_tokens: 64, output_tokens: 2002, cache_creation_input_tokens: 80_082 },
				],
			},
		},
		{ type: "message_stop" },
	];
}

function sseResponse(events: Record<string, unknown>[]): Response {
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

withOfficialAnthropicEndpoint();

describe("Anthropic on-demand compaction requests", () => {
	it("sends top-level summarize with instructions, strips conflicting controls and retains normal non-compaction behavior", async () => {
		const opts: Parameters<typeof streamAnthropic>[2] = {
			thinkingEnabled: true,
			toolChoice: "any",
			stopSequences: ["HALT"],
			taskBudget: { type: "tokens", total: 4096, remaining: 1024 },
			anthropicCompaction: { instructions: "Record the findings." },
		};
		const compacting = await captureRequest(model, opts);
		expect(compacting.payload.compaction).toEqual({ type: "summarize", instructions: "Record the findings." });
		expect(compacting.payload.context_management).toBeUndefined();
		expect(compacting.payload.stop_sequences).toBeUndefined();
		expect(compacting.payload.tool_choice).toEqual({ type: "auto" });
		expect(compacting.payload.output_config).toMatchObject({ task_budget: { type: "tokens", total: 4096 } });
		expect(JSON.stringify(compacting.payload.output_config)).not.toContain("remaining");
		expect(compacting.beta).toContain("compact-2026-09-04");
		expect(compacting.beta).not.toContain("compact-2026-01-12");
		const plain = await captureRequest(model, { thinkingEnabled: true, stopSequences: ["HALT"] });
		expect(plain.payload.context_management).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
		expect(plain.payload.stop_sequences).toEqual(["HALT"]);
		expect(plain.payload.compaction).toBeUndefined();
		expect(plain.beta).not.toContain("compact-2026-09-04");
	});

	it("strips an overridden output format and incompatible fields before dispatch", async () => {
		const response = await captureInjected(model, "https://api.anthropic.com", {
			anthropicCompaction: {},
			onPayload: value => {
				if (value === null || typeof value !== "object") return;
				return {
					...value,
					stop_sequences: ["HALT"],
					tool_choice: { type: "tool", name: "read" },
					context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
					output_config: {
						format: { type: "json_schema" },
						task_budget: { type: "tokens", total: 4096, remaining: 1024 },
					},
				};
			},
		});
		expect(response.payload.compaction).toEqual({ type: "summarize" });
		expect(response.payload.context_management).toBeUndefined();
		expect(response.payload.stop_sequences).toBeUndefined();
		expect(response.payload.tool_choice).toEqual({ type: "auto" });
		expect(response.payload.output_config).toEqual({ task_budget: { type: "tokens", total: 4096 } });
	});

	it("routes the beta through Vertex body and merges injected-client headers on the effective endpoint", async () => {
		const vertex = buildModel({ ...spec, provider: "google-vertex", baseUrl: vertexUrl });
		expect(vertex.compat.supportsContextManagement).toBe(false);
		const direct = await captureRequest(vertex, { anthropicCompaction: {} });
		expect(direct.payload.compaction).toEqual({ type: "summarize" });
		expect(direct.payload.anthropic_beta).toContain("compact-2026-09-04");
		expect(direct.beta).not.toContain("compact-2026-09-04");
		const injectedVertex = await captureInjected(model, vertexUrl, { anthropicCompaction: {} });
		expect(injectedVertex.payload.anthropic_beta).toContain("compact-2026-09-04");
		expect(injectedVertex.beta).not.toContain("compact-2026-09-04");
		const injectedOfficial = await captureInjected(model, "https://api.anthropic.com", { anthropicCompaction: {} });
		expect(injectedOfficial.payload.anthropic_beta).toBeUndefined();
		expect(injectedOfficial.beta).toContain("compact-2026-09-04");
		await withEnv({ ANTHROPIC_BASE_URL: vertexUrl }, async () => {
			const rerouted = await captureRequest(model, { thinkingEnabled: true, anthropicCompaction: {} });
			expect(rerouted.payload.compaction).toEqual({ type: "summarize" });
			expect(rerouted.payload.anthropic_beta).toContain("compact-2026-09-04");
			expect(rerouted.payload.context_management).toBeUndefined();
			expect(rerouted.beta).not.toContain("compact-2026-09-04");
		});
	});

	it("uses model and deployment policy, including Foundry and Claude Platform on AWS but not Bedrock", async () => {
		const oldModel = buildModel({ ...spec, id: "claude-sonnet-4-5" });
		const bedrock = buildModel({
			...spec,
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-mantle.us-west-2.api.aws",
		});
		expect(oldModel.compat.supportsServerCompaction).toBe(false);
		expect(bedrock.compat.supportsServerCompaction).toBe(false);
		for (const blocked of [oldModel, bedrock]) {
			const response = await captureRequest(blocked, { anthropicCompaction: {} });
			expect(response.payload.compaction).toBeUndefined();
			expect(response.beta).not.toContain("compact-2026-09-04");
		}
		expect(supportsAnthropicCompaction(model, "https://workspace.services.ai.azure.com/anthropic")).toBe(true);
		expect(supportsAnthropicCompaction(model, "https://aws-external-anthropic.us-west-2.api.aws")).toBe(true);
		expect(supportsAnthropicCompaction(model, "https://bedrock-runtime.us-west-2.amazonaws.com")).toBe(false);
		const optedIn = buildModel({ ...spec, remoteCompaction: { enabled: true } });
		expect(supportsAnthropicCompaction(optedIn, "https://bedrock-mantle.us-west-2.api.aws")).toBe(false);
		await withEnv({ ANTHROPIC_BASE_URL: "https://gateway.example.test" }, async () => {
			const response = await captureRequest(model, { anthropicCompaction: {} });
			expect(response.payload.compaction).toBeUndefined();
		});
	});
});

describe("Anthropic on-demand compaction response", () => {
	it("reads the complete signed block from content_block_start and sums usage iterations", async () => {
		let requests = 0;
		const fetchMock: typeof fetch = Object.assign(
			async () => {
				requests++;
				return sseResponse(mockEvents("compaction"));
			},
			{ preconnect: fetch.preconnect },
		);
		const result = await streamAnthropic(model, context, {
			apiKey: "sk-ant-test",
			anthropicCompaction: {},
			fetch: fetchMock,
		}).result();
		expect(result.providerPayload).toEqual({
			type: "anthropicCompaction",
			provider: "anthropic",
			content: SUMMARY,
			signature: SIGNATURE,
		});
		expect(result.stopDetails).toEqual({ type: "compaction" });
		expect(result.content).toEqual([]);
		expect(result.usage.input).toBe(64);
		expect(result.usage.output).toBe(2002);
		expect(result.usage.cacheWrite).toBe(80_082);
		expect(result.usage.totalTokens).toBe(82_148);
		expect(requests).toBe(1);
	});

	it("does not publish a block if the response stopped for another reason", async () => {
		const fetchMock: typeof fetch = Object.assign(async () => sseResponse(mockEvents("end_turn")), {
			preconnect: fetch.preconnect,
		});
		const result = await streamAnthropic(model, context, {
			apiKey: "sk-ant-test",
			anthropicCompaction: {},
			fetch: fetchMock,
		}).result();
		expect(result.providerPayload).toBeUndefined();
		expect(result.stopDetails).toBeUndefined();
	});

	it("retries a 529 compaction_unavailable response without losing the summary", async () => {
		let requests = 0;
		const fetchMock: typeof fetch = Object.assign(
			async () => {
				requests++;
				if (requests === 1) {
					return new Response(
						JSON.stringify({
							type: "error",
							error: {
								type: "overloaded_error",
								message: "Compaction unavailable",
								details: { error_code: "compaction_unavailable" },
							},
						}),
						{ status: 529, headers: { "Content-Type": "application/json" } },
					);
				}
				return sseResponse(mockEvents("compaction"));
			},
			{ preconnect: fetch.preconnect },
		);
		const result = await streamAnthropic(model, context, {
			apiKey: "sk-ant-test",
			anthropicCompaction: {},
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();
		expect(requests).toBe(2);
		expect(result.providerPayload).toMatchObject({ content: SUMMARY, signature: SIGNATURE });
	});

	it("does not retry a compaction signature 400 as a thinking-signature failure", async () => {
		let requests = 0;
		const fetchMock: typeof fetch = Object.assign(
			async () => {
				requests++;
				return new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message: "compaction_signature_invalid: Invalid `signature` in `thinking` block",
						},
					}),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			},
			{ preconnect: fetch.preconnect },
		);
		const result = await streamAnthropic(model, context, {
			apiKey: "sk-ant-test",
			fetch: fetchMock,
			providerSessionState: new Map(),
		}).result();
		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("compaction_signature_invalid");
	});
});

describe("Anthropic compaction replay", () => {
	it("replays signed bytes first, folds retained assistant and flushes file metadata after that turn", async () => {
		const summary = summaryMessage({ signature: SIGNATURE, filesText: "<files>handlers.ts (Read)</files>" });
		const retained: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Retained answer." }],
			timestamp: 2,
			provider: "anthropic",
			model: model.id,
			api: "anthropic-messages",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const messages: Context["messages"] = [summary, retained, { role: "user", content: "next", timestamp: 3 }];
		const wire = convertAnthropicMessages(messages, model, false, { replayCompaction: true });
		expect(wire[0]).toEqual({
			role: "assistant",
			content: [
				{ type: "compaction", content: SUMMARY, signature: SIGNATURE },
				{ type: "text", text: "Retained answer." },
			],
		});
		expect(wire[1]).toEqual({ role: "user", content: "<files>handlers.ts (Read)</files>" });
		const request = await captureRequest(model, { thinkingEnabled: true }, messages);
		expect(request.beta).toContain("compact-2026-09-04");
		expect(request.payload.context_management).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
		expect(JSON.stringify(request.payload.messages)).toContain(SIGNATURE);
		expect(JSON.stringify(request.payload.messages)).not.toContain("encrypted_content");
		const budgetReplay = await captureRequest(
			model,
			{ taskBudget: { type: "tokens", total: 4096, remaining: 500 } },
			messages,
		);
		expect(budgetReplay.payload.output_config).toEqual({ task_budget: { type: "tokens", total: 4096 } });
	});

	it("keeps legacy encrypted replay read-only with its beta and never-firing edit", async () => {
		const legacy = summaryMessage({ encryptedContent: ENCRYPTED });
		const messages: Context["messages"] = [legacy, { role: "user", content: "next", timestamp: 2 }];
		const reply = await captureRequest(model, {}, messages);
		expect(reply.beta).toContain("compact-2026-01-12");
		expect(reply.beta).not.toContain("compact-2026-09-04");
		expect(reply.payload.context_management).toEqual({
			edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 1_000_000 } }],
		});
		expect(JSON.stringify(reply.payload.messages)).toContain(ENCRYPTED);
		const newRequest = await captureRequest(model, { anthropicCompaction: {} }, messages);
		expect(newRequest.payload.compaction).toEqual({ type: "summarize" });
		expect(newRequest.payload.context_management).toBeUndefined();
		expect(JSON.stringify(newRequest.payload.messages)).not.toContain(ENCRYPTED);
		expect(JSON.stringify(newRequest.payload.messages)).toContain("<summary>");
	});

	it("keeps readable summary text if model, provider or endpoint cannot replay the block", async () => {
		const foreign = summaryMessage({ signature: SIGNATURE }, "different-provider");
		const unsupported = buildModel({ ...spec, id: "claude-sonnet-4-5" });
		const cases: Array<{ requestModel: Model<"anthropic-messages">; messages: Context["messages"] }> = [
			{ requestModel: model, messages: [foreign, { role: "user", content: "next", timestamp: 2 }] },
			{
				requestModel: unsupported,
				messages: [summaryMessage({ signature: SIGNATURE }), { role: "user", content: "next", timestamp: 2 }],
			},
		];
		for (const { requestModel, messages } of cases) {
			const response = await captureRequest(requestModel, {}, messages);
			expect(response.beta).not.toContain("compact-2026-09-04");
			expect(JSON.stringify(response.payload.messages)).toContain("<summary>");
		}
	});

	const preserved = buildModel({ ...spec, id: "claude-fable-5-1" });
	const readTool: NonNullable<Context["tools"]>[number] = {
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: {} },
	};
	const removedTool: NonNullable<Context["tools"]>[number] = {
		name: "grep",
		description: "Search files",
		parameters: { type: "object", properties: {} },
	};
	const addedTool: NonNullable<Context["tools"]>[number] = {
		name: "write",
		description: "Write a file",
		parameters: { type: "object", properties: {} },
	};
	const tools = [readTool, addedTool];
	const options = { sessionId: "conversation" };

	/** The retained assistant turn with signed thinking, answering the request `from` captured. */
	function keptFrom(from: { message: AssistantMessage }): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Keep this reasoning.", thinkingSignature: "sig_kept" },
				{ type: "text", text: "Audit continues." },
			],
			timestamp: 2,
			provider: "anthropic",
			model: preserved.id,
			api: "anthropic-messages",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			requestControls: from.message.requestControls,
		};
	}

	/** Wire messages carrying `tool_addition`/`tool_removal` blocks, with their indices. */
	function toolControls(wire: unknown): { index: number; json: string }[] {
		if (!Array.isArray(wire)) throw new Error("Expected wire messages");
		return wire
			.map((message, index) => ({ index, json: JSON.stringify(message) }))
			.filter(({ json }) => json.includes('"tool_addition"') || json.includes('"tool_removal"'));
	}

	it("keeps the declared tools through compaction and restates net changes after kept thinking", async () => {
		const first = await captureRequest(preserved, options, context.messages, [readTool, removedTool]);
		const kept = keptFrom(first);
		const later: Context["messages"] = [...context.messages, kept, { role: "user", content: "more", timestamp: 3 }];
		const changed = await captureRequest(preserved, options, later, tools, [removedTool]);
		expect(JSON.stringify(changed.payload.messages)).toContain("tool_addition");
		expect(JSON.stringify(changed.payload.messages)).toContain("tool_removal");
		const swapped = await captureRequest(
			preserved,
			options,
			[summaryMessage({ signature: SIGNATURE }), kept, { role: "user", content: "next", timestamp: 4 }],
			tools,
			[removedTool],
		);
		expect(swapped.payload.tools).toEqual(changed.payload.tools);
		expect(swapped.payload.system).toEqual(changed.payload.system);
		const wire = swapped.payload.messages;
		if (!Array.isArray(wire)) throw new Error("Expected wire messages");
		const nextIndex = wire.findIndex(message => JSON.stringify(message).includes('"next"'));
		const changeIndex = wire.findIndex(message => JSON.stringify(message).includes('"tool_addition"'));
		expect(nextIndex).toBeGreaterThan(0);
		expect(changeIndex).toBeGreaterThan(nextIndex);
		expect(JSON.stringify(wire[changeIndex])).toContain("tool_removal");
		expect(JSON.stringify(wire)).toContain("sig_kept");
	});

	it("re-issues roster changes the summary absorbed after the retained tail", async () => {
		const first = await captureRequest(preserved, options, context.messages, [readTool, removedTool]);
		const later: Context["messages"] = [
			...context.messages,
			keptFrom(first),
			{ role: "user", content: "more", timestamp: 3 },
		];
		const changed = await captureRequest(preserved, options, later, tools, [removedTool]);
		expect(changed.message.requestControls).toMatchObject({
			messageIndex: 3,
			tools: { declared: ["read", "grep", "write"], deferred: ["write"], active: ["read", "write"] },
		});
		// The kept turn answered `changed`, whose tool control is now inside the summary.
		const swapped = await captureRequest(
			preserved,
			options,
			[summaryMessage({ signature: SIGNATURE }), keptFrom(changed), { role: "user", content: "next", timestamp: 4 }],
			tools,
			[removedTool],
		);

		expect(swapped.payload.tools).toEqual(changed.payload.tools);
		const wire = swapped.payload.messages;
		if (!Array.isArray(wire)) throw new Error("Expected wire messages");
		const controls = toolControls(wire);
		expect(controls).toHaveLength(1);
		const [control] = controls;
		expect(JSON.parse(control?.json ?? "{}").content).toEqual([
			{ type: "tool_removal", tool: { type: "tool_reference", name: "grep" } },
			{ type: "tool_addition", tool: { type: "tool_reference", name: "write" } },
		]);
		const nextIndex = wire.findIndex(message => JSON.stringify(message).includes('"next"'));
		expect(control?.index).toBeGreaterThan(nextIndex);
		const keptIndex = wire.findIndex(message => JSON.stringify(message).includes("sig_kept"));
		expect(wire.slice(0, keptIndex).some(message => message.role === "system")).toBe(false);
	});
});
