/**
 * Client for attaching to a live native task subagent through its owner's
 * local attach endpoint. Discovery authenticates each private metadata entry
 * with its bearer token and never initializes a model, provider, or session.
 * Closing a client ends only its own connection; the child and its parent keep
 * running.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { getBaseConfigRoot, isEnoent } from "@oh-my-pi/pi-utils";
import { MAX_RPC_FRAME_BYTES, RpcFrameDecoder } from "../modes/rpc/rpc-frame";
import { assertOwnerPrivateDir } from "../utils/owner-private-dir";
import {
	type AgentAttachAttachRequest,
	type AgentAttachCommandRequest,
	type AgentAttachErrorCode,
	type AgentAttachLookupRequest,
	type AgentAttachServerFrame,
	parseAgentAttachServerFrame,
} from "./protocol";

/** Per-entry deadline covering connect plus the lookup reply. */
const DISCOVERY_DEADLINE_MS = 1_500;
/** Entries queried concurrently during discovery. */
const DISCOVERY_CONCURRENCY = 8;
/** Deadline for the attach handshake; the owner authenticates within the same window. */
const ATTACH_HANDSHAKE_TIMEOUT_MS = 5_000;
/** Largest discovery metadata file accepted; a valid entry is well under this. */
const MAX_METADATA_BYTES = 4 * 1024;

const INVALID_FRAME_MESSAGE = "The agent owner sent an invalid frame.";
const CONNECTION_CLOSED_MESSAGE = "The attach connection is closed.";

export interface AgentAttachClient {
	/** Receive validated server frames. Frames that arrive before the first listener are delivered to it in order. */
	onFrame(listener: (frame: AgentAttachServerFrame) => void): () => void;
	/** Send steering text. Rejects on blank input, command failure, or a closed connection. */
	steer(text: string): Promise<void>;
	/** Abort only the attached child. Resolves after the owner acknowledges. */
	abort(): Promise<void>;
	/** Detach locally. Idempotent; never aborts or disposes the child. */
	close(): void;
}

/** Failure from discovery or attach. Carries the owner IDs for `ambiguous` results. */
export class AgentAttachClientError extends Error {
	readonly code: AgentAttachErrorCode;
	readonly owners?: string[];

	constructor(code: AgentAttachErrorCode, message: string, owners?: string[]) {
		super(message);
		this.name = "AgentAttachClientError";
		this.code = code;
		if (owners) this.owners = owners;
	}
}

interface DiscoveryEntry {
	ownerSessionId: string;
	endpoint: string;
	token: string;
}

interface AttachTarget {
	endpoint: string;
	token: string;
	ownerSessionId: string;
	agentId: string;
	generation: number;
}

type LookupOutcome = { status: "found"; target: AttachTarget } | { status: "skip" };

const DiscoveryMetadataShape = type({
	"+": "delete",
	version: "1",
	ownerSessionId: "string >= 1",
	pid: "number.integer > 0",
	endpoint: "string >= 1",
	token: "string >= 1",
});

function parseDiscoveryMetadata(text: string): DiscoveryEntry | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	const meta = DiscoveryMetadataShape(raw);
	if (meta instanceof type.errors) return null;
	return { ownerSessionId: meta.ownerSessionId, endpoint: meta.endpoint, token: meta.token };
}

