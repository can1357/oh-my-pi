import type { AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { applyToolProxy } from "../../extensibility/tool-proxy";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { RpcClientConnection, type RpcClientConn } from "./client-connection";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
} from "./rpc-types";

type RpcHostToolOutput = (frame: RpcHostToolCallRequest | RpcHostToolCancelRequest) => void;

type PendingHostToolCall = {
	resolve: (result: AgentToolResult<unknown>) => void;
	reject: (error: Error) => void;
	onUpdate?: AgentToolUpdateCallback<unknown>;
	conn: RpcClientConn;
};

type RegisteredHostTool = { definition: RpcHostToolDefinition; sequence: number };

type ResolvedHostTool = { conn: RpcClientConn; definition: RpcHostToolDefinition };

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
	if (!value || typeof value !== "object") return false;
	const content = (value as { content?: unknown }).content;
	return Array.isArray(content);
}

export function isRpcHostToolResult(value: unknown): value is RpcHostToolResult {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; result?: unknown };
	return frame.type === "host_tool_result" && typeof frame.id === "string" && isAgentToolResult(frame.result);
}

export function isRpcHostToolUpdate(value: unknown): value is RpcHostToolUpdate {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; partialResult?: unknown };
	return frame.type === "host_tool_update" && typeof frame.id === "string" && isAgentToolResult(frame.partialResult);
}

class RpcHostToolAdapter<TParams extends TSchema = TSchema, TTheme extends Theme = Theme> implements AgentTool<
	TParams,
	unknown,
	TTheme
> {
	declare name: string;
	declare label: string;
	declare description: string;
	declare parameters: TParams;
	readonly strict = true;
	concurrency: "shared" | "exclusive" = "shared";
	readonly loadMode: ToolLoadMode;
	#bridge: RpcHostToolBridge;
	#definition: RpcHostToolDefinition;
	#conn: RpcClientConn;

	constructor(definition: RpcHostToolDefinition, bridge: RpcHostToolBridge, conn: RpcClientConn) {
		this.#definition = definition;
		this.#bridge = bridge;
		this.#conn = conn;
		applyToolProxy(definition, this);
		this.loadMode = defaultLoadModeForToolName(definition.name, definition.loadMode);
	}

	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		return this.#bridge.requestExecution(
			this.#conn,
			this.#definition,
			toolCallId,
			params as Record<string, unknown>,
			signal,
			onUpdate,
		);
	}
}

export class RpcHostToolBridge {
	#defaultConn: RpcClientConn;
	#clients = new Map<RpcClientConn, Map<string, RegisteredHostTool>>();
	#resolved = new Map<string, ResolvedHostTool>();
	#pendingCalls = new Map<string, PendingHostToolCall>();
	#closedConns = new WeakMap<RpcClientConn, Error>();
	#sequence = 0;

	constructor(clientOrOutput: RpcClientConn | RpcHostToolOutput) {
		this.#defaultConn =
			typeof clientOrOutput === "function"
				? new RpcClientConnection({
						id: "stdio",
						send: frame => clientOrOutput(frame as RpcHostToolCallRequest | RpcHostToolCancelRequest),
					})
				: clientOrOutput;
		this.#clients.set(this.#defaultConn, new Map());
	}

	/** Attach a client whose `set_host_tools` joins the merged union. */
	registerClient(conn: RpcClientConn): void {
		if (this.#clients.has(conn)) return;
		this.#clients.set(conn, new Map());
	}

	getToolNames(): string[] {
		return Array.from(this.#resolved.keys());
	}

	/** Replaces the tools one client owns; the session sees the merged union of every client. */
	setTools(tools: RpcHostToolDefinition[], conn: RpcClientConn = this.#defaultConn): AgentTool[] {
		let registrations = this.#clients.get(conn);
		if (!registrations) {
			registrations = new Map();
			this.#clients.set(conn, registrations);
		}
		registrations.clear();
		for (const tool of tools) {
			registrations.set(tool.name, { definition: tool, sequence: ++this.#sequence });
		}
		this.#recompute();
		return Array.from(this.#resolved.values(), entry => new RpcHostToolAdapter(entry.definition, this, entry.conn));
	}

	/** Rebuilds the merged map; `sequence` makes the latest registration of a name win. */
	#recompute(): void {
		const winners = new Map<string, ResolvedHostTool & { sequence: number }>();
		for (const [conn, registrations] of this.#clients) {
			for (const [name, registration] of registrations) {
				const current = winners.get(name);
				if (!current || registration.sequence > current.sequence) {
					winners.set(name, {
						conn,
						definition: registration.definition,
						sequence: registration.sequence,
					});
				}
			}
		}
		this.#resolved = new Map(
			Array.from(winners, ([name, winner]) => [name, { conn: winner.conn, definition: winner.definition }]),
		);
	}

	handleResult(frame: RpcHostToolResult, conn?: RpcClientConn): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		if (conn && pending.conn !== conn) return false;
		this.#pendingCalls.delete(frame.id);
		if (frame.isError) {
			const text = frame.result.content
				.filter(
					(item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string",
				)
				.map(item => item.text)
				.join("\n")
				.trim();
			pending.reject(new Error(text || "Host tool execution failed"));
			return true;
		}
		pending.resolve(frame.result);
		return true;
	}

	handleUpdate(frame: RpcHostToolUpdate, conn?: RpcClientConn): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		if (conn && pending.conn !== conn) return false;
		pending.onUpdate?.(frame.partialResult);
		return true;
	}

	requestExecution(
		conn: RpcClientConn,
		definition: RpcHostToolDefinition,
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		if (signal?.aborted) {
			return Promise.reject(new Error(`Host tool "${definition.name}" was aborted`));
		}

		const closedError = this.#closedConns.get(conn);
		if (closedError) {
			return Promise.reject(closedError);
		}

		const id = Snowflake.next() as string;
		const { promise, resolve, reject } = Promise.withResolvers<AgentToolResult<unknown>>();
		let settled = false;

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			this.#pendingCalls.delete(id);
		};

		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			conn.send({
				type: "host_tool_cancel",
				id: Snowflake.next() as string,
				targetId: id,
			});
			reject(new Error(`Host tool "${definition.name}" was aborted`));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingCalls.set(id, {
			resolve: result => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
			onUpdate,
			conn,
		});

		conn.send({
			type: "host_tool_call",
			id,
			toolCallId,
			toolName: definition.name,
			arguments: args,
		});

		return promise;
	}

	rejectAllPending(message: string): void {
		const error = new Error(message);
		const pendingCalls = Array.from(this.#pendingCalls.values());
		this.#pendingCalls.clear();
		for (const pending of pendingCalls) {
			pending.reject(error);
		}
	}

	/**
	 * Detaches one client: fails its in-flight calls, rejects its future
	 * executions, drops its tools from the union, and returns the refreshed
	 * merged adapters for the session.
	 */
	removeClient(conn: RpcClientConn, message: string): AgentTool[] {
		const error = new Error(message);
		if (!this.#closedConns.has(conn)) this.#closedConns.set(conn, error);
		this.#clients.delete(conn);
		this.#recompute();
		const pendingCalls = Array.from(this.#pendingCalls.entries()).filter(([, pending]) => pending.conn === conn);
		for (const [id, pending] of pendingCalls) {
			this.#pendingCalls.delete(id);
			pending.reject(error);
		}
		return Array.from(this.#resolved.values(), entry => new RpcHostToolAdapter(entry.definition, this, entry.conn));
	}

	/** Reject active and future host tool requests after the only RPC client disconnects. */
	close(message: string): void {
		this.removeClient(this.#defaultConn, message);
	}
}
