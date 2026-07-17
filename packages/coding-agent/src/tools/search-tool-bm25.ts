import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@pk-nerdsaver-ai/pi-agent-core";
import type { Component } from "@pk-nerdsaver-ai/pi-tui";
import { Text } from "@pk-nerdsaver-ai/pi-tui";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import searchToolBm25Description from "../prompts/tools/search-tool-bm25.md" with { type: "text" };
import { resolveEffectiveToolDiscoveryMode } from "../tool-discovery/mode";
import {
	buildDiscoverableToolSearchIndex,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
	filterBySource,
	formatDiscoverableToolServerSummary,
	searchDiscoverableTools,
	summarizeDiscoverableTools,
} from "../tool-discovery/tool-index";
import { framedBlock, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { formatCount, formatExpandHint, formatMoreItems, replaceTabs, TRUNCATE_LENGTHS } from "./render-utils";
import { ToolError } from "./tool-errors";
import type { ResolvedToolProfile, ToolCapability, ToolSource } from "./tool-profiles";
import { isToolCapabilityAllowed } from "./tool-profiles";

const DEFAULT_LIMIT = 8;
const TOOL_DISCOVERY_TITLE = "Tool Discovery";
const COLLAPSED_MATCH_LIMIT = 5;
const MATCH_LABEL_LEN = 72;
const MATCH_DESCRIPTION_LEN = 96;

const searchToolBm25Schema = type({
	query: type("string").describe("tool search query"),
	"limit?": type("number>0").describe("max matches"),
});

type SearchToolBm25Params = typeof searchToolBm25Schema.infer;

interface SearchToolBm25Match {
	name: string;
	label: string;
	description: string;
	server_name?: string;
	mcp_tool_name?: string;
	schema_keys: string[];
	score: number;
}

export interface SearchToolBm25Details {
	query: string;
	limit: number;
	total_tools: number;
	activated_tools: string[];
	active_selected_tools: string[];
	tools: SearchToolBm25Match[];
}

function formatMatch(tool: DiscoverableTool, score: number): SearchToolBm25Match {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.summary,
		server_name: tool.serverName,
		mcp_tool_name: tool.mcpToolName,
		schema_keys: tool.schemaKeys,
		score: Number(score.toFixed(6)),
	};
}

function buildSearchToolBm25Content(details: SearchToolBm25Details): string {
	return JSON.stringify({
		query: details.query,
		activated_tools: details.activated_tools,
		match_count: details.tools.length,
		total_tools: details.total_tools,
	});
}

/** Get discoverable tools for description rendering. Falls back to empty array on error. */
function getDiscoverableToolsForDescription(session: ToolSession): DiscoverableTool[] {
	try {
		return session.getDiscoverableTools?.() ?? [];
	} catch {
		return [];
	}
}

function getDiscoverableToolSearchIndexForExecution(session: ToolSession): DiscoverableToolSearchIndex {
	try {
		const cached = session.getDiscoverableToolSearchIndex?.();
		if (cached) return cached;
	} catch {}
	return buildDiscoverableToolSearchIndex(getDiscoverableToolsForDescription(session));
}

/** Resolve the effective selected tool names (generic or legacy MCP). */
function getSelectedToolNames(session: ToolSession): string[] {
	if (session.getSelectedDiscoveredToolNames) {
		return session.getSelectedDiscoveredToolNames();
	}
	return session.getSelectedMCPToolNames?.() ?? [];
}

/** Activate tools (generic or legacy MCP fallback). */
async function activateTools(session: ToolSession, toolNames: string[]): Promise<string[]> {
	if (session.activateDiscoveredTools) {
		return session.activateDiscoveredTools(toolNames);
	}
	if (session.activateDiscoveredMCPTools) {
		return session.activateDiscoveredMCPTools(toolNames);
	}
	return [];
}

export type ToolCapabilityPredicate = (capability: ToolCapability) => boolean;

export interface SearchToolBm25Options {
	/** Frozen tool ceiling; when set, search/activation cannot exceed it. */
	toolProfile?: ResolvedToolProfile;
	/** Injected capability predicate; defaults to profile check when profile is set. */
	capabilityPredicate?: ToolCapabilityPredicate;
}

function discoverableSource(tool: DiscoverableTool): ToolSource {
	return tool.source;
}

function isDiscoverableAllowed(tool: DiscoverableTool, options: SearchToolBm25Options | undefined): boolean {
	const capability: ToolCapability = {
		source: discoverableSource(tool),
		name: tool.name,
	};
	if (options?.capabilityPredicate) {
		return options.capabilityPredicate(capability);
	}
	if (options?.toolProfile) {
		return isToolCapabilityAllowed(options.toolProfile, capability);
	}
	return true;
}

type DiscoveryExecutionSession = ToolSession & {
	_supportsDiscoveryExecution: true;
};

