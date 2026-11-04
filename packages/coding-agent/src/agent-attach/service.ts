import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getBaseConfigRoot, logger } from "@oh-my-pi/pi-utils";
import { toWireData } from "../thread/session-mirror";
import { isAgentViewSession, type AgentViewSession } from "../session/agent-session-handle";
import type { AgentSession } from "../session/agent-session";
import type { AgentRegistryApi, AgentRef } from "../registry/agent-registry";
import { EventBus } from "../utils/event-bus";
import { assertOwnerPrivateDir } from "../utils/owner-private-dir";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../task/types";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "../modes/rpc/rpc-frame";
import {
	parseAgentAttachClientRequest,
	TASK_SUBAGENT_ATTACH_CHANNEL,
	type AgentAttachAvailablePayload,
	type AgentAttachCommandRequest,
	type AgentAttachErrorCode,
	type AgentAttachServerFrame,
} from "./protocol";

const ATTACH_VERSION = 1;
const AUTH_TIMEOUT_MS = 5_000;

interface AgentAttachServiceOptions {
	session: AgentSession;
	registry: AgentRegistryApi;
	eventBus: EventBus;
	subagentEventBus: EventBus;
	dir?: string;
}

export interface AgentAttachService {
	close(): Promise<void>;
}

interface Publication {
	endpoint: string;
	metaPath: string;
	closeServer: () => Promise<void>;
	connections: Set<IpcConnection>;
	removeOnExit: () => void;
	closed: boolean;
}

interface Membership {
	id: string;
	ownerSessionId: string;
	generation: number;
	instanceKey: string;
	ref: AgentRef;
	session: AgentViewSession;
	sessionFile: string | undefined;
	notified: boolean;
}

interface Outgoing {
	frame?: AgentAttachServerFrame;
	bytes: number;
	snapshot?: boolean;
}

interface AttachClient {
	connection: IpcConnection;
	membership?: Membership;
	encoder: RpcFrameEncoder;
	outgoing: Outgoing[];
	bufferedEvents: AgentAttachServerFrame[];
	commandUnsubscribers: Set<() => void>;
	pendingBytes: number;
	pumping: boolean;
	closed: boolean;
	closing: boolean;
	snapshotPending: boolean;
	unsubscribeSession?: () => void;
	unsubscribeRunState?: () => void;
}

interface StartedMembership {
	id: string;
	instanceKey: string;
	sessionFile?: string | null;
}

interface LifecycleEvent {
	id: string;
	status: "started" | "completed" | "failed" | "aborted";
	instanceKey: string;
	sessionFile?: string | null;
}

const LifecycleShape = type({
	"+": "delete",
	id: "string >= 1",
	status: '"started" | "completed" | "failed" | "aborted"',
	sessionInstanceKey: "string >= 1",
	"sessionFile?": "string | null",
});

function attachmentDir(): string {
	return path.join(getBaseConfigRoot(), "run", "agent-attach");
}

function randomHex(bytes: number): string {
	const data = crypto.webcrypto.getRandomValues(new Uint8Array(bytes));
	let result = "";
	for (const byte of data) result += byte.toString(16).padStart(2, "0");
	return result;
}

function privateEndpointFiles(endpoint: string): string[] {
	return process.platform === "win32" ? [] : [endpoint, `${endpoint}.bind.lock`];
}

function removeFilesSync(files: readonly string[]): void {
	for (const file of files) {
		try {
			fsSync.rmSync(file, { force: true });
		} catch {
			// The next start can clean up artifacts left by a failed OS unlink.
		}
	}
}

function tokenMatches(expected: string, presented: string): boolean {
	const expectedBytes = Buffer.from(expected, "utf8");
	const presentedBytes = Buffer.from(presented, "utf8");
	return expectedBytes.length === presentedBytes.length && crypto.timingSafeEqual(expectedBytes, presentedBytes);
}

