import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getFastembedCacheDir, getMnemopiEmbedRuntimeDir, VERSION } from "@oh-my-pi/pi-utils";
import type { LocalModelInitOptions } from "./core/embeddings";
import {
	mnemopiEmbedServerName,
	type MnemopiEmbedServerRequest,
	type MnemopiEmbedServerResponse,
} from "./embed-protocol";

const CONNECT_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 120_000;

type PendingReply = {
	id: string;
	resolve: (message: MnemopiEmbedServerResponse) => void;
	reject: (error: Error) => void;
};

/** One sequential exchange; close fails the outstanding request immediately. */
class EmbedConnection {
	#connection: IpcConnection;
	#pending: PendingReply | undefined;
	#closed: Error | undefined;

	constructor(connection: IpcConnection) {
		this.#connection = connection;
		connection.start(
			line => {
				try {
					const message = JSON.parse(line) as MnemopiEmbedServerResponse;
					if (message.id === this.#pending?.id) this.#pending?.resolve(message);
				} catch {
					this.#pending?.reject(new Error("invalid embedding server response"));
				}
			},
			reason => {
				this.#closed = new Error(`embedding server connection closed${reason ? `: ${reason}` : ""}`);
				this.#pending?.reject(this.#closed);
			},
		);
	}

	async request(
		message: MnemopiEmbedServerRequest,
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<MnemopiEmbedServerResponse> {
		if (this.#closed) throw this.#closed;
		const response = Promise.withResolvers<MnemopiEmbedServerResponse>();
		this.#pending = { id: message.id, resolve: response.resolve, reject: response.reject };
		const timer = setTimeout(
			() => response.reject(new Error(`embedding server ${message.type} timed out`)),
			timeoutMs,
		);
		try {
			this.#connection.send(JSON.stringify(message));
			return await response.promise;
		} finally {
			clearTimeout(timer);
			this.#pending = undefined;
		}
	}

	close(): void {
		this.#connection.destroy();
	}
}

async function connect(endpoint: string): Promise<EmbedConnection | null> {
	try {
		return new EmbedConnection(
			await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: CONNECT_TIMEOUT_MS }),
		);
	} catch {
		return null;
	}
}

/** Probe without replacing an owner, including one running another omp version. */
export async function pingEmbedIpcServer(endpoint: string): Promise<boolean> {
	const connection = await connect(endpoint);
	if (!connection) return false;
	try {
		return (await connection.request({ type: "ping", id: "probe" }, CONNECT_TIMEOUT_MS)).type === "pong";
	} catch {
		return false;
	} finally {
		connection.close();
	}
}

/**
 * Return null only when no server can be reached. Once connected, protocol,
 * inference, timeout and disconnect failures reach the caller as errors.
 * Each call owns its connection so the next call can reconnect after a crash.
 */
export async function embedViaIpc(
	options: LocalModelInitOptions,
	texts: string[],
	batchSize?: number,
): Promise<number[][] | null> {
	const cacheDir = options.cacheDir ?? getFastembedCacheDir();
	const endpoint = ipcEndpoint(getMnemopiEmbedRuntimeDir(), mnemopiEmbedServerName(options.model, cacheDir));
	const connection = await connect(endpoint);
	if (!connection) return null;
	try {
		const pong = await connection.request({ type: "ping", id: "ping" }, CONNECT_TIMEOUT_MS);
		if (pong.type !== "pong" || pong.tag !== VERSION) throw new Error(`incompatible embedding server at ${endpoint}`);
		const ready = await connection.request({ type: "init", id: "init", model: options.model, cacheDir });
		if (ready.type !== "ready") throw replyError(ready);
		const response = await connection.request({
			type: "embed",
			id: "embed",
			model: options.model,
			cacheDir,
			texts,
			batchSize,
		});
		if (response.type !== "vectors") throw replyError(response);
		return response.vectors;
	} finally {
		connection.close();
	}
}

function replyError(response: MnemopiEmbedServerResponse): Error {
	return new Error(response.type === "error" ? response.error : `unexpected embedding server reply: ${response.type}`);
}
