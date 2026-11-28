import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamAzureOpenAIResponses } from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { type OpenAIResponsesOptions, streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, Model, ModelSpec, Tool, ToolChoice } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as piUtils from "@oh-my-pi/pi-utils";

type Payload = Record<string, unknown>;

const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

const forkAgentTool: Tool = {
	name: "fork_agent",
	description: "Fork a subagent",
	parameters: type({ prompt: type("string") }),
};

const searchTool: Tool = {
	name: "dataforseo_search",
	description: "Search via DataForSEO",
	parameters: type({ query: type("string") }),
};

const todoTool: Tool = {
	name: "todo",
	description: "Manage a phased task list",
	parameters: type({ ops: type.array(type({ op: type("string") })) }),
};

const resolveTool: Tool = {
	name: "resolve",
	description: "Apply or discard a pending preview",
	parameters: type({ action: type.enumeration(["apply", "discard"]), reason: type("string") }),
};

const echoTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: type({ text: "string" }),
};

const absentTodoContext: Context = {
	messages: [{ role: "user", content: "do the thing", timestamp: Date.now() }],
	tools: [forkAgentTool, searchTool],
};

const presentTodoContext: Context = {
	messages: [{ role: "user", content: "list everything", timestamp: Date.now() }],
	tools: [forkAgentTool, todoTool],
};

const multiToolContext: Context = {
	messages: [{ role: "user", content: "Inspect this project.", timestamp: 0 }],
	tools: [todoTool, resolveTool],
};

const echoContext: Context = {
	messages: [{ role: "user", content: "call echo", timestamp: Date.now() }],
	tools: [echoTool],
};

const forcedTodoChoice: ToolChoice = { type: "tool", name: "todo" };

const openaiCompletionsModel: Model<"openai-completions"> = buildModel({
	id: "gpt-4o-mini-test",
	name: "GPT-4o Mini Test",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});

const openaiResponsesModel: Model<"openai-responses"> = buildModel({
	id: "gpt-5-mini-test",
	name: "GPT-5 Mini Test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
});

const azureModel: Model<"azure-openai-responses"> = buildModel({
	id: "gpt-5-mini-test",
	name: "GPT-5 Mini Test",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
});

const codexModel: Model<"openai-codex-responses"> = buildModel({
	id: "gpt-5-codex-test",
	name: "GPT-5 Codex Test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
});

function localCompletionsModel(provider: string, baseUrl: string): Model<"openai-completions"> {
	return buildModel({
		id: "qwen-3.6-27b",
		name: "Qwen 3.6 27B",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 32_768,
	} satisfies ModelSpec<"openai-completions">);
}

function lmStudioResponsesModel(): Model<"openai-responses"> {
	return buildModel({
		id: "qwen-3.6-27b",
		name: "Qwen 3.6 27B",
		api: "openai-responses",
		provider: "lm-studio",
		baseUrl: "http://127.0.0.1:1234/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 32_768,
	} satisfies ModelSpec<"openai-responses">);
}

function liteLlmBedrockModel(): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-4o-mini");
	return buildModel({
		...base,
		api: "openai-completions",
		id: "bedrock-claude-sonnet-4-6",
		name: "Bedrock Claude Sonnet 4.6 (LiteLLM)",
		provider: "litellm-bedrock",
		baseUrl: "https://example.test/v1",
		compat: base.compatConfig,
	} as ModelSpec<"openai-completions">);
}

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

function captureCompletionsPayload(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions,
): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamOpenAICompletions(model, context, {
		...options,
		apiKey: "test-key",
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Payload),
	});
	return promise;
}

function captureResponsesPayload(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions,
): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamOpenAIResponses(model, context, {
		...options,
		apiKey: "test-key",
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Payload),
	});
	return promise;
}

function captureAzurePayload(context: Context): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamAzureOpenAIResponses(azureModel, context, {
		apiKey: "test-key",
		azureBaseUrl: azureModel.baseUrl,
		azureApiVersion: "v1",
		toolChoice: forcedTodoChoice,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Payload),
	});
	return promise;
}

function captureCodexPayload(context: Context): Promise<Payload> {
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamOpenAICodexResponses(codexModel, context, {
		apiKey: createCodexToken("acct_test"),
		toolChoice: forcedTodoChoice,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Payload),
	});
	return promise;
}

function completionToolNames(payload: Payload): Array<string | undefined> {
	const tools = payload.tools as Array<{ function?: { name?: string } }> | undefined;
	return tools?.map(tool => tool.function?.name) ?? [];
}

