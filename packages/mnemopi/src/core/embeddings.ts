import { mkdirSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { type ApiKey, getOpenRouterHeaders, withAuth } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { hostMatchesUrl } from "@oh-my-pi/pi-catalog/hosts";
import {
	$env,
	$flag,
	extractHttpStatusFromError,
	fetchWithRetry,
	getFastembedCacheDir,
	logger,
} from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { EmbeddingModel } from "fastembed";
import { ensureFastembedModelSidecars } from "./fastembed-model-cache";
import { loadFastembed } from "./fastembed-runtime";
import {
	type EmbeddingOutput,
	getMnemopiRuntimeOptions,
	mnemopiDebugEnabled,
	resolveEmbeddingProvider,
} from "./runtime-options";

export type { EmbeddingOutput } from "./runtime-options";
export { cosineSimilarity } from "./vector-math";

export type Vector = Float32Array;
export type EmbeddingMatrix = Vector[];

export interface EmbeddingProvider {
	embed(texts: readonly string[]): EmbeddingOutput | Promise<EmbeddingOutput>;
	available?(): boolean | Promise<boolean>;
}

export type StandardEmbeddingModel = Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>;

export interface LocalEmbeddingModel {
	embed(texts: string[], batchSize?: number): EmbeddingOutput;
	queryEmbed?(query: string): Promise<number[]>;
}

export type LocalModelInitOptions = {
	model: StandardEmbeddingModel;
	cacheDir?: string;
	showDownloadProgress?: boolean;
};
export type LocalModelInitializer = (options: LocalModelInitOptions) => Promise<LocalEmbeddingModel>;

const QUERY_CACHE_MAX = 512;

let providerOverride: EmbeddingProvider | null = null;
let localModelPromise: Promise<LocalEmbeddingModel> | null = null;
let localModelInitializer: LocalModelInitializer = defaultLocalModelInitializer;
let apiCallCount = 0;
const queryCache = new LRUCache<string, Vector>({ max: QUERY_CACHE_MAX });

// Provider identity table for the cache key. Each unique `provider` object/function
// (configured via `withMnemopiRuntimeOptions`) gets a stable integer id so the cache
// scope reflects the runtime's actual embedding source. Two Mnemopi instances in the
// same process using different providers/models hash to disjoint keys and never
// collide on the same query text. `0` is the sentinel for "env-default fallback".
const providerIds = new WeakMap<object, number>();
let nextProviderId = 1;

/**
 * Quarantine the exact ONNX file named by a "Protobuf parsing failed" init
 * error. A truncated cached model blocks local embeddings forever: the
 * downloader treats the existing file as complete, so every init re-parses
 * the same broken bytes. The extracted path is error-message CONTENT, so it
 * is only honored when it resolves inside the fastembed cache directory —
 * never rename an arbitrary file a dependency happens to mention. Atomic
 * rename; losing a concurrent-heal race (file already renamed/removed)
 * still returns true because a retry is safe either way.
 * @internal exported for tests
 */
export async function quarantineCorruptModelFile(message: string, cacheDir?: string): Promise<boolean> {
	const match = /Load model from (.+?\.onnx) failed:.*Protobuf parsing failed/i.exec(message);
	if (!match) return false;
	const modelFile = nodePath.resolve(match[1]);
	const cacheRoot = nodePath.resolve(cacheDir ?? getFastembedCacheDir());
	if (!modelFile.startsWith(cacheRoot + nodePath.sep)) return false;
	try {
		await fsp.rename(modelFile, `${modelFile}.corrupt-${Date.now()}`);
		logger.warn("mnemopi: quarantined corrupt local embedding model; retrying init", { modelFile });
	} catch {
		// Concurrent heal or vanished file: the single retry stays safe. A
		// rename that failed with the file still in place just makes the
		// retry surface the original error again.
	}
	return true;
}

/**
 * Recover from a partially-extracted fastembed model cache. An interrupted
 * archive download/extraction leaves `<cacheDir>/<model>/` populated with
 * sidecars and a truncated `model.onnx_data` but WITHOUT the graph file
 * (`model.onnx` / `model_optimized.onnx`), so `FlagEmbedding.init` throws
 * `Model file not found at .../model.onnx`. Upstream `retrieveModel`
 * short-circuits on the existing model dir and never re-downloads, and
 * `downloadFileFromGCS` reuses a leftover partial `<model>.tar.gz` as-is, so
 * the cache is stuck broken forever: recall silently dies and the rebuild
 * queue grows every session. Delete the incomplete model dir AND the leftover
 * partial archive so the retry re-downloads from scratch. The model path is
 * error-message CONTENT, so the dir is only removed when it is a direct child
 * of the fastembed cache root — never touch a directory a dependency merely
 * names. Returns true when a retry is worth attempting (the incomplete cache
 * was cleared, or already gone from a concurrent heal).
 * @internal exported for tests
 */
export async function clearIncompleteModelCache(message: string, cacheDir?: string): Promise<boolean> {
	const match = /Model file not found at (.+?\.onnx)\b/i.exec(message);
	if (!match) return false;
	const modelFile = nodePath.resolve(match[1]);
	const modelDir = nodePath.dirname(modelFile);
	const cacheRoot = nodePath.resolve(cacheDir ?? getFastembedCacheDir());
	// Only a direct child of the cache root: `<cacheRoot>/<model>`.
	if (nodePath.dirname(modelDir) !== cacheRoot) return false;
	try {
		await fsp.rm(modelDir, { recursive: true, force: true });
		await fsp.rm(`${modelDir}.tar.gz`, { force: true });
		logger.warn("mnemopi: cleared incomplete local embedding model cache; re-downloading", { modelDir });
	} catch {
		// Concurrent heal or vanished dir: the single retry stays safe.
	}
	return true;
}

const SIDECAR_ERROR_RE =
	/(?:Config file not found at .*config|Tokenizer file not found at .*tokenizer|Tokens map file not found at .*special_tokens_map)/u;

/**
 * Shared local-model initializer: FlagEmbedding.init with BOTH cache heals.
 * Missing sidecars (config/tokenizer/tokens map) re-fetch and retry; a
 * corrupt model blob (Protobuf parse failure) quarantines the file and
 * retries THROUGH the sidecar heal, so a cache that is broken in both ways
 * still recovers in one pass. Also the initializer the embed worker uses in
 * its subprocess; the in-process seam stays {@link setLocalModelInitializer}.
 */
export async function defaultLocalModelInitializer(options: LocalModelInitOptions): Promise<LocalEmbeddingModel> {
	const cacheDir = options.cacheDir ?? getFastembedCacheDir();
	const initOptions = options.cacheDir === undefined ? { ...options, cacheDir } : options;
	const { FlagEmbedding } = await loadFastembed();
	const initWithSidecarHeal = async (): Promise<LocalEmbeddingModel> => {
		try {
			return await FlagEmbedding.init(initOptions);
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (!SIDECAR_ERROR_RE.test(message)) throw error;
			if (!(await ensureFastembedModelSidecars(options.model, cacheDir))) throw error;
			return FlagEmbedding.init(initOptions);
		}
	};
	try {
		return await initWithSidecarHeal();
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (/Protobuf parsing failed/i.test(message) && (await quarantineCorruptModelFile(message, cacheDir))) {
			return initWithSidecarHeal();
		}
		if (await clearIncompleteModelCache(message, cacheDir)) {
			return initWithSidecarHeal();
		}
		throw error;
	}
}

function activeEmbeddingOptions() {
	return getMnemopiRuntimeOptions()?.embeddings;
}

/**
 * Compose the per-query cache key. Includes the active provider's identity, the
 * resolved model name, and the API base URL so two `Mnemopi` instances in the same
 * process that point at different providers/models never share a cached query
 * vector. Provider identity comes from `providerIds` (WeakMap-assigned integer);
 * `0` is the sentinel for "no provider configured, fall back to env defaults".
 */
function queryCacheKey(text: string): string {
	const active = activeEmbeddingOptions();
	const provider = active?.provider as object | undefined;
	let providerId = 0;
	if (provider !== undefined) {
		const existing = providerIds.get(provider);
		if (existing === undefined) {
			providerId = nextProviderId++;
			providerIds.set(provider, providerId);
		} else {
			providerId = existing;
		}
	}
	const model = defaultModel();
	const apiUrl = active?.apiUrl ?? "";
	return `${providerId}::${model}::${apiUrl}::${text}`;
}

function inTestRuntime(): boolean {
	return $env.NODE_ENV === "test" || $env.BUN_ENV === "test";
}

export function embeddingsDisabled(): boolean {
	const active = activeEmbeddingOptions();
	if (active?.disabled !== undefined) {
		return active.disabled;
	}
	return $flag("MNEMOPI_NO_EMBEDDINGS");
}

/**
 * Resolved per-input character cap for {@link embed}.
 *
 * Reads (in order): the active runtime scope's `embeddings.maxInputChars`, then
 * `MNEMOPI_EMBEDDING_MAX_INPUT_CHARS`, then the bundled `8192` default. `0`
 * disables the cap entirely.
 */
function effectiveMaxInputChars(): number {
	const override = activeEmbeddingOptions()?.maxInputChars;
	if (override !== undefined) return Math.max(0, Math.trunc(override));
	const envValue = Number.parseInt($env.MNEMOPI_EMBEDDING_MAX_INPUT_CHARS ?? "", 10);
	if (Number.isFinite(envValue) && envValue >= 0) return envValue;
	return 8192;
}

/** Elision marker injected between the retained head and tail of an oversized input. */
const EMBEDDING_ELISION_MARKER = "\n\n[...]\n\n";

/**
 * Right-clip a single oversized input to {@link max} chars while preserving
 * both ends. Retention transcripts are chronological (oldest → newest), so a
 * naive `slice(0, max)` would drop the most recent — and most semantically
 * loaded — turns once a session passed the cap, leaving every later retained
 * episode with essentially the same prefix vector. Keeping a head/tail split
 * lets the embedding capture the topic setup at the start AND the latest
 * exchanges at the end. Falls back to a tail-only clip when `max` is too
 * small to fit the elision marker plus a useful slice on either side.
 */
function clipToWindow(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= EMBEDDING_ELISION_MARKER.length + 16) return text.slice(text.length - max);
	const budget = max - EMBEDDING_ELISION_MARKER.length;
	const headLen = budget >>> 1;
	const tailLen = budget - headLen;
	return text.slice(0, headLen) + EMBEDDING_ELISION_MARKER + text.slice(text.length - tailLen);
}

