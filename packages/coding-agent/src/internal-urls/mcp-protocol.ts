import { untilAborted } from "@oh-my-pi/pi-utils";
import { MCPManager } from "../mcp/manager";
import type { MCPResourceReadResult } from "../mcp/types";
import mcpDoc from "../prompts/internal-urls/mcp.md" with { type: "text" };
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, SchemeSpec } from "./types";

export interface McpResourceReadOptions {
	/** Match advertised resource URIs only, never URI templates. */
	exact?: boolean;
	signal?: AbortSignal;
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getUriTemplateMatchScore(
	uri: string,
	uriTemplate: string,
): { literalChars: number; expressionCount: number } | undefined {
	const expressionPattern = /\{[^}]+\}/g;
	const literalSegments = uriTemplate.split(expressionPattern);
	const expressionCount = (uriTemplate.match(expressionPattern) ?? []).length;
	const pattern = literalSegments.map(escapeRegex).join("(.*?)");
	const regex = new RegExp(`^${pattern}$`);
	if (!regex.test(uri)) return undefined;
	const literalChars = literalSegments.reduce((total, segment) => total + segment.length, 0);
	return { literalChars, expressionCount };
}

function extractResourceUri(url: InternalUrl): string {
	const scheme = url.protocol.replace(/:$/, "").toLowerCase();
	if (scheme !== "mcp") {
		// Server-advertised native URI (hierarchical or opaque). Preserve the
		// input byte-for-byte: `resolveTargetServer` matches by exact string
		// equality, so e.g. `catalog://root/` must keep its trailing slash.
		return url.rawHref ?? url.href;
	}
	// Legacy `mcp://<resource-uri>` wrapper: reconstruct the wrapped URI and
	// elide a bare trailing `/` that URL parsing adds to host-only forms.
	const host = url.rawHost || url.hostname;
	const rawPathname = url.rawPathname ?? url.pathname;
	const hasPath = rawPathname && rawPathname !== "/";
	const uri = `${host}${hasPath ? rawPathname : ""}${url.search}${url.hash}`.trim();
	if (!uri) {
		throw new Error("mcp:// URL requires a resource URI: mcp://<resource-uri>");
	}
	return uri;
}

function resolveTargetServer(mcpManager: MCPManager, uri: string, exact: boolean): string | undefined {
	const servers = mcpManager.getConnectedServers();
	for (const name of servers) {
		const serverResources = mcpManager.getServerResources(name);
		if (serverResources?.resources.some(r => r.uri === uri)) {
			return name;
		}
	}
	if (exact) return undefined;

	let bestTemplateMatch:
		| {
				serverName: string;
				literalChars: number;
				expressionCount: number;
				serverIndex: number;
				templateIndex: number;
		  }
		| undefined;

	for (const [serverIndex, name] of servers.entries()) {
		const serverResources = mcpManager.getServerResources(name);
		if (!serverResources) continue;

		for (const [templateIndex, template] of serverResources.templates.entries()) {
			const match = getUriTemplateMatchScore(uri, template.uriTemplate);
			if (!match) continue;

			const isBetterMatch =
				!bestTemplateMatch ||
				match.literalChars > bestTemplateMatch.literalChars ||
				(match.literalChars === bestTemplateMatch.literalChars &&
					(match.expressionCount < bestTemplateMatch.expressionCount ||
						(match.expressionCount === bestTemplateMatch.expressionCount &&
							(serverIndex < bestTemplateMatch.serverIndex ||
								(serverIndex === bestTemplateMatch.serverIndex &&
									templateIndex < bestTemplateMatch.templateIndex)))));

			if (isBetterMatch) {
				bestTemplateMatch = {
					serverName: name,
					literalChars: match.literalChars,
					expressionCount: match.expressionCount,
					serverIndex,
					templateIndex,
				};
			}
		}
	}

	return bestTemplateMatch?.serverName;
}

