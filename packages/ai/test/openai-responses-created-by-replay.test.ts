import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type as schemaType } from "@oh-my-pi/omptype";
import { streamAzureOpenAIResponses } from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Message,
	Model,
	ProviderSessionState,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as piUtils from "@oh-my-pi/pi-utils";
import { endpoint, type ResponsesWireEvent, send, sse, textEvents } from "./fixtures/openai-responses-server";

// The Responses API sets `created_by` on output items (and on each entry of a
// `shell_call_output` item's `output`) and refuses a request whose input item
// holds it: `400 Unknown parameter: 'input[7].created_by'`. Stored output items
// are replayed, so every replay path must drop the key, at any value.

/** A stored item's `created_by`: a string, `null` (seen live on a compaction item), or absent. */
type CreatedBy = string | null | undefined;

const CREATED_BY_VALUES = [
	["a string", "resp_creator"],
	["null", null],
] as const;
const SYSTEM_PROMPT = ["You are a helpful assistant."];
const USAGE = { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } };
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const LOOKUP_TOOL: Tool = {
	name: "lookup",
	description: "Look something up",
	parameters: schemaType({ query: "string" }),
};
const httpModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

const cleanups: Array<() => unknown> = [];
const originalWebSocket = global.WebSocket;

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(async () => {
	// Last in, first out: a later override is undone before the one it saw.
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	global.WebSocket = originalWebSocket;
	vi.restoreAllMocks();
});

/** The process-wide profile selection that `setAgentDir` and `setProfile` rewrite. */
const PROFILE_ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

/** Snapshot the profile env; the returned function puts it back and rebuilds the profile and dirs from it. */
function saveProfileState(): () => void {
	const saved = PROFILE_ENV_KEYS.map(key => [key, process.env[key]] as const);
	return () => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		piUtils.__resetDirsFromEnvForTests();
	};
}

function withCreatedBy<T extends Record<string, unknown>>(item: T, createdBy: CreatedBy): T {
	return createdBy === undefined ? item : { ...item, created_by: createdBy };
}

/** Where an item list holds its own `created_by` key: an item's top level, or a `shell_call_output` entry. */
function createdByPaths(items: readonly unknown[]): string[] {
	const paths: string[] = [];
	for (const [index, item] of items.entries()) {
		if (!piUtils.isRecord(item)) continue;
		if (Object.hasOwn(item, "created_by")) paths.push(`[${index}]`);
		if (item.type !== "shell_call_output" || !Array.isArray(item.output)) continue;
		for (const [entryIndex, entry] of item.output.entries()) {
			if (piUtils.isRecord(entry) && Object.hasOwn(entry, "created_by"))
				paths.push(`[${index}].output[${entryIndex}]`);
		}
	}
	return paths;
}

function inputOf(request: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
	const input = request?.input;
	if (!Array.isArray(input)) throw new Error("expected a request with an input list");
	return input as Array<Record<string, unknown>>;
}

function expectOne(input: Array<Record<string, unknown>>, type: string, key: string, value: string): void {
	expect(input.filter(item => item.type === type && item[key] === value)).toHaveLength(1);
}

function storedItems(message: AssistantMessage): unknown[] {
	const payload = message.providerPayload;
	if (payload?.type !== "openaiResponsesHistory") throw new Error("expected stored OpenAI Responses items");
	return payload.items;
}

function toolResultFor(message: AssistantMessage, text: string): ToolResultMessage {
	const call = message.content.find((block): block is ToolCall => block.type === "toolCall");
	if (!call) throw new Error(`expected a tool call in the turn (stop reason ${message.stopReason})`);
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: message.timestamp + 1,
	};
}

/** One response's output as the API returns it: a hosted shell call and its output, then a function call. */
function turnItems(tag: string, createdBy: CreatedBy): Array<Record<string, unknown>> {
	const entry = withCreatedBy(
		{ stdout: "README.md\n", stderr: "", outcome: { type: "exit", exit_code: 0 } },
		createdBy,
	);
	const shell = { commands: ["ls"], max_output_length: null, timeout_ms: null };
	return [
		withCreatedBy(
			{ id: `sh_${tag}`, type: "shell_call", call_id: `call_shell_${tag}`, action: shell, environment: null },
			createdBy,
		),
		withCreatedBy(
			{
				id: `sho_${tag}`,
				type: "shell_call_output",
				call_id: `call_shell_${tag}`,
				max_output_length: null,
				output: [entry],
			},
			createdBy,
		),
		withCreatedBy(
			{
				id: `fc_${tag}`,
				type: "function_call",
				call_id: `call_${tag}`,
				name: "lookup",
				arguments: '{"query":"readme"}',
				status: "completed",
			},
			createdBy,
		),
	];
}

