/**
 * Worker side of the MCP manager bridge: {@link RemoteMCPManager} implements
 * {@link MCPManagerApi} over the main thread's manager (remote-object kind
 * {@link MCP_MANAGER_KIND}). Workers never own MCP connections: every tool call,
 * resource read and change subscription runs on main.
 */
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { MCPToolDetails } from "@oh-my-pi/pi-tui/tools/mcp";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import type { MCPManagerApi, MCPToolScope } from "../../mcp/manager";
import type { MCPRequestOptions, MCPResource, MCPResourceReadResult, MCPResourceTemplate } from "../../mcp/types";
import type { RemoteObject, RpcMethod } from "../rpc";

/** Remote-object kind of a main-thread `MCPManager`. */
export const MCP_MANAGER_KIND = "mcp-manager";

/** Listener for server notification frames. */
export type McpNotificationListener = (serverName: string, method: string, params: unknown) => void;

/** Reply to {@link McpManagerProtocol.tools}. */
export interface McpToolsReply {
	/** Version of main's tool views; it changes whenever any session's view may have. */
	readonly version: number;
	/** The current tools; omitted when the caller already holds `version`. */
	readonly tools?: CustomTool<TSchema, MCPToolDetails>[];
}

/** Protocol a {@link RemoteMCPManager} speaks to its main-thread manager. */
export type McpManagerProtocol = {
	/** One scope's tools as plain cross-thread views (data + `execute` running on main), unless `knownVersion` is current. */
	tools: RpcMethod<[knownVersion: number, scope: MCPToolScope | undefined], McpToolsReply>;
	openToolScope: RpcMethod<[scope: MCPToolScope, seed: MCPToolScope | undefined], void>;
	/** Attribute a tool call; the returned release is synchronous for the worker. */
	trackToolCall: RpcMethod<[scope: MCPToolScope, toolCallId: string], () => void>;
	/** Subscribe; the returned unsubscribe is synchronous for the worker. */
	onToolsChanged: RpcMethod<[listener: () => void], () => void>;
	onNotification: RpcMethod<[listener: McpNotificationListener], () => void>;
	connectedServers: RpcMethod<[], string[]>;
	serverResources: RpcMethod<
		[name: string],
		{ resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined
	>;
	ensureServerResources: RpcMethod<[name: string], void>;
	waitForPendingConnections: RpcMethod<[], void>;
	readServerResource: RpcMethod<
		[name: string, uri: string, options: MCPRequestOptions | undefined],
		MCPResourceReadResult | undefined
	>;
	serverInstructions: RpcMethod<[], Map<string, string>>;
	reconcileBrowserFilter: RpcMethod<[enabled: boolean], void>;
};

/** Worker-side proxy of one main-thread `MCPManager`. */
export class RemoteMCPManager implements MCPManagerApi {
	readonly #remote: RemoteObject<McpManagerProtocol>;
	/** Each scope's tool views at the version main last sent them; absent before the first fetch. */
	#toolsByScope = new Map<
		MCPToolScope | undefined,
		{ version: number; tools: CustomTool<TSchema, MCPToolDetails>[] }
	>();

	constructor(remote: RemoteObject<McpManagerProtocol>) {
		this.#remote = remote;
	}

	/** `scope`'s current tools; the views cross only when main's tool views changed since this scope's last call. */
	getTools(scope?: MCPToolScope): CustomTool<TSchema, MCPToolDetails>[] {
		const cached = this.#toolsByScope.get(scope);
		const reply = this.#remote.callSync("tools", cached?.version ?? 0, scope);
		if (!reply.tools) return cached?.tools ?? [];
		this.#toolsByScope.set(scope, { version: reply.version, tools: reply.tools });
		return reply.tools;
	}

	openToolScope(scope: MCPToolScope, seed?: MCPToolScope): void {
		this.#remote.callSync("openToolScope", scope, seed);
	}

	trackToolCall(scope: MCPToolScope, toolCallId: string): () => void {
		return this.#remote.callSync("trackToolCall", scope, toolCallId);
	}

	addToolsChangedListener(listener: () => void): () => void {
		return this.#remote.callSync("onToolsChanged", listener);
	}

	addNotificationListener(listener: McpNotificationListener): () => void {
		return this.#remote.callSync("onNotification", listener);
	}

	getConnectedServers(): string[] {
		return this.#remote.callSync("connectedServers");
	}

	getServerResources(name: string): { resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined {
		return this.#remote.callSync("serverResources", name);
	}

	ensureServerResources(name: string): Promise<void> {
		return this.#remote.call("ensureServerResources", name);
	}

	waitForPendingConnections(): Promise<void> {
		return this.#remote.call("waitForPendingConnections");
	}

	readServerResource(
		name: string,
		uri: string,
		options?: MCPRequestOptions,
	): Promise<MCPResourceReadResult | undefined> {
		return this.#remote.call("readServerResource", name, uri, options);
	}

	getServerInstructions(): Map<string, string> {
		return this.#remote.callSync("serverInstructions");
	}

	reconcileBrowserFilter(enabled: boolean): Promise<void> {
		return this.#remote.call("reconcileBrowserFilter", enabled);
	}
}
