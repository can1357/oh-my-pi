/**
 * A2A v1.0 HTTP bridge (Bun.serve) bound strictly to loopback.
 *
 * - `GET /.well-known/agent-card.json` is public discovery metadata.
 * - `POST /` (and `/rpc`) is JSON-RPC 2.0 behind a bearer token; wrong or
 *   missing credentials get HTTP 401 with a JSON-RPC error body.
 * - `SendStreamingMessage` answers with Server-Sent Events and closes the
 *   stream on the task's terminal state.
 *
 * The fork enables `a2a.enabled` by default: every terminal serves a loopback
 * bridge on a free port unless the setting or `--a2a-port` says otherwise. The
 * bearer token is generated once under the agent directory with mode 600
 * (`a2a.token`), unless `a2a.token` is set.
 */

import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { getAgentDir, VERSION } from "@oh-my-pi/pi-utils";
import type { IrcDeliveryReceipt, IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { Settings } from "../config/settings";
import type { SpawnSubagentOptions } from "../extensibility/extensions/types";
import { type IrcBusApi, IrcBus } from "../irc/bus";
import { type AgentLifecycleApi, AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID, type AgentRef, type AgentRegistryApi } from "../registry/agent-registry";
import {
	A2A_SENDER_ID,
	a2aReachableGroup,
	type A2aDispatchDeps,
	type A2aReachableGroup,
	type A2aTask,
	type JsonRpcFailure,
	type JsonRpcId,
	type JsonRpcSuccess,
	type TaskStatusUpdateEvent,
	PendingSpawnLedger,
	RPC_ERRORS,
	RpcError,
	TASK_STATE,
	TERMINAL_TASK_STATES,
	discardPendingSpawn,
	dispatchA2aMethod,
	failedDeliveryTask,
	sendA2aMessage,
	snapshotA2aTask,
} from "./rpc";
import type { AgentDefinition } from "../task/types";
import { discoverAgents } from "../task/discovery";
import { cfgA2aMaxPeerSkills, cfgA2aPort, cfgA2aReplyTimeoutMs, cfgA2aToken } from "../task/settings";
import { buildAgentCard, type AgentCard } from "./card";
import { IncomingRequests, type IncomingRequestsApi } from "./incoming-requests";
import { OutgoingRequests } from "./outgoing-requests";

/** The bridge never binds anything else: an A2A endpoint on a LAN is an open door. */
export const A2A_HOST = "127.0.0.1";
export const DEFAULT_A2A_PORT = 7391;
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const A2A_TOKEN_FILENAME = "a2a.token";
function taskSignature(task: A2aTask): string {
	return `${task.status.state}|${task.status.timestamp ?? ""}|${task.status.message?.parts[0]?.text ?? ""}`;
}
const RPC_PATHS: ReadonlySet<string> = new Set(["/", "/rpc"]);

/** The bus surface the bridge uses: one fire-and-forget delivery. */
export interface A2aBus {
	send(message: Omit<IrcMessage, "id" | "ts">): Promise<IrcDeliveryReceipt>;
}

export interface A2aServerOptions {
	token: string;
	port?: number;
	host?: string;
	/** Public A2A identity: renames the main skill and resolves `to` by name. */
	name?: string;
	/**
	 * Incoming-request ledger shared with relays and workers. Omitted resolves
	 * to the process-wide instance, so every bridge records requests in the
	 * same ledger the reply paths read.
	 */
	incoming?: IncomingRequestsApi;
	registry: Pick<AgentRegistryApi, "get" | "list" | "onChange" | "setStatus">;
	bus: A2aBus;
	spawn?: (options: SpawnSubagentOptions) => Promise<AgentRef>;
	card: () => AgentCard | Promise<AgentCard>;
	/** SSE fallback poll for progress that arrives without a registry event. */
	streamPollMs?: number;
	/**
	 * The agent lifecycle owning `registry` (A2A-1). Its revive capability
	 * gates both which parked refs the card advertises and which addressed
	 * deliveries resolve; omitted treats every parked ref as addressable and
	 * leaves the bus's own ensureLive gate to refuse impossible revives.
	 */
	lifecycle?: Pick<AgentLifecycleApi, "canRevive" | "manages">;
}

export interface A2aServerHandle {
	readonly host: string;
	readonly port: number;
	readonly url: string;
	stop(): void;
}

/**
 * Read a completed run's published output for the task artifact. A missing
 * file or a read error is not a bridge failure: the task stays text-free and
 * the metadata path still names the file for same-host consumers.
 */
async function readPublishedOutput(outputPath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(outputPath, "utf8");
	} catch {
		return undefined;
	}
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function rpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
	return { jsonrpc: "2.0", id, result };
}

