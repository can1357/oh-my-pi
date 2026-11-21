import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import { WriteTool } from "../src/tools/write";
import * as piUtils from "@oh-my-pi/pi-utils";
import { readArchiveEntries, writeArchive } from "@oh-my-pi/pi-utils/ar";

const workerScript = path.join(import.meta.dir, "fixtures", "archive-write-worker.ts");
const padding = "x".repeat(8 * 1024 * 1024);
let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-archive-write-race-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

async function assertBothMembers(archive: string): Promise<void> {
	const entries = await readArchiveEntries({ path: archive, format: "tar" });
	for (const name of ["a", "b"]) {
		const member = entries.get(`${name}.txt`);
		expect(member).toBeDefined();
		expect(await new Response(member).text()).toBe(`new ${name}`);
	}
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => cwd,
		allocateOutputArtifact: async () => ({ id: "1", path: path.join(cwd, "output.log") }),
	};
}

async function runIndependentWriters(aPath: string, bPath: string): Promise<void> {
	const workers = [
		Bun.spawn([process.execPath, workerScript, aPath, "a"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
		Bun.spawn([process.execPath, workerScript, bPath, "b"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
	];
	try {
		const readers = workers.map(worker => worker.stdout.getReader());
		await Promise.all(
			readers.map(async reader => {
				const first = await reader.read();
				expect(new TextDecoder().decode(first.value)).toBe("ready\n");
			}),
		);
		for (const worker of workers) {
			worker.stdin.write("go\n");
			worker.stdin.end();
		}
		for (const [index, worker] of workers.entries()) {
			const output = (async () => {
				let text = "";
				const reader = readers[index]!;
				for (let next = await reader.read(); !next.done; next = await reader.read()) {
					text += new TextDecoder().decode(next.value);
				}
				return text;
			})();
			const [exit, stdout, error] = await Promise.all([worker.exited, output, new Response(worker.stderr).text()]);
			expect({ exit, stdout, error }).toEqual({ exit: 0, stdout: "success\n", error: "" });
		}
	} finally {
		for (const worker of workers) worker.kill();
		await Promise.all(workers.map(worker => worker.exited));
	}
}

describe("concurrent archive member writes", () => {
	it("preserves both successful updates across independent processes", async () => {
		const archive = path.join(root, "bundle.tar");
		await writeArchive(archive, "tar", [
			["a.txt", "old a"],
			["b.txt", "old b"],
			["padding", padding],
		]);
		await runIndependentWriters(archive, archive);
		await assertBothMembers(archive);
	});

	it("preserves both updates when the archive did not exist", async () => {
		const archive = path.join(root, "new", "bundle.tar");
		await runIndependentWriters(archive, archive);
		await assertBothMembers(archive);
	});

	it.skipIf(process.platform === "win32")("shares the lock through a directory symlink", async () => {
		const archive = path.join(root, "bundle.tar");
		const alias = path.join(root, "alias");
		await writeArchive(archive, "tar", [
			["a.txt", "old a"],
			["b.txt", "old b"],
			["padding", padding],
		]);
		await fs.symlink(root, alias, "dir");
		await runIndependentWriters(archive, path.join(alias, "bundle.tar"));
		await assertBothMembers(archive);
	});

	it("serializes distinct WriteTool instances in one process", async () => {
		const archive = path.join(root, "bundle.tar");
		await writeArchive(archive, "tar", [
			["a.txt", "old a"],
			["b.txt", "old b"],
			["padding", padding],
		]);
		const session = createSession(root);
		await Promise.all([
			new WriteTool(session).execute("a", { path: `${archive}:a.txt`, content: "new a" }),
			new WriteTool(session).execute("b", { path: `${archive}:b.txt`, content: "new b" }),
		]);
		await assertBothMembers(archive);
	});
	it("does not publish a canceled write after a contended lock is released", async () => {
		const archive = path.join(root, "bundle.tar");
		await writeArchive(archive, "tar", [["a.txt", "original"]]);
		const lock = await piUtils.acquireFileLock(archive);
		const entered = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		const withFileLock = piUtils.withFileLock;
		vi.spyOn(piUtils, "withFileLock").mockImplementation(async (filePath, fn, options) => {
			entered.resolve();
			try {
				return await withFileLock(filePath, fn, options);
			} finally {
				finished.resolve();
			}
		});
		try {
			const controller = new AbortController();
			const pending = new WriteTool(createSession(root)).execute(
				"canceled",
				{ path: `${archive}:a.txt`, content: "canceled" },
				controller.signal,
			);
			await entered.promise;
			controller.abort();
			await expect(pending).rejects.toThrow();
		} finally {
			lock.release();
		}
		// The real lock attempt must settle before checking disk: untilAborted
		// rejects its caller before an uncanceled waiter would stop running.
		await finished.promise;
		const entries = await readArchiveEntries({ path: archive, format: "tar" });
		expect(await new Response(entries.get("a.txt")).text()).toBe("original");
	});
});