function supportsToolDiscoveryExecution(session: ToolSession): session is DiscoveryExecutionSession {
	// Supports generic discovery
	if (
		typeof session.isToolDiscoveryEnabled === "function" &&
		typeof session.getSelectedDiscoveredToolNames === "function" &&
		typeof session.activateDiscoveredTools === "function"
	) {
		return true;
	}
	// Supports legacy MCP discovery
	if (
		typeof session.isMCPDiscoveryEnabled === "function" &&
		typeof session.getSelectedMCPToolNames === "function" &&
		typeof session.activateDiscoveredMCPTools === "function"
	) {
		return true;
	}
	return false;
}

function isDiscoveryEnabled(session: ToolSession): boolean {
	if (typeof session.isToolDiscoveryEnabled === "function") {
		return session.isToolDiscoveryEnabled();
	}
	return session.isMCPDiscoveryEnabled?.() ?? false;
}

export function renderSearchToolBm25Description(discoverableTools: DiscoverableTool[] = []): string {
	const summary = summarizeDiscoverableTools(discoverableTools);
	const builtinToolNames = filterBySource(discoverableTools, "builtin")
		.map(t => t.name)
		.sort();
	return prompt.render(searchToolBm25Description, {
		discoverableToolCount: summary.toolCount,
		discoverableMCPServerSummaries: summary.servers.map(formatDiscoverableToolServerSummary),
		hasDiscoverableMCPServers: summary.servers.length > 0,
		discoverableBuiltinToolNames: builtinToolNames,
		hasDiscoverableBuiltinTools: builtinToolNames.length > 0,
	});
}

function renderMatchLines(match: SearchToolBm25Match, theme: Theme): string[] {
	const safeServerName = match.server_name ? replaceTabs(match.server_name) : undefined;
	const safeLabel = replaceTabs(match.label);
	const safeDescription = replaceTabs(match.description.trim());
	const metaParts: string[] = [];
	if (safeServerName) metaParts.push(theme.fg("muted", safeServerName));
	metaParts.push(theme.fg("dim", `score ${match.score.toFixed(3)}`));
	const metaSep = theme.fg("dim", theme.sep.dot);
	const metaSuffix = metaParts.length > 0 ? ` ${metaParts.join(metaSep)}` : "";
	const lines = [`${theme.fg("accent", truncateToWidth(safeLabel, MATCH_LABEL_LEN))}${metaSuffix}`];
	if (safeDescription) {
		lines.push(theme.fg("muted", truncateToWidth(safeDescription, MATCH_DESCRIPTION_LEN)));
	}
	return lines;
}

function renderMatchBullets(tools: SearchToolBm25Match[], expanded: boolean, theme: Theme): string[] {
	const shown = expanded ? tools.length : Math.min(tools.length, COLLAPSED_MATCH_LIMIT);
	const bullet = theme.fg("dim", theme.format.bullet);
	const lines: string[] = [];
	for (let i = 0; i < shown; i++) {
		const itemLines = renderMatchLines(tools[i]!, theme);
		lines.push(`${bullet} ${itemLines[0]}`);
		for (let j = 1; j < itemLines.length; j++) {
			lines.push(`  ${itemLines[j]}`);
		}
	}
	const remaining = tools.length - shown;
	if (remaining > 0) {
		const hint = formatExpandHint(theme, expanded, true);
		lines.push(`${theme.fg("muted", formatMoreItems(remaining, "tool"))}${hint ? ` ${hint}` : ""}`);
	}
	return lines;
}

function renderFallbackResult(text: string, theme: Theme): Component {
	const header = renderStatusLine({ icon: "warning", title: TOOL_DISCOVERY_TITLE }, theme);
	const bodyLines = (text || "Tool discovery completed")
		.split("\n")
		.map(line => theme.fg("dim", truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.LINE)));
	return new Text([header, ...bodyLines].join("\n"), 0, 0);
}

/**
 * SearchToolsTool — wire name `search_tool_bm25` (preserved for persisted session back-compat).
 *
 * When tools.discoveryMode === "all", this covers both MCP tools and built-in discoverable tools.
 * When tools.discoveryMode === "mcp-only" or mcp.discoveryMode === true, only MCP tools are searched.
 */
export class SearchToolBm25Tool implements AgentTool<typeof searchToolBm25Schema, SearchToolBm25Details> {
	readonly name = "search_tool_bm25";
	readonly approval = "read" as const;
	readonly label = "SearchTools";
	readonly loadMode = "essential";
	get description(): string {
		return renderSearchToolBm25Description(getDiscoverableToolsForDescription(this.session));
	}
	readonly parameters = searchToolBm25Schema;
	readonly strict = true;

	constructor(
		private readonly session: ToolSession,
		private readonly options: SearchToolBm25Options = {},
	) {}

	static create(session: ToolSession, options?: SearchToolBm25Options): SearchToolBm25Tool | null {
		if (options?.toolProfile && !options.toolProfile.allowDiscovery) return null;
		return supportsToolDiscoveryExecution(session) ? new SearchToolBm25Tool(session, options) : null;
	}

