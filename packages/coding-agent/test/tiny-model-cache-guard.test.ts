import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	captureTinyModelTempSnapshot,
	pruneAbandonedTinyModelTemps,
	pruneTinyModelAttemptTemps,
	withTinyModelDownloadLock,
} from "@pk-nerdsaver-ai/pi-coding-agent/tiny/cache-guard";

const tempRoots = new Set<string>();

async function makeCache(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompk-model-cache-guard-"));
	tempRoots.add(root);
	return root;
}

afterEach(async () => {
	await Promise.all(Array.from(tempRoots, root => fs.rm(root, { force: true, recursive: true })));
	tempRoots.clear();
});

describe("tiny-model cache guard", () => {
	it("removes abandoned Transformers partials while preserving completed and active files", async () => {
		const cacheDir = await makeCache();
		const repo = "onnx-community/LFM2-1.2B-ONNX";
		const modelDir = path.join(cacheDir, repo, "onnx");
		await fs.mkdir(modelDir, { recursive: true });
		const abandoned = path.join(modelDir, "model_q4.onnx_data.tmp.11111.dead");
		const active = path.join(modelDir, "model_q4.onnx_data.tmp.22222.live");
		const completed = path.join(modelDir, "model_q4.onnx_data");
		await Promise.all([Bun.write(abandoned, "partial"), Bun.write(active, "active"), Bun.write(completed, "model")]);

		const result = await pruneAbandonedTinyModelTemps(cacheDir, repo, {
			isProcessAlive: pid => pid === 22222,
		});

		expect(result).toEqual({
			removedFiles: 1,
			reclaimedBytes: 7,
			failedFiles: 0,
			skippedActiveFiles: 1,
		});
		expect(await Bun.file(abandoned).exists()).toBe(false);
		expect(await Bun.file(active).text()).toBe("active");
		expect(await Bun.file(completed).text()).toBe("model");
	});

	it("preserves an old partial while its owner PID is still alive", async () => {
		const cacheDir = await makeCache();
		const repo = "onnx-community/LFM2-1.2B-ONNX";
		const partial = path.join(cacheDir, repo, "onnx", "model_q4.onnx_data.tmp.22222.reused");
		await fs.mkdir(path.dirname(partial), { recursive: true });
		await Bun.write(partial, "stale");
		const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		await fs.utimes(partial, old, old);

		const result = await pruneAbandonedTinyModelTemps(cacheDir, repo, {
			isProcessAlive: () => true,
		});

		expect(result.removedFiles).toBe(0);
		expect(result.skippedActiveFiles).toBe(1);
		expect(await Bun.file(partial).text()).toBe("stale");
	});

	it("removes only current-PID partials created or changed by each failed retry", async () => {
		const cacheDir = await makeCache();
		const repo = "onnx-community/LFM2-1.2B-ONNX";
		const modelDir = path.join(cacheDir, repo, "onnx");
		const ownerPid = 31_337;
		const unchanged = path.join(modelDir, `model_q4.onnx_data.tmp.${ownerPid}.unchanged`);
		const changed = path.join(modelDir, `model_q4.onnx_data.tmp.${ownerPid}.changed`);
		const otherOwner = path.join(modelDir, "model_q4.onnx_data.tmp.42424.other");
		const completed = path.join(modelDir, "model_q4.onnx_data");
		await fs.mkdir(modelDir, { recursive: true });
		await Promise.all([
			Bun.write(unchanged, "keep"),
			Bun.write(changed, "before"),
			Bun.write(otherOwner, "other"),
			Bun.write(completed, "model"),
		]);

		const firstSnapshot = await captureTinyModelTempSnapshot(cacheDir, repo, ownerPid);
		const firstAttempt = path.join(modelDir, `model_q4.onnx_data.tmp.${ownerPid}.retry-1`);
		await Promise.all([Bun.write(changed, "changed during failed attempt"), Bun.write(firstAttempt, "partial one")]);
		const firstCleanup = await pruneTinyModelAttemptTemps(cacheDir, repo, firstSnapshot, ownerPid);

		expect(firstCleanup.removedFiles).toBe(2);
		expect(firstCleanup.failedFiles).toBe(0);
		expect(firstCleanup.skippedActiveFiles).toBe(1);
		expect(await Bun.file(unchanged).text()).toBe("keep");
		expect(await Bun.file(changed).exists()).toBe(false);
		expect(await Bun.file(firstAttempt).exists()).toBe(false);
		expect(await Bun.file(otherOwner).text()).toBe("other");
		expect(await Bun.file(completed).text()).toBe("model");

		const retrySnapshot = await captureTinyModelTempSnapshot(cacheDir, repo, ownerPid);
		const retryAttempt = path.join(modelDir, `model_q4.onnx_data.tmp.${ownerPid}.retry-2`);
		await Bun.write(retryAttempt, "partial two");
		const retryCleanup = await pruneTinyModelAttemptTemps(cacheDir, repo, retrySnapshot, ownerPid);

		expect(retryCleanup.removedFiles).toBe(1);
		expect(retryCleanup.skippedActiveFiles).toBe(1);
		expect(await Bun.file(retryAttempt).exists()).toBe(false);
		expect(await Bun.file(unchanged).text()).toBe("keep");
	});

	it("serializes concurrent cache fills for the same repository", async () => {
		const cacheDir = await makeCache();
		const repo = "onnx-community/LFM2-1.2B-ONNX";
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const order: string[] = [];
		const lockOptions = { staleMs: 10_000, retries: 100, retryDelayMs: 5 };

		const first = withTinyModelDownloadLock(
			cacheDir,
			repo,
			async () => {
				order.push("first:start");
				firstStarted.resolve();
				await releaseFirst.promise;
				order.push("first:end");
			},
			lockOptions,
		);
		await firstStarted.promise;
		const second = withTinyModelDownloadLock(
			cacheDir,
			repo,
			async () => {
				order.push("second:start");
			},
			lockOptions,
		);
		await Bun.sleep(30);
		expect(order).toEqual(["first:start"]);

		releaseFirst.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second:start"]);
	});

	it("rejects repository paths that escape the cache root", async () => {
		const cacheDir = await makeCache();
		await expect(withTinyModelDownloadLock(cacheDir, "../outside", async () => undefined)).rejects.toThrow(
			"escapes its cache root",
		);
	});
});
