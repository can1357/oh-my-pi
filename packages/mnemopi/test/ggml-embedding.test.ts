// Contract: ggmlLocalModelInitializer builds a LocalEmbeddingModel from a
// stubbed node-llama-cpp loader, yields batched vectors, truncates inputs that
// exceed the context budget, reloads when the resolved GGUF path changes (and
// disposes the previous runtime), and fails fast when no GGUF model path
// resolves. The native addon is never pulled — a fake loader is injected via
// setGgmlModuleLoaderForTests, and afterEach restores the default loader so a
// later file never inherits a stale fake.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ggmlLocalModelInitializer,
	resetGgmlForTests,
	resolveGgufModelPath,
	setGgmlModuleLoaderForTests,
} from "../src/core/ggml-embedding";

afterEach(() => {
	resetGgmlForTests();
});

function fakeLlamaLoader(vector: number[], gpu = "vulkan") {
	return async () =>
		({
			getLlama: async () => ({
				gpu,
				dispose: async () => {},
				loadModel: async () => ({
					embeddingVectorSize: vector.length,
					createEmbeddingContext: async () => ({
						getEmbeddingFor: async (input: string) => ({
							vector: vector.map((v, i) => (input ? v + i * 0.001 : v)),
						}),
						dispose: async () => {},
					}),
				}),
			}),
		}) as never;
}

/** Run a test body with a fake GGUF path set, restoring the prior env after. */
async function withFakeGgufPath<T>(body: () => Promise<T>): Promise<T> {
	const prev = process.env.MNEMOPI_EMBED_GGUF_PATH;
	process.env.MNEMOPI_EMBED_GGUF_PATH = "/tmp/fake-model.gguf";
	try {
		return await body();
	} finally {
		if (prev !== undefined) process.env.MNEMOPI_EMBED_GGUF_PATH = prev;
		else delete process.env.MNEMOPI_EMBED_GGUF_PATH;
	}
}

describe("ggmlLocalModelInitializer", () => {
	test("embeds a batch and collapses the async generator into one matrix", async () => {
		resetGgmlForTests();
		setGgmlModuleLoaderForTests(fakeLlamaLoader([1, 2, 3]) as never);
		await withFakeGgufPath(async () => {
			const model = await ggmlLocalModelInitializer({ model: "fast-bge-base-en-v1.5" as never });
			const rows: number[][] = [];
			for await (const batch of model.embed(["a", "b"])) {
				expect(Array.isArray(batch)).toBe(true);
				for (const row of batch) rows.push(row);
			}
			expect(rows).toHaveLength(2);
			expect(rows[0]).toHaveLength(3);
			expect(rows[0][0]).toBeCloseTo(1);
		});
	});

	test("queryEmbed returns a single vector through the embedding context", async () => {
		resetGgmlForTests();
		setGgmlModuleLoaderForTests(fakeLlamaLoader([5, 6, 7]) as never);
		await withFakeGgufPath(async () => {
			const model = await ggmlLocalModelInitializer({ model: "fast-bge-base-en-v1.5" as never });
			const vec = await model.queryEmbed?.("query text");
			expect(vec).toHaveLength(3);
			expect(vec?.[0]).toBeCloseTo(5);
		});
	});

	test("rejects when no GGUF model path can be resolved", async () => {
		resetGgmlForTests();
		const before = process.env.MNEMOPI_EMBED_GGUF_PATH;
		delete process.env.MNEMOPI_EMBED_GGUF_PATH;
		try {
			// Unknown model id → no GGUF basename → null path → throws.
			await expect(
				ggmlLocalModelInitializer({ model: "fast-all-MiniLM-L6-v2" as never, cacheDir: "/tmp/definitely-empty" }),
			).rejects.toThrow(/no GGUF model for/);
		} finally {
			if (before !== undefined) process.env.MNEMOPI_EMBED_GGUF_PATH = before;
		}
	});

	test("uses gpu from the loader without requiring an explicit gpu option", async () => {
		resetGgmlForTests();
		setGgmlModuleLoaderForTests(fakeLlamaLoader([1], "metal") as never);
		await withFakeGgufPath(async () => {
			const model = await ggmlLocalModelInitializer({ model: "fast-bge-small-en-v1.5" as never });
			const vec = await model.queryEmbed?.("x");
			expect(vec).toHaveLength(1);
		});
	});

	test("truncates an input that exceeds the token budget before evaluation", async () => {
		resetGgmlForTests();
		let seen = "";
		setGgmlModuleLoaderForTests(
			(async () => ({
				getLlama: async () => ({
					gpu: "vulkan",
					dispose: async () => {},
					loadModel: async () => ({
						embeddingVectorSize: 3,
						createEmbeddingContext: async () => ({
							getEmbeddingFor: async (input: string) => {
								seen = input;
								return { vector: [1, 2, 3] };
							},
							dispose: async () => {},
						}),
					}),
				}),
			})) as never,
		);
		await withFakeGgufPath(async () => {
			const model = await ggmlLocalModelInitializer({ model: "fast-bge-base-en-v1.5" as never });
			for await (const _batch of model.embed(["x".repeat(4000)])) {
				// consume
			}
			// The tokenizer-less fake falls back to a character clip so the
			// context is never asked to evaluate more than its token budget.
			expect(seen.length).toBeGreaterThan(0);
			expect(seen.length).toBeLessThanOrEqual(512);
		});
	});

	test("reloads for a different GGUF path and disposes the previous runtime", async () => {
		resetGgmlForTests();
		let created = 0;
		let disposedContexts = 0;
		let disposedLlama = 0;
		setGgmlModuleLoaderForTests(
			(async () => ({
				getLlama: async () => {
					created += 1;
					return {
						gpu: "vulkan",
						dispose: async () => {
							disposedLlama += 1;
						},
						loadModel: async () => ({
							embeddingVectorSize: 3,
							createEmbeddingContext: async () => ({
								getEmbeddingFor: async () => ({ vector: [created, 0, 0] }),
								dispose: async () => {
									disposedContexts += 1;
								},
							}),
						}),
					};
				},
			})) as never,
		);
		const setPath = async (value: string, body: () => Promise<void>) => {
			const before = process.env.MNEMOPI_EMBED_GGUF_PATH;
			process.env.MNEMOPI_EMBED_GGUF_PATH = value;
			try {
				await body();
			} finally {
				if (before !== undefined) process.env.MNEMOPI_EMBED_GGUF_PATH = before;
				else delete process.env.MNEMOPI_EMBED_GGUF_PATH;
			}
		};
		await setPath("/tmp/gguf-a.gguf", async () => {
			const first = await ggmlLocalModelInitializer({ model: "fast-bge-base-en-v1.5" as never });
			await first.queryEmbed?.("a");
		});
		await setPath("/tmp/gguf-b.gguf", async () => {
			const second = await ggmlLocalModelInitializer({ model: "fast-bge-base-en-v1.5" as never });
			const vec = await second.queryEmbed?.("b");
			// The second load must emit vectors from its OWN context, not the
			// first path's cached runtime.
			expect(vec?.[0]).toBeCloseTo(2);
		});
		expect(created).toBe(2);
		expect(disposedContexts).toBe(1);
		expect(disposedLlama).toBe(1);
	});
});

