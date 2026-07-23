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
import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import {
	type DeepResearchEvent,
	type ResearchTool,
	runDeepResearch,
	type UsageTotals,
} from "@pk-nerdsaver-ai/pi-deep-research";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import { parseModelString } from "../config/model-resolver";
import deepResearchDescription from "../prompts/tools/deep-research.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { createOmpSearchTool } from "./search-adapter";

export const deepResearchSchema = type({
	question: "string",
	max_researchers: "number?",
	model: "string?",
	max_total_tokens: "number?",
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
	budgetExhausted?: boolean;
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
		case "budget_cooldown":
			return `Cooling down ${Math.round(event.delayMs / 1000)}s (${event.usedTokens}/${event.maxTotalTokens} tokens used)`;
		case "budget_exhausted":
			return `Token budget reached (${event.usedTokens}/${event.maxTotalTokens}) — wrapping up with findings so far`;
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
		const settings = this.#session.settings;
		const modelError = (error: string): AgentToolResult<DeepResearchRenderDetails> => ({
			content: [{ type: "text", text: `Error: ${error}` }],
			details: { status: "error", question: params.question, progress: "", error },
			isError: true,
		});

		const resolveSpec = (spec: string, origin: string): Model | AgentToolResult<DeepResearchRenderDetails> => {
			const registry = this.#session.modelRegistry;
			if (!registry) return modelError(`Cannot resolve ${origin} "${spec}": no model registry is available.`);
			const parsed = parseModelString(spec);
			if (!parsed) {
				return modelError(
					`Invalid ${origin} "${spec}". Expected "provider/model-id" (e.g. "anthropic/claude-sonnet-4-5").`,
				);
			}
			const found = registry.find(parsed.provider, parsed.id);
			if (!found) {
				return modelError(
					`Unknown ${origin} "${spec}" — not found in the model registry. Use "provider/model-id" for any model available to omp.`,
				);
			}
			return found;
		};

		const baseSpec = params.model?.trim() || (settings.get("deepResearch.model") ?? "").trim();
		let model: Model | undefined;
		if (baseSpec) {
			const resolved = resolveSpec(
				baseSpec,
				params.model?.trim() ? "model parameter" : "deepResearch.model setting",
			);
			if (!("provider" in resolved)) return resolved;
			model = resolved;
		} else {
			model = this.#session.getActiveModel?.();
		}
		if (!model) {
			return modelError("Deep research requires an active session model, but none is set.");
		}
		const baseModel = model;

		const roleModel = (
			key: "deepResearch.summarizationModel" | "deepResearch.compressionModel" | "deepResearch.reportModel",
		): Model | AgentToolResult<DeepResearchRenderDetails> => {
			const spec = (settings.get(key) ?? "").trim();
			if (!spec) return baseModel;
			return resolveSpec(spec, `${key} setting`);
		};
		const summarizationModel = roleModel("deepResearch.summarizationModel");
		if (!("provider" in summarizationModel)) return summarizationModel;
		const compressionModel = roleModel("deepResearch.compressionModel");
		if (!("provider" in compressionModel)) return compressionModel;
		const reportModel = roleModel("deepResearch.reportModel");
		if (!("provider" in reportModel)) return reportModel;

		const configuredBudget = params.max_total_tokens ?? settings.get("deepResearch.maxTotalTokens");
		const maxTotalTokens = configuredBudget > 0 ? configuredBudget : undefined;
		const cooldownMs = Math.max(0, settings.get("deepResearch.cooldownMs"));

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
				summarizationModel,
				compressionModel,
				finalReportModel: reportModel,
				allowClarification: false,
				maxConcurrentResearchUnits: params.max_researchers ?? 5,
				maxTotalTokens,
				cooldownMs,
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

			const budgetNote = result.budgetExhausted
				? `\n\n> Note: the run's token budget (${maxTotalTokens} tokens) was reached before research finished; this report is based on the findings gathered up to that point.`
				: "";
			return {
				content: [{ type: "text", text: result.finalReport + budgetNote }],
				details: {
					status: "completed",
					question: params.question,
					progress: "Report complete",
					brief: result.researchBrief,
					researchersStarted,
					researchersCompleted,
					notesCount: result.notes.length,
					usage: result.usage,
					budgetExhausted: result.budgetExhausted,
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