function formatAvailableResources(mcpManager: MCPManager): string {
	const available = mcpManager
		.getConnectedServers()
		.flatMap(name => {
			const serverResources = mcpManager.getServerResources(name);
			if (!serverResources) return [];
			const concrete = serverResources.resources.map(r => `  ${r.uri} (${name})`);
			const templates = serverResources.templates.map(t => `  ${t.uriTemplate} (${name}, template)`);
			return [...concrete, ...templates];
		})
		.join("\n");
	return available || "  (none)";
}

/**
 * Read the MCP resource `url` names (see {@link extractResourceUri}) from the connected server that
 * advertises it. Undefined when no server does, after pending connects and catalog loads settle;
 * those waits are bounded by the MCP connect/request timeouts and end early on an aborted `signal`
 * (the work itself stays in flight for the manager).
 */
export async function readMcpResource(
	mcpManager: MCPManager,
	url: InternalUrl,
	options?: McpResourceReadOptions,
): Promise<InternalResource | undefined> {
	const exact = options?.exact === true;
	const signal = options?.signal;
	const uri = extractResourceUri(url);
	let targetServer = resolveTargetServer(mcpManager, uri, exact);
	if (!targetServer) {
		// A configured server may still be handshaking when discovery returned
		// (the `connectServers` startup race deliberately leaves slow servers in
		// flight). This one-shot read must observe the final attached state
		// rather than the mid-handshake snapshot, so wait for pending connects
		// before loading catalogs and retrying.
		await untilAborted(signal, mcpManager.waitForPendingConnections());
		await untilAborted(
			signal,
			Promise.allSettled(mcpManager.getConnectedServers().map(name => mcpManager.ensureServerResources(name))),
		);
		targetServer = resolveTargetServer(mcpManager, uri, exact);
	}
	if (!targetServer) return undefined;

	let result: MCPResourceReadResult | undefined;
	try {
		result = await mcpManager.readServerResource(targetServer, uri, { signal });
	} catch (error) {
		if (signal?.aborted) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`MCP resource read error: ${message}`);
	}

	if (!result) {
		throw new Error(`Server "${targetServer}" returned no content for "${uri}".`);
	}

	const textParts: string[] = [];
	for (const item of result.contents) {
		if (item.text !== undefined && item.text !== null) {
			textParts.push(item.text);
		} else if (item.blob) {
			textParts.push(`[Binary content: ${item.mimeType ?? "unknown"}, base64 length ${item.blob.length}]`);
		}
	}

	const content = textParts.length > 0 ? textParts.join("\n---\n") : "(empty resource)";
	return {
		url: url.href,
		content,
		contentType: "text/plain",
		size: Buffer.byteLength(content, "utf-8"),
		notes: [`MCP server: ${targetServer}`],
	};
}

/**
 * Protocol handler for MCP resources.
 *
 * URL forms:
 * - mcp://<resource-uri> (e.g. mcp://test://notes, mcp://ibkr://portfolio/positions)
 * - A resource's native URI when its scheme has no OMP handler (e.g. ags://capabilities/current-host)
 */
export class McpProtocolHandler implements ProtocolHandler {
	readonly scheme = "mcp";
	readonly spec: SchemeSpec = { backing: "remote", selectors: "opaque", immutable: true };

	/**
	 * Always advertised: the system prompt is built before MCP discovery settles
	 * (`MCPManager.instance()` and its server set are populated asynchronously),
	 * so there is no reliable synchronous "has servers" signal at prompt time.
	 */
	promptDoc(): string {
		return mcpDoc.trim();
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const mcpManager = await MCPManager.load();
		if (!mcpManager) {
			throw new Error("No MCP manager available. MCP servers may not be configured.");
		}
		const resource = await readMcpResource(mcpManager, url, { signal: context?.signal });
		if (resource) return resource;
		throw new Error(
			`No MCP server has resource "${extractResourceUri(url)}".\n\nAvailable resources:\n${formatAvailableResources(mcpManager)}`,
		);
	}
}
