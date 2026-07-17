import * as fs from "node:fs/promises";
import {
	LOCAL_AGENT_OWNER_PROTOCOL,
	type LocalAgentOwnerClientFrame,
	type LocalAgentOwnerCommand,
	LocalAgentOwnerProtocolError,
	type LocalAgentOwnerResponseData,
	type LocalAgentOwnerServerFrame,
	type LocalAgentRuntimeDescriptor,
	type LocalAgentTranscriptChunk,
	MAX_OWNER_FRAME_BYTES,
	MAX_OWNER_TRANSCRIPT_BYTES,
	type SequencedLocalAgentOwnerEvent,
} from "./local-agent-owner-types";
import type { GatewayCommand } from "./types";

interface PendingRequest {
	readonly resolve: (frame: LocalAgentOwnerServerFrame) => void;
	readonly reject: (error: Error) => void;
}

export interface LocalAgentOwnerClientOptions {
	readonly descriptor: LocalAgentRuntimeDescriptor;
	readonly afterSeq?: number;
	readonly connectTimeoutMs?: number;
}

export type LocalAgentOwnerEventListener = (event: SequencedLocalAgentOwnerEvent) => void;

export class LocalAgentOwnerClient {
	readonly #initialDescriptor: LocalAgentRuntimeDescriptor;
	readonly #listeners = new Set<LocalAgentOwnerEventListener>();
	readonly #pending = new Map<string, PendingRequest>();
	#socket: WebSocket | undefined;
	#descriptor: LocalAgentRuntimeDescriptor;
	#lastSeq: number;
	#connectPromise: Promise<LocalAgentRuntimeDescriptor> | undefined;

	constructor(options: LocalAgentOwnerClientOptions) {
		this.#initialDescriptor = options.descriptor;
		this.#descriptor = options.descriptor;
		this.#lastSeq = options.afterSeq ?? 0;
	}

	get descriptor(): LocalAgentRuntimeDescriptor {
		return this.#descriptor;
	}

	get lastSequence(): number {
		return this.#lastSeq;
	}

	get leaseExpired(): boolean {
		return Date.now() >= this.#descriptor.leaseExpiresAt;
	}

