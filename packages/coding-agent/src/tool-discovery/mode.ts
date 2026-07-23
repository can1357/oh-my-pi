import type { Settings } from "../config/settings";
import type { SettingValue } from "../config/settings-schema";

export const TOOL_DISCOVERY_AUTO_THRESHOLD = 40;
/**
 * Schema-token budget for auto discovery: tool count is a poor proxy for
 * context spend (a handful of MCP tools with deep JSON schemas can outweigh
 * dozens of built-ins), so auto mode also flips to mcp-only discovery when
 * the estimated wire tokens of every registered tool schema cross this
 * budget (~8% of a 200K window).
 */
/** Maximum active wire-schema spend after progressive discovery. */
export const TOOL_DISCOVERY_SCHEMA_TOKEN_BUDGET = 16_000;
export const TOOL_DISCOVERY_AUTO_SCHEMA_TOKENS = TOOL_DISCOVERY_SCHEMA_TOKEN_BUDGET;
export const TOOL_DISCOVERY_SEARCH_TOOL_NAME = "search_tool_bm25";

export type ToolDiscoveryModeSetting = SettingValue<"tools.discoveryMode">;
export type EffectiveToolDiscoveryMode = Exclude<ToolDiscoveryModeSetting, "auto">;

export function countToolsForAutoDiscovery(toolNames: Iterable<string>): number {
	let count = 0;
	for (const name of toolNames) {
		if (name !== TOOL_DISCOVERY_SEARCH_TOOL_NAME) count++;
	}
	return count;
}

export function resolveEffectiveToolDiscoveryMode(
	settings: Settings,
	toolCount: number,
	schemaTokens?: number,
): EffectiveToolDiscoveryMode {
	const configuredMode = settings.get("tools.discoveryMode");
	if (configuredMode === "all" || configuredMode === "mcp-only") return configuredMode;
	if (settings.get("mcp.discoveryMode")) return "mcp-only";
	if (
		configuredMode === "auto" &&
		(toolCount > TOOL_DISCOVERY_AUTO_THRESHOLD ||
			(schemaTokens !== undefined && schemaTokens > TOOL_DISCOVERY_AUTO_SCHEMA_TOKENS))
	) {
		return "mcp-only";
	}
	return "off";
}
