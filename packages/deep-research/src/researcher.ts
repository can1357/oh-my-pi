import { type AssistantMessage, type Context, completeSimple, type Message } from "@pk-nerdsaver-ai/pi-ai";
import type { RunContext } from "./config";
import {
	accumulateUsage,
	messageText,
	rawNotesOf,
	removeUpToLastAssistantMessage,
	toolCallsOf,
	toolResultMessage,
	userMessage,
} from "./messages";
import { prompts } from "./prompts";
import { createTavilySearchTool } from "./tavily";
import { RESEARCH_COMPLETE_TOOL_NAME, researchCompleteTool, thinkTool } from "./tools";
import type { ResearchTool } from "./types";
import { completionErrorMessage, getTodayStr, isTokenLimitExceeded } from "./utils";

export interface ResearcherOutput {
	compressedResearch: string;
	rawNotes: string[];
}

const COMPRESSION_MAX_ATTEMPTS = 3;
const COMPRESSION_FAILURE_TEXT = "Error synthesizing research report: Maximum retries exceeded";

/** The search tool a researcher gets: the injected host tool wins over the configured backend. */
export function researcherSearchTool(run: RunContext): ResearchTool | undefined {
	if (run.config.searchTool) return run.config.searchTool;
	if (run.config.searchApi === "tavily") return createTavilySearchTool(run);
	return undefined;
}

/** All tools a researcher may call: ResearchComplete, think_tool, search, and configured extras. */
export function researcherTools(run: RunContext): ResearchTool[] {
	const tools: ResearchTool[] = [
		{ tool: researchCompleteTool, execute: () => "Research complete." },
		{ tool: thinkTool, execute: args => `Reflection recorded: ${String(args.reflection ?? "")}` },
	];
	const searchTool = researcherSearchTool(run);
	if (searchTool) tools.push(searchTool);
	const existingNames = new Set(tools.map(entry => entry.tool.name));
	for (const extra of run.config.extraTools) {
		if (!existingNames.has(extra.tool.name)) tools.push(extra);
	}
	return tools;
}

/** Run one researcher sub-agent on a topic: tool-calling loop, then compression of findings. */
export async function runResearcher(run: RunContext, topic: string): Promise<ResearcherOutput> {
	const { config } = run;
	const tools = researcherTools(run);
	if (tools.length === 0) {
		throw new Error(
			"No tools found to conduct research: Please configure either your search API or add extra tools to your configuration.",
		);
	}
	const toolsByName = new Map(tools.map(entry => [entry.tool.name, entry]));
	const searchTool = researcherSearchTool(run);

	const systemPrompt = prompts.researcherSystem({
		date: getTodayStr(),
		extra_tool_prompt: config.extraToolInstructions,
		search_tool_name: searchTool?.tool.name ?? "web_search",
	});
	const messages: Message[] = [userMessage(topic)];

	let toolCallIterations = 0;
	for (;;) {
		const context: Context = { systemPrompt: [systemPrompt], messages, tools: tools.map(entry => entry.tool) };
		const response = await completeSimple(run.models.research, context, {
			...config.modelOptions,
			maxTokens: config.researchModelMaxTokens,
		});
		if (response.stopReason === "error") {
			const overflow = isTokenLimitExceeded(response, run.models.research.contextWindow);
			if (!overflow) throw new Error(response.errorMessage ?? "Researcher model request failed");
		}
		accumulateUsage(run.usage, response);
		messages.push(response);

		const calls = toolCallsOf(response);
		if (calls.length === 0) break;

		toolCallIterations += 1;
		const results = await Promise.all(
			calls.map(async call => {
				const target = toolsByName.get(call.name);
				if (!target) return toolResultMessage(call, `Error executing tool: unknown tool "${call.name}"`, true);
				try {
					return toolResultMessage(call, await target.execute(call.arguments));
				} catch (error) {
					return toolResultMessage(
						call,
						`Error executing tool: ${error instanceof Error ? error.message : String(error)}`,
						true,
					);
				}
			}),
		);
		messages.push(...results);

		const researchCompleteCalled = calls.some(call => call.name === RESEARCH_COMPLETE_TOOL_NAME);
		if (toolCallIterations >= config.maxReactToolCalls || researchCompleteCalled) break;
	}

	return compressResearch(run, messages);
}

/** Distill a researcher transcript into cleaned findings, shrinking history on context overflow. */
async function compressResearch(run: RunContext, researcherMessages: Message[]): Promise<ResearcherOutput> {
	const { config } = run;
	const attemptMessages = [...researcherMessages, userMessage(prompts.compressResearchHuman())];
	const systemPrompt = prompts.compressResearchSystem({ date: getTodayStr() });

	let messages = attemptMessages;
	for (let attempt = 0; attempt < COMPRESSION_MAX_ATTEMPTS; attempt++) {
		let response: AssistantMessage;
		try {
			response = await completeSimple(
				run.models.compression,
				{ systemPrompt: [systemPrompt], messages },
				{ ...config.modelOptions, maxTokens: config.compressionModelMaxTokens },
			);
		} catch (error) {
			const failed = completionErrorMessage(error);
			if (failed && isTokenLimitExceeded(failed, run.models.compression.contextWindow)) {
				messages = removeUpToLastAssistantMessage(messages);
			}
			continue;
		}
		if (response.stopReason === "error") {
			if (isTokenLimitExceeded(response, run.models.compression.contextWindow)) {
				messages = removeUpToLastAssistantMessage(messages);
			}
			continue;
		}
		accumulateUsage(run.usage, response);
		return { compressedResearch: messageText(response), rawNotes: [rawNotesOf(researcherMessages)] };
	}

	return { compressedResearch: COMPRESSION_FAILURE_TEXT, rawNotes: [rawNotesOf(researcherMessages)] };
}