/**
 * Clip every input to {@link effectiveMaxInputChars} so a runaway retention
 * transcript can't blow past the embedding model's context window. Uses a
 * head/tail split via {@link clipToWindow} so the embedding still sees the
 * tail of the conversation (where the latest topic shifts live) and not just
 * the stale prefix. Returns the original array when no input needs trimming
 * (the common case); the new array is allocated only when at least one input
 * is oversized so we don't churn arrays for the typical short-query path
 * through `embedQuery`. Emits one debug-or-warn log per call summarizing how
 * many inputs were trimmed and by how much — silent truncation was the
 * original bug (#3126).
 */
function capInputs(texts: readonly string[]): readonly string[] {
	const max = effectiveMaxInputChars();
	if (max === 0) return texts;
	let trimmed: string[] | null = null;
	let trimmedCount = 0;
	let maxOriginalLen = 0;
	for (let i = 0; i < texts.length; i++) {
		const text = texts[i] ?? "";
		if (text.length <= max) continue;
		if (trimmed === null) trimmed = texts.slice() as string[];
		trimmed[i] = clipToWindow(text, max);
		trimmedCount++;
		if (text.length > maxOriginalLen) maxOriginalLen = text.length;
	}
	if (trimmed === null) return texts;
	logger[mnemopiDebugEnabled() ? "warn" : "debug"]("mnemopi: embedding input truncated", {
		inputCount: texts.length,
		trimmedCount,
		maxOriginalLen,
		maxInputChars: max,
	});
	return trimmed;
}

