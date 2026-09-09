import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	buildTransformedCodexRequestBody,
	convertOpenAICodexResponsesTools as convertCodexTools,
	normalizeCodexToolChoice,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import {
	buildParams,
	convertTools,
	mapOpenAIResponsesToolChoiceForTools,
	supportsFreeformApplyPatch,
} from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { ResponseStreamEvent } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import {
	appendResponsesToolResultMessages,
	convertResponsesAssistantMessage,
	processResponsesStream,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Model, ModelSpec, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const GRAMMAR = [
	"// top-level comment",
	"",
	'start: "*** Begin Patch" LF  // trailing comment',
	"PATH: /https?:\\/\\/[^\\n]+/",
	'LITERAL: "//"',
	"",
].join("\n");
const COMPACT_GRAMMAR = 'start: "*** Begin Patch" LF\nPATH: /https?:\\/\\/[^\\n]+/\nLITERAL: "//"';

function makeModel(overrides: Partial<ModelSpec<"openai-responses">> = {}): Model<"openai-responses"> {
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
	} as ModelSpec<"openai-responses">);
}

function makeCodexModel(overrides: Partial<ModelSpec<"openai-codex-responses">> = {}): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
		...overrides,
	} as ModelSpec<"openai-codex-responses">);
}

const editTool: Tool = {
	name: "edit",
	customWireName: "apply_patch",
	description: "edit files",
	parameters: type({ input: "string" }),
	customFormat: { syntax: "lark", definition: GRAMMAR },
};

const plainTool: Tool = {
	name: "read_file",
	description: "read a file",
	parameters: type({ path: "string" }),
};

function hasCustomTool(tools: unknown): boolean {
	return (
		Array.isArray(tools) &&
		tools.some(tool => typeof tool === "object" && tool !== null && (tool as { type?: unknown }).type === "custom")
	);
}

const unionBranches = [
	{
		type: "object",
		properties: { type: { enum: ["insert"] }, text: { type: "string" } },
		required: ["type", "text"],
	},
	{
		type: "object",
		properties: { type: { enum: ["delete"] }, start: { type: "integer" } },
		required: ["type", "start"],
	},
];

function makeUnionTool(strict: boolean): Tool {
	return {
		name: "batch_update_doc",
		description: "batch update",
		strict,
		parameters: {
			type: "object",
			properties: {
				operations: {
					type: "array",
					items: {
						oneOf: unionBranches,
					},
				},
			},
			required: ["operations"],
		},
	} as unknown as Tool;
}

describe("supportsFreeformApplyPatch", () => {
	test("applyPatchToolType: freeform enables", () => {
		expect(supportsFreeformApplyPatch(makeModel({ applyPatchToolType: "freeform" }))).toBe(true);
	});

	test("applyPatchToolType: function disables", () => {
		expect(supportsFreeformApplyPatch(makeModel({ id: "gpt-4", applyPatchToolType: "function" }))).toBe(false);
	});

	test("flag is the sole signal — id/baseUrl are irrelevant", () => {
		expect(
			supportsFreeformApplyPatch(
				makeModel({ id: "gpt-4", baseUrl: "https://proxy.example/", applyPatchToolType: "freeform" }),
			),
		).toBe(true);
		expect(supportsFreeformApplyPatch(makeModel({ id: "gpt-4", baseUrl: "https://api.openai.com/v1" }))).toBe(false);
	});
});

