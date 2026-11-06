/**
 * A2A v1.0 HTTP bridge (Bun.serve) bound strictly to loopback.
 *
 * - `GET /.well-known/agent-card.json` is public discovery metadata.
 * - `POST /` (and `/rpc`) is JSON-RPC 2.0 behind a bearer token; wrong or
 *   missing credentials get HTTP 401 with a JSON-RPC error body.
 * - `SendStreamingMessage` answers with Server-Sent Events and closes the
 *   stream on the task's terminal state.
 *
 * `a2a.enabled` defaults off; the server starts only from the `--a2a-port` flag
 * or that setting. The bearer token is generated once under the agent directory
 * with mode 600 (`a2a.token`), unless `a2a.token` is set.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { getAgentDir, VERSION } from "@oh-my-pi/pi-utils";
import type { IrcDeliveryReceipt, IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { Settings } from "../config/settings";
import type { SpawnSubagentOptions } from "../extensibility/extensions/types";
import { type IrcBusApi, IrcBus } from "../irc/bus";
import { AgentRegistry, type AgentRef, type AgentRegistryApi } from "../registry/agent-registry";
import { discoverAgents } from "../task/discovery";
import { cfgA2aPort, cfgA2aToken } from "../task/settings";
import type { AgentDefinition } from "../task/types";
import { buildAgentCard, type AgentCard } from "./card";
import {
	A2A_SENDER_ID,
	type A2aTask,
	type JsonRpcFailure,
	type JsonRpcId,
	type JsonRpcSuccess,
	type TaskStatusUpdateEvent,
	RPC_ERRORS,
	RpcError,
	TASK_STATE,
	TERMINAL_TASK_STATES,
	dispatchA2aMethod,
	failedDeliveryTask,
	sendA2aMessage,
	taskFromAgentRef,
} from "./rpc";

/** The bridge never binds anything else: an A2A endpoint on a LAN is an open door. */
export const A2A_HOST = "127.0.0.1";
export const DEFAULT_A2A_PORT = 7391;
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const A2A_TOKEN_FILENAME = "a2a.token";
/** How long a stream waits on a SUBMITTED (reserved, not yet registered) spawn. */
const PENDING_SPAWN_GRACE_MS = 30_000;
const RPC_PATHS: ReadonlySet<string> = new Set(["/", "/rpc"]);

/** The bus surface the bridge uses: one fire-and-forget delivery. */
export interface A2aBus {
	send(message: Omit<IrcMessage, "id" | "ts">): Promise<IrcDeliveryReceipt>;
}