function outputEvents(responseId: string, items: Array<Record<string, unknown>>): ResponsesWireEvent[] {
	const events: ResponsesWireEvent[] = [{ type: "response.created", response: { id: responseId } }];
	for (const [outputIndex, item] of items.entries()) {
		const added = item.type === "function_call" ? { ...item, arguments: "", status: "in_progress" } : item;
		events.push({ type: "response.output_item.added", output_index: outputIndex, item: added });
		if (item.type === "function_call") {
			const delta = { output_index: outputIndex, item_id: item.id, delta: item.arguments };
			events.push({ type: "response.function_call_arguments.delta", ...delta });
		}
		events.push({ type: "response.output_item.done", output_index: outputIndex, item });
	}
	const response = { id: responseId, status: "completed", output: items, usage: USAGE };
	events.push({ type: "response.completed", response });
	return events;
}

/** Turns 1 and 2 answer with items that carry `created_by`; turn 3 answers with text. */
function respond(index: number, createdBy: CreatedBy): ResponsesWireEvent[] {
	if (index === 3) return textEvents("Done", `resp_${index}`);
	return outputEvents(`resp_${index}`, turnItems(`t${index}`, createdBy));
}

/** A compaction's replacement history, as stored: an earlier call, its output and the compaction item. */
function replacementHistory(provider: string, createdBy: CreatedBy): UserMessage {
	const items = [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "Earlier request" }] },
		withCreatedBy(
			{ id: "fc_earlier", type: "function_call", call_id: "call_earlier", name: "lookup", arguments: "{}" },
			createdBy,
		),
		withCreatedBy(
			{ id: "fco_earlier", type: "function_call_output", call_id: "call_earlier", output: "earlier" },
			createdBy,
		),
		withCreatedBy({ id: "cmp_earlier", type: "compaction", encrypted_content: "enc_earlier" }, createdBy),
	];
	return {
		role: "user",
		content: "Summary of the earlier conversation",
		providerPayload: createOpenAIResponsesHistoryPayload(provider, items, false),
		timestamp: 0,
	};
}

// ============================================================================
// Routes that chain: the HTTP previous_response_id chain and both WebSocket sessions
// ============================================================================

interface ChainRoute {
	provider: string;
	turn(context: Context, providerSessionState: Map<string, ProviderSessionState>): Promise<AssistantMessage>;
	requests(): Array<Record<string, unknown>>;
}

function httpRoute(createdBy: CreatedBy): ChainRoute {
	const requests: Array<Record<string, unknown>> = [];
	const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return sse(respond(requests.length, createdBy));
	}) as FetchImpl;
	const options = { apiKey: "not-a-secret", sessionId: "created-by", statefulResponses: true, fetch };
	return {
		provider: "openai",
		turn: (context, providerSessionState) =>
			streamOpenAIResponses(httpModel, context, { ...options, providerSessionState }).result(),
		requests: () => requests,
	};
}

function webSocketRoute(createdBy: CreatedBy): ChainRoute {
	const wire = endpoint((socket, _body, index) => send(socket, respond(index, createdBy)));
	const sessions: Array<Map<string, ProviderSessionState>> = [];
	cleanups.push(async () => {
		for (const session of sessions) for (const state of session.values()) state.close();
		await wire.server.stop(true);
	});
	const model: Model<"openai-responses"> = { ...httpModel, baseUrl: `http://127.0.0.1:${wire.server.port}/v1` };
	const options = { apiKey: "not-a-secret", sessionId: "created-by", preferWebsockets: true };
	return {
		provider: "openai",
		turn: (context, providerSessionState) => {
			sessions.push(providerSessionState);
			return streamOpenAIResponses(model, context, { ...options, providerSessionState }).result();
		},
		requests: () => wire.requests.map(request => request.body),
	};
}

/** The parts of a WebSocket the Codex transport uses; it answers each request frame at once. */
class CodexStubSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState = CodexStubSocket.CONNECTING;
	binaryType: "blob" | "arraybuffer" | "nodebuffer" = "blob";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;

	constructor(
		readonly url: string,
		readonly answer: (body: Record<string, unknown>) => ResponsesWireEvent[],
	) {
		// Open after the transport has attached its handlers, as a real socket does.
		queueMicrotask(() => {
			this.readyState = CodexStubSocket.OPEN;
			this.onopen?.(new Event("open"));
		});
	}

	send(data: string): void {
		for (const event of this.answer(JSON.parse(data)))
			this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
	}

	close(): void {
		this.readyState = CodexStubSocket.CLOSED;
	}
}