function embeddingApiKey(): ApiKey {
	const active = activeEmbeddingOptions();
	if (active?.apiKey !== undefined) {
		return active.apiKey;
	}
	return $env.MNEMOPI_EMBEDDING_API_KEY || $env.OPENROUTER_API_KEY || $env.OPENAI_API_KEY || "";
}

/** A resolver always counts as configured; a static key only when non-empty. */
function embeddingKeyConfigured(key: ApiKey = embeddingApiKey()): boolean {
	return typeof key === "function" || key !== "";
}

function embeddingBaseUrl(): string {
	const active = activeEmbeddingOptions();
	if (active?.apiUrl !== undefined) {
		return active.apiUrl;
	}
	return $env.MNEMOPI_EMBEDDING_API_URL || $env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
}

function defaultModel(): string {
	const active = activeEmbeddingOptions();
	if (active?.model !== undefined) {
		return active.model;
	}
	return $env.MNEMOPI_EMBEDDING_MODEL || "BAAI/bge-small-en-v1.5";
}

/**
 * Resolve the embedding model name for the currently active runtime scope.
 *
 * Reads (in order): the active provider's `model` from `withMnemopiRuntimeOptions`,
 * the `MNEMOPI_EMBEDDING_MODEL` env var, then the bundled fastembed default. Stored
 * alongside each row in `memory_embeddings.model` so migrations can re-embed when
 * the active model changes.
 */