/** Read one metadata file without following symlinks and within a fixed byte bound. */
async function readDiscoveryEntry(file: string): Promise<DiscoveryEntry | null> {
	const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(() => null);
	if (!handle) return null;
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) return null;
		const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_METADATA_BYTES) return null;
		return parseDiscoveryMetadata(buffer.toString("utf8", 0, bytesRead));
	} catch {
		return null;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Entries for the current user's attach directory. A missing directory means no
 * live owners. POSIX requires the directory to be a real, owner-only directory
 * owned by the current user; Windows relies on the current-user pipe ACLs.
 */
async function readDiscoveryEntries(ownerSessionId: string | undefined): Promise<DiscoveryEntry[]> {
	const dir = path.join(getBaseConfigRoot(), "run", "agent-attach");
	if (process.platform !== "win32") {
		try {
			assertOwnerPrivateDir(dir, "agent attach directory");
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}
	}
	let names: string[];
	try {
		names = await fs.promises.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const entries: DiscoveryEntry[] = [];
	for (const name of names.filter(n => n.endsWith(".json")).sort()) {
		const entry = await readDiscoveryEntry(path.join(dir, name));
		if (entry && (ownerSessionId === undefined || entry.ownerSessionId === ownerSessionId)) entries.push(entry);
	}
	return entries;
}

/** Decode one server line. `undefined` means a chunk is still pending. Throws on malformed input. */
function decodeServerLine(decoder: RpcFrameDecoder, line: string): AgentAttachServerFrame | undefined {
	const value: unknown = JSON.parse(line);
	const complete = decoder.push(value);
	if (complete === undefined) return undefined;
	const frame = parseAgentAttachServerFrame(complete);
	if (frame === undefined) throw new Error(INVALID_FRAME_MESSAGE);
	return frame;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const item = items[next++];
			out.push(await fn(item));
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

/** Ask one owner whether it has `agentId` live. Never throws; any failure is a skip. */
function lookupEntry(entry: DiscoveryEntry, agentId: string): Promise<LookupOutcome> {
	const { promise, resolve } = Promise.withResolvers<LookupOutcome>();
	let connection: IpcConnection | undefined;
	let settled = false;
	const finish = (outcome: LookupOutcome): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		connection?.destroy();
		resolve(outcome);
	};
	const timer = setTimeout(() => finish({ status: "skip" }), DISCOVERY_DEADLINE_MS);
	IpcConnection.connect(entry.endpoint, {
		framing: "lines",
		timeoutMs: DISCOVERY_DEADLINE_MS,
		maxFrameBytes: MAX_RPC_FRAME_BYTES,
	}).then(
		conn => {
			if (settled) {
				conn.destroy();
				return;
			}
			connection = conn;
			const decoder = new RpcFrameDecoder();
			conn.start(
				line => {
					let frame: AgentAttachServerFrame | undefined;
					try {
						frame = decodeServerLine(decoder, line);
					} catch {
						finish({ status: "skip" });
						return;
					}
					if (!frame) return;
					if (
						frame.type === "found" &&
						frame.agentId === agentId &&
						frame.ownerSessionId === entry.ownerSessionId
					) {
						finish({
							status: "found",
							target: {
								endpoint: entry.endpoint,
								token: entry.token,
								ownerSessionId: frame.ownerSessionId,
								agentId,
								generation: frame.generation,
							},
						});
					} else {
						finish({ status: "skip" });
					}
				},
				() => finish({ status: "skip" }),
			);
			const request: AgentAttachLookupRequest = {
				v: 1,
				op: "lookup",
				token: entry.token,
				ownerSessionId: entry.ownerSessionId,
				agentId,
			};
			conn.send(JSON.stringify(request));
		},
		() => finish({ status: "skip" }),
	);
	return promise;
}

/**
 * One attached connection. Frames reach listeners in order; frames received
 * before the first listener are queued. Steer and abort resolve on their
 * matching `ack`, and reject on a matching `error` or when the connection ends.
 */
class AttachedAgentConnection implements AgentAttachClient {
	readonly handshake: Promise<AgentAttachServerFrame>;
	readonly #resolveHandshake: (frame: AgentAttachServerFrame) => void;
	readonly #rejectHandshake: (error: AgentAttachClientError) => void;
	readonly #connection: IpcConnection;
	readonly #decoder = new RpcFrameDecoder();
	readonly #listeners = new Set<(frame: AgentAttachServerFrame) => void>();
	readonly #queued: AgentAttachServerFrame[] = [];
	readonly #commands = new Map<number, { resolve: () => void; reject: (error: AgentAttachClientError) => void }>();
	#nextRequestId = 1;
	#handshakeDone = false;
	#closed = false;
	#reported = false;

	constructor(connection: IpcConnection, handshakeLine: string) {
		this.#connection = connection;
		const { promise, resolve, reject } = Promise.withResolvers<AgentAttachServerFrame>();
		this.handshake = promise;
		this.#resolveHandshake = resolve;
		this.#rejectHandshake = reject;
		connection.start(
			line => this.#onLine(line),
			() => this.#fail(new AgentAttachClientError("session_gone", "The agent owner closed the attach connection.")),
		);
		connection.send(handshakeLine);
	}

	onFrame(listener: (frame: AgentAttachServerFrame) => void): () => void {
		const first = this.#listeners.size === 0;
		this.#listeners.add(listener);
		if (first) for (const frame of this.#queued.splice(0)) listener(frame);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async steer(text: string): Promise<void> {
		if (text.trim() === "") throw new AgentAttachClientError("invalid_request", "Steering text is blank.");
		await this.#command(requestId => ({ op: "steer", requestId, text }));
	}

	async abort(): Promise<void> {
		await this.#command(requestId => ({ op: "abort", requestId }));
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#rejectCommands(new AgentAttachClientError("session_gone", CONNECTION_CLOSED_MESSAGE));
		const detach: AgentAttachCommandRequest = { op: "detach" };
		this.#connection.send(JSON.stringify(detach));
		this.#connection.end();
	}

	#command(build: (requestId: number) => AgentAttachCommandRequest): Promise<void> {
		if (this.#closed) return Promise.reject(new AgentAttachClientError("session_gone", CONNECTION_CLOSED_MESSAGE));
		const requestId = this.#nextRequestId++;
		const line = JSON.stringify(build(requestId));
		if (Buffer.byteLength(line, "utf8") > MAX_RPC_FRAME_BYTES) {
			return Promise.reject(new AgentAttachClientError("transport_limit", "The input is too large to send."));
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#commands.set(requestId, { resolve, reject });
		// Sends made after the connection closed are dropped; the close path rejects them.
		this.#connection.send(line);
		return promise;
	}

	#onLine(line: string): void {
		let frame: AgentAttachServerFrame | undefined;
		try {
			frame = decodeServerLine(this.#decoder, line);
		} catch {
			this.#fail(new AgentAttachClientError("invalid_request", INVALID_FRAME_MESSAGE));
			return;
		}
		if (frame) this.#receive(frame);
	}

	#receive(frame: AgentAttachServerFrame): void {
		if (this.#closed) return;
		if (!this.#handshakeDone) {
			this.#handshakeDone = true;
			this.#resolveHandshake(frame);
		}
		if ((frame.type === "ack" || frame.type === "error") && frame.requestId !== undefined) {
			const command = this.#commands.get(frame.requestId);
			if (command) {
				this.#commands.delete(frame.requestId);
				if (frame.type === "ack") command.resolve();
				else command.reject(new AgentAttachClientError(frame.code, frame.message));
				return;
			}
		}
		if (frame.type === "error" && frame.requestId === undefined) {
			this.#reportSessionError(new AgentAttachClientError(frame.code, frame.message));
			return;
		}
		this.#deliver(frame);
	}

	#deliver(frame: AgentAttachServerFrame): void {
		if (this.#listeners.size === 0) {
			this.#queued.push(frame);
			return;
		}
		for (const listener of this.#listeners) listener(frame);
	}

	/** Surface a connection-level failure once, then fail every pending command with it. */
	#reportSessionError(error: AgentAttachClientError): void {
		this.#rejectCommands(error);
		if (this.#reported) return;
		this.#reported = true;
		this.#deliver({ type: "error", code: error.code, message: error.message });
	}

	/** Terminal failure: end the connection and report it. Idempotent. */
	#fail(error: AgentAttachClientError): void {
		if (!this.#handshakeDone) {
			this.#handshakeDone = true;
			this.#rejectHandshake(error);
		}
		if (this.#closed) return;
		this.#closed = true;
		this.#reportSessionError(error);
		this.#connection.destroy();
	}

	#rejectCommands(error: AgentAttachClientError): void {
		for (const command of this.#commands.values()) command.reject(error);
		this.#commands.clear();
	}
}

async function attach(target: AttachTarget): Promise<AgentAttachClient> {
	let connection: IpcConnection;
	try {
		connection = await IpcConnection.connect(target.endpoint, {
			framing: "lines",
			timeoutMs: ATTACH_HANDSHAKE_TIMEOUT_MS,
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
		});
	} catch {
		throw new AgentAttachClientError("session_gone", `Subagent ${target.agentId} is no longer reachable.`);
	}
	const request: AgentAttachAttachRequest = {
		v: 1,
		op: "attach",
		token: target.token,
		ownerSessionId: target.ownerSessionId,
		agentId: target.agentId,
		generation: target.generation,
	};
	const client = new AttachedAgentConnection(connection, JSON.stringify(request));
	const timer = setTimeout(() => connection.destroy(), ATTACH_HANDSHAKE_TIMEOUT_MS);
	let reply: AgentAttachServerFrame;
	try {
		reply = await client.handshake;
	} finally {
		clearTimeout(timer);
	}
	if (reply.type === "error") {
		client.close();
		throw new AgentAttachClientError(reply.code, reply.message);
	}
	if (reply.type !== "snapshot_start") {
		client.close();
		throw new AgentAttachClientError("invalid_request", "The agent owner replied with an unexpected frame.");
	}
	if (
		reply.ownerSessionId !== target.ownerSessionId ||
		reply.agentId !== target.agentId ||
		reply.generation !== target.generation
	) {
		client.close();
		throw new AgentAttachClientError("session_gone", `Subagent ${target.agentId} changed while attaching.`);
	}
	return client;
}

/**
 * Find the one live subagent with exactly `agentId` and attach to it. When
 * `ownerSessionId` is set, only that owner is considered and no other owner is
 * tried. Without it, more than one live match fails as `ambiguous`.
 */
export async function connectAgentAttach(args: {
	agentId: string;
	ownerSessionId?: string;
}): Promise<AgentAttachClient> {
	const { agentId, ownerSessionId } = args;
	const entries = await readDiscoveryEntries(ownerSessionId);
	const outcomes = await mapBounded(entries, DISCOVERY_CONCURRENCY, entry => lookupEntry(entry, agentId));
	const matches = outcomes.flatMap(outcome => (outcome.status === "found" ? [outcome.target] : []));
	if (matches.length === 1) return attach(matches[0]);
	if (matches.length > 1) {
		const owners = [...new Set(matches.map(match => match.ownerSessionId))].sort();
		throw new AgentAttachClientError(
			"ambiguous",
			`More than one live subagent matches ${agentId}. Choose its owner.`,
			owners,
		);
	}
	const scope = ownerSessionId === undefined ? "" : ` under owner ${ownerSessionId}`;
	throw new AgentAttachClientError("not_found", `No live subagent ${agentId}${scope}.`);
}
