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
	/**
	 * Interrupted states: the task stays open until a human answers. The omp
	 * agent lifecycle never parks there, so the bridge serves them to clients
	 * that switch on the full v1.0 enum; omp's own client reports them as
	 * unusable instead of polling forever.
	 */
	INPUT_REQUIRED: "TASK_STATE_INPUT_REQUIRED",
	AUTH_REQUIRED: "TASK_STATE_AUTH_REQUIRED",
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
	/**
	 * The message reached the bridge but not the addressed agent: the IRC bus
	 * receipt came back `failed` (unknown recipient, dropped queued work, a
	 * guard refusal). HTTP 200 with a JSON-RPC error, so a client cannot mistake
	 * a refused delivery for an accepted one.
	 */
	DELIVERY_FAILED: -32011,
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

/** Largest published output inlined as a task artifact; the rest is a client-side read concern. */
export const A2A_ARTIFACT_MAX_CHARS = 100_000;

/**
 * Attach a completed run's published output to the task as a text artifact.
 *
 * A2A clients cannot read `metadata.outputPath`: it names a file on the
 * *server's* disk. Without the artifact a remote client learns the task
 * completed but never sees its answer, so `SendMessage`/`GetTask` inline the
 * output (bounded by {@link A2A_ARTIFACT_MAX_CHARS}). A failed read leaves the
 * task unchanged; the metadata path stays for same-host diagnostics.
 */
