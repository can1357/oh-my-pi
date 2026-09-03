import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	buildTransformedCodexRequestBody,
	convertCodexResponsesMessages,
	convertOpenAICodexResponsesTools,
	normalizeCodexToolChoice,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import {
	buildParams,
	convertTools,
	mapOpenAIResponsesToolChoiceForTools,
} from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { ResponseStreamEvent } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import {
	appendResponsesToolResultMessages,
	buildResponsesInput,
	convertResponsesAssistantMessage,
	processResponsesStream,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Context, Model, ModelSpec, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { sanitizeOpenAIResponsesHistoryItemsForReplay } from "@oh-my-pi/pi-ai/utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function model<TApi extends "openai-responses" | "openai-codex-responses">(
	api: TApi,
	id = "gpt-5.4",
	supportsComputerUse?: boolean,
): Model<TApi> {
	return buildModel({
		id,
		name: id,
		api,
		provider: api === "openai-responses" ? "openai" : "openai-codex",
		baseUrl: api === "openai-responses" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
		...(supportsComputerUse !== undefined ? { supportsComputerUse } : {}),
	} as ModelSpec<TApi>);
}

const computerTool: Tool = {
	name: "computer",
	description: "Control the host desktop",
	parameters: type({}),
	native: { type: "computer" },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.4",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

async function* events(items: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const item of items) yield item as ResponseStreamEvent;
}

