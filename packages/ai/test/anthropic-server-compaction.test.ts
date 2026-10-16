import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import {
	convertAnthropicMessages,
	streamAnthropic,
	supportsAnthropicCompaction,
} from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Context, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
import {
	PromptCacheDebugJournal,
	type PromptCacheDiagnosticContextInput,
} from "@oh-my-pi/pi-ai/utils/prompt-cache-debug";
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
	state: {
		signature?: string;
		encryptedContent?: string;
		filesText?: string;
		retainedFiles?: Array<{ text: string; after: number }>;
		exactTail?: true;
	},
	provider = "anthropic",
	timestamp = 1,
): UserMessage {
	return {
		role: "user",
		content: `<summary>${SUMMARY}</summary>`,
		providerPayload: { type: "anthropicCompaction", provider, content: SUMMARY, exactTail: true, ...state },
		timestamp,
	};
}

function assistantTurn(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp,
		provider: "anthropic",
		model: model.id,
		api: "anthropic-messages",
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
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

function mockEvents(stopReason: string, modelId = model.id, cacheRead = 0): Record<string, unknown>[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_compact",
				model: modelId,
				usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: cacheRead },
			},
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
					{
						type: "compaction",
						input_tokens: 64,
						output_tokens: 2002,
						cache_creation_input_tokens: 80_082,
						cache_read_input_tokens: cacheRead,
					},
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