function codexWebSocketRoute(createdBy: CreatedBy): ChainRoute {
	const restoreProfileState = saveProfileState();
	const tempDir = piUtils.TempDir.createSync("@pi-created-by-replay-");
	piUtils.setAgentDir(tempDir.path());
	cleanups.push(() => {
		restoreProfileState();
		return tempDir.remove();
	});
	const requests: Array<Record<string, unknown>> = [];
	global.WebSocket = class extends CodexStubSocket {
		constructor(url: string) {
			super(url, body => {
				requests.push(body);
				return respond(requests.length, createdBy);
			});
		}
	} as unknown as typeof WebSocket;
	const model = buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	});
	const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } };
	const options = {
		apiKey: `aaa.${Buffer.from(JSON.stringify(claims), "utf8").toBase64()}.bbb`,
		sessionId: "created-by",
		fetch: vi.fn(async () => {
			throw new Error("the SSE fallback must not be called");
		}) as FetchImpl,
	};
	return {
		provider: "openai-codex",
		turn: (context, providerSessionState) =>
			streamOpenAICodexResponses(model, context, { ...options, providerSessionState }).result(),
		requests: () => requests,
	};
}

/**
 * Turn 1 stores a response whose items carry `created_by`. In a new session,
 * turn 2 replays everything in full and its response carries the field again;
 * turn 3 must chain on turn 2's response with only the new tool result.
 */
async function runChain(route: ChainRoute, createdBy: CreatedBy) {
	const messages: Message[] = [
		replacementHistory(route.provider, createdBy),
		{ role: "user", content: "Find the readme", timestamp: 1 },
	];
	const context = (): Context => ({ systemPrompt: SYSTEM_PROMPT, messages: [...messages], tools: [LOOKUP_TOOL] });
	const first = await route.turn(context(), new Map());
	messages.push(first, toolResultFor(first, "one"));
	const session = new Map<string, ProviderSessionState>();
	const second = await route.turn(context(), session);
	messages.push(second, toolResultFor(second, "two"));
	expect((await route.turn(context(), session)).stopReason).toBe("stop");
	return { requests: route.requests(), stored: [...storedItems(first), ...storedItems(second)] };
}

describe.each([
	["the HTTP route", httpRoute],
	["the Responses WebSocket session", webSocketRoute],
	["the Codex WebSocket session", codexWebSocketRoute],
] as const)("created_by on %s", (_route, makeRoute) => {
	it.each(CREATED_BY_VALUES)(
		"replays stored items without created_by (%s) and still chains the next request",
		async (_label, createdBy) => {
			const run = await runChain(makeRoute(createdBy), createdBy);
			const control = await runChain(makeRoute(undefined), undefined);
			// The stub's created_by reached the stored items, so the probe can see it.
			expect(createdByPaths(run.stored)).toHaveLength(8);
			expect(run.requests).toHaveLength(3);
			const inputs = run.requests.map(inputOf);
			for (const input of inputs) expect(createdByPaths(input)).toEqual([]);
			const [, full, chained] = inputs;
			expect(run.requests[1]?.previous_response_id).toBeUndefined();
			expectOne(full, "function_call", "call_id", "call_t1");
			expectOne(full, "shell_call_output", "call_id", "call_shell_t1");
			expectOne(full, "function_call_output", "call_id", "call_earlier");
			expectOne(full, "compaction", "encrypted_content", "enc_earlier");
			expect(run.requests[2]?.previous_response_id).toBe("resp_2");
			expect(chained.map(item => item.type)).toEqual(["function_call_output"]);
			// Nothing but created_by changed.
			expect(inputs).toEqual(control.requests.map(inputOf));
		},
	);
});

// ============================================================================
// Azure: no native history of its own, only replayed payloads
// ============================================================================

const azureModel: Model<"azure-openai-responses"> = buildModel({
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
});

async function azureInput(createdBy: CreatedBy): Promise<Array<Record<string, unknown>>> {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_t1|fc_t1", name: "lookup", arguments: { query: "readme" } }],
		api: "azure-openai-responses",
		provider: "azure",
		model: "gpt-5-mini",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		providerPayload: createOpenAIResponsesHistoryPayload("azure", turnItems("t1", createdBy)),
		timestamp: 2,
	};
	const messages: Message[] = [
		replacementHistory("azure", createdBy),
		{ role: "user", content: "Find the readme", timestamp: 1 },
		assistant,
		toolResultFor(assistant, "one"),
	];
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamAzureOpenAIResponses(
		azureModel,
		{ systemPrompt: SYSTEM_PROMPT, messages, tools: [LOOKUP_TOOL] },
		{
			apiKey: "not-a-secret",
			azureBaseUrl: azureModel.baseUrl,
			azureApiVersion: "v1",
			signal: AbortSignal.abort(),
			onPayload: payload => resolve(payload as Record<string, unknown>),
		},
	);
	return inputOf(await promise);
}