function rpcFailure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
	return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** Constant-time bearer check; a missing or malformed header is simply unauthorized. */
function isAuthorized(header: string | null, token: string): boolean {
	if (!header) return false;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	if (!match) return false;
	const provided = Buffer.from(match[1]);
	const expected = Buffer.from(token);
	return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function parseRpcRequest(body: unknown): { id: JsonRpcId; method: string; params: unknown } {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new RpcError(RPC_ERRORS.INVALID_REQUEST, "Request payload validation error");
	}
	const record = body as Record<string, unknown>;
	const id = record.id;
	const validId = id === undefined || id === null || typeof id === "string" || typeof id === "number";
	if (record.jsonrpc !== "2.0" || typeof record.method !== "string" || !validId) {
		throw new RpcError(RPC_ERRORS.INVALID_REQUEST, "Request payload validation error");
	}
	return { id: (id ?? null) as JsonRpcId, method: record.method, params: record.params };
}

/**
 * Stream one task as `StreamResponse` frames: the initial task, then
 * `TaskStatusUpdateEvent`s for status or activity changes, closing on a
 * terminal state or when the client disconnects.
 */
function streamTaskResponse(
	id: JsonRpcId,
	task: A2aTask,
	options: Pick<A2aServerOptions, "registry" | "streamPollMs">,
	deps: A2aDispatchDeps,
	activeStreams: Set<() => void>,
): Response {
	const encoder = new TextEncoder();
	let closed = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let unsubscribeRegistry: (() => void) | undefined;
	let unsubscribeLedger: (() => void) | undefined;
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

	const frame = (result: unknown): void => {
		if (closed) return;
		controller?.enqueue(encoder.encode(`data: ${JSON.stringify(rpcSuccess(id, result))}\n\n`));
	};
	const settle = (close: boolean): void => {
		if (closed) return;
		closed = true;
		clearInterval(timer);
		unsubscribeRegistry?.();
		unsubscribeLedger?.();
		activeStreams.delete(stop);
		if (close) {
			try {
				controller?.close();
			} catch {
				// Already cancelled by the client.
			}
		}
	};
	const stop = (): void => settle(true);
	activeStreams.add(stop);
	let lastSignature = taskSignature(task);
	const emit = (): void => {
		if (closed) return;
		const snapshot = snapshotA2aTask(deps, task.id);
		// A non-pending ref that disappeared is still a terminal failure. A
		// pending registration stays SUBMITTED until its promise settles, so
		// snapshot is defined and this branch does not run.
		if (!snapshot) {
			const update: TaskStatusUpdateEvent = {
				taskId: task.id,
				contextId: task.contextId ?? "",
				status: { state: TASK_STATE.FAILED, timestamp: new Date().toISOString() },
				final: true,
			};
			frame({ statusUpdate: update });
			stop();
			return;
		}
		const signature = taskSignature(snapshot);
		if (signature === lastSignature) return;
		lastSignature = signature;
		const final = TERMINAL_TASK_STATES.has(snapshot.status.state);
		const update: TaskStatusUpdateEvent = {
			taskId: snapshot.id,
			contextId: snapshot.contextId ?? "",
			status: snapshot.status,
			final,
		};
		frame({ statusUpdate: update });
		if (final) stop();
	};

	const stream = new ReadableStream<Uint8Array>({
		start(streamController) {
			controller = streamController;
			frame({ task });
			if (TERMINAL_TASK_STATES.has(task.status.state)) {
				// The initial task is already terminal (a refused delivery, a
				// completed run): the stream still ends with the final status
				// update a spec client waits for before closing.
				const update: TaskStatusUpdateEvent = {
					taskId: task.id,
					contextId: task.contextId ?? "",
					status: task.status,
					final: true,
				};
				frame({ statusUpdate: update });
				stop();
				return;
			}
			unsubscribeRegistry = options.registry.onChange(event => {
				if (event.ref.id === task.id) emit();
			});
			unsubscribeLedger = deps.pendingSpawns?.subscribe(changedId => {
				if (changedId === task.id) emit();
			});
			// Catch a settlement that landed between SendMessage and subscribe.
			emit();
			const interval = setInterval(emit, options.streamPollMs ?? 250);
			timer = interval;
			// An SSE stream must not pin the event loop: `server.unref()` alone
			// cannot release a per-stream interval.
			interval.unref?.();
		},
		cancel() {
			settle(false);
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		},
	});
}

