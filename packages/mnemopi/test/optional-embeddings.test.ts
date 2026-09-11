import { afterEach, describe, expect, it } from "bun:test";
import {
	available,
	embed,
	embedQuery,
	getEmbeddingApiCallCountForTests,
	resetEmbeddingProviderForTests,
	setEmbeddingProviderForTests,
	setLocalModelInitializerForTests,
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

function withLocalEmbeddingEnv<T>(fn: () => Promise<T> | T): Promise<T> {
	return withEnv(
		{
			NODE_ENV: undefined,
			BUN_ENV: undefined,
			MNEMOPI_NO_EMBEDDINGS: undefined,
			MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5",
			MNEMOPI_EMBEDDING_API_URL: undefined,
			OPENROUTER_BASE_URL: undefined,
			OPENROUTER_API_KEY: undefined,
			OPENAI_API_KEY: undefined,
		},
		fn,
	);
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

	it("uses a constructor-scoped embedding provider", async () => {
		const memory = new Mnemopi({
			embeddings: {
				provider: streamRows(texts => texts.map(text => [text.length, text.charCodeAt(0) || 0])),
			},
		});
		try {
			const result = await withMnemopiRuntimeOptions(memory.runtimeOptions, () => embedQuery("cache me"));
			expect(result).toEqual(new Float32Array([8, 99]));
		} finally {
			memory.close();
		}
	});

	it("returns null to every caller sharing a failed local model initialization, then retries", async () => {
		await withLocalEmbeddingEnv(async () => {
			let initCalls = 0;
			const unavailable = Promise.withResolvers<never>();
			const initializationStarted = Promise.withResolvers<void>();
			const observedCacheDirs: Array<string | undefined> = [];
			setLocalModelInitializerForTests(async options => {
				initCalls += 1;
				observedCacheDirs.push(options.cacheDir);
				if (initCalls === 1) {
					initializationStarted.resolve();
					return unavailable.promise;
				}
				return {
					embed: streamRows(texts => texts.map(text => [text.length, text.charCodeAt(0) || 0])),
				};
			});

			const first = embed(["first"]);
			await initializationStarted.promise;
			const waiter = embed(["same initialization"]);
			unavailable.reject(new Error("mnemopi embed subprocess unavailable"));

			expect(await Promise.all([first, waiter])).toEqual([null, null]);
			expect(await embed(["second"])).toEqual([new Float32Array([6, 115])]);
			expect(initCalls).toBe(2);
			expect(observedCacheDirs).toEqual([getFastembedCacheDir(), getFastembedCacheDir()]);
			expect(observedCacheDirs.some(cacheDir => cacheDir?.includes(".hermes") ?? false)).toBe(false);
		});
	});

	it("keeps a replacement local model cached when a stale initialization fails", async () => {
		await withLocalEmbeddingEnv(async () => {
			const stale = Promise.withResolvers<never>();
			const staleStarted = Promise.withResolvers<void>();
			setLocalModelInitializerForTests(() => {
				staleStarted.resolve();
				return stale.promise;
			});

			const staleEmbed = embed(["stale"]);
			await staleStarted.promise;

			let replacementInitCalls = 0;
			setLocalModelInitializerForTests(async () => {
				replacementInitCalls += 1;
				return {
					embed: streamRows(texts => texts.map(text => [text.length])),
				};
			});
			expect(await embed(["replacement"])).toEqual([new Float32Array([11])]);

			stale.reject(new Error("stale initialization failed"));
			expect(await staleEmbed).toBeNull();
			expect(await embed(["cached"])).toEqual([new Float32Array([6])]);
			expect(replacementInitCalls).toBe(1);
		});
	});
});
