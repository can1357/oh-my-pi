import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	NativeCompactionError,
	prepareCompaction,
	type SessionEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import {
	buildCompactionV2Request,
	buildOpenAiNativeHistory,
	CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
	getCompactionV2PreserveData,
	requestCompactionV2Streaming,
	requestOpenAiRemoteCompaction,
	requestRemoteCompaction,
	shouldUseCompactionV2Streaming,
	shouldUseOpenAiRemoteCompaction,
	trimRemoteCompactionInputToContextWindow,
} from "@oh-my-pi/pi-agent-core/compaction/openai";
import * as ai from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getOpenAICodexTransportDetails } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type {
	AssistantMessage,
	CodexCompactionContext,
	FetchImpl,
	Model,
	ProviderSessionState,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import * as piUtils from "@oh-my-pi/pi-utils";

const { isRecord } = piUtils;
const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";
const TEST_CODEX_COMPACTION: CodexCompactionContext = {
	operationId: "compaction-operation-1",
	trigger: "auto",
	reason: "context_limit",
	phase: "pre_turn",
	strategy: "memento",
};
const CODEX_RESIDENCY_TOKEN = `header.${Buffer.from(
	JSON.stringify({
		"https://api.openai.com/auth": {
			chatgpt_account_id: "acct-test",
			chatgpt_data_residency: "us",
		},
	}),
).toString("base64url")}.signature`;

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeOpenAiModel(overrides: Partial<ModelSpec<"openai-responses">> = {}): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	});
}

function makeAzureModel(overrides: Partial<ModelSpec<"azure-openai-responses">> = {}): Model<"azure-openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5 Azure",
		api: "azure-openai-responses",
		provider: "azure-openai",
		baseUrl: "https://example-resource.openai.azure.com/openai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	});
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

interface CodexCompactionTestSocket {
	readyState: number;
	readonly sent: Array<Record<string, unknown>>;
	emit(event: Record<string, unknown>): void;
	fail(): void;
}

function installCodexCompactionWebSocket(options?: {
	respond?: (socket: CodexCompactionTestSocket, request: Record<string, unknown>) => void;
}): {
	sockets: CodexCompactionTestSocket[];
	restore(): void;
} {
	const originalWebSocket = globalThis.WebSocket;
	const sockets: CodexCompactionTestSocket[] = [];

	class CodexCompactionWebSocket implements CodexCompactionTestSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;

		readyState = CodexCompactionWebSocket.CONNECTING;
		binaryType: "blob" | "arraybuffer" | "nodebuffer" = "blob";
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		onclose: ((event: Event) => void) | null = null;
		readonly sent: Array<Record<string, unknown>> = [];
		readonly handshakeHeaders = { "x-codex-turn-state": `compaction-state-${sockets.length}` };

		constructor(
			readonly url: string,
			readonly socketOptions?: { headers?: Record<string, string> },
		) {
			sockets.push(this);
			queueMicrotask(() => {
				this.readyState = CodexCompactionWebSocket.OPEN;
				this.onopen?.(new Event("open"));
			});
		}

		send(data: string): void {
			const parsed: unknown = JSON.parse(data);
			if (!isRecord(parsed)) throw new Error("Expected Codex WebSocket request object");
			this.sent.push(parsed);
			options?.respond?.(this, parsed);
		}

		emit(event: Record<string, unknown>): void {
			this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
		}

		fail(): void {
			this.readyState = CodexCompactionWebSocket.CLOSED;
			this.onerror?.(new Event("error"));
			this.onclose?.(new Event("close"));
		}

		close(): void {
			this.readyState = CodexCompactionWebSocket.CLOSED;
		}
	}

	Object.defineProperty(globalThis, "WebSocket", {
		configurable: true,
		writable: true,
		value: CodexCompactionWebSocket,
	});
	return {
		sockets,
		restore: () => {
			Object.defineProperty(globalThis, "WebSocket", {
				configurable: true,
				writable: true,
				value: originalWebSocket,
			});
		},
	};
}

describe("buildOpenAiNativeHistory custom tool calls", () => {
	test("serializes customWireName tool calls as custom_tool_call + custom_tool_call_output", () => {
		const patch = "*** Begin Patch\n*** End Patch\n";
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_apply_1|ctc_apply_1",
					name: "edit",
					arguments: { input: patch },
					customWireName: "apply_patch",
				},
			],
			timestamp: Date.now(),
			provider: "openai",
			model: "gpt-5",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_apply_1|ctc_apply_1",
			toolName: "edit",
			content: [{ type: "text", text: "patch applied" }],
			isError: false,
			timestamp: Date.now(),
		};

		const items = buildOpenAiNativeHistory([assistant, toolResult], makeOpenAiModel());

		const call = items.find(item => item.type === "custom_tool_call");
		expect(call).toBeDefined();
		expect(call?.name).toBe("apply_patch");
		expect(call?.input).toBe(patch);
		expect(call?.call_id).toBe("call_apply_1");

		const output = items.find(item => item.type === "custom_tool_call_output");
		expect(output).toBeDefined();
		expect(output?.call_id).toBe("call_apply_1");
		expect(output?.output).toBe("patch applied");

		// Did NOT emit the legacy function_call / function_call_output pair.
		expect(items.find(item => item.type === "function_call")).toBeUndefined();
		expect(items.find(item => item.type === "function_call_output")).toBeUndefined();
	});

	test("continues to emit function_call for regular JSON tools", () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_read_1|fc_read_1",
					name: "read_file",
					arguments: { path: "/tmp/x" },
				},
			],
			timestamp: Date.now(),
			provider: "openai",
			model: "gpt-5",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		};
		const items = buildOpenAiNativeHistory([assistant], makeOpenAiModel());
		expect(items.find(item => item.type === "function_call")).toBeDefined();
		expect(items.find(item => item.type === "custom_tool_call")).toBeUndefined();
	});

	test("preserves bigint tool arguments as exact decimal strings", () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_lookup_1|fc_lookup_1",
					name: "lookup",
					arguments: { rowId: 9_007_199_254_740_993n },
				},
			],
			timestamp: Date.now(),
			provider: "openai",
			model: "gpt-5",
			api: "openai-responses",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		};

		const items = buildOpenAiNativeHistory([assistant], makeOpenAiModel());
		const call = items.find(item => item.type === "function_call");

		expect(call?.arguments).toBe('{"rowId":"9007199254740993"}');
	});
});

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Codex carries native responses-API items on `providerPayload`. The history
// builder reads call ids from there (not the message content blocks), so each
// turn pairs a content `toolCall` (kept by `transformMessages` so the matching
// result survives) with a `providerPayload` function/custom call of the same id.
// `dt: true` appends to the running history; `dt: false` is a full snapshot that
// replaces it.
const CODEX_MODEL = makeOpenAiModel({ provider: "openai-codex" });

function codexAssistant(calls: Array<{ callId: string; custom?: boolean }>, dt: boolean): AssistantMessage {
	const content = calls.map(c => ({
		type: "toolCall" as const,
		id: `${c.callId}|${c.custom ? "ctc" : "fc"}_${c.callId}`,
		name: c.custom ? "edit" : "read",
		arguments: c.custom ? { input: "p" } : {},
		...(c.custom ? { customWireName: "apply_patch" } : {}),
	}));
	const items = calls.map(c =>
		c.custom
			? {
					type: "custom_tool_call",
					id: `ctc_${c.callId}`,
					call_id: c.callId,
					name: "apply_patch",
					input: "p",
					status: "completed",
				}
			: {
					type: "function_call",
					id: `fc_${c.callId}`,
					call_id: c.callId,
					name: "read",
					arguments: "{}",
					status: "completed",
				},
	);
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "openai-codex",
		model: "gpt-5",
		api: "openai-responses",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		providerPayload: { type: "openaiResponsesHistory", provider: "openai-codex", ...(dt ? { dt: true } : {}), items },
	} as unknown as AssistantMessage;
}

function toolResultFor(callId: string, custom = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `${callId}|${custom ? "ctc" : "fc"}_${callId}`,
		toolName: custom ? "edit" : "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("buildOpenAiNativeHistory multimodal tool results", () => {
	test("encodes ReadTool images inside the native function output", () => {
		const imageData = Buffer.from("read image").toString("base64");
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_image|fc_call_image",
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: imageData, mimeType: "image/png", detail: "original" },
			],
			isError: false,
			timestamp: Date.now(),
		};
		const model = makeOpenAiModel({ provider: "openai-codex", input: ["text", "image"] });

		const items = buildOpenAiNativeHistory(
			[codexAssistant([{ callId: "call_image" }], true), result],
			model,
			undefined,
			true,
		);

		const output = items.find(item => item.type === "function_call_output");
		expect(output?.output).toEqual([
			{ type: "input_text", text: "Read image file [image/png]" },
			{
				type: "input_image",
				detail: "original",
				image_url: `data:image/png;base64,${imageData}`,
			},
		]);
		expect(items.some(item => item.type === "message" && item.role === "user")).toBe(false);
	});
});

