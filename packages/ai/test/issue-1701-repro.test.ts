import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamAzureOpenAIResponses } from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model, Tool, ToolChoice } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";

const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	vi.restoreAllMocks();
});

const completionsModel: Model<"openai-completions"> = buildModel({
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

const responsesModel: Model<"openai-responses"> = buildModel({
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

const absentTodoContext: Context = {
	messages: [{ role: "user", content: "do the thing", timestamp: Date.now() }],
	tools: [forkAgentTool, searchTool],
};

const presentTodoContext: Context = {
	messages: [{ role: "user", content: "list everything", timestamp: Date.now() }],
	tools: [forkAgentTool, todoTool],
};

const forcedTodoChoice: ToolChoice = { type: "tool", name: "todo" };

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

function captureCompletionsPayload(context: Context): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAICompletions(completionsModel, context, {
		apiKey: "test-key",
		toolChoice: forcedTodoChoice,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

function captureResponsesPayload(context: Context): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAIResponses(responsesModel, context, {
		apiKey: "test-key",
		toolChoice: forcedTodoChoice,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

function captureAzurePayload(context: Context): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamAzureOpenAIResponses(azureModel, context, {
		apiKey: "test-key",
		azureBaseUrl: azureModel.baseUrl,
		azureApiVersion: "v1",
		toolChoice: forcedTodoChoice,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

function captureCodexPayload(context: Context): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamOpenAICodexResponses(codexModel, context, {
		apiKey: createCodexToken("acct_test"),
		toolChoice: forcedTodoChoice,
		signal: createAbortedSignal(),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

function completionToolNames(payload: Record<string, unknown>): Array<string | undefined> {
	const tools = payload.tools as Array<{ function?: { name?: string } }> | undefined;
	return tools?.map(tool => tool.function?.name) ?? [];
}

function responsesToolNames(payload: Record<string, unknown>): Array<string | undefined> {
	const tools = payload.tools as Array<{ name?: string }> | undefined;
	return tools?.map(tool => tool.name) ?? [];
}

describe("issue #1701 forced tool_choice guards", () => {
	it("drops OpenAI Completions forced tool_choice when the named tool is absent", async () => {
		const payload = await captureCompletionsPayload(absentTodoContext);

		expect(completionToolNames(payload)).toEqual(["fork_agent", "dataforseo_search"]);
		expect(payload.tool_choice).toBeUndefined();
	});

	it("keeps OpenAI Completions forced tool_choice when the named tool is present", async () => {
		const payload = await captureCompletionsPayload(presentTodoContext);

		expect(completionToolNames(payload)).toEqual(["fork_agent", "todo"]);
		expect(payload.tool_choice).toEqual({ type: "function", function: { name: "todo" } });
	});

	it("drops OpenAI Responses forced tool_choice when the named tool is absent", async () => {
		const payload = await captureResponsesPayload(absentTodoContext);

		expect(responsesToolNames(payload)).toEqual(["fork_agent", "dataforseo_search"]);
		expect(payload.tool_choice).toBeUndefined();
	});

	it("keeps OpenAI Responses forced tool_choice when the named tool is present", async () => {
		const payload = await captureResponsesPayload(presentTodoContext);

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
