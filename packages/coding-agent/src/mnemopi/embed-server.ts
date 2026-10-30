/**
 * Machine-shared mnemopi embedding server: one detached process per (model,
 * cache dir) that owns that pair's IPC endpoint, serves every omp process on
 * the machine, and exits once idle so the model's memory is returned (issue
 * #9908). Entered from `cli.ts` via the `__omp_worker_mnemopi_embed_server`
 * selector with the endpoint/model/tag env set by `embed-client.ts`.
 *
 * It never loads onnxruntime itself. Inference runs in a private
 * `__omp_worker_mnemopi_embed` child (issue #3031): onnxruntime-node's
 * `session.run` blocks the JS thread for a whole batch, and this loop must
 * keep answering pings, other clients, and its idle timer meanwhile. The child
 * is SIGKILLed when an embed wedges, on idle exit, and on shutdown, so the
 * native finalizer never runs anywhere.
 */
import { setProcessName } from "@oh-my-pi/pi-utils";
import { type JsonLineReply, JsonLineServer } from "../subprocess/jsonl-server";
import { MnemopiEmbedClient, spawnMnemopiEmbedWorker } from "./embed-client";
import {
	MNEMOPI_EMBED_IDLE_MS,
	MNEMOPI_EMBED_IDLE_MS_ENV,
	MNEMOPI_EMBED_MODEL_ENV,
	MNEMOPI_EMBED_SOCKET_ENV,
	MNEMOPI_EMBED_TAG_ENV,
	type MnemopiEmbedCall,
	type MnemopiEmbedServerRequest,
	type MnemopiEmbedServerResponse,
} from "./embed-protocol";

/** Run one `init`/`embed` on the onnxruntime child and reply to the requesting connection. */
async function serveCall(
	runtime: MnemopiEmbedClient,
	request: MnemopiEmbedCall,
	reply: JsonLineReply<MnemopiEmbedServerResponse>,
): Promise<void> {
	if (request.type === "init") {
		const error = await runtime.load(request.model, request.cacheDir);
		reply.send(error === undefined ? { type: "ready", id: request.id } : { type: "error", id: request.id, error });
		return;
	}
	try {
		const vectors = await runtime.embed(request.model, request.cacheDir, request.texts, request.batchSize);
		reply.send({ type: "vectors", id: request.id, vectors });
	} catch (error) {
		reply.send({ type: "error", id: request.id, error: error instanceof Error ? error.message : String(error) });
	}
}

/** Serve the endpoint named by the CLI worker host environment until idle exit or `shutdown`. */
export async function startMnemopiEmbedServerFromEnvironment(): Promise<void> {
	const endpoint = process.env[MNEMOPI_EMBED_SOCKET_ENV];
	const model = process.env[MNEMOPI_EMBED_MODEL_ENV];
	const tag = process.env[MNEMOPI_EMBED_TAG_ENV];
	if (!endpoint || !model || !tag) throw new Error("mnemopi embed server environment is incomplete");
	setProcessName(`omp mnemopi embed ${model}`);
	// Same correlation, timeout, and wedge reaping as an omp process, over the private child.
	const runtime = new MnemopiEmbedClient(spawnMnemopiEmbedWorker);
	const server: JsonLineServer<MnemopiEmbedServerRequest, MnemopiEmbedServerResponse> = new JsonLineServer({
		name: "mnemopi-embed-server",
		cleanupLabel: "mnemopi-embed-server",
		idleMs: Number(process.env[MNEMOPI_EMBED_IDLE_MS_ENV]) || MNEMOPI_EMBED_IDLE_MS,
		banner: bound => `omp mnemopi embed server listening on ${bound}`,
		onRequest(request, reply) {
			if (request.type === "ping") {
				reply.send({ type: "pong", id: request.id, tag });
				return;
			}
			if (request.type === "shutdown") {
				server.exit("shutdown requested");
				return;
			}
			// Calls run concurrently, as they did in the per-process child.
			void server.busy(() => serveCall(runtime, request, reply));
		},
		onStop: () => runtime.terminate(),
	});
	await server.serve(endpoint);
}
