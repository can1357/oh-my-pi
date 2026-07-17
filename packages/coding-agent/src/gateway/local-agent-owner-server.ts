import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSessionGateway } from "./agent-session-gateway";
import {
	LOCAL_AGENT_OWNER_PROTOCOL,
	type LocalAgentOwnerClientFrame,
	type LocalAgentOwnerCommand,
	LocalAgentOwnerProtocolError,
	type LocalAgentOwnerResponseData,
	type LocalAgentOwnerServerFrame,
	type LocalAgentRefSnapshot,
	type LocalAgentRuntimeDescriptor,
	MAX_OWNER_FRAME_BYTES,
	MAX_OWNER_REPLAY_EVENTS,
	MAX_OWNER_REQUEST_CACHE,
	MAX_OWNER_TRANSCRIPT_BYTES,
	type SequencedLocalAgentOwnerEvent,
} from "./local-agent-owner-types";
import type { GatewayCommand, GatewayEvent, GatewayResponseData } from "./types";

interface OwnerSocketData {
	authenticated: boolean;
}

export interface LocalAgentOwnerServerOptions {
	readonly sessionId: string;
	readonly agentId: string;
	readonly ownerId?: string;
	readonly ownerEpoch: number;
	readonly transcriptPath: string;
	readonly tokenFilePath: string;
	readonly ref: LocalAgentRefSnapshot;
	readonly gateway: AgentSessionGateway;
	readonly hostname?: "127.0.0.1" | "::1";
	readonly port?: number;
	readonly heartbeatMs?: number;
	readonly leaseMs?: number;
	readonly replayLimit?: number;
	readonly requestCacheLimit?: number;
	readonly onRevive?: () => Promise<LocalAgentOwnerResponseData>;
}

interface CachedResponse {
	readonly fingerprint: string;
	readonly frame: LocalAgentOwnerServerFrame;
}