describe("convertTools: freeform emission", () => {
	const freeformModel = makeModel({ applyPatchToolType: "freeform" });

	test("muse-code keeps the edit tool a function — api.meta.ai/v1 rejects custom tools", () => {
		// Verified 2026-09-05: POST /v1/responses with a `custom` tool 400s with
		// "`custom` tools are not supported on this endpoint" on muse-code; the
		// same model as a function tool returns 200. The catalog must not re-add
		// apply-patch-tool-type "freeform" for this provider.
		const museSpec = {
			id: "muse-spark-1.3-contributor",
			name: "Muse Spark 1.3 (C)",
			api: "openai-responses",
			baseUrl: "https://api.meta.ai/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 131_072,
		};
		const muse = buildModel({ ...museSpec, provider: "muse-code" } as ModelSpec<"openai-responses">);
		expect(supportsFreeformApplyPatch(muse)).toBe(false);
		const [out] = convertTools([editTool], false, muse) as unknown as Array<Record<string, unknown>>;
		expect(out.type).toBe("function");

		// Same model id on the direct Meta API key provider is also function.
		const meta = buildModel({ ...museSpec, provider: "meta" } as ModelSpec<"openai-responses">);
		expect(supportsFreeformApplyPatch(meta)).toBe(false);
		const [functionOut] = convertTools([editTool], false, meta) as unknown as Array<Record<string, unknown>>;
		expect(functionOut.type).toBe("function");
	});

	test("edit tool with customFormat becomes a custom grammar tool", () => {
		const [out] = convertTools([editTool], false, freeformModel) as unknown as Array<Record<string, unknown>>;
		expect(out.type).toBe("custom");
		expect(out.name).toBe("apply_patch"); // wire name from tool.customWireName
		expect(out.format).toEqual({ type: "grammar", syntax: "lark", definition: COMPACT_GRAMMAR });
	});

	test("regular tools remain function-type alongside a custom one", () => {
		const out = convertTools([editTool, plainTool], false, freeformModel) as unknown as Array<
			Record<string, unknown>
		>;
		expect(out[0].type).toBe("custom");
		expect(out[1].type).toBe("function");
		expect(out[1].name).toBe("read_file");
	});

	test("falls back to function tool when flag is absent", () => {
		const [out] = convertTools([editTool], false, makeModel({ id: "gpt-4" })) as unknown as Array<
			Record<string, unknown>
		>;
		expect(out.type).toBe("function");
		expect(out.name).toBe("edit");
	});

	test("applyPatchToolType=function explicitly disables", () => {
		const [out] = convertTools(
			[editTool],
			false,
			makeModel({ id: "gpt-4", applyPatchToolType: "function" }),
		) as unknown as Array<Record<string, unknown>>;
		expect(out.type).toBe("function");
	});

	test("rewrites oneOf to anyOf for non-strict Responses tool schemas", () => {
		const unionTool = makeUnionTool(false);

		const [out] = convertTools([unionTool], true, makeModel()) as unknown as Array<{
			parameters: { properties: { operations: { items: Record<string, unknown> } } };
			strict?: boolean;
		}>;

		const items = out.parameters.properties.operations.items;
		// Author-set `strict: false` MUST survive to the wire (#4336) — providers
		// distinguish it from an omitted flag when generating optional-arg values.
		expect(out.strict).toBe(false);
		expect(items.oneOf).toBeUndefined();
		expect(items.anyOf).toEqual(unionBranches);
	});

	test("rewrites oneOf to anyOf before strict schema enforcement", () => {
		const unionTool = makeUnionTool(true);

		const [out] = convertTools([unionTool], true, makeModel()) as unknown as Array<{
			parameters: { properties: { operations: { items: Record<string, unknown> } } };
			strict?: boolean;
		}>;

		const items = out.parameters.properties.operations.items;
		expect(out.strict).toBe(true);
		expect(items.oneOf).toBeUndefined();
		expect(items.anyOf).toMatchObject(unionBranches);
		expect((items.anyOf as Array<Record<string, unknown>>)[0]?.additionalProperties).toBe(false);
	});
});

describe("tool choice mapping: freeform emission", () => {
	const freeformModel = makeModel({ applyPatchToolType: "freeform" });

	test("forced internal edit choice targets custom wire name", () => {
		expect(mapOpenAIResponsesToolChoiceForTools({ type: "tool", name: "edit" }, [editTool], freeformModel)).toEqual({
			type: "custom",
			name: "apply_patch",
		});
	});

	test("regular forced choices remain function choices", () => {
		expect(
			mapOpenAIResponsesToolChoiceForTools({ type: "tool", name: "read_file" }, [plainTool], freeformModel),
		).toEqual({
			type: "function",
			name: "read_file",
		});
	});

	test("codex backend forced internal edit choice targets custom wire name", () => {
		expect(
			normalizeCodexToolChoice(
				{ type: "tool", name: "edit" },
				[editTool],
				makeCodexModel({ applyPatchToolType: "freeform" }),
			),
		).toEqual({
			type: "custom",
			name: "apply_patch",
		});
	});
});

