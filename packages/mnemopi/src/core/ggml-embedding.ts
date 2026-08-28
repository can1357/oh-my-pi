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
 * model's *identity* (name) and vector dimension, and quantization (Q4_K_M)
 * changes the embedding *values* slightly — so switching backends under the
 * same model id does NOT change the dimension but DOES produce non-identical
 * vectors. The persisted corpus key therefore includes the backend/artifact in
 * effect (`currentEmbeddingModelIdentity` in `embeddings.ts`), so switching
 * `fastembed -> ggml` (or vice versa) forces a corpus rebuild even though the
 * model id is unchanged. Cross-backend vectors are never mixed.
 */

import { existsSync } from "node:fs";
import * as nodePath from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type * as LlamaCpp from "node-llama-cpp";
import { MODEL_CACHE_DIR } from "../config";
import type { LocalEmbeddingModel, LocalModelInitializer, LocalModelInitOptions } from "./embeddings";

/** Minimal loaded-llama embedding surface the initializer depends on. */
interface LlamaEmbeddingRuntime {
	llama: LlamaCpp.Llama;
	context: {
		getEmbeddingFor(input: string): Promise<{ vector: readonly number[] }>;
		dispose(): Promise<void>;
	};
	/**
	 * Truncate `input` to the embedding context's token budget before
	 * evaluation. node-llama-cpp's `getEmbeddingFor` *throws* when the tokenized
	 * input exceeds the context window (unlike the fastembed/onnx path, which
	 * silently truncates), so oversized inputs must be clipped up front. Uses the
	 * model tokenizer when available; falls back to a conservative character
	 * clip (each token occupies at least one character) for the test seam.
	 */
	truncate(input: string): string;
}

/** Embedding-context token budget. Matches the bge-series max context (512). */
const CONTEXT_SIZE = 512;
/** Headroom kept when token-truncating so a detokenize/retokenize round-trip cannot spill past the budget. */
const TRUNCATE_MARGIN = 4;

/** Default node-llama-cpp module namespace type. */
type LlamaCppModule = typeof LlamaCpp;

/**
 * Default node-llama-cpp loader. node-llama-cpp is ESM-only (no CJS export)
 * with an async module graph, so Bun cannot `createRequire` it the way
 * fastembed is loaded in `fastembed-runtime.ts`; `import()` is the loader Bun
 * supports for an ESM-only async native-addon module. Kept behind an injected
 * loader so tests stub it and the native addon still never loads in the main
 * agent process.
 */
async function loadNodeLlamaCpp(): Promise<LlamaCppModule> {
	return await import("node-llama-cpp");
}

const DEFAULT_MODULE_LOADER: () => Promise<LlamaCppModule> = loadNodeLlamaCpp;

/** Default node-llama-cpp loader; tests swap this via `setGgmlModuleLoaderForTests`. */
let moduleLoader: () => Promise<LlamaCppModule> = DEFAULT_MODULE_LOADER;

/** Cached ggml runtime, keyed by the resolved GGUF model path. */
let llamaCache: { modelPath: string; promise: Promise<LlamaEmbeddingRuntime> } | null = null;

/**
 * Resolve the GGUF model path. Order:
 *  1. `MNEMOPI_EMBED_GGUF_PATH` explicit path (full filename).
 *  2. `<MNEMOPI_EMBED_GGUF_DIR>` or the canonical `MODEL_CACHE_DIR`
 *     (`~/.hermes/mnemopi/models`).
 *  3. `cacheDir` (the fastembed cache root) if provided.
 * Returns `null` when no candidate exists (caller should fall back).
 */
