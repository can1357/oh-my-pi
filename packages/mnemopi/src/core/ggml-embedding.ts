/**
 * GGML (llama.cpp / node-llama-cpp) local-embeddings backend. An alternative
 * to the fastembed/onnxruntime path for machines with a GPU: node-llama-cpp
 * builds ggml against a GPU backend (Vulkan on Linux, Metal on macOS, CUDA on
 * Windows/NVIDIA) and runs the SAME embedding models llama.cpp ships as GGUF.
 *
 * Why this exists: onnxruntime-node's default execution provider is CPU-only,
 * and the GPU EP (onnxruntime-gpu) needs a version-matched CUDA+cuDNN stack
 * that is not always installed. ggml's Vulkan backend needs only the Mesa/VK
 * driver and is often 10-40x faster for a small embedding model (measured ~16ms
 * / vector on a GTX 1650 Ti vs ~650ms / vector on the ONNX CPU path).
 *
 * Isolation contract (mirrors `fastembed-runtime.ts`): this module is imported
 * ONLY inside the mnemopi embed worker subprocess, so llm's `node-llama-cpp`
 * native addon + ggml runtime never load in the main agent address space. The
 * parent SIGKILLs the worker on shutdown so any addon destructor cannot crash
 * the host (the sibling guarantee to issue #3031 for onnxruntime-node).
 *
 * Model-compat note: the GGUF conversion of an embedding model preserves the
 * model's *identity* (name) and vector dimension, so switching the backend from
 * fastembed/ONNX to ggml for the same model id does NOT change the dimension
 * and does not require re-embedding the memory corpus. Quantization (Q4_K_M)
 * changes the embedding *values* slightly, so cross-backend vectors are not
 * bit-identical, but they are dimension- and semantic-compatible.
 */

import { existsSync } from "node:fs";
import * as nodePath from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Llama } from "node-llama-cpp";
import type { LocalEmbeddingModel, LocalModelInitializer, LocalModelInitOptions } from "./embeddings";

/** Minimal loaded-llama embedding surface the initializer depends on. */
interface LlamaEmbeddingRuntime {
	llama: Llama;
	context: {
		getEmbeddingFor(input: string): Promise<{ vector: readonly number[] }>;
		dispose(): Promise<void>;
	};
}

let llamaPromise: Promise<LlamaEmbeddingRuntime> | null = null;

/**
 * Resolve the GGUF model path. Order:
 *  1. `MNEMOPI_EMBED_GGUF_PATH` explicit path (full filename).
 *  2. `<cacheDir>/<model>.gguf` where `cacheDir` is the fastembed cache root
 *     (so a user can drop the GGUF beside the ONNX cache).
 *  3. `<cacheDir>/../mnemopi/models/<model>.gguf`.
 * Returns `null` when no candidate exists (caller should fall back).
 */
export function resolveGgufModelPath(model: string, cacheDir: string | undefined): string | null {
	const explicit = process.env.MNEMOPI_EMBED_GGUF_PATH?.trim();
	if (explicit) return explicit;
	const root = cacheDir ?? defaultGgufCacheRoot();
	const basename = ggufFilename(model);
	if (!basename) return null;
	for (const base of [root, nodePath.join(root, "..", "models")]) {
		const candidate = nodePath.join(base, basename);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function ggufFilename(model: string): string | null {
	// The worker passes fastembed ids (e.g. "fast-bge-base-en-v1.5"). Map them
	// to a stable GGUF basename; fall back to a direct `<model>.gguf` for custom.
	const known: Record<string, string> = {
		"fast-bge-base-en-v1.5": "bge-base-en-v1.5-q4_k_m.gguf",
		"fast-bge-small-en-v1.5": "bge-small-en-v1.5-q4_k_m.gguf",
		"fast-bge-small-zh-v1.5": "bge-small-zh-v1.5-q4_k_m.gguf",
	};
	return known[model] ?? (model.endsWith(".gguf") ? model : null);
}

function defaultGgufCacheRoot(): string {
	return process.env.MNEMOPI_EMBED_GGUF_DIR ?? nodePath.join(process.env.HOME ?? "", ".hermes", "cache", "fastembed");
}

/** Default node-llama-cpp loader; tests swap this via `setGgmlModuleLoaderForTests`. */
let moduleLoader: () => Promise<typeof import("node-llama-cpp")> = () => import("node-llama-cpp");

/**
 * Lazily load node-llama-cpp (a heavy native addon) once. Uses `gpu: "auto"`
 * which resolves the best available backend (Vulkan here). Kept behind an
 * injected loader so tests can stub it without pulling the native addon.
 */
async function loadRuntime(modelPath: string): Promise<LlamaEmbeddingRuntime> {
	const { getLlama } = await moduleLoader();
	const llama = await getLlama({ gpu: "auto" });
	const model = await llama.loadModel({ modelPath });
	const context = await model.createEmbeddingContext({ contextSize: 512 });
	logger.debug("mnemopi: ggml embedding loaded", { gpu: llama.gpu, modelPath });
	return { llama, context };
}

/** Build a `LocalEmbeddingModel`-compatible instance backed by ggml. */
function makeEmbeddingModel(runtime: LlamaEmbeddingRuntime): LocalEmbeddingModel {
	return {
		async *embed(texts: string[], batchSize = 64): AsyncIterable<number[][]> {
			for (let i = 0; i < texts.length; i += batchSize) {
				const batch = texts.slice(i, i + batchSize);
				const vectors: number[][] = [];
				for (const text of batch) {
					const { vector } = await runtime.context.getEmbeddingFor(text);
					vectors.push(Array.from(vector));
				}
				yield vectors;
			}
		},
		async queryEmbed(query: string): Promise<number[]> {
			const { vector } = await runtime.context.getEmbeddingFor(query);
			return Array.from(vector);
		},
	};
}

/**
 * Default ggml local-model initializer. Matches the
 * `LocalModelInitializer` signature so callers can install it via
 * `setLocalModelInitializer` (or default) with no protocol change.
 */
export const ggmlLocalModelInitializer: LocalModelInitializer = async (
	options: LocalModelInitOptions,
): Promise<LocalEmbeddingModel> => {
	const modelPath = resolveGgufModelPath(options.model, options.cacheDir);
	if (!modelPath) {
		throw new Error(
			`mnemopi: no GGUF model for ${options.model}; set MNEMOPI_EMBED_GGUF_PATH or place the .gguf in the cache`,
		);
	}
	llamaPromise ??= loadRuntime(modelPath);
	try {
		const runtime = await llamaPromise;
		return makeEmbeddingModel(runtime);
	} catch (error) {
		llamaPromise = null;
		throw error;
	}
};

export function resetGgmlForTests(): void {
	llamaPromise = null;
}

export function setGgmlModuleLoaderForTests(loader: () => Promise<typeof import("node-llama-cpp")>): void {
	moduleLoader = loader;
	llamaPromise = null;
}
