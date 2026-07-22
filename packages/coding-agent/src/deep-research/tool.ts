/**
 * deep_research tool — launches the pi-deep-research pipeline in-session.
 *
 * Uses the session's active model for every pipeline role and routes researcher
 * searches through the omp web search subsystem, so no extra configuration is
 * needed beyond what the session already has.
 */
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@pk-nerdsaver-ai/pi-agent-core";
import {
	type DeepResearchEvent,
	type ResearchTool,
	runDeepResearch,
	type UsageTotals,
} from "@pk-nerdsaver-ai/pi-deep-research";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import deepResearchDescription from "../prompts/tools/deep-research.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { createOmpSearchTool } from "./search-adapter";

export const deepResearchSchema = type({
	question: "string",
	max_researchers: "number?",
});

export type DeepResearchToolParams = typeof deepResearchSchema.infer;

export interface DeepResearchRenderDetails {
	status: "completed" | "clarification_needed" | "error";
	question: string;
	progress: string;
	brief?: string;
	researchersStarted?: number;
	researchersCompleted?: number;
	notesCount?: number;
	usage?: UsageTotals;
	error?: string;
}

/** Builds the researcher search tool; injectable for tests. */
export type DeepResearchSearchToolFactory = (session: ToolSession) => ResearchTool;

const defaultSearchToolFactory: DeepResearchSearchToolFactory = session =>
	createOmpSearchTool({
		authStorage: session.authStorage,
		sessionId: session.getSessionId?.() ?? undefined,
	});

function progressLine(event: DeepResearchEvent, started: number, completed: number): string | undefined {
	switch (event.type) {
		case "research_brief":
			return `Research brief ready (${event.brief.length} chars)`;
		case "supervisor_iteration":
			return `Supervisor planning, iteration ${event.iteration}/${event.maxIterations}`;
		case "researcher_start":
			return `Researching: ${event.topic.slice(0, 120)}`;
		case "researcher_complete":
			return `Researcher finished (${completed}/${started})`;
		case "final_report_start":
			return "Writing final report…";
		default:
			return undefined;
	}
}

export class DeepResearchTool implements AgentTool<typeof deepResearchSchema, DeepResearchRenderDetails> {
	readonly name = "deep_research";
	readonly approval = "read" as const;
	readonly label = "Deep Research";
	readonly description: string;
	readonly parameters = deepResearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Run multi-step deep web research and produce a cited report";

	#session: ToolSession;
	#createSearchTool: DeepResearchSearchToolFactory;

	constructor(session: ToolSession, createSearchTool: DeepResearchSearchToolFactory = defaultSearchToolFactory) {
		this.#session = session;
		this.#createSearchTool = createSearchTool;
		this.description = prompt.render(deepResearchDescription);
	}

	async execute(
		_toolCallId: string,
		params: DeepResearchToolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<DeepResearchRenderDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<DeepResearchRenderDetails>> {
		const model = this.#session.getActiveModel?.();
		if (!model) {
			const error = "Deep research requires an active session model, but none is set.";
			return {
				content: [{ type: "text", text: `Error: ${error}` }],
				details: { status: "error", question: params.question, progress: "", error },
				isError: true,
			};
		}

		let progress = "Starting deep research…";
		let researchersStarted = 0;
		let researchersCompleted = 0;
		const emit = (event: DeepResearchEvent): void => {
			if (event.type === "researcher_start") researchersStarted += 1;
			if (event.type === "researcher_complete") researchersCompleted += 1;
			const line = progressLine(event, researchersStarted, researchersCompleted);
			if (!line) return;
			progress = line;
			onUpdate?.({
				content: [{ type: "text", text: progress }],
				details: {
					status: "completed",
					question: params.question,
					progress,
					researchersStarted,
					researchersCompleted,
				},
			});
		};

		try {
			const result = await runDeepResearch(params.question, {
				researchModel: model,
				summarizationModel: model,
				compressionModel: model,
				finalReportModel: model,
				allowClarification: false,
				maxConcurrentResearchUnits: params.max_researchers ?? 5,
				searchApi: "none",
				searchTool: this.#createSearchTool(this.#session),
				modelOptions: signal ? { signal } : {},
				onEvent: emit,
			});

			if (result.status === "clarification_needed") {
				const text =
					"The research pipeline determined the question needs clarification before it can proceed. " +
					`Ask the user this question, then re-run deep_research with the refined question:\n\n${result.clarificationQuestion}`;
				return {
					content: [{ type: "text", text }],
					details: {
						status: "clarification_needed",
						question: params.question,
						progress,
						brief: result.researchBrief,
						researchersStarted,
						researchersCompleted,
						usage: result.usage,
					},
				};
			}

			return {
				content: [{ type: "text", text: result.finalReport }],
				details: {
					status: "completed",
					question: params.question,
					progress: "Report complete",
					brief: result.researchBrief,
					researchersStarted,
					researchersCompleted,
					notesCount: result.notes.length,
					usage: result.usage,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Error: deep research failed: ${message}` }],
				details: { status: "error", question: params.question, progress, error: message },
				isError: true,
			};
		}
	}
}