	subscribe(listener: LocalAgentOwnerEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async connect(timeoutMs = 5_000): Promise<LocalAgentRuntimeDescriptor> {
		if (this.#socket?.readyState === WebSocket.OPEN) return this.#descriptor;
		if (this.#connectPromise) return this.#connectPromise;
		const connecting = this.#open(timeoutMs);
		this.#connectPromise = connecting;
		try {
			return await connecting;
		} finally {
			if (this.#connectPromise === connecting) this.#connectPromise = undefined;
		}
	}

	async close(): Promise<void> {
		const socket = this.#socket;
		this.#socket = undefined;
		socket?.close(1000, "client close");
		this.#rejectPending(new Error("Local agent owner client closed"));
	}

	status(): Promise<LocalAgentRuntimeDescriptor> {
		return this.#request({ type: "status" }) as Promise<LocalAgentRuntimeDescriptor>;
	}

	list(): Promise<LocalAgentOwnerResponseData> {
		return this.#request({ type: "list" });
	}

	chat(text: string, requestId?: string): Promise<LocalAgentOwnerResponseData> {
		return this.#request({ type: "chat", text }, requestId);
	}

	abort(requestId?: string): Promise<LocalAgentOwnerResponseData> {
		return this.#request({ type: "abort" }, requestId);
	}

	revive(requestId?: string): Promise<LocalAgentOwnerResponseData> {
		return this.#request({ type: "revive" }, requestId);
	}

	forward(command: GatewayCommand, requestId?: string): Promise<LocalAgentOwnerResponseData> {
		return this.#request({ type: "gateway", command }, requestId);
	}

	async readTranscript(fromByte: number, maxBytes = MAX_OWNER_TRANSCRIPT_BYTES): Promise<LocalAgentTranscriptChunk> {
		await this.connect();
		const requestId = Bun.randomUUIDv7();
		const frame = await this.#sendRequest({
			t: "read_transcript",
			requestId,
			ownerEpoch: this.#descriptor.ownerEpoch,
			fromByte,
			maxBytes: Math.min(maxBytes, MAX_OWNER_TRANSCRIPT_BYTES),
		});
		if (frame.t === "response" && !frame.ok) throw new LocalAgentOwnerProtocolError(frame.code, frame.error);
		if (frame.t !== "transcript") throw new Error("Unexpected transcript response");
		return { text: frame.text, newSize: frame.newSize, eof: frame.eof };
	}

	async #request(
		command: LocalAgentOwnerCommand,
		requestId = Bun.randomUUIDv7(),
	): Promise<LocalAgentOwnerResponseData> {
		await this.connect();
		const frame = await this.#sendRequest({
			t: "command",
			requestId,
			ownerEpoch: this.#descriptor.ownerEpoch,
			command,
		});
		if (frame.t !== "response") throw new Error("Unexpected owner response");
		if (!frame.ok) throw new LocalAgentOwnerProtocolError(frame.code, frame.error);
		return frame.data;
	}

	async #open(timeoutMs: number): Promise<LocalAgentRuntimeDescriptor> {
		const token = (await fs.readFile(this.#initialDescriptor.tokenFilePath, "utf8")).trim();
		if (token.length !== 64) throw new Error("Invalid local agent owner token file");
		const socket = new WebSocket(this.#initialDescriptor.endpoint);
		this.#socket = socket;
		const connected = Promise.withResolvers<LocalAgentRuntimeDescriptor>();
		const timeout = setTimeout(
			() => {
				socket.close();
				connected.reject(new Error("Timed out connecting to local agent owner"));
			},
			Math.max(100, timeoutMs),
		);
		socket.onopen = () => {
			const hello: LocalAgentOwnerClientFrame = {
				t: "hello",
				protocol: LOCAL_AGENT_OWNER_PROTOCOL,
				sessionId: this.#initialDescriptor.sessionId,
				ownerEpoch: this.#initialDescriptor.ownerEpoch,
				token,
				afterSeq: this.#lastSeq,
			};
			socket.send(JSON.stringify(hello));
		};
		socket.onmessage = event => {
			if (typeof event.data !== "string" || Buffer.byteLength(event.data) > MAX_OWNER_FRAME_BYTES) {
				socket.close(1009, "invalid frame");
				return;
			}
			let frame: LocalAgentOwnerServerFrame;
			try {
				frame = JSON.parse(event.data) as LocalAgentOwnerServerFrame;
			} catch {
				socket.close(1007, "invalid json");
				return;
			}
			if (frame.t === "hello_ok") {
				clearTimeout(timeout);
				this.#descriptor = frame.descriptor;
				connected.resolve(frame.descriptor);
				return;
			}
			if (frame.t === "event") {
				if (frame.ownerEpoch !== this.#descriptor.ownerEpoch || frame.seq <= this.#lastSeq) return;
				this.#lastSeq = frame.seq;
				if (frame.event.type === "heartbeat")
					this.#descriptor = {
						...this.#descriptor,
						leaseExpiresAt: frame.event.leaseExpiresAt,
						eventSeq: frame.seq,
					};
				else if (frame.event.type === "snapshot") this.#descriptor = frame.event.descriptor;
				for (const listener of this.#listeners)
					listener({ ownerEpoch: frame.ownerEpoch, seq: frame.seq, event: frame.event });
				return;
			}
			if (frame.t === "response" || frame.t === "transcript") {
				const pending = this.#pending.get(frame.requestId);
				if (!pending) return;
				this.#pending.delete(frame.requestId);
				pending.resolve(frame);
			}
		};
		socket.onerror = () => {
			clearTimeout(timeout);
			connected.reject(new Error("Local agent owner connection failed"));
		};
		socket.onclose = () => {
			clearTimeout(timeout);
			if (this.#socket === socket) this.#socket = undefined;
			connected.reject(new Error("Local agent owner rejected the connection"));
			this.#rejectPending(new Error("Local agent owner disconnected"));
		};
		return connected.promise;
	}

	#sendRequest(
		frame: Extract<LocalAgentOwnerClientFrame, { requestId: string }>,
	): Promise<LocalAgentOwnerServerFrame> {
		const socket = this.#socket;
		if (!socket || socket.readyState !== WebSocket.OPEN)
			return Promise.reject(new Error("Local agent owner is not connected"));
		if (this.#pending.has(frame.requestId))
			return Promise.reject(new Error(`Duplicate in-flight request id: ${frame.requestId}`));
		const result = Promise.withResolvers<LocalAgentOwnerServerFrame>();
		this.#pending.set(frame.requestId, { resolve: result.resolve, reject: result.reject });
		socket.send(JSON.stringify(frame));
		return result.promise;
	}

	#rejectPending(error: Error): void {
		for (const request of this.#pending.values()) request.reject(error);
		this.#pending.clear();
	}
}