describe("buildOpenAiNativeHistory interleaved assistant message (#8789)", () => {
	test("hoists a trailing text block before its tool-call batch", () => {
		// deepseek-v4-flash on opencode-go streamed [thinking, 2 tool calls,
		// trailing "</thinking" text]; the compaction history builder must not
		// wedge the demoted text between the calls and their outputs.
		const model = makeOpenAiModel({
			id: "deepseek-v4-flash",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "planning" },
				{ type: "toolCall", id: "call_a|fc_call_a", name: "read", arguments: { path: "a" } },
				{ type: "toolCall", id: "call_b|fc_call_b", name: "read", arguments: { path: "b" } },
				{ type: "text", text: "<think>\n</thinking\n</think>" },
			],
			timestamp: Date.now(),
			provider: "opencode-go",
			model: "deepseek-v4-flash",
			api: "openai-responses",
			usage: ZERO_USAGE,
			stopReason: "toolUse",
		};

		const items = buildOpenAiNativeHistory([assistant, toolResultFor("call_a"), toolResultFor("call_b")], model);

		expect(items.map(item => item.type)).toEqual([
			"message",
			"function_call",
			"function_call",
			"function_call_output",
			"function_call_output",
		]);
		expect(JSON.stringify(items[0]?.content)).toContain("</thinking");
	});
});

describe("buildOpenAiNativeHistory call-id tracking", () => {
	test("registers function_call ids carried in providerPayload so later tool results are emitted", () => {
		const items = buildOpenAiNativeHistory(
			[codexAssistant([{ callId: "call_1" }], true), toolResultFor("call_1")],
			CODEX_MODEL,
		);
		const output = items.find(item => item.type === "function_call_output");
		const call = items.find(item => item.type === "function_call");
		expect(call).toBeDefined();
		expect(call).not.toHaveProperty("status");
		expect(output?.call_id).toBe("call_1");
		expect(items.find(item => item.type === "custom_tool_call_output")).toBeUndefined();
	});

	test("registers custom_tool_call ids from providerPayload so outputs use the custom wire shape", () => {
		const items = buildOpenAiNativeHistory(
			[codexAssistant([{ callId: "call_2", custom: true }], true), toolResultFor("call_2", true)],
			CODEX_MODEL,
		);
		expect(items.find(item => item.type === "custom_tool_call_output")?.call_id).toBe("call_2");
		expect(items.find(item => item.type === "function_call_output")).toBeUndefined();
	});

	test("a full-snapshot providerPayload resets known call ids so stale outputs are dropped", () => {
		const items = buildOpenAiNativeHistory(
			[
				codexAssistant([{ callId: "call_old" }], true),
				// dt: false → splices the running history; call_old's function_call is gone.
				codexAssistant([{ callId: "call_new" }], false),
				toolResultFor("call_old"),
				toolResultFor("call_new"),
			],
			CODEX_MODEL,
		);
		expect(items.some(item => item.type === "function_call_output" && item.call_id === "call_old")).toBe(false);
		expect(items.some(item => item.type === "function_call_output" && item.call_id === "call_new")).toBe(true);
	});
});

describe("buildOpenAiNativeHistory computer calls", () => {
	const computerModel = makeOpenAiModel({ supportsComputerUse: true });
	const pendingSafetyChecks = [{ id: "safe_1", code: "confirm", message: "Confirm click" }];
	const acknowledgedSafetyChecks = [{ id: "safe_1", code: "confirm", message: "Confirm click" }];

	function computerAssistant(): AssistantMessage {
		return {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_computer_1|item_computer_1",
					name: "computer",
					arguments: { actions: [{ type: "click", button: "left", x: 12, y: 34 }] },
					providerMetadata: {
						type: "computer",
						providerItemId: "item_computer_1",
						actions: [{ type: "click", button: "left", x: 12, y: 34 }],
						pendingSafetyChecks,
					},
				},
			],
			timestamp: Date.now(),
			provider: "openai",
			model: "gpt-5",
			api: "openai-responses",
			usage: ZERO_USAGE,
			stopReason: "toolUse",
		};
	}

	test("preserves provider item id, actions, safety checks, screenshot file_id, and acknowledgements", () => {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_computer_1|item_computer_1",
			toolName: "computer",
			content: [],
			isError: false,
			timestamp: Date.now(),
			providerMetadata: {
				type: "computer",
				screenshot: { type: "computer_screenshot", file_id: "file_screen_电脑/%2F" },
				acknowledgedSafetyChecks,
			},
		};
		const items = buildOpenAiNativeHistory([computerAssistant(), result], computerModel);
		expect(items).toEqual([
			{
				type: "computer_call",
				id: "item_computer_1",
				call_id: "call_computer_1",
				actions: [{ type: "click", button: "left", x: 12, y: 34 }],
				pending_safety_checks: pendingSafetyChecks,
				status: "completed",
			},
			{
				type: "computer_call_output",
				call_id: "call_computer_1",
				output: { type: "computer_screenshot", file_id: "file_screen_电脑/%2F" },
				acknowledged_safety_checks: acknowledgedSafetyChecks,
			},
		]);
	});

	test("registers native provider-payload computer calls for exact output pairing", () => {
		const assistant = computerAssistant();
		assistant.providerPayload = {
			type: "openaiResponsesHistory",
			provider: "openai",
			dt: true,
			items: [
				{
					type: "computer_call",
					id: "item_raw_stable",
					call_id: "call_computer_1",
					actions: [{ type: "screenshot" }],
					pending_safety_checks: [],
					status: "completed",
				},
			],
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_computer_1|item_computer_1",
			toolName: "computer",
			content: [],
			isError: false,
			timestamp: Date.now(),
			providerMetadata: {
				type: "computer",
				screenshot: { type: "computer_screenshot", image_url: "data:image/png;base64,AAEC" },
				acknowledgedSafetyChecks: [],
			},
		};
		const items = buildOpenAiNativeHistory([assistant, result], computerModel);
		expect(items[0]?.id).toBe("item_raw_stable");
		expect(items[1]).toEqual({
			type: "computer_call_output",
			call_id: "call_computer_1",
			output: { type: "computer_screenshot", image_url: "data:image/png;base64,AAEC" },
			acknowledged_safety_checks: [],
		});
	});

	test("replaces a failed call without a screenshot with valid recovery history", () => {
		const failed: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_computer_1|item_computer_1",
			toolName: "computer",
			content: [{ type: "text", text: "capture failed" }],
			isError: true,
			timestamp: Date.now(),
		};
		const items = buildOpenAiNativeHistory([computerAssistant(), failed], computerModel);
		expect(items).toHaveLength(1);
		const recovery = items[0];
		expect(recovery).toMatchObject({
			type: "message",
			role: "assistant",
		});
		expect(recovery).not.toHaveProperty("status");
		expect(String(recovery?.id)).toMatch(/^msg_[a-z0-9-]+$/);
		expect(recovery?.content).toEqual([expect.objectContaining({ type: "output_text", annotations: [] })]);
		expect(JSON.stringify(items)).toContain("failed before a screenshot was recorded");
		expect(JSON.stringify(items)).toContain("capture failed");
	});

	test("downgrades unsupported native computer history to stable valid assistant message items", () => {
		const unsupportedModel = makeOpenAiModel({ supportsComputerUse: false });
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_computer_1|item_computer_1",
			toolName: "computer",
			content: [],
			isError: false,
			timestamp: Date.now(),
			providerMetadata: {
				type: "computer",
				screenshot: { type: "computer_screenshot", file_id: "file_downgraded_screen" },
				acknowledgedSafetyChecks: [{ id: "safe_downgraded" }],
			},
		};
		const first = buildOpenAiNativeHistory([computerAssistant(), result], unsupportedModel);
		const second = buildOpenAiNativeHistory([computerAssistant(), result], unsupportedModel);
		expect(first).toHaveLength(2);
		for (const note of first) {
			expect(note).toMatchObject({ type: "message", role: "assistant" });
			expect(note).not.toHaveProperty("status");
			expect(String(note.id)).toMatch(/^msg_[a-z0-9-]+$/);
			expect(note.content).toEqual([expect.objectContaining({ type: "output_text", annotations: [] })]);
		}
		expect(first.map(item => item.id)).toEqual(second.map(item => item.id));
		expect(first.every(item => String(item.id).length <= 64)).toBe(true);
		expect(JSON.stringify(first)).toContain("file_downgraded_screen");
		expect(JSON.stringify(first)).toContain("safe_downgraded");
	});
});