	static createIf(session: ToolSession, options?: SearchToolBm25Options): SearchToolBm25Tool | null {
		// Direct createTools() calls do not know the final MCP/extension catalog yet, so
		// auto mode is activated later by createAgentSession after the full registry exists.
		if (resolveEffectiveToolDiscoveryMode(session.settings, 0) === "off") return null;
		return SearchToolBm25Tool.create(session, options);
	}

	async execute(
		_toolCallId: string,
		params: SearchToolBm25Params,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchToolBm25Details>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchToolBm25Details>> {
		if (!supportsToolDiscoveryExecution(this.session)) {
			throw new ToolError("Tool discovery is unavailable in this session.");
		}
		if (!isDiscoveryEnabled(this.session)) {
			throw new ToolError(
				"Tool discovery is disabled. Enable tools.discoveryMode or mcp.discoveryMode to use search_tool_bm25.",
			);
		}

		const query = params.query.trim();
		if (query.length === 0) {
			throw new ToolError("Query is required and must not be empty.");
		}
		const limit = params.limit ?? DEFAULT_LIMIT;
		if (!Number.isInteger(limit) || limit <= 0) {
			throw new ToolError("Limit must be a positive integer.");
		}

		const searchIndex = getDiscoverableToolSearchIndexForExecution(this.session);
		const selectedToolNames = new Set(getSelectedToolNames(this.session));
		let ranked: Array<{ tool: DiscoverableTool; score: number }> = [];
		try {
			ranked = searchDiscoverableTools(searchIndex, query, searchIndex.documents.length)
				.filter(result => !selectedToolNames.has(result.tool.name))
				.filter(result => isDiscoverableAllowed(result.tool, this.options))
				.slice(0, limit);
		} catch (error) {
			if (error instanceof Error) {
				throw new ToolError(error.message);
			}
			throw error;
		}

		// Activation must re-check the same (source,name) capability before callbacks.
		const eligibleForActivation = ranked.filter(result => isDiscoverableAllowed(result.tool, this.options));
		const forbidden = ranked
			.filter(result => !isDiscoverableAllowed(result.tool, this.options))
			.map(result => result.tool.name);
		if (forbidden.length > 0) {
			throw new ToolError(`Tool activation denied by capability profile: ${forbidden.join(", ")}`);
		}

		const activated =
			eligibleForActivation.length > 0
				? await activateTools(
						this.session,
						eligibleForActivation.map(result => result.tool.name),
					)
				: [];

		const details: SearchToolBm25Details = {
			query,
			limit,
			total_tools: searchIndex.documents.length,
			activated_tools: activated,
			active_selected_tools: getSelectedToolNames(this.session),
			tools: eligibleForActivation.map(result => formatMatch(result.tool, result.score)),
		};

		return {
			content: [{ type: "text", text: buildSearchToolBm25Content(details) }],
			details,
		};
	}
}

export const searchToolBm25Renderer = {
	renderCall(args: SearchToolBm25Params, _options: RenderResultOptions, uiTheme: Theme): Component {
		const query = typeof args.query === "string" ? replaceTabs(args.query.trim()) : "";
		const meta = args.limit ? [`limit:${args.limit}`] : [];
		const header = renderStatusLine(
			{ icon: "pending", title: TOOL_DISCOVERY_TITLE, description: query || "(empty query)", meta },
			uiTheme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SearchToolBm25Details; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		if (!result.details) {
			const fallbackText = result.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.filter((text): text is string => typeof text === "string" && text.length > 0)
				.join("\n");
			return renderFallbackResult(fallbackText, uiTheme);
		}

		const { details } = result;
		const meta = [
			formatCount("match", details.tools.length),
			`${details.active_selected_tools.length} active`,
			`${details.total_tools} total`,
			`limit:${details.limit}`,
		];
		const safeQuery = replaceTabs(details.query);
		const header = renderStatusLine(
			{
				...(details.tools.length > 0
					? { iconOverride: uiTheme.fg("accent", uiTheme.symbol("icon.search")) }
					: { icon: "warning" as const }),
				title: TOOL_DISCOVERY_TITLE,
				description: truncateToWidth(safeQuery, MATCH_LABEL_LEN),
				meta,
			},
			uiTheme,
		);
		if (details.tools.length === 0) {
			const emptyMessage =
				details.total_tools === 0 ? "No discoverable tools are currently loaded." : "No matching tools found.";
			return new Text(`${header}\n${uiTheme.fg("muted", emptyMessage)}`, 0, 0);
		}

		return framedBlock(uiTheme, width => ({
			header,
			sections: [{ lines: renderMatchBullets(details.tools, options.expanded ?? false, uiTheme) }],
			state: "success",
			borderColor: "borderMuted",
			applyBg: false,
			width,
		}));
	},

	mergeCallAndResult: true,
	inline: true,
};
