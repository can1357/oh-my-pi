/**
 * Live MCP runtime view-model for `/extensions`.
 *
 * Discovery yields config (`MCPServer`). `MCPManager` holds the live connection.
 * This module joins them by server name without stuffing runtime objects into
 * `Extension.raw`.
 */
import type { MCPServer } from "../../../capability/mcp";
import type { SourceMeta } from "../../../capability/types";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import { type LoadMCPConfigsOptions, loadAllMCPConfigs } from "../../../mcp/config";
import type { MCPLoadResult, MCPManager } from "../../../mcp/manager";
import type { McpConnectionStatusEvent } from "../../../mcp/startup-events";
import type {
	MCPImplementation,
	MCPPrompt,
	MCPResource,
	MCPResourceTemplate,
	MCPServerConfig,
	MCPServerConnection,
} from "../../../mcp/types";
import { PREVIEW_LIMITS } from "../../../tools/render-utils";
import {
	sanitizeDisplayField,
	sanitizeDisplayLine,
	sanitizeDisplayLineField,
	sanitizeDisplayText,
} from "./display-text";

export type MCPConnectionHealth = "connected" | "connecting" | "disconnected" | "inactive";

export interface MCPRuntimeCatalogItem {
	name: string;
	title?: string;
	description?: string;
	/** MCP `inputSchema` / bridged `parameters`. Rendered on expand. */
	parameters?: unknown;
}

export interface MCPRuntimeSnapshot {
	health: MCPConnectionHealth;
	transport: "stdio" | "sse" | "http";
	title?: string;
	description?: string;
	websiteUrl?: string;
	implementationName?: string;
	implementationVersion?: string;
	instructions?: string;
	tools: MCPRuntimeCatalogItem[];
	resources: MCPRuntimeCatalogItem[];
	prompts: MCPRuntimeCatalogItem[];
	command?: string;
	args?: string[];
	url?: string;
	envCount: number;
}

/** Narrow manager surface so tests can stub without constructing MCPManager. */
export interface MCPRuntimeSource {
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected";
	getConnection(name: string): MCPServerConnection | undefined;
	getTools(): Array<{
		mcpServerName?: string;
		mcpToolName?: string;
		description?: string;
		label?: string;
		parameters?: unknown;
	}>;
	getServerResources?(name: string): { resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined;
	getServerPrompts?(name: string): MCPPrompt[] | undefined;
}

/** Manager methods `/extensions` needs to match `/mcp enable` / `/mcp disable`. */
export interface MCPToggleManager {
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected";
	getTools(): CustomTool[];
	disconnectServer(name: string): Promise<void>;
	connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		onStatus?: (event: McpConnectionStatusEvent) => void,
	): Promise<Pick<MCPLoadResult, "errors"> | MCPLoadResult>;
}

export interface MCPToggleSession {
	refreshMCPTools(tools: CustomTool[]): Promise<void> | void;
}

export interface ApplyMcpToggleRuntimeOptions {
	name: string;
	enabled: boolean;
	cwd: string;
	manager?: MCPToggleManager;
	session?: MCPToggleSession;
	/** Same discovery filters as session startup (`sdk.ts` / `/mcp reload`). */
	discovery?: LoadMCPConfigsOptions;
	loadConfigs?: typeof loadAllMCPConfigs;
	onStatus?: (event: McpConnectionStatusEvent) => void;
}

/**
 * After `/extensions` persists an MCP enable/disable, apply the same live
 * connect/disconnect + session tool refresh that `/mcp enable` / `/mcp disable`
 * already do. Config persistence stays in `setMcpServerEnabled`.
 */