function diagnosticTextEvents(cacheRead: number): Record<string, unknown>[] {
	return [
		{
			type: "message_start",
			message: {
				id: `msg_diagnostic_${cacheRead}`,
				model: model.id,
				usage: { input_tokens: 64, output_tokens: 0, cache_read_input_tokens: cacheRead },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 64, output_tokens: 1, cache_read_input_tokens: cacheRead },
		},
		{ type: "message_stop" },
	];
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

	it("uses model and deployment policy, including Foundry and Claude Platform on AWS but not Bedrock's other routes", async () => {
		const oldModel = buildModel({ ...spec, id: "claude-sonnet-4-5" });
		const bedrock = buildModel({
			...spec,
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-mantle.us-west-2.api.aws",
		});
		expect(oldModel.compat.supportsServerCompaction).toBe(false);
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

	it.each([
		["amazon-bedrock", "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic", "us.anthropic.claude-opus-5-5"],
		["bedrock-mantle", "https://bedrock-mantle.us-east-1.api.aws/anthropic", "anthropic.claude-opus-5-5"],
		["bedrock-mantle", "https://bedrock-mantle.{region}.api.aws/anthropic", "anthropic.claude-opus-5-5"],
		[
			"amazon-bedrock",
			"https://bedrock-runtime-fips.us-east-1.amazonaws.com/anthropic",
			"us.anthropic.claude-opus-5-5",
		],
		[
			"bedrock-mantle",
			"https://vpce-0a1b2c3d4e5f67890-abcd1234.bedrock-mantle.us-east-1.vpce.amazonaws.com/anthropic",
			"anthropic.claude-opus-5-5",
		],
	])("sends on-demand compaction for %s at %s", async (provider, baseUrl, id) => {
		const bedrock = buildModel({ ...spec, id, provider, baseUrl });
		const response = await captureRequest(bedrock, { anthropicCompaction: {} });
		expect(response.payload.compaction).toEqual({ type: "summarize" });
		expect(response.beta).toContain("compact-2026-09-04");
		const origin = new URL(baseUrl).origin;
		expect(supportsAnthropicCompaction(bedrock, origin)).toBe(false);
		expect(supportsAnthropicCompaction(bedrock, `${origin}/openai/v1`)).toBe(false);
	});

	it("gates a first-party reroute and an opt-out on compat.bedrockMessagesApi", () => {
		const runtimeRoute = "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic";
		// Rerouted without the flag: excluded, as before Bedrock support.
		expect(supportsAnthropicCompaction(model, runtimeRoute)).toBe(false);
		const optedIn = buildModel({ ...spec, compat: { bedrockMessagesApi: true } });
		expect(supportsAnthropicCompaction(optedIn, runtimeRoute)).toBe(true);
		const optedOut = buildModel({
			...spec,
			id: "us.anthropic.claude-fable-5",
			provider: "amazon-bedrock",
			baseUrl: runtimeRoute,
			compat: { bedrockMessagesApi: false },
		});
		expect(supportsAnthropicCompaction(optedOut)).toBe(false);
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
	it("replays signed bytes first, folds retained assistant and flushes file metadata after the retained tail", async () => {
		// Retained turns predate the summary's commit time; "next" follows it.
		const summary = summaryMessage(
			{ signature: SIGNATURE, filesText: "<files>handlers.ts (Read)</files>" },
			"anthropic",
			2,
		);
		const retained = assistantTurn([{ type: "text", text: "Retained answer." }], 1);
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
		expect(wire[2]).toMatchObject({ role: "user", content: "next" });
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

	// Signed thinking in retained turns stays valid only while every byte before
	// it reaches the API as it was first sent; file metadata may only appear
	// where later turns already saw it.
	describe("retained tail stays byte-identical", () => {
		const files = "<files>handlers.ts (Read)</files>";
		const call = assistantTurn(
			[
				{ type: "thinking", thinking: "plan", thinkingSignature: "sig-plan" },
				{ type: "toolCall", id: "t1", name: "read", arguments: {} },
			],
			10,
		);
		const result = (timestamp: number): Context["messages"][number] => ({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "text", text: "file bytes" }],
			isError: false,
			timestamp,
		});
		const answer = assistantTurn(
			[
				{ type: "thinking", thinking: "check", thinkingSignature: "sig-check" },
				{ type: "text", text: "done" },
			],
			12,
		);
		const roles = (wire: Array<{ role: string; content: unknown }>) =>
			wire.map(param => (typeof param.content === "string" ? param.content : param.role));

		it("emits file metadata before the first message created after the summary, never inside the tail", () => {
			const summary = summaryMessage({ signature: SIGNATURE, filesText: files }, "anthropic", 20);
			const wire = convertAnthropicMessages(
				[summary, call, result(11), answer, { role: "user", content: "next", timestamp: 21 }],
				model,
				false,
				{ replayCompaction: true },
			);
			expect(roles(wire)).toEqual(["assistant", "user", "assistant", files, "next"]);
			// The retained turns keep their signed thinking.
			expect(JSON.stringify(wire)).toContain("sig-plan");
			expect(JSON.stringify(wire)).toContain("sig-check");
		});

		it("defers file metadata past tool results that complete a retained tool_use turn", () => {
			const summary = summaryMessage({ signature: SIGNATURE, filesText: files }, "anthropic", 11);
			const wire = convertAnthropicMessages([summary, call, result(12), answer], model, false, {
				replayCompaction: true,
			});
			expect(roles(wire)).toEqual(["assistant", "user", files, "assistant", "Continue."]);
		});

		it("keeps a developer message ending the retained tail a user turn ahead of trailing file metadata", () => {
			const summary = summaryMessage({ signature: SIGNATURE, filesText: files }, "anthropic", 20);
			const reminder: Context["messages"][number] = {
				role: "developer",
				content: "<system-reminder>budget</system-reminder>",
				timestamp: 12,
			};
			const wire = convertAnthropicMessages([summary, call, result(11), reminder], preserved, false, {
				replayCompaction: true,
			});
			// As a `system` message it would sit before a user turn, which the API rejects.
			expect(wire.map(param => param.role)).toEqual(["assistant", "user", "user", "user"]);
			expect(roles(wire).at(-1)).toBe(files);
		});

		it("replays earlier summaries' metadata at their own points inside the tail", () => {
			const summary = summaryMessage(
				{
					signature: SIGNATURE,
					filesText: files,
					retainedFiles: [{ text: "<files>old.ts (Read)</files>", after: 11 }],
				},
				"anthropic",
				20,
			);
			const wire = convertAnthropicMessages(
				[summary, call, result(11), answer, { role: "user", content: "next", timestamp: 21 }],
				model,
				false,
				{ replayCompaction: true },
			);
			expect(roles(wire)).toEqual(["assistant", "user", "<files>old.ts (Read)</files>", "assistant", files, "next"]);
		});

		it("ends a compaction request where the summarized range ends", () => {
			const summary = summaryMessage({ signature: SIGNATURE, filesText: files }, "anthropic", 20);
			const prefix: Context["messages"] = [summary, call, result(11), answer];
			// Metadata due at or after the cutoff replays with the retained tail
			// (e.g. merged into a kept user turn): it stays out, and a final
			// assistant turn gets no `Continue.`.
			const keptWithTail = convertAnthropicMessages(prefix, model, false, {
				replayCompaction: true,
				compactionRequest: { filesDueBefore: 12 },
			});
			expect(roles(keptWithTail)).toEqual(["assistant", "user", "assistant"]);
			// Metadata due before the cutoff closes the range.
			const closesRange = convertAnthropicMessages(prefix, model, false, {
				replayCompaction: true,
				compactionRequest: { filesDueBefore: 22 },
			});
			expect(roles(closesRange)).toEqual(["assistant", "user", "assistant", files]);
		});

		it("keeps the original layout for summaries persisted without exactTail", () => {
			// Thinking created after such a compaction was signed with the
			// metadata right after the first retained turn; moving it would
			// change the bytes before that thinking.
			const persisted = JSON.parse(
				JSON.stringify(summaryMessage({ signature: SIGNATURE, filesText: files }, "anthropic", 20)),
			) as UserMessage;
			if (persisted.providerPayload?.type !== "anthropicCompaction") throw new Error("expected payload");
			delete persisted.providerPayload.exactTail;
			const later = assistantTurn(
				[
					{ type: "thinking", thinking: "after", thinkingSignature: "sig-post-compaction" },
					{ type: "text", text: "ok" },
				],
				22,
			);
			const messages: Context["messages"] = [
				persisted,
				call,
				result(11),
				answer,
				{ role: "user", content: "next", timestamp: 21 },
				later,
				{ role: "user", content: "resume", timestamp: 23 },
			];
			const wire = convertAnthropicMessages(messages, model, false, { replayCompaction: true });
			expect(roles(wire)).toEqual(["assistant", "user", files, "assistant", "next", "assistant", "resume"]);
			expect(JSON.stringify(wire)).toContain("sig-post-compaction");
			// A compaction request over it stops before that metadata when the
			// retained tail starts at the first turn.
			const request = convertAnthropicMessages([persisted], model, false, {
				replayCompaction: true,
				compactionRequest: { filesDueBefore: 10 },
			});
			expect(roles(request)).toEqual(["assistant"]);
		});
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

	it("places a new tool addition after compaction file metadata, not before a user turn", async () => {
		const first = await captureRequest(preserved, options, context.messages, [readTool]);
		const opened = keptFrom(first);
		const summary = summaryMessage(
			{ signature: SIGNATURE, filesText: "<files>handlers.ts (Read)</files>" },
			"anthropic",
			3,
		);
		const request = await captureRequest(
			preserved,
			options,
			[...context.messages, opened, summary],
			[readTool, addedTool],
		);
		const wire = request.payload.messages;
		if (!Array.isArray(wire)) throw new Error("Expected wire messages");
		const controls = toolControls(wire);
		expect(controls).toHaveLength(1);
		const controlIndex = controls[0]?.index ?? -1;
		expect(wire[controlIndex]?.role).toBe("system");
		const filesIndex = wire.findIndex(message => JSON.stringify(message).includes("<files>handlers.ts"));
		expect(filesIndex).toBeGreaterThan(-1);
		expect(controlIndex).toBeGreaterThan(filesIndex);
		expect(wire[controlIndex + 1]?.role === "assistant" || controlIndex === wire.length - 1).toBe(true);
	});

	it("makes no tool or effort change of its own on a compaction request", async () => {
		const live = { ...options, thinkingEnabled: true, effort: "high" as const };
		const first = await captureRequest(preserved, live, context.messages, [readTool, removedTool]);
		const summarized: Context["messages"] = [
			...context.messages,
			keptFrom(first),
			{ role: "user", content: "more", timestamp: 3 },
		];
		// The live turn whose reply is kept after the summary.
		const kept = await captureRequest(preserved, live, summarized, [readTool, removedTool]);
		// Roster and effort change before compacting. Live turns send both after the
		// kept reply; between it and the summarized range they would break its thinking.
		const compaction = await captureRequest(
			preserved,
			{ ...options, thinkingEnabled: true, effort: "low", anthropicCompaction: {} },
			summarized,
			[readTool],
			[removedTool],
		);
		const withoutCacheControl = (value: unknown): unknown =>
			JSON.parse(JSON.stringify(value), (key, inner) => (key === "cache_control" ? undefined : inner));
		expect(compaction.payload.compaction).toBeDefined();
		expect(compaction.payload.tools).toEqual(kept.payload.tools);
		expect(compaction.payload.output_config).toEqual(kept.payload.output_config);
		expect(withoutCacheControl(compaction.payload.messages)).toEqual(withoutCacheControl(kept.payload.messages));

		// The next live turn sends both changes once, after the kept reply.
		const next = await captureRequest(
			preserved,
			{ ...options, thinkingEnabled: true, effort: "low" },
			[summaryMessage({ signature: SIGNATURE }), keptFrom(kept), { role: "user", content: "next", timestamp: 4 }],
			[readTool],
			[removedTool],
		);
		const wire = next.payload.messages;
		if (!Array.isArray(wire)) throw new Error("Expected wire messages");
		const keptIndex = wire.findIndex(message => JSON.stringify(message).includes("sig_kept"));
		const controls = toolControls(wire);
		const efforts = wire.flatMap((message, index) => (message.output_config?.effort === "low" ? [index] : []));
		expect(controls).toHaveLength(1);
		expect(JSON.parse(controls[0]?.json ?? "{}").content).toEqual([
			{ type: "tool_removal", tool: { type: "tool_reference", name: "grep" } },
		]);
		expect(efforts).toHaveLength(1);
		// The kept reply folds into the compaction block's assistant message.
		expect(keptIndex).toBe(0);
		expect(controls[0]?.index).toBeGreaterThan(keptIndex);
		expect(efforts[0]).toBeGreaterThan(keptIndex);
	});

	it("keeps an effort change of the turn the block opened behind the compaction block", async () => {
		const opened: AssistantMessage = {
			...keptFrom({ message: {} as AssistantMessage }),
			requestControls: { messageIndex: 1, effort: { topLevel: "high", tail: "low" } },
		};
		const request = await captureRequest(preserved, { ...options, thinkingEnabled: true, effort: "low" }, [
			summaryMessage({ signature: SIGNATURE }),
			opened,
			{ role: "user", content: "next", timestamp: 3 },
		]);
		const wire = request.payload.messages;
		if (!Array.isArray(wire)) throw new Error("Expected wire messages");
		expect(wire[0]?.content?.[0]).toEqual({ type: "compaction", content: SUMMARY, signature: SIGNATURE });
		const effortIndex = wire.findIndex(message => message.output_config?.effort === "low");
		const nextIndex = wire.findIndex(message => JSON.stringify(message).includes('"next"'));
		expect(effortIndex).toBe(1);
		expect(nextIndex).toBe(2);
	});

	it("applies an effort change before a summary replayed as text", async () => {
		const opened: AssistantMessage = {
			...keptFrom({ message: {} as AssistantMessage }),
			requestControls: { messageIndex: 1, effort: { topLevel: "high", tail: "low" } },
		};
		const request = await captureRequest(preserved, { ...options, thinkingEnabled: true, effort: "low" }, [
			summaryMessage({ signature: SIGNATURE }, "different-provider"),
			opened,
			{ role: "user", content: "next", timestamp: 3 },
		]);
		const wire = request.payload.messages;
		if (!Array.isArray(wire)) throw new Error("Expected wire messages");
		expect(JSON.stringify(wire)).not.toContain('"type":"compaction"');
		expect(wire.findIndex(message => message.output_config?.effort === "low")).toBe(0);
		expect(JSON.stringify(wire[1])).toContain("<summary>");
	});
});

describe("Anthropic prompt-cache diagnostic adapter", () => {
	it("records caller context across a signed on-demand compaction and isolates journal sequences", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prompt-cache-adapter-"));
		const firstJournal = new PromptCacheDebugJournal({ filePath: path.join(tempDir, "first.jsonl") });
		const secondJournal = new PromptCacheDebugJournal({ filePath: path.join(tempDir, "second.jsonl") });
		try {
			await withEnv({ PI_PROMPT_CACHE_DEBUG: "1" }, async () => {
				let cacheRead = 700;
				let compaction = false;
				const fetchMock: typeof fetch = Object.assign(
					async (_input: string | URL | Request, init?: RequestInit) => {
						if (compaction) {
							expect(JSON.parse(String(init?.body ?? "{}")).compaction).toEqual({ type: "summarize" });
							return sseResponse(mockEvents("compaction", model.id, cacheRead));
						}
						return sseResponse(diagnosticTextEvents(cacheRead));
					},
					{ preconnect: fetch.preconnect },
				);
				const transitionState: PromptCacheDiagnosticContextInput = {
					branchState: { timestamp: 10, fromId: "branch-a" },
					compactionState: { timestamp: 20 },
					pruneState: 30,
				};
				const adapterContext: Context = {
					systemPrompt: ["stable"],
					tools: [
						{
							name: "lookup",
							description: "stable",
							parameters: { type: "object", properties: {}, additionalProperties: false },
						},
					],
					messages: [{ role: "user", content: "stable", timestamp: 1 }],
				};
				const options = (
					journal: PromptCacheDebugJournal,
					promptCacheDiagnosticContext?: PromptCacheDiagnosticContextInput,
				) => ({
					apiKey: "sk-ant-test",
					cacheRetention: "short" as const,
					sessionId: "anthropic-diagnostic-adapter-regression",
					...(promptCacheDiagnosticContext ? { promptCacheDiagnosticContext } : {}),
					providerOptions: { promptCacheDiagnosticJournal: journal },
					fetch: fetchMock,
				});

				await streamAnthropic(model, adapterContext, options(firstJournal)).result();
				cacheRead = 2;
				compaction = true;
				const compacted = await streamAnthropic(model, adapterContext, {
					...options(firstJournal, transitionState),
					anthropicCompaction: {},
				}).result();
				expect(compacted.providerPayload).toMatchObject({ content: SUMMARY, signature: SIGNATURE });
				compaction = false;
				cacheRead = 1;
				await streamAnthropic(model, adapterContext, options(firstJournal, transitionState)).result();
				cacheRead = 0;
				await streamAnthropic(
					model,
					adapterContext,
					options(firstJournal, { ...transitionState, compactionState: { timestamp: 40 } }),
				).result();
				cacheRead = 900;
				await streamAnthropic(
					model,
					{ messages: [{ role: "user", content: "other-session", timestamp: 3 }] },
					{ ...options(secondJournal), sessionId: "other-session" },
				).result();
			});

			await firstJournal.flush();
			await secondJournal.flush();
			const sequences = async (filePath: string) =>
				(await Bun.file(filePath).text())
					.trim()
					.split("\n")
					.map(line => {
						const record: unknown = JSON.parse(line);
						if (!record || typeof record !== "object" || !("sequence" in record)) {
							throw new Error("journal record omitted a sequence");
						}
						if (typeof record.sequence !== "number") throw new Error("journal sequence is not numeric");
						return record.sequence;
					});
			expect(await sequences(path.join(tempDir, "first.jsonl"))).toEqual([1, 2, 3, 4]);
			expect(await sequences(path.join(tempDir, "second.jsonl"))).toEqual([1]);

			const [first, second, third, fourth] = firstJournal.records;
			expect(first?.bodySource).toBe("wire");
			expect(second?.bodySource).toBe("wire");
			expect(second?.context.compaction).toBe("absent");
			expect(second?.context.branchStateDigest).not.toBeNull();
			expect(second?.context.compactionStateDigest).not.toBeNull();
			expect(second?.context.pruneStateDigest).not.toBeNull();
			expect(second?.context.mutation).toBe("compaction");
			expect(second?.reset).toMatchObject({ observed: true, cause: "compaction-branch-replay" });
			expect(third?.context.branchStateDigest).toBe(second?.context.branchStateDigest);
			expect(third?.context.compactionStateDigest).toBe(second?.context.compactionStateDigest);
			expect(third?.context.mutation).not.toBe("compaction");
			expect(third?.reset).toMatchObject({ observed: true, cause: "unknown" });
			expect(fourth?.context.compactionStateDigest).not.toBe(third?.context.compactionStateDigest);
			expect(fourth?.context.mutation).toBe("compaction");
			expect(fourth?.reset).toMatchObject({ observed: true, cause: "compaction-branch-replay" });
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
