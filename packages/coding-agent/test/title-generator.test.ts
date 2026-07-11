import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import * as ai from "@pk-nerdsaver-ai/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { generateSessionTitle } from "@pk-nerdsaver-ai/pi-coding-agent/utils/title-generator";
import { logger } from "@pk-nerdsaver-ai/pi-utils";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function getModelFor(provider: GeneratedProvider, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected model ${provider}/${id}`);
	return model;
}

function withoutForcedToolChoice(model: Model<Api>): Model<Api> {
	return { ...model, compat: { ...model.compat, supportsForcedToolChoice: false } } as Model<Api>;
}

function createSettings(model: Model<Api>, tinyModel = "online") {
	return {
		get(path: string) {
			if (path === "providers.tinyModel") return tinyModel;
			return undefined;
		},
		getModelRole(role: string) {
			return role === "smol" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
		getApiKeyForProvider: async () => "test-key",
		authStorage: { rotateSessionCredential: async () => false },
		resolver: () => async () => "test-key",
	} as never;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("title generator", () => {
	it("returns the title from a forced set_title tool call", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [
				{
					type: "toolCall",
					id: "call-title",
					name: "set_title",
					arguments: { title: "Structured Title" },
				},
			],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Structured Title");
		expect(completeSimpleMock.mock.calls[0]?.[1]).toMatchObject({
			tools: [expect.objectContaining({ name: "set_title" })],
		});
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			disableReasoning: true,
			toolChoice: { type: "tool", name: "set_title" },
		});
	});

	it("uses the bundled default prompt when no title prompt file is resolved", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "toolCall", id: "call-title", name: "set_title", arguments: { title: "Default Prompt" } }],
		} as never);

		await generateSessionTitle("Investigate the resolver", createRegistry(model), createSettings(model));

		const request = completeSimpleMock.mock.calls[0]?.[1] as { systemPrompt?: string[] } | undefined;
		expect(request?.systemPrompt).toHaveLength(1);
		expect(request?.systemPrompt?.[0]).toContain("set_title");
	});

	it("uses the resolved TITLE_SYSTEM.md prompt for online title generation", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const customPrompt = "Generate lowercase colon-delimited session names.";
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "toolCall", id: "call-title", name: "set_title", arguments: { title: "fix:resolver" } }],
		} as never);

		await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
			undefined,
			undefined,
			undefined,
			customPrompt,
		);

		const request = completeSimpleMock.mock.calls[0]?.[1] as
			| { systemPrompt?: string[]; tools?: Array<{ name?: string }> }
			| undefined;
		const options = completeSimpleMock.mock.calls[0]?.[2] as
			| { toolChoice?: { type?: string; name?: string } }
			| undefined;
		expect(request?.systemPrompt).toEqual([customPrompt]);
		expect(request?.tools?.[0]?.name).toBe("set_title");
		expect(options?.toolChoice).toEqual({ type: "tool", name: "set_title" });
	});

	it("falls back to text content when no set_title tool call is returned", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Text Title" }],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Text Title");
	});

	it("defers titling for a greeting without invoking the model", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");

		const title = await generateSessionTitle("hi", createRegistry(model), createSettings(model));

		expect(title).toBeNull();
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("returns null when the model rejects a non-greeting taskless message with the none sentinel", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [
				{
					type: "toolCall",
					id: "call-title",
					name: "set_title",
					arguments: { title: "none" },
				},
			],
		} as never);

		const title = await generateSessionTitle(
			"I have a quick question for you",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBeNull();
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("logs and returns null when title credentials are missing", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const title = await generateSessionTitle(
			"Investigate the resolver",
			{
				getAvailable: () => [model],
				getApiKey: async () => undefined,
			} as never,
			createSettings(model),
			"session-1",
		);

		expect(title).toBeNull();
		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledWith(
			"title-generator: no API key",
			expect.objectContaining({
				sessionId: "session-1",
				provider: model.provider,
				id: model.id,
				reason: "missing-api-key",
			}),
		);
	});

	it("logs and returns null when title credential lookup throws", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const title = await generateSessionTitle(
			"Investigate the resolver",
			{
				getAvailable: () => [model],
				getApiKey: async () => {
					throw new Error("credential lookup failed");
				},
			} as never,
			createSettings(model),
			"session-2",
		);

		expect(title).toBeNull();
		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledWith(
			"title-generator: error",
			expect.objectContaining({
				sessionId: "session-2",
				provider: model.provider,
				id: model.id,
				reason: "exception",
				error: "credential lookup failed",
			}),
		);
	});

	it("uses a reasoning-safe output budget for reasoning models", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [
				{
					type: "toolCall",
					id: "call-title",
					name: "set_title",
					arguments: { title: "Budget Title" },
				},
			],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);
		const maxTokens = (completeSimpleMock.mock.calls[0]?.[2] as { maxTokens?: number } | undefined)?.maxTokens;

		expect(title).toBe("Budget Title");
		expect(maxTokens).toBeGreaterThanOrEqual(1024);
	});

	it("strips code blocks from the message sent to the model", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "toolCall", id: "call-title", name: "set_title", arguments: { title: "Setup Screen" } }],
		} as never);

		await generateSessionTitle(
			"plan a setup screen\n```\nWelcome to Claude Code v2.1.158\n```\npick provider then theme",
			createRegistry(model),
			createSettings(model),
		);

		const sentMessages = (completeSimpleMock.mock.calls[0]?.[1] as { messages?: Array<{ content?: string }> })
			?.messages;
		const userContent = sentMessages?.[0]?.content ?? "";
		expect(userContent).not.toContain("Claude Code v2.1.158");
		expect(userContent).toContain("pick provider then theme");
	});

	it("uses <title> markers instead of a forced tool call when the model lacks tool_choice support", async () => {
		const model = getModelFor("deepseek", "deepseek-v4-pro");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Add OAuth authentication</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"Add OAuth authentication",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Add OAuth authentication");
		const request = completeSimpleMock.mock.calls[0]?.[1] as { systemPrompt?: string[]; tools?: unknown };
		const options = completeSimpleMock.mock.calls[0]?.[2] as { toolChoice?: unknown };
		expect(request?.tools).toBeUndefined();
		expect(options?.toolChoice).toBeUndefined();
		expect(request?.systemPrompt?.[0]).toContain("<title>");
	});

	it("uses the marker path when the model rejects forced tool choice", async () => {
		const model = withoutForcedToolChoice(getModelOrThrow("claude-sonnet-4-5"));
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Investigate the resolver</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Investigate the resolver");
		expect((completeSimpleMock.mock.calls[0]?.[1] as { tools?: unknown }).tools).toBeUndefined();
		expect((completeSimpleMock.mock.calls[0]?.[2] as { toolChoice?: unknown }).toolChoice).toBeUndefined();
	});

	it("accepts a plain sentence when the model omits the <title> markers", async () => {
		const model = getModelFor("deepseek", "deepseek-v4-pro");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Fix login button on mobile" }],
		} as never);

		const title = await generateSessionTitle(
			"the login button is broken on mobile",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Fix login button on mobile");
	});

	it("strips an unclosed <title> tag from a truncated response", async () => {
		const model = getModelFor("deepseek", "deepseek-v4-pro");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Refactor API client error handling" }],
		} as never);

		const title = await generateSessionTitle(
			"refactor the error handling in the api client",
			createRegistry(model),
			createSettings(model),
		);

		expect(title).toBe("Refactor API client error handling");
	});

	it("appends the marker instruction after a custom prompt in marker mode", async () => {
		const model = getModelFor("deepseek", "deepseek-v4-pro");
		const customPrompt = "Generate lowercase colon-delimited session names.";
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>fix:resolver</title>" }],
		} as never);

		const title = await generateSessionTitle(
			"Investigate the resolver",
			createRegistry(model),
			createSettings(model),
			undefined,
			undefined,
			undefined,
			customPrompt,
		);

		expect(title).toBe("fix:resolver");
		const request = completeSimpleMock.mock.calls[0]?.[1] as { systemPrompt?: string[] };
		expect(request?.systemPrompt).toHaveLength(2);
		expect(request?.systemPrompt?.[0]).toBe(customPrompt);
		expect(request?.systemPrompt?.[1]).toContain("<title>");
	});

	it("resolves the model roles in precedence order: tiny -> commit -> smol", async () => {
		const tinyModel = getModelOrThrow("claude-haiku-4-5");
		const commitModel = getModelOrThrow("claude-sonnet-4-5");
		const smolModel = getModelOrThrow("claude-opus-4-8");

		const mockComplete = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Test Title</title>" }],
		} as never);

		// Case 1: All three roles configured. 'tiny' should be used.
		let currentSettings = {
			get(path: string) {
				if (path === "providers.tinyModel") return "online";
				return undefined;
			},
			getModelRole(role: string) {
				if (role === "tiny") return `${tinyModel.provider}/${tinyModel.id}`;
				if (role === "commit") return `${commitModel.provider}/${commitModel.id}`;
				if (role === "smol") return `${smolModel.provider}/${smolModel.id}`;
				return undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;

		const registry = {
			getAvailable: () => [tinyModel, commitModel, smolModel],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false },
			resolver: () => async () => "test-key",
		} as never;

		await generateSessionTitle("Some message", registry, currentSettings);
		expect(mockComplete).toHaveBeenCalled();
		expect(mockComplete.mock.calls[0]?.[0]).toBe(tinyModel);

		mockComplete.mockClear();

		// Case 2: 'tiny' role not configured, 'commit' and 'smol' configured. 'commit' should be used.
		currentSettings = {
			get(path: string) {
				if (path === "providers.tinyModel") return "online";
				return undefined;
			},
			getModelRole(role: string) {
				if (role === "commit") return `${commitModel.provider}/${commitModel.id}`;
				if (role === "smol") return `${smolModel.provider}/${smolModel.id}`;
				return undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;

		await generateSessionTitle("Some message", registry, currentSettings);
		expect(mockComplete).toHaveBeenCalled();
		expect(mockComplete.mock.calls[0]?.[0]).toBe(commitModel);

		mockComplete.mockClear();

		// Case 3: Only 'smol' role configured. 'smol' should be used.
		currentSettings = {
			get(path: string) {
				if (path === "providers.tinyModel") return "online";
				return undefined;
			},
			getModelRole(role: string) {
				if (role === "smol") return `${smolModel.provider}/${smolModel.id}`;
				return undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;

		await generateSessionTitle("Some message", registry, currentSettings);
		expect(mockComplete).toHaveBeenCalled();
		expect(mockComplete.mock.calls[0]?.[0]).toBe(smolModel);
	});
});
