import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

/** Queue two operations on the given paths; the first blocks until released. Returns the observed event order. */
async function runBlockedPair(first: string, second: string): Promise<{ beforeRelease: string[]; final: string[] }> {
	const events: string[] = [];
	const gate = Promise.withResolvers<void>();
	const op1 = withFileMutationQueue(first, async () => {
		events.push("start:op1");
		await gate.promise;
		events.push("end:op1");
	});
	const op2 = withFileMutationQueue(second, async () => {
		events.push("start:op2");
		events.push("end:op2");
	});
	// Yield one macrotask so every runnable queued operation gets a chance to start.
	await new Promise<void>(resolve => setImmediate(resolve));
	const beforeRelease = [...events];
	gate.resolve();
	await Promise.all([op1, op2]);
	return { beforeRelease, final: events };
}

describe("legacy shim withFileMutationQueue export", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-file-mutation-queue-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("serializes concurrent operations targeting the same file", async () => {
		const targetFile = path.join(tmpDir, "same.txt");
		const { beforeRelease, final } = await runBlockedPair(targetFile, targetFile);
		expect(beforeRelease).toEqual(["start:op1"]);
		expect(final).toEqual(["start:op1", "end:op1", "start:op2", "end:op2"]);
	});

	it("returns each operation's result in order", async () => {
		const targetFile = path.join(tmpDir, "results.txt");
		const results = await Promise.all([
			withFileMutationQueue(targetFile, async () => 1),
			withFileMutationQueue(targetFile, async () => 2),
		]);
		expect(results).toEqual([1, 2]);
	});

	it("runs operations on different files concurrently", async () => {
		const events: string[] = [];
		const gate = Promise.withResolvers<void>();
		const opA = withFileMutationQueue(path.join(tmpDir, "file-a.txt"), async () => {
			events.push("start:opA");
			await gate.promise;
			events.push("end:opA");
			return "A";
		});
		const opB = withFileMutationQueue(path.join(tmpDir, "file-b.txt"), async () => {
			events.push("start:opB");
			events.push("end:opB");
			return "B";
		});

		// opB must complete while opA is still blocked; a shared queue would deadlock here.
		expect(await opB).toBe("B");
		expect(events).toEqual(["start:opA", "start:opB", "end:opB"]);
		gate.resolve();
		expect(await opA).toBe("A");
	});

	it("does not deadlock subsequent operations when an earlier operation throws", async () => {
		const targetFile = path.join(tmpDir, "throw.txt");
		const events: string[] = [];
		const gate = Promise.withResolvers<void>();

		const op1 = withFileMutationQueue(targetFile, async () => {
			events.push("start:op1");
			await gate.promise;
			events.push("throw:op1");
			throw new Error("mutation error in op1");
		});
		const op2 = withFileMutationQueue(targetFile, async () => {
			events.push("start:op2");
			return "recovered";
		});

		await new Promise<void>(resolve => setImmediate(resolve));
		expect(events).toEqual(["start:op1"]);
		gate.resolve();
		await expect(op1).rejects.toThrow("mutation error in op1");
		expect(await op2).toBe("recovered");
		expect(events).toEqual(["start:op1", "throw:op1", "start:op2"]);
	});

	it("serializes existing and uncreated files reached through directory symlinks", async () => {
		const realDir = path.join(tmpDir, "real");
		const linkDir = path.join(tmpDir, "link");
		await fs.mkdir(realDir, { recursive: true });

		try {
			await fs.symlink(realDir, linkDir, "dir");
		} catch {
			return;
		}

		const realExisting = path.join(realDir, "existing.txt");
		await fs.writeFile(realExisting, "hello", "utf-8");
		const existing = await runBlockedPair(realExisting, path.join(linkDir, "existing.txt"));
		expect(existing.beforeRelease).toEqual(["start:op1"]);
		expect(existing.final).toEqual(["start:op1", "end:op1", "start:op2", "end:op2"]);

		const uncreated = await runBlockedPair(path.join(linkDir, "new-file.txt"), path.join(realDir, "new-file.txt"));
		expect(uncreated.beforeRelease).toEqual(["start:op1"]);
		expect(uncreated.final).toEqual(["start:op1", "end:op1", "start:op2", "end:op2"]);
	});
});