describe("remote compaction input forwarding", () => {
	test("rewrites an oversized trailing tool output without dropping native history", async () => {
		// The compact endpoint still receives every call/result item. Only the
		// trailing output body is replaced when the request cannot fit.
		const nativeInput = [
			{ type: "custom_tool_call", call_id: "call_apply_1", name: "apply_patch", input: "{}" },
			{ type: "custom_tool_call_output", call_id: "call_apply_1", output: "patch applied".repeat(1_000) },
		];
		let requestInput: Array<Record<string, unknown>> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			const body: unknown = JSON.parse(String(init?.body));
			if (!isRecord(body) || !Array.isArray(body.input) || !body.input.every(isRecord)) {
				throw new Error("expected remote compaction input");
			}
			requestInput = body.input;
			return Response.json({
				output: [{ type: "compaction_summary", summary: "compact" }],
			});
		};

		await requestOpenAiRemoteCompaction(
			makeOpenAiModel({ contextWindow: 1_000 }),
			"test-key",
			nativeInput,
			"compact",
			undefined,
			{ fetch: fetchMock },
		);

		const trimmed = trimRemoteCompactionInputToContextWindow(nativeInput, new Tokenizer(), 1_000, "compact");
		expect(trimmed.estimatedTokensAfter).toBeLessThanOrEqual(1_000);
		expect(requestInput?.some(item => item.type === "custom_tool_call")).toBe(true);
		expect(requestInput?.find(item => item.type === "custom_tool_call_output")?.output).toBe(
			CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
		);
	});

	test("rewrites contiguous trailing outputs until the request fits", () => {
		const input = [
			{ type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
			{ type: "function_call", call_id: "call_2", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "a".repeat(8_000) },
			{ type: "function_call_output", call_id: "call_2", output: "b".repeat(8_000) },
		];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 1_000, "compact");

		expect(result.rewrittenOutputs).toBe(2);
		expect(result.input.slice(0, 2)).toEqual(input.slice(0, 2));
		expect(result.input.slice(2).map(item => item.output)).toEqual([
			CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
			CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
		]);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(1_000);
		expect(input[2].output).toHaveLength(8_000);
	});

	test("keeps the original input when trailing rewrites cannot make the request fit", () => {
		const input = [
			{ type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "a".repeat(20_000) },
			{ type: "function_call", call_id: "call_2", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_2", output: "useful latest result" },
		];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 1_000, "compact");

		expect(result.rewrittenOutputs).toBe(0);
		expect(result.input).toEqual(input);
		expect(result.input[3].output).toBe("useful latest result");
		expect(result.estimatedTokensAfter).toBe(result.estimatedTokensBefore);
	});

	test("charges inline images by the maximum vision budget instead of serialized base64 size", () => {
		const input = [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_image", detail: "auto", image_url: `data:image/png;base64,${"a".repeat(80_000)}` },
				],
			},
			{ type: "function_call_output", call_id: "call_1", output: "useful result" },
		];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 15_000, "compact");

		expect(result.rewrittenOutputs).toBe(0);
		expect(result.input).toEqual(input);
		expect(result.estimatedTokensAfter).toBeGreaterThan(12_000);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(15_000);
	});

	test("uses conservative token accounting for token-dense trailing output", () => {
		const output = Array.from({ length: 1_000 }, (_, index) => index.toString(16).padStart(8, "0")).join("");
		const input = [{ type: "function_call_output", call_id: "call_1", output }];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 3_000, "compact");

		expect(result.estimatedTokensBefore).toBeGreaterThan(3_000);
		expect(result.rewrittenOutputs).toBe(1);
		expect(result.input[0].output).toBe(CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(3_000);
	});

	test("scans past a synthetic tool-image attachment to rewrite its output", () => {
		const attachment = {
			type: "message",
			role: "user",
			content: [
				{ type: "input_text", text: "Attached image(s) from tool result:" },
				{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
			],
		};
		const input = [
			{ type: "function_call_output", call_id: "call_1", output: "large tool output".repeat(1_000) },
			attachment,
		];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 15_000, "compact");

		expect(result.rewrittenOutputs).toBe(1);
		expect(result.input[0].output).toBe(CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE);
		expect(result.input[1]).toEqual(attachment);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(15_000);
	});

	test("rewrites a native multimodal tool output atomically", () => {
		const input = [
			{
				type: "function_call_output",
				call_id: "call_1",
				output: [
					{ type: "input_text", text: "large tool output".repeat(1_000) },
					{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
				],
			},
		];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 15_000, "compact");

		expect(result.rewrittenOutputs).toBe(1);
		expect(result.input[0].output).toBe(CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(15_000);
	});

	test("reserves the maximum patch budget for original-detail images", () => {
		const input = [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_image", detail: "original", image_url: `data:image/png;base64,${"a".repeat(80_000)}` },
				],
			},
			{ type: "function_call_output", call_id: "call_1", output: "useful result".repeat(2_000) },
		];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 15_000, "compact");

		expect(result.estimatedTokensBefore).toBeGreaterThan(15_000);
		expect(result.rewrittenOutputs).toBe(1);
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(15_000);
	});

	test("returns semantically unchanged input when it already fits", () => {
		const input = [{ type: "function_call_output", call_id: "call_1", output: "small" }];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 1_000, "compact");

		expect(result.rewrittenOutputs).toBe(0);
		expect(result.input).toEqual(input);
	});
});

describe("requestCompactionV2Streaming", () => {
	test("posts a compaction_trigger Responses stream and installs Codex-style replacement history", async () => {
		const userItem = { type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] };
		const compactionItem = { type: "compaction", encrypted_content: "enc_123" };
		const model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
				model: "gpt-5-compact",
			},
		});
		const request = buildCompactionV2Request(
			model,
			[
				{ type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] },
				{ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\nrepo" }] },
				userItem,
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ignored" }] },
			],
			"instructions",
			{ sessionId: "session-1", promptCacheKey: "cache-1" },
		);
		let requestBody: { model: string; input: Array<Record<string, unknown>>; prompt_cache_key?: string } | undefined;
		let sessionHeader: string | undefined;
		let clientRequestHeader: string | undefined;
		let legacySessionHeader: string | undefined;
		let betaFeaturesHeader: string | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			expect(String(input)).toBe("https://compact.example/v1/responses");
			if (!init?.headers || init.headers instanceof Headers || Array.isArray(init.headers)) {
				throw new Error("Expected V2 compaction to send headers as a plain object");
			}
			const rawSessionHeader = init.headers.session_id;
			const rawClientRequestHeader = init.headers["x-client-request-id"];
			const rawLegacySessionHeader = init.headers["session-id"];
			const rawBetaFeaturesHeader = init.headers["x-codex-beta-features"];
			sessionHeader = typeof rawSessionHeader === "string" ? rawSessionHeader : undefined;
			clientRequestHeader = typeof rawClientRequestHeader === "string" ? rawClientRequestHeader : undefined;
			legacySessionHeader = typeof rawLegacySessionHeader === "string" ? rawLegacySessionHeader : undefined;
			betaFeaturesHeader = typeof rawBetaFeaturesHeader === "string" ? rawBetaFeaturesHeader : undefined;
			requestBody = JSON.parse(String(init.body)) as {
				model: string;
				input: Array<Record<string, unknown>>;
				prompt_cache_key?: string;
			};
			return sseResponse([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ignored" }] },
				},
				{ type: "response.output_item.done", output_index: 1, item: compactionItem },
				{
					type: "response.completed",
					response: {
						usage: {
							input_tokens: 123,
							output_tokens: 4,
							total_tokens: 127,
							input_tokens_details: { cached_tokens: 7 },
							output_tokens_details: { reasoning_tokens: 1 },
						},
					},
				},
			]);
		};

		expect(shouldUseCompactionV2Streaming(model)).toBe(true);
		const result = await requestCompactionV2Streaming(model, "test-key", request, undefined, { fetch: fetchMock });

		expect(sessionHeader).toBe("session-1");
		expect(clientRequestHeader).toBe("session-1");
		expect(legacySessionHeader).toBeUndefined();
		expect(betaFeaturesHeader).toBeUndefined();
		expect(requestBody?.model).toBe("gpt-5-compact");
		expect(requestBody?.prompt_cache_key).toBe("cache-1");
		expect(requestBody?.input[requestBody.input.length - 1]).toEqual({ type: "compaction_trigger" });
		expect(result.replacementHistory).toEqual([userItem, compactionItem]);
		expect(result.usedTokens).toBe(123);
		expect(result.usage?.cachedInputTokens).toBe(7);
		expect(result.usage?.reasoningOutputTokens).toBe(1);
	});

	test("negotiates Codex V2 compaction for an explicit Responses endpoint", async () => {
		const model = buildModel({
			id: "gpt-5",
			name: "GPT-5",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
			remoteCompaction: {
				enabled: true,
				api: "openai-codex-responses",
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		const request = buildCompactionV2Request(
			model,
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] }],
			"instructions",
		);
		let betaFeaturesHeader: string | undefined;
		let residencyHeader: string | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			if (!init?.headers || init.headers instanceof Headers || Array.isArray(init.headers)) {
				throw new Error("Expected V2 compaction to send headers as a plain object");
			}
			const rawBetaFeaturesHeader = init.headers["x-codex-beta-features"];
			const rawResidencyHeader = init.headers["x-openai-internal-codex-residency"];
			betaFeaturesHeader = typeof rawBetaFeaturesHeader === "string" ? rawBetaFeaturesHeader : undefined;
			residencyHeader = typeof rawResidencyHeader === "string" ? rawResidencyHeader : undefined;
			return sseResponse([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "compaction", encrypted_content: "enc" },
				},
				{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
			]);
		};

		await requestCompactionV2Streaming(model, CODEX_RESIDENCY_TOKEN, request, undefined, { fetch: fetchMock });

		expect(betaFeaturesHeader).toBe("remote_compaction_v2");
		expect(residencyHeader).toBe("us");
	});

	test("retries transient V2 stream failures with a fresh request attempt", async () => {
		const model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		const request = buildCompactionV2Request(
			model,
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] }],
			"instructions",
		);
		let attempts = 0;
		const fetchMock: FetchImpl = async () => {
			attempts++;
			if (attempts === 1) {
				return new Response("try again", { status: 500, statusText: "Internal Server Error" });
			}
			return sseResponse([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "compaction", encrypted_content: "enc" },
				},
				{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
			]);
		};

		await requestCompactionV2Streaming(model, "test-key", request, undefined, {
			fetch: fetchMock,
			retryWait: async () => {},
		});

		expect(attempts).toBe(2);
	});

	test("does not retry and preserves auth_unavailable from V2 HTTP failures", async () => {
		const model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		const request = buildCompactionV2Request(
			model,
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] }],
			"instructions",
		);
		const fetchMock = vi.fn(async () =>
			Response.json(
				{ error: { type: "auth_unavailable", message: "no auth available for codex" } },
				{ status: 503, statusText: "Service Unavailable" },
			),
		);

		const error = await requestCompactionV2Streaming(model, "test-key", request, undefined, {
			fetch: fetchMock,
			retryWait: async () => {},
		}).catch(cause => cause);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(error).toBeInstanceOf(AIError.ProviderHttpError);
		expect(AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)).toBe(true);
	});
});