function responsesToolNames(payload: Payload): Array<string | undefined> {
	const tools = payload.tools as Array<{ name?: string }> | undefined;
	return tools?.map(tool => tool.name) ?? [];
}

function assistantWithToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "search", arguments: { q: "x" } }],
		api: "openai-completions",
		provider: "litellm-bedrock",
		model: "bedrock-claude-sonnet-4-6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("forced tool_choice targeting a tool absent from the request", () => {
	beforeEach(() => {
		vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops OpenAI Completions forced tool_choice when the named tool is absent", async () => {
		const payload = await captureCompletionsPayload(openaiCompletionsModel, absentTodoContext, {
			toolChoice: forcedTodoChoice,
		});

		expect(completionToolNames(payload)).toEqual(["fork_agent", "dataforseo_search"]);
		expect(payload.tool_choice).toBeUndefined();
	});

	it("keeps OpenAI Completions forced tool_choice when the named tool is present", async () => {
		const payload = await captureCompletionsPayload(openaiCompletionsModel, presentTodoContext, {
			toolChoice: forcedTodoChoice,
		});

		expect(completionToolNames(payload)).toEqual(["fork_agent", "todo"]);
		expect(payload.tool_choice).toEqual({ type: "function", function: { name: "todo" } });
	});

	it("drops OpenAI Responses forced tool_choice when the named tool is absent", async () => {
		const payload = await captureResponsesPayload(openaiResponsesModel, absentTodoContext, {
			toolChoice: forcedTodoChoice,
		});

		expect(responsesToolNames(payload)).toEqual(["fork_agent", "dataforseo_search"]);
		expect(payload.tool_choice).toBeUndefined();
	});

	it("keeps OpenAI Responses forced tool_choice when the named tool is present", async () => {
		const payload = await captureResponsesPayload(openaiResponsesModel, presentTodoContext, {
			toolChoice: forcedTodoChoice,
		});

		expect(responsesToolNames(payload)).toEqual(["fork_agent", "todo"]);
		expect(payload.tool_choice).toEqual({ type: "function", name: "todo" });
	});

	it("drops Azure Responses forced tool_choice when the named tool is absent", async () => {
		const payload = await captureAzurePayload(absentTodoContext);

		expect(responsesToolNames(payload)).toEqual(["fork_agent", "dataforseo_search"]);
		expect(payload.tool_choice).toBeUndefined();
	});

	it("drops Codex Responses forced tool_choice when the named tool is absent", async () => {
		const payload = await captureCodexPayload(absentTodoContext);

		expect(responsesToolNames(payload)).toEqual(["fork_agent", "dataforseo_search"]);
		expect(payload.tool_choice).toBeUndefined();
	});

	it("keeps Codex Responses forced tool_choice when the named tool is present", async () => {
		const payload = await captureCodexPayload(presentTodoContext);

		expect(responsesToolNames(payload)).toEqual(["fork_agent", "todo"]);
		expect(payload.tool_choice).toEqual({ type: "function", name: "todo" });
	});
});

describe("string-only tool_choice hosts on Chat Completions", () => {
	it.each([
		["llama.cpp", "http://localhost:8080/v1"],
		["lm-studio", "http://127.0.0.1:1234/v1"],
	])("drops the forced choice for %s when the named tool is absent", async (provider, baseUrl) => {
		const payload = await captureCompletionsPayload(
			localCompletionsModel(provider, baseUrl),
			{ messages: [{ role: "user", content: "Resolve the pending preview.", timestamp: 0 }], tools: [] },
			{ toolChoice: { type: "tool", name: "resolve" } },
		);

		expect(payload.tool_choice).toBeUndefined();
	});

	it.each([
		["llama.cpp", "http://localhost:8080/v1"],
		["lm-studio", "http://127.0.0.1:1234/v1"],
	])("narrows the advertised tools to the forced one for %s", async (provider, baseUrl) => {
		const payload = await captureCompletionsPayload(localCompletionsModel(provider, baseUrl), multiToolContext, {
			toolChoice: { type: "tool", name: "todo" },
		});

		expect(completionToolNames(payload)).toEqual(["todo"]);
		expect(payload.tool_choice).toBe("required");
	});
});

describe("LM Studio Responses string-only tool_choice", () => {
	it("narrows the advertised tools before downgrading the named choice", async () => {
		const payload = await captureResponsesPayload(lmStudioResponsesModel(), multiToolContext, {
			toolChoice: { type: "tool", name: "todo" },
		});

		expect(responsesToolNames(payload)).toEqual(["todo"]);
		expect(payload.tool_choice).toBe("required");
	});

	it("keeps every tool and drops the choice when the named tool is absent", async () => {
		const payload = await captureResponsesPayload(lmStudioResponsesModel(), multiToolContext, {
			toolChoice: { type: "tool", name: "missing" },
		});

		expect(responsesToolNames(payload)).toEqual(["todo", "resolve"]);
		expect(payload.tool_choice).toBeUndefined();
	});
});