describe("request params: freeform custom tools", () => {
	test("openai responses leaves parallel tool calls unset", () => {
		const { params } = buildParams(
			makeModel({ applyPatchToolType: "freeform" }),
			{ messages: [{ role: "user", content: "edit", timestamp: 0 }], tools: [editTool] },
			undefined,
			undefined,
		);

		expect(hasCustomTool(params.tools)).toBe(true);
		expect(params.parallel_tool_calls).toBeUndefined();
	});

	test("codex responses leaves parallel tool calls unset for custom tools", async () => {
		const params = await buildTransformedCodexRequestBody(
			makeCodexModel({ applyPatchToolType: "freeform" }),
			{ messages: [{ role: "user", content: "edit", timestamp: 0 }], tools: [editTool] },
			undefined,
		);

		expect(hasCustomTool(params.tools)).toBe(true);
		expect(params.parallel_tool_calls).toBeUndefined();
	});
});

describe("custom_tool_call stream receive", () => {
	async function* makeStream(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
		for (const e of events) yield e as ResponseStreamEvent;
	}

	test("strips streaming parse bookkeeping from function-call output blocks", async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
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
			stopReason: "stop",
		};
		const emitted: unknown[] = [];
		const stream = {
			push: (e: unknown) => emitted.push(e),
			end: () => {},
		} as never;
		const args = JSON.stringify({ command: "x".repeat(300) });

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "" },
				},
				{ type: "response.function_call_arguments.delta", delta: args },
				{ type: "response.function_call_arguments.done", arguments: args },
				{
					type: "response.output_item.done",
					item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: args },
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const block = output.content[0];
		expect(block?.type).toBe("toolCall");
		if (block?.type !== "toolCall") throw new Error("expected toolCall block");
		expect(block.arguments).toEqual({ command: "x".repeat(300) });
		expect((block as unknown as Record<string, unknown>).partialJson).toBeUndefined();
		expect((block as unknown as Record<string, unknown>).lastParseLen).toBeUndefined();
	});

	test("persists final args on the block when finalized via output_item.done without an args.done event", async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
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
			stopReason: "stop",
		};
		const stream = { push: () => {}, end: () => {} } as never;

		// Two small deltas: the second grows the buffer by far less than the
		// throttle's min-growth threshold, so parseStreamingJsonThrottled skips the
		// final re-parse and currentBlock.arguments is left at the first partial
		// parse. No function_call_arguments.done arrives, so output_item.done is the
		// sole finalization path and must still persist the full arguments.
		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" },
				},
				{ type: "response.function_call_arguments.delta", delta: '{"path":"' },
				{ type: "response.function_call_arguments.delta", delta: 'README.md"}' },
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: "read_file",
						arguments: '{"path":"README.md"}',
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const block = output.content[0];
		expect(block?.type).toBe("toolCall");
		if (block?.type !== "toolCall") throw new Error("expected toolCall block");
		expect(block.arguments).toEqual({ path: "README.md" });
		expect((block as unknown as Record<string, unknown>).partialJson).toBeUndefined();
		expect((block as unknown as Record<string, unknown>).lastParseLen).toBeUndefined();
	});

	test("aggregates delta events into a ToolCall with input arg", async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
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
			stopReason: "stop",
		};
		const emitted: unknown[] = [];
		const stream = {
			push: (e: unknown) => emitted.push(e),
			end: () => {},
		} as never;

		const events = [
			{
				type: "response.output_item.added",
				item: {
					type: "custom_tool_call",
					id: "ctc_1",
					call_id: "call_1",
					name: "apply_patch",
					input: "",
				},
			},
			{
				type: "response.custom_tool_call_input.delta",
				delta: "*** Begin Patch\n",
			},
			{
				type: "response.custom_tool_call_input.delta",
				delta: "*** End Patch\n",
			},
			{
				type: "response.custom_tool_call_input.done",
				input: "*** Begin Patch\n*** End Patch\n",
			},
			{
				type: "response.output_item.done",
				item: {
					type: "custom_tool_call",
					id: "ctc_1",
					call_id: "call_1",
					name: "apply_patch",
					input: "*** Begin Patch\n*** End Patch\n",
				},
			},
		];

		await processResponsesStream(makeStream(events), output, stream, makeModel());

		const block = output.content[0];
		expect(block?.type).toBe("toolCall");
		const tool = block as {
			type: "toolCall";
			name: string;
			arguments: Record<string, unknown>;
			customWireName?: string;
		};
		// Wire name passes through unchanged — the agent-loop dispatcher
		// matches against both `Tool.name` and `Tool.customWireName`.
		expect(tool.name).toBe("apply_patch");
		expect(tool.customWireName).toBe("apply_patch");
		expect(tool.arguments.input).toBe("*** Begin Patch\n*** End Patch\n");

		// toolcall_end event carries the final ToolCall
		const endEvent = emitted.find(
			(
				e,
			): e is {
				type: string;
				toolCall: { name: string; arguments: Record<string, unknown>; customWireName?: string };
			} => !!e && typeof e === "object" && (e as { type?: string }).type === "toolcall_end",
		);
		expect(endEvent?.toolCall.name).toBe("apply_patch");
		expect(endEvent?.toolCall.customWireName).toBe("apply_patch");
	});

	test("synthesizes a non-empty item id when custom output item id is absent", async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
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
			stopReason: "stop",
		};
		const emitted: unknown[] = [];
		const stream = {
			push: (e: unknown) => emitted.push(e),
			end: () => {},
		} as never;

		await processResponsesStream(
			makeStream([
				{
					type: "response.output_item.added",
					item: {
						type: "custom_tool_call",
						call_id: "call_missing_item",
						name: "apply_patch",
						input: "",
					},
				},
				{
					type: "response.output_item.done",
					item: {
						type: "custom_tool_call",
						call_id: "call_missing_item",
						name: "apply_patch",
						input: "*** Begin Patch\n*** End Patch\n",
					},
				},
			]),
			output,
			stream,
			makeModel(),
		);

		const block = output.content[0];
		expect(block?.type).toBe("toolCall");
		expect((block as { id: string }).id).toStartWith("call_missing_item|fc_");

		const endEvent = emitted.find(
			(e): e is { type: string; toolCall: { id: string } } =>
				!!e && typeof e === "object" && (e as { type?: string }).type === "toolcall_end",
		);
		expect(endEvent?.toolCall.id).toStartWith("call_missing_item|fc_");
	});
});