describe("Responses Lite remote compaction", () => {
	function makeCodexLiteModel(
		overrides: Partial<ModelSpec<"openai-codex-responses">> = {},
	): Model<"openai-codex-responses"> {
		return buildModel({
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.example/backend-api",
			reasoning: true,
			preferWebsockets: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 372000,
			maxTokens: 128000,
			useResponsesLite: true,
			remoteCompaction: { enabled: true, api: "openai-codex-responses", v2StreamingEnabled: true },
			...overrides,
		});
	}

	interface CapturedLiteRequest {
		instructions?: unknown;
		tools?: unknown;
		input?: Array<Record<string, unknown>>;
		client_metadata?: unknown;
		reasoning?: Record<string, unknown>;
		include?: string[];
	}

	interface CapturedLiteExchange {
		body: CapturedLiteRequest;
		headers: Headers;
	}

	function parseCodexTurnMetadata(value: unknown): Record<string, unknown> {
		if (typeof value !== "string") throw new Error("expected x-codex-turn-metadata");
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed)) throw new Error("expected Codex turn metadata object");
		return parsed;
	}

	function captureLite(init: RequestInit | undefined): CapturedLiteExchange {
		if (!init?.headers || init.headers instanceof Headers || Array.isArray(init.headers)) {
			throw new Error("Expected remote compaction to send headers as a plain object");
		}
		return {
			body: JSON.parse(String(init.body)) as CapturedLiteRequest,
			headers: new Headers(init.headers),
		};
	}

	function captureStreamLite(init: RequestInit | undefined): CapturedLiteExchange {
		if (!init?.headers) throw new Error("Expected local compaction request headers");
		return {
			body: JSON.parse(String(init.body)) as CapturedLiteRequest,
			headers: new Headers(init.headers),
		};
	}

	function compactionV2Events(encryptedContent: string): Array<Record<string, unknown>> {
		return [
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "compaction", encrypted_content: encryptedContent },
			},
			{
				type: "response.done",
				response: {
					id: `response-${encryptedContent}`,
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		];
	}

	test("V1 compaction sends the lite header and input-item instructions", async () => {
		const model = makeCodexLiteModel();
		let captured: CapturedLiteExchange | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			captured = captureLite(init);
			return Response.json({ output: [{ type: "compaction", encrypted_content: "enc" }] });
		};

		await requestOpenAiRemoteCompaction(
			model,
			CODEX_RESIDENCY_TOKEN,
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
			"compact instructions",
			undefined,
			{
				fetch: fetchMock,
				sessionId: "codex-compaction-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
				codexCompaction: TEST_CODEX_COMPACTION,
			},
		);

		expect(captured?.headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
		expect(captured?.headers.get("x-openai-internal-codex-residency")).toBe("us");
		expect(captured?.body.reasoning).toEqual({ context: "all_turns" });
		expect(captured?.body.include).toEqual(["reasoning.encrypted_content"]);
		expect(captured?.body.instructions).toBeUndefined();
		expect(captured?.body.client_metadata).toBeUndefined();
		expect(captured?.headers.get("x-codex-installation-id")).toBe(TEST_INSTALLATION_ID);
		expect(captured?.headers.get("session-id")).toBe("codex-compaction-session");
		const v1TurnMetadata = parseCodexTurnMetadata(captured?.headers.get("x-codex-turn-metadata"));
		expect(v1TurnMetadata.request_kind).toBe("compaction");
		expect(v1TurnMetadata.compaction).toEqual({
			trigger: "auto",
			reason: "context_limit",
			implementation: "responses_compact",
			phase: "pre_turn",
			strategy: "memento",
		});
		expect(captured?.body.input?.[0]).toEqual({ type: "additional_tools", role: "developer", tools: [] });
		expect(captured?.body.input?.[1]).toEqual({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: "compact instructions" }],
		});
	});

	test("V2 streaming compaction applies the lite rewrite and keeps the trigger last", async () => {
		const model = makeCodexLiteModel();
		const request = buildCompactionV2Request(
			model,
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] }],
			"compact instructions",
			{ sessionId: "codex-compaction-session" },
		);
		let captured: CapturedLiteExchange | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			captured = captureStreamLite(init);
			return sseResponse(compactionV2Events("enc"));
		};

		expect(shouldUseCompactionV2Streaming(model)).toBe(true);
		await requestCompactionV2Streaming(model, CODEX_RESIDENCY_TOKEN, request, undefined, {
			fetch: fetchMock,
			providerSessionState: new Map<string, ProviderSessionState>(),
			codexCompaction: TEST_CODEX_COMPACTION,
		});

		expect(captured?.headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
		expect(captured?.headers.get("x-openai-internal-codex-residency")).toBe("us");
		expect(captured?.body.reasoning).toEqual({ context: "all_turns" });
		expect(captured?.body.include).toEqual(["reasoning.encrypted_content"]);
		expect(captured?.body.instructions).toBeUndefined();
		if (!isRecord(captured?.body.client_metadata)) throw new Error("expected V2 client_metadata");
		const v2ClientMetadata = captured.body.client_metadata;
		const v2TurnMetadata = parseCodexTurnMetadata(v2ClientMetadata["x-codex-turn-metadata"]);
		expect(captured.headers.get("x-codex-installation-id")).toBeNull();
		expect(v2ClientMetadata["x-codex-installation-id"]).toBe(TEST_INSTALLATION_ID);
		expect(v2ClientMetadata.session_id).toBe(captured.headers.get("session-id"));
		expect(v2ClientMetadata.thread_id).toBe(captured.headers.get("thread-id"));
		expect(v2TurnMetadata.request_kind).toBe("compaction");
		expect(v2TurnMetadata.compaction).toEqual({
			trigger: "auto",
			reason: "context_limit",
			implementation: "responses_compaction_v2",
			phase: "pre_turn",
			strategy: "memento",
		});
		expect(captured?.body.input?.[0]).toEqual({ type: "additional_tools", role: "developer", tools: [] });
		expect(captured?.body.input?.[1]).toEqual({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: "compact instructions" }],
		});
		expect(captured?.body.input?.at(-1)).toEqual({ type: "compaction_trigger" });
	});

	test("V2 compaction reuses the live Codex WebSocket transport when preferred", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const webSocket = installCodexCompactionWebSocket({
			respond: (socket, outbound) => {
				const input = outbound.input;
				const isCompaction =
					Array.isArray(input) && input.some(item => isRecord(item) && item.type === "compaction_trigger");
				const events = isCompaction
					? compactionV2Events("enc-websocket")
					: [
							{
								type: "response.output_item.done",
								item: {
									type: "message",
									id: "message-live-turn",
									role: "assistant",
									status: "completed",
									content: [{ type: "output_text", text: "live response" }],
								},
							},
							{
								type: "response.done",
								response: {
									id: "response-live-turn",
									status: "completed",
									usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
								},
							},
						];
				for (const event of events) socket.emit(event);
			},
		});
		try {
			const model = makeCodexLiteModel({ preferWebsockets: true });
			const sessionId = "codex-websocket-compaction";
			const fetchMock = vi.fn(async () => {
				throw new Error("WebSocket-first V2 compaction unexpectedly used SSE");
			});
			const liveTurn = await ai
				.streamSimple(
					model,
					{
						systemPrompt: ["You are a helpful assistant."],
						messages: [{ role: "user", content: "Start the turn", timestamp: Date.now() }],
					},
					{
						apiKey: "test-key",
						fetch: fetchMock,
						sessionId,
						preferWebsockets: true,
						providerSessionState,
					},
				)
				.result();
			expect(liveTurn.stopReason).toBe("stop");

			const request = buildCompactionV2Request(
				model,
				[{ type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] }],
				"compact instructions",
				{ sessionId },
			);
			const result = await requestCompactionV2Streaming(model, "test-key", request, undefined, {
				fetch: fetchMock,
				preferWebsockets: true,
				providerSessionState,
				codexCompaction: TEST_CODEX_COMPACTION,
			});

			const sentRequest = webSocket.sockets[0]?.sent[1];
			const sentInput = sentRequest?.input;
			expect(fetchMock).not.toHaveBeenCalled();
			expect(webSocket.sockets).toHaveLength(1);
			expect(webSocket.sockets[0]?.sent).toHaveLength(2);
			expect(sentRequest?.type).toBe("response.create");
			expect(Array.isArray(sentInput) ? sentInput.at(-1) : undefined).toEqual({ type: "compaction_trigger" });
			expect(result.compactionItem).toEqual({ type: "compaction", encrypted_content: "enc-websocket" });
			expect(
				getOpenAICodexTransportDetails(model, {
					sessionId,
					providerSessionState,
				}),
			).toMatchObject({
				lastTransport: "websocket",
				websocketConnected: true,
				canAppend: false,
			});
		} finally {
			for (const state of providerSessionState.values()) state.close();
			providerSessionState.clear();
			webSocket.restore();
		}
	});

	test("V2 compaction discards partial WebSocket output before SSE replay", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const webSocket = installCodexCompactionWebSocket({
			respond: socket => {
				socket.emit({
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "compaction", encrypted_content: "enc-partial-websocket" },
				});
				queueMicrotask(() => socket.fail());
			},
		});
		try {
			const model = makeCodexLiteModel({ preferWebsockets: true });
			const request = buildCompactionV2Request(
				model,
				[{ type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] }],
				"compact instructions",
				{ sessionId: "codex-websocket-fallback" },
			);
			const fetchMock = vi.fn(async () => sseResponse(compactionV2Events("enc-sse")));

			const result = await requestCompactionV2Streaming(model, "test-key", request, undefined, {
				fetch: fetchMock,
				preferWebsockets: true,
				providerSessionState,
				codexCompaction: TEST_CODEX_COMPACTION,
			});

			expect(webSocket.sockets).toHaveLength(1);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.compactionItem).toEqual({ type: "compaction", encrypted_content: "enc-sse" });
			expect(
				getOpenAICodexTransportDetails(model, {
					sessionId: "codex-websocket-fallback",
					providerSessionState,
				}),
			).toMatchObject({
				lastTransport: "sse",
				websocketDisabled: true,
			});
		} finally {
			for (const state of providerSessionState.values()) state.close();
			providerSessionState.clear();
			webSocket.restore();
		}
	});

	test("V2 compaction over WebSocket keeps the first mid-turn x-codex-turn-state", async () => {
		const midTurnCompaction = { ...TEST_CODEX_COMPACTION, phase: "mid_turn" as const };
		const providerSessionState = new Map<string, ProviderSessionState>();
		let responseCount = 0;
		const webSocket = installCodexCompactionWebSocket({
			respond: socket => {
				responseCount += 1;
				// The handshake already seeded `compaction-state-0`; a later
				// response value must not replace the turn's first sticky token.
				socket.emit({ type: "response.metadata", headers: { "x-codex-turn-state": "later-turn-state" } });
				for (const event of compactionV2Events(`enc-metadata-${responseCount}`)) socket.emit(event);
			},
		});
		try {
			const model = makeCodexLiteModel({ preferWebsockets: true });
			const sessionId = "codex-websocket-turn-state";
			const buildRequest = () =>
				buildCompactionV2Request(
					model,
					[{ type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] }],
					"compact instructions",
					{ sessionId },
				);
			const streamOptions = {
				preferWebsockets: true,
				providerSessionState,
				codexCompaction: midTurnCompaction,
			} as const;

			await requestCompactionV2Streaming(model, "test-key", buildRequest(), undefined, streamOptions);
			await requestCompactionV2Streaming(model, "test-key", buildRequest(), undefined, streamOptions);

			const secondRequest = webSocket.sockets[0]?.sent[1];
			const clientMetadata = isRecord(secondRequest?.client_metadata) ? secondRequest.client_metadata : undefined;
			expect(webSocket.sockets).toHaveLength(1);
			expect(webSocket.sockets[0]?.sent).toHaveLength(2);
			expect(clientMetadata?.["x-codex-turn-state"]).toBe("compaction-state-0");
			expect(getOpenAICodexTransportDetails(model, { sessionId, providerSessionState })).toMatchObject({
				hasTurnState: true,
			});
		} finally {
			for (const state of providerSessionState.values()) state.close();
			providerSessionState.clear();
			webSocket.restore();
		}
	});

	test("V2 compaction rolls back SSE metadata when the attempt fails", async () => {
		const model = makeCodexLiteModel();
		const sessionId = "codex-sse-failed-turn-state";
		const providerSessionState = new Map<string, ProviderSessionState>();
		const request = buildCompactionV2Request(
			model,
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "real user" }] }],
			"compact instructions",
			{ sessionId },
		);
		let requestCount = 0;
		let replay: CapturedLiteExchange | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			requestCount += 1;
			if (requestCount === 1) {
				return sseResponse([
					{ type: "response.metadata", headers: { "x-codex-turn-state": "discarded-turn-state" } },
					{
						type: "response.failed",
						response: { error: { code: "data_residency_mismatch", message: "wrong transport route" } },
					},
				]);
			}
			replay = captureStreamLite(init);
			return sseResponse(compactionV2Events("enc-replay"));
		};
		const options = {
			fetch: fetchMock,
			preferWebsockets: false,
			providerSessionState,
			codexCompaction: { ...TEST_CODEX_COMPACTION, phase: "mid_turn" as const },
		};
		try {
			await expect(requestCompactionV2Streaming(model, "test-key", request, undefined, options)).rejects.toThrow(
				"data_residency_mismatch",
			);
			await requestCompactionV2Streaming(model, "test-key", request, undefined, options);

			const clientMetadata = isRecord(replay?.body.client_metadata) ? replay.body.client_metadata : undefined;
			expect(requestCount).toBe(2);
			expect(clientMetadata?.["x-codex-turn-state"]).toBeUndefined();
		} finally {
			for (const state of providerSessionState.values()) state.close();
			providerSessionState.clear();
		}
	});

	test("compact fan-out keeps local Codex summaries on one classified turn", async () => {
		const model = makeCodexLiteModel();
		const captured: CapturedLiteExchange[] = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			captured.push(captureStreamLite(init));
			return sseResponse([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg_summary", role: "assistant", status: "in_progress", content: [] },
				},
				{
					type: "response.content_part.added",
					output_index: 0,
					content_index: 0,
					part: { type: "output_text", text: "" },
				},
				{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "local summary" },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg_summary",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "local summary" }],
					},
				},
				{
					type: "response.completed",
					response: {
						status: "completed",
						usage: {
							input_tokens: 8,
							output_tokens: 2,
							total_tokens: 10,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]);
		};
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-1",
			messagesToSummarize: [{ role: "user", content: "long history", timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [{ role: "user", content: "recent", timestamp: 2 }],
			isSplitTurn: false,
			tokensBefore: 100_000,
			fileOps: createFileOps(),
			settings: {
				...DEFAULT_COMPACTION_SETTINGS,
				remoteEnabled: false,
				remoteStreamingV2Enabled: false,
			},
		};

		const result = await compact(preparation, model, "test-key", undefined, undefined, {
			fetch: fetchMock,
			sessionId: "codex-compaction-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
			codexCompaction: TEST_CODEX_COMPACTION,
		});

		expect(result.summary).toContain("local summary");
		expect(captured).toHaveLength(2);
		const turnIds: string[] = [];
		for (const exchange of captured) {
			if (!isRecord(exchange.body.client_metadata)) throw new Error("expected local client_metadata");
			const clientMetadata = exchange.body.client_metadata;
			const turnMetadata = parseCodexTurnMetadata(clientMetadata["x-codex-turn-metadata"]);
			expect(exchange.headers.get("x-codex-installation-id")).toBeNull();
			expect(clientMetadata["x-codex-installation-id"]).toBe(TEST_INSTALLATION_ID);
			expect(turnMetadata.request_kind).toBe("compaction");
			expect(turnMetadata.compaction).toEqual({
				trigger: "auto",
				reason: "context_limit",
				implementation: "responses",
				phase: "pre_turn",
				strategy: "memento",
			});
			if (typeof turnMetadata.turn_id !== "string") throw new Error("expected Codex turn id");
			turnIds.push(turnMetadata.turn_id);
		}
		expect(new Set(turnIds).size).toBe(1);
	});

	test("local Codex compaction isolates and closes transient websocket sessions", async () => {
		let responseCount = 0;
		const webSocket = installCodexCompactionWebSocket({
			respond: socket => {
				responseCount += 1;
				const responseId = `response-${responseCount}`;
				const messageId = `message-${responseCount}`;
				const text = responseCount === 1 ? "main response" : "local summary";
				const events: Record<string, unknown>[] = [
					{
						type: "response.output_item.added",
						item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
					},
					{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
					{ type: "response.output_text.delta", delta: text },
					{
						type: "response.output_item.done",
						item: {
							type: "message",
							id: messageId,
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text }],
						},
					},
					{
						type: "response.done",
						response: {
							id: responseId,
							status: "completed",
							usage: {
								input_tokens: 8,
								output_tokens: 2,
								total_tokens: 10,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				];
				for (const event of events) socket.emit(event);
			},
		});

		const providerSessionState = new Map<string, ProviderSessionState>();
		try {
			const model = makeCodexLiteModel({ preferWebsockets: true });
			const sessionId = "agent-compaction-isolation";
			const fetchMock: FetchImpl = async () => {
				throw new Error("Codex websocket compaction unexpectedly used SSE");
			};
			const main = await ai
				.streamSimple(
					model,
					{
						systemPrompt: ["You are a helpful assistant."],
						messages: [{ role: "user", content: "Start the turn", timestamp: Date.now() }],
					},
					{ apiKey: "test-key", fetch: fetchMock, sessionId, providerSessionState },
				)
				.result();
			expect(main.stopReason).toBe("stop");
			expect(webSocket.sockets).toHaveLength(1);
			expect(webSocket.sockets[0]?.readyState).toBe(globalThis.WebSocket.OPEN);

			const preparation: CompactionPreparation = {
				firstKeptEntryId: "kept-1",
				messagesToSummarize: [{ role: "user", content: "long history", timestamp: 1 }],
				turnPrefixMessages: [],
				recentMessages: [{ role: "user", content: "recent", timestamp: 2 }],
				isSplitTurn: false,
				tokensBefore: 100_000,
				fileOps: createFileOps(),
				settings: {
					...DEFAULT_COMPACTION_SETTINGS,
					remoteEnabled: false,
					remoteStreamingV2Enabled: false,
				},
			};
			const result = await compact(preparation, model, "test-key", undefined, undefined, {
				fetch: fetchMock,
				sessionId,
				providerSessionState,
				codexCompaction: TEST_CODEX_COMPACTION,
			});

			expect(result.summary).toContain("local summary");
			expect(webSocket.sockets).toHaveLength(3);
			expect(webSocket.sockets[0]?.readyState).toBe(globalThis.WebSocket.OPEN);
			expect(webSocket.sockets[1]?.readyState).toBe(globalThis.WebSocket.CLOSED);
			expect(webSocket.sockets[2]?.readyState).toBe(globalThis.WebSocket.CLOSED);
			expect(
				getOpenAICodexTransportDetails(model, {
					sessionId,
					providerSessionState,
				}),
			).toMatchObject({
				websocketConnected: true,
				hasTurnState: true,
			});
		} finally {
			for (const state of providerSessionState.values()) state.close();
			providerSessionState.clear();
			webSocket.restore();
		}
	});
});