describe("OpenCode Go tool_choice compatibility", () => {
	it("omits forced tool_choice from DeepSeek Flash Responses payloads while preserving tools", async () => {
		const model = getBundledModel("opencode-go", "deepseek-v4-flash") as Model<"openai-responses">;
		expect(model.compat.supportsToolChoice).toBe(false);
		const body = await captureResponsesPayload(model, echoContext, {
			toolChoice: { type: "tool", name: "echo" },
		});
		expect(body.tools).toEqual([expect.objectContaining({ type: "function", name: "echo" })]);
		expect(body.tool_choice).toBeUndefined();
	});

	it("omits tool_choice from MiMo title-style payloads while preserving tools", async () => {
		const model = getBundledModel("opencode-go", "mimo-v2.5-pro") as Model<"openai-completions">;
		const body = await captureCompletionsPayload(model, echoContext, {
			reasoning: "high",
			toolChoice: { type: "tool", name: "echo" },
		});
		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.reasoning_effort).toBe("high");
	});

	it("omits tool_choice from DeepSeek payloads but preserves tools and reasoning_effort", async () => {
		const model = getBundledModel("opencode-go", "deepseek-v4-pro") as Model<"openai-completions">;
		const body = await captureCompletionsPayload(model, echoContext, { reasoning: "high", toolChoice: "auto" });
		expect(body.tools).toBeDefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.reasoning_effort).toBe("high");
	});
});

// Ephemeral side-channel turns send `context.tools = []` with `toolChoice: "none"`.
// A proxy such as LiteLLM → Bedrock turns `tools: []` / `tool_choice: "none"` into
// an empty Bedrock `toolConfig`, which Bedrock rejects once the conversation holds
// toolUse/toolResult blocks. `tool_choice: "none"` is therefore dropped whenever
// the resolved tool list is empty.
describe("Chat Completions tool_choice none without tools", () => {
	it("omits both tools and tool_choice for explicitly empty tools with toolChoice none", async () => {
		const body = await captureCompletionsPayload(
			liteLlmBedrockModel(),
			{
				messages: [{ role: "user", content: "what is X", timestamp: Date.now() }],
				tools: [],
			},
			{ toolChoice: "none" },
		);

		expect(body.tools).toBeUndefined();
		expect(body.tool_choice).toBeUndefined();
	});

	it("omits both tools and tool_choice for explicitly empty tools with tool history", async () => {
		// The Anthropic-proxy `tools: []` sentinel is only for contexts that omit
		// `tools` entirely; an explicit `[]` opt-out must not fall through to it.
		const body = await captureCompletionsPayload(
			liteLlmBedrockModel(),
			{
				messages: [
					{ role: "user", content: "search now", timestamp: Date.now() },
					assistantWithToolCall(),
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "search",
						content: [{ type: "text", text: "result" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "btw what is X", timestamp: Date.now() },
				],
				tools: [],
			},
			{ toolChoice: "none" },
		);

		expect(body.tools).toBeUndefined();
		expect(body.tool_choice).toBeUndefined();
	});

	it("drops tool_choice when tool history is present without explicit tools", async () => {
		// Omitted `tools` with tool history injects `tools: []` for Anthropic-proxy
		// compat; `tool_choice: "none"` must still be stripped alongside it.
		const body = await captureCompletionsPayload(
			liteLlmBedrockModel(),
			{
				messages: [
					{ role: "user", content: "search now", timestamp: Date.now() },
					assistantWithToolCall(),
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "search",
						content: [{ type: "text", text: "result" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "follow-up", timestamp: Date.now() },
				],
			},
			{ toolChoice: "none" },
		);

		expect(body.tools).toEqual([]);
		expect(body.tool_choice).toBeUndefined();
	});

	it("keeps tool_choice none when real tools are present", async () => {
		const body = await captureCompletionsPayload(
			liteLlmBedrockModel(),
			{
				messages: [{ role: "user", content: "answer in prose", timestamp: Date.now() }],
				tools: [echoTool],
			},
			{ toolChoice: "none" },
		);

		expect(Array.isArray(body.tools)).toBe(true);
		expect((body.tools as unknown[]).length).toBe(1);
		expect(body.tool_choice).toBe("none");
	});
});
