import { describe, expect, test } from "bun:test";
import { type Context, type Message, z } from "@pk-nerdsaver-ai/pi-ai";
import {
	createMockModel,
	type MockModel,
	type MockResponse,
	registerMockApi,
} from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { resolveModel } from "../src/config";
import { runDeepResearch } from "../src/deep-researcher";
import type { DeepResearchEvent } from "../src/types";

registerMockApi();

const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 };

function toolCall(name: string, args: Record<string, unknown>): MockResponse {
	return { content: [{ type: "toolCall", name, arguments: args }], usage: USAGE };
}

function text(content: string): MockResponse {
	return { content: [content], usage: USAGE };
}

function toolNames(context: Context): string[] {
	return (context.tools ?? []).map(tool => tool.name);
}

function lastMessage(context: Context): Message | undefined {
	return context.messages[context.messages.length - 1];
}

interface ScriptOptions {
	clarificationNeeded?: boolean;
	supervisorTopics?: string[];
}

/**
 * One mock model routing every stage of the pipeline by tool surface:
 * clarify → brief → supervisor → researcher(s) → compression → final report.
 */
function createPipelineMock(script: ScriptOptions = {}): MockModel {
	const topics = script.supervisorTopics ?? ["topic A"];
	return createMockModel({
		handler: context => {
			const names = toolNames(context);
			if (names.includes("ClarifyWithUser")) {
				return script.clarificationNeeded
					? toolCall("ClarifyWithUser", { need_clarification: true, question: "Which region?", verification: "" })
					: toolCall("ClarifyWithUser", {
							need_clarification: false,
							question: "",
							verification: "Understood, starting research.",
						});
			}
			if (names.includes("ResearchQuestion")) {
				return toolCall("ResearchQuestion", { research_brief: "Research brief: compare the topics." });
			}
			if (names.includes("Summary")) {
				return toolCall("Summary", { summary: "webpage summary", key_excerpts: "excerpt one" });
			}
			if (names.includes("ConductResearch")) {
				const delegated = context.messages.some(
					message => message.role === "toolResult" && message.toolName === "ConductResearch",
				);
				if (delegated) return toolCall("ResearchComplete", {});
				return {
					content: topics.map((topic, index) => ({
						type: "toolCall" as const,
						id: `conduct-${index}`,
						name: "ConductResearch",
						arguments: { research_topic: topic },
					})),
					usage: USAGE,
				};
			}
			if (names.includes("tavily_search")) {
				const searched = lastMessage(context)?.role === "toolResult";
				if (searched) return text("I have enough information on this topic.");
				return toolCall("tavily_search", { queries: ["query one"] });
			}
			// No tools: compression (has a system prompt) or the final report.
			if (context.systemPrompt && context.systemPrompt.length > 0) {
				return text(
					"**Fully Comprehensive Findings**\ncompressed research findings\n\n### Sources\n[1] Example: https://example.com",
				);
			}
			return text("# Final Report\n\nThe answer, based on the findings.");
		},
	});
}

