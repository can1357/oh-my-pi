/**
 * Live MCP runtime view-model for `/extensions`.
 *
 * Discovery yields config (`MCPServer`). `MCPManager` holds the live connection.
 * This module joins them by server name without stuffing runtime objects into
 * `Extension.raw`.
 */
/** Config and connection fields actually consumed by the dashboard. */
export interface MCPServerConfigDisplay {
	type?: string;
	transport?: string;
	command?: string;
	args?: string[];
	url?: string;
	env?: Record<string, unknown>;
}

export interface MCPServerDisplay extends MCPServerConfigDisplay {
	name: string;
	enabled?: boolean;
	_source: unknown;
}

export interface MCPImplementationDisplay {
	name: string;
	version?: string;
	title?: string;
	description?: string;
	websiteUrl?: string;
}

export interface MCPResourceDisplay {
	name: string;
	title?: string;
	description?: string;
	uri?: string;
	uriTemplate?: string;
}

export interface MCPConnectionDisplay {
	name: string;
	config: MCPServerConfigDisplay;
	serverInfo?: MCPImplementationDisplay;
	instructions?: string;
	tools?: Array<{
		name: string;
		title?: string;
		description?: string;
		annotations?: { title?: string };
		inputSchema?: unknown;
	}>;
	resources?: MCPResourceDisplay[];
	resourceTemplates?: MCPResourceDisplay[];
	prompts?: MCPResourceDisplay[];
}

import { PREVIEW_LIMITS } from "../../render/render-utils";
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
	getConnection(name: string): MCPConnectionDisplay | undefined;
	getTools(): Array<{
		mcpServerName?: string;
		mcpToolName?: string;
		description?: string;
		label?: string;
		parameters?: unknown;
	}>;
	getServerResources?(name: string): { resources: MCPResourceDisplay[]; templates: MCPResourceDisplay[] } | undefined;
	getServerPrompts?(name: string): MCPResourceDisplay[] | undefined;
}

const DEFAULT_VISIBLE_TOOLS = PREVIEW_LIMITS.COLLAPSED_ITEMS;

export function isDiscoveredMcpServer(raw: unknown): raw is MCPServerDisplay {
	if (!raw || typeof raw !== "object") return false;
	const value = raw as { name?: unknown; _source?: unknown };
	return typeof value.name === "string" && value._source !== undefined;
}

export function inferMcpTransport(server: MCPServerDisplay | MCPServerConfigDisplay): "stdio" | "sse" | "http" {
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

function resourcesFrom(connection: MCPConnectionDisplay, manager?: MCPRuntimeSource): MCPRuntimeCatalogItem[] {
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

function promptsFrom(connection: MCPConnectionDisplay, manager?: MCPRuntimeSource): MCPRuntimeCatalogItem[] {
	const listed = manager?.getServerPrompts?.(connection.name) ?? connection.prompts ?? [];
	return listed.map(prompt => catalogItem(prompt.name, prompt.title, prompt.description));
}

function identityFrom(
	info: MCPImplementationDisplay | undefined,
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
	server: MCPServerDisplay,
	manager: MCPRuntimeSource | undefined,
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
