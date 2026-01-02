/**
 * Exa MCP Tools
 *
 * 22 tools for Exa's MCP servers:
 * - 4 search tools (search, deep, code, crawl)
 * - 1 LinkedIn search tool
 * - 1 company research tool
 * - 2 researcher tools (start, poll)
 * - 14 websets tools (CRUD, items, search, enrichment, monitor)
 */

import type { CustomTool } from "../../custom-tools/types.js";
import type { ExaSettings } from "../../settings-manager.js";
import { companyTool } from "./company.js";
import { linkedinTool } from "./linkedin.js";
import { researcherTools } from "./researcher.js";
import { searchTools } from "./search.js";
import type { ExaRenderDetails } from "./types.js";
import { websetsTools } from "./websets.js";

/** All Exa tools (22 total) - static export for backward compatibility */
export const exaTools: CustomTool<any, ExaRenderDetails>[] = [
	...searchTools,
	linkedinTool,
	companyTool,
	...researcherTools,
	...websetsTools,
];

/** Get Exa tools filtered by settings */
export function getExaTools(settings: Required<ExaSettings>): CustomTool<any, ExaRenderDetails>[] {
	if (!settings.enabled) return [];

	const tools: CustomTool<any, ExaRenderDetails>[] = [];

	if (settings.enableSearch) tools.push(...searchTools);
	if (settings.enableLinkedin) tools.push(linkedinTool);
	if (settings.enableCompany) tools.push(companyTool);
	if (settings.enableResearcher) tools.push(...researcherTools);
	if (settings.enableWebsets) tools.push(...websetsTools);

	return tools;
}

export { companyTool } from "./company.js";
export { linkedinTool } from "./linkedin.js";
export { logExaError, logViewError } from "./logger.js";
export {
	callExaTool,
	callWebsetsTool,
	createMCPToolFromServer,
	createMCPWrappedTool,
	fetchMCPToolSchema,
	findApiKey,
	formatSearchResults,
	isSearchResponse,
} from "./mcp-client.js";
export { renderExaCall, renderExaResult } from "./render.js";
export { researcherTools } from "./researcher.js";
// Re-export individual modules for selective importing
export { searchTools } from "./search.js";
// Re-export types and utilities
export type { ExaRenderDetails, ExaSearchResponse, ExaSearchResult, MCPToolWrapperConfig } from "./types.js";
export { websetsTools } from "./websets.js";
