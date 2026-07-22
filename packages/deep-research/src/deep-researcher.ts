import { type AssistantMessage, completeSimple, type Message } from "@pk-nerdsaver-ai/pi-ai";
import { createRunContext, type RunContext } from "./config";
import { accumulateUsage, getBufferString, messageText, userMessage } from "./messages";
import { prompts } from "./prompts";
import { runSupervisor } from "./supervisor";
import { completeStructured } from "./tools";
import type { DeepResearchConfigInput, DeepResearchResult } from "./types";
import { clarifyWithUserSchema, researchQuestionSchema } from "./types";
import { completionErrorMessage, getTodayStr, isTokenLimitExceeded } from "./utils";

const FINAL_REPORT_MAX_RETRIES = 3;

/**
 * Run the full deep research pipeline:
 * clarify → research brief → supervisor with parallel researchers → final report.
 */
export async function runDeepResearch(
	query: string | Message[],
	configInput: DeepResearchConfigInput = {},
): Promise<DeepResearchResult> {
	const run = createRunContext(configInput);
	const { config } = run;
	const messages: Message[] = typeof query === "string" ? [userMessage(query)] : [...query];
	const date = getTodayStr();

	// Step 1: optionally assess whether a clarifying question is needed.
	if (config.allowClarification) {
		const { value, message } = await completeStructured({
			model: run.models.research,
			context: { messages: [userMessage(prompts.clarifyWithUser({ messages: getBufferString(messages), date }))] },
			tool: {
				name: "ClarifyWithUser",
				description: "Model for user clarification requests.",
				parameters: clarifyWithUserSchema,
			},
			schema: clarifyWithUserSchema,
			maxTokens: config.researchModelMaxTokens,
			maxRetries: config.maxStructuredOutputRetries,
			options: config.modelOptions,
		});
		accumulateUsage(run.usage, message);

		if (value.need_clarification) {
			config.onEvent({ type: "clarification_needed", question: value.question });
			return {
				status: "clarification_needed",
				finalReport: "",
				clarificationQuestion: value.question,
				researchBrief: "",
				notes: [],
				rawNotes: [],
				messages: [...messages, assistantTextMessage(run, value.question)],
				usage: run.usage,
			};
		}
		messages.push(assistantTextMessage(run, value.verification));
	} else {
		config.onEvent({ type: "clarification_skipped" });
	}

	// Step 2: translate the conversation into a focused research brief.
	const briefResult = await completeStructured({
		model: run.models.research,
		context: { messages: [userMessage(prompts.researchBrief({ messages: getBufferString(messages), date }))] },
		tool: {
			name: "ResearchQuestion",
			description: "Research question and brief for guiding research.",
			parameters: researchQuestionSchema,
		},
		schema: researchQuestionSchema,
		maxTokens: config.researchModelMaxTokens,
		maxRetries: config.maxStructuredOutputRetries,
		options: config.modelOptions,
	});
	accumulateUsage(run.usage, briefResult.message);
	const researchBrief = briefResult.value.research_brief;
	config.onEvent({ type: "research_brief", brief: researchBrief });

	// Step 3: supervisor-driven research with parallel researcher sub-agents.
	const { notes, rawNotes } = await runSupervisor(run, researchBrief);

	// Step 4: final report with progressive truncation on context overflow.
	config.onEvent({ type: "final_report_start" });
	const finalReport = await generateFinalReport(run, researchBrief, messages, notes.join("\n"));
	config.onEvent({ type: "final_report_complete", reportLength: finalReport.length });

	return {
		status: "completed",
		finalReport,
		researchBrief,
		notes,
		rawNotes,
		messages,
		usage: run.usage,
	};
}

/** A reusable researcher with pre-resolved config and models. */
export function createDeepResearcher(config: DeepResearchConfigInput = {}) {
	return {
		run: (query: string | Message[]) => runDeepResearch(query, config),
	};
}

function assistantTextMessage(run: RunContext, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: run.models.research.api,
		provider: run.models.research.provider,
		model: run.models.research.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function generateFinalReport(
	run: RunContext,
	researchBrief: string,
	messages: Message[],
	initialFindings: string,
): Promise<string> {
	const { config } = run;
	let findings = initialFindings;
	let findingsCharLimit: number | null = null;

	for (let retry = 0; retry <= FINAL_REPORT_MAX_RETRIES; retry++) {
		const prompt = prompts.finalReport({
			research_brief: researchBrief,
			messages: getBufferString(messages),
			findings,
			date: getTodayStr(),
		});
		try {
			const response = await completeSimple(
				run.models.finalReport,
				{ messages: [userMessage(prompt)] },
				{ ...config.modelOptions, maxTokens: config.finalReportModelMaxTokens },
			);
			if (response.stopReason === "error") {
				if (!isTokenLimitExceeded(response, run.models.finalReport.contextWindow)) {
					return `Error generating final report: ${response.errorMessage ?? "unknown error"}`;
				}
				accumulateUsage(run.usage, response);
				const shrunk = shrinkFindings(findings, findingsCharLimit, run.models.finalReport.contextWindow, retry);
				if (typeof shrunk === "string") return shrunk;
				findings = shrunk.findings;
				findingsCharLimit = shrunk.charLimit;
				continue;
			}
			accumulateUsage(run.usage, response);
			return messageText(response);
		} catch (error) {
			const failed = completionErrorMessage(error);
			if (failed && isTokenLimitExceeded(failed, run.models.finalReport.contextWindow)) {
				const shrunk = shrinkFindings(findings, findingsCharLimit, run.models.finalReport.contextWindow, retry);
				if (typeof shrunk === "string") return shrunk;
				findings = shrunk.findings;
				findingsCharLimit = shrunk.charLimit;
				continue;
			}
			return `Error generating final report: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	return "Error generating final report: Maximum retries exceeded";
}

/**
 * Port of the Python retry shrink: first retry uses contextWindow * 4 chars as
 * the findings budget, subsequent retries reduce it by 10% each time.
 * Returns an error string when the model's context window is unknown.
 */
function shrinkFindings(
	findings: string,
	currentCharLimit: number | null,
	contextWindow: number | null,
	retry: number,
): { findings: string; charLimit: number } | string {
	if (retry === 0) {
		if (!contextWindow) {
			return (
				"Error generating final report: Token limit exceeded, however, we could not determine the model's maximum " +
				"context length. Please pick a final report model with a known context window."
			);
		}
		const charLimit = contextWindow * 4;
		return { findings: findings.slice(0, charLimit), charLimit };
	}
	const baseCharLimit = currentCharLimit ?? (contextWindow ? contextWindow * 4 : findings.length);
	const charLimit = Math.floor(baseCharLimit * 0.9);
	return { findings: findings.slice(0, charLimit), charLimit };
}
