import { describe, expect, it } from "bun:test";
import {
	convertCodexResponsesMessages,
	streamOpenAICodexResponses,
} from "@pk-nerdsaver-ai/pi-ai/providers/openai-codex-responses";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "@pk-nerdsaver-ai/pi-ai/providers/openai-responses";
import { buildResponsesInput } from "@pk-nerdsaver-ai/pi-ai/providers/openai-shared";
import type { Context, Model, ModelSpec, ProviderSessionState } from "@pk-nerdsaver-ai/pi-ai/types";
import { createOpenAIResponsesHistoryPayload, truncateResponseItemId } from "@pk-nerdsaver-ai/pi-ai/utils";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function createCodexToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `${header}.${payload}.signature`;
}

/**
 * Returns the bundled `gpt-5-mini` model with `compat.requiresJuiceZeroHack`
 * cleared so it doesn't trigger the GPT-5 "Juice: 0" developer-message hack
 * injected by `applyResponsesReasoningParams`. The hack is exercised by its
 * own targeted tests; these history-replay tests assert raw payload shape and
 * should stay independent of it.
 */
function getOpenAIReasoningModel(
	provider: Parameters<typeof getBundledModel>[0],
	id: string,
): Model<"openai-responses"> {
	const base = getBundledModel(provider, id) as Model<"openai-responses">;
	// Override both views: `compat` for direct use, `compatConfig` so tests
	// that rebuild via `buildModel({ ..., compat: model.compatConfig })` keep
	// the override through re-resolution.
	return {
		...base,
		compat: { ...base.compat, requiresJuiceZeroHack: false },
		compatConfig: { ...base.compatConfig, requiresJuiceZeroHack: false },
	};
}

const preservedHistoryItems = [
	{ type: "message", role: "user", content: [{ type: "input_text", text: "Preserved user" }] },
	{ type: "compaction", encrypted_content: "enc_123" },
];

const fallbackHistoryItems = [
	{ type: "message", role: "user", content: [{ type: "input_text", text: "Recovered user" }] },
];

const snapshotHistoryItems = [
	{ type: "message", role: "user", content: [{ type: "input_text", text: "Canonical user" }] },
	{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Canonical assistant" }] },
];

const preservedHistoryContext: Context = {
	messages: [
		{
			role: "user",
			content: "summary that should be ignored",
			providerPayload: createOpenAIResponsesHistoryPayload("openai", preservedHistoryItems, false),
			timestamp: Date.now(),
		},
	],
};

const assistantSnapshotContext: Context = {
	messages: [
		{ role: "user", content: "generic history that should be replaced", timestamp: Date.now() },
		makeAssistantMessage(snapshotHistoryItems),
		{ role: "user", content: "follow-up user", timestamp: Date.now() },
	],
};

const codexAssistantSnapshotContext: Context = {
	messages: [
		{ role: "user", content: "generic history that should be replaced", timestamp: Date.now() },
		makeAssistantMessage(snapshotHistoryItems, false, "openai-codex", "gpt-5.2-codex"),
		{ role: "user", content: "follow-up user", timestamp: Date.now() },
	],
};

const codexToCopilotContext: Context = {
	messages: [
		{ role: "user", content: "generic user before switch", timestamp: Date.now() },
		{
			...makeAssistantMessage([], false, "openai-codex", "gpt-5.2-codex"),
			content: [{ type: "text", text: "generic assistant that should be rebuilt" }],
			providerPayload: createOpenAIResponsesHistoryPayload("openai-codex", [
				{ type: "reasoning", encrypted_content: "enc_123" },
				...snapshotHistoryItems,
			]),
		},
		{ role: "user", content: "follow-up user", timestamp: Date.now() },
	],
};

const resumedSameProviderContext: Context = {
	messages: [
		{
			role: "user",
			content: "summary that should be preserved",
			providerPayload: createOpenAIResponsesHistoryPayload("openai", fallbackHistoryItems, false),
			timestamp: Date.now(),
		},
		{
			...makeAssistantMessage([{ type: "reasoning", encrypted_content: "enc_123" }, ...snapshotHistoryItems]),
			content: [{ type: "text", text: "generic assistant that should be rebuilt" }],
		},
		{ role: "user", content: "follow-up user", timestamp: Date.now() },
	],
};

const resumedCopilotSameProviderContext: Context = {
	messages: [
		{
			role: "user",
			content: "summary that should be preserved",
			providerPayload: createOpenAIResponsesHistoryPayload("github-copilot", fallbackHistoryItems, false),
			timestamp: Date.now(),
		},
		{
			...makeAssistantMessage(
				[{ type: "reasoning", encrypted_content: "enc_123" }, ...snapshotHistoryItems],
				false,
				"github-copilot",
				"gpt-5.4",
			),
			content: [{ type: "text", text: "generic assistant that should be rebuilt" }],
		},
		{ role: "user", content: "follow-up user", timestamp: Date.now() },
	],
};

const resumedSameProviderWithRemoteCompactionPayloadContext: Context = {
	messages: [
		{
			role: "user",
			content: "summary that should be preserved",
			providerPayload: createOpenAIResponsesHistoryPayload("openai", preservedHistoryItems, false),
			timestamp: Date.now(),
		},
		{
			...makeAssistantMessage([], false),
			content: [{ type: "text", text: "generic assistant that should be preserved" }],
		},
		{ role: "user", content: "follow-up user", timestamp: Date.now() },
	],
};

const resumedSameProviderWithStaleThinkingContext: Context = {
	messages: [
		{
			role: "user",
			content: "summary that should be preserved",
			timestamp: Date.now(),
		},
		{
			...makeAssistantMessage([], false),
			content: [
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: JSON.stringify({ type: "reasoning", id: "stale", encrypted_content: "enc_stale" }),
				},
				{ type: "text", text: "generic assistant that should be rebuilt" },
			],
			providerPayload: createOpenAIResponsesHistoryPayload("openai", [
				{ type: "reasoning", encrypted_content: "enc_snapshot" },
			]),
		},
		{ role: "user", content: "follow-up user", timestamp: Date.now() },
	],
};