function secureTokenEquals(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function commandFingerprint(command: LocalAgentOwnerCommand): string {
	return JSON.stringify(command);
}

export class LocalAgentOwnerServer {
	readonly #options: LocalAgentOwnerServerOptions;
	readonly #gateway: AgentSessionGateway;
	readonly #ownerId: string;
	readonly #replayLimit: number;
	readonly #requestCacheLimit: number;
	readonly #events: SequencedLocalAgentOwnerEvent[] = [];
	readonly #requests = new Map<string, CachedResponse>();
	readonly #sockets = new Set<Bun.ServerWebSocket<OwnerSocketData>>();
	#server: Bun.Server<OwnerSocketData> | undefined;
	#token = "";
	#seq = 0;
	#leaseExpiresAt = 0;
	#heartbeat: Timer | undefined;
	#unsubscribeGateway: (() => void) | undefined;
	#stopping = false;

	constructor(options: LocalAgentOwnerServerOptions) {
		if (!Number.isSafeInteger(options.ownerEpoch) || options.ownerEpoch < 1)
			throw new Error("ownerEpoch must be positive");
		this.#options = options;
		this.#gateway = options.gateway;
		this.#ownerId = options.ownerId ?? Bun.randomUUIDv7();
		this.#replayLimit = Math.max(1, Math.min(options.replayLimit ?? MAX_OWNER_REPLAY_EVENTS, 4_096));
		this.#requestCacheLimit = Math.max(1, Math.min(options.requestCacheLimit ?? MAX_OWNER_REQUEST_CACHE, 4_096));
	}

	start(): LocalAgentRuntimeDescriptor {
		if (this.#server) throw new Error("Local agent owner server already started");
		this.#stopping = false;
		this.#token = crypto.randomBytes(32).toString("hex");
		fs.mkdirSync(path.dirname(this.#options.tokenFilePath), { recursive: true, mode: 0o700 });
		fs.writeFileSync(this.#options.tokenFilePath, this.#token, { encoding: "utf8", mode: 0o600, flag: "wx" });
		try {
			fs.chmodSync(this.#options.tokenFilePath, 0o600);
		} catch {
			// Windows ACL enforcement is supplied by the native host; mode still protects POSIX hosts.
		}

		try {
			this.#server = Bun.serve<OwnerSocketData>({
				hostname: this.#options.hostname ?? "127.0.0.1",
				port: this.#options.port ?? 0,
				fetch: (request, server) => this.#handleFetch(request, server),
				websocket: {
					open: socket => {
						this.#sockets.add(socket);
					},
					message: (socket, message) => void this.#handleMessage(socket, message),
					close: socket => {
						this.#sockets.delete(socket);
					},
				},
			});
		} catch (error) {
			fs.rmSync(this.#options.tokenFilePath, { force: true });
			throw error;
		}

		this.#renewLease();
		this.#unsubscribeGateway = this.#gateway.subscribe(event => this.publish({ type: "gateway", event }));
		const heartbeatMs = Math.max(100, this.#options.heartbeatMs ?? 5_000);
		this.#heartbeat = setInterval(() => {
			this.#renewLease();
			this.publish({ type: "heartbeat", leaseExpiresAt: this.#leaseExpiresAt });
		}, heartbeatMs);
		return this.descriptor;
	}

	get descriptor(): LocalAgentRuntimeDescriptor {
		const server = this.#server;
		if (!server?.port) throw new Error("Local agent owner server is not started");
		const hostname = server.hostname === "::1" ? "[::1]" : "127.0.0.1";
		return {
			protocol: LOCAL_AGENT_OWNER_PROTOCOL,
			sessionId: this.#options.sessionId,
			agentId: this.#options.agentId,
			ownerId: this.#ownerId,
			ownerPid: process.pid,
			ownerEpoch: this.#options.ownerEpoch,
			endpoint: `ws://${hostname}:${server.port}/owner`,
			tokenFilePath: path.resolve(this.#options.tokenFilePath),
			transcriptPath: path.resolve(this.#options.transcriptPath),
			leaseExpiresAt: this.#leaseExpiresAt,
			eventSeq: this.#seq,
			lifecycle: this.#stopping ? "stopping" : "running",
			ref: { ...this.#options.ref },
		};
	}

	publish(event: SequencedLocalAgentOwnerEvent["event"]): SequencedLocalAgentOwnerEvent {
		const sequenced = { ownerEpoch: this.#options.ownerEpoch, seq: ++this.#seq, event };
		this.#events.push(sequenced);
		if (this.#events.length > this.#replayLimit) this.#events.splice(0, this.#events.length - this.#replayLimit);
		const frame: LocalAgentOwnerServerFrame = { t: "event", ...sequenced };
		for (const socket of this.#sockets) if (socket.data.authenticated) socket.send(JSON.stringify(frame));
		return sequenced;
	}

	async stop(reason: "settled" | "shutdown" | "error" = "shutdown"): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		this.publish({ type: "owner_stopping", reason });
		if (this.#heartbeat) clearInterval(this.#heartbeat);
		this.#heartbeat = undefined;
		this.#unsubscribeGateway?.();
		this.#unsubscribeGateway = undefined;
		this.#sockets.clear();
		const server = this.#server;
		this.#server = undefined;
		// Bun 1.3.x wedge: after any server-initiated `ws.close()`, the promise
		// from `Server.stop()` (soft or force) never resolves — even with every
		// client fully closed. `stop(true)` still tears the listener down
		// synchronously, so bound the await instead of trusting it to settle.
		const stopped = server?.stop(true);
		if (stopped) {
			await Promise.race([
				stopped,
				new Promise<void>(resolve => {
					const grace = setTimeout(resolve, 1_000);
					grace.unref?.();
				}),
			]);
		}
		fs.rmSync(this.#options.tokenFilePath, { force: true });
		this.#token = "";
	}

	#renewLease(): void {
		this.#leaseExpiresAt = Date.now() + Math.max(500, this.#options.leaseMs ?? 15_000);
	}

	#handleFetch(request: Request, server: Bun.Server<OwnerSocketData>): Response | undefined {
		const url = new URL(request.url);
		if (url.pathname !== "/owner") return new Response("Not found", { status: 404 });
		if (request.headers.has("Origin")) return new Response("Browser origins are forbidden", { status: 403 });
		if (!server.upgrade(request, { data: { authenticated: false } })) {
			return new Response("WebSocket upgrade failed", { status: 400 });
		}
		return undefined;
	}

	async #handleMessage(socket: Bun.ServerWebSocket<OwnerSocketData>, raw: string | Buffer): Promise<void> {
		if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_OWNER_FRAME_BYTES) {
			socket.close(1009, "invalid frame");
			return;
		}
		let frame: unknown;
		try {
			frame = JSON.parse(raw);
		} catch {
			socket.close(1007, "invalid json");
			return;
		}
		if (!socket.data.authenticated) {
			this.#handleHello(socket, frame);
			return;
		}
		if (!frame || typeof frame !== "object" || !("t" in frame)) {
			socket.close(1007, "invalid frame");
			return;
		}
		const typed = frame as LocalAgentOwnerClientFrame;
		if (typed.t === "command") await this.#handleCommand(socket, typed);
		else if (typed.t === "read_transcript") await this.#handleTranscript(socket, typed);
		else socket.close(1007, "unexpected frame");
	}

	#handleHello(socket: Bun.ServerWebSocket<OwnerSocketData>, input: unknown): void {
		if (!input || typeof input !== "object") return socket.close(1008, "unauthorized");
		const frame = input as Partial<Extract<LocalAgentOwnerClientFrame, { t: "hello" }>>;
		if (
			frame.t !== "hello" ||
			frame.protocol !== LOCAL_AGENT_OWNER_PROTOCOL ||
			frame.sessionId !== this.#options.sessionId ||
			frame.ownerEpoch !== this.#options.ownerEpoch ||
			typeof frame.token !== "string" ||
			!secureTokenEquals(frame.token, this.#token) ||
			!Number.isSafeInteger(frame.afterSeq) ||
			(frame.afterSeq ?? -1) < 0
		) {
			return socket.close(1008, "unauthorized");
		}
		socket.data.authenticated = true;
		socket.send(
			JSON.stringify({
				t: "hello_ok",
				descriptor: this.descriptor,
				latestSeq: this.#seq,
			} satisfies LocalAgentOwnerServerFrame),
		);
		const afterSeq = frame.afterSeq ?? 0;
		const firstSeq = this.#events[0]?.seq ?? this.#seq + 1;
		if (afterSeq < firstSeq - 1) {
			this.publish({ type: "snapshot", descriptor: this.descriptor });
			return;
		}
		for (const event of this.#events) {
			if (event.seq > afterSeq)
				socket.send(JSON.stringify({ t: "event", ...event } satisfies LocalAgentOwnerServerFrame));
		}
	}

	async #handleCommand(
		socket: Bun.ServerWebSocket<OwnerSocketData>,
		frame: Extract<LocalAgentOwnerClientFrame, { t: "command" }>,
	): Promise<void> {
		if (frame.ownerEpoch !== this.#options.ownerEpoch)
			return this.#sendError(socket, frame.requestId, "stale_epoch", "Owner epoch is stale");
		if (this.#stopping) return this.#sendError(socket, frame.requestId, "owner_stopping", "Owner is stopping");
		if (typeof frame.requestId !== "string" || frame.requestId.length === 0 || frame.requestId.length > 256) {
			return this.#sendError(socket, "", "invalid", "Invalid request id");
		}
		const fingerprint = commandFingerprint(frame.command);
		const cached = this.#requests.get(frame.requestId);
		if (cached) {
			if (cached.fingerprint !== fingerprint)
				return this.#sendError(socket, frame.requestId, "invalid", "Request id was reused with different content");
			socket.send(JSON.stringify(cached.frame));
			return;
		}
		let response: LocalAgentOwnerServerFrame;
		try {
			const data = await this.#runCommand(frame.requestId, frame.command);
			response = {
				t: "response",
				requestId: frame.requestId,
				ownerEpoch: this.#options.ownerEpoch,
				ok: true,
				...(data === undefined ? {} : { data }),
			};
		} catch (error) {
			const protocolError =
				error instanceof LocalAgentOwnerProtocolError
					? error
					: new LocalAgentOwnerProtocolError("internal", error instanceof Error ? error.message : String(error));
			response = {
				t: "response",
				requestId: frame.requestId,
				ownerEpoch: this.#options.ownerEpoch,
				ok: false,
				code: protocolError.code,
				error: protocolError.message,
			};
		}
		this.#requests.set(frame.requestId, { fingerprint, frame: response });
		if (this.#requests.size > this.#requestCacheLimit)
			this.#requests.delete(this.#requests.keys().next().value as string);
		socket.send(JSON.stringify(response));
	}

	async #runCommand(requestId: string, command: LocalAgentOwnerCommand): Promise<LocalAgentOwnerResponseData> {
		switch (command.type) {
			case "status":
				return this.descriptor;
			case "list":
				return [{ ...this.#options.ref }];
			case "chat": {
				if (typeof command.text !== "string" || command.text.trim().length === 0)
					throw new LocalAgentOwnerProtocolError("invalid", "Chat text is required");
				await this.#dispatchGateway({
					id: requestId,
					type: "prompt",
					identity: { channelId: "local-owner", sessionKey: this.#options.sessionId },
					message: command.text,
					streamingBehavior: "steer",
				});
				return { accepted: true };
			}
			case "abort":
				await this.#dispatchGateway({
					id: requestId,
					type: "abort",
					identity: { channelId: "local-owner", sessionKey: this.#options.sessionId },
				});
				return { cancelled: true };
			case "revive":
				if (!this.#options.onRevive)
					throw new LocalAgentOwnerProtocolError("not_found", "This owner has no revive handler");
				return this.#options.onRevive();
			case "gateway":
				await this.#dispatchGateway(command.command);
				return { accepted: true };
		}
	}

	async #dispatchGateway(command: GatewayCommand): Promise<GatewayResponseData> {
		let response: GatewayEvent | undefined;
		const unsubscribe = this.#gateway.subscribe(event => {
			if (event.type === "response" && event.id === command.id) response = event;
		});
		try {
			await this.#gateway.dispatch(command);
		} finally {
			unsubscribe();
		}
		if (!response || response.type !== "response") throw new Error("Gateway did not correlate a response");
		if (!response.success) throw new Error(response.error);
		return response.data;
	}

	async #handleTranscript(
		socket: Bun.ServerWebSocket<OwnerSocketData>,
		frame: Extract<LocalAgentOwnerClientFrame, { t: "read_transcript" }>,
	): Promise<void> {
		if (frame.ownerEpoch !== this.#options.ownerEpoch)
			return this.#sendError(socket, frame.requestId, "stale_epoch", "Owner epoch is stale");
		if (
			!Number.isSafeInteger(frame.fromByte) ||
			frame.fromByte < 0 ||
			!Number.isSafeInteger(frame.maxBytes) ||
			frame.maxBytes < 1
		) {
			return this.#sendError(socket, frame.requestId, "invalid", "Invalid transcript range");
		}
		const maxBytes = Math.min(frame.maxBytes, MAX_OWNER_TRANSCRIPT_BYTES);
		let bytes = new Uint8Array();
		let fileSize = 0;
		try {
			const file = Bun.file(this.#options.transcriptPath);
			fileSize = file.size;
			if (frame.fromByte > fileSize)
				return this.#sendError(socket, frame.requestId, "invalid", "Transcript offset exceeds file size");
			bytes = new Uint8Array(
				await file.slice(frame.fromByte, Math.min(fileSize, frame.fromByte + maxBytes)).arrayBuffer(),
			);
		} catch (error) {
			return this.#sendError(
				socket,
				frame.requestId,
				"not_found",
				error instanceof Error ? error.message : "Transcript unavailable",
			);
		}
		const completeLength = bytes.lastIndexOf(10) + 1;
		const complete = bytes.subarray(0, completeLength);
		const newSize = frame.fromByte + complete.byteLength;
		const response: LocalAgentOwnerServerFrame = {
			t: "transcript",
			requestId: frame.requestId,
			ownerEpoch: this.#options.ownerEpoch,
			text: new TextDecoder().decode(complete),
			newSize,
			eof: newSize === fileSize,
		};
		socket.send(JSON.stringify(response));
	}

	#sendError(
		socket: Bun.ServerWebSocket<OwnerSocketData>,
		requestId: string,
		code: "stale_epoch" | "invalid" | "not_found" | "owner_stopping",
		error: string,
	): void {
		socket.send(
			JSON.stringify({
				t: "response",
				requestId,
				ownerEpoch: this.#options.ownerEpoch,
				ok: false,
				code,
				error,
			} satisfies LocalAgentOwnerServerFrame),
		);
	}
}
