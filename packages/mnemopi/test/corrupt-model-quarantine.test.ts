// Contract: a "Protobuf parsing failed" init error quarantines EXACTLY the
// model file named in the message (atomic rename to *.corrupt-<ts>) and
// reports retry-safety; unrelated init errors never touch the filesystem.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { quarantineCorruptModelFile } from "../src/core/embeddings";

async function tempModelFile(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-quarantine-"));
	const file = path.join(dir, "model_optimized.onnx");
	await fs.writeFile(file, "not a protobuf");
	return file;
}

/** The helper only honors paths inside the given cache root. */
function cacheRootOf(file: string): string {
	return path.dirname(path.dirname(file));
}

describe("quarantineCorruptModelFile", () => {
	test("renames the exact file named by a protobuf failure and allows retry", async () => {
		const file = await tempModelFile();
		const healed = await quarantineCorruptModelFile(
			`Load model from ${file} failed:Protobuf parsing failed.`,
			cacheRootOf(file),
		);
		expect(healed).toBe(true);
		// Original gone, quarantined copy present.
		await expect(fs.access(file)).rejects.toThrow();
		const siblings = await fs.readdir(path.dirname(file));
		expect(siblings.some(name => name.startsWith("model_optimized.onnx.corrupt-"))).toBe(true);
		await fs.rm(path.dirname(file), { recursive: true, force: true });
	});

	test("does not treat unrelated init errors as corruption", async () => {
		const file = await tempModelFile();
		const healed = await quarantineCorruptModelFile(`Model file not found at ${file}`, cacheRootOf(file));
		expect(healed).toBe(false);
		// Untouched: no rename happened.
		expect(await fs.access(file).then(() => true)).toBe(true);
		await fs.rm(path.dirname(file), { recursive: true, force: true });
	});

	test("a missing file (concurrent heal) still reports retry-safe", async () => {
		const ghost = path.join(os.tmpdir(), `mnemopi-ghost-${Date.now()}`, "model_optimized.onnx");
		const healed = await quarantineCorruptModelFile(
			`Load model from ${ghost} failed:Protobuf parsing failed.`,
			path.dirname(path.dirname(ghost)),
		);
		expect(healed).toBe(true);
	});

	test("refuses to touch a file OUTSIDE the fastembed cache directory", async () => {
		const file = await tempModelFile();
		// Cache root that does NOT contain the file: containment must reject.
		const foreignRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mnemopi-foreign-"));
		const healed = await quarantineCorruptModelFile(
			`Load model from ${file} failed:Protobuf parsing failed.`,
			foreignRoot,
		);
		expect(healed).toBe(false);
		expect(await fs.access(file).then(() => true)).toBe(true);
		await fs.rm(path.dirname(file), { recursive: true, force: true });
		await fs.rm(foreignRoot, { recursive: true, force: true });
	});
});