export function currentEmbeddingModel(): string {
	return defaultModel();
}

export function isApiModel(modelName: string): boolean {
	if (
		modelName.startsWith("openai/") ||
		modelName.includes("text-embedding") ||
		modelName.startsWith("text-embedding")
	) {
		return true;
	}
	const active = activeEmbeddingOptions();
	const baseUrl = active?.apiUrl ?? ($env.MNEMOPI_EMBEDDING_API_URL || $env.OPENROUTER_BASE_URL);
	if (baseUrl !== undefined && baseUrl !== "" && !hostMatchesUrl(baseUrl, "openrouter")) {
		return true;
	}
	return $flag("MNEMOPI_EMBEDDINGS_VIA_API");
}

const MODEL_DIMS: Record<string, number> = {
	"BAAI/bge-small-en-v1.5": 384,
	"BAAI/bge-base-en-v1.5": 768,
	"BAAI/bge-large-en-v1.5": 1024,
	"BAAI/bge-small-zh-v1.5": 512,
	"BAAI/bge-base-zh-v1.5": 768,
	"BAAI/bge-large-zh-v1.5": 1024,
	"intfloat/multilingual-e5-small": 384,
	"intfloat/multilingual-e5-base": 768,
	"intfloat/multilingual-e5-large": 1024,
	"BAAI/bge-m3": 1024,
	"BAAI/bge-multilingual-gemma2": 3584,
	"openai/text-embedding-3-small": 1536,
	"openai/text-embedding-3-large": 3072,
	"text-embedding-3-small": 1536,
	"text-embedding-3-large": 3072,
	"jina-embeddings-v5-omni-nano": 768,
	"jina-embeddings-v5-omni-small": 1024,
};
export function embeddingDimFor(modelName: string): number {
	const override = Number.parseInt($env.MNEMOPI_EMBEDDING_DIM ?? "", 10);
	if (Number.isFinite(override)) {
		return override;
	}
	return MODEL_DIMS[modelName] ?? 384;
}

/** Drain an embedding stream (a custom provider or fastembed) into a `Float32Array` matrix. */
async function collectMatrix(batches: EmbeddingOutput): Promise<EmbeddingMatrix> {
	const rows: Vector[] = [];
	for await (const batch of batches) {
		for (const row of batch) {
			rows.push(new Float32Array(row));
		}
	}
	return rows;
}