describe("OpenAI GA computer contract", () => {
	test("gates models and emits the exact native request tool and forced choice", () => {
		const supported = model("openai-responses");
		const unsupported = model("openai-responses", "gpt-5.3");
		expect(supported.supportsComputerUse).toBe(true);
		expect(unsupported.supportsComputerUse).toBe(false);
		expect(convertTools([computerTool], true, supported)).toEqual([{ type: "computer" }]);
		expect(convertTools([computerTool], true, unsupported)).toMatchObject([{ type: "function", name: "computer" }]);
		expect(mapOpenAIResponsesToolChoiceForTools({ type: "computer" }, [computerTool], supported)).toEqual({
			type: "computer",
		});
		const functionOnlyTool: Tool = { ...computerTool, name: "inspect", native: undefined };
		expect(mapOpenAIResponsesToolChoiceForTools({ type: "computer" }, [functionOnlyTool], supported)).toBeUndefined();
		const { params } = buildParams(
			supported,
			{ messages: [{ role: "user", content: "inspect", timestamp: 1 }], tools: [computerTool] },
			{ toolChoice: { type: "computer" }, include: ["computer_call_output.output.image_url"] },
			undefined,
		);
		expect(JSON.parse(JSON.stringify(params))).toMatchObject({
			tools: [{ type: "computer" }],
			tool_choice: { type: "computer" },
			include: expect.arrayContaining(["computer_call_output.output.image_url"]),
		});
		expect(JSON.stringify(params)).not.toContain("display_width");
		expect(JSON.stringify(params)).not.toContain("display_height");
	});

	test("reconciles a queued computer choice after direct and proxy model switches", () => {
		const direct = model("openai-responses");
		const proxy = buildModel({
			...direct,
			baseUrl: "https://proxy.example.com/v1",
			compat: direct.compatConfig,
		} as ModelSpec<"openai-responses">);
		const context: Context = {
			messages: [{ role: "user", content: "inspect", timestamp: 1 }],
			tools: [computerTool],
		};

		expect(direct.supportsComputerUse).toBe(true);
		expect(proxy.supportsComputerUse).toBe(false);
		const directRequest = buildParams(
			direct,
			context,
			{ toolChoice: { type: "function", name: "computer" } },
			undefined,
		);
		expect(directRequest.params.tools).toEqual([{ type: "computer" }]);
		expect(directRequest.params.tool_choice).toEqual({ type: "computer" });

		const proxyRequest = buildParams(proxy, context, { toolChoice: { type: "computer" } }, undefined);
		expect(proxyRequest.params.tools).toMatchObject([{ type: "function", name: "computer" }]);
		expect(proxyRequest.params.tool_choice).toEqual({ type: "function", name: "computer" });
	});

	test("serializes the computer tool as a named function tool for unsupported models", () => {
		const unsupported = model("openai-responses", "gpt-5.3");
		const tools = convertTools([computerTool], true, unsupported);
		expect(tools).toHaveLength(1);
		const serialized = JSON.parse(JSON.stringify(tools[0])) as Record<string, unknown>;
		expect(serialized.type).toBe("function");
		expect(serialized.name).toBe("computer");
		expect(serialized.description).toBe("Control the host desktop");
		expect(serialized.parameters).toMatchObject({ type: "object" });
		expect(JSON.stringify(tools)).not.toContain('{"type":"computer"}');
		// Forcing the fallback uses a plain named function choice.
		expect(
			mapOpenAIResponsesToolChoiceForTools({ type: "function", name: "computer" }, [computerTool], unsupported),
		).toEqual({ type: "function", name: "computer" });
		// A queued native choice is reconciled to the emitted function fallback.
		expect(mapOpenAIResponsesToolChoiceForTools({ type: "computer" }, [computerTool], unsupported)).toEqual({
			type: "function",
			name: "computer",
		});

		const codexUnsupported = model("openai-codex-responses", "gpt-5.3");
		expect(codexUnsupported.supportsComputerUse).not.toBe(true);
		const codexTools = convertOpenAICodexResponsesTools([computerTool], codexUnsupported);
		expect(codexTools).toHaveLength(1);
		expect(codexTools[0]).toMatchObject({ type: "function", name: "computer" });
		expect(
			normalizeCodexToolChoice({ type: "function", name: "computer" }, [computerTool], codexUnsupported),
		).toEqual({ type: "function", name: "computer" });
		expect(normalizeCodexToolChoice({ type: "computer" }, [computerTool], codexUnsupported)).toEqual({
			type: "function",
			name: "computer",
		});
	});

	test("uses the function fallback for every tested subscription model in regular and Lite requests", async () => {
		const otherTool: Tool = { name: "read", description: "read", parameters: type({ path: "string" }) };
		for (const id of ["gpt-5.3-codex-spark", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]) {
			const subscription = model("openai-codex-responses", id);
			const context: Context = {
				messages: [{ role: "user", content: "capture the screen", timestamp: 1 }],
				tools: [computerTool, otherTool],
			};
			expect(subscription.supportsComputerUse).toBe(false);

			const regular = await buildTransformedCodexRequestBody(subscription, context, {
				toolChoice: { type: "computer" },
				responsesLite: false,
			});
			expect(regular.tools).toMatchObject([
				{ type: "function", name: "computer" },
				{ type: "function", name: "read" },
			]);
			expect(regular.tool_choice).toEqual({ type: "function", name: "computer" });

			const lite = await buildTransformedCodexRequestBody(subscription, context, {
				toolChoice: { type: "computer" },
				responsesLite: true,
			});
			expect(lite.tools).toBeUndefined();
			expect(lite.input?.[0]).toMatchObject({
				type: "additional_tools",
				tools: [{ type: "function", name: "computer" }],
			});
			expect(lite.tool_choice).toBe("required");
		}
	});

	test("preserves an explicit future Codex native opt-in through regular and Lite requests", async () => {
		const optedIn = model("openai-codex-responses", "gpt-5.6-terra", true);
		const context: Context = {
			messages: [{ role: "user", content: "capture", timestamp: 1 }],
			tools: [computerTool],
		};
		expect(convertOpenAICodexResponsesTools([computerTool], optedIn)).toEqual([{ type: "computer" }]);
		expect(normalizeCodexToolChoice({ type: "computer" }, [computerTool], optedIn)).toEqual({ type: "computer" });
		expect(normalizeCodexToolChoice({ type: "function", name: "computer" }, [computerTool], optedIn)).toEqual({
			type: "computer",
		});

		const regular = await buildTransformedCodexRequestBody(optedIn, context, {
			toolChoice: { type: "function", name: "computer" },
			responsesLite: false,
		});
		expect(regular.tools).toEqual([{ type: "computer" }]);
		expect(regular.tool_choice).toEqual({ type: "computer" });

		const lite = await buildTransformedCodexRequestBody(optedIn, context, {
			toolChoice: { type: "function", name: "computer" },
			responsesLite: true,
		});
		expect(lite.tools).toBeUndefined();
		expect(lite.input?.[0]).toEqual({ type: "additional_tools", role: "developer", tools: [{ type: "computer" }] });
		expect(lite.tool_choice).toBe("required");
	});
	test("pairs in-memory computer results for an explicit Codex native opt-in", () => {
		const optedIn = model("openai-codex-responses", "gpt-5.6-terra", true);
		const call = assistant([
			{
				type: "toolCall",
				id: "call_native_codex|item_native_codex",
				name: "computer",
				arguments: {},
				providerMetadata: {
					type: "computer",
					providerItemId: "item_native_codex",
					actions: [{ type: "screenshot" }],
					pendingSafetyChecks: [],
				},
			},
		]);
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_native_codex|item_native_codex",
			toolName: "computer",
			content: [{ type: "image", data: "cG5n", mimeType: "image/png", detail: "original" }],
			isError: false,
			timestamp: 2,
			providerMetadata: {
				type: "computer",
				screenshot: { type: "computer_screenshot", image_url: "data:image/png;base64,cG5n" },
				acknowledgedSafetyChecks: [],
			},
		};

		const replay = convertCodexResponsesMessages(optedIn, { messages: [call, result] });
		expect(replay).toContainEqual(expect.objectContaining({ type: "computer_call", call_id: "call_native_codex" }));
		expect(replay).toContainEqual(
			expect.objectContaining({ type: "computer_call_output", call_id: "call_native_codex" }),
		);
		expect(replay.some(item => item.type === "function_call_output")).toBe(false);
	});
	test("parses batched streamed actions, stable item id, and safety checks", async () => {
		const output = assistant([]);
		const emitted: unknown[] = [];
		const stream = { push: (event: unknown) => emitted.push(event), end: () => {} } as never;
		const item = {
			type: "computer_call",
			id: "item_computer_123",
			call_id: "call_computer_123",
			actions: [
				{ type: "move", x: 10, y: 20 },
				{ type: "click", button: "left", x: 10, y: 20 },
				{ type: "keypress", keys: ["CTRL", "L"] },
			],
			pending_safety_checks: [{ id: "safe_1", code: "confirm", message: "Confirm navigation" }],
			status: "completed",
		};
		await processResponsesStream(
			events([
				{ type: "response.output_item.added", output_index: 0, item },
				{ type: "response.output_item.done", output_index: 0, item },
			]),
			output,
			stream,
			model("openai-responses"),
		);
		const call = output.content[0];
		expect(call?.type).toBe("toolCall");
		if (call?.type !== "toolCall") throw new Error("expected computer tool call");
		expect(call.id).toBe("call_computer_123|item_computer_123");
		expect(JSON.stringify(call.providerMetadata)).toBe(
			JSON.stringify({
				type: "computer",
				providerItemId: "item_computer_123",
				actions: item.actions,
				pendingSafetyChecks: item.pending_safety_checks,
			}),
		);
		expect(emitted).toContainEqual(expect.objectContaining({ type: "toolcall_end" }));
	});

	test("promotes a completed computer call on max-output truncation to tool use", async () => {
		const output = assistant([]);
		const item = {
			type: "computer_call",
			id: "item_truncated_computer",
			call_id: "call_truncated_computer",
			actions: [{ type: "screenshot" }],
			pending_safety_checks: [],
			status: "completed",
		};
		await processResponsesStream(
			events([
				{ type: "response.output_item.added", output_index: 0, item },
				{ type: "response.output_item.done", output_index: 0, item },
				{
					type: "response.incomplete",
					response: {
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			]),
			output,
			{ push: () => {}, end: () => {} } as never,
			model("openai-responses"),
		);
		expect(output.stopReason).toBe("toolUse");
	});

	test("replays image_url and file_id screenshots losslessly with acknowledgements", () => {
		for (const screenshot of [
			{ type: "computer_screenshot" as const, image_url: "data:image/png;base64,AAEC" },
			{ type: "computer_screenshot" as const, file_id: "file_screen_123" },
		]) {
			const known = new Set<string>();
			const computer = new Set<string>();
			const calls = convertResponsesAssistantMessage(
				assistant([
					{
						type: "toolCall",
						id: "call_123|item_123",
						name: "computer",
						arguments: {},
						providerMetadata: {
							type: "computer",
							providerItemId: "item_123",
							actions: [{ type: "screenshot" }],
							pendingSafetyChecks: [{ id: "safe_1" }],
						},
					},
				]),
				model("openai-responses"),
				0,
				known,
				true,
				undefined,
				false,
				true,
				undefined,
				computer,
			);
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "call_123|item_123",
				toolName: "computer",
				content: [],
				isError: false,
				timestamp: 2,
				providerMetadata: {
					type: "computer",
					screenshot,
					acknowledgedSafetyChecks: [{ id: "safe_1" }],
				},
			};
			appendResponsesToolResultMessages(
				calls,
				result,
				model("openai-responses"),
				false,
				true,
				known,
				undefined,
				true,
				computer,
			);
			expect(calls).toEqual([
				expect.objectContaining({ type: "computer_call", id: "item_123", call_id: "call_123" }),
				{
					type: "computer_call_output",
					call_id: "call_123",
					output: screenshot,
					acknowledged_safety_checks: [{ id: "safe_1" }],
				},
			]);
			const rawCalls = calls as unknown as Array<Record<string, unknown>>;
			const sanitized = sanitizeOpenAIResponsesHistoryItemsForReplay(rawCalls);
			expect(sanitized[0]).toMatchObject({ id: "item_123", type: "computer_call" });
			expect(sanitized[1]).toMatchObject({ output: screenshot });
		}
	});

	test("clears reasoning candidates at every client continuation boundary", () => {
		const boundaries: Array<[string, Record<string, unknown>]> = [
			["input message", { role: "user", content: "next turn" }],
			["input text", { type: "input_text", text: "next turn" }],
			["input image", { type: "input_image", file_id: "file_input_image" }],
			["input file", { type: "input_file", file_id: "file_input_file" }],
			["input audio", { type: "input_audio", input_audio: { data: "base64", format: "wav" } }],
			["function output", { type: "function_call_output", call_id: "call_function", output: "done" }],
			["custom output", { type: "custom_tool_call_output", call_id: "call_custom", output: "done" }],
			[
				"computer output",
				{
					type: "computer_call_output",
					call_id: "call_computer_output",
					output: { type: "computer_screenshot", file_id: "file_computer_output" },
				},
			],
			["local shell output", { type: "local_shell_call_output", id: "call_local_shell", output: "done" }],
			["shell output", { type: "shell_call_output", call_id: "call_shell", output: [], status: "completed" }],
			["apply patch output", { type: "apply_patch_call_output", call_id: "call_patch", status: "completed" }],
			["MCP approval", { type: "mcp_approval_response", approval_request_id: "approval_1", approve: true }],
			["client tool search output", { type: "tool_search_output", execution: "client", tools: [] }],
			["additional tools", { type: "additional_tools", role: "developer", tools: [] }],
			["compaction", { type: "compaction", encrypted_content: "compacted-context" }],
			["legacy compaction summary", { type: "compaction_summary", summary: "compacted context" }],
			["compaction trigger", { type: "compaction_trigger" }],
			["item reference", { type: "item_reference", id: "item_reference_1" }],
		];

		for (const [boundary, item] of boundaries) {
			const sanitized = sanitizeOpenAIResponsesHistoryItemsForReplay([
				{
					type: "reasoning",
					id: "rs_unrelated_turn",
					summary: [],
					encrypted_content: "unrelated-reasoning",
				},
				item,
				{
					type: "reasoning",
					id: "rs_computer_turn",
					summary: [],
					encrypted_content: "computer-reasoning",
				},
				{
					type: "message",
					id: "msg_computer_turn",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "I will inspect the screen.", annotations: [] }],
				},
				{
					type: "tool_search_output",
					id: "tool_search_server_1",
					execution: "server",
					status: "completed",
					tools: [],
				},
				{
					type: "computer_call",
					id: "cu_computer_turn",
					call_id: "call_computer_turn",
					action: { type: "screenshot" },
					pending_safety_checks: [],
					status: "completed",
				},
				{
					type: "computer_call_output",
					call_id: "call_computer_turn",
					output: { type: "computer_screenshot", file_id: "file_computer_turn" },
				},
			]);
			const reasoningIds = sanitized
				.filter(replayItem => replayItem.type === "reasoning")
				.map(replayItem => (replayItem as { id?: string }).id);
			expect({ boundary, reasoningIds }).toEqual({
				boundary,
				reasoningIds: [undefined, "rs_computer_turn"],
			});
		}
	});

	test("strips reasoning identity when an orphan native computer call is demoted", () => {
		const supported = model("openai-responses");
		const previous = {
			...assistant([]),
			providerPayload: {
				type: "openaiResponsesHistory" as const,
				provider: "openai" as const,
				dt: true,
				items: [
					{
						type: "reasoning",
						id: "rs_orphan_computer",
						summary: [],
						encrypted_content: "orphan-computer-reasoning",
					},
					{
						type: "computer_call",
						id: "cu_orphan_computer",
						call_id: "call_orphan_computer",
						actions: [{ type: "screenshot" }],
						pending_safety_checks: [],
						status: "completed",
					},
				],
			},
		};
		const replay = buildResponsesInput({
			model: supported,
			context: { messages: [previous] },
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});
		expect(replay.some(item => item.type === "computer_call" || item.type === "computer_call_output")).toBe(false);
		expect(JSON.stringify(replay)).toContain("interrupted before a screenshot was recorded");
		expect(JSON.stringify(replay)).not.toContain("rs_orphan_computer");
	});

	test("turns a failed computer call without a screenshot into valid recovery history", () => {
		const context = {
			messages: [
				assistant([
					{
						type: "toolCall" as const,
						id: "call_failed|item_failed",
						name: "computer",
						arguments: {},
						providerMetadata: {
							type: "computer" as const,
							providerItemId: "item_failed",
							actions: [{ type: "click" as const, button: "left" as const, x: 1, y: 2 }],
							pendingSafetyChecks: [],
						},
					},
				]),
				{
					role: "toolResult" as const,
					toolCallId: "call_failed|item_failed",
					toolName: "computer",
					content: [{ type: "text" as const, text: "screen capture failed" }],
					isError: true,
					timestamp: 2,
				},
			],
		};
		const input = buildResponsesInput({
			model: model("openai-responses"),
			context,
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			repairOrphanOutputs: true,
		});
		expect(input.some(item => item.type === "computer_call" || item.type === "computer_call_output")).toBe(false);
		expect(JSON.stringify(input)).toContain("before a screenshot was recorded");
	});

	test("demotes native computer history when replaying to an unsupported model", () => {
		const unsupported = model("openai-responses", "gpt-5.3");
		const reasoning = {
			type: "reasoning",
			id: "rs_native_1",
			summary: [],
			encrypted_content: "native-computer-reasoning",
		};
		const call = {
			type: "computer_call",
			id: "item_native_1",
			call_id: "call_native_1",
			actions: [{ type: "screenshot" }],
			pending_safety_checks: [{ id: "safe_native_1" }],
			status: "completed",
		};
		const output = {
			type: "computer_call_output",
			call_id: "call_native_1",
			output: { type: "computer_screenshot", file_id: "file_native_1" },
			acknowledged_safety_checks: [{ id: "safe_native_1" }],
		};
		const previous = {
			...assistant([]),
			model: unsupported.id,
			providerPayload: {
				type: "openaiResponsesHistory" as const,
				provider: "openai" as const,
				dt: true,
				items: [reasoning, call, output],
			},
		};
		const replay = buildResponsesInput({
			model: unsupported,
			context: { messages: [previous] },
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
		});
		expect(replay.some(item => item.type === "computer_call" || item.type === "computer_call_output")).toBe(false);
		expect(JSON.stringify(replay)).toContain("call_native_1");
		expect(JSON.stringify(replay)).toContain("file_native_1");
		expect(JSON.stringify(replay)).not.toContain("rs_native_1");
	});

	test("full native history replacement clears stale computer call pairing state", () => {
		const supported = model("openai-responses");
		const oldCall = {
			type: "computer_call",
			id: "item_old_computer",
			call_id: "call_old_computer",
			actions: [{ type: "screenshot" }],
			pending_safety_checks: [],
			status: "completed",
		};
		const oldAssistant = {
			...assistant([]),
			providerPayload: {
				type: "openaiResponsesHistory" as const,
				provider: "openai" as const,
				dt: true,
				items: [oldCall],
			},
		};
		const replacementAssistant = {
			...assistant([]),
			providerPayload: {
				type: "openaiResponsesHistory" as const,
				provider: "openai" as const,
				items: [
					{
						type: "function_call",
						id: "fc_new",
						call_id: "call_new",
						name: "inspect",
						arguments: "{}",
					},
				],
			},
		};
		const staleResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_old_computer|item_old_computer",
			toolName: "computer",
			content: [],
			isError: false,
			timestamp: 3,
			providerMetadata: {
				type: "computer",
				screenshot: { type: "computer_screenshot", file_id: "file_stale" },
				acknowledgedSafetyChecks: [],
			},
		};
		const replay = buildResponsesInput({
			model: supported,
			context: { messages: [oldAssistant, replacementAssistant, staleResult] },
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});
		expect(replay.some(item => item.type === "computer_call" || item.type === "computer_call_output")).toBe(false);
		expect(replay.some(item => item.type === "function_call" && item.call_id === "call_new")).toBe(true);
	});

	test("unrolls the native computer tool and forced choice for Codex", () => {
		const codex = model("openai-codex-responses");
		expect(convertOpenAICodexResponsesTools([computerTool], codex)).toMatchObject([
			{ type: "function", name: "computer", description: "Control the host desktop" },
		]);
		expect(normalizeCodexToolChoice({ type: "computer" }, [computerTool], codex)).toEqual({
			type: "function",
			name: "computer",
		});
		expect(normalizeCodexToolChoice({ type: "computer" }, [], codex)).toBeUndefined();
	});

	test("unrolls native computer response history for Codex replay", () => {
		const codex = model("openai-codex-responses");
		const previous = {
			...assistant([]),
			api: "openai-codex-responses" as const,
			provider: "openai-codex",
			model: codex.id,
			providerPayload: {
				type: "openaiResponsesHistory" as const,
				provider: "openai-codex",
				dt: true,
				items: [
					{
						type: "reasoning",
						id: "rs_codex_computer",
						summary: [],
						encrypted_content: "encrypted-codex-computer-reasoning",
					},
					{
						type: "computer_call",
						id: "item_codex_computer",
						call_id: "call_codex_computer",
						actions: [{ type: "screenshot" }],
						pending_safety_checks: [],
						status: "completed",
					},
					{
						type: "computer_call_output",
						call_id: "call_codex_computer",
						output: { type: "computer_screenshot", file_id: "file_codex_computer" },
						acknowledged_safety_checks: [],
					},
				],
			},
		};
		const replay = convertCodexResponsesMessages(codex, { messages: [previous] });
		const reasoning = replay.find(item => item.type === "reasoning") as { id?: string } | undefined;
		expect(reasoning?.id).toBeUndefined();
		expect(replay.some(item => item.type === "computer_call" || item.type === "computer_call_output")).toBe(false);
		const call = replay.find(item => item.type === "function_call" && item.call_id === "call_codex_computer");
		expect(call).toMatchObject({ type: "function_call", name: "computer" });
		if (call?.type !== "function_call") throw new Error("Expected unrolled computer function call");
		expect(JSON.parse(call.arguments)).toEqual({ actions: [{ type: "screenshot" }] });
		expect(replay.some(item => item.type === "function_call_output" && item.call_id === "call_codex_computer")).toBe(
			true,
		);
		expect(JSON.stringify(replay)).toContain("file_codex_computer");
	});

	test("retains Codex reasoning identity when computer demotion leaves native response IDs", () => {
		const codex = model("openai-codex-responses");
		const compacted = {
			role: "user" as const,
			content: "compacted history",
			providerPayload: {
				type: "openaiResponsesHistory" as const,
				provider: "openai-codex",
				items: [
					{
						type: "reasoning",
						id: "rs_codex_mixed",
						summary: [],
						encrypted_content: "encrypted-codex-mixed-reasoning",
					},
					{
						type: "message",
						id: "msg_codex_mixed",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Inspecting the screen." }],
					},
					{
						type: "function_call",
						id: "fc_codex_mixed",
						call_id: "call_codex_mixed_tool",
						name: "inspect",
						arguments: "{}",
						status: "completed",
					},
					{
						type: "computer_call",
						id: "item_codex_mixed_computer",
						call_id: "call_codex_mixed_computer",
						actions: [{ type: "screenshot" }],
						pending_safety_checks: [],
						status: "completed",
					},
					{
						type: "computer_call_output",
						call_id: "call_codex_mixed_computer",
						output: { type: "computer_screenshot", file_id: "file_codex_mixed_computer" },
						acknowledged_safety_checks: [],
					},
				],
			},
			timestamp: Date.now(),
		};

		const replay = convertCodexResponsesMessages(codex, { messages: [compacted] });
		expect(replay).toContainEqual(expect.objectContaining({ type: "reasoning", id: "rs_codex_mixed" }));
		expect(replay).toContainEqual(expect.objectContaining({ type: "message", id: "msg_codex_mixed" }));
		expect(replay).toContainEqual(expect.objectContaining({ type: "function_call", id: "fc_codex_mixed" }));
		expect(replay.some(item => item.type === "computer_call" || item.type === "computer_call_output")).toBe(false);
	});

	test("unrolls internal computer calls and screenshot results for Codex replay", () => {
		const codex = model("openai-codex-responses");
		const call = {
			...assistant([
				{
					type: "toolCall" as const,
					id: "call_internal_computer|item_internal_computer",
					name: "computer",
					arguments: {},
					providerMetadata: {
						type: "computer" as const,
						providerItemId: "item_internal_computer",
						actions: [{ type: "screenshot" as const }],
						pendingSafetyChecks: [],
					},
				},
			]),
			api: "openai-codex-responses" as const,
			provider: "openai-codex",
			model: codex.id,
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_internal_computer|item_internal_computer",
			toolName: "computer",
			content: [{ type: "image", data: "cG5n", mimeType: "image/png", detail: "original" }],
			isError: false,
			timestamp: 2,
			providerMetadata: {
				type: "computer",
				screenshot: { type: "computer_screenshot", image_url: "data:image/png;base64,cG5n" },
				acknowledgedSafetyChecks: [],
			},
		};
		const replay = convertCodexResponsesMessages(codex, { messages: [call, result] });
		expect(replay.some(item => item.type === "computer_call" || item.type === "computer_call_output")).toBe(false);
		const functionCall = replay.find(
			item => item.type === "function_call" && item.call_id === "call_internal_computer",
		);
		expect(functionCall).toMatchObject({ type: "function_call", name: "computer" });
		if (functionCall?.type !== "function_call") throw new Error("Expected unrolled computer function call");
		expect(JSON.parse(functionCall.arguments)).toEqual({ actions: [{ type: "screenshot" }] });
		expect(
			replay.some(item => item.type === "function_call_output" && item.call_id === "call_internal_computer"),
		).toBe(true);
		expect(JSON.stringify(replay)).toContain("data:image/png;base64,cG5n");
	});

	test("unrolls direct API computer history after switching to a subscription model", async () => {
		const current = model("openai-codex-responses", "gpt-5.6-terra");
		const call = assistant([
			{
				type: "toolCall",
				id: "call_direct_computer|item_direct_computer",
				name: "computer",
				arguments: {},
				providerMetadata: {
					type: "computer",
					providerItemId: "item_direct_computer",
					actions: [{ type: "screenshot" }],
					pendingSafetyChecks: [],
				},
			},
		]);
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_direct_computer|item_direct_computer",
			toolName: "computer",
			content: [{ type: "image", data: "cG5n", mimeType: "image/png", detail: "original" }],
			isError: false,
			timestamp: 2,
			providerMetadata: {
				type: "computer",
				screenshot: { type: "computer_screenshot", image_url: "data:image/png;base64,cG5n" },
				acknowledgedSafetyChecks: [],
			},
		};

		const replay = convertCodexResponsesMessages(current, { messages: [call, result] });
		expect(replay.some(item => item.type === "computer_call" || item.type === "computer_call_output")).toBe(false);
		expect(replay).toContainEqual(
			expect.objectContaining({ type: "function_call", name: "computer", call_id: "call_direct_computer" }),
		);
		expect(replay).toContainEqual(
			expect.objectContaining({ type: "function_call_output", call_id: "call_direct_computer" }),
		);

		const context: Context = {
			messages: [call, result, { role: "user", content: "continue", timestamp: 3 }],
			tools: [computerTool],
		};
		for (const responsesLite of [false, true]) {
			const body = await buildTransformedCodexRequestBody(current, context, {
				toolChoice: { type: "computer" },
				responsesLite,
			});
			const serialized = JSON.stringify(body);
			expect(serialized).not.toContain('"type":"computer_call"');
			expect(serialized).not.toContain('"type":"computer_call_output"');
			expect(serialized).toContain('"type":"function_call"');
			expect(serialized).toContain('"type":"function_call_output"');
			if (responsesLite) {
				expect(body.input?.[0]).toMatchObject({
					type: "additional_tools",
					tools: [{ type: "function", name: "computer" }],
				});
				expect(body.tool_choice).toBe("required");
			} else {
				expect(body.tools).toMatchObject([{ type: "function", name: "computer" }]);
				expect(body.tool_choice).toEqual({ type: "function", name: "computer" });
			}
		}
	});
});