test("uses configured OpenAI-compatible compaction for custom providers", async () => {
	const model = makeOpenAiModel({
		provider: "cliproxy-codex",
		baseUrl: "http://127.0.0.1:8317/v1",
		remoteCompaction: {
			enabled: true,
			api: "openai-responses",
			endpoint: "http://127.0.0.1:8317/v1/responses/compact",
			model: "gpt-5.5",
		},
	});
	let requestBody: unknown;
	const fetchMock: FetchImpl = async (input, init) => {
		expect(String(input)).toBe("http://127.0.0.1:8317/v1/responses/compact");
		requestBody = JSON.parse(String(init?.body));
		return new Response(
			JSON.stringify({
				output: [{ type: "compaction_summary", summary: "native compacted" }],
			}),
		);
	};

	expect(shouldUseOpenAiRemoteCompaction(model)).toBe(true);
	await requestOpenAiRemoteCompaction(
		model,
		"test-key",
		[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
		"instructions",
		undefined,
		{ fetch: fetchMock },
	);
	expect(requestBody).toMatchObject({ model: "gpt-5.5" });
});

test("uses Azure request shape for Azure Responses remote compaction", async () => {
	const previousDeploymentMap = Bun.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
	Bun.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = "gpt-5-compact=azure-gpt-5-compact";
	const model = makeAzureModel({
		headers: { "x-custom-header": "custom" },
		remoteCompaction: {
			enabled: true,
			api: "azure-openai-responses",
			model: "gpt-5-compact",
		},
	});
	let requestBody: unknown;
	let requestApiKey: string | undefined;
	let requestAuthorization: string | undefined;
	let requestContentType: string | undefined;
	let requestCustomHeader: string | undefined;
	const stringHeader = (value: string | readonly string[] | undefined): string | undefined =>
		typeof value === "string" ? value : undefined;
	const fetchMock: FetchImpl = async (input, init) => {
		expect(String(input)).toBe(
			"https://example-resource.openai.azure.com/openai/v1/responses/compact?api-version=v1",
		);
		if (!init?.headers || init.headers instanceof Headers || Array.isArray(init.headers)) {
			throw new Error("Expected remote compaction to send headers as a plain object");
		}
		requestApiKey = stringHeader(init.headers["api-key"]);
		requestAuthorization = stringHeader(init.headers.Authorization);
		requestContentType = stringHeader(init.headers["content-type"]);
		requestCustomHeader = stringHeader(init.headers["x-custom-header"]);
		requestBody = JSON.parse(String(init.body));
		return Response.json({
			output: [{ type: "compaction_summary", summary: "azure compacted" }],
		});
	};

	expect(shouldUseOpenAiRemoteCompaction(model)).toBe(true);
	await requestOpenAiRemoteCompaction(
		model,
		"azure-key",
		[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
		"instructions",
		undefined,
		{ fetch: fetchMock },
	);

	expect(requestApiKey).toBe("azure-key");
	expect(requestAuthorization).toBeUndefined();
	expect(requestContentType).toBe("application/json");
	expect(requestCustomHeader).toBe("custom");
	expect(requestBody).toMatchObject({ model: "azure-gpt-5-compact" });
	if (previousDeploymentMap === undefined) {
		delete Bun.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
	} else {
		Bun.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = previousDeploymentMap;
	}
});

describe("requestOpenAiRemoteCompaction abort", () => {
	test("rejects when the abort signal is aborted mid-fetch", async () => {
		const controller = new AbortController();
		const fetchMock: FetchImpl = (_input, init) => {
			// Honor the provided abort signal: hang until aborted, then reject.
			const signal = init?.signal as AbortSignal | undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			if (signal?.aborted) {
				reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
				return promise;
			}
			signal?.addEventListener("abort", () => {
				reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
			});
			return promise;
		};

		const promise = requestOpenAiRemoteCompaction(
			makeOpenAiModel(),
			"test-key",
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
			"compact",
			controller.signal,
			{ fetch: fetchMock },
		);

		queueMicrotask(() => controller.abort());

		await expect(promise).rejects.toThrow();
	});
});

describe("requestOpenAiRemoteCompaction timeout", () => {
	test("a never-responding endpoint rejects with TimeoutError instead of hanging", async () => {
		// Contract: the compact endpoint is a raw fetch outside the pi-ai stream
		// watchdogs — a silently dropped connection must not hang compaction
		// forever (frozen "Auto context-full maintenance…" spinner).
		const fetchMock: FetchImpl = (_input, init) => {
			const signal = init?.signal as AbortSignal | undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			signal?.addEventListener("abort", () => reject(signal.reason));
			return promise;
		};

		await expect(
			requestOpenAiRemoteCompaction(
				makeOpenAiModel(),
				"test-key",
				[{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
				"compact",
				undefined,
				{ fetch: fetchMock, timeoutMs: 20 },
			),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});
});

describe("requestRemoteCompaction wire formats", () => {
	test("uses OpenAI chat completions format for /chat/completions endpoints", async () => {
		const model = buildModel({
			id: "catalog-selection-id",
			name: "Qwopus 3.6 35B-A3B Coder",
			requestModelId: "provider-wire-id",
			remoteCompaction: { model: "provider-compact-wire-id" },
			api: "openai-completions",
			provider: "local-llama",
			baseUrl: "http://127.0.0.1:8001/v1",
			headers: { "x-local-llama": "1" },
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 4096,
		});
		let sentBody: unknown;
		const fetchMock: FetchImpl = async (_input, init) => {
			if (typeof init?.body !== "string") throw new Error("missing remote compaction request body");
			sentBody = JSON.parse(init.body) as unknown;
			const headers = new Headers(init.headers);
			expect(headers.get("authorization")).toBe("Bearer local-key");
			expect(headers.get("x-local-llama")).toBe("1");
			return new Response(JSON.stringify({ choices: [{ message: { content: "remote summary" } }] }), {
				headers: { "content-type": "application/json" },
			});
		};

		const result = await requestRemoteCompaction(
			"http://127.0.0.1:8001/v1/chat/completions",
			{ systemPrompt: "summarize", prompt: "<conversation>hello</conversation>", maxTokens: 16_384 },
			undefined,
			{ fetch: fetchMock, model, apiKey: "local-key" },
		);

		expect(result).toEqual({ summary: "remote summary" });
		expect(sentBody).toEqual({
			model: "provider-compact-wire-id",
			messages: [
				{ role: "system", content: "summarize" },
				{ role: "user", content: "<conversation>hello</conversation>" },
			],
			stream: false,
			max_tokens: 16_384,
		});
	});

	test("keeps the generic omp summarizer format for other endpoints", async () => {
		let sentBody: unknown;
		const fetchMock: FetchImpl = async (_input, init) => {
			if (typeof init?.body !== "string") throw new Error("missing remote compaction request body");
			sentBody = JSON.parse(init.body) as unknown;
			expect(new Headers(init.headers).get("authorization")).toBeNull();
			return new Response(JSON.stringify({ summary: "generic summary", shortSummary: "generic" }), {
				headers: { "content-type": "application/json" },
			});
		};

		const result = await requestRemoteCompaction(
			"https://compaction.example.test/summarize",
			{ systemPrompt: "summarize", prompt: "<conversation>hello</conversation>", maxTokens: 16_384 },
			undefined,
			{ fetch: fetchMock, apiKey: "unused-for-generic" },
		);

		expect(result).toEqual({ summary: "generic summary", shortSummary: "generic" });
		expect(sentBody).toEqual({
			systemPrompt: "summarize",
			prompt: "<conversation>hello</conversation>",
			maxTokens: 16_384,
		});
	});
});

describe("compact() remote compaction failure handling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function localSummaryMessage(text: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
			provider: "mock",
			model: "mock",
			api: "mock",
			usage: ZERO_USAGE,
			stopReason: "stop",
		};
	}

	function makePreparation(): CompactionPreparation {
		return {
			firstKeptEntryId: "kept-1",
			messagesToSummarize: [{ role: "user", content: "long history", timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [{ role: "user", content: "recent", timestamp: 2 }],
			isSplitTurn: false,
			tokensBefore: 100_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteStreamingV2Enabled: false },
		};
	}

	test("streams V2 compaction before V1 when both settings and model opt in", async () => {
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local summary"));
		const compactionItem = { type: "compaction", encrypted_content: "enc_v2" };
		const preparation = makePreparation();
		preparation.settings = {
			...preparation.settings,
			remoteStreamingV2Enabled: true,
		};
		preparation.messagesToSummarize = [
			{ role: "user", content: "first user request", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "hidden reasoning",
						thinkingSignature: JSON.stringify({
							type: "reasoning",
							id: "rs_test",
							encrypted_content: "encrypted reasoning",
							summary: [],
						}),
					},
					{ type: "text", text: "assistant visible answer" },
					{ type: "toolCall", id: "call_read_1|fc_read_1", name: "read", arguments: { path: "/tmp/x" } },
				],
				timestamp: 2,
				provider: "openai",
				model: "gpt-5",
				api: "openai-responses",
				usage: ZERO_USAGE,
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "call_read_1|fc_read_1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				timestamp: 3,
			},
		];
		preparation.recentMessages = [{ role: "user", content: "second user request", timestamp: 4 }];
		const model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		let requestBody: { input: Array<Record<string, unknown>>; reasoning?: Record<string, unknown> } | undefined;
		let calls = 0;
		const fetchMock: FetchImpl = async (_input, init) => {
			calls++;
			requestBody = JSON.parse(String(init?.body)) as {
				input: Array<Record<string, unknown>>;
				reasoning?: Record<string, unknown>;
			};
			return sseResponse([
				{ type: "response.output_item.done", output_index: 0, item: compactionItem },
				{
					type: "response.completed",
					response: { usage: { input_tokens: 55, output_tokens: 3, total_tokens: 58 } },
				},
			]);
		};

		const result = await compact(preparation, model, "test-key", undefined, undefined, {
			fetch: fetchMock,
		});

		const input = requestBody?.input ?? [];
		const inputText = input.flatMap(item =>
			Array.isArray(item.content)
				? item.content.filter(isRecord).map(part => (typeof part.text === "string" ? part.text : ""))
				: [],
		);
		expect(calls).toBe(1);
		// Faithful Codex V2 shape: the trigger is the final input item.
		expect(input[input.length - 1]).toEqual({ type: "compaction_trigger" });
		// Conversation turns survive translation — user prompts, assistant prose, reasoning, and the tool pair.
		expect(inputText).toContain("first user request");
		expect(inputText).toContain("assistant visible answer");
		expect(inputText).toContain("second user request");
		expect(input.some(item => item.type === "reasoning")).toBe(true);
		expect(input.some(item => item.type === "function_call" && item.name === "read")).toBe(true);
		expect(input.some(item => item.type === "function_call_output")).toBe(true);
		expect(
			input.some(
				item =>
					(item.type === "message" || item.type === "function_call" || item.type === "custom_tool_call") &&
					Object.hasOwn(item, "status"),
			),
		).toBe(false);
		// Reasoning effort is sent like a normal turn (gpt-5 is a reasoning model).
		expect(requestBody?.reasoning).toMatchObject({ effort: "high", summary: "auto" });
		const remote = getCompactionV2PreserveData(result.preserveData);
		expect(remote?.usedTokens).toBe(55);
		expect(remote?.replacementHistory.at(-1)).toEqual(compactionItem);
		expect(result.summary).toBe(
			"Remote compaction preserved provider-native history for this session. Compaction processed 55 input tokens.",
		);
		expect(completeSpy).not.toHaveBeenCalled();
	});

	test("rewrites an oversized trailing tool output before V2 streaming compaction", async () => {
		const preparation = makePreparation();
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: true };
		preparation.messagesToSummarize = [
			{ role: "user", content: "inspect the large file", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call_read_large|fc_read_large", name: "read", arguments: { path: "/tmp/x" } },
				],
				timestamp: 2,
				provider: "openai",
				model: "gpt-5",
				api: "openai-responses",
				usage: ZERO_USAGE,
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "call_read_large|fc_read_large",
				toolName: "read",
				content: [{ type: "text", text: "large output".repeat(10_000) }],
				isError: false,
				timestamp: 3,
			},
		];
		preparation.recentMessages = [];
		const model = makeOpenAiModel({
			contextWindow: 20_000,
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		let requestInput: Array<Record<string, unknown>> = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			const body: unknown = JSON.parse(String(init?.body));
			if (!isRecord(body) || !Array.isArray(body.input) || !body.input.every(isRecord)) {
				throw new Error("expected V2 compaction input");
			}
			requestInput = body.input;
			return sseResponse([
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "compaction", encrypted_content: "enc_trimmed" },
				},
				{
					type: "response.completed",
					response: { usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102 } },
				},
			]);
		};

		await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock });

		expect(requestInput.some(item => item.type === "function_call" && item.call_id === "call_read_large")).toBe(true);
		expect(requestInput.find(item => item.type === "function_call_output")?.output).toBe(
			CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE,
		);
		expect(requestInput.at(-1)).toEqual({ type: "compaction_trigger" });
	});

	test("re-expands a prior V2 compaction's originals when no candidate can reuse the replay", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("re-expanded local summary"));
		const compactionItem = { type: "compaction", encrypted_content: "enc_v2" };
		const v2Model = makeOpenAiModel({
			remoteCompaction: {
				enabled: true,
				v2StreamingEnabled: true,
				v2Endpoint: "https://compact.example/v1/responses",
			},
		});
		// Produce a real V2 preserve payload (opaque placeholder summary, provider "openai").
		const v2Preparation = makePreparation();
		v2Preparation.messagesToSummarize = [{ role: "user", content: "ORIGINAL ALPHA port 4242", timestamp: 1 }];
		v2Preparation.recentMessages = [{ role: "user", content: "turn after", timestamp: 2 }];
		v2Preparation.settings = { ...v2Preparation.settings, remoteStreamingV2Enabled: true };
		const v2Result = await compact(v2Preparation, v2Model, "k", undefined, undefined, {
			fetch: async () =>
				sseResponse([
					{ type: "response.output_item.done", output_index: 0, item: compactionItem },
					{
						type: "response.completed",
						response: { usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 } },
					},
				]),
		});
		// V2 success persists only the opaque placeholder — no second local summarization round.
		expect(v2Result.summary).toContain("Remote compaction preserved provider-native history");

		// Session branch after that V2 compaction: originals + compaction boundary + new turns.
		const ts = (n: number) => new Date(n).toISOString();
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: ts(1),
				message: { role: "user", content: "ORIGINAL ALPHA port 4242", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "m1",
				timestamp: ts(2),
				summary: v2Result.summary,
				firstKeptEntryId: "m1",
				tokensBefore: 100_000,
				preserveData: v2Result.preserveData,
			},
			{
				type: "message",
				id: "m2",
				parentId: "c1",
				timestamp: ts(3),
				message: { role: "user", content: "second turn", timestamp: 3 },
			},
			{
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: ts(4),
				message: { role: "user", content: "third turn", timestamp: 4 },
			},
		];
		const baseSettings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };

		// Remote disabled → the V2 replay is unusable → re-expand the pre-V2 original.
		const reexpanded = prepareCompaction(entries, { ...baseSettings, remoteEnabled: false }, v2Model);
		expect(reexpanded).toBeDefined();
		const reexpandedText = JSON.stringify(reexpanded?.messagesToSummarize ?? []);
		expect(reexpandedText).toContain("ORIGINAL ALPHA port 4242");

		// Remote + V2 still enabled, same provider → reuse the replay, don't re-summarize originals.
		const reused = prepareCompaction(entries, { ...baseSettings, remoteStreamingV2Enabled: true }, v2Model);
		expect(reused).toBeDefined();
		const reusedText = JSON.stringify(reused?.messagesToSummarize ?? []);
		expect(reusedText).not.toContain("ORIGINAL ALPHA port 4242");
	});

	test("re-expands a stranded remote compaction when the active model cannot replay it (#6343)", () => {
		const ts = (n: number) => new Date(n).toISOString();
		const anthropicActive = buildModel({
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		const openaiSmol = makeOpenAiModel({ id: "gpt-5-mini", name: "GPT-5 mini" });
		// Prior OpenAI remote compaction: opaque placeholder summary, provider-native
		// replay stored under preserveData tagged "openai".
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: ts(1),
				message: { role: "user", content: "ORIGINAL ALPHA port 4242", timestamp: 1 },
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "m1",
				timestamp: ts(2),
				summary: "Remote compaction preserved provider-native history for this session.",
				firstKeptEntryId: "m1",
				tokensBefore: 100_000,
				preserveData: {
					openaiRemoteCompaction: {
						provider: "openai",
						replacementHistory: [{ type: "message", role: "user", content: "opaque native replay" }],
						compactionItem: { type: "compaction", encrypted_content: "enc_v1" },
					},
				},
			},
			{
				type: "message",
				id: "m2",
				parentId: "c1",
				timestamp: ts(3),
				message: { role: "user", content: "second turn", timestamp: 3 },
			},
			{
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: ts(4),
				message: { role: "user", content: "third turn", timestamp: 4 },
			},
		];
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 };
		// Reuse is judged by the ACTIVE model, not the candidate set. The active
		// anthropic model's encoder drops the OpenAI replay payload, so the stranded
		// originals are re-expanded into a portable local summary — even though the
		// OpenAI smol role could still replay the blob.
		const foreignActive = prepareCompaction(entries, settings, anthropicActive);
		expect(foreignActive).toBeDefined();
		expect(JSON.stringify(foreignActive?.messagesToSummarize ?? [])).toContain("ORIGINAL ALPHA port 4242");
		// The same-provider OpenAI model can replay the payload, so the boundary is
		// kept and the originals are not re-summarized.
		const sameProviderActive = prepareCompaction(entries, settings, openaiSmol);
		expect(sameProviderActive).toBeDefined();
		expect(JSON.stringify(sameProviderActive?.messagesToSummarize ?? [])).not.toContain("ORIGINAL ALPHA port 4242");
	});

	test("retains the V2 non-auth failure when the V1 fallback fails authentication", async () => {
		const preparation = makePreparation();
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: true };
		const model = makeOpenAiModel({
			remoteCompaction: { enabled: true, v2StreamingEnabled: true },
		});
		const requestedUrls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			requestedUrls.push(url);
			return url.endsWith("/responses/compact")
				? new Response("authentication failed", { status: 401, statusText: "Unauthorized" })
				: new Response("V2 transport failed", { status: 400, statusText: "Bad Request" });
		};

		const error = await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock }).catch(
			cause => cause,
		);

		expect(requestedUrls.map(url => new URL(url).pathname)).toEqual(["/v1/responses", "/v1/responses/compact"]);
		expect(error).toBeInstanceOf(NativeCompactionError);
		expect(error).toMatchObject({ cause: { status: 400 } });
		expect(AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)).toBe(false);
	});

	test("keeps native compaction auth-classified when every attempted protocol fails authentication", async () => {
		const preparation = makePreparation();
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: true };
		const model = makeOpenAiModel({
			remoteCompaction: { enabled: true, v2StreamingEnabled: true },
		});
		const requestedUrls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			requestedUrls.push(String(input));
			return new Response("authentication failed", { status: 401, statusText: "Unauthorized" });
		};

		const error = await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock }).catch(
			cause => cause,
		);

		expect(requestedUrls.map(url => new URL(url).pathname)).toEqual(["/v1/responses", "/v1/responses/compact"]);
		expect(error).toBeInstanceOf(NativeCompactionError);
		expect(error).toMatchObject({ cause: { status: 401 } });
		expect(AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)).toBe(true);
	});

	test("V2 native failure falls back to V1 without generic summarization", async () => {
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local summary"));
		const preparation = makePreparation();
		preparation.settings = { ...preparation.settings, remoteStreamingV2Enabled: true };
		const model = makeOpenAiModel({
			remoteCompaction: { enabled: true, v2StreamingEnabled: true },
		});
		const requestedUrls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.endsWith("/responses/compact")) {
				return Response.json({ output: [{ type: "compaction", encrypted_content: "enc-v1" }] });
			}
			return new Response("V2 unavailable", { status: 502, statusText: "Bad Gateway" });
		};

		const result = await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock });

		expect(requestedUrls.some(url => url.endsWith("/responses"))).toBe(true);
		expect(requestedUrls.some(url => url.endsWith("/responses/compact"))).toBe(true);
		expect(result.shortSummary).toBe("Remote compaction");
		expect(completeSpy).not.toHaveBeenCalled();
	});

	test("user abort during the remote compact request rejects without falling back to local summarization", async () => {
		// Contract: Esc is a cancellation, not a remote failure. Before the fix
		// the AbortError was swallowed by the fallback catch and compaction kept
		// running local summarization on an already-aborted signal.
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local summary"));
		const controller = new AbortController();
		const fetchMock: FetchImpl = (_input, init) => {
			const signal = init?.signal as AbortSignal | undefined;
			const { promise, reject } = Promise.withResolvers<Response>();
			const fail = () =>
				reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
			if (signal?.aborted) fail();
			else signal?.addEventListener("abort", fail);
			// Esc lands while the compact POST is in flight.
			queueMicrotask(() => controller.abort());
			return promise;
		};

		await expect(
			compact(makePreparation(), makeOpenAiModel(), "test-key", undefined, controller.signal, {
				fetch: fetchMock,
			}),
		).rejects.toThrow();
		expect(completeSpy).not.toHaveBeenCalled();
	});

	test("uses configured chat completions endpoints for openai-completions remote compaction", async () => {
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local fallback"));
		const preparation = makePreparation();
		preparation.settings = {
			...preparation.settings,
			remoteEndpoint: "http://127.0.0.1:8001/v1/chat/completions",
			remoteStreamingV2Enabled: false,
		};
		const model = buildModel({
			id: "catalog-selection-id",
			name: "Qwopus 3.6 35B-A3B Coder",
			requestModelId: "provider-wire-id",
			api: "openai-completions",
			provider: "local-llama",
			baseUrl: "http://127.0.0.1:8001/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 4096,
		});
		const requestBodies: unknown[] = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			if (typeof init?.body !== "string") throw new Error("missing remote compaction request body");
			requestBodies.push(JSON.parse(init.body) as unknown);
			expect(new Headers(init.headers).get("authorization")).toBe("Bearer local-key");
			const summary = requestBodies.length === 1 ? "remote history summary" : "remote short summary";
			return new Response(JSON.stringify({ choices: [{ message: { content: summary } }] }), {
				headers: { "content-type": "application/json" },
			});
		};

		const result = await compact(preparation, model, "local-key", undefined, undefined, {
			fetch: fetchMock,
		});

		expect(result.summary).toContain("remote history summary");
		expect(result.shortSummary).toBe("remote short summary");
		expect(completeSpy).not.toHaveBeenCalled();
		expect(requestBodies).toHaveLength(2);
		expect(requestBodies[0]).toMatchObject({
			model: "provider-wire-id",
			messages: [{ role: "system" }, { role: "user", content: expect.stringContaining("long history") }],
			stream: false,
		});
	});

	test("uses an explicit remote endpoint after provider-native compaction fails", async () => {
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local fallback"));
		const preparation = makePreparation();
		preparation.settings = {
			...preparation.settings,
			remoteEndpoint: "http://summary.test/v1/chat/completions",
			remoteStreamingV2Enabled: true,
		};
		const model = makeOpenAiModel({
			remoteCompaction: { enabled: true, v2StreamingEnabled: true },
		});
		const requestedUrls: string[] = [];
		const fetchMock: FetchImpl = async input => {
			const url = String(input);
			requestedUrls.push(url);
			if (url === preparation.settings.remoteEndpoint) {
				const summary =
					requestedUrls.filter(requested => requested === url).length === 1
						? "configured remote history summary"
						: "configured remote short summary";
				return Response.json({ choices: [{ message: { content: summary } }] });
			}
			return new Response("native compaction unavailable", { status: 400, statusText: "Bad Request" });
		};

		const result = await compact(preparation, model, "test-key", undefined, undefined, { fetch: fetchMock });

		expect(requestedUrls.map(url => new URL(url).pathname)).toEqual([
			"/v1/responses",
			"/v1/responses/compact",
			"/v1/chat/completions",
			"/v1/chat/completions",
		]);
		expect(result.summary).toContain("configured remote history summary");
		expect(result.shortSummary).toBe("configured remote short summary");
		expect(completeSpy).not.toHaveBeenCalled();
	});

	test("native compaction server failure rejects without generic summarization", async () => {
		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(localSummaryMessage("local summary"));
		const fetchMock: FetchImpl = async () =>
			new Response("nope", { status: 500, statusText: "Internal Server Error" });

		await expect(
			compact(makePreparation(), makeOpenAiModel(), "test-key", undefined, undefined, {
				fetch: fetchMock,
			}),
		).rejects.toThrow("Remote compaction failed");
		expect(completeSpy).not.toHaveBeenCalled();
	});
});