/** Create and start the bridge; `port: 0` asks the OS for an ephemeral port. */
export function createA2aServer(options: A2aServerOptions): A2aServerHandle {
	const host = options.host ?? A2A_HOST;
	if (host !== A2A_HOST) {
		throw new Error(`A2A server binds ${A2A_HOST} only (refusing host ${host})`);
	}
	if (options.token.length === 0) throw new Error("A2A server requires a non-empty bearer token");
	/** Every open stream's stop closure: `stop()` closes them, `server.stop` alone does not. */
	const activeStreams = new Set<() => void>();
	const pendingSpawns = new PendingSpawnLedger();
	const canRevive = options.lifecycle?.manages(options.registry)
		? (ref: AgentRef) => options.lifecycle!.canRevive(ref)
		: undefined;
	const dispatchDeps: A2aDispatchDeps = {
		registry: options.registry,
		...(options.name !== undefined ? { identityName: options.name } : {}),
		send: (message: Omit<IrcMessage, "id" | "ts">) => options.bus.send(message),
		spawn: options.spawn,
		readOutput: readPublishedOutput,
		senderId: A2A_SENDER_ID,
		createdTaskIds: new Set<string>(),
		createdTaskRefs: new Map<string, AgentRef | undefined>(),
		contextIds: new Map<string, string>(),
		pendingSpawns,
		incoming: options.incoming ?? IncomingRequests.global(),
		outgoing: OutgoingRequests.global(),
		...(canRevive !== undefined ? { canRevive } : {}),
	};
	const unsubscribe = options.registry.onChange(event => {
		if (event.type === "removed") {
			// A resolved pending spawn must not outlive the exact ref the registry
			// dropped. Evict that record so GetTask, ListTasks, and SSE match a
			// normal unregistration: missing, absent, and one final FAILED.
			const record = pendingSpawns.get(event.ref.id);
			if (record?.ref === event.ref) discardPendingSpawn(dispatchDeps, record);
			return;
		}
		if (event.type !== "registered" || !dispatchDeps.createdTaskRefs?.has(event.ref.id)) return;
		// A pending registration owns an exact future ref. The first registered
		// event for that id may be a replacement and must not be claimed.
		if (pendingSpawns.get(event.ref.id)?.outcome === "pending") return;
		const owned = dispatchDeps.createdTaskRefs.get(event.ref.id);
		if (owned === undefined) {
			dispatchDeps.createdTaskRefs.set(event.ref.id, event.ref);
		} else if (owned !== event.ref) {
			dispatchDeps.createdTaskRefs.delete(event.ref.id);
			dispatchDeps.createdTaskIds?.delete(event.ref.id);
			dispatchDeps.contextIds?.delete(event.ref.id);
		}
	});

	const server = Bun.serve({
		hostname: host,
		port: options.port ?? DEFAULT_A2A_PORT,
		async fetch(request: Request): Promise<Response> {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === AGENT_CARD_PATH) {
				return jsonResponse(await options.card());
			}
			if (request.method !== "POST" || !RPC_PATHS.has(url.pathname)) {
				return new Response("Not Found", { status: 404 });
			}
			if (!isAuthorized(request.headers.get("authorization"), options.token)) {
				return jsonResponse(rpcFailure(null, RPC_ERRORS.UNAUTHORIZED, "Unauthorized"), 401);
			}
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return jsonResponse(rpcFailure(null, RPC_ERRORS.PARSE_ERROR, "Invalid JSON payload"));
			}
			// SendStreamingMessage is a single-request SSE upgrade: it has no
			// meaning in a batch or as a notification (both need a JSON body back).
			if (
				!Array.isArray(body) &&
				typeof body === "object" &&
				body !== null &&
				(body as Record<string, unknown>).method === "SendStreamingMessage" &&
				Object.prototype.hasOwnProperty.call(body, "id")
			) {
				let rpc: { id: JsonRpcId; method: string; params: unknown };
				try {
					rpc = parseRpcRequest(body);
				} catch (error) {
					const rpcError = error instanceof RpcError ? error : undefined;
					return jsonResponse(
						rpcFailure(
							null,
							rpcError?.code ?? RPC_ERRORS.INVALID_REQUEST,
							rpcError?.message ?? "Invalid request",
						),
						rpcError?.httpStatus ?? 200,
					);
				}
				try {
					const task = await sendA2aMessage(rpc.params, dispatchDeps);
					// A refused delivery is terminal: frame the initial task and a
					// final TASK_STATE_FAILED, then close. The task's own registry
					// state may never change, so waiting on it would hang the stream.
					return streamTaskResponse(
						rpc.id,
						failedDeliveryTask(task) ?? task,
						options,
						dispatchDeps,
						activeStreams,
					);
				} catch (error) {
					if (error instanceof RpcError) {
						return jsonResponse(rpcFailure(rpc.id, error.code, error.message, error.data), error.httpStatus);
					}
					const message = error instanceof Error ? error.message : String(error);
					return jsonResponse(rpcFailure(rpc.id, RPC_ERRORS.INTERNAL_ERROR, message), 500);
				}
			}
			// A2A/JSON-RPC: single request, notification (no id -> 204), or batch.
			const calls: unknown[] = Array.isArray(body) ? body : [body];
			const batch = Array.isArray(body);
			if (batch && calls.length === 0) {
				return jsonResponse(rpcFailure(null, RPC_ERRORS.INVALID_REQUEST, "Invalid request"));
			}
			const responses: Array<JsonRpcSuccess | JsonRpcFailure> = [];
			let singleStatus: number | undefined;
			for (const call of calls) {
				let rpc: { id: JsonRpcId; method: string; params: unknown };
				try {
					rpc = parseRpcRequest(call);
				} catch (error) {
					const rpcError = error instanceof RpcError ? error : undefined;
					responses.push(
						rpcFailure(
							null,
							rpcError?.code ?? RPC_ERRORS.INVALID_REQUEST,
							rpcError?.message ?? "Invalid request",
						),
					);
					continue;
				}
				// A request without an `id` is a notification: process it but never
				// put a response on the wire (JSON-RPC 2.0, A9).
				const notification = !Object.prototype.hasOwnProperty.call(call as object, "id");
				try {
					const result = await dispatchA2aMethod(rpc.method, rpc.params, dispatchDeps);
					if (!notification) responses.push(rpcSuccess(rpc.id, result));
				} catch (error) {
					if (notification) continue;
					if (error instanceof RpcError) {
						responses.push(rpcFailure(rpc.id, error.code, error.message, error.data));
						if (!batch) singleStatus = error.httpStatus;
					} else {
						const message = error instanceof Error ? error.message : String(error);
						responses.push(rpcFailure(rpc.id, RPC_ERRORS.INTERNAL_ERROR, message));
						if (!batch) singleStatus = 500;
					}
				}
			}
			if (responses.length === 0) return new Response(null, { status: 204 });
			return jsonResponse(batch ? responses : responses[0], singleStatus ?? 200);
		},
	});

	// A bridge is a sidecar: it must never keep a finished session's process
	// alive on its own socket.
	server.unref();
	const port = server.port ?? options.port ?? DEFAULT_A2A_PORT;
	return {
		host,
		port,
		url: `http://${host}:${port}/`,
		stop(): void {
			unsubscribe();
			for (const stopStream of activeStreams) stopStream();
			activeStreams.clear();
			pendingSpawns.release();
			server.stop(true);
		},
	};
}

