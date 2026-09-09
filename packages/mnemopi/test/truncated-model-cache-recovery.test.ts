// Contract: an interrupted fastembed download leaves a partial model dir
// (`<cacheDir>/<model>/` populated with sidecars + a truncated
// `model.onnx_data` but WITHOUT the graph file), which upstream `retrieveModel`
// treats as complete forever. `FlagEmbedding.init` then throws
// `Model file not found at .../model.onnx` every session. `clearIncompleteModelCache`
// deletes the incomplete dir AND the leftover partial `<model>.tar.gz` so the
// retry re-downloads cleanly, and `defaultLocalModelInitializer` retries init
// exactly once — no loop.
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearIncompleteModelCache,
	defaultLocalModelInitializer,
	type LocalEmbeddingModel,
} from "../src/core/embeddings";
import * as runtime from "../src/core/fastembed-runtime";

const MODEL = "fast-multilingual-e5-large";

/** Build a partially-extracted cache: sidecars + truncated data, no `model.onnx`, leftover `.tar.gz`. */
async function partialCache(): Promise<{ cacheDir: string; modelDir: string; tarGz: string; modelFile: string }> {
	const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-truncated-"));
	const modelDir = path.join(cacheDir, MODEL);
	await fs.mkdir(modelDir, { recursive: true });
	await fs.writeFile(path.join(modelDir, "config.json"), "{}");
	await fs.writeFile(path.join(modelDir, "tokenizer.json"), "{}");
	await fs.writeFile(path.join(modelDir, "model.onnx_data"), "truncated");
	const tarGz = path.join(cacheDir, `${MODEL}.tar.gz`);
	await fs.writeFile(tarGz, "partial archive");
	return { cacheDir, modelDir, tarGz, modelFile: path.join(modelDir, "model.onnx") };
}

const fakeModel = { embed: async () => [] } as unknown as LocalEmbeddingModel;

describe("truncated fastembed model cache recovery", () => {
	test("missing model file clears the incomplete cache and retries init exactly once", async () => {
		const { cacheDir, modelDir, tarGz, modelFile } = await partialCache();
		let initCalls = 0;
		const loadSpy = spyOn(runtime, "loadFastembed").mockResolvedValue({
			FlagEmbedding: {
				init: async () => {
					initCalls++;
					if (initCalls === 1) throw new Error(`Model file not found at ${modelFile}`);
					return fakeModel;
				},
			},
		} as never);
		try {
			const model = await defaultLocalModelInitializer({ model: MODEL as never, cacheDir });
			expect(model).toBe(fakeModel);
			expect(initCalls).toBe(2);
			// Incomplete dir and leftover partial archive both cleared for a clean re-download.
			await expect(fs.access(modelDir)).rejects.toThrow();
			await expect(fs.access(tarGz)).rejects.toThrow();
		} finally {
			loadSpy.mockRestore();
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});

	test("a retry that still cannot find the model surfaces the error without looping", async () => {
		const { cacheDir, modelDir, tarGz, modelFile } = await partialCache();
		let initCalls = 0;
		const loadSpy = spyOn(runtime, "loadFastembed").mockResolvedValue({
			FlagEmbedding: {
				init: async () => {
					initCalls++;
					throw new Error(`Model file not found at ${modelFile}`);
				},
			},
		} as never);
		try {
			await expect(defaultLocalModelInitializer({ model: MODEL as never, cacheDir })).rejects.toThrow(
				/Model file not found/,
			);
			expect(initCalls).toBe(2);
			// Cache still cleared so the NEXT session re-downloads from scratch.
			await expect(fs.access(modelDir)).rejects.toThrow();
			await expect(fs.access(tarGz)).rejects.toThrow();
		} finally {
			loadSpy.mockRestore();
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});
});

describe("clearIncompleteModelCache", () => {
	test("removes the incomplete model dir and its partial archive", async () => {
		const { cacheDir, modelDir, tarGz, modelFile } = await partialCache();
		try {
			const cleared = await clearIncompleteModelCache(`Model file not found at ${modelFile}`, cacheDir);
			expect(cleared).toBe(true);
			await expect(fs.access(modelDir)).rejects.toThrow();
			await expect(fs.access(tarGz)).rejects.toThrow();
		} finally {
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});

	test("ignores unrelated init errors (protobuf corruption is handled elsewhere)", async () => {
		const { cacheDir, modelDir, modelFile } = await partialCache();
		try {
			const cleared = await clearIncompleteModelCache(
				`Load model from ${modelFile} failed:Protobuf parsing failed.`,
				cacheDir,
			);
			expect(cleared).toBe(false);
			expect(await fs.access(modelDir).then(() => true)).toBe(true);
		} finally {
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});

	test("refuses to remove a dir OUTSIDE the fastembed cache root", async () => {
		const { cacheDir, modelDir, modelFile } = await partialCache();
		const foreignRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-foreign-"));
		try {
			// modelFile lives under cacheDir, but we pass a different cache root: containment must reject.
			const cleared = await clearIncompleteModelCache(`Model file not found at ${modelFile}`, foreignRoot);
			expect(cleared).toBe(false);
			expect(await fs.access(modelDir).then(() => true)).toBe(true);
		} finally {
			await fs.rm(cacheDir, { recursive: true, force: true });
			await fs.rm(foreignRoot, { recursive: true, force: true });
		}
	});
});
