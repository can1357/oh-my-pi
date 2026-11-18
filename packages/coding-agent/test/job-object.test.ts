import { describe, expect, test } from "bun:test";
import { WindowsJob } from "../src/launch/job-object";

const isWindows = process.platform === "win32";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function spawnDetached() {
	return Bun.spawn(["cmd", "/c", "ping", "-n", "30", "127.0.0.1"], {
		stdout: "ignore",
		stderr: "ignore",
		detached: true,
	});
}

function cleanup(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* already dead */
	}
}

describe.skipIf(!isWindows)("WindowsJob", () => {
	test("closing the job kills an assigned detached process", async () => {
		const job = WindowsJob.create();
		expect(job).toBeDefined();
		const proc = spawnDetached();
		const assigned = job!.assign(proc.pid);
		expect(assigned.ok).toBe(true);
		job!.close();
		await proc.exited;
		expect(isAlive(proc.pid)).toBe(false);
	});

	test("closing the job leaves unassigned processes alone", async () => {
		const job = WindowsJob.create();
		expect(job).toBeDefined();
		const proc = spawnDetached();
		try {
			// CloseHandle is synchronous: any collateral kill would already have happened.
			job!.close();
			expect(isAlive(proc.pid)).toBe(true);
		} finally {
			cleanup(proc.pid);
			await proc.exited;
		}
	});

	test("close is idempotent and assign after close fails", () => {
		const job = WindowsJob.create();
		expect(job).toBeDefined();
		job!.close();
		job!.close();
		const proc = spawnDetached();
		try {
			expect(job!.assign(proc.pid).ok).toBe(false);
		} finally {
			cleanup(proc.pid);
		}
	});
});
