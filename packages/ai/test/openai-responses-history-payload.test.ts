import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Context, Model, ModelSpec, ProviderSessionState, Tool } from "@oh-my-pi/pi-ai/types";
import {
	createOpenAIResponsesHistoryPayload,
	sanitizeOpenAIResponsesHistoryItemsForReplay,
} from "@oh-my-pi/pi-ai/utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import * as piUtils from "@oh-my-pi/pi-utils";

const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function getOpenAIReasoningModel(provider: GeneratedProvider, id: string): Model<"openai-responses"> {
	const model = getBundledModel<"openai-responses">(provider, id);
	return model;
}

const ISSUE_5002_PATCH = "*** Begin Patch\n*** End Patch\n";
const ISSUE_5002_TOOL_OUTPUT = "patch applied";
const issue5002XaiOAuthModel = buildModel({
	id: "grok-build",
	name: "Grok Build",
	api: "openai-responses",
	provider: "xai-oauth",
	baseUrl: "https://api.x.ai/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 256000,
	maxTokens: 64000,
} satisfies ModelSpec<"openai-responses">);

const issue5002ZeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const issue5002EditTool: Tool = {
	name: "edit",
	customWireName: "apply_patch",
	description: "Apply a hashline patch",
	parameters: type({ input: "string" }),
	customFormat: { syntax: "lark", definition: 'start: "*** Begin Patch" LF\nLF: /\\n/' },
};

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