function markResponsesProviderSessionStateWarmed(providerSessionState: Map<string, ProviderSessionState>): void {
	const state = providerSessionState.values().next().value as
		| (ProviderSessionState & { nativeHistoryReplayWarmed: boolean })
		| undefined;
	if (!state) throw new Error("Expected OpenAI Responses provider session state");
	state.nativeHistoryReplayWarmed = true;
}

function captureResponsesPayload(
	model: Model<"openai-responses">,
	context: Context,
	providerSessionState?: Map<string, ProviderSessionState>,
	options?: Omit<OpenAIResponsesOptions, "apiKey" | "signal" | "providerSessionState" | "onPayload">,
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAIResponses(model, context, {
		apiKey: "test-key",
		signal: createAbortedSignal(),
		providerSessionState,
		...options,
		onPayload: payload => resolve(payload),
	});
	return promise;
}

function captureCodexPayload(model: Model<"openai-codex-responses">, context: Context): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICodexResponses(model, context, {
		apiKey: createCodexToken("acc_test"),
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return promise;
}

const incrementalItems1 = [
	{
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text: "First response" }],
		status: "completed",
		id: "msg_1",
		phase: "commentary",
	},
];

const incrementalItems2 = [
	{
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text: "Second response" }],
		status: "completed",
		id: "msg_2",
		phase: "final_answer",
	},
];

function makeAssistantMessage(
	items: Record<string, unknown>[],
	incremental = false,
	provider: "openai" | "openai-codex" | "github-copilot" = "openai",
	model = provider === "openai-codex" ? "gpt-5.2-codex" : provider === "github-copilot" ? "gpt-5.4" : "gpt-5-mini",
) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ignored" }],
		api: provider === "openai-codex" ? ("openai-codex-responses" as const) : ("openai-responses" as const),
		provider,
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		providerPayload: createOpenAIResponsesHistoryPayload(provider, items, incremental),
		timestamp: Date.now(),
	};
}

const incrementalContext: Context = {
	messages: [
		{ role: "user", content: "first question", timestamp: Date.now() },
		makeAssistantMessage(incrementalItems1, true),
		{ role: "user", content: "second question", timestamp: Date.now() },
		makeAssistantMessage(incrementalItems2, true),
		{ role: "user", content: "third question", timestamp: Date.now() },
	],
};

