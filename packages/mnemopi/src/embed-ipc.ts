import * as path from "node:path";
import { type IpcConnection, IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getFastembedCacheDir, getMnemopiEmbedRuntimeDir, logger, VERSION } from "@oh-my-pi/pi-utils";
import {
	currentEmbeddingModel,
	defaultLocalModelInitializer,
	fastembedModelName,
	type LocalEmbeddingModel,
} from "./core/embeddings";
import { pingEmbedIpcServer } from "./embed-ipc-client";
import {
	mnemopiEmbedServerName,
	type MnemopiEmbedCall,
	type MnemopiEmbedServerRequest,
	type MnemopiEmbedServerResponse,
} from "./embed-protocol";

export interface EmbedIpcServerOptions {
	model?: string;
	cacheDir?: string;
}

type EmbedIpcServerLocation = { endpoint: string; model: string };
export type EmbedIpcServer = EmbedIpcServerLocation &
	({ alreadyRunning: true } | { alreadyRunning: false; closed: Promise<void>; stop(): Promise<void> });

/** Validate the wire boundary before queueing any model work. */
function parseRequest(value: unknown): MnemopiEmbedServerRequest {
	if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") {
		throw new Error("embedding request requires a string id");
	}
	const request = value as Record<string, unknown>;
	const id = value.id;
	if (request.type === "ping" || request.type === "shutdown") return { type: request.type, id };
	if (request.type !== "init" && request.type !== "embed") throw new Error("unknown embedding request type");
	if (typeof request.model !== "string") throw new Error("embedding request requires a model");
	if (request.cacheDir !== undefined && typeof request.cacheDir !== "string")
		throw new Error("invalid embedding cache directory");
	const common = { id, model: request.model, cacheDir: request.cacheDir as string | undefined };
	if (request.type === "init") return { type: "init", ...common };
	if (!Array.isArray(request.texts) || !request.texts.every(text => typeof text === "string")) {
		throw new Error("embedding texts must be an array of strings");
	}
	if (
		request.batchSize !== undefined &&
		(typeof request.batchSize !== "number" || !Number.isInteger(request.batchSize) || request.batchSize < 1)
	) {
		throw new Error("embedding batch size must be a positive integer");
	}
	return { type: "embed", ...common, texts: request.texts, batchSize: request.batchSize as number | undefined };
}

/**
 * Serve the same endpoint and protocol as omp, with one in-process model.
 * Native IPC handles exclusive binding, owner-only access and stale sockets.
 * The caller must SIGKILL after `closed` if inference loaded onnxruntime, to
 * avoid its NAPI finalizer crash (issue #3031).
 */
export async function startEmbedIpcServer(options: EmbedIpcServerOptions = {}): Promise<EmbedIpcServer> {
	const model = options.model ?? currentEmbeddingModel();
	const modelId = fastembedModelName(model);
	if (modelId === null) throw new Error(`embed-serve: no local fastembed model for '${model}'`);
	const cacheDir = path.resolve(options.cacheDir ?? getFastembedCacheDir());
	const endpoint = ipcEndpoint(getMnemopiEmbedRuntimeDir(), mnemopiEmbedServerName(modelId, cacheDir));
	const location = { endpoint, model };
	if (await pingEmbedIpcServer(endpoint)) return { ...location, alreadyRunning: true };

	const connections = new Set<IpcConnection>();
	const closed = Promise.withResolvers<void>();
	let listener: IpcServer;
	let stopping: Promise<void> | undefined;
	const stop = (): Promise<void> => {
		stopping ??= (async () => {
			for (const connection of connections) connection.destroy();
			connections.clear();
			try {
				await listener.close();
				closed.resolve();
			} catch (error) {
				closed.reject(error);
				throw error;
			}
		})();
		return stopping;
	};
	let localModel: LocalEmbeddingModel | undefined;
	// Queue both initialization and inference so neither can race another client.
	let queue: Promise<void> = Promise.resolve();
	const serveCall = async (request: MnemopiEmbedCall): Promise<MnemopiEmbedServerResponse> => {
		if (request.model !== modelId) throw new Error(`this embedding server serves '${modelId}'`);
		if (request.cacheDir !== undefined && path.resolve(request.cacheDir) !== cacheDir) {
			throw new Error(`this embedding server uses cache directory '${cacheDir}'`);
		}
		if (request.type === "init") {
			localModel ??= await defaultLocalModelInitializer({ model: modelId, cacheDir, showDownloadProgress: false });
			return { type: "ready", id: request.id };
		}
		if (!localModel) throw new Error("embed before init");
		const vectors: number[][] = [];
		for await (const batch of localModel.embed(request.texts, request.batchSize)) {
			for (const row of batch) vectors.push(Array.from(row));
		}
		return { type: "vectors", id: request.id, vectors };
	};
	try {
		listener = await IpcServer.listen(endpoint, { framing: "lines" }, connection => {
			connections.add(connection);
			const send = (response: MnemopiEmbedServerResponse): void => {
				try {
					if (!connection.closed) connection.send(JSON.stringify(response));
				} catch (error) {
					logger.debug("mnemopi embed server: reply failed", { error: String(error) });
				}
			};
			connection.start(
				line => {
					let request: MnemopiEmbedServerRequest;
					let decoded: unknown;
					try {
						decoded = JSON.parse(line);
						request = parseRequest(decoded);
					} catch (error) {
						if (
							typeof decoded === "object" &&
							decoded !== null &&
							"id" in decoded &&
							typeof decoded.id === "string"
						) {
							send({ type: "error", id: decoded.id, error: String(error) });
						} else {
							logger.warn("mnemopi embed server: malformed request", { error: String(error) });
						}
						return;
					}
					if (request.type === "ping") {
						send({ type: "pong", id: request.id, tag: VERSION });
						return;
					}
					if (request.type === "shutdown") {
						void stop().catch(error =>
							logger.error("mnemopi embed server: shutdown failed", { error: String(error) }),
						);
						return;
					}
					const call = request;
					queue = queue.then(async () => {
						try {
							send(await serveCall(call));
						} catch (error) {
							send({
								type: "error",
								id: call.id,
								error: error instanceof Error ? error.message : String(error),
							});
						}
					});
				},
				() => connections.delete(connection),
			);
		});
	} catch (error) {
		// A sibling can win the bind after our first probe. Never unlink its endpoint.
		if (await pingEmbedIpcServer(endpoint)) return { ...location, alreadyRunning: true };
		throw new Error(`embed-serve: could not bind ${endpoint}: ${String(error)}`, { cause: error });
	}
	return { ...location, alreadyRunning: false, closed: closed.promise, stop };
}