const codexToCopilotContext: Context = {
	messages: [
		{ role: "user", content: "generic user before switch", timestamp: Date.now() },
		{
			...makeAssistantMessage([], false, "openai-codex", "gpt-5.5"),
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

// A self-hosted Responses server that returns reasoning as plaintext
// `reasoning_text` (no opaque `encrypted_content`) and caches the prompt it
// rendered, prior-turn thinking included.
const plaintextReasoningModel = buildModel({
	id: "local-reasoner",
	name: "Local Reasoner",
	api: "openai-responses",
	provider: "self-hosted",
	baseUrl: "http://127.0.0.1:8000/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131_072,
	maxTokens: 4_096,
} satisfies ModelSpec<"openai-responses">);

function plaintextReasoningItem(id: string, text: string): Record<string, unknown> {
	return { type: "reasoning", id, summary: [], content: [{ type: "reasoning_text", text }] };
}

function selfHostedAssistantTurn(
	content: AssistantMessage["content"],
	nativeItems: Record<string, unknown>[],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: plaintextReasoningModel.api,
		provider: plaintextReasoningModel.provider,
		model: plaintextReasoningModel.id,
		usage: issue5002ZeroUsage,
		stopReason,
		providerPayload: createOpenAIResponsesHistoryPayload(plaintextReasoningModel.provider, nativeItems),
		timestamp: Date.now(),
	};
}

function replayedReasoningTexts(input: unknown[] | undefined): string[] {
	return (input ?? []).flatMap(item => {
		const candidate = item as { type?: unknown; content?: unknown };
		if (candidate.type !== "reasoning" || !Array.isArray(candidate.content)) return [];
		return candidate.content.flatMap(part => (typeof part?.text === "string" ? [part.text] : []));
	});
}

function markResponsesProviderSessionStateWarmed(providerSessionState: Map<string, ProviderSessionState>): void {
	const state = providerSessionState.values().next().value as
		| (ProviderSessionState & { nativeHistoryReplayWarmed: boolean })
		| undefined;
	if (!state) throw new Error("Expected OpenAI Responses provider session state");
	state.nativeHistoryReplayWarmed = true;
}

function asConnectionBound(model: Model<"openai-responses">): Model<"openai-responses"> {
	return { ...model, compat: { ...model.compat, connectionBoundNativeHistory: true } };
}

function resumedEncryptedReasoningContext(model: Model<"openai-responses">): Context {
	return {
		messages: [
			{ role: "user", content: "first question", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "generic assistant that should be rebuilt" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: issue5002ZeroUsage,
				stopReason: "stop",
				providerPayload: createOpenAIResponsesHistoryPayload(model.provider, [
					{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc_turn_1" },
					...snapshotHistoryItems.slice(1),
				]),
				timestamp: Date.now(),
			},
			{ role: "user", content: "follow-up user", timestamp: Date.now() },
		],
	};
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
	model = provider === "openai-codex" ? "gpt-5.5" : provider === "github-copilot" ? "gpt-5.4" : "gpt-5-mini",
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

function isIssue5002Record(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	return true;
}

function findResponsesInputItemByCallId(
	input: unknown[],
	type: string,
	callId: string,
): Record<string, unknown> | undefined {
	for (const item of input) {
		if (!isIssue5002Record(item)) continue;
		if (item.type === type && item.call_id === callId) return item;
	}
	return undefined;
}

function listResponsesToolItems(input: unknown[] | undefined): Array<[unknown, unknown, unknown]> {
	const tools: Array<[unknown, unknown, unknown]> = [];
	for (const item of input ?? []) {
		if (!isIssue5002Record(item)) continue;
		if (item.type === "function_call" || item.type === "function_call_output") {
			tools.push([item.type, item.call_id, item.name]);
		}
	}
	return tools;
}

function collectResponsesInputImageDetails(input: unknown): string[] {
	const details: string[] = [];
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
			return;
		}
		if (!isIssue5002Record(node)) return;
		if (node.type === "input_image" && typeof node.detail === "string") details.push(node.detail);
		for (const key in node) visit(node[key]);
	};
	visit(input);
	return details;
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
	it("clamps stored original image hints when replay support is unknown", () => {
		const items = [
			{ type: "input_image", detail: "original", image_url: "data:image/png;base64,ZmFrZQ==" },
			{
				type: "message",
				role: "user",
				content: [{ type: "input_image", detail: "original", image_url: "data:image/png;base64,ZmFrZQ==" }],
			},
		];
		expect(collectResponsesInputImageDetails(sanitizeOpenAIResponsesHistoryItemsForReplay(items))).toEqual([
			"auto",
			"auto",
		]);
		expect(
			collectResponsesInputImageDetails(
				sanitizeOpenAIResponsesHistoryItemsForReplay(items, { supportsImageDetailOriginal: true }),
			),
		).toEqual(["original", "original"]);
	});

	it("adapts reconstructed apply_patch replay for xai-oauth while preserving OpenAI custom replay", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "previous frame" },
						{ type: "image", mimeType: "image/png", data: "ZmFrZQ==", detail: "original" },
					],
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_apply",
							name: "apply_patch",
							arguments: { input: ISSUE_5002_PATCH },
							customWireName: "apply_patch",
						},
					],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5-mini",
					usage: issue5002ZeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "call_apply",
					toolName: "edit",
					content: [{ type: "text", text: ISSUE_5002_TOOL_OUTPUT }],
					isError: false,
					timestamp: Date.now(),
				},
			],
			tools: [issue5002EditTool],
		};

		const xaiInput = buildResponsesInput({
			model: issue5002XaiOAuthModel,
			context,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: issue5002XaiOAuthModel.compat.supportsImageDetailOriginal,
			nativeHistory: { replay: true, filterReasoning: issue5002XaiOAuthModel.compat.filterReasoningHistory },
		});
		expect(findResponsesInputItemByCallId(xaiInput, "function_call", "call_apply")).toEqual({
			type: "function_call",
			call_id: "call_apply",
			name: "edit",
			arguments: JSON.stringify({ input: ISSUE_5002_PATCH }),
		});
		expect(findResponsesInputItemByCallId(xaiInput, "function_call_output", "call_apply")).toEqual({
			type: "function_call_output",
			call_id: "call_apply",
			output: ISSUE_5002_TOOL_OUTPUT,
		});
		expect(JSON.stringify(xaiInput)).not.toContain("custom_tool_call");
		expect(collectResponsesInputImageDetails(xaiInput)).toEqual(["auto"]);

		const openaiModel = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const openaiInput = buildResponsesInput({
			model: openaiModel,
			context,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: openaiModel.compat.supportsImageDetailOriginal,
			nativeHistory: { replay: true, filterReasoning: openaiModel.compat.filterReasoningHistory },
		});
		expect(findResponsesInputItemByCallId(openaiInput, "custom_tool_call", "call_apply")).toEqual({
			type: "custom_tool_call",
			call_id: "call_apply",
			name: "apply_patch",
			input: ISSUE_5002_PATCH,
		});
		expect(findResponsesInputItemByCallId(openaiInput, "custom_tool_call_output", "call_apply")).toEqual({
			type: "custom_tool_call_output",
			call_id: "call_apply",
			output: ISSUE_5002_TOOL_OUTPUT,
		});
		expect(collectResponsesInputImageDetails(openaiInput)).toEqual(["original"]);
	});

	it("adapts persisted native apply_patch Responses items for xai-oauth continuations", () => {
		const nativeHistoryItems = [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "previous native frame" },
					{ type: "input_image", detail: "original", image_url: "data:image/png;base64,ZmFrZQ==" },
				],
			},
			{ type: "custom_tool_call", call_id: "call_native_apply", name: "apply_patch", input: ISSUE_5002_PATCH },
			{
				type: "custom_tool_call_output",
				call_id: "call_native_apply",
				output: ISSUE_5002_TOOL_OUTPUT,
			},
		];
		const xaiContext: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "fallback should not be replayed" }],
					api: "openai-responses",
					provider: "xai-oauth",
					model: issue5002XaiOAuthModel.id,
					usage: issue5002ZeroUsage,
					stopReason: "stop",
					providerPayload: createOpenAIResponsesHistoryPayload("xai-oauth", nativeHistoryItems),
					timestamp: Date.now(),
				},
				{ role: "user", content: "continue", timestamp: Date.now() },
			],
		};

		const xaiInput = buildResponsesInput({
			model: issue5002XaiOAuthModel,
			context: xaiContext,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: issue5002XaiOAuthModel.compat.supportsImageDetailOriginal,
			nativeHistory: { replay: true, filterReasoning: issue5002XaiOAuthModel.compat.filterReasoningHistory },
		});
		expect(findResponsesInputItemByCallId(xaiInput, "function_call", "call_native_apply")).toEqual({
			type: "function_call",
			call_id: "call_native_apply",
			name: "edit",
			arguments: JSON.stringify({ input: ISSUE_5002_PATCH }),
		});
		expect(findResponsesInputItemByCallId(xaiInput, "function_call_output", "call_native_apply")).toEqual({
			type: "function_call_output",
			call_id: "call_native_apply",
			output: ISSUE_5002_TOOL_OUTPUT,
		});
		expect(JSON.stringify(xaiInput)).not.toContain("custom_tool_call");
		expect(collectResponsesInputImageDetails(xaiInput)).toEqual(["auto"]);

		const openaiModel = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const openaiContext: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "fallback should not be replayed" }],
					api: "openai-responses",
					provider: "openai",
					model: openaiModel.id,
					usage: issue5002ZeroUsage,
					stopReason: "stop",
					providerPayload: createOpenAIResponsesHistoryPayload("openai", nativeHistoryItems),
					timestamp: Date.now(),
				},
				{ role: "user", content: "continue", timestamp: Date.now() },
			],
		};
		const openaiInput = buildResponsesInput({
			model: openaiModel,
			context: openaiContext,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: openaiModel.compat.supportsImageDetailOriginal,
			nativeHistory: { replay: true, filterReasoning: openaiModel.compat.filterReasoningHistory },
		});
		expect(findResponsesInputItemByCallId(openaiInput, "custom_tool_call", "call_native_apply")).toEqual({
			type: "custom_tool_call",
			call_id: "call_native_apply",
			name: "apply_patch",
			input: ISSUE_5002_PATCH,
		});
		expect(findResponsesInputItemByCallId(openaiInput, "custom_tool_call_output", "call_native_apply")).toEqual({
			type: "custom_tool_call_output",
			call_id: "call_native_apply",
			output: ISSUE_5002_TOOL_OUTPUT,
		});
		expect(collectResponsesInputImageDetails(openaiInput)).toEqual(["original"]);
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

	it("falls back to rebuilt history on resumed connection-bound sessions with fresh session state", async () => {
		const model = asConnectionBound(getOpenAIReasoningModel("openai", "gpt-5-mini"));
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
		const model = asConnectionBound(getOpenAIReasoningModel("openai", "gpt-5-mini"));
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
		const model = asConnectionBound(getOpenAIReasoningModel("openai", "gpt-5-mini"));
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
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up user" }] },
		]);
	});

	it("replays native history after a connection-bound session state is warmed", async () => {
		const model = asConnectionBound(getOpenAIReasoningModel("openai", "gpt-5-mini"));
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

	it("replays encrypted reasoning on the first resumed request unless the host binds items to a connection", async () => {
		const replayed: Record<string, boolean> = {};
		for (const model of [
			getOpenAIReasoningModel("xai-oauth", "grok-4.7"),
			getOpenAIReasoningModel("openai", "gpt-5-mini"),
			getOpenAIReasoningModel("github-copilot", "gpt-5.4"),
		]) {
			const payload = (await captureResponsesPayload(model, resumedEncryptedReasoningContext(model), new Map())) as {
				input?: unknown[];
			};
			replayed[model.provider] = containsEncryptedReasoning(payload.input);
		}

		expect(replayed).toEqual({ "xai-oauth": true, openai: true, "github-copilot": false });
	});

	it("rebuilds history after the provider session state closes on a host without connection binding", async () => {
		const model = getOpenAIReasoningModel("xai-oauth", "grok-4.7");
		const context = resumedEncryptedReasoningContext(model);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const warm = (await captureResponsesPayload(model, context, providerSessionState)) as { input?: unknown[] };
		for (const state of providerSessionState.values()) state.close();
		const closed = (await captureResponsesPayload(model, context, providerSessionState)) as { input?: unknown[] };

		expect(containsEncryptedReasoning(warm.input)).toBe(true);
		expect(containsEncryptedReasoning(closed.input)).toBe(false);
		expect(containsAssistantOutputText(closed.input, "generic assistant that should be rebuilt")).toBe(true);
	});

	it("keeps a closed provider session state cold when a request started before the close succeeds", async () => {
		const model = getOpenAIReasoningModel("xai-oauth", "grok-4.7");
		const context = resumedEncryptedReasoningContext(model);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const requested = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const completed = [
			{ type: "response.created", response: { id: "resp_side" } },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_side",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "side answer" }],
				},
			},
			{ type: "response.completed", response: { id: "resp_side", status: "completed" } },
		];
		const inFlight = streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			providerSessionState,
			fetch: async () => {
				requested.resolve();
				await released.promise;
				return new Response(`${completed.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
			},
		}).result();
		await requested.promise;
		for (const state of providerSessionState.values()) state.close();
		released.resolve();
		expect((await inFlight).stopReason).toBe("stop");

		const retry = (await captureResponsesPayload(model, context, providerSessionState)) as { input?: unknown[] };
		expect(containsEncryptedReasoning(retry.input)).toBe(false);
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

	it("replays plaintext reasoning turns on a cold resumed session exactly as a warm session does", async () => {
		// A new process resumes a session whose server returned plaintext reasoning.
		// Rebuilding those turns dropped the reasoning and re-serialized tool
		// arguments, so the first resumed request no longer extended the prefix the
		// server cached and it prefilled the whole context again.
		const context: Context = {
			messages: [
				{ role: "user", content: "Read note.txt, then reply.", timestamp: Date.now() },
				selfHostedAssistantTurn(
					[
						{ type: "thinking", thinking: "Read the note first." },
						{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "note.txt" } },
					],
					[
						// An explicit `encrypted_content: null` carries no blob; the turn is still plaintext.
						{ ...plaintextReasoningItem("rs_1", "Read the note first."), encrypted_content: null },
						{
							type: "function_call",
							id: "fc_1",
							call_id: "call_1",
							name: "read",
							arguments: '{"path": "note.txt"}',
							status: "completed",
						},
					],
					"toolUse",
				),
				{
					role: "toolResult",
					toolCallId: "call_1|fc_1",
					toolName: "read",
					content: [{ type: "text", text: "hello" }],
					isError: false,
					timestamp: Date.now(),
				},
				selfHostedAssistantTurn(
					[
						{ type: "thinking", thinking: "The note says hello." },
						{ type: "text", text: "It says hello." },
					],
					[
						plaintextReasoningItem("rs_2", "The note says hello."),
						{
							type: "message",
							id: "msg_2",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "It says hello.", annotations: [] }],
						},
					],
					"stop",
				),
				{ role: "user", content: "Read it again.", timestamp: Date.now() },
			],
		};

		const cold = (await captureResponsesPayload(asConnectionBound(plaintextReasoningModel), context, new Map())) as {
			input?: unknown[];
		};
		const warm = (await captureResponsesPayload(plaintextReasoningModel, context)) as { input?: unknown[] };

		expect(replayedReasoningTexts(cold.input)).toEqual(["Read the note first.", "The note says hello."]);
		expect(findResponsesInputItemByCallId(cold.input ?? [], "function_call", "call_1")?.arguments).toBe(
			'{"path": "note.txt"}',
		);
		expect(cold.input).toEqual(warm.input);
	});

	it("replays only plaintext reasoning turns without server-issued state on a cold session", async () => {
		// Reasoning alone does not make a turn safe to replay across processes: an
		// `encrypted_content` blob or a surviving item id is exactly what #488's
		// backends bind to one connection, and summary-only reasoning is no evidence
		// of a plaintext-reasoning server. Those turns stay rebuilt even when an
		// earlier turn of the same request replays natively.
		const context: Context = {
			messages: [
				{ role: "user", content: "Read a.txt and b.txt, then draw them.", timestamp: Date.now() },
				selfHostedAssistantTurn(
					[{ type: "toolCall", id: "call_a|fc_a", name: "read", arguments: { path: "a.txt" } }],
					[
						plaintextReasoningItem("rs_a", "Start with a.txt."),
						{
							type: "function_call",
							id: "fc_a",
							call_id: "call_a",
							name: "read",
							arguments: '{"path": "a.txt"}',
						},
					],
					"toolUse",
				),
				{
					role: "toolResult",
					toolCallId: "call_a|fc_a",
					toolName: "read",
					content: [{ type: "text", text: "alpha" }],
					isError: false,
					timestamp: Date.now(),
				},
				selfHostedAssistantTurn(
					[{ type: "toolCall", id: "call_b|fc_b", name: "read", arguments: { path: "b.txt" } }],
					[
						{ ...plaintextReasoningItem("rs_b", "Now b.txt."), encrypted_content: "enc_b" },
						{
							type: "function_call",
							id: "fc_b",
							call_id: "call_b",
							name: "read",
							arguments: '{"path": "b.txt"}',
						},
					],
					"toolUse",
				),
				{
					role: "toolResult",
					toolCallId: "call_b|fc_b",
					toolName: "read",
					content: [{ type: "text", text: "beta" }],
					isError: false,
					timestamp: Date.now(),
				},
				selfHostedAssistantTurn(
					[{ type: "text", text: "Drawn." }],
					[
						plaintextReasoningItem("rs_c", "Draw both."),
						{ type: "image_generation_call", id: "ig_c", status: "completed", result: "aW1hZ2U=" },
						{
							type: "message",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Drawn.", annotations: [] }],
						},
					],
					"stop",
				),
				{ role: "user", content: "Summarize.", timestamp: Date.now() },
				selfHostedAssistantTurn(
					[{ type: "text", text: "Summary." }],
					[
						{ type: "reasoning", id: "rs_d", summary: [{ type: "summary_text", text: "Summarize both." }] },
						{
							type: "message",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Summary.", annotations: [] }],
						},
					],
					"stop",
				),
				{ role: "user", content: "Thanks.", timestamp: Date.now() },
			],
		};

		const payload = (await captureResponsesPayload(
			asConnectionBound(plaintextReasoningModel),
			context,
			new Map(),
		)) as {
			input?: unknown[];
		};
		const input = payload.input ?? [];

		expect(
			input.map(item => {
				const candidate = item as { type?: unknown; role?: unknown; call_id?: unknown };
				return candidate.call_id ? `${candidate.type}:${candidate.call_id}` : (candidate.type ?? candidate.role);
			}),
		).toEqual([
			"user",
			"reasoning",
			"function_call:call_a",
			"function_call_output:call_a",
			"function_call:call_b",
			"function_call_output:call_b",
			"message",
			"user",
			"message",
			"user",
		]);
		expect(replayedReasoningTexts(input)).toEqual(["Start with a.txt."]);
		expect(findResponsesInputItemByCallId(input, "function_call", "call_a")?.arguments).toBe('{"path": "a.txt"}');
		expect(containsEncryptedReasoning(input)).toBe(false);
		expect(JSON.stringify(input)).not.toContain("ig_c");
	});

	describe("summary-only reasoning on a warm session (#14288)", () => {
		// Servers that stream reasoning as summary text return reasoning items
		// without `reasoning_text`. A warm session replays them natively, so the
		// targets that require `reasoning_text` on every turn (DeepSeek family)
		// need it filled in, as the cold rebuild already does.
		function summaryOnlyReasoningContext(model: Model<"openai-responses">): Context {
			const turn = {
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: issue5002ZeroUsage,
			} as const;
			return {
				messages: [
					{ role: "user", content: "Read a.txt.", timestamp: Date.now() },
					{
						...turn,
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Open a.txt." },
							{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a.txt" } },
						],
						stopReason: "toolUse",
						providerPayload: createOpenAIResponsesHistoryPayload(model.provider, [
							{ type: "reasoning", id: "rs_a", summary: [{ type: "summary_text", text: "Open a.txt." }] },
							{ type: "function_call", call_id: "call_a", name: "read", arguments: '{"path":"a.txt"}' },
						]),
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "call_a",
						toolName: "read",
						content: [{ type: "text", text: "A" }],
						isError: false,
						timestamp: Date.now(),
					},
					{
						// No native payload: the warm path replays the thinking signature.
						...turn,
						role: "assistant",
						content: [
							{
								type: "thinking",
								thinking: "It says A.",
								thinkingSignature: JSON.stringify({
									type: "reasoning",
									id: "rs_b",
									summary: [{ type: "summary_text", text: "It says A." }],
								}),
							},
							{ type: "text", text: "A." },
						],
						stopReason: "stop",
						timestamp: Date.now(),
					},
					{ role: "user", content: "Thanks.", timestamp: Date.now() },
				],
			};
		}

		it("carries the cold rebuild's reasoning_text for targets that require it", async () => {
			const model = getOpenAIReasoningModel("commandcode", "deepseek/deepseek-v4.1-flash");
			const context = summaryOnlyReasoningContext(model);
			const options = { reasoning: Effort.Medium };
			const cold = (await captureResponsesPayload(asConnectionBound(model), context, new Map(), options)) as {
				input?: unknown[];
			};
			const warm = (await captureResponsesPayload(model, context, undefined, options)) as { input?: unknown[] };

			expect(replayedReasoningTexts(cold.input)).toEqual(["Open a.txt.", "It says A."]);
			expect(replayedReasoningTexts(warm.input)).toEqual(["Open a.txt.", "It says A."]);
		});

		it("replays summary-only items verbatim for targets that do not require reasoning_text", async () => {
			const context = summaryOnlyReasoningContext(plaintextReasoningModel);
			const warm = (await captureResponsesPayload(plaintextReasoningModel, context, undefined, {
				reasoning: Effort.Medium,
			})) as { input?: unknown[] };

			expect(replayedReasoningTexts(warm.input)).toEqual([]);
		});

		it("replays encrypted summary items verbatim on OpenRouter tool-call turns", async () => {
			// OpenRouter requires reasoning on tool-call turns for every reasoning
			// model; an OpenAI-family item's opaque `encrypted_content` is its
			// reasoning, so the summary must not be injected as `reasoning_text`.
			const model = getOpenAIReasoningModel("openrouter", "openai/gpt-5");
			const reasoningItem = {
				type: "reasoning",
				encrypted_content: "enc_blob",
				summary: [{ type: "summary_text", text: "Open a.txt." }],
			};
			const context: Context = {
				messages: [
					{ role: "user", content: "Read a.txt.", timestamp: Date.now() },
					{
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: issue5002ZeroUsage,
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Open a.txt." },
							{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a.txt" } },
						],
						stopReason: "toolUse",
						providerPayload: createOpenAIResponsesHistoryPayload(model.provider, [
							reasoningItem,
							{ type: "function_call", call_id: "call_a", name: "read", arguments: '{"path":"a.txt"}' },
						]),
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "call_a",
						toolName: "read",
						content: [{ type: "text", text: "A" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			};
			const warm = (await captureResponsesPayload(model, context, undefined, { reasoning: Effort.Medium })) as {
				input?: Array<{ type?: string }>;
			};

			expect(warm.input?.filter(item => item.type === "reasoning")).toEqual([reasoningItem]);
		});
	});

	it("ignores incompatible native history snapshots across providers", async () => {
		const model = getBundledModel("github-copilot", "gpt-5.4") as Model<"openai-responses">;
		const payload = (await captureResponsesPayload(model, codexToCopilotContext)) as { input?: unknown[] };
		expect(containsEncryptedReasoning(payload.input)).toBe(false);
		expect(containsAssistantOutputText(payload.input, "generic assistant that should be rebuilt")).toBe(true);
	});

	it("does not replay GitHub Copilot hidden-empty assistant native or fallback history into the next request", async () => {
		const hiddenEmptyNativeItems = [
			{ type: "reasoning", encrypted_content: "enc_hidden_empty" },
			{
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "", annotations: [] }],
			},
		];
		const followUp = "continue after hidden empty assistant turn";
		const context: Context = {
			messages: [
				{
					...makeAssistantMessage(hiddenEmptyNativeItems, false, "github-copilot", "gpt-5.4"),
					content: [
						{ type: "text", text: "" },
						{
							type: "thinking",
							thinking: "",
							thinkingSignature: JSON.stringify({
								type: "reasoning",
								id: "rs_hidden_empty_fallback",
								encrypted_content: "enc_hidden_empty_fallback",
							}),
						},
					],
				},
				{ role: "user", content: followUp, timestamp: Date.now() },
			],
		};
		const model = getBundledModel("github-copilot", "gpt-5.4") as Model<"openai-responses">;
		const payload = (await captureResponsesPayload(model, context)) as { input?: unknown[] };

		expect(containsUserInputText(payload.input, followUp)).toBe(true);
		expect(findResponsesInputItem(payload.input, "reasoning")).toBeUndefined();
		expect(containsAssistantOutputText(payload.input, "")).toBe(false);
	});

	it("does not replay GitHub Copilot hidden-empty assistant fallback on cold provider session state", async () => {
		const hiddenEmptyNativeItems = [
			{ type: "reasoning", encrypted_content: "enc_hidden_empty_cold" },
			{
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "", annotations: [] }],
			},
		];
		const followUp = "continue after hidden empty assistant turn (cold)";
		const context: Context = {
			messages: [
				{
					...makeAssistantMessage(hiddenEmptyNativeItems, false, "github-copilot", "gpt-5.4"),
					content: [
						{ type: "text", text: "" },
						{
							type: "thinking",
							thinking: "",
							thinkingSignature: JSON.stringify({
								type: "reasoning",
								id: "rs_hidden_empty_cold_fallback",
								encrypted_content: "enc_hidden_empty_cold_fallback",
							}),
						},
					],
				},
				{ role: "user", content: followUp, timestamp: Date.now() },
			],
		};
		const model = getBundledModel("github-copilot", "gpt-5.4") as Model<"openai-responses">;
		const providerSessionState = new Map<string, ProviderSessionState>();
		const payload = (await captureResponsesPayload(model, context, providerSessionState)) as {
			input?: unknown[];
		};

		expect(containsUserInputText(payload.input, followUp)).toBe(true);
		expect(findResponsesInputItem(payload.input, "reasoning")).toBeUndefined();
		expect(containsAssistantOutputText(payload.input, "")).toBe(false);
	});

	it("preserves native-only assistant response items without visible assistant text", async () => {
		const followUp = "continue after native-only assistant turn";
		const context: Context = {
			messages: [
				makeAssistantMessage(
					[
						{
							type: "web_search_call",
							id: "ws_native_only",
							status: "completed",
						},
					],
					false,
					"github-copilot",
					"gpt-5.4",
				),
				{ role: "user", content: followUp, timestamp: Date.now() },
			],
		};
		const model = getBundledModel("github-copilot", "gpt-5.4") as Model<"openai-responses">;
		const payload = await captureResponsesPayload(model, context);
		const input =
			payload && typeof payload === "object" && "input" in payload && Array.isArray(payload.input)
				? payload.input
				: undefined;
		const webSearchItem = findResponsesInputItem(input, "web_search_call");

		expect(webSearchItem).toMatchObject({ type: "web_search_call", status: "completed" });
		expect(webSearchItem?.id).toBeUndefined();
		expect(containsAssistantOutputText(input, "ignored")).toBe(false);
		expect(containsUserInputText(input, followUp)).toBe(true);
	});

	it("builds up history incrementally from multiple assistant messages", async () => {
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const payload = (await captureResponsesPayload(model, incrementalContext)) as { input?: unknown[] };
		expect(payload.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "first question" }] },
			...incrementalItems1.map(({ id: _id, status: _status, ...item }) => item),
			{ role: "user", content: [{ type: "input_text", text: "second question" }] },
			...incrementalItems2.map(({ id: _id, status: _status, ...item }) => item),
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
				phase: "commentary",
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});

	it("omits legacy plain-string text signature IDs when rebuilding fallback replay history without reasoning", async () => {
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
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});

	it("omits long non-msg legacy signature IDs when rebuilding fallback replay history without reasoning", async () => {
		const legacySignature = `item_${"copilot/legacy+opaque=".repeat(8)}`;
		const context: Context = {
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "Legacy answer", textSignature: legacySignature }],
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
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});

	it("keeps hashed long legacy signature IDs when the replayed turn carries its reasoning item", async () => {
		const legacySignature = `item_${"copilot/legacy+opaque=".repeat(8)}`;
		const context: Context = {
			messages: [
				{ role: "user", content: "first user", timestamp: Date.now() },
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "",
							thinkingSignature: JSON.stringify({
								type: "reasoning",
								id: "rs_keep",
								encrypted_content: "enc_keep",
							}),
						},
						{ type: "text", text: "Signed answer", textSignature: legacySignature },
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
			{ type: "reasoning", id: "rs_keep", encrypted_content: "enc_keep" },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Signed answer", annotations: [] }],
				status: "completed",
				id: `msg_${Bun.hash(legacySignature).toString(36)}`,
			},
			{ role: "user", content: [{ type: "input_text", text: "follow-up" }] },
		]);
	});

	it.each([
		{ callSuffix: "|fc_call", resultSuffix: "" },
		{ callSuffix: "", resultSuffix: "|fc_result" },
	])("preserves real output for mixed Responses ids ($callSuffix, $resultSuffix)", ({ callSuffix, resultSuffix }) => {
		const callId = `googleai-ts1:${"opaque/signature+token=".repeat(12)}`;
		const context: Context = {
			messages: [
				{ role: "user", content: "weather?", timestamp: 0 },
				{
					...makeAssistantMessage([]),
					content: [
						{
							type: "toolCall",
							id: `${callId}${callSuffix}`,
							name: "get_weather",
							arguments: { city: "Paris" },
						},
					],
					providerPayload: undefined,
					stopReason: "toolUse",
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: `${callId}${resultSuffix}`,
					toolName: "get_weather",
					content: [{ type: "text", text: "15C" }],
					isError: false,
					timestamp: 0,
				},
			],
		};
		const input = buildResponsesInput({
			model: getOpenAIReasoningModel("openai", "gpt-5-mini"),
			context,
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
		});

		expect(findResponsesInputItem(input, "function_call")?.call_id).toBe(callId);
		expect(input.filter(item => item.type === "function_call_output")).toEqual([
			{ type: "function_call_output", call_id: callId, output: "15C" },
		]);
	});

	it("strips output-only replay metadata while echoing opaque call_id values verbatim", async () => {
		const opaqueReasoningId = `item_${"copilot/reasoning+token=".repeat(8)}`;
		const opaqueMessageId = `item_${"copilot/message+opaque=".repeat(8)}`;
		const opaqueCallId = `googleai-ts1:${"function-signature.".repeat(12)}`;
		const opaqueFunctionItemId = `item_${"copilot/function-item+opaque/=".repeat(8)}`;
		const opaqueCustomCallId = `googleai-ts1:${"custom-signature.".repeat(12)}`;
		const opaqueCustomItemId = `item_${"copilot/custom-item+opaque/=".repeat(8)}`;
		const replayHistoryItems: Array<Record<string, unknown>> = [
			{ type: "reasoning", id: opaqueReasoningId, encrypted_content: "enc_opaque", status: "completed" },
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
			{
				type: "custom_tool_call",
				id: opaqueCustomItemId,
				call_id: opaqueCustomCallId,
				name: "apply_patch",
				input: "*** Begin Patch\n*** End Patch\n",
				status: "completed",
			},
			{
				type: "custom_tool_call_output",
				call_id: opaqueCustomCallId,
				output: "patch applied",
			},
			{
				type: "compaction",
				encrypted_content: "encrypted-compaction",
				status: "completed",
			},
			{
				type: "compaction_summary",
				summary: "compacted context",
				status: "completed",
			},
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
		const customToolCallItem = findResponsesInputItem(payload.input, "custom_tool_call");
		const itemReference = findResponsesInputItem(payload.input, "item_reference");
		const compactionItem = findResponsesInputItem(payload.input, "compaction");
		const compactionSummaryItem = findResponsesInputItem(payload.input, "compaction_summary");

		expect(reasoningItem).toBeDefined();
		expect(messageItem).toBeDefined();
		expect(functionCallItem).toBeDefined();
		expect(functionCallOutputItem).toBeDefined();
		expect(customToolCallItem).toBeDefined();
		expect(reasoningItem?.id).toBeUndefined();
		expect(messageItem?.id).toBeUndefined();
		expect(functionCallItem?.id).toBeUndefined();
		expect(functionCallOutputItem?.id).toBeUndefined();
		expect(itemReference).toBeUndefined();
		expect(reasoningItem).not.toHaveProperty("status");
		expect(messageItem).not.toHaveProperty("status");
		expect(functionCallItem).not.toHaveProperty("status");
		expect(customToolCallItem).not.toHaveProperty("status");
		expect(compactionItem).not.toHaveProperty("status");
		expect(compactionSummaryItem).not.toHaveProperty("status");
		expect(
			(payload.input ?? []).some(
				item => item && typeof item === "object" && "id" in (item as Record<string, unknown>),
			),
		).toBe(false);
		expect(reasoningItem?.encrypted_content).toBe("enc_opaque");
		expect(compactionItem?.encrypted_content).toBe("encrypted-compaction");
		expect(compactionSummaryItem?.summary).toBe("compacted context");
		expect(functionCallItem).toBeDefined();
		expect(functionCallItem!.call_id).toBe(opaqueCallId);
		expect(functionCallOutputItem?.call_id).toBe(opaqueCallId);
		expect(customToolCallItem?.call_id).toBe(opaqueCustomCallId);
		expect(containsAssistantOutputText(payload.input, "Sanitized assistant answer")).toBe(true);
		expect(replayHistoryItems[0]?.id).toBe(opaqueReasoningId);
		expect(replayHistoryItems[1]?.id).toBe(opaqueMessageId);
		expect(replayHistoryItems[2]?.id).toBe(opaqueFunctionItemId);
		expect(replayHistoryItems[2]?.call_id).toBe(opaqueCallId);
		expect(replayHistoryItems[1]?.status).toBe("completed");
		expect(replayHistoryItems[2]?.status).toBe("completed");
		expect(replayHistoryItems[3]?.id).toBe("fco_should_be_removed");
		expect(replayHistoryItems[3]?.call_id).toBe(opaqueCallId);
		expect(replayHistoryItems[4]?.status).toBe("completed");
		expect(replayHistoryItems[6]?.status).toBe("completed");
		expect(replayHistoryItems[7]?.status).toBe("completed");
		expect(replayHistoryItems[8]?.id).toBe(opaqueMessageId);
	});

	it("preserves the reasoning ID linked to a native computer call in the next request", async () => {
		const nativeComputerHistory = [
			{
				type: "reasoning",
				id: "rs_interrupted_computer_turn",
				summary: [],
				encrypted_content: "encrypted-computer-reasoning",
				status: "completed",
			},
			{
				type: "computer_call",
				id: "cu_interrupted_computer_turn",
				call_id: "call_interrupted_computer_turn",
				action: { type: "screenshot" },
				pending_safety_checks: [],
				status: "completed",
			},
			{
				type: "computer_call_output",
				call_id: "call_interrupted_computer_turn",
				output: { type: "computer_screenshot", image_url: "data:image/png;base64,AAEC" },
			},
		];
		const context: Context = {
			messages: [
				makeAssistantMessage(nativeComputerHistory, false, "openai", "gpt-5.4"),
				{ role: "user", content: "continue after interrupt", timestamp: Date.now() },
			],
		};

		const model = getOpenAIReasoningModel("openai", "gpt-5.4");
		const payload = (await captureResponsesPayload(model, context)) as { input?: unknown[] };

		expect(payload.input).toEqual([
			{
				type: "reasoning",
				id: "rs_interrupted_computer_turn",
				summary: [],
				encrypted_content: "encrypted-computer-reasoning",
			},
			{
				type: "computer_call",
				id: "cu_interrupted_computer_turn",
				call_id: "call_interrupted_computer_turn",
				action: { type: "screenshot" },
				pending_safety_checks: [],
				status: "completed",
			},
			{
				type: "computer_call_output",
				call_id: "call_interrupted_computer_turn",
				output: { type: "computer_screenshot", image_url: "data:image/png;base64,AAEC" },
			},
			{ role: "user", content: [{ type: "input_text", text: "continue after interrupt" }] },
		]);
	});

	it("preserves linked reasoning when the screenshot is a later tool result", async () => {
		const context: Context = {
			messages: [
				{
					...makeAssistantMessage(
						[
							{
								type: "reasoning",
								id: "rs_split_computer_turn",
								summary: [],
								encrypted_content: "encrypted-split-computer-reasoning",
								status: "completed",
							},
							{
								type: "computer_call",
								id: "cu_split_computer_turn",
								call_id: "call_split_computer_turn",
								action: { type: "screenshot" },
								pending_safety_checks: [],
								status: "completed",
							},
						],
						true,
						"openai",
						"gpt-5.4",
					),
					content: [
						{
							type: "toolCall" as const,
							id: "call_split_computer_turn|cu_split_computer_turn",
							name: "computer",
							arguments: { actions: [{ type: "screenshot" }] },
							providerMetadata: {
								type: "computer" as const,
								providerItemId: "cu_split_computer_turn",
								actions: [{ type: "screenshot" as const }],
								pendingSafetyChecks: [],
							},
						},
					],
				},
				{
					role: "toolResult",
					toolCallId: "call_split_computer_turn|cu_split_computer_turn",
					toolName: "computer",
					content: [{ type: "image", data: "AAEC", mimeType: "image/png" }],
					isError: false,
					timestamp: Date.now(),
					providerMetadata: {
						type: "computer",
						screenshot: { type: "computer_screenshot", image_url: "data:image/png;base64,AAEC" },
						acknowledgedSafetyChecks: [],
					},
				},
				{ role: "user", content: "continue after split persistence", timestamp: Date.now() },
			],
		};

		const model = getOpenAIReasoningModel("openai", "gpt-5.4");
		const payload = (await captureResponsesPayload(model, context)) as { input?: unknown[] };

		expect(findResponsesInputItem(payload.input, "reasoning")?.id).toBe("rs_split_computer_turn");
		expect(findResponsesInputItem(payload.input, "computer_call")).toMatchObject({
			id: "cu_split_computer_turn",
			call_id: "call_split_computer_turn",
		});
		expect(findResponsesInputItem(payload.input, "computer_call_output")).toMatchObject({
			call_id: "call_split_computer_turn",
		});
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

	it("keeps an invocation-text tool name from another API out of the Responses request", async () => {
		// Shape of a GLM-5.3 (openai-completions) turn whose gateway returned the
		// whole tool invocation as the name; OpenAI rejected the replay with
		// `Invalid 'input[401].name': string too long ... length 9654`.
		const invocationName = "eval>\n<code>\n".padEnd(9654, "print('step')\n");
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Run the script", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Running the script." },
						{ type: "toolCall", id: "chatcmpl-tool-invocation", name: invocationName, arguments: {} },
						{ type: "toolCall", id: "chatcmpl-tool-read", name: "read", arguments: { path: "README.md" } },
					],
					api: "openai-completions",
					provider: "zai",
					model: "glm-5.3",
					usage,
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "chatcmpl-tool-invocation",
					toolName: invocationName,
					content: [{ type: "text", text: "Tool not found" }],
					isError: true,
					timestamp: 3,
				},
				{
					role: "toolResult",
					toolCallId: "chatcmpl-tool-read",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 4,
				},
				{ role: "user", content: "continue", timestamp: 5 },
			],
		};
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const payload = (await captureResponsesPayload(model, context)) as { input?: unknown[] };
		expect(listResponsesToolItems(payload.input)).toEqual([
			["function_call", "chatcmpl-tool-read", "read"],
			["function_call_output", "chatcmpl-tool-read", undefined],
		]);
		expect(containsAssistantOutputText(payload.input, "Running the script.")).toBe(true);
	});

	it("drops malformed tool names from same-model native history replay", async () => {
		const malformedName = 'bash\0arg_key="command"\0arg_value="ls -la"';
		const assistantMessage = {
			...makeAssistantMessage(
				[
					{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc_tools" },
					{ type: "function_call", id: "fc_bad", call_id: "call_bad", name: malformedName, arguments: "{}" },
					{
						type: "function_call",
						id: "fc_read",
						call_id: "call_read",
						name: "read",
						arguments: '{"path":"README.md"}',
					},
				],
				true,
			),
			content: [
				{ type: "toolCall" as const, id: "call_bad|fc_bad", name: malformedName, arguments: {} },
				{ type: "toolCall" as const, id: "call_read|fc_read", name: "read", arguments: { path: "README.md" } },
			],
			stopReason: "toolUse" as const,
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "List the repo", timestamp: Date.now() },
				assistantMessage,
				{
					role: "toolResult",
					toolCallId: "call_bad|fc_bad",
					toolName: malformedName,
					content: [{ type: "text", text: "Tool not found" }],
					isError: true,
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "call_read|fc_read",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: Date.now(),
				},
				{ role: "user", content: "continue", timestamp: Date.now() },
			],
		};
		const model = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const providerSessionState = new Map<string, ProviderSessionState>();
		await captureResponsesPayload(model, context, providerSessionState);
		markResponsesProviderSessionStateWarmed(providerSessionState);
		const payload = (await captureResponsesPayload(model, context, providerSessionState)) as { input?: unknown[] };
		expect(containsEncryptedReasoning(payload.input)).toBe(true);
		expect(listResponsesToolItems(payload.input)).toEqual([
			["function_call", "call_read", "read"],
			["function_call_output", "call_read", undefined],
		]);
	});

	it("drops a same-model snapshot's paired malformed output and still notes a genuine orphan", () => {
		const malformedName = "bad invocation text";
		const assistantMessage = {
			...makeAssistantMessage(
				[
					{ type: "reasoning", id: "rs_keep", summary: [], encrypted_content: "enc_keep" },
					{ type: "function_call", call_id: "call_shared", name: malformedName, arguments: "{}" },
					{ type: "function_call_output", call_id: "call_shared", output: "Tool not found" },
					{
						type: "function_call",
						call_id: "call_shared",
						name: "read",
						arguments: '{"path":"README.md"}',
					},
					{ type: "function_call_output", call_id: "call_shared", output: "file contents" },
					{ type: "function_call_output", call_id: "call_genuine_orphan", output: "unrelated orphan" },
				],
				true,
			),
			stopReason: "toolUse" as const,
		};
		const input = buildResponsesInput({
			model: getOpenAIReasoningModel("openai", "gpt-5-mini"),
			context: {
				messages: [
					{ role: "user", content: "List the repo", timestamp: 1 },
					assistantMessage,
					{ role: "user", content: "continue", timestamp: 2 },
				],
			},
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		const wire = JSON.stringify(input);
		expect(wire).not.toContain(malformedName);
		expect(wire).not.toContain("Tool not found");
		expect(wire).not.toContain("[Orphan tool result; call_id=call_shared]");
		expect(wire).toContain("[Orphan tool result; call_id=call_genuine_orphan]: unrelated orphan");
		expect(containsEncryptedReasoning(input)).toBe(true);
		expect(listResponsesToolItems(input)).toEqual([
			["function_call", "call_shared", "read"],
			["function_call_output", "call_shared", undefined],
		]);
		expect(findResponsesInputItemByCallId(input, "function_call_output", "call_shared")?.output).toBe(
			"file contents",
		);
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

	it("honors strict pairing overrides against opposite catalog defaults", async () => {
		const orphanCallId = "call_override_orphan";
		const orphanOutput = "orphan result";
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: orphanCallId, name: "read", arguments: { path: "README.md" } }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5-mini",
					usage: issue5002ZeroUsage,
					stopReason: "toolUse",
					providerPayload: createOpenAIResponsesHistoryPayload(
						"openai",
						[{ type: "message", role: "assistant", content: [{ type: "output_text", text: "snapshot" }] }],
						false,
					),
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: orphanCallId,
					toolName: "read",
					content: [{ type: "text", text: orphanOutput }],
					isError: false,
					timestamp: Date.now(),
				},
				{ role: "user", content: "Continue", timestamp: Date.now() },
			],
		};
		const catalogNonStrictModel = getOpenAIReasoningModel("openai", "gpt-5-mini");
		const catalogStrictModel: Model<"openai-responses"> = {
			...catalogNonStrictModel,
			compat: { ...catalogNonStrictModel.compat, strictResponsesPairing: true },
		};
		const strictOverridePayload = (await captureResponsesPayload(catalogNonStrictModel, context, undefined, {
			strictResponsesPairing: true,
		})) as { input?: unknown[] };
		const nonStrictOverridePayload = (await captureResponsesPayload(catalogStrictModel, context, undefined, {
			strictResponsesPairing: false,
		})) as { input?: unknown[] };
		const orphanNote = (input: unknown[] | undefined): { content?: string } | undefined =>
			input?.find(item => {
				if (!item || typeof item !== "object") return false;
				const candidate = item as { type?: unknown; role?: unknown; content?: unknown };
				return (
					candidate.type === "message" &&
					candidate.role === "assistant" &&
					typeof candidate.content === "string" &&
					candidate.content.includes(orphanCallId) &&
					candidate.content.includes(orphanOutput)
				);
			}) as { content?: string } | undefined;

		expect(orphanNote(strictOverridePayload.input)?.content).toContain("[Orphan read result;");
		expect(orphanNote(nonStrictOverridePayload.input)?.content).toContain("[Orphan tool result;");
	});
});