function fakeTavilyFetch(): typeof globalThis.fetch {
	const impl = (input: string | URL | Request): Promise<Response> => {
		void input;
		return Promise.resolve(
			new Response(
				JSON.stringify({
					query: "query one",
					results: [
						{
							title: "Example",
							url: "https://example.com",
							content: "snippet",
							raw_content: "raw webpage content",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
	};
	return impl as typeof globalThis.fetch;
}

describe("runDeepResearch", () => {
	test("ends with a clarifying question without starting research", async () => {
		const model = createPipelineMock({ clarificationNeeded: true });
		const result = await runDeepResearch("Tell me about coffee", {
			researchModel: model,
			summarizationModel: model,
			compressionModel: model,
			finalReportModel: model,
		});

		expect(result.status).toBe("clarification_needed");
		expect(result.clarificationQuestion).toBe("Which region?");
		expect(result.finalReport).toBe("");
		// Only the clarification call happened — no brief, supervisor, or report calls.
		expect(model.calls).toHaveLength(1);
	});

	test("runs the full pipeline: brief → parallel researchers → compression → report", async () => {
		const model = createPipelineMock({ supervisorTopics: ["topic A", "topic B"] });
		const events: DeepResearchEvent[] = [];
		const result = await runDeepResearch("Compare topic A and topic B", {
			researchModel: model,
			summarizationModel: model,
			compressionModel: model,
			finalReportModel: model,
			allowClarification: false,
			maxConcurrentResearchUnits: 2,
			tavilyApiKey: "test-key",
			fetch: fakeTavilyFetch(),
			onEvent: event => events.push(event),
		});

		expect(result.status).toBe("completed");
		expect(result.researchBrief).toBe("Research brief: compare the topics.");
		expect(result.finalReport).toContain("# Final Report");
		// Both researchers' compressed findings became supervisor notes.
		expect(result.notes).toHaveLength(2);
		expect(result.notes.every(note => note.includes("compressed research findings"))).toBe(true);
		// Raw notes were captured from both researcher transcripts.
		expect(result.rawNotes.join("\n")).toContain("Search results");
		// Webpage content was summarized through the Summary structured call.
		expect(result.rawNotes.join("\n")).toContain("webpage summary");
		// Every mocked call contributed usage.
		expect(result.usage.totalTokens).toBe(model.calls.length * 15);
		// Lifecycle events fired in order.
		const eventTypes = events.map(event => event.type);
		expect(eventTypes).toContain("research_brief");
		expect(eventTypes).toContain("final_report_complete");
		expect(eventTypes.indexOf("research_brief")).toBeLessThan(eventTypes.indexOf("researcher_start"));
		expect(eventTypes.filter(type => type === "researcher_start")).toHaveLength(2);
	});

	test("rejects ConductResearch calls beyond the concurrency budget", async () => {
		const model = createPipelineMock({ supervisorTopics: ["t1", "t2", "t3"] });
		const events: DeepResearchEvent[] = [];
		const result = await runDeepResearch("Research three things", {
			researchModel: model,
			summarizationModel: model,
			compressionModel: model,
			finalReportModel: model,
			allowClarification: false,
			maxConcurrentResearchUnits: 2,
			tavilyApiKey: "test-key",
			fetch: fakeTavilyFetch(),
			onEvent: event => events.push(event),
		});

		expect(result.status).toBe("completed");
		// Only two researchers actually ran.
		expect(events.filter(event => event.type === "researcher_start")).toHaveLength(2);
		// The overflow call is reported as an error note instead of being executed.
		expect(result.notes.some(note => note.includes("exceeded the maximum number of concurrent research units"))).toBe(
			true,
		);
	});

	test("retries structured output when the model skips the forced tool call", async () => {
		const model = createMockModel({
			responses: [
				// First brief attempt: plain text, no tool call.
				text("I cannot structure that."),
			],
			handler: context => {
				const names = toolNames(context);
				if (names.includes("ResearchQuestion")) {
					return toolCall("ResearchQuestion", { research_brief: "brief after retry" });
				}
				if (names.includes("ConductResearch")) return toolCall("ResearchComplete", {});
				if (context.systemPrompt && context.systemPrompt.length > 0) return text("compressed");
				return text("# Report");
			},
		});
		const result = await runDeepResearch("anything", {
			researchModel: model,
			summarizationModel: model,
			compressionModel: model,
			finalReportModel: model,
			allowClarification: false,
			searchApi: "none",
		});

		expect(result.status).toBe("completed");
		expect(result.researchBrief).toBe("brief after retry");
	});

	test("routes researcher searches through an injected host search tool", async () => {
		const searchCalls: string[][] = [];
		const model = createMockModel({
			handler: context => {
				const names = toolNames(context);
				if (names.includes("ResearchQuestion")) {
					return toolCall("ResearchQuestion", { research_brief: "brief" });
				}
				if (names.includes("ConductResearch")) {
					const delegated = context.messages.some(
						message => message.role === "toolResult" && message.toolName === "ConductResearch",
					);
					return delegated
						? toolCall("ResearchComplete", {})
						: toolCall("ConductResearch", { research_topic: "topic" });
				}
				if (names.includes("web_search")) {
					const searched = lastMessage(context)?.role === "toolResult";
					return searched ? text("done researching") : toolCall("web_search", { queries: ["q1", "q2"] });
				}
				if (context.systemPrompt && context.systemPrompt.length > 0) return text("compressed host findings");
				return text("# Report");
			},
		});
		const result = await runDeepResearch("research something", {
			researchModel: model,
			summarizationModel: model,
			compressionModel: model,
			finalReportModel: model,
			allowClarification: false,
			searchApi: "none",
			searchTool: {
				tool: {
					name: "web_search",
					description: "Host-provided web search.",
					parameters: z.object({ queries: z.array(z.string()) }),
				},
				execute: args => {
					searchCalls.push(z.array(z.string()).parse(args.queries));
					return "host search results";
				},
			},
		});

		expect(result.status).toBe("completed");
		// The injected tool received the researcher's queries; no Tavily call was made.
		expect(searchCalls).toEqual([["q1", "q2"]]);
		expect(result.notes.join("\n")).toContain("compressed host findings");
	});
});

describe("resolveModel", () => {
	test("maps unknown specs to a clear error", () => {
		expect(() => resolveModel("not-a-model-spec")).toThrow("Invalid model spec");
		expect(() => resolveModel("nope:does-not-exist")).toThrow("Unknown provider");
	});
});

describe("token budget", () => {
	test("winds research down gracefully when the budget is exhausted, still writing the report", async () => {
		// Each mocked call reports 15 tokens; a 30-token budget is spent after
		// the brief + first supervisor turn, before any researcher tool loop.
		const model = createPipelineMock({ supervisorTopics: ["topic A", "topic B"] });
		const events: DeepResearchEvent[] = [];
		const result = await runDeepResearch("Compare topic A and topic B", {
			researchModel: model,
			summarizationModel: model,
			compressionModel: model,
			finalReportModel: model,
			allowClarification: false,
			maxConcurrentResearchUnits: 2,
			maxTotalTokens: 30,
			cooldownMs: 0,
			tavilyApiKey: "test-key",
			fetch: fakeTavilyFetch(),
			onEvent: event => events.push(event),
		});

		expect(result.status).toBe("completed");
		expect(result.budgetExhausted).toBe(true);
		// The run degraded instead of aborting: a real report was still written.
		expect(result.finalReport).toContain("# Final Report");
		// Researchers stopped before searching — no tool-loop transcripts were captured.
		expect(result.rawNotes.join("\n")).not.toContain("Search results");
		// Exhaustion is announced exactly once.
		expect(events.filter(event => event.type === "budget_exhausted")).toHaveLength(1);
		// Wind-down path: brief + one supervisor turn + one compression per topic + final report.
		expect(model.calls).toHaveLength(5);
	});

	test("pauses with budget_cooldown events once usage crosses the threshold", async () => {
		const model = createPipelineMock();
		const events: DeepResearchEvent[] = [];
		const result = await runDeepResearch("Tell me about topic A", {
			researchModel: model,
			summarizationModel: model,
			compressionModel: model,
			finalReportModel: model,
			allowClarification: false,
			maxTotalTokens: 10_000,
			cooldownThresholdRatio: 0.001,
			cooldownMs: 1,
			tavilyApiKey: "test-key",
			fetch: fakeTavilyFetch(),
			onEvent: event => events.push(event),
		});

		expect(result.status).toBe("completed");
		expect(result.budgetExhausted).toBe(false);
		const cooldowns = events.filter(event => event.type === "budget_cooldown");
		// Every call after the first paused: the threshold sits below one call's usage.
		expect(cooldowns.length).toBeGreaterThanOrEqual(1);
		for (const cooldown of cooldowns) {
			expect(cooldown.usedTokens).toBeGreaterThan(0);
			expect(cooldown.maxTotalTokens).toBe(10_000);
			expect(cooldown.delayMs).toBe(1);
		}
	});
});
