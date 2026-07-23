import { describe, expect, test } from "bun:test";
import { z } from "@pk-nerdsaver-ai/pi-ai";
import {
	createMockModel,
	type MockModel,
	type MockResponse,
	registerMockApi,
} from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import type { ResearchTool } from "@pk-nerdsaver-ai/pi-deep-research";
import { DeepResearchTool } from "../../src/deep-research/tool";
import type { ToolSession } from "../../src/tools";

registerMockApi();

const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };

function toolCall(name: string, args: Record<string, unknown>): MockResponse {
	return { content: [{ type: "toolCall", name, arguments: args }], usage: USAGE };
}

function text(content: string): MockResponse {
	return { content: [content], usage: USAGE };
}

/** One mock model routing every pipeline stage by tool surface, as in the package tests. */
function createPipelineMock(): MockModel {
	return createMockModel({
		handler: context => {
			const names = (context.tools ?? []).map(tool => tool.name);
			if (names.includes("ResearchQuestion")) {
				return toolCall("ResearchQuestion", { research_brief: "Brief: research the topic." });
			}
			if (names.includes("ConductResearch")) {
				const delegated = context.messages.some(
					message => message.role === "toolResult" && message.toolName === "ConductResearch",
				);
				if (delegated) return toolCall("ResearchComplete", {});
				return toolCall("ConductResearch", { research_topic: "the topic" });
			}
			if (names.includes("web_search")) {
				const searched = context.messages[context.messages.length - 1]?.role === "toolResult";
				if (searched) return text("I have enough information.");
				return toolCall("web_search", { queries: ["query one"] });
			}
			if (context.systemPrompt && context.systemPrompt.length > 0) {
				return text("**Findings**\ncompressed findings");
			}
			return text("# Final Report\n\nThe answer.");
		},
	});
}

const fakeSearchTool: ResearchTool = {
	tool: {
		name: "web_search",
		description: "Fake host search.",
		parameters: z.object({ queries: z.array(z.string()) }),
	},
	execute: () => "Search results: example finding (https://example.com)",
};

interface SessionOptions {
	sessionModel?: MockModel;
	registryModels?: Record<string, MockModel>;
	settings?: Record<string, unknown>;
}

function createSession(options: SessionOptions = {}): ToolSession {
	const values: Record<string, unknown> = {
		"deepResearch.model": "",
		"deepResearch.summarizationModel": "",
		"deepResearch.compressionModel": "",
		"deepResearch.reportModel": "",
		"deepResearch.maxTotalTokens": 0,
		"deepResearch.cooldownMs": 0,
		...options.settings,
	};
	const registryModels = options.registryModels ?? {};
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: { get: (key: string) => values[key] },
		getActiveModel: options.sessionModel ? () => options.sessionModel : undefined,
		modelRegistry: {
			find: (provider: string, id: string) => registryModels[`${provider}/${id}`],
		},
	} as unknown as ToolSession;
}

function researchTool(session: ToolSession): DeepResearchTool {
	return new DeepResearchTool(session, () => fakeSearchTool);
}

describe("DeepResearchTool model selection", () => {
	test("the model parameter overrides the session model for the whole pipeline", async () => {
		const sessionModel = createPipelineMock();
		const overrideModel = createPipelineMock();
		const session = createSession({ sessionModel, registryModels: { "mock/override": overrideModel } });

		const result = await researchTool(session).execute("call-1", {
			question: "What is the topic?",
			model: "mock/override",
		});

		expect(result.isError).toBeUndefined();
		expect(result.details?.status).toBe("completed");
		// Every pipeline call went to the registry-resolved model, none to the session model.
		expect(overrideModel.calls.length).toBeGreaterThan(0);
		expect(sessionModel.calls).toHaveLength(0);
	});

	test("the deepResearch.model setting is used when no parameter is given", async () => {
		const sessionModel = createPipelineMock();
		const settingsModel = createPipelineMock();
		const session = createSession({
			sessionModel,
			registryModels: { "mock/configured": settingsModel },
			settings: { "deepResearch.model": "mock/configured" },
		});

		const result = await researchTool(session).execute("call-2", { question: "What is the topic?" });

		expect(result.details?.status).toBe("completed");
		expect(settingsModel.calls.length).toBeGreaterThan(0);
		expect(sessionModel.calls).toHaveLength(0);
	});

	test("an unknown model parameter maps to a clear error without any model calls", async () => {
		const sessionModel = createPipelineMock();
		const session = createSession({ sessionModel });

		const result = await researchTool(session).execute("call-3", {
			question: "What is the topic?",
			model: "mock/does-not-exist",
		});

		expect(result.isError).toBe(true);
		const textBlock = result.content[0];
		expect(textBlock?.type === "text" && textBlock.text).toContain('Unknown model parameter "mock/does-not-exist"');
		expect(sessionModel.calls).toHaveLength(0);
	});
});

describe("DeepResearchTool token budget", () => {
	test("a settings budget winds the run down gracefully and flags the report", async () => {
		const sessionModel = createPipelineMock();
		// Each mocked call reports 15 tokens; 30 is spent before any researcher searches.
		const session = createSession({ sessionModel, settings: { "deepResearch.maxTotalTokens": 30 } });

		const result = await researchTool(session).execute("call-4", { question: "What is the topic?" });

		expect(result.details?.status).toBe("completed");
		expect(result.details?.budgetExhausted).toBe(true);
		const textBlock = result.content[0];
		const report = textBlock?.type === "text" ? textBlock.text : "";
		// The report still exists, with the budget disclosure appended.
		expect(report).toContain("# Final Report");
		expect(report).toContain("token budget (30 tokens) was reached");
	});

	test("the max_total_tokens parameter overrides the settings budget", async () => {
		const sessionModel = createPipelineMock();
		// Settings say 30 (would exhaust); the call raises it high enough to finish research.
		const session = createSession({ sessionModel, settings: { "deepResearch.maxTotalTokens": 30 } });

		const result = await researchTool(session).execute("call-5", {
			question: "What is the topic?",
			max_total_tokens: 10_000,
		});

		expect(result.details?.status).toBe("completed");
		expect(result.details?.budgetExhausted).toBe(false);
		// Research actually ran: the researcher searched through the injected tool.
		expect(sessionModel.calls.length).toBeGreaterThan(4);
	});
});
