import { afterEach, describe, expect, it } from "bun:test";
import {
	available,
	embed,
	embedQuery,
	getEmbeddingApiCallCountForTests,
	type LocalModelInitializer,
	resetEmbeddingProviderForTests,
	setEmbeddingProviderForTests,
	setLocalModelInitializerForTests,
	type StandardEmbeddingModel,
} from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { getFastembedCacheDir } from "@oh-my-pi/pi-utils";
import packageJson from "../package.json" with { type: "json" };

const ENV_KEYS = [
	"NODE_ENV",
	"BUN_ENV",
	"MNEMOPI_NO_EMBEDDINGS",
	"MNEMOPI_EMBEDDING_MODEL",
	"MNEMOPI_EMBEDDING_API_URL",
	"MNEMOPI_EMBEDDING_API_KEY",
	"OPENROUTER_BASE_URL",
	"OPENROUTER_API_KEY",
	"OPENAI_API_KEY",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

function snapshotEnv(): Partial<Record<EnvKey, string>> {
	const snapshot: Partial<Record<EnvKey, string>> = {};
	for (const key of ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) {
			snapshot[key] = value;
		}
	}
	return snapshot;
}

function restoreEnv(snapshot: Partial<Record<EnvKey, string>>): void {
	for (const key of ENV_KEYS) {
		const value = snapshot[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

async function withEnv<T>(updates: Partial<Record<EnvKey, string | undefined>>, fn: () => Promise<T> | T): Promise<T> {
	const snapshot = snapshotEnv();
	try {
		for (const key of ENV_KEYS) {
			if (key in updates) {
				const value = updates[key];
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
		resetEmbeddingProviderForTests();
		return await fn();
	} finally {
		restoreEnv(snapshot);
		resetEmbeddingProviderForTests();
	}
}

afterEach(() => {
	resetEmbeddingProviderForTests();
});

/** Wrap a synchronous matrix function as the `AsyncIterable<number[][]>` a provider now returns. */
function streamRows(
	rows: (texts: readonly string[]) => number[][],
): (texts: readonly string[]) => AsyncGenerator<number[][]> {
	return async function* (texts) {
		yield rows(texts);
	};
}

// Fastembed model ids `fastembedModelName` resolves the test model names to. Typed as
// `StandardEmbeddingModel` here (same inlined-string cast `fastembedModelName` uses)
// instead of value-importing fastembed's `EmbeddingModel` enum, whose module eagerly
// loads the onnxruntime-node native addon.
const FAST_BGE_SMALL_EN_V15 = "fast-bge-small-en-v1.5" as StandardEmbeddingModel;
const FAST_MULTILINGUAL_E5_LARGE = "fast-multilingual-e5-large" as StandardEmbeddingModel;
const MULTILINGUAL_SCOPE = { embeddings: { model: "intfloat/multilingual-e5-large" } } as const;

/** Local fastembed only: no test-runtime short-circuit, no API endpoint or keys. */
const LOCAL_EMBEDDING_ENV = {
	NODE_ENV: undefined,
	BUN_ENV: undefined,
	MNEMOPI_NO_EMBEDDINGS: undefined,
	MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5",
	MNEMOPI_EMBEDDING_API_URL: undefined,
	OPENROUTER_BASE_URL: undefined,
	OPENROUTER_API_KEY: undefined,
	OPENAI_API_KEY: undefined,
};

/**
 * Local-model initializer that records each requested model in `inits` and returns an
 * encoder whose rows identify it: `[1, 0]` for the small English model, `[0, 1, len]`
 * for any other model. `shouldFail` runs after the init is recorded, so it can fail a
 * specific attempt (e.g. the first load of one model) while later retries succeed.
 */
function modelTaggedInitializer(
	inits: StandardEmbeddingModel[],
	shouldFail?: (model: StandardEmbeddingModel) => boolean,
): LocalModelInitializer {
	return async options => {
		inits.push(options.model);
		if (shouldFail?.(options.model)) {
			throw new Error(`${options.model} init failure`);
		}
		return {
			embed: streamRows(texts =>
				texts.map(text => (options.model === FAST_BGE_SMALL_EN_V15 ? [1, 0] : [0, 1, text.length])),
			),
		};
	};
}

describe("optional embeddings", () => {
	it("falls back cleanly when embeddings are disabled", async () => {
		await withEnv({ MNEMOPI_NO_EMBEDDINGS: "1" }, async () => {
			setEmbeddingProviderForTests({ embed: streamRows(() => [[1, 2, 3]]), available: () => true });

			expect(await available()).toBe(false);
			expect(await embedQuery("hello")).toBeNull();
			expect(await embed(["hello"])).toBeNull();
		});
	});

	it("uses a fake provider and caches single-query embeddings", async () => {
		await withEnv({ MNEMOPI_NO_EMBEDDINGS: undefined }, async () => {
			let calls = 0;
			setEmbeddingProviderForTests({
				embed: streamRows(texts => {
					calls += 1;
					return texts.map(text => [text.length, text.charCodeAt(0) || 0]);
				}),
				available: () => true,
			});

			expect(await available()).toBe(true);
			expect(await embedQuery("cache me")).toEqual(new Float32Array([8, 99]));
			expect(await embedQuery("cache me")).toEqual(new Float32Array([8, 99]));
			expect(calls).toBe(1);
		});
	});

	it("returns null instead of throwing when the provider fails", async () => {
		await withEnv({ MNEMOPI_NO_EMBEDDINGS: undefined }, async () => {
			setEmbeddingProviderForTests({
				embed() {
					throw new Error("provider unavailable");
				},
			});

			expect(await embed(["hello"])).toBeNull();
			expect(await embedQuery("hello")).toBeNull();
		});
	});

	it("calls an OpenAI-compatible custom embeddings endpoint without requiring an API key", async () => {
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch: async request => {
				requests += 1;
				expect(request.headers.get("content-type")).toBe("application/json");
				expect(request.headers.get("user-agent")).toBe(`omp/${packageJson.version}`);
				expect(request.headers.get("http-referer")).toBe("https://omp.sh/");
				expect(request.headers.get("x-openrouter-title")).toBe("omp");
				expect(request.headers.get("x-openrouter-categories")).toBe("cli-agent");
				expect(request.headers.get("x-title")).toBeNull();
				expect(request.headers.get("authorization")).toBeNull();
				expect(new URL(request.url).pathname).toBe("/embeddings");
				const payload = (await request.json()) as { model: string; input: string[] };
				expect(payload.model).toBe("openai/text-embedding-3-small");
				return Response.json({
					data: payload.input.map((text, index) => ({ embedding: [text.length, index + 1] })),
				});
			},
		});

		try {
			await withEnv(
				{
					MNEMOPI_NO_EMBEDDINGS: undefined,
					MNEMOPI_EMBEDDING_MODEL: "openai/text-embedding-3-small",
					MNEMOPI_EMBEDDING_API_URL: server.url.toString().replace(/\/+$/, ""),
					MNEMOPI_EMBEDDING_API_KEY: undefined,
					OPENROUTER_API_KEY: undefined,
					OPENAI_API_KEY: undefined,
				},
				async () => {
					expect(await available()).toBe(true);
					expect(await embed(["hi", "world"])).toEqual([new Float32Array([2, 1]), new Float32Array([5, 2])]);
					expect(getEmbeddingApiCallCountForTests()).toBe(1);
				},
			);
			expect(requests).toBe(1);
		} finally {
			server.stop(true);
		}
	});
	it("flattens async batches into one matrix", async () => {
		await withEnv({ MNEMOPI_NO_EMBEDDINGS: undefined }, async () => {
			setEmbeddingProviderForTests({
				// fastembed-shaped: an async generator yielding batches of rows.
				embed: async function* (texts) {
					for (let i = 0; i < texts.length; i += 2) {
						yield texts.slice(i, i + 2).map(text => [text.length, text.charCodeAt(0) || 0]);
					}
				},
				available: () => true,
			});
			expect(await embed(["hi", "world", "test"])).toEqual([
				new Float32Array([2, 104]),
				new Float32Array([5, 119]),
				new Float32Array([4, 116]),
			]);
		});
	});

	it("lets constructor-scoped noEmbeddings override enabled providers", async () => {
		setEmbeddingProviderForTests({
			embed: streamRows(texts => texts.map(() => [1, 2, 3])),
			available: () => true,
		});
		const memory = new Mnemopi({ noEmbeddings: true });
		try {
			const result = await withMnemopiRuntimeOptions(memory.runtimeOptions, () => embed(["hello"]));
			expect(result).toBeNull();
		} finally {
			memory.close();
		}
	});

	it("retries local model initialization after a transient failure", async () => {
		await withEnv(LOCAL_EMBEDDING_ENV, async () => {
			let initCalls = 0;
			const observedCacheDirs: Array<string | undefined> = [];
			setLocalModelInitializerForTests(async options => {
				initCalls += 1;
				observedCacheDirs.push(options.cacheDir);
				if (initCalls === 1) throw new Error("transient init failure");
				return {
					embed: streamRows(texts => texts.map(text => [text.length, text.charCodeAt(0) || 0])),
				};
			});

			expect(await embed(["first"])).toBeNull();
			expect(await embed(["second"])).toEqual([new Float32Array([6, 115])]);
			expect(initCalls).toBe(2);
			expect(observedCacheDirs).toEqual([getFastembedCacheDir(), getFastembedCacheDir()]);
			expect(observedCacheDirs.some(cacheDir => cacheDir?.includes(".hermes") ?? false)).toBe(false);
		});
	});

	it("loads a separate local encoder per configured model", async () => {
		await withEnv(LOCAL_EMBEDDING_ENV, async () => {
			const inits: StandardEmbeddingModel[] = [];
			setLocalModelInitializerForTests(modelTaggedInitializer(inits));

			// Same query text, two runtime scopes with different local models: each
			// scope must embed through its own encoder, not the first-loaded one.
			expect(await embed(["shared text"])).toEqual([new Float32Array([1, 0])]);
			expect(await withMnemopiRuntimeOptions(MULTILINGUAL_SCOPE, () => embed(["shared text"]))).toEqual([
				new Float32Array([0, 1, 11]),
			]);
			// Switching back reuses the first encoder instead of re-initializing it.
			expect(await embed(["again"])).toEqual([new Float32Array([1, 0])]);
			expect([...inits].sort()).toEqual([FAST_BGE_SMALL_EN_V15, FAST_MULTILINGUAL_E5_LARGE]);
		});
	});

	it("evicts only the failed model's local encoder entry", async () => {
		await withEnv(LOCAL_EMBEDDING_ENV, async () => {
			const inits: StandardEmbeddingModel[] = [];
			setLocalModelInitializerForTests(
				modelTaggedInitializer(inits, model => model === FAST_MULTILINGUAL_E5_LARGE && inits.length === 2),
			);

			expect(await embed(["alpha"])).toEqual([new Float32Array([1, 0])]);
			// The failed multilingual init must not poison or reuse the healthy
			// English encoder: embed returns null, and the next scoped call retries.
			expect(await withMnemopiRuntimeOptions(MULTILINGUAL_SCOPE, () => embed(["beta"]))).toBeNull();
			expect(await withMnemopiRuntimeOptions(MULTILINGUAL_SCOPE, () => embed(["beta"]))).toEqual([
				new Float32Array([0, 1, 4]),
			]);
			expect(await embed(["gamma"])).toEqual([new Float32Array([1, 0])]);
			expect([...inits].sort()).toEqual([
				FAST_BGE_SMALL_EN_V15,
				FAST_MULTILINGUAL_E5_LARGE,
				FAST_MULTILINGUAL_E5_LARGE,
			]);
		});
	});

	it("shares one initialization between concurrent calls for the same model", async () => {
		await withEnv(LOCAL_EMBEDDING_ENV, async () => {
			const inits: StandardEmbeddingModel[] = [];
			setLocalModelInitializerForTests(modelTaggedInitializer(inits));

			const [first, second] = await Promise.all([
				withMnemopiRuntimeOptions(MULTILINGUAL_SCOPE, () => embed(["three"])),
				withMnemopiRuntimeOptions(MULTILINGUAL_SCOPE, () => embed(["four"])),
			]);
			expect(first).toEqual([new Float32Array([0, 1, 5])]);
			expect(second).toEqual([new Float32Array([0, 1, 4])]);
			expect(inits).toEqual([FAST_MULTILINGUAL_E5_LARGE]);
		});
	});
});
