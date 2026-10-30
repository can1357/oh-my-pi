import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import {
	armTeardown,
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasLiveIsolationLease,
	hasUnfinishedWriter,
	ISOLATION_UNFINISHED_DIR,
	ISOLATION_LEASE_DIR,
	leaseIsolationWorkspace,
	markUnfinishedWriter,
	registerIsolationWorkspace,
} from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import {
	ISOLATION_OWNER_FILE,
	resolveSandboxIdentity,
	writeIsolationOwner,
} from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";

const temporary: string[] = [];
const registered: string[] = [];

/** A sandbox on disk: base dir, marker, and the `m` mount a user's cwd sits in. */
async function makeSandbox(agentId = "lease-test"): Promise<{ baseDir: string; mergedDir: string }> {
	const baseDir = await resolveSandboxIdentity(await fs.mkdtemp(path.join(os.tmpdir(), "omp-lease-")));
	temporary.push(baseDir);
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await writeIsolationOwner(baseDir, agentId);
	registered.push(mergedDir);
	return { baseDir, mergedDir };
}

/** A pid that is certainly not running. */
async function deadPid(): Promise<number> {
	const process_ = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
	await process_.exited;
	return process_.pid;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const mergedDir of registered.splice(0)) forgetIsolationWorkspace(mergedDir);
	for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("isolation workspace leases", () => {
	it("defers an owner's teardown until the last user has gone", async () => {
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir, { baseDir, generation: "gen-1" });
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

	it("runs the owner's teardown when a lease held by another process goes away", async () => {
		// A user in another process departs — or is killed — without telling
		// this one, so the owner's deferred teardown cannot wait on a callback
		// that only its own release would fire.
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir, { baseDir, generation: "gen-1" });
		try {
			const foreign = path.join(baseDir, ISOLATION_LEASE_DIR, "foreign.json");
			await Bun.write(foreign, JSON.stringify({ pid: process.pid }));

			let torndown = 0;
			expect(await deferTeardownWhileLeased(mergedDir, async () => void (torndown += 1))).toBe(true);

			await fs.rm(foreign);
			for (let waited = 0; waited < 40 && torndown === 0; waited += 1) await scheduler.wait(100);
			expect(torndown).toBe(1);
		} finally {
			forgetIsolationWorkspace(mergedDir);
		}
	});

	it("treats a lease directory it cannot list as held", async () => {
		// A read error is not evidence that nobody is in there, and the caller
		// of this is about to delete the directory.
		const { baseDir } = await makeSandbox();
		await fs.mkdir(path.join(baseDir, ISOLATION_LEASE_DIR), { recursive: true });
		vi.spyOn(fs, "readdir").mockImplementation(async target => {
			if (String(target).endsWith(ISOLATION_LEASE_DIR)) throw Object.assign(new Error("EIO"), { code: "EIO" });
			return [];
		});

		expect(await hasLiveIsolationLease(baseDir)).toBe(true);
	});

	it("fails the grant when the lease cannot be recorded", async () => {
		// A caller told it holds a lease arranges its life around that. A
		// silent no-op is how a live child's workspace gets deleted under it.
		const { mergedDir } = await makeSandbox();
		const write = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation((destination, input, options) =>
			String(destination).includes(ISOLATION_LEASE_DIR)
				? Promise.reject(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }))
				: write(destination as Parameters<typeof write>[0], input as Parameters<typeof write>[1], options),
		);

		await expect(leaseIsolationWorkspace(mergedDir)).rejects.toThrow("ENOSPC");
	});

	it("registers the owner's teardown before it asks whether anybody is here", async () => {
		// A check that finds no users and registers nothing leaves a user
		// admitted a moment later with no teardown to run on its way out: it is
		// protected from deletion and its work is never captured.
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir, { baseDir, generation: "gen-1" });
		let torndown = 0;
		const teardown = async (): Promise<void> => void (torndown += 1);

		// Nobody here: the caller is told to proceed, and nothing is left armed.
		expect(await deferTeardownWhileLeased(mergedDir, teardown)).toBe(false);

		// A user admitted after that answer still finds a teardown when it goes,
		// because the next decision registers before it asks.
		const late = await leaseIsolationWorkspace(path.join(mergedDir, "late"));
		expect(await deferTeardownWhileLeased(mergedDir, teardown)).toBe(true);
		expect(torndown).toBe(0);
		await late();
		expect(torndown).toBe(1);
	});

	it("awaits the work when two parties notice the same departure", async () => {
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir, { baseDir, generation: "gen-1" });
		let started = 0;
		let finished = 0;
		const user = await leaseIsolationWorkspace(mergedDir);
		expect(
			await deferTeardownWhileLeased(mergedDir, async () => {
				started += 1;
				await scheduler.wait(50);
				finished += 1;
			}),
		).toBe(true);

		// The watch fires on the removal while the release is still deciding;
		// both must come back with the work done, not merely started.
		await user();
		expect(started).toBe(1);
		expect(finished).toBe(1);
	});

	it("keeps one writer's record from speaking for another, and clears each when it finishes", async () => {
		// Two writers overwrote each other, and the single record left naming
		// the one that had exited let a destructive path delete the other's
		// live data.
		const { baseDir, mergedDir } = await makeSandbox();
		expect(await hasUnfinishedWriter(baseDir)).toBe(false);

		const first = await markUnfinishedWriter(path.join(mergedDir, "deep"));
		const second = await markUnfinishedWriter(mergedDir);
		expect(await hasUnfinishedWriter(baseDir)).toBe(true);

		await second();
		expect(await hasUnfinishedWriter(baseDir)).toBe(true);

		// A record nobody ever clears is a workspace nobody ever reclaims.
		await first();
		expect(await hasUnfinishedWriter(baseDir)).toBe(false);
	});

	it("retires an unfinished-writer record whose process is gone", async () => {
		const { baseDir } = await makeSandbox();
		await Bun.write(
			path.join(baseDir, ISOLATION_UNFINISHED_DIR, "dead.json"),
			JSON.stringify({ pid: await deadPid() }),
		);
		expect(await hasUnfinishedWriter(baseDir)).toBe(false);
	});

	it("keeps the owner's registration through an unlocked window", async () => {
		// `armTeardown` is for a caller that holds no lock: withdrawing the
		// registration on "nobody is here" and only then committing the cleanup
		// is the window a user is admitted in.
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir, { baseDir, generation: "gen-1" });
		let captured = 0;
		armTeardown(mergedDir, async () => void (captured += 1), { generation: "gen-1" });

		const late = await leaseIsolationWorkspace(path.join(mergedDir, "late"));
		expect(await deferTeardownWhileLeased(mergedDir, async () => {}, { generation: "gen-1" })).toBe(true);
		await late();

		// The capture armed before the window is the one that ran, not the
		// plain cleanup that followed it.
		expect(captured).toBe(1);
	});

	it("counts a lease taken by another process, and drops one whose holder is gone", async () => {
		const { baseDir, mergedDir } = await makeSandbox();
		const leaseDir = path.join(baseDir, ISOLATION_LEASE_DIR);
		await Bun.write(path.join(leaseDir, "stale.json"), JSON.stringify({ pid: await deadPid() }));
		await Bun.write(path.join(leaseDir, "live.json"), JSON.stringify({ pid: process.pid }));

		expect(await hasLiveIsolationLease(baseDir)).toBe(true);
		expect(await fs.readdir(leaseDir)).toEqual(["live.json"]);

		await fs.rm(path.join(leaseDir, "live.json"));
		expect(await hasLiveIsolationLease(baseDir)).toBe(false);
		expect(await deferTeardownWhileLeased(mergedDir, async () => {})).toBe(false);
	});

	it("ignores the owning run's own session lease", async () => {
		// The owner's child session has the sandbox as its cwd. It is part of
		// the run, not a later user of its workspace, so it must not stop its
		// own run's capture.
		const { baseDir, mergedDir } = await makeSandbox("Owner-1");
		registerIsolationWorkspace(mergedDir, { baseDir, generation: "gen-1", agentId: "Owner-1" });
		try {
			const own = await leaseIsolationWorkspace(mergedDir, { agentId: "Owner-1" });
			expect(await hasLiveIsolationLease(baseDir, "Owner-1")).toBe(false);
			expect(await hasLiveIsolationLease(baseDir)).toBe(true);

			const nested = await leaseIsolationWorkspace(mergedDir, { agentId: "Nested-2" });
			expect(await hasLiveIsolationLease(baseDir, "Owner-1")).toBe(true);
			await nested();
			await own();
		} finally {
			forgetIsolationWorkspace(mergedDir);
		}
	});

	it("finds the sandbox behind a symlinked cwd, and leases nothing under a malformed marker", async () => {
		const { baseDir, mergedDir } = await makeSandbox();
		const alias = path.join(path.dirname(baseDir), `${path.basename(baseDir)}-alias`);
		await fs.symlink(baseDir, alias);
		temporary.push(alias);

		const viaAlias = await leaseIsolationWorkspace(path.join(alias, "m"));
		expect(await hasLiveIsolationLease(baseDir)).toBe(true);
		await viaAlias();
		expect(await hasLiveIsolationLease(baseDir)).toBe(false);

		// A marker that is here and cannot be read is unknown, not absent: the
		// caller is refused rather than handed a successful no-op it would
		// treat as protection.
		const plain = await fs.mkdtemp(path.join(os.tmpdir(), "omp-not-a-sandbox-"));
		temporary.push(plain);
		await fs.mkdir(path.join(plain, "m"));
		await Bun.write(path.join(plain, ISOLATION_OWNER_FILE), "{ not json");
		await expect(leaseIsolationWorkspace(path.join(plain, "m"))).rejects.toThrow("unreadable owner marker");
		expect(await fs.readdir(plain)).not.toContain(ISOLATION_LEASE_DIR);

		// A directory named `m` with no marker at all is simply not a sandbox.
		const bare = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bare-m-"));
		temporary.push(bare);
		await fs.mkdir(path.join(bare, "m"));
		await (
			await leaseIsolationWorkspace(path.join(bare, "m"))
		)();
		expect(await fs.readdir(bare)).not.toContain(ISOLATION_LEASE_DIR);

		expect(mergedDir).toContain(baseDir);
	});

	it("keeps a newer materialisation's deferred teardown when an older one finishes", async () => {
		// Forget is keyed by generation: an old teardown completing must not
		// drop the record — and the pending teardown — of the materialisation
		// that replaced it.
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir, { baseDir, generation: "gen-1" });
		registerIsolationWorkspace(mergedDir, { baseDir, generation: "gen-2" });
		try {
			const user = await leaseIsolationWorkspace(mergedDir);
			let torndown = 0;
			expect(
				await deferTeardownWhileLeased(mergedDir, async () => void (torndown += 1), { generation: "gen-2" }),
			).toBe(true);

			forgetIsolationWorkspace(mergedDir, "gen-1");

			await user();
			expect(torndown).toBe(1);
		} finally {
			forgetIsolationWorkspace(mergedDir);
		}
	});
});