function containsAssistantOutputText(input: unknown[] | undefined, text: string): boolean {
	return (input ?? []).some(item => {
		if (!item || typeof item !== "object") return false;
		const candidate = item as { type?: unknown; role?: unknown; content?: unknown };
		if (candidate.type !== "message" || candidate.role !== "assistant" || !Array.isArray(candidate.content))
			return false;
		return candidate.content.some(part => {
			if (!part || typeof part !== "object") return false;
			const content = part as { type?: unknown; text?: unknown };
			return content.type === "output_text" && content.text === text;
		});
	});
}

function containsEncryptedReasoning(input: unknown[] | undefined): boolean {
	return (input ?? []).some(item => {
		if (!item || typeof item !== "object") return false;
		const candidate = item as { encrypted_content?: unknown };
		return typeof candidate.encrypted_content === "string";
	});
}

function findResponsesInputItem(input: unknown[] | undefined, type: string): Record<string, unknown> | undefined {
	return input?.find(item => {
		if (!item || typeof item !== "object") return false;
		return (item as { type?: unknown }).type === type;
	}) as Record<string, unknown> | undefined;
}

function containsUserInputText(input: unknown[] | undefined, text: string): boolean {
	return (input ?? []).some(item => {
		if (!item || typeof item !== "object") return false;
		const candidate = item as { role?: unknown; content?: unknown };
		if (candidate.role !== "user" || !Array.isArray(candidate.content)) return false;
		return candidate.content.some(part => {
			if (!part || typeof part !== "object") return false;
			const content = part as { type?: unknown; text?: unknown };
			return content.type === "input_text" && content.text === text;
		});
	});
}