describe("codex-backend convertTools (chatgpt.com/backend-api)", () => {
	test("edit tool with customFormat becomes a custom grammar tool when flag is set", () => {
		const [out] = convertCodexTools([editTool], makeCodexModel({ applyPatchToolType: "freeform" }));
		expect(out.type).toBe("custom");
		expect(out.name).toBe("apply_patch");
		if (out.type !== "custom") throw new Error("Expected custom tool payload");
		expect(out.format).toEqual({ type: "grammar", syntax: "lark", definition: COMPACT_GRAMMAR });
	});

	test("wire shape matches direct-OpenAI convertTools (single serializer contract)", () => {
		const [codexOut] = convertCodexTools([editTool], makeCodexModel({ applyPatchToolType: "freeform" }));
		const [openaiOut] = convertTools([editTool], false, makeModel({ applyPatchToolType: "freeform" }));
		expect(codexOut).toEqual(openaiOut as unknown as typeof codexOut);
	});

	test("falls back to function tool when flag is absent", () => {
		const [out] = convertCodexTools([editTool], makeCodexModel({ id: "gpt-4" }));
		expect(out.type).toBe("function");
		expect(out.name).toBe("edit");
	});
});

describe("dispatcher wire-name matching", () => {
	test("ToolCall.name matches a Tool via its customWireName", () => {
		// Simulate what agent-loop.ts:455-465 does.
		const editLikeTool: Tool & { customWireName?: string } = {
			name: "edit",
			customWireName: "apply_patch",
			description: "edit files",
			parameters: type({ input: "string" }),
			customFormat: { syntax: "lark", definition: GRAMMAR },
		};
		const readTool: Tool = {
			name: "read_file",
			description: "read",
			parameters: type({ path: "string" }),
		};
		const tools = [editLikeTool, readTool];
		const toolCall = { name: "apply_patch" };

		const matched =
			tools.find(t => t.name === toolCall.name) ??
			tools.find(
				(t): t is typeof t & { customWireName: string } =>
					(t as { customWireName?: string }).customWireName !== undefined &&
					(t as { customWireName?: string }).customWireName === toolCall.name,
			);
		expect(matched).toBe(editLikeTool);
	});

	test("prefers name over customWireName when both would match", () => {
		// A pathological tool set: one tool named `foo`, another with
		// customWireName `foo`. Internal name wins.
		const nameMatch: Tool = {
			name: "foo",
			description: "",
			parameters: type({}),
		};
		const wireMatch: Tool & { customWireName: string } = {
			name: "bar",
			customWireName: "foo",
			description: "",
			parameters: type({}),
		};
		const tools = [wireMatch, nameMatch]; // wireMatch listed first
		const toolCall = { name: "foo" };

		const matched =
			tools.find(t => t.name === toolCall.name) ??
			tools.find(
				(t): t is typeof t & { customWireName: string } =>
					(t as { customWireName?: string }).customWireName !== undefined &&
					(t as { customWireName?: string }).customWireName === toolCall.name,
			);
		expect(matched).toBe(nameMatch);
	});
});