export interface ResolveA2aTokenOptions {
	/** Defaults to the fork agent directory (`PI_CODING_AGENT_DIR` / `~/.omp`). */
	agentDir?: string;
	/** The `a2a.token` setting; when set it wins and no file is touched. */
	explicitToken?: string;
}

/**
 * Resolve the bearer token: the configured value, else `a2a.token` under the
 * agent directory, generated once (32 random bytes, mode 600) when absent.
 * Concurrent first enables race on `wx`; the loser reads the winner's token.
 */
export async function resolveA2aToken(options: ResolveA2aTokenOptions): Promise<string> {
	const explicit = options.explicitToken?.trim();
	if (explicit) return explicit;
	const dir = options.agentDir ?? getAgentDir();
	const file = path.join(dir, A2A_TOKEN_FILENAME);
	const readExisting = async (): Promise<string | undefined> => {
		try {
			const token = (await fs.readFile(file, "utf8")).trim();
			await fs.chmod(file, 0o600);
			return token.length > 0 ? token : undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	};
	const existing = await readExisting();
	if (existing) return existing;
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const token = randomBytes(32).toString("hex");
	try {
		await fs.writeFile(file, `${token}\n`, { mode: 0o600, flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			const raced = await readExisting();
			if (raced) return raced;
			throw new Error(`A2A token file exists but is empty: ${file}`);
		}
		throw error;
	}
	await fs.chmod(file, 0o600);
	return token;
}

/** Session surface the bridge needs for agent discovery. */
export interface A2aHostSession {
	cwd: string;
	getSessionAgents?: () => AgentDefinition[];
	effectiveExtensionRoots?: () => EffectiveExtensionRoots;
}

export interface StartA2aServerOptions extends Omit<A2aServerOptions, "card" | "token"> {
	settings: Settings;
	agentDir?: string;
	/** Pre-built card; absent builds skills from the registry plus discovery. */
	card?: () => AgentCard | Promise<AgentCard>;
	version?: string;
	/** Session whose cwd and agent discovery feed the card. */
	session?: A2aHostSession;
	/** Public A2A identity (`a2a.name` / `--a2a-name`): renames the main agent's skill id. */
	name?: string;
}

/**
 * Start the bridge for a live session: resolve the token, serve a card built
 * from the agent registry plus discovery descriptions, and route spawns through
 * the injected seam (the CLI injects the task-executor seam).
 */
export async function startA2aServer(options: StartA2aServerOptions): Promise<A2aServerHandle> {
	const { registry } = options;
	const token = await resolveA2aToken({
		agentDir: options.agentDir ?? options.settings.getAgentDir(),
		explicitToken: cfgA2aToken.get(options.settings),
	});
	// Discovery is a filesystem scan; the card route is public and may be hit by
	// any local page, so memoize the descriptions and only re-read the registry
	// (cheap, live) per request. A failed scan is retried on the next request.
	let descriptionsPromise: Promise<Map<string, string>> | undefined;
	const loadDescriptions = (): Promise<Map<string, string>> => {
		descriptionsPromise ??= (async () => {
			const cwd = options.session?.cwd ?? process.cwd();
			const discovery = await discoverAgents(cwd, undefined, options.session?.effectiveExtensionRoots?.());
			const sessionAgents = options.session?.getSessionAgents?.() ?? [];
			return new Map([...discovery.agents, ...sessionAgents].map(agent => [agent.name, agent.description] as const));
		})().catch(error => {
			descriptionsPromise = undefined;
			throw error;
		});
		return descriptionsPromise;
	};
	const cwd = options.session?.cwd ?? process.cwd();
	// A1: an unset/empty name becomes a unique, skill-id-safe terminal name so
	// peers can always register a2a:<name> and address a reply back.
	const identity = options.name?.trim() || autoA2aName(cwd);
	// A3: a random per-process id mirrored in the served card lets a reader
	// confirm the port it found still belongs to THIS bridge (pid reuse).
	const instanceId = randomBytes(16).toString("hex");
	// The lifecycle owning this registry proves actual parked revive
	// capability (A2A-1); without one, no parked ref is advertised and the
	// bus's own ensureLive gate stays the delivery authority.
	const lifecycle = options.lifecycle ?? AgentLifecycleManager.global();
	const canReviveParked = lifecycle.manages(registry) ? (ref: AgentRef) => lifecycle.canRevive(ref) : undefined;
	const maxPeerSkills = Math.max(1, cfgA2aMaxPeerSkills.get(options.settings));
	const card = async (): Promise<AgentCard> => {
		if (options.card) return { ...(await options.card()), instanceId };
		const descriptions = await loadDescriptions();
		// A2A-1: advertise every agent this terminal can actually deliver to —
		// Main first, then running, kept-alive idle, and revivable parked
		// subagents — each group sorted by newest activity, then id. The cap
		// applies AFTER the ordering, so it drops the least recently active
		// reachable agents, never whole status groups. Finished one-shot
		// corpses, aborted agents, advisors and unrevivable parked refs stay
		// off the card; they remain addressable only while a delivery path
		// can still reach them (idle wake / lifecycle revive).
		const groups = new Map<A2aReachableGroup, AgentRef[]>();
		for (const ref of registry.list()) {
			const group = a2aReachableGroup(ref);
			if (group === undefined) continue;
			// A kept-alive idle agent is addressable only while its live session
			// is attached (an IRC wake needs it); a detached idle corpse is a
			// finished one-shot the card must not advertise.
			if (group === "idle" && ref.kind === "sub" && ref.session === null) continue;
			if (group === "parked" && !(canReviveParked?.(ref) ?? false)) continue;
			const bucket = groups.get(group) ?? [];
			bucket.push(ref);
			groups.set(group, bucket);
		}
		const ordered: AgentRef[] = [];
		for (const group of ["main", "running", "idle", "parked"] as const) {
			const bucket = groups.get(group) ?? [];
			bucket.sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id));
			ordered.push(...bucket);
		}
		const skills = ordered.slice(0, maxPeerSkills).map(ref => ({
			id: ref.id === MAIN_AGENT_ID ? identity : ref.id,
			displayName: ref.displayName,
			description: descriptions.get(ref.history?.agent ?? ref.id),
		}));
		return buildAgentCard({
			url: `http://${A2A_HOST}:${handle.port}/`,
			version: options.version ?? VERSION,
			skills,
			name: identity,
			instanceId,
		});
	};

	// The bridge owns the incoming ledger's maintenance for its lifetime:
	// recipient removal and reply-deadline expiry. Only the concrete
	// main-thread ledger carries `startCleanup`; an injected proxy is
	// maintained by its installer. Workers share main's ledger and never
	// install a cleanup service of their own.
	const ledger = options.incoming ?? IncomingRequests.global();
	const stopCleanup =
		ledger instanceof IncomingRequests
			? ledger.startCleanup(registry, cfgA2aReplyTimeoutMs.get(options.settings))
			: undefined;
	let handle: A2aServerHandle;
	try {
		handle = createA2aServer({
			...options,
			name: identity,
			port: options.port ?? cfgA2aPort.get(options.settings),
			token,
			card,
			incoming: ledger,
			lifecycle,
		});
		const agentDir = options.agentDir ?? options.settings.getAgentDir();
		await registerLocalBridge({
			agentDir,
			port: handle.port,
			name: identity,
			instanceId,
		});
		// A3: remove this process's own discovery file when the bridge stops,
		// together with the ledger cleanup this bridge installed.
		return {
			host: handle.host,
			port: handle.port,
			url: handle.url,
			stop(): void {
				try {
					const file = bridgeEntryPath(agentDir, process.pid);
					const entry: unknown = JSON.parse(syncFs.readFileSync(file, "utf8"));
					if (isLocalBridgeEntry(entry, process.pid) && entry.instanceId === instanceId)
						syncFs.rmSync(file, { force: true });
				} catch {
					// Discovery cleanup is best effort.
				}
				stopCleanup?.();
				handle.stop();
			},
		};
	} catch (error) {
		// A failed startup after cleanup installation must not leave the
		// subscription or its expiry timer behind on the ledger.
		stopCleanup?.();
		throw error;
	}
}

