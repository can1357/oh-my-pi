/**
 * Worker side of the MCP manager bridge: {@link RemoteMCPManager} implements
 * {@link MCPManagerApi} over the main thread's manager (remote-object kind
 * {@link MCP_MANAGER_KIND}). Workers never own MCP connections: every tool call,
 * resource read and change subscription runs on main.
 */
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { MCPToolDetails } from "@oh-my-pi/pi-tui/tools/mcp";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import type { MCPManagerApi } from "../../mcp/manager";
import type { MCPRequestOptions, MCPResource, MCPResourceReadResult, MCPResourceTemplate } from "../../mcp/types";
import type { RemoteObject, RpcMethod } from "../rpc";

/** Remote-object kind of a main-thread `MCPManager`. */
export const MCP_MANAGER_KIND = "mcp-manager";

/** Listener for server notification frames. */
export type McpNotificationListener = (serverName: string, method: string, params: unknown) => void;

/** Protocol a {@link RemoteMCPManager} speaks to its main-thread manager. */
export type McpManagerProtocol = {
	/** Current tools as plain cross-thread views (data + `execute` running on main). */
	tools: RpcMethod<[], CustomTool<TSchema, MCPToolDetails>[]>;
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

	constructor(remote: RemoteObject<McpManagerProtocol>) {
		this.#remote = remote;
	}

	getTools(): CustomTool<TSchema, MCPToolDetails>[] {
		return this.#remote.callSync("tools");
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
