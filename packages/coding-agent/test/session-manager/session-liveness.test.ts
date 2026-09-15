import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inspectSessionLiveness } from "@oh-my-pi/pi-coding-agent/session/session-liveness";
import { FileLock } from "@oh-my-pi/pi-natives";
import { __internalsForTesting } from "@oh-my-pi/pi-utils/file-lock";
import { holdFileOpen } from "../helpers/open-file-holder";

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-liveness-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function makeFile(name = "session.jsonl"): Promise<string> {
	const file = path.join(root, name);
	await Bun.write(file, "session\n");
	return file;
}

function expectedProcIdentity(dev: number, ino: number): string {
	const device = BigInt(dev);
	const major = ((device / 256n) % 4096n) | ((device / 4294967296n) & 0xfffff000n);
	const minor = (device % 256n) | ((device / 4096n) & 0xffffff00n);
	return `${major.toString(16).padStart(2, "0")}:${minor.toString(16).padStart(2, "0")}:${ino}`;
}

describe("inspectSessionLiveness", () => {
	test("an old file with no holder is not live", async () => {
		const file = await makeFile();
		const old = new Date(Date.now() - 60 * 60_000);
		await fs.utimes(file, old, old);

		const result = await inspectSessionLiveness(file);

		expect(result.live).toBe(false);
		expect(result.signals).toEqual([]);
		expect(result.holders).toEqual([]);
		expect(result.secondsSinceWrite).toBeGreaterThan(3500);
	});

	test("detects this process and a foreign open handle while filtering its own pid", async () => {
		const file = await makeFile();
		const ownHandle = await fs.open(file, "r");
		try {
			const selfResult = await inspectSessionLiveness(file);
			// Seeing our own fd still fires the conservative OS signal, but the gc
			// process is deliberately not presented as an external holder.
			expect(selfResult.signals).toContain("open-handle");
			expect(selfResult.holders.some(holder => holder.pid === process.pid)).toBe(false);

			const child = await holdFileOpen(file);
			try {
				const result = await inspectSessionLiveness(file);
				expect(result.signals).toContain("open-handle");
				expect(result.holders).toContainEqual({ pid: child.pid, command: expect.any(String) });
				expect(result.holders.some(holder => holder.pid === process.pid)).toBe(false);
			} finally {
				await child.close();
			}
		} finally {
			await ownHandle.close();
		}
	});

	test("detects the repository advisory lock", async () => {
		const file = await makeFile();
		const lock = FileLock.tryAcquire(__internalsForTesting.getLockPath(file));
		expect(lock.acquired).toBe(true);
		try {
			const result = await inspectSessionLiveness(file);
			expect(result.live).toBe(true);
			expect(result.signals).toContain("advisory-lock");
		} finally {
			lock.release();
		}
	});

	test("matches proc locks by the file device and inode", async () => {
		const file = await makeFile();
		const stat = await fs.stat(file);
		const procRoot = path.join(root, "proc");
		const fakePid = 424242;
		await fs.mkdir(path.join(procRoot, String(fakePid)), { recursive: true });
		await Bun.write(path.join(procRoot, String(fakePid), "comm"), "future-omp\n");
		await Bun.write(
			path.join(procRoot, "locks"),
			`1: POSIX  ADVISORY  WRITE ${fakePid} ${expectedProcIdentity(stat.dev, stat.ino)} 0 EOF\n`,
		);

		const result = await inspectSessionLiveness(file, { procRoot });

		expect(result.signals).toContain("posix-lock");
		expect(result.holders).toContainEqual({ pid: fakePid, command: "future-omp" });
	});

	test("a missing path degrades without throwing or claiming liveness", async () => {
		const result = await inspectSessionLiveness(path.join(root, "missing.jsonl"));

		expect(result.live).toBe(false);
		expect(result.signals).toEqual([]);
		expect(result.secondsSinceWrite).toBeUndefined();
		expect(result.degraded.some(reason => reason.includes("could not stat"))).toBe(true);
	});

	test("unavailable proc checks degrade independently", async () => {
		const file = await makeFile();
		const missingProc = path.join(root, "missing-proc");

		const result = await inspectSessionLiveness(file, { procRoot: missingProc });

		expect(result.live).toBe(false);
		expect(result.degraded.some(reason => reason.includes("open-handle"))).toBe(true);
		expect(result.degraded.some(reason => reason.includes("posix-lock"))).toBe(true);
	});
});
