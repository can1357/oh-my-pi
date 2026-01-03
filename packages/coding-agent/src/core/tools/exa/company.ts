/**
 * Exa Company Tool
 *
 * Research companies using Exa's comprehensive data sources.
 */

import { Type } from "@sinclair/typebox";
import type { CustomTool } from "../../custom-tools/types";
import type { ExaRenderDetails } from "./types";

/** exa_company - Company research */
export const companyTool: CustomTool<any, ExaRenderDetails> = {
	name: "exa_company",
	label: "Exa Company",
	description: `Research companies using Exa's comprehensive data sources.

Returns detailed company information including overview, news, financials, and key people.

Parameters:
- company_name: Name of the company to research (e.g., "OpenAI", "Google", "Y Combinator")`,

	parameters: Type.Object({
		company_name: Type.String({ description: "Name of the company to research" }),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		try {
			const { findApiKey, callExaTool, formatSearchResults, isSearchResponse } = await import("./mcp-client.js");

			const apiKey = await findApiKey();
			if (!apiKey) {
				return {
					content: [{ type: "text" as const, text: "Error: EXA_API_KEY not found" }],
					details: { error: "EXA_API_KEY not found", toolName: "exa_company" },
				};
			}
			const response = await callExaTool("company_research", params, apiKey);

			if (isSearchResponse(response)) {
				const formatted = formatSearchResults(response);
				return {
					content: [{ type: "text" as const, text: formatted }],
					details: { response, toolName: "exa_company" },
				};
			}

			return {
				content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
				details: { raw: response, toolName: "exa_company" },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text" as const, text: `Error: ${message}` }],
				details: { error: message, toolName: "exa_company" },
			};
		}
	},
};