export async function attachOutputArtifact(
	task: A2aTask,
	readOutput: ((path: string) => Promise<string | undefined>) | undefined,
): Promise<A2aTask> {
	if (!readOutput || task.status.state !== TASK_STATE.COMPLETED) return task;
	if (Array.isArray(task.artifacts) && task.artifacts.length > 0) return task;
	const outputPath = asRecord(task.metadata)?.outputPath;
	if (typeof outputPath !== "string" || outputPath.length === 0) return task;
	const text = await readOutput(outputPath);
	if (text === undefined) return task;
	return {
		...task,
		artifacts: [
			{
				artifactId: `${task.id}:output`,
				name: "output",
				parts: [{ text: text.slice(0, A2A_ARTIFACT_MAX_CHARS) }],
			},
		],
	};
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
	/** omp extension: force a spawn even when `to` is given (spawn wins). */
	spawn?: boolean;
	/** omp extension: the sender terminal's public name (for the reply envelope). */
	from?: string;
	/** omp extension: the sender terminal's bridge url (for the reply envelope). */
	fromUrl?: string;
	/** omp extension: correlates a reply to a request messageId (no new reply envelope). */
	inReplyTo?: string;
	/** A2A grouping id from message.contextId, persisted per created task. */
	contextId?: string;
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
	const from = readString("from");
	const fromUrl = readString("fromUrl");
	const inReplyTo = readString("inReplyTo");
	const contextId =
		typeof message.contextId === "string" && message.contextId.trim().length > 0
			? message.contextId.trim()
			: undefined;
	const spawnRaw = metadata?.spawn ?? messageMetadata?.spawn;
	if (spawnRaw !== undefined && typeof spawnRaw !== "boolean") {
		throw invalidParams("metadata.spawn must be a boolean");
	}
	return {
		messageId,
		text,
		...(to !== undefined ? { to } : {}),
		...(agent !== undefined ? { agent } : {}),
		...(context !== undefined ? { context } : {}),
		...(from !== undefined ? { from } : {}),
		...(fromUrl !== undefined ? { fromUrl } : {}),
		...(spawnRaw === true ? { spawn: true } : {}),
		...(inReplyTo !== undefined ? { inReplyTo } : {}),
		...(contextId !== undefined ? { contextId } : {}),
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
	if (request.pageToken !== undefined && request.pageToken !== "") {
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
	/** Read a completed run's published output for the task artifact; absent leaves tasks text-free. */
	readOutput?: (path: string) => Promise<string | undefined>;
	/** Sender agent id recorded on bus messages. */
	senderId?: string;
	/** This bridge's public identity (`a2a.name`): `to` by that name resolves to the main agent. */
	identityName?: string;
	/** Ids of tasks created through this bridge (the only cancelable ones). */
	createdTaskIds?: Set<string>;
	/** Generation owned by each spawned task; undefined means its registration is pending. */
	createdTaskRefs?: Map<string, AgentRef | undefined>;
	/** Client contextId persisted per spawned task, for ListTasks filtering. */
	contextIds?: Map<string, string>;
	/** Notified when a peer request with a reply identity is delivered here. */
	noteIncomingRequest?: (from: string, messageId: string) => void;
}

export const A2A_SENDER_ID = "a2a";

/**
 * Resolve an omp address: an exact agent id, or the `main` alias. Advisor
 * transcripts are not peers — the agent card and ListTasks already hide them,
 * so GetTask/CancelTask must not reach them either.
 */
export function resolveAddressedRef(
	registry: Pick<AgentRegistryApi, "get">,
	to: string,
	identityName?: string,
): AgentRef | undefined {
	// `to` may be the registry id ("Main"), the literal "main", or the
	// terminal's public A2A identity (a2a.name): all resolve to the main ref.
	const lowered = to.toLowerCase();
	if (identityName !== undefined && lowered === identityName.toLowerCase()) {
		const byIdentity = registry.get(MAIN_AGENT_ID);
		if (byIdentity !== undefined) return byIdentity.kind === "advisor" ? undefined : byIdentity;
	}
	const ref =
		registry.get(to) ??
		(lowered === "main" ? registry.get(MAIN_AGENT_ID) : undefined) ??
		registry.get(to.slice(0, 1).toUpperCase() + to.slice(1));
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

/** Serialize a registered agent, applying any persisted client contextId (A9). */
function taskFor(ref: AgentRef, deps: A2aDispatchDeps, extraMetadata?: Record<string, unknown>): A2aTask {
	const task = taskFromAgentRef(ref, extraMetadata);
	const contextId = deps.contextIds?.get(ref.id);
	return contextId !== undefined ? { ...task, contextId } : task;
}

/** Record a SendMessage-created task: mark spawns cancelable (A8) and persist their contextId (A9). */
function persistTask(
	task: A2aTask,
	request: ParsedSendMessage,
	deps: A2aDispatchDeps,
	created: boolean,
	ref?: AgentRef,
): A2aTask {
	if (created) {
		deps.createdTaskIds?.add(task.id);
		deps.createdTaskRefs?.set(task.id, ref ?? deps.registry.get(task.id));
		if (request.contextId !== undefined) deps.contextIds?.set(task.id, request.contextId);
		else deps.contextIds?.delete(task.id);
	}
	return created && request.contextId !== undefined ? { ...task, contextId: request.contextId } : task;
}

/**
 * Deliver one SendMessage: to an addressed agent through the bus (a receipt is
 * returned in the task metadata), or as a full spawn when no recipient is named.
 */
export async function sendA2aMessage(params: unknown, deps: A2aDispatchDeps): Promise<A2aTask> {
	const request = parseSendMessageParams(params);
	const contextBlock =
		request.context !== undefined ? `[Shared context from the requesting terminal]\n${request.context}` : undefined;
	if (request.to !== undefined && request.spawn !== true) {
		const target = resolveAddressedRef(deps.registry, request.to, deps.identityName);
		if (!target) {
			throw new RpcError(RPC_ERRORS.TASK_NOT_FOUND, `Task not found: ${request.to}`, { httpStatus: 404 });
		}
		const sections: string[] = [];
		if (request.inReplyTo !== undefined) {
			// A2: a correlated reply. It is labelled as the answer to one request
			// but carries NO reply-back envelope, so it cannot start an unbounded
			// request -> reply -> request chain. No outstanding request is recorded.
			const from = request.from ?? "a peer terminal";
			sections.push(
				`[A2A reply to your request ${request.inReplyTo} from peer terminal ${from}. This is the answer, not a new task; no reply is expected.]`,
			);
		} else if (request.from !== undefined) {
			// A2: a request. The envelope names the a2a: agent to spawn for the
			// answer; this terminal's task tool attaches metadata.inReplyTo to that
			// spawn automatically, so the model only has to send the answer.
			sections.push(
				`[A2A task from peer terminal ${request.from}. This message was delivered into your conversation. When you have the answer, send it back by spawning the agent a2a:${request.from} with the task tool - that delivers your reply to the sender's terminal and is correlated to this request automatically. Do not answer in plain text: the sender only sees replies through the a2a agent.]`,
			);
		}
		if (contextBlock !== undefined) sections.push(contextBlock);
		sections.push(request.text);
		const body = sections.join("\n\n");
		const receipt = await deps.send({
			from: deps.senderId ?? A2A_SENDER_ID,
			to: target.id,
			body,
			external: true,
		});
		if (receipt.outcome !== "failed" && request.from !== undefined && request.inReplyTo === undefined) {
			deps.noteIncomingRequest?.(request.from, request.messageId);
		}
		const current = deps.registry.get(target.id) ?? target;
		return persistTask(taskFor(current, deps, { delivery: receipt, requestedTo: request.to }), request, deps, false);
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
			return persistTask(
				{
					id: error.agentId,
					contextId: MAIN_AGENT_ID,
					status: { state: TASK_STATE.SUBMITTED, timestamp: new Date().toISOString() },
					metadata: { agentId: error.agentId, spawned: true, pending: true },
				},
				request,
				deps,
				true,
			);
		}
		if (isSpawnRejection(error)) {
			throw new RpcError(RPC_ERRORS.AGENT_REJECTED, error.message, {
				httpStatus: 200,
				data: [{ reason: "SPAWN_REJECTED" }],
			});
		}
		throw error;
	}
	return persistTask(taskFromAgentRef(ref, { spawned: true }), request, deps, true, ref);
}

/** The bus receipt of a delivered task, when that delivery came back `failed`. */
export function failedDeliveryReceipt(task: A2aTask): IrcDeliveryReceipt | undefined {
	const delivery = asRecord(asRecord(task.metadata)?.delivery);
	return delivery?.outcome === "failed" ? (delivery as unknown as IrcDeliveryReceipt) : undefined;
}

/**
 * Turn a failed-delivery task into a terminal `TASK_STATE_FAILED` snapshot: the
 * streaming transport frames it and closes instead of waiting forever on a
 * status that will never change. `undefined` when the delivery succeeded.
 */
export function failedDeliveryTask(task: A2aTask): A2aTask | undefined {
	const receipt = failedDeliveryReceipt(task);
	if (!receipt) return undefined;
	const at = new Date().toISOString();
	const error = receipt.error ?? `Delivery to ${task.id} failed`;
	return {
		...task,
		status: {
			state: TASK_STATE.FAILED,
			timestamp: at,
			message: { messageId: `${task.id}:delivery-failed:${at}`, role: "ROLE_AGENT", parts: [{ text: error }] },
		},
	};
}

/**
 * Refuse a task whose delivery failed as a JSON-RPC error. Without this a
 * client reads HTTP 200 plus a task as success and never learns the addressed
 * agent never saw the message.
 */
export function assertTaskDelivered(task: A2aTask): void {
	const receipt = failedDeliveryReceipt(task);
	if (!receipt) return;
	throw new RpcError(RPC_ERRORS.DELIVERY_FAILED, receipt.error ?? `Delivery to ${task.id} failed`, {
		httpStatus: 200,
		data: [{ reason: "DELIVERY_FAILED" }],
	});
}

/** Dispatch one non-streaming A2A method; unknown methods (and the SubscribeToTask cut) throw -32601. */
export async function dispatchA2aMethod(method: string, params: unknown, deps: A2aDispatchDeps): Promise<unknown> {
	switch (method) {
		case "SendStreamingMessage":
		case "SendMessage": {
			const task = await sendA2aMessage(params, deps);
			assertTaskDelivered(task);
			return { task: await attachOutputArtifact(task, deps.readOutput) };
		}
		case "GetTask": {
			const id = parseTaskIdParams(params);
			const ref = resolveAddressedRef(deps.registry, id, deps.identityName);
			if (!ref) throw new RpcError(RPC_ERRORS.TASK_NOT_FOUND, `Task not found: ${id}`, { httpStatus: 404 });
			return attachOutputArtifact(taskFor(ref, deps), deps.readOutput);
		}
		case "ListTasks": {
			const request = parseListTasksParams(params);
			const refs = deps.registry
				.list()
				.filter(ref => ref.kind !== "advisor")
				// Stable creation order, not lastActivity: activity churn must not
				// reorder pages between two ListTasks calls (A9).
				.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
			const tasks = refs
				.map(ref => taskFor(ref, deps))
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
			const ref = resolveAddressedRef(deps.registry, id, deps.identityName);
			if (!ref) throw new RpcError(RPC_ERRORS.TASK_NOT_FOUND, `Task not found: ${id}`, { httpStatus: 404 });
			// Only tasks created through this bridge may be canceled. Main and local
			// subagents belong to the local session, not to a remote caller (A8).
			if (
				ref.kind === "main" ||
				!deps.createdTaskIds?.has(id) ||
				(deps.createdTaskRefs && deps.createdTaskRefs.get(id) !== ref)
			) {
				throw new RpcError(RPC_ERRORS.TASK_NOT_CANCELABLE, `Task is not cancelable through A2A: ${id}`, {
					httpStatus: 400,
				});
			}
			if (TERMINAL_TASK_STATES.has(mapAgentStatus(ref))) {
				throw new RpcError(RPC_ERRORS.TASK_NOT_CANCELABLE, `Task is already terminal: ${id}`, {
					httpStatus: 400,
				});
			}
			await ref.session?.abort({ reason: "a2a CancelTask" });
			// Re-check terminality and generation after abort: a completion or a
			// newer ref for this id must not be stamped `aborted` (A8).
			const current = deps.registry.get(ref.id);
			if (current === ref && !TERMINAL_TASK_STATES.has(mapAgentStatus(current))) {
				deps.registry.setStatus(ref.id, "aborted", ref);
			}
			return taskFor(ref, deps);
		}
		default:
			throw new RpcError(RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
	}
}