export async function applyMcpToggleRuntime(options: ApplyMcpToggleRuntimeOptions): Promise<void> {
	const { name, enabled, cwd, manager, session, discovery, loadConfigs = loadAllMCPConfigs, onStatus } = options;
	if (!manager) return;

	if (!enabled) {
		await manager.disconnectServer(name);
		await session?.refreshMCPTools(manager.getTools());
		return;
	}

	if (manager.getConnectionStatus(name) !== "disconnected") {
		await session?.refreshMCPTools(manager.getTools());
		return;
	}

	const { configs, sources } = await loadConfigs(cwd, discovery);
	const config = configs[name];
	if (!config) {
		await session?.refreshMCPTools(manager.getTools());
		return;
	}
	const source = sources[name];
	await manager.connectServers({ [name]: config }, source ? { [name]: source } : {}, onStatus);
	await session?.refreshMCPTools(manager.getTools());
}

const DEFAULT_VISIBLE_TOOLS = PREVIEW_LIMITS.COLLAPSED_ITEMS;

export function isDiscoveredMcpServer(raw: unknown): raw is MCPServer {
	if (!raw || typeof raw !== "object") return false;
	const value = raw as { name?: unknown; _source?: unknown };
	return typeof value.name === "string" && value._source !== undefined;
}

export function inferMcpTransport(server: MCPServer | MCPServerConfig): "stdio" | "sse" | "http" {
	if (
		"transport" in server &&
		(server.transport === "stdio" || server.transport === "sse" || server.transport === "http")
	) {
		return server.transport;
	}
	if ("type" in server && (server.type === "stdio" || server.type === "sse" || server.type === "http")) {
		return server.type;
	}
	if ("url" in server && typeof server.url === "string" && server.url.length > 0) {
		return "http";
	}
	return "stdio";
}

function catalogItem(name: string, title?: string, description?: string, parameters?: unknown): MCPRuntimeCatalogItem {
	const cleanName = sanitizeDisplayLine(name);
	const cleanTitle = sanitizeDisplayLineField(title);
	const cleanDescription = sanitizeDisplayField(description);
	return {
		name: cleanName,
		...(cleanTitle && cleanTitle !== cleanName ? { title: cleanTitle } : {}),
		...(cleanDescription ? { description: cleanDescription } : {}),
		...(parameters !== undefined ? { parameters } : {}),
	};
}

function toolsFromManager(manager: MCPRuntimeSource, serverName: string): MCPRuntimeCatalogItem[] {
	const items: MCPRuntimeCatalogItem[] = [];
	const seen: Record<string, true> = {};
	for (const tool of manager.getTools()) {
		if (tool.mcpServerName !== serverName) continue;
		const name = tool.mcpToolName ?? tool.label?.split("/").pop() ?? tool.label;
		if (!name || seen[name]) continue;
		seen[name] = true;
		items.push(catalogItem(name, undefined, tool.description, tool.parameters));
	}
	return items;
}

function resourcesFrom(connection: MCPServerConnection, manager?: MCPRuntimeSource): MCPRuntimeCatalogItem[] {
	const listed = manager?.getServerResources?.(connection.name);
	const resources = listed?.resources ?? connection.resources ?? [];
	const templates = listed?.templates ?? connection.resourceTemplates ?? [];
	return [
		...resources.map(resource => catalogItem(resource.name, resource.title, resource.description ?? resource.uri)),
		...templates.map(template =>
			catalogItem(template.name, template.title, template.description ?? template.uriTemplate),
		),
	];
}

function promptsFrom(connection: MCPServerConnection, manager?: MCPRuntimeSource): MCPRuntimeCatalogItem[] {
	const listed = manager?.getServerPrompts?.(connection.name) ?? connection.prompts ?? [];
	return listed.map(prompt => catalogItem(prompt.name, prompt.title, prompt.description));
}

function identityFrom(
	info: MCPImplementation | undefined,
	fallbackName: string,
): Pick<MCPRuntimeSnapshot, "title" | "description" | "websiteUrl" | "implementationName" | "implementationVersion"> {
	if (!info) return {};
	const implementationName = sanitizeDisplayLineField(info.name);
	const displayTitle = sanitizeDisplayLineField(info.title);
	return {
		title: displayTitle && displayTitle !== fallbackName ? displayTitle : undefined,
		description: sanitizeDisplayField(info.description),
		websiteUrl: sanitizeDisplayLineField(info.websiteUrl),
		implementationName,
		implementationVersion: sanitizeDisplayLineField(info.version),
	};
}

