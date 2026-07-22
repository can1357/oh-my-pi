import { type Context, completeSimple, type Message } from "@pk-nerdsaver-ai/pi-ai";
import type { RunContext } from "./config";
import { accumulateUsage, getNotesFromToolCalls, toolCallsOf, toolResultMessage, userMessage } from "./messages";
import { prompts } from "./prompts";
import { runResearcher } from "./researcher";
import {
	CONDUCT_RESEARCH_TOOL_NAME,
	conductResearchTool,
	RESEARCH_COMPLETE_TOOL_NAME,
	researchCompleteTool,
	THINK_TOOL_NAME,
	thinkTool,
} from "./tools";
import { getTodayStr } from "./utils";

export interface SupervisorOutput {
	notes: string[];
	rawNotes: string[];
}

const SUPERVISOR_TOOLS = [conductResearchTool, researchCompleteTool, thinkTool];

/** Run the supervisor: delegate research topics to parallel researcher sub-agents until satisfied. */
export async function runSupervisor(run: RunContext, researchBrief: string): Promise<SupervisorOutput> {
	const { config } = run;
	const systemPrompt = prompts.leadResearcher({
		date: getTodayStr(),
		max_concurrent_research_units: config.maxConcurrentResearchUnits,
		max_researcher_iterations: config.maxResearcherIterations,
	});

	const supervisorMessages: Message[] = [userMessage(researchBrief)];
	const rawNotes: string[] = [];

	for (let iteration = 1; ; iteration++) {
		config.onEvent({ type: "supervisor_iteration", iteration, maxIterations: config.maxResearcherIterations });

		const context: Context = { systemPrompt: [systemPrompt], messages: supervisorMessages, tools: SUPERVISOR_TOOLS };
		const response = await completeSimple(run.models.research, context, {
			...config.modelOptions,
			maxTokens: config.researchModelMaxTokens,
		});
		if (response.stopReason === "error") {
			throw new Error(response.errorMessage ?? "Supervisor model request failed");
		}
		accumulateUsage(run.usage, response);
		supervisorMessages.push(response);

		const calls = toolCallsOf(response);
		const researchCompleteCalled = calls.some(call => call.name === RESEARCH_COMPLETE_TOOL_NAME);
		if (iteration > config.maxResearcherIterations || calls.length === 0 || researchCompleteCalled) {
			return { notes: getNotesFromToolCalls(supervisorMessages), rawNotes };
		}

		// think_tool calls: acknowledge the reflection and keep going.
		for (const call of calls.filter(call => call.name === THINK_TOOL_NAME)) {
			supervisorMessages.push(
				toolResultMessage(call, `Reflection recorded: ${String(call.arguments.reflection ?? "")}`),
			);
		}

		// ConductResearch calls: run researchers in parallel up to the concurrency budget.
		const researchCalls = calls.filter(call => call.name === CONDUCT_RESEARCH_TOOL_NAME);
		if (researchCalls.length > 0) {
			const allowed = researchCalls.slice(0, config.maxConcurrentResearchUnits);
			const overflow = researchCalls.slice(config.maxConcurrentResearchUnits);

			const results = await Promise.all(
				allowed.map(async call => {
					const topic = String(call.arguments.research_topic ?? "");
					config.onEvent({ type: "researcher_start", topic });
					try {
						const output = await runResearcher(run, topic);
						config.onEvent({
							type: "researcher_complete",
							topic,
							compressedLength: output.compressedResearch.length,
						});
						return { call, output };
					} catch (error) {
						return {
							call,
							output: {
								compressedResearch: `Error synthesizing research report: ${error instanceof Error ? error.message : String(error)}`,
								rawNotes: [] as string[],
							},
						};
					}
				}),
			);

			for (const { call, output } of results) {
				supervisorMessages.push(toolResultMessage(call, output.compressedResearch));
			}
			for (const call of overflow) {
				supervisorMessages.push(
					toolResultMessage(
						call,
						`Error: Did not run this research as you have already exceeded the maximum number of concurrent research units. ` +
							`Please try again with ${config.maxConcurrentResearchUnits} or fewer research units.`,
						true,
					),
				);
			}

			const combined = results
				.flatMap(({ output }) => output.rawNotes)
				.filter(notes => notes.length > 0)
				.join("\n");
			if (combined.length > 0) rawNotes.push(combined);
		}
	}
}