describe("resolveGgufModelPath", () => {
	test("prefers the explicit MNEMOPI_EMBED_GGUF_PATH over cache lookup", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-gguf-"));
		const modelFile = path.join(dir, "bge-base-en-v1.5-q4_k_m.gguf");
		try {
			await fs.writeFile(modelFile, "x");
			const before = process.env.MNEMOPI_EMBED_GGUF_PATH;
			process.env.MNEMOPI_EMBED_GGUF_PATH = modelFile;
			try {
				expect(resolveGgufModelPath("fast-bge-base-en-v1.5", dir)).toBe(modelFile);
			} finally {
				if (before !== undefined) process.env.MNEMOPI_EMBED_GGUF_PATH = before;
				else delete process.env.MNEMOPI_EMBED_GGUF_PATH;
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("maps a fastembed id to its GGUF basename and finds it in the cache dir", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-gguf-cache-"));
		const modelFile = path.join(dir, "bge-base-en-v1.5-q4_k_m.gguf");
		await fs.writeFile(modelFile, "x");
		try {
			const before = process.env.MNEMOPI_EMBED_GGUF_PATH;
			delete process.env.MNEMOPI_EMBED_GGUF_PATH;
			try {
				expect(resolveGgufModelPath("fast-bge-base-en-v1.5", dir)).toBe(modelFile);
			} finally {
				if (before !== undefined) process.env.MNEMOPI_EMBED_GGUF_PATH = before;
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("finds the GGUF in the canonical mnemopi/models cache root", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-gguf-root-"));
		const modelsDir = path.join(root, "mnemopi", "models");
		await fs.mkdir(modelsDir, { recursive: true });
		const modelFile = path.join(modelsDir, "bge-base-en-v1.5-q4_k_m.gguf");
		await fs.writeFile(modelFile, "x");
		try {
			const prevDir = process.env.MNEMOPI_EMBED_GGUF_DIR;
			const prevPath = process.env.MNEMOPI_EMBED_GGUF_PATH;
			// Point the gguf cache root at the production layout (~/.hermes/mnemopi/models)
			// so the default root lands in the canonical model directory.
			process.env.MNEMOPI_EMBED_GGUF_DIR = modelsDir;
			delete process.env.MNEMOPI_EMBED_GGUF_PATH;
			try {
				// cacheDir is the fastembed cache root; the canonical model dir wins.
				expect(
					resolveGgufModelPath("fast-bge-base-en-v1.5", path.join(root, "cache", "fastembed")),
				).toBe(modelFile);
			} finally {
				if (prevDir !== undefined) process.env.MNEMOPI_EMBED_GGUF_DIR = prevDir;
				else delete process.env.MNEMOPI_EMBED_GGUF_DIR;
				if (prevPath !== undefined) process.env.MNEMOPI_EMBED_GGUF_PATH = prevPath;
				else delete process.env.MNEMOPI_EMBED_GGUF_PATH;
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("returns null for an unknown model id with no explicit path", async () => {
		const before = process.env.MNEMOPI_EMBED_GGUF_PATH;
		delete process.env.MNEMOPI_EMBED_GGUF_PATH;
		try {
			expect(resolveGgufModelPath("fast-all-MiniLM-L6-v2", "/tmp/definitely-empty")).toBeNull();
		} finally {
			if (before !== undefined) process.env.MNEMOPI_EMBED_GGUF_PATH = before;
		}
	});
});