const KNOWN_MODEL_NAMES: Record<string, string> = {
	"BAAI/bge-small-en-v1.5": "fast-bge-small-en-v1.5",
	"BAAI/bge-base-en-v1.5": "fast-bge-base-en-v1.5",
	"BAAI/bge-small-en": "fast-bge-small-en",
	"BAAI/bge-base-en": "fast-bge-base-en",
	"BAAI/bge-small-zh-v1.5": "fast-bge-small-zh-v1.5",
	"intfloat/multilingual-e5-large": "fast-multilingual-e5-large",
	"sentence-transformers/all-MiniLM-L6-v2": "fast-all-MiniLM-L6-v2",
};
function fastembedModelName(modelName: string): StandardEmbeddingModel | null {
	// Fastembed `EmbeddingModel` enum string values, inlined so resolving a model name
	// (and `available()`) never imports `fastembed` — its module eagerly loads the
	// `onnxruntime-node` native addon, which segfaults in some runtimes.
	const id = KNOWN_MODEL_NAMES[modelName];
	return id === undefined ? null : (id as StandardEmbeddingModel);
}

async function getLocalModel(): Promise<LocalEmbeddingModel | null> {
	if (isApiModel(defaultModel()) || embeddingsDisabled() || inTestRuntime()) {
		return null;
	}
	if (localModelPromise !== null) {
		return localModelPromise;
	}

	const modelName = fastembedModelName(defaultModel());
	if (modelName === null) {
		return null;
	}
	const cacheDir = getFastembedCacheDir();
	mkdirSync(cacheDir, { recursive: true });
	const loading = localModelInitializer({
		model: modelName,
		cacheDir,
		showDownloadProgress: false,
	});
	localModelPromise = loading;
	try {
		return await loading;
	} catch (error) {
		logger[mnemopiDebugEnabled() ? "warn" : "debug"]("mnemopi: local embedding model failed to load", {
			model: modelName,
			error: String(error),
		});
		if (localModelPromise === loading) localModelPromise = null;
		return null;
	}
}

async function embedApi(texts: readonly string[]): Promise<EmbeddingMatrix | null> {
	const baseUrl = embeddingBaseUrl();
	const isCustom = !hostMatchesUrl(baseUrl, "openrouter");
	const apiKey = embeddingApiKey();
	if (!isCustom && !embeddingKeyConfigured(apiKey)) {
		return null;
	}

	const body = JSON.stringify({ model: defaultModel(), input: texts });
	try {
		// withAuth re-resolves the key on 401 (force-refresh, then sibling
		// rotation) when `apiKey` is a resolver. The 429 backoff stays inside
		// the attempt via fetchWithRetry. An empty static key attempts without
		// an Authorization header (local/proxy setups).
		const response = await withAuth(apiKey, async key => {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				...getOpenRouterHeaders(),
			};
			if (key !== "") {
				headers.Authorization = `Bearer ${key}`;
			}
			const res = await fetchWithRetry(`${baseUrl.replace(/\/+$/, "")}/embeddings`, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(30000),
				maxAttempts: 3,
				defaultDelayMs: attempt => 2 ** attempt * 1000,
			});
			if (res.status === 401) {
				throw new ProviderHttpError("mnemopi embedding request unauthorized (401)", 401, { headers: res.headers });
			}
			return res;
		});
		if (!response.ok) {
			return null;
		}
		const { data: rows } = (await response.json()) as { data?: Array<{ embedding: number[] }> };
		if (rows === undefined) {
			return null;
		}
		apiCallCount += 1;
		return rows.map(row => new Float32Array(row.embedding));
	} catch (error) {
		logger.debug("mnemopi embedding request failed", { status: extractHttpStatusFromError(error) });
		return null;
	}
}

async function providerAvailable(provider: EmbeddingProvider): Promise<boolean> {
	if (provider.available === undefined) {
		return true;
	}
	try {
		return await provider.available();
	} catch {
		return false;
	}
}

export function setEmbeddingProviderForTests(provider: EmbeddingProvider | null | undefined): void {
	providerOverride = provider ?? null;
	queryCache.clear();
}

export const setEmbeddingProvider = setEmbeddingProviderForTests;

