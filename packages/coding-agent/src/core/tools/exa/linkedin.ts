/**
 * Exa LinkedIn Tool
 *
 * Search LinkedIn for people, companies, and professional content.
 */

import { Type } from "@sinclair/typebox";
import type { CustomTool } from "../../custom-tools/types";
import type { ExaRenderDetails } from "./types";

/** exa_linkedin - LinkedIn search */
export const linkedinTool: CustomTool<any, ExaRenderDetails> = {
	name: "exa_linkedin",
	label: "Exa LinkedIn",
	description: `Search LinkedIn for people, companies, and professional content using Exa.

Returns LinkedIn search results with profiles, posts, and company information.

Parameters:
- query: LinkedIn search query (e.g., "Software Engineer at OpenAI", "Y Combinator companies")`,

	parameters: Type.Object({
		query: Type.String({ description: "LinkedIn search query" }),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		try {
			const { findApiKey, callExaTool, formatSearchResults, isSearchResponse } = await import("./mcp-client.js");

			const apiKey = await findApiKey();
			if (!apiKey) {
				return {
					content: [{ type: "text" as const, text: "Error: EXA_API_KEY not found" }],
					details: { error: "EXA_API_KEY not found", toolName: "exa_linkedin" },
				};
			}
			const response = await callExaTool("linkedin_search", params, apiKey);

			if (isSearchResponse(response)) {
				const formatted = formatSearchResults(response);
				return {
					content: [{ type: "text" as const, text: formatted }],
					details: { response, toolName: "exa_linkedin" },
				};
			}

			return {
				content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
				details: { raw: response, toolName: "exa_linkedin" },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text" as const, text: `Error: ${message}` }],
				details: { error: message, toolName: "exa_linkedin" },
			};
		}
	},
};
