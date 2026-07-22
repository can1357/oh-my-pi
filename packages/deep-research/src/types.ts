import type { Message, Model, SimpleStreamOptions, Tool } from "@pk-nerdsaver-ai/pi-ai";
import { z } from "@pk-nerdsaver-ai/pi-ai";

/** Search backend used by researcher sub-agents. */
export type SearchApi = "tavily" | "none";

/**
 * A model selection: either a resolved catalog `Model`, or a
 * `"provider:model-id"` spec resolved against the bundled catalog
 * (e.g. `"openai:gpt-4.1"`).
 */
export type ModelSpec = string | Model;

/** A tool a researcher sub-agent may call, with its execution handler. */
export interface ResearchTool {
	tool: Tool;
	execute: (args: Record<string, unknown>) => Promise<string> | string;
}

/** Configuration for a deep research run. All fields have defaults. */
export interface DeepResearchConfig {
	/** Model powering clarification, the research brief, the supervisor, and researcher sub-agents. */
	researchModel: ModelSpec;
	/** Model summarizing raw webpage content from search results. */
	summarizationModel: ModelSpec;
	/** Model compressing each researcher sub-agent's findings. */
	compressionModel: ModelSpec;
	/** Model writing the final report. */
	finalReportModel: ModelSpec;

	/** Max output tokens for the research model. */
	researchModelMaxTokens: number;
	/** Max output tokens for the summarization model. */
	summarizationModelMaxTokens: number;
	/** Max output tokens for the compression model. */
	compressionModelMaxTokens: number;
	/** Max output tokens for the final report model. */
	finalReportModelMaxTokens: number;

	/** Whether the agent may end the run early with a clarifying question. */
	allowClarification: boolean;
	/** Max researcher sub-agents running concurrently per supervisor iteration. */
	maxConcurrentResearchUnits: number;
	/** Max supervisor reflect/delegate iterations before the research phase ends. */
	maxResearcherIterations: number;
	/** Max tool-calling iterations inside a single researcher sub-agent. */
	maxReactToolCalls: number;
	/** Max retries for structured-output (forced tool call) generations. */
	maxStructuredOutputRetries: number;

	/** Search backend. "none" leaves researchers with only injected extra tools. */
	searchApi: SearchApi;
	/** Tavily API key. Falls back to the TAVILY_API_KEY environment variable. */
	tavilyApiKey?: string;
	/** Results per Tavily query. */
	tavilyMaxResults: number;
	/** Tavily topic filter. */
	tavilyTopic: "general" | "news" | "finance";
	/** Max characters of raw webpage content sent to the summarization model. */
	maxContentLength: number;

	/**
	 * Injected search tool. When set, it replaces the built-in backend selected by
	 * `searchApi` — hosts (e.g. the omp coding agent) use this to route research
	 * through their own search subsystem.
	 */
	searchTool?: ResearchTool;

	/** Extra tools made available to researcher sub-agents (e.g. MCP-backed tools). */
	extraTools: ResearchTool[];
	/** Extra instruction block injected into the researcher system prompt. */
	extraToolInstructions: string;

	/** Optional passthrough options applied to every pi-ai completion. */
	modelOptions: Partial<SimpleStreamOptions>;
	/** Fetch implementation for Tavily HTTP calls (testing/proxy seam). */
	fetch: typeof globalThis.fetch;
	/** Progress callback for lifecycle events. */
	onEvent: (event: DeepResearchEvent) => void;
}

export type DeepResearchConfigInput = Partial<DeepResearchConfig>;

/** Aggregate token usage across every model call in a run. */
export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export type DeepResearchEvent =
	| { type: "clarification_needed"; question: string }
	| { type: "clarification_skipped" }
	| { type: "research_brief"; brief: string }
	| { type: "supervisor_iteration"; iteration: number; maxIterations: number }
	| { type: "researcher_start"; topic: string }
	| { type: "researcher_complete"; topic: string; compressedLength: number }
	| { type: "final_report_start" }
	| { type: "final_report_complete"; reportLength: number };

export interface DeepResearchResult {
	/** "clarification_needed" when the agent ended the run by asking the user a question. */
	status: "completed" | "clarification_needed";
	/** The final markdown report. Empty when clarification is needed. */
	finalReport: string;
	/** The clarifying question to relay to the user, when status is "clarification_needed". */
	clarificationQuestion?: string;
	/** The research brief generated from the conversation. */
	researchBrief: string;
	/** Compressed findings returned by each researcher (plus supervisor reflections). */
	notes: string[];
	/** Uncompressed raw notes captured from researcher transcripts. */
	rawNotes: string[];
	/** Outer conversation transcript (input messages plus generated replies). */
	messages: Message[];
	usage: UsageTotals;
}

/** Structured output of the clarification step. */
export interface ClarifyWithUser {
	need_clarification: boolean;
	question: string;
	verification: string;
}

/** Structured output of the research-brief step. */
export interface ResearchQuestion {
	researchBrief: string;
}

/** Structured summary of a single webpage. */
export interface WebpageSummary {
	summary: string;
	keyExcerpts: string;
}
export const clarifyWithUserSchema = z.object({
	need_clarification: z.boolean().describe("Whether the user needs to be asked a clarifying question."),
	question: z.string().describe("A question to ask the user to clarify the report scope"),
	verification: z
		.string()
		.describe("Verify message that we will start research after the user has provided the necessary information."),
});

export const researchQuestionSchema = z.object({
	research_brief: z.string().describe("A research question that will be used to guide the research."),
});

export const webpageSummarySchema = z.object({
	summary: z.string(),
	key_excerpts: z.string(),
});