describe("OpenAI responses history payload", () => {
	it("appends user-message replacement history without wiping prefix or tail", () => {
		const middleItems = [
			{ type: "function_call", call_id: "call_middle", name: "middle_tool", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_middle", output: "middle result" },
		];
		const makeContext = (provider: "openai" | "openai-codex"): Context => ({
			messages: [
				{ role: "user", content: "prefix user", timestamp: Date.now() },
				{
					role: "user",
					content: "range archive summary",
					providerPayload: createOpenAIResponsesHistoryPayload(provider, middleItems),
					timestamp: Date.now(),
				},
				{ role: "user", content: "tail user", timestamp: Date.now() },
				{ role: "user", content: "post user", timestamp: Date.now() },
			],
		});
		const assertWireOrder = (items: unknown[]) => {
			const wire = JSON.stringify(items);
			const prefixIndex = wire.indexOf("prefix user");
			const middleIndex = wire.indexOf("middle_tool");
			const tailIndex = wire.indexOf("tail user");
			const postIndex = wire.indexOf("post user");
			expect(prefixIndex).toBeGreaterThanOrEqual(0);
			expect(middleIndex).toBeGreaterThan(prefixIndex);
			expect(tailIndex).toBeGreaterThan(middleIndex);
			expect(postIndex).toBeGreaterThan(tailIndex);

			const callIds = new Set<string>();
			const outputIds = new Set<string>();
			for (const item of items) {
				if (typeof item !== "object" || item === null) continue;
				const record = item as Record<string, unknown>;
				if (record.type === "function_call" && typeof record.call_id === "string") {
					callIds.add(record.call_id);
				}
				if (record.type === "function_call_output" && typeof record.call_id === "string") {
					outputIds.add(record.call_id);
				}
			}
			expect(callIds).toEqual(new Set(["call_middle"]));
			expect(outputIds).toEqual(new Set(["call_middle"]));
		};

		const openaiItems = buildResponsesInput({
			model: getOpenAIReasoningModel("openai", "gpt-5-mini"),
			context: makeContext("openai"),
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});
		assertWireOrder(openaiItems);

		const codexModel = getBundledModel("openai-codex", "gpt-5.2-codex") as Model<"openai-codex-responses">;
		const codexItems = convertCodexResponsesMessages(codexModel, makeContext("openai-codex"));
		assertWireOrder(codexItems);
	});

	it("prepends multiple OpenAI developer instructions in order without changing prompt cache key routing", async () => {
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const payload = (await captureResponsesPayload(
			model,
			{
				systemPrompt: ["stable instructions", "second instructions"],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			undefined,
			{ sessionId: "session-abc" },
		)) as { input?: unknown[]; prompt_cache_key?: unknown };

		expect(payload.input).toEqual([
			{ role: "developer", content: "stable instructions" },
			{ role: "developer", content: "second instructions" },
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
		]);
		expect(payload.prompt_cache_key).toBe("session-abc");
	});

	it("uses canonical instructions field for endpoints without developer-role support", async () => {
		const baseModel = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const model = buildModel({
			...baseModel,
			baseUrl: "https://proxy.example.com/v1",
			compat: baseModel.compatConfig,
		} as ModelSpec<"openai-responses">);
		const payload = (await captureResponsesPayload(model, {
			systemPrompt: ["stable instructions", "second instructions"],
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		})) as { input?: unknown[]; instructions?: string };

		expect(payload.instructions).toBe("stable instructions\n\nsecond instructions");
		expect(payload.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
	});

	it("keeps system instruction order ahead of replayed native history", async () => {
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const payload = (await captureResponsesPayload(model, {
			...assistantSnapshotContext,
			systemPrompt: ["stable instructions", "second instructions"],
		})) as { input?: unknown[] };

		expect(payload.input).toEqual([
			{ role: "developer", content: "stable instructions" },
			{ role: "developer", content: "second instructions" },
			...snapshotHistoryItems,
			{ role: "user", content: [{ type: "input_text", text: "follow-up user" }] },
		]);
	});

	it("inlines preserved replacement history for openai-responses", async () => {
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const payload = (await captureResponsesPayload(model, preservedHistoryContext)) as { input?: unknown[] };
		expect(payload.input).toEqual(preservedHistoryItems);
	});

	it("prefers assistant native history snapshots for openai-responses", async () => {
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const payload = (await captureResponsesPayload(model, assistantSnapshotContext)) as { input?: unknown[] };
		expect(payload.input).toEqual([
			...snapshotHistoryItems,
			{ role: "user", content: [{ type: "input_text", text: "follow-up user" }] },
		]);
	});

	it("drops unfinished image generation calls from replayed native history", async () => {
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const context: Context = {
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				makeAssistantMessage(
					[
						{
							id: "ig_failed",
							type: "image_generation_call",
							status: "failed",
						},
						{
							id: "ig_generating",
							type: "image_generation_call",
							status: "generating",
							action: "generate",
						},
						{
							id: "ig_completed",
							type: "image_generation_call",
							status: "completed",
							result: "base64-image",
							action: "generate",
							background: "opaque",
							output_format: "png",
							quality: "medium",
						},
					],
					true,
				),
				{ role: "user", content: "follow-up user", timestamp: Date.now() },
			],
		};
		const payload = (await captureResponsesPayload(model, context)) as { input?: unknown[] };
		const imageGenerationItems = payload.input?.filter(item => {
			if (!item || typeof item !== "object") return false;
			return (item as { type?: unknown }).type === "image_generation_call";
		});

		expect(imageGenerationItems).toEqual([
			{
				id: "ig_completed",
				type: "image_generation_call",
				status: "completed",
				result: "base64-image",
			},
		]);
	});

	it("falls back to rebuilt history on resumed same-provider sessions with fresh session state", async () => {
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const payload = (await captureResponsesPayload(model, resumedSameProviderContext, providerSessionState)) as {
			input?: unknown[];
		};
		expect(containsEncryptedReasoning(payload.input)).toBe(false);
		expect(containsUserInputText(payload.input, "summary that should be preserved")).toBe(true);
		expect(containsAssistantOutputText(payload.input, "generic assistant that should be rebuilt")).toBe(true);
		expect(containsAssistantOutputText(payload.input, "Canonical assistant")).toBe(false);
	});

	it("does not replay stale thinking signatures when native replay is cold", async () => {
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const payload = (await captureResponsesPayload(
			model,
			resumedSameProviderWithStaleThinkingContext,
			providerSessionState,
		)) as {
			input?: unknown[];
		};

		expect(containsEncryptedReasoning(payload.input)).toBe(false);
		expect(containsUserInputText(payload.input, "summary that should be preserved")).toBe(true);
		expect(containsAssistantOutputText(payload.input, "generic assistant that should be rebuilt")).toBe(true);
	});

	it("preserves remote replacement history on cold openai session state", async () => {
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const payload = (await captureResponsesPayload(
			model,
			resumedSameProviderWithRemoteCompactionPayloadContext,
			providerSessionState,
		)) as {
			input?: unknown[];
		};

		expect(payload.input).toEqual([
			...preservedHistoryItems,
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "generic assistant that should be preserved", annotations: [] }],
				status: "completed",
				id: "msg_1",
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up user" }] },
		]);
	});

	it("replays native history after the same-provider session state is warmed", async () => {
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const providerSessionState = new Map<string, ProviderSessionState>();
		await captureResponsesPayload(model, resumedSameProviderContext, providerSessionState);
		markResponsesProviderSessionStateWarmed(providerSessionState);
		const payload = (await captureResponsesPayload(model, resumedSameProviderContext, providerSessionState)) as {
			input?: unknown[];
		};
		expect(payload.input).toEqual([
			{ type: "reasoning", encrypted_content: "enc_123" },
			...snapshotHistoryItems,
			{ role: "user", content: [{ type: "input_text", text: "follow-up user" }] },
		]);
	});

	it("does not warm GitHub Copilot replay when only OpenAI replay state is warmed", async () => {
		const openAiModel = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const copilotModel = getBundledModel("github-copilot", "gpt-5.4") as Model<"openai-responses">;
		const providerSessionState = new Map<string, ProviderSessionState>();
		await captureResponsesPayload(openAiModel, resumedSameProviderContext, providerSessionState);
		markResponsesProviderSessionStateWarmed(providerSessionState);
		const payload = (await captureResponsesPayload(
			copilotModel,
			resumedCopilotSameProviderContext,
			providerSessionState,
		)) as { input?: unknown[] };
		expect(containsEncryptedReasoning(payload.input)).toBe(false);
		expect(containsUserInputText(payload.input, "summary that should be preserved")).toBe(true);
		expect(containsAssistantOutputText(payload.input, "generic assistant that should be rebuilt")).toBe(true);
		expect(containsAssistantOutputText(payload.input, "Canonical assistant")).toBe(false);
	});

	it("prefers assistant native history snapshots for openai-codex-responses", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.2-codex") as Model<"openai-codex-responses">;
		const payload = (await captureCodexPayload(model, codexAssistantSnapshotContext)) as { input?: unknown[] };
		expect(payload.input).toEqual([
			...snapshotHistoryItems,
			{ role: "user", content: [{ type: "input_text", text: "follow-up user" }] },
		]);
	});

	it("ignores incompatible native history snapshots across providers", async () => {
		const model = getBundledModel("github-copilot", "gpt-5.4") as Model<"openai-responses">;
		const payload = (await captureResponsesPayload(model, codexToCopilotContext)) as { input?: unknown[] };
		expect(containsEncryptedReasoning(payload.input)).toBe(false);
		expect(containsAssistantOutputText(payload.input, "generic assistant that should be rebuilt")).toBe(true);
	});

	it("builds up history incrementally from multiple assistant messages", async () => {
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const payload = (await captureResponsesPayload(model, incrementalContext)) as { input?: unknown[] };
		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first question" }] },
			...incrementalItems1.map(({ id: _id, ...item }) => item),
			{ role: "user", content: [{ type: "input_text", text: "second question" }] },
			...incrementalItems2.map(({ id: _id, ...item }) => item),
			{ role: "user", content: [{ type: "input_text", text: "third question" }] },
		]);
	});

	it("preserves assistant message phase when rebuilding fallback replay history", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Commentary answer",
							textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
						},
					],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5-mini",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
				{ role: "user", content: "follow-up", timestamp: Date.now() },
			],
		};
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const payload = (await captureResponsesPayload(model, context)) as { input?: unknown[] };
		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first user" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Commentary answer", annotations: [] }],
				status: "completed",
				id: "msg_commentary",
				phase: "commentary",
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});

	it("keeps legacy plain-string text signatures when rebuilding fallback replay history", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "Legacy answer", textSignature: "msg_legacy" }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5-mini",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
				{ role: "user", content: "follow-up", timestamp: Date.now() },
			],
		};
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const payload = (await captureResponsesPayload(model, context)) as { input?: unknown[] };
		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first user" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Legacy answer", annotations: [] }],
				status: "completed",
				id: "msg_legacy",
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});

	it("strips replay-only ids and item references while preserving paired call_id values", async () => {
		const opaqueReasoningId = `item_${"copilot/reasoning+token=".repeat(8)}`;
		const opaqueMessageId = `item_${"copilot/message+opaque=".repeat(8)}`;
		const opaqueCallId = `call_${"copilot/tool-call+opaque/=".repeat(8)}`;
		const opaqueFunctionItemId = `item_${"copilot/function-item+opaque/=".repeat(8)}`;
		const replayHistoryItems: Array<Record<string, unknown>> = [
			{ type: "reasoning", id: opaqueReasoningId, encrypted_content: "enc_opaque" },
			{
				type: "message",
				role: "assistant",
				id: opaqueMessageId,
				status: "completed",
				content: [{ type: "output_text", text: "Sanitized assistant answer", annotations: [] }],
			},
			{
				type: "function_call",
				id: opaqueFunctionItemId,
				call_id: opaqueCallId,
				name: "lookup_weather",
				arguments: '{"city":"Oslo"}',
				status: "completed",
			},
			{ type: "function_call_output", id: "fco_should_be_removed", call_id: opaqueCallId, output: "72F" },
			{ type: "item_reference", id: opaqueMessageId },
		];
		const context: Context = {
			messages: [
				makeAssistantMessage(replayHistoryItems, false),
				{ role: "user", content: "follow-up user", timestamp: Date.now() },
			],
		};

		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const payload = (await captureResponsesPayload(model, context)) as { input?: unknown[] };
		const reasoningItem = findResponsesInputItem(payload.input, "reasoning");
		const messageItem = findResponsesInputItem(payload.input, "message");
		const functionCallItem = findResponsesInputItem(payload.input, "function_call");
		const functionCallOutputItem = findResponsesInputItem(payload.input, "function_call_output");
		const itemReference = findResponsesInputItem(payload.input, "item_reference");
		const expectedCallId = truncateResponseItemId(opaqueCallId, "call");

		expect(reasoningItem).toBeDefined();
		expect(messageItem).toBeDefined();
		expect(functionCallItem).toBeDefined();
		expect(functionCallOutputItem).toBeDefined();
		expect(reasoningItem?.id).toBeUndefined();
		expect(messageItem?.id).toBeUndefined();
		expect(functionCallItem?.id).toBeUndefined();
		expect(functionCallOutputItem?.id).toBeUndefined();
		expect(itemReference).toBeUndefined();
		expect(
			(payload.input ?? []).some(
				item => item && typeof item === "object" && "id" in (item as Record<string, unknown>),
			),
		).toBe(false);
		expect(reasoningItem?.encrypted_content).toBe("enc_opaque");
		expect(functionCallItem?.call_id).toBe(expectedCallId);
		expect(functionCallOutputItem?.call_id).toBe(expectedCallId);
		expect((functionCallItem?.call_id as string).length).toBeLessThanOrEqual(64);
		expect(containsAssistantOutputText(payload.input, "Sanitized assistant answer")).toBe(true);
		expect(replayHistoryItems[0]?.id).toBe(opaqueReasoningId);
		expect(replayHistoryItems[1]?.id).toBe(opaqueMessageId);
		expect(replayHistoryItems[2]?.id).toBe(opaqueFunctionItemId);
		expect(replayHistoryItems[2]?.call_id).toBe(opaqueCallId);
		expect(replayHistoryItems[3]?.id).toBe("fco_should_be_removed");
		expect(replayHistoryItems[3]?.call_id).toBe(opaqueCallId);
		expect(replayHistoryItems[4]?.id).toBe(opaqueMessageId);
	});

	it("backward compat: old full-snapshot payloads still replace history for legacy same-provider assistant turns", async () => {
		const fullSnapshotItems = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Canonical user" }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Canonical assistant" }] },
		];
		const context: Context = {
			messages: [
				{ role: "user", content: "old user message that gets replaced", timestamp: Date.now() },
				{
					...makeAssistantMessage(fullSnapshotItems, false),
					providerPayload: { type: "openaiResponsesHistory", items: fullSnapshotItems },
				},
				{ role: "user", content: "follow-up", timestamp: Date.now() },
			],
		};
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const payload = (await captureResponsesPayload(model, context)) as { input?: unknown[] };
		expect(payload.input).toEqual([
			...fullSnapshotItems,
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});
	it("rebuilds failed tool calls before replaying tool results for openai-responses", async () => {
		const callId = "call_failed_openai_1";
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "README.md" } }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5-mini",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: "Tool arguments were invalid.",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: callId,
					toolName: "read",
					content: [{ type: "text", text: "Tool execution was aborted." }],
					isError: true,
					timestamp: Date.now(),
				},
				{ role: "user", content: "Resume", timestamp: Date.now() },
			],
		};
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const payload = (await captureResponsesPayload(model, context)) as { input?: unknown[] };
		const functionCallItem = findResponsesInputItem(payload.input, "function_call");
		const functionCallOutputItem = findResponsesInputItem(payload.input, "function_call_output");

		expect(functionCallItem).toMatchObject({
			type: "function_call",
			call_id: callId,
			name: "read",
			arguments: '{"path":"README.md"}',
		});
		expect(functionCallOutputItem).toMatchObject({
			type: "function_call_output",
			call_id: callId,
			output: "Tool execution was aborted.",
		});
	});

	it("rebuilds failed tool calls before replaying tool results for openai-codex-responses", async () => {
		const callId = "call_failed_codex_1";
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "README.md" } }],
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-5.2-codex",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: "Tool arguments were invalid.",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: callId,
					toolName: "read",
					content: [{ type: "text", text: "Tool execution was aborted." }],
					isError: true,
					timestamp: Date.now(),
				},
				{ role: "user", content: "Resume", timestamp: Date.now() },
			],
		};
		const model = getBundledModel("openai-codex", "gpt-5.2-codex") as Model<"openai-codex-responses">;
		const payload = (await captureCodexPayload(model, context)) as { input?: unknown[] };
		const functionCallItem = findResponsesInputItem(payload.input, "function_call");
		const functionCallOutputItem = findResponsesInputItem(payload.input, "function_call_output");

		expect(functionCallItem).toMatchObject({
			type: "function_call",
			call_id: callId,
			name: "read",
			arguments: '{"path":"README.md"}',
		});
		expect(functionCallOutputItem).toMatchObject({
			type: "function_call_output",
			call_id: callId,
			output: "Tool execution was aborted.",
		});
	});

	it("converts orphan function_call_output replayed from providerPayload into an assistant note (issue #1351)", async () => {
		// Reproduces the symptom: a previous turn's snapshot carries a
		// `function_call_output` whose matching `function_call` was wiped by an
		// earlier `dt: false` splice (or never landed because the call was
		// rejected locally). OpenAI rejects that with
		// `400 No tool call found for function call output with call_id …`.
		const orphanCallId = "call_jR3cVxeU10g0YVtR2KSgpveO";
		const orphanOutput = "(see attached image)";
		const pairedCallId = "call_paired_ok";
		const context: Context = {
			messages: [
				{
					role: "user",
					content: "follow-up after aborted turn",
					providerPayload: createOpenAIResponsesHistoryPayload("openai", [
						{
							type: "function_call",
							call_id: pairedCallId,
							name: "read",
							arguments: '{"path":"README.md"}',
						},
						{
							type: "function_call_output",
							call_id: pairedCallId,
							output: "file contents",
						},
						{
							type: "function_call_output",
							call_id: orphanCallId,
							output: orphanOutput,
						},
					]),
					timestamp: Date.now(),
				},
			],
		};

		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const payload = (await captureResponsesPayload(model, context)) as { input?: unknown[] };

		const orphanSurvivors = (payload.input ?? []).filter(item => {
			if (!item || typeof item !== "object") return false;
			const candidate = item as { type?: unknown; call_id?: unknown };
			return candidate.type === "function_call_output" && candidate.call_id === orphanCallId;
		});
		expect(orphanSurvivors).toEqual([]);

		const pairedOutputs = (payload.input ?? []).filter(item => {
			if (!item || typeof item !== "object") return false;
			const candidate = item as { type?: unknown; call_id?: unknown };
			return candidate.type === "function_call_output" && candidate.call_id === pairedCallId;
		});
		expect(pairedOutputs).toHaveLength(1);

		const note = (payload.input ?? []).find(item => {
			if (!item || typeof item !== "object") return false;
			const candidate = item as { type?: unknown; role?: unknown; content?: unknown };
			return (
				candidate.type === "message" &&
				candidate.role === "assistant" &&
				typeof candidate.content === "string" &&
				(candidate.content as string).includes(orphanCallId)
			);
		}) as { content?: string } | undefined;
		expect(note?.content).toContain(orphanOutput);
	});
});
