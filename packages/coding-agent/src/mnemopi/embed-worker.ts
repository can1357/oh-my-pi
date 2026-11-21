/**
 * Mnemopi local-embeddings worker: a child of the omp daemon's `infer` module,
 * re-entered through the agent CLI's hidden `__omp_worker_mnemopi_embed`
 * selector, speaking LF-delimited JSON over stdin/stdout. The whole point of
 * this module is that `loadFastembed()` — and therefore `onnxruntime-node`'s
 * NAPI constructor + finalizer — only ever runs in this child address space.
 * The daemon `SIGKILL`s us on wedge, idle, and stop, and we `SIGKILL`
 * ourselves when stdin closes, so the destructor that crashes Bun on Windows
 * shutdown (issue #3031, mnemopi sibling of #1606/#1607) never runs.
 */

import { defaultLocalModelInitializer, type StandardEmbeddingModel } from "@oh-my-pi/pi-mnemopi/core";
import { logger } from "@oh-my-pi/pi-utils";
import { claimWorkerStdout, type WorkerStdout } from "../daemon/modules/speech-frames";
import { startParentWatchdog } from "../subprocess/parent-watchdog";
import type { MnemopiEmbedModelId, MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "./embed-protocol";

/** The reply channel, claimed when the worker starts. */
let stdout: WorkerStdout | undefined;

/** Write one reply line to the daemon. */
function send(message: MnemopiEmbedWorkerOutbound): void {
	stdout?.write(`${JSON.stringify(message)}\n`);
}

interface LoadedModel {
	model: MnemopiEmbedModelId;
	cacheDir: string | undefined;
	instance: {
		embed(texts: string[], batchSize?: number): AsyncIterable<number[][]> | Iterable<number[][]>;
	};
}

let loaded: Promise<LoadedModel> | null = null;
let loadedKey = "";

async function loadModel(model: MnemopiEmbedModelId, cacheDir: string | undefined): Promise<LoadedModel> {
	// Route through mnemopi's shared initializer so the worker inherits BOTH
	// cache heals (sidecar re-fetch AND corrupt-model quarantine/retry) —
	// fastembed/onnxruntime still load only in this child address space, the
	// initializer calls loadFastembed() itself.
	// Cast: `model` arrives as a string from the parent (resolved by
	// mnemopi's `fastembedModelName`); the parent only ever passes pre-vetted
	// fast-* identifiers.
	const instance = await defaultLocalModelInitializer({
		model: model as StandardEmbeddingModel,
		cacheDir,
		showDownloadProgress: false,
	});
	return { model, cacheDir, instance };
}

function ensureLoaded(model: MnemopiEmbedModelId, cacheDir: string | undefined): Promise<LoadedModel> {
	const key = `${model}\u0000${cacheDir ?? ""}`;
	if (loaded !== null && loadedKey === key) return loaded;
	const loading = loadModel(model, cacheDir).catch(error => {
		// Failed loads must not poison the cache — a retry with the same key
		// should re-attempt the load.
		if (loaded === loading) {
			loaded = null;
			loadedKey = "";
		}
		throw error;
	});
	loaded = loading;
	loadedKey = key;
	return loading;
}
async function handleEmbed(message: Extract<MnemopiEmbedWorkerInbound, { type: "embed" }>): Promise<void> {
	try {
		// Each `embed` carries the model + cacheDir the wrapper was bound to.
		// `ensureLoaded` is idempotent for the same key, so this is a no-op
		// once the model is in memory — and it transparently re-loads after
		// the parent SIGKILLed the previous subprocess but mnemopi still
		// holds the cached `LocalEmbeddingModel` wrapper from before.
		const { instance } = await ensureLoaded(message.model, message.cacheDir);
		const vectors: number[][] = [];
		const batches = instance.embed([...message.texts], message.batchSize);
		for await (const batch of batches) {
			for (const row of batch) vectors.push(row);
		}
		send({ type: "vectors", id: message.id, vectors });
	} catch (error) {
		send({
			type: "error",
			id: message.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function handleInit(message: Extract<MnemopiEmbedWorkerInbound, { type: "init" }>): Promise<void> {
	try {
		await ensureLoaded(message.model, message.cacheDir);
		send({ type: "ready", id: message.id });
	} catch (error) {
		send({
			type: "error",
			id: message.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Serve stdin requests concurrently until stdin closes. */
export async function startMnemopiEmbedWorker(): Promise<void> {
	// Stdout carries reply lines only; library chatter goes to stderr.
	stdout = claimWorkerStdout();
	// A native embed can pin the main thread; the watchdog thread still notices a dead daemon.
	if (process.ppid > 1) startParentWatchdog(process.ppid);
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of Bun.stdin.stream()) {
		buffered += decoder.decode(chunk, { stream: true });
		let newline = buffered.indexOf("\n");
		while (newline >= 0) {
			const line = buffered.slice(0, newline).trim();
			buffered = buffered.slice(newline + 1);
			newline = buffered.indexOf("\n");
			if (!line) continue;
			let message: MnemopiEmbedWorkerInbound;
			try {
				message = JSON.parse(line) as MnemopiEmbedWorkerInbound;
			} catch (error) {
				logger.warn("mnemopi-embed: malformed request line", { error: String(error) });
				continue;
			}
			switch (message.type) {
				case "ping":
					send({ type: "pong", id: message.id });
					break;
				case "init":
					void handleInit(message);
					break;
				case "embed":
					void handleEmbed(message);
					break;
			}
		}
	}
	// The daemon went away: die without running the onnxruntime finalizer.
	process.kill(process.pid, "SIGKILL");
}
