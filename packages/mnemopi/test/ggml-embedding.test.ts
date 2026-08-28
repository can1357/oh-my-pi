// Contract: ggmlLocalModelInitializer builds a LocalEmbeddingModel from a
// stubbed node-llama-cpp loader, yields batched vectors, and fails fast when no
// GGUF model path resolves. The native addon is never pulled — a fake loader is
// injected via setGgmlModuleLoaderForTests.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ggmlLocalModelInitializer,
	resetGgmlForTests,
	resolveGgufModelPath,
	setGgmlModuleLoaderForTests,
} from "../src/core/ggml-embedding";

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

	test("falls back to the sibling mnemopi/models directory", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-gguf-root-"));
		const modelsDir = path.join(root, "..", "models");
		await fs.mkdir(modelsDir, { recursive: true });
		const modelFile = path.join(modelsDir, "bge-base-en-v1.5-q4_k_m.gguf");
		await fs.writeFile(modelFile, "x");
		try {
			const before = process.env.MNEMOPI_EMBED_GGUF_PATH;
			delete process.env.MNEMOPI_EMBED_GGUF_PATH;
			try {
				// candidates are root and root/../models.
				expect(resolveGgufModelPath("fast-bge-base-en-v1.5", root)).toBe(modelFile);
			} finally {
				if (before !== undefined) process.env.MNEMOPI_EMBED_GGUF_PATH = before;
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