describe("history replay: custom_tool_call round-trip", () => {
	test("assistant tool-call block without replayed reasoning omits custom_tool_call item id", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1|ctc_1",
					name: "edit",
					arguments: { input: "*** Begin Patch\n*** End Patch\n" },
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
			stopReason: "stop",
		};
		const knownCallIds = new Set<string>();
		const customCallIds = new Set<string>();
		const items = convertResponsesAssistantMessage(assistantMsg, makeModel(), 0, knownCallIds, true, customCallIds);

		expect(items).toHaveLength(1);
		const item = items[0] as { type: string; id?: string; name?: string; input?: string };
		expect(item.type).toBe("custom_tool_call");
		expect(item.id).toBeUndefined();
		expect(item.name).toBe("apply_patch");
		expect(item.input).toBe("*** Begin Patch\n*** End Patch\n");
		expect(customCallIds.has("call_1")).toBe(true);
	});

	test("assistant tool-call block with replayed reasoning keeps custom_tool_call item id", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_1", summary: [] }),
				},
				{
					type: "toolCall",
					id: "call_1|ctc_1",
					name: "edit",
					arguments: { input: "*** Begin Patch\n*** End Patch\n" },
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
			stopReason: "stop",
		};
		const knownCallIds = new Set<string>();
		const customCallIds = new Set<string>();
		const items = convertResponsesAssistantMessage(assistantMsg, makeModel(), 0, knownCallIds, true, customCallIds);

		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({ type: "reasoning", id: "rs_1" });
		expect(items[1]).toMatchObject({ type: "custom_tool_call", id: "ctc_1", call_id: "call_1" });
		expect(customCallIds.has("call_1")).toBe(true);
	});

	test("assistant function_call block without replayed reasoning omits item id", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1|fc_1",
					name: "read",
					arguments: { path: "README.md" },
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
			stopReason: "stop",
		};
		const knownCallIds = new Set<string>();
		const items = convertResponsesAssistantMessage(assistantMsg, makeModel(), 0, knownCallIds, true);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ type: "function_call", call_id: "call_1", name: "read" });
		expect(JSON.parse(JSON.stringify(items[0]))).not.toHaveProperty("id");
		expect(knownCallIds.has("call_1")).toBe(true);
	});

	test("assistant function_call block with replayed reasoning keeps item id", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_1", summary: [] }),
				},
				{
					type: "toolCall",
					id: "call_1|fc_1",
					name: "read",
					arguments: { path: "README.md" },
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
			stopReason: "stop",
		};
		const knownCallIds = new Set<string>();
		const items = convertResponsesAssistantMessage(assistantMsg, makeModel(), 0, knownCallIds, true);

		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({ type: "reasoning", id: "rs_1" });
		expect(items[1]).toMatchObject({ type: "function_call", id: "fc_1", call_id: "call_1" });
		expect(knownCallIds.has("call_1")).toBe(true);
	});

	test("assistant message block without replayed reasoning omits msg item id", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "done",
					textSignature: JSON.stringify({ v: 1, id: "msg_1" }),
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
			stopReason: "stop",
		};
		const knownCallIds = new Set<string>();
		const items = convertResponsesAssistantMessage(assistantMsg, makeModel(), 0, knownCallIds, true);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ type: "message", role: "assistant", status: "completed" });
		expect(JSON.parse(JSON.stringify(items[0]))).not.toHaveProperty("id");
	});

	test("assistant message block with replayed reasoning keeps msg item id", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_1", summary: [] }),
				},
				{
					type: "text",
					text: "done",
					textSignature: JSON.stringify({ v: 1, id: "msg_1" }),
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
			stopReason: "stop",
		};
		const knownCallIds = new Set<string>();
		const items = convertResponsesAssistantMessage(assistantMsg, makeModel(), 0, knownCallIds, true);

		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({ type: "reasoning", id: "rs_1" });
		expect(items[1]).toMatchObject({ type: "message", id: "msg_1", role: "assistant", status: "completed" });
	});

	test("custom tool call omits item id when replayed across same-provider model switch", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_1|ctc_1",
					name: "edit",
					arguments: { input: "*** Begin Patch\n*** End Patch\n" },
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
			stopReason: "stop",
		};
		const knownCallIds = new Set<string>();
		const customCallIds = new Set<string>();
		const items = convertResponsesAssistantMessage(
			assistantMsg,
			makeModel({ id: "gpt-5.1" }),
			0,
			knownCallIds,
			true,
			customCallIds,
		);

		expect(items).toHaveLength(1);
		const item = items[0] as { type: string; id?: string; call_id?: string };
		expect(item.type).toBe("custom_tool_call");
		expect(item.id).toBeUndefined();
		expect(item.call_id).toBe("call_1");
		expect(customCallIds.has("call_1")).toBe(true);
	});

	test("paired tool result emits custom_tool_call_output when custom id is tracked", () => {
		const messages: unknown[] = [];
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "edit",
			isError: false,
			content: [{ type: "text", text: "Success. Updated the following files:\nM foo.txt" }],
			timestamp: Date.now(),
		};
		const knownCallIds = new Set<string>(["call_1"]);
		const customCallIds = new Set<string>(["call_1"]);
		const model = makeModel();

		appendResponsesToolResultMessages(
			messages as never,
			toolResult,
			model,
			true,
			model.compat.supportsImageDetailOriginal,
			knownCallIds,
			customCallIds,
		);

		expect(messages).toHaveLength(1);
		const item = messages[0] as { type: string; call_id: string; output: string };
		expect(item.type).toBe("custom_tool_call_output");
		expect(item.call_id).toBe("call_1");
		expect(item.output).toContain("Success");
	});

	test("tool result for a non-custom call still emits function_call_output", () => {
		const messages: unknown[] = [];
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_2",
			toolName: "read_file",
			isError: false,
			content: [{ type: "text", text: "ok" }],
			timestamp: Date.now(),
		};
		const knownCallIds = new Set<string>(["call_2"]);
		const customCallIds = new Set<string>(); // call_2 not custom
		const model = makeModel();

		appendResponsesToolResultMessages(
			messages as never,
			toolResult,
			model,
			true,
			model.compat.supportsImageDetailOriginal,
			knownCallIds,
			customCallIds,
		);

		const item = messages[0] as { type: string };
		expect(item.type).toBe("function_call_output");
	});
});
