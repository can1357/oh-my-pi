// Contract: defaultLocalModelInitializer retries FlagEmbedding.init EXACTLY
// once after a Protobuf-corruption failure (quarantining the cached file in
// between), and does not loop when the retry fails too.
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getFastembedCacheDir } from "@oh-my-pi/pi-utils";
import { defaultLocalModelInitializer, type LocalEmbeddingModel } from "../src/core/embeddings";
import * as runtime from "../src/core/fastembed-runtime";

async function corruptCache(): Promise<{ cacheDir: string; modelFile: string }> {
	const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-retry-"));
	const modelDir = path.join(cacheDir, "fast-bge-small-en-v1.5");
	await fs.mkdir(modelDir, { recursive: true });
	const modelFile = path.join(modelDir, "model_optimized.onnx");
	await fs.writeFile(modelFile, "garbage");
	return { cacheDir, modelFile };
}

const fakeModel = { embed: async () => [] } as unknown as LocalEmbeddingModel;

describe("defaultLocalModelInitializer corruption retry", () => {
	test("protobuf failure quarantines the file and retries init exactly once", async () => {
		const { cacheDir, modelFile } = await corruptCache();
		let initCalls = 0;
		const loadSpy = spyOn(runtime, "loadFastembed").mockResolvedValue({
			FlagEmbedding: {
				init: async () => {
					initCalls++;
					if (initCalls === 1) throw new Error(`Load model from ${modelFile} failed:Protobuf parsing failed.`);
					return fakeModel;
				},
			},
		} as never);
		try {
			const model = await defaultLocalModelInitializer({
				model: "fast-bge-small-en-v1.5" as never,
				cacheDir,
			});
			expect(model).toBe(fakeModel);
			expect(initCalls).toBe(2);
			const siblings = await fs.readdir(path.dirname(modelFile));
			expect(siblings.some(name => name.startsWith("model_optimized.onnx.corrupt-"))).toBe(true);
		} finally {
			loadSpy.mockRestore();
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});

	test("uses the shared default cache root when cacheDir is omitted", async () => {
		const cacheDir = getFastembedCacheDir();
		const modelFile = path.join(cacheDir, "missing-corrupt-model", "model_optimized.onnx");
		const observedCacheDirs: Array<string | undefined> = [];
		let initCalls = 0;
		const loadSpy = spyOn(runtime, "loadFastembed").mockResolvedValue({
			FlagEmbedding: {
				init: async (options: { cacheDir?: string }) => {
					observedCacheDirs.push(options.cacheDir);
					initCalls++;
					if (initCalls === 1) throw new Error(`Load model from ${modelFile} failed:Protobuf parsing failed.`);
					return fakeModel;
				},
			},
		} as never);
		try {
			const model = await defaultLocalModelInitializer({
				model: "fast-bge-small-en-v1.5" as never,
			});
			expect(model).toBe(fakeModel);
			expect(observedCacheDirs).toEqual([cacheDir, cacheDir]);
		} finally {
			loadSpy.mockRestore();
		}
	});

	test("a retry that fails again surfaces the error without looping", async () => {
		const { cacheDir, modelFile } = await corruptCache();
		let initCalls = 0;
		const loadSpy = spyOn(runtime, "loadFastembed").mockResolvedValue({
			FlagEmbedding: {
				init: async () => {
					initCalls++;
					throw new Error(`Load model from ${modelFile} failed:Protobuf parsing failed.`);
				},
			},
		} as never);
		try {
			await expect(
				defaultLocalModelInitializer({ model: "fast-bge-small-en-v1.5" as never, cacheDir }),
			).rejects.toThrow(/Protobuf parsing failed/);
			expect(initCalls).toBe(2);
		} finally {
			loadSpy.mockRestore();
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});
});
