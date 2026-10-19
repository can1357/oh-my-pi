import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { modelDirDigest } from "../../bench/memory-eval/engines/mnemopi";
import { pythonPath } from "./python";

const DIGEST_PY = path.join(import.meta.dir, "../../bench/memory-eval/py/model_digest.py");

async function pythonDigest(dir: string): Promise<string> {
	const proc = Bun.spawn([pythonPath!, DIGEST_PY, dir], { stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(stderr);
	return stdout.trim();
}

// Mnemopi's JS fastembed keeps plain files; a Hugging Face snapshot (Python fastembed, Mnemosyne) holds symlinks to
// blobs. The same bytes must give the same digest either way, and any changed model or tokenizer byte a new one.
it.skipIf(pythonPath === undefined)(
	"digests the loaded model files identically in TS and Python, following symlinks",
	async () => {
		await using dir = await TempDir.create("@memory-eval-model-digest-");
		const plain = dir.join("plain");
		const snapshot = dir.join("snapshot");
		const blobs = dir.join("blobs");
		await Promise.all([fs.mkdir(plain), fs.mkdir(snapshot), fs.mkdir(blobs)]);
		for (const [name, bytes] of [
			["model_optimized.onnx", "onnx-weights"],
			["tokenizer.json", '{"vocab":1}'],
		]) {
			await Bun.write(path.join(plain, name), bytes);
			await Bun.write(path.join(blobs, name), bytes);
			await fs.symlink(path.join(blobs, name), path.join(snapshot, name));
		}
		const digest = await modelDirDigest(plain);
		expect(await pythonDigest(plain)).toBe(digest);
		expect(await modelDirDigest(snapshot)).toBe(digest);
		expect(await pythonDigest(snapshot)).toBe(digest);

		// Cache byproducts the runtime never loads, such as the healer's quarantined download, are not the model.
		await Bun.write(path.join(plain, "model_optimized.onnx.corrupt-1700000000000"), "broken-download");
		await Bun.write(path.join(plain, "model.onnx"), "an-alternate-export-this-model-never-loads");
		await Bun.write(path.join(plain, ".lock"), "");
		expect(await modelDirDigest(plain)).toBe(digest);
		expect(await pythonDigest(plain)).toBe(digest);

		await Bun.write(path.join(plain, "tokenizer.json"), '{"vocab":2}');
		const changed = await modelDirDigest(plain);
		expect(changed).not.toBe(digest);
		expect(await pythonDigest(plain)).toBe(changed);
	},
);