/** One registry entry for a locally running bridge; one file per process (A3). */
export interface LocalBridgeEntry {
	pid: number;
	port: number;
	startedAt: number;
	/** Public A2A identity (configured name or the auto-generated terminal name). */
	name?: string;
	/** Random per-process id, mirrored in the served card for liveness checks. */
	instanceId: string;
}

/** A2A v1.0 skill-id-safe terminal name derived from the cwd basename + pid (A1). */
export function autoA2aName(cwd: string): string {
	const slug = path
		.basename(cwd)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${slug.length > 0 ? slug : "omp"}-${process.pid}`;
}

function localBridgesDir(agentDir: string): string {
	return path.join(agentDir, "a2a-bridges");
}

function bridgeEntryPath(agentDir: string, pid: number): string {
	return path.join(localBridgesDir(agentDir), `${pid}.json`);
}

/**
 * Record this bridge in the machine-local discovery registry (A3): one file
 * per process, written atomically (tmp + rename) so two terminals registering
 * at the same time never clobber each other. Best effort - a failed write never
 * blocks the bridge.
 */
export async function registerLocalBridge(options: {
	agentDir: string;
	port: number;
	name?: string;
	instanceId: string;
	/** Override for tests simulating another process. */
	pid?: number;
}): Promise<void> {
	try {
		const pid = options.pid ?? process.pid;
		await fs.mkdir(localBridgesDir(options.agentDir), { recursive: true, mode: 0o700 });
		const entry: LocalBridgeEntry = {
			pid,
			port: options.port,
			startedAt: Date.now(),
			...(options.name !== undefined ? { name: options.name } : {}),
			instanceId: options.instanceId,
		};
		const file = bridgeEntryPath(options.agentDir, pid);
		const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
		await fs.writeFile(tmp, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		await fs.rename(tmp, file);
	} catch {
		// Discovery is best effort; a failed write never blocks the bridge.
	}
}

/** Remove this process's own discovery file on shutdown (A3). */
export async function unregisterLocalBridge(agentDir: string, pid: number = process.pid): Promise<void> {
	try {
		await fs.rm(bridgeEntryPath(agentDir, pid), { force: true });
	} catch {
		// best effort
	}
}

function isLocalBridgeEntry(value: unknown, pid: number): value is LocalBridgeEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		entry.pid === pid &&
		typeof entry.port === "number" &&
		Number.isInteger(entry.port) &&
		entry.port > 0 &&
		entry.port <= 65535 &&
		typeof entry.startedAt === "number" &&
		typeof entry.instanceId === "string" &&
		entry.instanceId.length > 0 &&
		(entry.name === undefined || typeof entry.name === "string")
	);
}

/** This process's own registry entry, read directly from its <pid>.json file (A3). */
export async function readLocalBridgeEntry(agentDir: string, pid: number): Promise<LocalBridgeEntry | undefined> {
	try {
		const entry: unknown = JSON.parse(await fs.readFile(bridgeEntryPath(agentDir, pid), "utf8"));
		return isLocalBridgeEntry(entry, pid) ? entry : undefined;
	} catch {
		return undefined;
	}
}

/** This terminal's public A2A identity for reply envelopes (A1/A3); empty when no bridge is registered. */
export async function readOwnA2aIdentity(agentDir: string): Promise<{ name?: string; url?: string }> {
	const entry = await readLocalBridgeEntry(agentDir, process.pid);
	if (entry === undefined) return {};
	return {
		...(entry.name !== undefined ? { name: entry.name } : {}),
		url: `http://${A2A_HOST}:${entry.port}/`,
	};
}

