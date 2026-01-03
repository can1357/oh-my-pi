/**
 * Exa Researcher Tools
 *
 * Async research tasks with polling for completion.
 */

import { Type } from "@sinclair/typebox";
import type { CustomTool } from "../../custom-tools/types";
import { callExaTool, findApiKey } from "./mcp-client";
import type { ExaRenderDetails } from "./types";

const researcherStartTool: CustomTool<any, ExaRenderDetails> = {
	name: "exa_researcher_start",
	label: "Start Deep Research",
	description:
		"Start an asynchronous deep research task using Exa's researcher. Returns a task_id for polling completion.",
	parameters: Type.Object({
		query: Type.String({ description: "Research query to investigate" }),
		depth: Type.Optional(
			Type.Number({
				description: "Research depth (1-5, default: 3)",
				minimum: 1,
				maximum: 5,
			}),
		),
		breadth: Type.Optional(
			Type.Number({
				description: "Research breadth (1-5, default: 3)",
				minimum: 1,
				maximum: 5,
			}),
		),
	}),
	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		try {
			const apiKey = await findApiKey();
			if (!apiKey) {
				return {
					content: [{ type: "text" as const, text: "Error: EXA_API_KEY not found" }],
					details: { error: "EXA_API_KEY not found", toolName: "exa_researcher_start" },
				};
			}
			const result = await callExaTool("deep_researcher_start", params as Record<string, unknown>, apiKey);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				details: { raw: result, toolName: "exa_researcher_start" },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text" as const, text: `Error: ${message}` }],
				details: { error: message, toolName: "exa_researcher_start" },
			};
		}
	},
};

const researcherPollTool: CustomTool<any, ExaRenderDetails> = {
	name: "exa_researcher_poll",
	label: "Poll Research Status",
	description:
		"Poll the status of an asynchronous research task. Returns status (pending|running|completed|failed) and result if completed.",
	parameters: Type.Object({
		task_id: Type.String({ description: "Task ID returned from exa_researcher_start" }),
	}),
	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		try {
			const apiKey = await findApiKey();
			if (!apiKey) {
				return {
					content: [{ type: "text" as const, text: "Error: EXA_API_KEY not found" }],
					details: { error: "EXA_API_KEY not found", toolName: "exa_researcher_poll" },
				};
			}
			const result = await callExaTool("deep_researcher_check", params as Record<string, unknown>, apiKey);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
				details: { raw: result, toolName: "exa_researcher_poll" },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text" as const, text: `Error: ${message}` }],
				details: { error: message, toolName: "exa_researcher_poll" },
			};
		}
	},
};

export const researcherTools: CustomTool<any, ExaRenderDetails>[] = [researcherStartTool, researcherPollTool];