export function setLocalModelInitializerForTests(initializer: LocalModelInitializer | null | undefined): void {
	localModelInitializer = initializer ?? defaultLocalModelInitializer;
	localModelPromise = null;
	queryCache.clear();
}

/**
 * Override the function used to construct the local fastembed model the next
 * time `embed()` is called. Lets a host (e.g. the agent CLI) keep
 * `onnxruntime-node` out of its own address space by routing every fastembed
 * load + inference through a dedicated subprocess. Same wipe semantics as the
 * `*ForTests` form: clears the cached model promise and the query cache so
 * subsequent embeds run through the new initializer immediately.
 */
export const setLocalModelInitializer = setLocalModelInitializerForTests;

export function resetEmbeddingProviderForTests(): void {
	providerOverride = null;
	localModelPromise = null;
	localModelInitializer = defaultLocalModelInitializer;
	apiCallCount = 0;
	queryCache.clear();
}

export const resetEmbeddingStateForTests = resetEmbeddingProviderForTests;

export async function available(): Promise<boolean> {
	if (embeddingsDisabled()) {
		return false;
	}
	const active = activeEmbeddingOptions();
	const activeProvider = resolveEmbeddingProvider(active?.provider);
	if (activeProvider !== undefined) {
		return providerAvailable(activeProvider);
	}
	if (providerOverride !== null) {
		return providerAvailable(providerOverride);
	}
	if (isApiModel(defaultModel())) {
		const baseUrl = active?.apiUrl ?? ($env.MNEMOPI_EMBEDDING_API_URL || $env.OPENROUTER_BASE_URL);
		if (baseUrl !== undefined && baseUrl !== "" && !hostMatchesUrl(baseUrl, "openrouter")) {
			return true;
		}
		return embeddingKeyConfigured();
	}
	if (inTestRuntime()) {
		return false;
	}
	return fastembedModelName(defaultModel()) !== null;
}

export function availableApi(): boolean {
	return embeddingKeyConfigured();
}

export async function embedQuery(text: string): Promise<Vector | null> {
	if (text === "" || embeddingsDisabled()) {
		return null;
	}
	const key = queryCacheKey(text);
	const cached = queryCache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const vectors = await embed([text]);
	const vector = vectors?.[0] ?? null;
	if (vector !== null) {
		queryCache.set(key, vector);
	}
	return vector;
}

export async function embed(texts: readonly string[]): Promise<EmbeddingMatrix | null> {
	if (texts.length === 0 || embeddingsDisabled()) {
		return null;
	}
	texts = capInputs(texts);
	const activeProvider = resolveEmbeddingProvider(activeEmbeddingOptions()?.provider);
	if (activeProvider !== undefined) {
		try {
			return await collectMatrix(await activeProvider.embed(texts));
		} catch {
			return null;
		}
	}
	if (providerOverride !== null) {
		try {
			return await collectMatrix(await providerOverride.embed(texts));
		} catch {
			return null;
		}
	}
	if (isApiModel(defaultModel())) {
		return embedApi(texts);
	}
	if (texts.length === 1) {
		const key = queryCacheKey(texts[0] ?? "");
		const cached = queryCache.get(key);
		if (cached !== undefined) {
			return [cached];
		}
	}
	const model = await getLocalModel();
	if (model === null) {
		return null;
	}
	try {
		const vectors = await collectMatrix(model.embed([...texts]));
		if (vectors.length === 1) {
			const vector = vectors[0];
			if (vector !== undefined) {
				queryCache.set(queryCacheKey(texts[0] ?? ""), vector);
			}
		}
		return vectors;
	} catch (error) {
		logger[mnemopiDebugEnabled() ? "warn" : "debug"]("mnemopi: local embedding failed", {
			textCount: texts.length,
			error: String(error),
		});
		return null;
	}
}

export function getEmbeddingApiCallCountForTests(): number {
	return apiCallCount;
}

export const DEFAULT_MODEL = defaultModel();
export const EMBEDDING_DIM = embeddingDimFor(DEFAULT_MODEL);