function parseLifecycleEvent(value: unknown): LifecycleEvent | undefined {
	const parsed = LifecycleShape(value);
	if (parsed instanceof type.errors) return undefined;
	return {
		id: parsed.id,
		status: parsed.status,
		instanceKey: parsed.sessionInstanceKey,
		sessionFile: parsed.sessionFile,
	};
}

function requestIdOf(value: unknown): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	const requestId: unknown = Reflect.get(value, "requestId");
	return Number.isSafeInteger(requestId) && (requestId as number) > 0 ? (requestId as number) : undefined;
}

export async function startAgentAttachService(options: AgentAttachServiceOptions): Promise<AgentAttachService> {
	const dir = options.dir ?? attachmentDir();
	const memberships = new Map<string, Membership>();
	const pendingMemberships = new Map<string, StartedMembership>();
	const clients = new Set<AttachClient>();
	const publications = new Set<Publication>();
	let currentPublication: Publication | undefined;
	let ownerSessionId = options.session.sessionManager.getSessionId();
	let closed = false;
	let publishPromise: Promise<void> | undefined;
	let ownerSwitchPromise = Promise.resolve();

	const sameLiveMembership = (membership: Membership): boolean => {
		const current = options.registry.get(membership.id);
		return (
			!closed &&
			membership.ownerSessionId === ownerSessionId &&
			memberships.get(membership.id) === membership &&
			current === membership.ref &&
			current.generation === membership.generation &&
			current.kind === "sub" &&
			current.session === membership.session &&
			(current.status === "running" || current.status === "idle") &&
			membership.session.instanceKey === membership.instanceKey &&
			(membership.sessionFile === undefined || current.sessionFile === membership.sessionFile)
		);
	};

	const unsubscribeClient = (client: AttachClient): void => {
		client.unsubscribeSession?.();
		client.unsubscribeRunState?.();
		for (const unsubscribe of client.commandUnsubscribers) unsubscribe();
		client.commandUnsubscribers.clear();
		client.unsubscribeSession = undefined;
		client.unsubscribeRunState = undefined;
	};
	const finishClient = (client: AttachClient, graceful: boolean): void => {
		if (client.closed) return;
		client.closed = true;
		client.closing = false;
		client.outgoing.length = 0;
		client.bufferedEvents.length = 0;
		client.pendingBytes = 0;
		unsubscribeClient(client);
		clients.delete(client);
		client.membership = undefined;
		if (graceful) client.connection.end();
		else client.connection.destroy();
	};

	const queueFrame = (client: AttachClient, frame: AgentAttachServerFrame, bypassSnapshot = false): boolean => {
		if (client.closed || client.closing) return false;
		const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8") + 1;
		if (bytes > MAX_RPC_REASSEMBLED_BYTES) {
			failClient(client, "transport_limit", "A single attachment update exceeds the transport limit.");
			return false;
		}
		if (client.pendingBytes + bytes > MAX_RPC_REASSEMBLED_BYTES) {
			failClient(client, "lagged", "Attachment output fell behind; run agent attach again.");
			return false;
		}
		if (client.snapshotPending && !bypassSnapshot) {
			client.bufferedEvents.push(frame);
			client.pendingBytes += bytes;
			return true;
		}
		client.outgoing.push({ frame, bytes });
		client.pendingBytes += bytes;
		void pump(client);
		return true;
	};

	const pump = async (client: AttachClient): Promise<void> => {
		if (client.pumping || client.closed) return;
		client.pumping = true;
		try {
			while (!client.closed && client.outgoing.length > 0) {
				const item = client.outgoing.shift()!;
				if (item.snapshot) {
					await captureSnapshot(client);
					continue;
				}
				if (!item.frame) continue;
				for (const line of client.encoder.encodeFrames(item.frame)) {
					if (client.connection.closed) {
						finishClient(client, false);
						return;
					}
					const framedLine = line.endsWith("\n") ? line.slice(0, -1) : line;
					if (!client.connection.send(framedLine)) await client.connection.drained();
				}
				client.pendingBytes = Math.max(0, client.pendingBytes - item.bytes);
			}
		} catch {
			finishClient(client, false);
		} finally {
			client.pumping = false;
			if (!client.closed && client.closing && client.outgoing.length === 0) finishClient(client, true);
		}
	};

	function failClient(client: AttachClient, code: AgentAttachErrorCode, message: string, requestId?: number): void {
		if (client.closed || client.closing) return;
		unsubscribeClient(client);
		client.bufferedEvents.length = 0;
		client.outgoing.length = 0;
		client.pendingBytes = 0;
		client.closing = true;
		const frame: AgentAttachServerFrame = { type: "error", requestId, code, message };
		const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8") + 1;
		client.outgoing.push({ frame, bytes });
		client.pendingBytes = bytes;
		void pump(client);
	}

	function enqueueSnapshotFrames(client: AttachClient, frames: AgentAttachServerFrame[]): boolean {
		const output: Outgoing[] = [];
		let bytes = 0;
		for (const frame of frames) {
			const size = Buffer.byteLength(JSON.stringify(frame), "utf8") + 1;
			if (size > MAX_RPC_REASSEMBLED_BYTES || client.pendingBytes + bytes + size > MAX_RPC_REASSEMBLED_BYTES) {
				failClient(client, "transport_limit", "The task snapshot exceeds the attachment transport limit.");
				return false;
			}
			bytes += size;
			output.push({ frame, bytes: size });
		}
		client.outgoing.unshift(...output);
		client.pendingBytes += bytes;
		return true;
	}

	function snapshotFrames(membership: Membership): AgentAttachServerFrame[] {
		if (!sameLiveMembership(membership)) throw new Error("session_gone");
		const target = membership.session;
		const sessionContext = target.buildTranscriptSessionContext({ keepInFlightToolCalls: true });
		const messages = toWireData(sessionContext.messages);
		const streamMessage = toWireData(target.agent.state.streamMessage);
		const pendingToolResults = toWireData([...target.agent.getPendingToolResults()]);
		const activeToolExecutionUpdates = toWireData([...target.activeToolExecutionUpdates()]);
		const stats = toWireData(target.getSessionStats());
		const queue = toWireData(target.getQueuedMessages());
		const model = target.model ? { provider: target.model.provider, id: target.model.id } : null;
		const frames: AgentAttachServerFrame[] = [
			{
				type: "snapshot_start",
				agentId: membership.id,
				ownerSessionId: membership.ownerSessionId,
				generation: membership.generation,
				displayName: membership.ref.displayName,
				status: membership.ref.status === "running" ? "running" : "idle",
				cwd: target.sessionManager.getCwd(),
				model,
				isStreaming: target.isStreaming,
				stats,
			},
		];
		for (let index = 0; index < messages.length; index++) {
			frames.push({ type: "snapshot_message", index, message: messages[index]! });
		}
		frames.push({
			type: "snapshot_end",
			streamMessage,
			pendingToolResults,
			activeToolExecutionUpdates,
			queue: {
				steering: [...queue.steering],
				followUp: [...queue.followUp],
				liveSteered: queue.liveSteered,
			},
		});
		return frames;
	}

	async function captureSnapshot(client: AttachClient): Promise<void> {
		const membership = client.membership;
		if (!membership || !sameLiveMembership(membership)) {
			failClient(client, "session_gone", "The attached task session is no longer live.");
			return;
		}
		try {
			await membership.session.settleInFlightMessagePersistence();
			if (!sameLiveMembership(membership)) {
				failClient(client, "session_gone", "The attached task session is no longer live.");
				return;
			}
			const bufferedBytes = client.bufferedEvents.reduce(
				(sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame), "utf8") + 1,
				0,
			);
			client.bufferedEvents.length = 0;
			client.pendingBytes = Math.max(0, client.pendingBytes - bufferedBytes);
			if (!enqueueSnapshotFrames(client, snapshotFrames(membership))) return;
			client.snapshotPending = false;
		} catch {
			failClient(client, "session_gone", "The attached task session is no longer available.");
		}
	}

	const scheduleSnapshot = (client: AttachClient): void => {
		if (client.closed || client.closing || client.snapshotPending) return;
		client.snapshotPending = true;
		client.outgoing.push({ bytes: 0, snapshot: true });
		void pump(client);
	};

	const isSuccessfulCompaction = (event: unknown): boolean => {
		if (!event || typeof event !== "object") return false;
		const eventType: unknown = Reflect.get(event, "type");
		const aborted: unknown = Reflect.get(event, "aborted");
		if (aborted !== false) return false;
		if (eventType === "manual_compaction_end") return Boolean(Reflect.get(event, "result"));
		return (
			eventType === "auto_compaction_end" &&
			!Reflect.get(event, "willRetry") &&
			Boolean(Reflect.get(event, "result"))
		);
	};

	const bindClientSession = (client: AttachClient, membership: Membership): void => {
		client.membership = membership;
		client.snapshotPending = true;
		client.unsubscribeSession = membership.session.subscribe(event => {
			if (!sameLiveMembership(membership)) {
				failClient(client, "session_gone", "The attached task session is no longer live.");
				return;
			}
			const wireEvent = toWireData(event);
			if (isSuccessfulCompaction(event)) {
				scheduleSnapshot(client);
				queueFrame(client, { type: "event", event: wireEvent }, true);
				return;
			}
			queueFrame(client, { type: "event", event: wireEvent });
		});
		client.unsubscribeRunState = membership.session.subscribeRunState(state => {
			if (!sameLiveMembership(membership)) {
				failClient(client, "session_gone", "The attached task session is no longer live.");
				return;
			}
			queueFrame(client, { type: "run_state", state });
		});
		client.outgoing.push({ bytes: 0, snapshot: true });
		void pump(client);
	};

	const sendCommandError = (client: AttachClient, requestId: number, error: unknown): void => {
		const message = error instanceof Error ? error.message : String(error);
		queueFrame(client, { type: "error", requestId, code: "command_failed", message: message.slice(0, 2048) }, true);
	};

	const dispatchCommand = (client: AttachClient, request: AgentAttachCommandRequest): void => {
		if (request.op === "detach") {
			client.closing = true;
			unsubscribeClient(client);
			void pump(client);
			return;
		}
		const membership = client.membership;
		if (!membership || !sameLiveMembership(membership)) {
			failClient(client, "session_gone", "The attached task session is no longer live.", request.requestId);
			return;
		}
		if (request.op === "steer" && request.text.trim().length === 0) {
			queueFrame(
				client,
				{
					type: "error",
					requestId: request.requestId,
					code: "invalid_request",
					message: "Steering text must not be blank.",
				},
				true,
			);
			return;
		}
		if (request.op === "abort") {
			void membership.session.abort().then(
				() => {
					if (sameLiveMembership(membership))
						queueFrame(client, { type: "ack", requestId: request.requestId }, true);
					else
						failClient(client, "session_gone", "The attached task session is no longer live.", request.requestId);
				},
				error => sendCommandError(client, request.requestId, error),
			);
			return;
		}
		if (membership.ref.status === "running") {
			void membership.session.steer(request.text).then(
				() => {
					if (sameLiveMembership(membership))
						queueFrame(client, { type: "ack", requestId: request.requestId }, true);
					else
						failClient(client, "session_gone", "The attached task session is no longer live.", request.requestId);
				},
				error => sendCommandError(client, request.requestId, error),
			);
			return;
		}
		let acknowledged = false;
		const unsubscribeStart = membership.session.subscribe(event => {
			if (event.type === "agent_start") acknowledge();
		});
		client.commandUnsubscribers.add(unsubscribeStart);
		const acknowledge = (): void => {
			if (acknowledged) return;
			acknowledged = true;
			unsubscribeStart();
			client.commandUnsubscribers.delete(unsubscribeStart);
			if (sameLiveMembership(membership)) queueFrame(client, { type: "ack", requestId: request.requestId }, true);
			else failClient(client, "session_gone", "The attached task session is no longer live.", request.requestId);
		};
		void membership.session
			.prompt(request.text, { streamingBehavior: "steer", throwOnDrop: true })
			.then(accepted => {
				if (!accepted) throw new Error("The task session rejected the steering message.");
				acknowledge();
			})
			.catch(error => {
				unsubscribeStart();
				client.commandUnsubscribers.delete(unsubscribeStart);
				sendCommandError(client, request.requestId, error);
			});
	};

	const closeMembershipClients = (membership: Membership): void => {
		for (const client of clients) {
			if (client.membership === membership)
				failClient(client, "session_gone", "The attached task session is no longer live.");
		}
	};

	const invalidateMembership = (id: string): void => {
		const membership = memberships.get(id);
		if (!membership) return;
		if (sameLiveMembership(membership)) return;
		memberships.delete(id);
		closeMembershipClients(membership);
	};

	const reconcileStartedMemberships = (): void => {
		if (closed) return;
		for (const [key, started] of pendingMemberships) {
			const ref = options.registry.get(started.id);
			const session = ref?.session;
			if (
				!ref ||
				ref.kind !== "sub" ||
				!session ||
				session.instanceKey !== started.instanceKey ||
				(ref.status !== "running" && ref.status !== "idle") ||
				(started.sessionFile != null && ref.sessionFile !== started.sessionFile) ||
				!isAgentViewSession(session)
			) {
				continue;
			}
			const existing = memberships.get(started.id);
			if (existing && existing.ref === ref && existing.instanceKey === started.instanceKey) {
				pendingMemberships.delete(key);
				continue;
			}
			if (existing) {
				memberships.delete(started.id);
				closeMembershipClients(existing);
			}
			const membership: Membership = {
				id: started.id,
				ownerSessionId,
				generation: ref.generation,
				instanceKey: started.instanceKey,
				ref,
				session,
				sessionFile: started.sessionFile ?? undefined,
				notified: false,
			};
			memberships.set(started.id, membership);
			pendingMemberships.delete(key);
			announceMembership(membership);
		}
	};

	function announceMembership(membership: Membership): void {
		if (!currentPublication || currentPublication.closed || membership.notified || !sameLiveMembership(membership))
			return;
		const payload: AgentAttachAvailablePayload = {
			id: membership.id,
			ownerSessionId: membership.ownerSessionId,
			generation: membership.generation,
			argv: ["agent", "attach", membership.id, "--owner", membership.ownerSessionId],
		};
		membership.notified = true;
		options.eventBus.emit(TASK_SUBAGENT_ATTACH_CHANNEL, payload);
	}

	const onLifecycle = (data: unknown): void => {
		const event = parseLifecycleEvent(data);
		if (!event) return;
		const key = JSON.stringify([event.id, event.instanceKey]);
		if (event.status !== "started") {
			pendingMemberships.delete(key);
			const membership = memberships.get(event.id);
			if (membership?.instanceKey === event.instanceKey) invalidateMembership(event.id);
			return;
		}
		const started: StartedMembership = {
			id: event.id,
			instanceKey: event.instanceKey,
			sessionFile: event.sessionFile,
		};
		pendingMemberships.set(key, started);
		reconcileStartedMemberships();
		queueMicrotask(reconcileStartedMemberships);
	};

	const onProgress = (): void => reconcileStartedMemberships();
	const unsubscribeLifecycle = options.subagentEventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, onLifecycle);
	const unsubscribeProgress = options.subagentEventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, onProgress);
	const unsubscribeRegistry = options.registry.onChange(event => {
		if (event.type === "removed" || options.registry.get(event.ref.id) !== event.ref) {
			invalidateMembership(event.ref.id);
			return;
		}
		invalidateMembership(event.ref.id);
		reconcileStartedMemberships();
	});

	const publish = async (publicationOwnerSessionId: string): Promise<void> => {
		if (closed || publishPromise) return publishPromise;
		publishPromise = (async () => {
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
			if (process.platform !== "win32") assertOwnerPrivateDir(dir, "agent attach directory");
			const entryId = randomHex(8);
			const token = randomHex(32);
			const endpoint = ipcEndpoint(dir, entryId);
			const metaPath = path.join(dir, `${entryId}.json`);
			const liveConnections = new Set<IpcConnection>();
			const server = await IpcServer.listen(
				endpoint,
				{ framing: "lines", maxFrameBytes: MAX_RPC_FRAME_BYTES },
				connection => {
					liveConnections.add(connection);
					handleConnection(connection, token, liveConnections, publicationOwnerSessionId);
				},
			);
			try {
				const metadata = {
					version: ATTACH_VERSION,
					ownerSessionId: publicationOwnerSessionId,
					pid: process.pid,
					endpoint,
					token,
				};
				const temporaryPath = `${metaPath}.tmp`;
				const handle = await fs.open(temporaryPath, "wx", 0o600);
				try {
					await handle.writeFile(JSON.stringify(metadata), "utf8");
				} finally {
					await handle.close();
				}
				await fs.rename(temporaryPath, metaPath);
			} catch (error) {
				removeFilesSync([`${metaPath}.tmp`, ...privateEndpointFiles(endpoint)]);
				await server.close();
				throw error;
			}
			const publication: Publication = {
				endpoint,
				metaPath,
				closeServer: () => server.close(),
				connections: liveConnections,
				closed: false,
				removeOnExit: () => removeFilesSync([metaPath, ...privateEndpointFiles(endpoint)]),
			};
			publications.add(publication);
			process.once("exit", publication.removeOnExit);
			currentPublication = publication;
			for (const membership of memberships.values()) announceMembership(membership);
		})().finally(() => {
			publishPromise = undefined;
		});
		return publishPromise;
	};

	const withdraw = async (publication: Publication | undefined): Promise<void> => {
		if (!publication || publication.closed) return;
		publication.closed = true;
		publications.delete(publication);
		process.off("exit", publication.removeOnExit);
		for (const connection of publication.connections) connection.destroy();
		removeFilesSync([publication.metaPath]);
		await publication.closeServer();
		removeFilesSync(privateEndpointFiles(publication.endpoint));
	};

	const switchOwner = async (nextOwnerSessionId: string): Promise<void> => {
		await publishPromise;
		if (closed) return;
		const previous = currentPublication;
		currentPublication = undefined;
		for (const client of clients) failClient(client, "session_gone", "The owner session changed; attach again.");
		memberships.clear();
		pendingMemberships.clear();
		ownerSessionId = nextOwnerSessionId;
		await withdraw(previous);
		await publish(nextOwnerSessionId);
		reconcileStartedMemberships();
	};

	function handleConnection(
		connection: IpcConnection,
		token: string,
		liveConnections: Set<IpcConnection>,
		publicationOwnerSessionId: string,
	): void {
		let authenticated = false;
		let client: AttachClient | undefined;
		const handshakeTimer = setTimeout(() => connection.destroy(), AUTH_TIMEOUT_MS);
		const closeConnection = (): void => {
			clearTimeout(handshakeTimer);
			liveConnections.delete(connection);
			if (client) finishClient(client, false);
		};
		const reject = (code: AgentAttachErrorCode, message: string, requestId?: number): void => {
			clearTimeout(handshakeTimer);
			const response = { type: "error", requestId, code, message };
			connection.send(JSON.stringify(response));
			connection.end();
		};
		connection.start(line => {
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch {
				reject("invalid_request", "Malformed attachment request.");
				return;
			}
			if (!raw || typeof raw !== "object") {
				reject("invalid_request", "Attachment request must be an object.");
				return;
			}
			const rawVersion: unknown = Reflect.get(raw, "v");
			if (!authenticated && rawVersion !== ATTACH_VERSION) {
				reject("unsupported_version", "Unsupported attachment protocol version.");
				return;
			}
			const parsed = parseAgentAttachClientRequest(raw);
			if (!parsed) {
				reject("invalid_request", "Invalid attachment request.", requestIdOf(raw));
				return;
			}
			if (!authenticated) {
				if (parsed.op !== "lookup" && parsed.op !== "attach") {
					reject("invalid_request", "The first attachment request must be lookup or attach.", requestIdOf(raw));
					return;
				}
				if (!tokenMatches(token, parsed.token)) {
					reject("unauthorized", "Attachment authentication failed.");
					return;
				}
				if (parsed.ownerSessionId !== publicationOwnerSessionId || parsed.ownerSessionId !== ownerSessionId) {
					reject("not_found", "No live task matches that owner and id.");
					return;
				}
				const membership = memberships.get(parsed.agentId);
				if (!membership || !sameLiveMembership(membership)) {
					reject("not_found", "No live task matches that owner and id.");
					return;
				}
				if (parsed.op === "attach" && parsed.generation !== membership.generation) {
					reject("session_gone", "The task session changed; run agent attach again.");
					return;
				}
				authenticated = true;
				clearTimeout(handshakeTimer);
				if (parsed.op === "lookup") {
					connection.send(
						JSON.stringify({
							type: "found",
							ownerSessionId: membership.ownerSessionId,
							agentId: membership.id,
							generation: membership.generation,
						}),
					);
					connection.end();
					return;
				}
				client = {
					connection,
					encoder: new RpcFrameEncoder(),
					outgoing: [],
					bufferedEvents: [],
					commandUnsubscribers: new Set(),
					pendingBytes: 0,
					pumping: false,
					closed: false,
					closing: false,
					snapshotPending: true,
				};
				client.encoder.setProtocolVersion(2);
				clients.add(client);
				bindClientSession(client, membership);
				return;
			}
			if (!client) {
				reject("invalid_request", "The attachment is not active.", requestIdOf(raw));
				return;
			}
			if (parsed.op === "lookup" || parsed.op === "attach") {
				failClient(client, "invalid_request", "Authentication requests are only valid at connection start.");
				return;
			}
			dispatchCommand(client, parsed);
		}, closeConnection);
	}

	const unregisterSessionChange = options.session.registerSessionChangeCallback(() => {
		const nextOwnerSessionId = options.session.sessionManager.getSessionId();
		ownerSwitchPromise = ownerSwitchPromise
			.then(() => switchOwner(nextOwnerSessionId))
			.catch(error => {
				logger.warn("Agent attach publication could not follow the root session switch", { error: String(error) });
				options.session.emitNotice(
					"warning",
					"Live task attachment is unavailable for the new session.",
					"agent-attach",
				);
			});
	});

	try {
		await publish(ownerSessionId);
		reconcileStartedMemberships();
	} catch (error) {
		closed = true;
		unsubscribeLifecycle();
		unsubscribeProgress();
		unsubscribeRegistry();
		unregisterSessionChange();
		for (const publication of publications) await withdraw(publication);
		throw error;
	}

	return {
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			unsubscribeLifecycle();
			unsubscribeProgress();
			unsubscribeRegistry();
			unregisterSessionChange();
			await ownerSwitchPromise;
			await publishPromise?.catch(() => {});
			for (const client of clients) failClient(client, "session_gone", "The owner session has closed.");
			memberships.clear();
			pendingMemberships.clear();
			const active = [...publications];
			currentPublication = undefined;
			await Promise.all(active.map(withdraw));
		},
	};
}
