import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	convertCodexResponsesMessages,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { buildResponsesInput } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, Model, ModelSpec, ProviderSessionState, Tool } from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
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

function createCodexToken(accountId: string): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `${header}.${payload}.signature`;
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

const codexAssistantSnapshotContext: Context = {
	messages: [
		{ role: "user", content: "generic history that should be replaced", timestamp: Date.now() },
		makeAssistantMessage(snapshotHistoryItems, false, "openai-codex", "gpt-5.5"),
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

		const codexModel = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.5");
		const codexItems = convertCodexResponsesMessages(codexModel, makeContext("openai-codex"));
		assertWireOrder(codexItems);
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

	it("preserves encrypted_function_args on replayed Codex function calls", () => {
		// codex-rs #35845: an empty `encrypted_function_args` array marks plaintext
		// collaboration arguments; the marker must survive replay verbatim or the
		// backend would treat the replayed arguments as encrypted.
		const codexModel = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.5");
		const nativeItems = [
			{
				type: "function_call",
				id: "fc_plaintext_1",
				call_id: "call_plaintext_collab",
				name: "send_message",
				namespace: "collaboration",
				arguments: JSON.stringify({ message: "hello", task_name: "worker" }),
				encrypted_function_args: [],
				status: "completed",
			},
			{
				type: "function_call_output",
				call_id: "call_plaintext_collab",
				output: "delivered",
			},
		];
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "fallback should not be replayed" }],
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: codexModel.id,
					usage: issue5002ZeroUsage,
					stopReason: "stop",
					providerPayload: createOpenAIResponsesHistoryPayload("openai-codex", nativeItems),
					timestamp: Date.now(),
				},
				{ role: "user", content: "continue", timestamp: Date.now() },
			],
		};

		const input = convertCodexResponsesMessages(codexModel, context);
		expect(findResponsesInputItemByCallId(input, "function_call", "call_plaintext_collab")).toEqual({
			type: "function_call",
			call_id: "call_plaintext_collab",
			name: "send_message",
			namespace: "collaboration",
			arguments: JSON.stringify({ message: "hello", task_name: "worker" }),
			encrypted_function_args: [],
		});
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

	it("normalizes result-bearing native images for full Codex replay", () => {
		const model = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.5");
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
						},
						{
							id: "ig_stale_result",
							type: "image_generation_call",
							status: "generating",
							result: "stale-result-image",
						},
						{
							id: "ig_completed",
							type: "image_generation_call",
							status: "completed",
							result: "completed-image",
						},
					],
					false,
					"openai-codex",
					model.id,
				),
				{ role: "user", content: "follow-up user", timestamp: Date.now() },
			],
		};
		const imageGenerationItems = convertCodexResponsesMessages(model, context).filter(
			item => item.type === "image_generation_call",
		);

		expect(imageGenerationItems).toEqual([
			{
				id: "ig_stale_result",
				type: "image_generation_call",
				status: "completed",
				result: "stale-result-image",
			},
			{
				id: "ig_completed",
				type: "image_generation_call",
				status: "completed",
				result: "completed-image",
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
		const model = getBundledModel("openai-codex", "gpt-5.5") as Model<"openai-codex-responses">;
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
					model: "gpt-5.5",
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
		const model = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.5");
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