export function resolveGgufModelPath(model: string, cacheDir: string | undefined): string | null {
	const explicit = process.env.MNEMOPI_EMBED_GGUF_PATH?.trim();
	if (explicit) return explicit;
	const basename = ggufFilename(model);
	if (!basename) return null;
	const candidates = [defaultGgufCacheRoot()];
	if (cacheDir !== undefined && cacheDir !== "") {
		candidates.push(cacheDir);
	}
	for (const base of candidates) {
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
	return process.env.MNEMOPI_EMBED_GGUF_DIR ?? MODEL_CACHE_DIR;
}

/**
 * Lazily load node-llama-cpp (a heavy native addon) once. Uses `gpu: "auto"`
 * which resolves the best available backend (Vulkan here). Kept behind an
 * injected loader so tests can stub it without pulling the native addon.
 */
async function loadRuntime(modelPath: string): Promise<LlamaEmbeddingRuntime> {
	const { getLlama } = await moduleLoader();
	const llama = await getLlama({ gpu: "auto" });
	const model = await llama.loadModel({ modelPath });
	const context = await model.createEmbeddingContext({ contextSize: CONTEXT_SIZE });
	logger.debug("mnemopi: ggml embedding loaded", { gpu: llama.gpu, modelPath });
	return { llama, context, truncate: buildTruncate(model) };
}

/** Build an input-truncation helper backed by the model tokenizer, with a char clip fallback. */
function buildTruncate(model: LlamaCpp.LlamaModel): (input: string) => string {
	const tokenize = model.tokenize as ((text: string) => number[]) | undefined;
	const detokenize = model.detokenize as ((tokens: readonly number[]) => string) | undefined;
	if (typeof tokenize !== "function" || typeof detokenize !== "function") {
		return input => (input.length > CONTEXT_SIZE ? input.slice(0, CONTEXT_SIZE) : input);
	}
	return input => {
		const tokens = tokenize(input);
		if (tokens.length <= CONTEXT_SIZE) return input;
		return detokenize(tokens.slice(0, CONTEXT_SIZE - TRUNCATE_MARGIN));
	};
}

/** Dispose a loaded ggml runtime (context, then the llama loader). Best-effort. */
async function disposeRuntime(runtime: LlamaEmbeddingRuntime): Promise<void> {
	try {
		await runtime.context.dispose();
	} catch {
		// A partially-initialized or already-disposed runtime must not block a switch.
	}
	try {
		await runtime.llama.dispose();
	} catch {
		// Best-effort; the worker subprocess SIGKILL reaps any leak on shutdown.
	}
}

/** Build a `LocalEmbeddingModel`-compatible instance backed by ggml. */
function makeEmbeddingModel(runtime: LlamaEmbeddingRuntime): LocalEmbeddingModel {
	return {
		async *embed(texts: string[], batchSize = 64): AsyncIterable<number[][]> {
			for (let i = 0; i < texts.length; i += batchSize) {
				const batch = texts.slice(i, i + batchSize);
				const vectors: number[][] = [];
				for (const text of batch) {
					const { vector } = await runtime.context.getEmbeddingFor(runtime.truncate(text));
					vectors.push(Array.from(vector));
				}
				yield vectors;
			}
		},
		async queryEmbed(query: string): Promise<number[]> {
			const { vector } = await runtime.context.getEmbeddingFor(runtime.truncate(query));
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
	// A path switch (e.g. a different GGUF for the same model id) must NOT reuse
	// the previous context: node-llama-cpp embeddings are only comparable within
	// the exact same model file. Dispose the old context/model/runtime and load
	// the new one, so the worker's `(model, cacheDir)` reload yields the right
	// vectors rather than silently reusing the first path's context.
	if (llamaCache !== null && llamaCache.modelPath !== modelPath) {
		const previous = await llamaCache.promise.catch(() => null);
		if (previous !== null) {
			await disposeRuntime(previous);
		}
		llamaCache = null;
	}
	if (llamaCache === null) {
		llamaCache = { modelPath, promise: loadRuntime(modelPath) };
	}
	const loading = llamaCache.promise;
	try {
		const runtime = await loading;
		return makeEmbeddingModel(runtime);
	} catch (error) {
		if (llamaCache?.promise === loading) {
			llamaCache = null;
		}
		throw error;
	}
};

/** Restore the default loader and clear the cached runtime. Call from `afterEach`. */
export function resetGgmlForTests(): void {
	moduleLoader = DEFAULT_MODULE_LOADER;
	llamaCache = null;
}

export function setGgmlModuleLoaderForTests(loader: () => Promise<LlamaCppModule>): void {
	moduleLoader = loader;
	llamaCache = null;
}
