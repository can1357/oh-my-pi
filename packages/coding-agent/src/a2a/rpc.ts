/**
 * A2A v1.0 wire model and method dispatch for the omp bridge.
 *
 * The bridge exposes omp's agent registry as A2A tasks: one registered agent is
 * one task, keyed by the agent id. Two omp extensions ride metadata:
 * - `metadata.to` addresses an existing agent (delivered through the IRC bus);
 *   A2A `contextId` is a grouping id, never a recipient.
 * - `metadata.agent` / `metadata.context` name the agent definition and shared
 *   background for a spawn when no recipient is addressed.
 *
 * The registry carries no exit code, so terminality comes from
 * `lifecycle.terminalAt` and a completed run is recognized by its published
 * output artifact (`history.outputPath`).
 */

import type { SpawnSubagentOptions } from "../extensibility/extensions/types";
import { MAIN_AGENT_ID, type AgentRef, type AgentRegistryApi } from "../registry/agent-registry";
import { PerCallModelError } from "../task/model-approval";
import { SpawnRefusedError } from "../task/spawn-run";
import { SpawnPendingError } from "../task/spawn-subagent";
import { StructuredSubagentError } from "../task/structured-subagent";
import type { IrcDeliveryReceipt, IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

/** A2A v1.0 task lifecycle states (proto enum names; JSON keeps them verbatim). */
export const TASK_STATE = {
	UNSPECIFIED: "TASK_STATE_UNSPECIFIED",
	SUBMITTED: "TASK_STATE_SUBMITTED",
	WORKING: "TASK_STATE_WORKING",
	COMPLETED: "TASK_STATE_COMPLETED",
	FAILED: "TASK_STATE_FAILED",
	CANCELED: "TASK_STATE_CANCELED",
	REJECTED: "TASK_STATE_REJECTED",
} as const;
export type TaskState = (typeof TASK_STATE)[keyof typeof TASK_STATE];

/** States after which a task stream closes and no message may be delivered. */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
	TASK_STATE.COMPLETED,
	TASK_STATE.FAILED,
	TASK_STATE.CANCELED,
	TASK_STATE.REJECTED,
]);

/** JSON-RPC codes: standard ones plus the A2A-specific range the bridge uses. */
export const RPC_ERRORS = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	/** JSON-RPC's implementation-defined server-error range; HTTP 401 pairs it. */
	UNAUTHORIZED: -32000,
	TASK_NOT_FOUND: -32001,
	TASK_NOT_CANCELABLE: -32002,
	UNSUPPORTED_OPERATION: -32004,
	CONTENT_TYPE_NOT_SUPPORTED: -32005,
	/**
	 * A spawn was refused before any agent existed (spawn policy, unknown or
	 * disabled agent, model-approval denial). HTTP 200: the bridge worked, the
	 * request was rejected — clients must not read this as a bridge failure.
	 */
	AGENT_REJECTED: -32010,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcSuccess {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
}

export interface JsonRpcFailure {
	jsonrpc: "2.0";
	id: JsonRpcId;
	error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** A method error that carries its JSON-RPC code and the HTTP status to pair it with. */
export class RpcError extends Error {
	readonly code: number;
	readonly httpStatus: number;
	readonly data: unknown;

