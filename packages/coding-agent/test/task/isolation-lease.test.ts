import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasLiveIsolationLease,
	ISOLATION_LEASE_DIR,
	leaseIsolationWorkspace,
	registerIsolationWorkspace,
} from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import { ISOLATION_OWNER_FILE, writeIsolationOwner } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";

const sandboxes: string[] = [];

/** A sandbox on disk: base dir, marker, and the `m` mount a user's cwd sits in. */
async function makeSandbox(): Promise<{ baseDir: string; mergedDir: string }> {
	const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lease-"));
	sandboxes.push(baseDir);
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await writeIsolationOwner(baseDir, "lease-test");
	return { baseDir, mergedDir };
}

afterEach(async () => {
	for (const dir of sandboxes.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("isolation workspace leases", () => {
	it("defers an owner's teardown until the last user has gone", async () => {
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir);
		try {
			const user = await leaseIsolationWorkspace(path.join(mergedDir, "nested"));
			expect(await hasLiveIsolationLease(baseDir)).toBe(true);

			let torndown = 0;
			expect(await deferTeardownWhileLeased(mergedDir, async () => void (torndown += 1))).toBe(true);
			expect(torndown).toBe(0);

			await user();
			expect(torndown).toBe(1);
			expect(await hasLiveIsolationLease(baseDir)).toBe(false);
		} finally {
			forgetIsolationWorkspace(mergedDir);
		}
	});

	it("counts a lease taken by another process, and drops one whose holder is gone", async () => {
		// The sandbox is not this process's: a session another process opened in
		// it has no local record to consult, which is why the lease is a file.
		const { baseDir, mergedDir } = await makeSandbox();
		const leaseDir = path.join(baseDir, ISOLATION_LEASE_DIR);
		const dead = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		await dead.exited;
		await Bun.write(path.join(leaseDir, "stale.json"), JSON.stringify({ pid: dead.pid }));
		await Bun.write(path.join(leaseDir, "live.json"), JSON.stringify({ pid: process.pid }));

		expect(await hasLiveIsolationLease(baseDir)).toBe(true);
		// The dead holder's lease is cleared on the way past; the live one stays.
		expect(await fs.readdir(leaseDir)).toEqual(["live.json"]);

		await fs.rm(path.join(leaseDir, "live.json"));
		expect(await hasLiveIsolationLease(baseDir)).toBe(false);
		expect(await deferTeardownWhileLeased(mergedDir, async () => {})).toBe(false);
	});

	it("takes no lease outside a sandbox", async () => {
		const plain = await fs.mkdtemp(path.join(os.tmpdir(), "omp-not-a-sandbox-"));
		sandboxes.push(plain);
		const release = await leaseIsolationWorkspace(plain);
		await release();
		expect(await Bun.file(path.join(plain, ISOLATION_OWNER_FILE)).exists()).toBe(false);
	});
});