export interface A2aServerOptions {
	token: string;
	port?: number;
	host?: string;
	registry: Pick<AgentRegistryApi, "get" | "list" | "onChange" | "setStatus">;
	bus: A2aBus;
	spawn?: (options: SpawnSubagentOptions) => Promise<AgentRef>;
	card: () => AgentCard | Promise<AgentCard>;
	/** SSE fallback poll for progress that arrives without a registry event. */
	streamPollMs?: number;
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
	activeStreams: Set<() => void>,
): Response {
	const encoder = new TextEncoder();
	let closed = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let unsubscribe: (() => void) | undefined;
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

	const frame = (result: unknown): void => {
		if (closed) return;
		controller?.enqueue(encoder.encode(`data: ${JSON.stringify(rpcSuccess(id, result))}\n\n`));
	};
	const settle = (close: boolean): void => {
		if (closed) return;
		closed = true;
		clearInterval(timer);
		unsubscribe?.();
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
	let lastSignature = `${task.status.state}|${task.status.timestamp ?? ""}`;
	// A SUBMITTED task is a reserved spawn whose run is still starting: its id
	// is not in the registry yet, and that must not read as a terminal failure.
	let pendingUntil = task.metadata?.pending === true ? Date.now() + PENDING_SPAWN_GRACE_MS : 0;
	const emit = (): void => {
		if (closed) return;
		const ref = options.registry.get(task.id);
		if (!ref) {
			if (pendingUntil > 0 && Date.now() < pendingUntil) return;
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
		pendingUntil = 0;
		const snapshot = taskFromAgentRef(ref);
		const signature = `${snapshot.status.state}|${snapshot.status.timestamp ?? ""}|${ref.activity ?? ""}`;
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
			unsubscribe = options.registry.onChange(event => {
				if (event.ref.id === task.id) emit();
			});
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
	const dispatchDeps = {
		registry: options.registry,
		send: (message: Omit<IrcMessage, "id" | "ts">) => options.bus.send(message),
		spawn: options.spawn,
		readOutput: readPublishedOutput,
		senderId: A2A_SENDER_ID,
	};

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
			let rpc: { id: JsonRpcId; method: string; params: unknown };
			try {
				rpc = parseRpcRequest(body);
			} catch (error) {
				const rpcError = error instanceof RpcError ? error : undefined;
				return jsonResponse(
					rpcFailure(null, rpcError?.code ?? RPC_ERRORS.INVALID_REQUEST, rpcError?.message ?? "Invalid request"),
					rpcError?.httpStatus ?? 200,
				);
			}
			try {
				if (rpc.method === "SendStreamingMessage") {
					const task = await sendA2aMessage(rpc.params, dispatchDeps);
					// A refused delivery is terminal: frame the initial task and a
					// final TASK_STATE_FAILED, then close. The task's own registry
					// state may never change, so waiting on it would hang the stream.
					return streamTaskResponse(rpc.id, failedDeliveryTask(task) ?? task, options, activeStreams);
				}
				const result = await dispatchA2aMethod(rpc.method, rpc.params, dispatchDeps);
				return jsonResponse(rpcSuccess(rpc.id, result));
			} catch (error) {
				if (error instanceof RpcError) {
					return jsonResponse(rpcFailure(rpc.id, error.code, error.message, error.data), error.httpStatus);
				}
				const message = error instanceof Error ? error.message : String(error);
				return jsonResponse(rpcFailure(rpc.id, RPC_ERRORS.INTERNAL_ERROR, message), 500);
			}
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
			for (const stopStream of activeStreams) stopStream();
			activeStreams.clear();
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
	const card =
		options.card ??
		(async (): Promise<AgentCard> => {
			const descriptions = await loadDescriptions();
			const skills = registry
				.list()
				.filter(ref => ref.kind !== "advisor")
				.map(ref => ({
					id: ref.id,
					displayName: ref.displayName,
					description: descriptions.get(ref.history?.agent ?? ref.id),
				}));
			return buildAgentCard({
				url: `http://${A2A_HOST}:${handle.port}/`,
				version: options.version ?? VERSION,
				skills,
			});
		});

	const handle = createA2aServer({
		...options,
		port: options.port ?? cfgA2aPort.get(options.settings),
		token,
		card,
	});
	await registerLocalBridge({
		agentDir: options.agentDir ?? options.settings.getAgentDir(),
		port: handle.port,
		token,
	});
	return handle;
}

/** One registry entry for a locally running bridge; written under <agent dir>. */
export interface LocalBridgeEntry {
	pid: number;
	port: number;
	startedAt: number;
}

function localBridgesPath(agentDir: string): string {
	return path.join(agentDir, "a2a-bridges.json");
}

/** Record this bridge in the machine-local discovery registry (best effort). */
async function registerLocalBridge(options: { agentDir: string; port: number; token: string }): Promise<void> {
	try {
		const file = localBridgesPath(options.agentDir);
		const existing = await readLiveBridges(options.agentDir);
		existing.set(process.pid, { pid: process.pid, port: options.port, startedAt: Date.now() });
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await fs.writeFile(
			file,
			`${JSON.stringify([...existing.values()])}
`,
			{ mode: 0o600 },
		);
	} catch {
		// Discovery is best effort; a failed write never blocks the bridge.
	}
}

/** Live local bridges: entries whose pid still exists, this process excluded. */
export async function readLiveBridges(agentDir: string): Promise<Map<number, LocalBridgeEntry>> {
	const map = new Map<number, LocalBridgeEntry>();
	try {
		const raw = await fs.readFile(localBridgesPath(agentDir), "utf8");
		const entries = JSON.parse(raw) as LocalBridgeEntry[];
		if (!Array.isArray(entries)) return map;
		for (const entry of entries) {
			if (typeof entry?.pid !== "number" || typeof entry?.port !== "number") continue;
			if (entry.pid === process.pid) continue;
			try {
				process.kill(entry.pid, 0);
			} catch {
				continue; // dead pid: pruned by not being re-written
			}
			map.set(entry.pid, entry);
		}
	} catch {
		// missing or unreadable registry: no bridges
	}
	return map;
}

/** Process-global wiring used by the CLI: the shared registry plus its IRC bus. */
export function defaultA2aDeps(): { registry: AgentRegistryApi; bus: IrcBusApi } {
	return { registry: AgentRegistry.global(), bus: IrcBus.global() };
}