it.each(CREATED_BY_VALUES)(
	"created_by on the Azure route: replays a replacement history and a stored turn without created_by (%s)",
	async (_label, createdBy) => {
		const input = await azureInput(createdBy);
		expect(createdByPaths(input)).toEqual([]);
		expectOne(input, "compaction", "encrypted_content", "enc_earlier");
		expectOne(input, "shell_call_output", "call_id", "call_shell_t1");
		expect(input).toEqual(await azureInput(undefined));
	},
);

// ============================================================================
// Item types no adapter rebuilds, and a tool parameter named created_by
// ============================================================================

const SEARCHED_TOOLS = [
	{
		type: "function",
		name: "find_owner",
		description: "Find who created a record",
		parameters: {
			type: "object",
			properties: { created_by: { type: "string", description: "The creator's id" } },
			required: ["created_by"],
		},
		strict: false,
	},
];

/** Stored items of types that no replay adapter rebuilds for a model with freeform tools and computer use. */
function otherTypeItems(createdBy: CreatedBy): Array<Record<string, unknown>> {
	const screenshot = { type: "computer_screenshot", image_url: "data:image/png;base64,ZmFrZQ==" };
	return [
		{
			id: "ctc_1",
			type: "custom_tool_call",
			call_id: "call_custom",
			name: "apply_patch",
			input: "*** Begin Patch\n",
		},
		{ id: "ctco_1", type: "custom_tool_call_output", call_id: "call_custom", output: "patched" },
		{
			id: "cu_1",
			type: "computer_call",
			call_id: "call_computer",
			action: { type: "screenshot" },
			pending_safety_checks: [],
		},
		{
			id: "cuo_1",
			type: "computer_call_output",
			call_id: "call_computer",
			output: screenshot,
			acknowledged_safety_checks: [],
		},
		{
			id: "tsc_1",
			type: "tool_search_call",
			call_id: "call_search",
			arguments: { query: "owner" },
			execution: "client",
		},
		{
			id: "tso_1",
			type: "tool_search_output",
			call_id: "call_search",
			execution: "client",
			tools: structuredClone(SEARCHED_TOOLS),
		},
		{ id: "future_1", type: "future_output_item", detail: "kept as stored" },
	].map(item => withCreatedBy({ ...item, status: "completed" }, createdBy));
}

async function otherTypesInput(createdBy: CreatedBy): Promise<Array<Record<string, unknown>>> {
	const model: Model<"openai-responses"> = { ...httpModel, applyPatchToolType: "freeform", supportsComputerUse: true };
	const requests: Array<Record<string, unknown>> = [];
	const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return sse(textEvents("Done", "resp_1"));
	}) as FetchImpl;
	const summary: UserMessage = {
		role: "user",
		content: "Summary of the earlier conversation",
		providerPayload: createOpenAIResponsesHistoryPayload("openai", otherTypeItems(createdBy), false),
		timestamp: 0,
	};
	const messages: Message[] = [summary, { role: "user", content: "Continue", timestamp: 1 }];
	await streamOpenAIResponses(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages, tools: [LOOKUP_TOOL] },
		{ apiKey: "not-a-secret", sessionId: "created-by", fetch },
	).result();
	expect(requests).toHaveLength(1);
	return inputOf(requests[0]);
}

it.each(CREATED_BY_VALUES)(
	"drops created_by (%s) from custom tool, computer, tool search and undeclared item types, keeping a tool parameter named created_by",
	async (_label, createdBy) => {
		expect(createdByPaths(otherTypeItems(createdBy))).toHaveLength(7);
		const input = await otherTypesInput(createdBy);
		expect(createdByPaths(input)).toEqual([]);
		// Replay drops item ids, so each type is found by its call id or, for the undeclared one, by type.
		for (const item of otherTypeItems(undefined)) {
			expect(input.filter(found => found.type === item.type && found.call_id === item.call_id)).toHaveLength(1);
		}
		expect(input.find(item => item.type === "tool_search_output")?.tools).toEqual(SEARCHED_TOOLS);
		expect(input).toEqual(await otherTypesInput(undefined));
	},
);
