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
import { truncateCodePoints } from "../utils/code-points";
import type { IncomingRequestsApi } from "./incoming-requests";
import type { OutgoingRequestsApi } from "./outgoing-requests";
import type { IrcDeliveryReceipt, IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { logger } from "@oh-my-pi/pi-utils";

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

/** Largest published output inlined as a task artifact, in Unicode code points; the rest is a client-side read concern. */
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
				parts: [{ text: truncateCodePoints(text, A2A_ARTIFACT_MAX_CHARS) }],
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
/** One bridge-created spawn whose registration has not been discarded. */
export interface PendingSpawnRecord {
	/** Stable SUBMITTED view captured when the spawn was reserved. */
	task: A2aTask;
	registration: Promise<AgentRef>;
	/** Creation time in epoch ms, so ListTasks can order this row with registry refs. */
	createdAt: number;
	outcome: "pending" | "resolved" | "rejected";
	/** The registration promise's exact ref, once it resolves. */
	ref?: AgentRef;
	reason?: string;
	/** Terminal view captured once, so a rejection does not mint a new timestamp per read. */
	failedTask?: A2aTask;
	cancelRequested: boolean;
}

/** Bridge-owned pending spawns shared by SendMessage, GetTask, ListTasks, and SSE. */
export class PendingSpawnLedger {
	readonly #records = new Map<string, PendingSpawnRecord>();
	readonly #listeners = new Set<(id: string) => void>();

	get(id: string): PendingSpawnRecord | undefined {
		return this.#records.get(id);
	}

	records(): PendingSpawnRecord[] {
		return [...this.#records.values()];
	}

	track(record: PendingSpawnRecord): void {
		this.#records.set(record.task.id, record);
	}

	/** Drop one record. The caller notifies views that were serving it. */
	delete(id: string): void {
		this.#records.delete(id);
	}

	subscribe(listener: (id: string) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	notify(id: string): void {
		for (const listener of this.#listeners) listener(id);
	}

	/** Drop every stream subscription. Called when the server closes. */
	release(): void {
		this.#listeners.clear();
	}
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
	/**
	 * Incoming-request ledger. A request with a reply identity is recorded
	 * here before delivery and rolled back by exact match when the delivery is
	 * refused. Absent only for dispatch callers that do no reply tracking;
	 * the live server always passes the process-wide instance.
	 */
	incoming?: IncomingRequestsApi;
	/**
	 * Pending spawns created by this bridge. Absent only for callers that never
	 * spawn; the live server always installs one ledger for every view.
	 */
	pendingSpawns?: PendingSpawnLedger;
	/** Process-wide outgoing reply registry. Absent leaves a correlated reply on IRC. */
	outgoing?: OutgoingRequestsApi;
	/**
	 * Proves a `parked` recipient can actually be revived by the agent
	 * lifecycle (A2A-1). Absent treats a parked ref as addressable: callers
	 * without a lifecycle keep the pre-A2A-1 bus behavior (the bus's own
	 * ensureLive gate still refuses an impossible revive).
	 */
	canRevive?: (ref: AgentRef) => boolean;
}

/** A delivered peer request that expects an answer (A2). */
export interface A2aIncomingRequest {
	/** Sender's public A2A identity: its `a2a:<from>` agent carries the reply. */
	from: string;
	/**
	 * The sender's bridge URL as it arrived on the wire (`metadata.fromUrl`).
	 * Retained so an automatic reply can pin the originating endpoint when
	 * several registrations share `from` as their skill id; never used to
	 * construct a destination — only registered peers are ever sent to.
	 */
	fromUrl?: string;
	/** The request's A2A `messageId`, echoed back as `inReplyTo`. */
	messageId: string;
	/** Local agent id the request was delivered to. */
	to: string;
	/** When delivery started (ms since epoch): output after it may answer the request. */
	at: number;
}

export const A2A_SENDER_ID = "a2a";

/** Which reachable group an agent belongs to for A2A delivery and card order. */
export type A2aReachableGroup = "main" | "running" | "idle" | "parked";

/**
 * The narrow shared reachability predicate behind the served card and
 * addressed delivery (A2A-1): Main is always addressable by identity, a
 * `running` subagent receives asides, an `idle` subagent is woken by the
 * IRC bus, and a `parked` subagent goes through the lifecycle revive path.
 * Advisors and aborted tombstones are unreachable — `undefined`. The bus
 * stays the delivery authority for everything else: an idle ref whose
 * session is gone fails there with the existing `failed` receipt.
 */
export function a2aReachableGroup(ref: AgentRef): A2aReachableGroup | undefined {
	if (ref.kind === "advisor") return undefined;
	if (ref.kind === "main") return ref.status === "aborted" ? undefined : "main";
	switch (ref.status) {
		case "running":
			return "running";
		case "idle":
			return "idle";
		case "parked":
			return "parked";
		case "aborted":
			return undefined;
	}
}

/**
 * Resolve an omp address: an exact agent id, or the `main` alias. Advisor
 * transcripts are not peers — the agent card and ListTasks already hide them,
 * so GetTask/CancelTask must not reach them either. Deliverability is a
 * separate A2A-1 gate (see {@link sendA2aMessage}); every registered
 * non-advisor ref stays visible to task views.
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

/**
 * Resolve an omp address to a ref A2A delivery can deliver to (A2A-1): the
 * normal address resolution gated by {@link a2aReachableGroup} and, for
 * `parked` refs, the lifecycle's proven revive capability. Advisors, aborted
 * tombstones and unrevivable parked refs resolve to `undefined` and are
 * refused like an unknown agent (`TASK_NOT_FOUND`, HTTP 404), as is a ref
 * removed between discovery and delivery. A still-registered idle corpse
 * (no live session) resolves normally: it is a legitimate lookup whose
 * delivery the IRC bus then refuses, surfacing as the existing
 * `DELIVERY_FAILED` error (HTTP 200) — never a 404 and never a fresh
 * replacement spawn.
 */
export function resolveDeliverableRef(
	registry: Pick<AgentRegistryApi, "get">,
	to: string,
	identityName?: string,
	canRevive?: (ref: AgentRef) => boolean,
): AgentRef | undefined {
	const ref = resolveAddressedRef(registry, to, identityName);
	if (ref === undefined || a2aReachableGroup(ref) === undefined) return undefined;
	// A parked ref needs a proven revive path; an impossible revive is the
	// unknown-agent failure the caller already reports.
	if (ref.status === "parked" && canRevive !== undefined && !canRevive(ref)) return undefined;
	return ref;
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
		// Pending spawns pass no ref, so this stays undefined until
		// claimResolvedRef. Do not capture registry.get: a reused id may still
		// hold a stale earlier generation, and that comparison must see only
		// the registry at resolve time.
		deps.createdTaskRefs?.set(task.id, ref);
		if (request.contextId !== undefined) deps.contextIds?.set(task.id, request.contextId);
		else deps.contextIds?.delete(task.id);
	}
	return created && request.contextId !== undefined ? { ...task, contextId: request.contextId } : task;
}

function registrationFailureReason(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

function failPendingRecord(record: PendingSpawnRecord, reason: string): void {
	const at = new Date().toISOString();
	record.outcome = "rejected";
	record.reason = reason;
	record.failedTask = {
		...record.task,
		status: {
			state: TASK_STATE.FAILED,
			timestamp: at,
			message: {
				messageId: `${record.task.id}:registration-failed:${at}`,
				role: "ROLE_AGENT",
				parts: [{ text: reason }],
			},
		},
	};
}

/** Own the registration's exact ref, or drop the id when a replacement already holds it. */
function claimResolvedRef(deps: A2aDispatchDeps, ref: AgentRef): void {
	const current = deps.registry.get(ref.id);
	if ((current !== undefined && current !== ref) || (deps.createdTaskRefs?.get(ref.id) ?? ref) !== ref) {
		deps.createdTaskRefs?.delete(ref.id);
		deps.createdTaskIds?.delete(ref.id);
		deps.contextIds?.delete(ref.id);
		return;
	}
	deps.createdTaskRefs?.set(ref.id, ref);
}

/**
 * Abort one owned generation. A different ref now stored under the same id is a
 * replacement: its session is never aborted and its status is never stamped.
 */
async function abortOwnedRef(deps: A2aDispatchDeps, ref: AgentRef): Promise<void> {
	const current = deps.registry.get(ref.id);
	if (current !== undefined && current !== ref) {
		if (!TERMINAL_TASK_STATES.has(mapAgentStatus(ref))) {
			await ref.session?.abort({ reason: "a2a CancelTask" });
		}
		return;
	}
	if (TERMINAL_TASK_STATES.has(mapAgentStatus(ref))) return;
	await ref.session?.abort({ reason: "a2a CancelTask" });
	const after = deps.registry.get(ref.id);
	if (after === ref && !TERMINAL_TASK_STATES.has(mapAgentStatus(after))) {
		deps.registry.setStatus(ref.id, "aborted", ref);
	}
}
/**
 * The removal transition shared by the registry `removed` event and a
 * registration that settles to a ref the registry no longer holds: drop the
 * pending row — only while it is still this exact ledger record — with its
 * ownership and context state, then notify the views that served it. A
 * replacement ref under the same id is never mutated, and a normal removal
 * stays missing: no new rejected/FAILED tombstone is minted.
 */
export function discardPendingSpawn(deps: A2aDispatchDeps, record: PendingSpawnRecord): void {
	const ledger = deps.pendingSpawns;
	// An obsolete callback must not discard a newer ledger record for the id.
	if (ledger?.get(record.task.id) !== record) return;
	ledger.delete(record.task.id);
	deps.createdTaskRefs?.delete(record.task.id);
	deps.createdTaskIds?.delete(record.task.id);
	deps.contextIds?.delete(record.task.id);
	ledger.notify(record.task.id);
}

async function onRegistrationResolved(deps: A2aDispatchDeps, record: PendingSpawnRecord, ref: AgentRef): Promise<void> {
	// The ref may have registered and been removed — or been replaced under
	// the id — before this callback ran. The exact-ref check gates every
	// mutation below: resolving the row into a ref the registry no longer
	// holds would resurrect a removed agent through GetTask/ListTasks/SSE and
	// let a pending cancel abort a generation the registry already dropped.
	// A mismatch is the same transition as the registry's `removed` event.
	if (deps.registry.get(ref.id) !== ref) {
		discardPendingSpawn(deps, record);
		return;
	}
	record.outcome = "resolved";
	record.ref = ref;
	claimResolvedRef(deps, ref);
	if (record.cancelRequested) await abortOwnedRef(deps, ref);
	deps.pendingSpawns?.notify(record.task.id);
}

function onRegistrationRejected(deps: A2aDispatchDeps, record: PendingSpawnRecord, reason: unknown): void {
	failPendingRecord(record, registrationFailureReason(reason));
	deps.pendingSpawns?.notify(record.task.id);
}

/** Remember a reserved spawn and settle it from its registration promise, not from registry absence. */
function trackPendingSpawn(
	deps: A2aDispatchDeps,
	task: A2aTask,
	registration: Promise<AgentRef>,
	createdAt: number,
): void {
	const ledger = deps.pendingSpawns;
	if (!ledger) return;
	const record: PendingSpawnRecord = {
		task,
		registration,
		createdAt,
		outcome: "pending",
		cancelRequested: false,
	};
	ledger.track(record);
	void registration
		.then(
			ref => onRegistrationResolved(deps, record, ref),
			reason => {
				onRegistrationRejected(deps, record, reason);
			},
		)
		.catch((error: unknown) => {
			logger.warn("A2A pending spawn abort failed", {
				taskId: record.task.id,
				error: error instanceof Error ? error.message : String(error),
			});
			ledger.notify(record.task.id);
		});
}

/**
 * The task every view serves for `id`: a live registry ref, the stable pending
 * row, the registration's resolved ref, or the registration failure. Undefined
 * when nothing owns the id (advisors included).
 */
export function snapshotA2aTask(deps: A2aDispatchDeps, id: string): A2aTask | undefined {
	const record = deps.pendingSpawns?.get(id);
	const addressed = resolveAddressedRef(deps.registry, id, deps.identityName);
	if (record?.outcome === "rejected") {
		if (addressed && addressed !== record.ref) return taskFor(addressed, deps);
		return record.failedTask;
	}
	if (record?.outcome === "resolved" && record.ref) {
		const current = deps.registry.get(record.ref.id);
		if (current) return taskFor(current, deps);
		return taskFor(record.ref, deps);
	}
	if (record?.outcome === "pending") {
		// Invariant: registration resolves to the first ref registered under this
		// id, so a live registry ref here is that generation, not a replacement.
		if (addressed) return taskFor(addressed, deps);
		return record.task;
	}
	if (!addressed) return undefined;
	return taskFor(addressed, deps);
}

/** Registry refs plus ledger rows that are not already represented, in stable creation order. */
function listA2aTaskRows(deps: A2aDispatchDeps): Array<{ createdAt: number; task: A2aTask }> {
	const rows: Array<{ createdAt: number; id: string; task: A2aTask }> = [];
	const seen = new Set<string>();
	for (const ref of deps.registry.list()) {
		if (ref.kind === "advisor") continue;
		const task = snapshotA2aTask(deps, ref.id);
		if (!task) continue;
		rows.push({ createdAt: ref.createdAt, id: ref.id, task });
		seen.add(ref.id);
	}
	for (const record of deps.pendingSpawns?.records() ?? []) {
		if (seen.has(record.task.id)) continue;
		const task = snapshotA2aTask(deps, record.task.id);
		if (!task) continue;
		rows.push({ createdAt: record.createdAt, id: task.id, task });
	}
	rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	return rows;
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
		const target = resolveDeliverableRef(deps.registry, request.to, deps.identityName, deps.canRevive);
		if (!target) {
			throw new RpcError(RPC_ERRORS.TASK_NOT_FOUND, `Task not found: ${request.to}`, { httpStatus: 404 });
		}
		if (request.inReplyTo !== undefined && request.from !== undefined && deps.outgoing) {
			const matched = await deps.outgoing.resolve(request.inReplyTo, request.from, request.text);
			if (matched) {
				const current = deps.registry.get(target.id) ?? target;
				return persistTask(
					taskFor(current, deps, { delivery: { to: target.id, outcome: "injected" }, requestedTo: request.to }),
					request,
					deps,
					false,
				);
			}
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
				`[A2A task from peer terminal ${request.from}. This message was delivered into your conversation. When you have the answer, send it back by spawning the agent a2a:${request.from} with the task tool - that delivers your reply to the sender's terminal and is correlated to this request automatically. The sender only sees what reaches it through the a2a agent.]`,
			);
		}
		if (contextBlock !== undefined) sections.push(contextBlock);
		sections.push(request.text);
		const body = sections.join("\n\n");
		const deliveredAt = Date.now();
		// A request with a reply identity is recorded BEFORE the delivery: a
		// fast recipient wakes synchronously inside the bus send and may claim
		// (or even answer) it before this function sees the receipt, so the
		// record must already exist. A correlated reply records nothing.
		const from = request.from;
		const trackIncoming = from !== undefined && request.inReplyTo === undefined;
		const incomingRecord = trackIncoming
			? {
					from,
					messageId: request.messageId,
					to: target.id,
					at: deliveredAt,
					...(request.fromUrl !== undefined ? { fromUrl: request.fromUrl } : {}),
				}
			: undefined;
		if (incomingRecord !== undefined) {
			try {
				await deps.incoming?.note(incomingRecord);
			} catch (error) {
				// The bookkeeping failed: never deliver a request whose reply
				// tracking is lost, or the sender would wait forever.
				const reason = error instanceof Error ? error.message : String(error);
				throw new RpcError(RPC_ERRORS.INTERNAL_ERROR, `Failed to record incoming request: ${reason}`);
			}
		}
		let receipt: IrcDeliveryReceipt;
		try {
			receipt = await deps.send({
				from: deps.senderId ?? A2A_SENDER_ID,
				to: target.id,
				body,
				external: true,
				...(request.inReplyTo !== undefined
					? { a2aInReplyTo: request.inReplyTo }
					: { a2aMessageId: request.messageId }),
			});
		} catch (error) {
			// A fast recipient may already hold a claim on this request; the
			// exact-record discard invalidates it without touching others.
			if (incomingRecord !== undefined) await deps.incoming?.discard(incomingRecord);
			throw error;
		}
		if (receipt.outcome === "failed" && incomingRecord !== undefined) {
			// Refused delivery: the addressed agent never saw the request, so
			// its record and any lease a fast claimant took on it must go.
			await deps.incoming?.discard(incomingRecord);
		}
		// A woken/revived delivery started a new turn (A2A-1): the response
		// task must report WORKING, never a completed prior turn's terminal
		// state. GetTask keeps reading the live ref, so the task terminalizes
		// when the wake turn actually settles.
		const current = deps.registry.get(target.id) ?? target;
		const task = taskFor(current, deps, { delivery: receipt, requestedTo: request.to });
		const delivered =
			receipt.outcome === "woken" || receipt.outcome === "revived"
				? { ...task, status: { state: TASK_STATE.WORKING, timestamp: task.status.timestamp } }
				: task;
		return persistTask(delivered, request, deps, false);
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
		// The run was reserved and is still starting. Keep its registration
		// promise: absence from the registry is not a failure, and a second
		// SendMessage for the same id must not reset the stable timestamp.
		if (error instanceof SpawnPendingError) {
			const existing = deps.pendingSpawns?.get(error.agentId);
			if (existing?.outcome === "pending") return existing.task;
			const createdAt = Date.now();
			const task = persistTask(
				{
					id: error.agentId,
					contextId: MAIN_AGENT_ID,
					status: { state: TASK_STATE.SUBMITTED, timestamp: new Date(createdAt).toISOString() },
					metadata: { agentId: error.agentId, spawned: true, pending: true },
				},
				request,
				deps,
				true,
			);
			trackPendingSpawn(deps, task, error.registration, createdAt);
			return task;
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
			const task = snapshotA2aTask(deps, id);
			if (!task) throw new RpcError(RPC_ERRORS.TASK_NOT_FOUND, `Task not found: ${id}`, { httpStatus: 404 });
			return attachOutputArtifact(task, deps.readOutput);
		}
		case "ListTasks": {
			const request = parseListTasksParams(params);
			const tasks = listA2aTaskRows(deps)
				.map(row => row.task)
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
			const pending = deps.pendingSpawns?.get(id);
			// Registration is still open: record intent and apply it to that exact
			// ref when the promise settles. Do not abort whatever currently occupies the id.
			if (pending?.outcome === "pending") {
				if (!deps.createdTaskIds?.has(id)) {
					throw new RpcError(RPC_ERRORS.TASK_NOT_CANCELABLE, `Task is not cancelable through A2A: ${id}`, {
						httpStatus: 400,
					});
				}
				pending.cancelRequested = true;
				return pending.task;
			}
			const ref = resolveAddressedRef(deps.registry, id, deps.identityName);
			if (!ref) {
				if (pending?.outcome === "rejected") {
					throw new RpcError(RPC_ERRORS.TASK_NOT_CANCELABLE, `Task is already terminal: ${id}`, {
						httpStatus: 400,
					});
				}
				throw new RpcError(RPC_ERRORS.TASK_NOT_FOUND, `Task not found: ${id}`, { httpStatus: 404 });
			}
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
			await abortOwnedRef(deps, ref);
			return taskFor(ref, deps);
		}
		default:
			throw new RpcError(RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
	}
}