export function snapshotMcpRuntime(
	server: MCPServer,
	manager: MCPRuntimeSource | MCPManager | undefined,
	opts?: { enabled?: boolean; shadowed?: boolean },
): MCPRuntimeSnapshot {
	const enabled = opts?.enabled ?? server.enabled !== false;
	const transport = inferMcpTransport(server);
	const envCount = server.env ? Object.keys(server.env).length : 0;
	const base: MCPRuntimeSnapshot = {
		health: enabled ? "disconnected" : "inactive",
		transport,
		command: sanitizeDisplayField(server.command),
		args: server.args?.map(arg => sanitizeDisplayText(arg)),
		url: sanitizeDisplayField(server.url),
		envCount,
		tools: [],
		resources: [],
		prompts: [],
	};

	// Shadowed same-name configs share a name with the winner. Joining by
	// server.name would steal the live connection's health/tools/instructions.
	if (opts?.shadowed || !enabled || !manager) {
		return base;
	}

	const health = manager.getConnectionStatus(server.name);
	const connection = manager.getConnection(server.name);
	const identity = identityFrom(connection?.serverInfo, server.name);
	const connectedTools = (connection?.tools ?? []).map(tool =>
		catalogItem(tool.name, tool.title ?? tool.annotations?.title, tool.description, tool.inputSchema),
	);
	const tools = connectedTools.length > 0 ? connectedTools : toolsFromManager(manager, server.name);

	return {
		...base,
		health,
		...identity,
		instructions: sanitizeDisplayField(connection?.instructions),
		tools,
		resources: connection ? resourcesFrom(connection, manager) : [],
		prompts: connection ? promptsFrom(connection, manager) : [],
		command:
			sanitizeDisplayField(server.command) ??
			(connection?.config && "command" in connection.config
				? sanitizeDisplayField(connection.config.command)
				: undefined),
		args:
			server.args?.map(arg => sanitizeDisplayText(arg)) ??
			(connection?.config && "args" in connection.config
				? connection.config.args?.map(arg => sanitizeDisplayText(arg))
				: undefined),
		url:
			sanitizeDisplayField(server.url) ??
			(connection?.config && "url" in connection.config ? sanitizeDisplayField(connection.config.url) : undefined),
		transport: connection ? inferMcpTransport(connection.config) : transport,
	};
}

export function formatMcpListHint(snapshot: MCPRuntimeSnapshot): string {
	switch (snapshot.health) {
		case "inactive":
			return "inactive";
		case "connecting":
			return "connecting…";
		case "disconnected":
			return "unavailable";
		case "connected": {
			const parts = [`${snapshot.tools.length} tool${snapshot.tools.length === 1 ? "" : "s"}`];
			if (snapshot.resources.length > 0) {
				parts.push(`${snapshot.resources.length} resource${snapshot.resources.length === 1 ? "" : "s"}`);
			}
			if (snapshot.prompts.length > 0) {
				parts.push(`${snapshot.prompts.length} prompt${snapshot.prompts.length === 1 ? "" : "s"}`);
			}
			return parts.join(" · ");
		}
	}
}

export function formatMcpHealthLabel(health: MCPConnectionHealth): string {
	switch (health) {
		case "connected":
			return "Connected";
		case "connecting":
			return "Connecting";
		case "disconnected":
			return "Not connected";
		case "inactive":
			return "Inactive";
	}
}

export function visibleMcpTools(
	tools: MCPRuntimeCatalogItem[],
	limit: number = DEFAULT_VISIBLE_TOOLS,
): { shown: MCPRuntimeCatalogItem[]; hidden: number } {
	if (tools.length <= limit) return { shown: tools, hidden: 0 };
	return { shown: tools.slice(0, limit), hidden: tools.length - limit };
}