/**
 * Live local bridges: readers list the a2a-bridges dir (A3). Liveness is a
 * pid-existence check; dead entries are deleted on read. `excludePid` (default
 * this process) keeps a terminal from registering itself as its own peer.
 */
export async function readLiveBridges(
	agentDir: string,
	options: { excludePid?: number } = {},
): Promise<Map<number, LocalBridgeEntry>> {
	const map = new Map<number, LocalBridgeEntry>();
	const excludePid = options.excludePid ?? process.pid;
	let names: string[];
	try {
		names = await fs.readdir(localBridgesDir(agentDir));
	} catch {
		return map;
	}
	for (const name of names) {
		const match = /^(\d+)\.json$/.exec(name);
		if (!match) continue;
		const pid = Number(match[1]);
		const file = path.join(localBridgesDir(agentDir), name);
		let entry: unknown;
		try {
			entry = JSON.parse(await fs.readFile(file, "utf8"));
		} catch {
			continue; // unreadable entry: skip it
		}
		if (pid === excludePid) continue;
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
			await fs.rm(file, { force: true }).catch(() => {}); // dead pid: prune on read
			continue;
		}
		if (isLocalBridgeEntry(entry, pid)) map.set(pid, entry);
	}
	return map;
}

/** Process-global wiring used by the CLI: the shared registry plus its IRC bus. */
export function defaultA2aDeps(): { registry: AgentRegistryApi; bus: IrcBusApi } {
	return { registry: AgentRegistry.global(), bus: IrcBus.global() };
}