	constructor(code: number, message: string, options?: { httpStatus?: number; data?: unknown }) {
		super(message);
		this.name = "RpcError";
		this.code = code;
		this.httpStatus = options?.httpStatus ?? 200;
		this.data = options?.data;
	}
}

/** One content part; v1 accepts text/plain only. */
export interface A2aPart {
	text?: string;
	data?: unknown;
	url?: string;
	raw?: string;
	mediaType?: string;
	filename?: string;
	metadata?: Record<string, unknown>;
}

export type A2aRole = "ROLE_USER" | "ROLE_AGENT";

export interface A2aMessage {
	messageId: string;
	role: A2aRole;
	parts: A2aPart[];
	contextId?: string;
	taskId?: string;
	metadata?: Record<string, unknown>;
}

export interface A2aTaskStatus {
	state: TaskState;
	timestamp?: string;
	message?: A2aMessage;
}

export interface A2aTask {
	id: string;
	contextId?: string;
	status: A2aTaskStatus;
	artifacts?: unknown[];
	history?: A2aMessage[];
	metadata?: Record<string, unknown>;
}

export interface TaskStatusUpdateEvent {
	taskId: string;
	contextId: string;
	status: A2aTaskStatus;
	/** True on the last event of a stream: the task reached a terminal state. */
	final?: boolean;
	metadata?: Record<string, unknown>;
}

export interface ListTasksResult {
	tasks: A2aTask[];
	nextPageToken: string;
	pageSize: number;
	totalSize: number;
}

/** Map the real agent lifecycle onto an A2A task state. */
export function mapAgentStatus(ref: AgentRef): TaskState {
	switch (ref.status) {
		case "running":
		case "parked":
			return TASK_STATE.WORKING;
		case "aborted":
			return TASK_STATE.CANCELED;
		case "idle": {
			const terminal = ref.lifecycle?.terminalAt !== undefined || ref.history?.outputPath !== undefined;
			if (!terminal) return TASK_STATE.WORKING;
			// No exit code survives in the registry; a published output artifact is
			// the completed-run signal, its absence a failed one.
			return ref.history?.outputPath ? TASK_STATE.COMPLETED : TASK_STATE.FAILED;
		}
	}
}

/** The A2A status of one ref, with its last progress gist as the status message while working. */
export function taskStatusFromRef(ref: AgentRef): A2aTaskStatus {
	const state = mapAgentStatus(ref);
	const at = ref.lifecycle?.terminalAt ?? ref.lastActivity;
	const activity = state === TASK_STATE.WORKING ? ref.activity : undefined;
	return {
		state,
		timestamp: new Date(at).toISOString(),
		...(activity
			? {
					message: {
						messageId: `${ref.id}:${at}`,
						role: "ROLE_AGENT" as const,
						parts: [{ text: activity }],
					},
				}
			: {}),
	};
}

/** Serialize one registered agent as an A2A task, with omp-specific metadata attached. */
export function taskFromAgentRef(ref: AgentRef, extraMetadata?: Record<string, unknown>): A2aTask {
	return {
		id: ref.id,
		contextId: ref.parentId ?? MAIN_AGENT_ID,
		status: taskStatusFromRef(ref),
		metadata: {
			agentId: ref.id,
			agentKind: ref.kind,
			agentStatus: ref.status,
			displayName: ref.displayName,
			...(ref.history?.outputPath ? { outputPath: ref.history.outputPath } : {}),
			...extraMetadata,
		},
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function invalidParams(message: string, data?: unknown): RpcError {
	return new RpcError(RPC_ERRORS.INVALID_PARAMS, message, { data });
}

export interface ParsedSendMessage {
	messageId: string;
	text: string;
	/** omp extension: the existing agent id to deliver to. */
	to?: string;
	/** omp extension: agent definition for a spawn. */
	agent?: string;
	/** omp extension: shared background for a spawn. */
	context?: string;
}

/** Validate a `SendMessage` request and flatten its text parts. */
export function parseSendMessageParams(params: unknown): ParsedSendMessage {
	const request = asRecord(params);
	const message = asRecord(request?.message);
	if (!request || !message) throw invalidParams("params.message is required");
	const messageId = message.messageId;
	if (typeof messageId !== "string" || messageId.length === 0) {
		throw invalidParams("message.messageId is required");
	}
	const role = typeof message.role === "string" ? message.role : undefined;
	if (role !== undefined && role.toUpperCase() !== "ROLE_USER" && role.toLowerCase() !== "user") {
		throw invalidParams("message.role must be ROLE_USER");
	}
	if (!Array.isArray(message.parts) || message.parts.length === 0) {
		throw invalidParams("message.parts must contain at least one text part");
	}
	const texts: string[] = [];
	for (const part of message.parts) {
		const record = asRecord(part);
		if (record && typeof record.text === "string") {
			texts.push(record.text);
			continue;
		}
		throw new RpcError(RPC_ERRORS.CONTENT_TYPE_NOT_SUPPORTED, "Only text/plain parts are supported", {
			data: [{ mediaType: record?.mediaType ?? null }],
		});
	}
	const text = texts.join("\n").trim();
	if (text.length === 0) throw invalidParams("message.parts text must not be empty");
	const metadata = asRecord(request.metadata);
	const messageMetadata = asRecord(message.metadata);
	const readString = (key: string): string | undefined => {
		const value = metadata?.[key] ?? messageMetadata?.[key];
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
	};
	const to = readString("to");
	const agent = readString("agent");
	const context = readString("context");
	return {
		messageId,
		text,
		...(to !== undefined ? { to } : {}),
		...(agent !== undefined ? { agent } : {}),
		...(context !== undefined ? { context } : {}),
	};
}

/** Validate a `params.id` task reference. */
export function parseTaskIdParams(params: unknown, what = "params.id"): string {
	const id = asRecord(params)?.id;
	if (typeof id !== "string" || id.length === 0) throw invalidParams(`${what} is required`);
	return id;
}

export interface ParsedListTasks {
	contextId?: string;
	status?: TaskState;
	pageSize: number;
	offset: number;
}

const TASK_STATE_VALUES: ReadonlySet<string> = new Set(Object.values(TASK_STATE));

/** Validate a `ListTasks` request; pagination is a decimal offset cursor. */
export function parseListTasksParams(params: unknown): ParsedListTasks {
	const request = asRecord(params) ?? {};
	const contextId = typeof request.contextId === "string" ? request.contextId : undefined;
	const status = typeof request.status === "string" ? request.status : undefined;
	if (status !== undefined && !TASK_STATE_VALUES.has(status)) {
		throw invalidParams(`params.status is not a TaskState: ${status}`);
	}
	const rawPageSize = request.pageSize;
	if (rawPageSize !== undefined && (typeof rawPageSize !== "number" || !Number.isInteger(rawPageSize))) {
		throw invalidParams("params.pageSize must be an integer");
	}
	const pageSize = Math.min(Math.max(rawPageSize ?? 50, 1), 100);
	let offset = 0;
	if (request.pageToken !== undefined) {
		if (typeof request.pageToken !== "string" || !/^\d+$/.test(request.pageToken)) {
			throw invalidParams("params.pageToken must be a token returned by ListTasks");
		}
		offset = Number.parseInt(request.pageToken, 10);
	}
	return {
		...(contextId !== undefined ? { contextId } : {}),
		...(status !== undefined ? { status: status as TaskState } : {}),
		pageSize,
		offset,
	};
}

export interface A2aDispatchDeps {
	registry: Pick<AgentRegistryApi, "get" | "list" | "setStatus">;
	/** Deliver one message through the IRC bus. */
	send: (message: Omit<IrcMessage, "id" | "ts">) => Promise<IrcDeliveryReceipt>;
	/** Spawn a subagent through the extension seam; absent on hosts without a session. */
	spawn?: (options: SpawnSubagentOptions) => Promise<AgentRef>;
	/** Sender agent id recorded on bus messages. */
	senderId?: string;
}

export const A2A_SENDER_ID = "a2a";

/**
 * Resolve an omp address: an exact agent id, or the `main` alias. Advisor
 * transcripts are not peers — the agent card and ListTasks already hide them,
 * so GetTask/CancelTask must not reach them either.
 */
export function resolveAddressedRef(registry: Pick<AgentRegistryApi, "get">, to: string): AgentRef | undefined {
	const ref = registry.get(to) ?? (to.toLowerCase() === "main" ? registry.get(MAIN_AGENT_ID) : undefined);
	return ref?.kind === "advisor" ? undefined : ref;
}

/** Whether a spawn failure is a pre-spawn refusal the client can act on. */
function isSpawnRejection(error: unknown): error is Error {
	return (
		(error instanceof StructuredSubagentError && error.kind === "preflight") ||
		error instanceof SpawnRefusedError ||
		error instanceof PerCallModelError
	);
}

/**
 * Deliver one SendMessage: to an addressed agent through the bus (a receipt is
 * returned in the task metadata), or as a full spawn when no recipient is named.
 */
export async function sendA2aMessage(params: unknown, deps: A2aDispatchDeps): Promise<A2aTask> {
	const request = parseSendMessageParams(params);
	if (request.to !== undefined) {
		const target = resolveAddressedRef(deps.registry, request.to);
		if (!target) {
			throw new RpcError(RPC_ERRORS.TASK_NOT_FOUND, `Task not found: ${request.to}`, { httpStatus: 404 });
		}
		const receipt = await deps.send({
			from: deps.senderId ?? A2A_SENDER_ID,
			to: target.id,
			body: request.text,
		});
		const current = deps.registry.get(target.id) ?? target;
		return taskFromAgentRef(current, { delivery: receipt, requestedTo: request.to });
	}
	if (!deps.spawn) {
		throw new RpcError(RPC_ERRORS.INTERNAL_ERROR, "spawnSubagent is not available in this host");
	}
	let ref: AgentRef;
	try {
		ref = await deps.spawn({
			prompt: request.text,
			...(request.agent !== undefined ? { agent: request.agent } : {}),
			...(request.context !== undefined ? { context: request.context } : {}),
		});
	} catch (error) {
		// The run was reserved and is still starting: report the id as SUBMITTED
		// rather than a failure, so a client does not retry into a duplicate agent.
		if (error instanceof SpawnPendingError) {
			return {
				id: error.agentId,
				contextId: MAIN_AGENT_ID,
				status: { state: TASK_STATE.SUBMITTED, timestamp: new Date().toISOString() },
				metadata: { agentId: error.agentId, spawned: true, pending: true },
			};
		}
		if (isSpawnRejection(error)) {
			throw new RpcError(RPC_ERRORS.AGENT_REJECTED, error.message, {
				httpStatus: 200,
				data: [{ reason: "SPAWN_REJECTED" }],
			});
		}
		throw error;
	}
	return taskFromAgentRef(ref, { spawned: true });
}

/** Dispatch one non-streaming A2A method; unknown methods (and the SubscribeToTask cut) throw -32601. */
export async function dispatchA2aMethod(method: string, params: unknown, deps: A2aDispatchDeps): Promise<unknown> {
	switch (method) {
		case "SendMessage":
			return { task: await sendA2aMessage(params, deps) };
		case "GetTask": {
			const id = parseTaskIdParams(params);
			const ref = resolveAddressedRef(deps.registry, id);
			if (!ref) throw new RpcError(RPC_ERRORS.TASK_NOT_FOUND, `Task not found: ${id}`, { httpStatus: 404 });
			return taskFromAgentRef(ref);
		}
		case "ListTasks": {
			const request = parseListTasksParams(params);
			const refs = deps.registry
				.list()
				.filter(ref => ref.kind !== "advisor")
				.sort((a, b) => b.lastActivity - a.lastActivity);
			const tasks = refs
				.map(ref => taskFromAgentRef(ref))
				.filter(
					task =>
						(request.contextId === undefined || task.contextId === request.contextId) &&
						(request.status === undefined || task.status.state === request.status),
				);
			const page = tasks.slice(request.offset, request.offset + request.pageSize);
			const nextOffset = request.offset + page.length;
			const result: ListTasksResult = {
				tasks: page,
				nextPageToken: nextOffset < tasks.length ? String(nextOffset) : "",
				pageSize: request.pageSize,
				totalSize: tasks.length,
			};
			return result;
		}
		case "CancelTask": {
			const id = parseTaskIdParams(params);
			const ref = resolveAddressedRef(deps.registry, id);
			if (!ref) throw new RpcError(RPC_ERRORS.TASK_NOT_FOUND, `Task not found: ${id}`, { httpStatus: 404 });
			if (TERMINAL_TASK_STATES.has(mapAgentStatus(ref))) {
				throw new RpcError(RPC_ERRORS.TASK_NOT_CANCELABLE, `Task is already terminal: ${id}`, {
					httpStatus: 400,
				});
			}
			await ref.session?.abort({ reason: "a2a CancelTask" });
			deps.registry.setStatus(ref.id, "aborted");
			return taskFromAgentRef(deps.registry.get(ref.id) ?? ref);
		}
		default:
			throw new RpcError(RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
	}
}
