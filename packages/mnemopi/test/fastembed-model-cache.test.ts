import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isFastembedModelCached } from "../src/core/fastembed-model-cache";

// The agent shows download activity whenever this reports false, so it must
// match fastembed@3's `<cacheDir>/<Qdrant repo>/` layout and its
// fetch-only-missing-files behavior.
describe("isFastembedModelCached", () => {
	const files = [
		"model.onnx",
		"model.onnx_data",
		"tokenizer.json",
		"tokenizer_config.json",
		"config.json",
		"special_tokens_map.json",
	];
	let cacheDir: string;

	beforeEach(async () => {
		cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-fastembed-"));
	});

	afterEach(async () => {
		await fs.rm(cacheDir, { recursive: true, force: true });
	});

	async function populate(dir: string, names: readonly string[]): Promise<void> {
		await Promise.all(names.map(name => Bun.write(path.join(cacheDir, dir, name), "x")));
	}

	it("reports a model cached only when every weight and tokenizer file is present", async () => {
		await populate("Qdrant_multilingual-e5-large-onnx", files);
		expect(await isFastembedModelCached("fast-multilingual-e5-large", cacheDir)).toBe(true);

		await fs.rm(path.join(cacheDir, "Qdrant_multilingual-e5-large-onnx", "model.onnx_data"));
		expect(await isFastembedModelCached("fast-multilingual-e5-large", cacheDir)).toBe(false);
	});

	it("ignores the fastembed@2 tarball layout keyed by model name", async () => {
		await populate("fast-multilingual-e5-large", files);
		expect(await isFastembedModelCached("fast-multilingual-e5-large", cacheDir)).toBe(false);
	});

	it("reports unknown models as not cached", async () => {
		expect(await isFastembedModelCached("custom", cacheDir)).toBe(false);
	});
});
