import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import * as natives from "@oh-my-pi/pi-natives";
import { clearWorktrees, listWorktrees, type WorktreeEntry } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import * as isolationFs from "@oh-my-pi/pi-coding-agent/task/isolation-fs";
import { ISOLATION_LEASE_DIR } from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import {
	ISOLATION_OWNER_FILE,
	markIsolationRetired,
	markIsolationRetiring,
	RETAINED_BACKEND_FILE,
	writeIsolationOwner,
	writeRetainedBackend,
} from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { cleanupIsolation, ensureIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

/** Directories this file made, removed after each test. */
const temporary: string[] = [];

/** The real `stat`, kept before any spy replaces it. */
const realStat = fs.stat;

/**
 * Regression for #6761: `omp worktree clear` (no `--all`) must delete only
 * task-isolation sandboxes whose owner process is gone. A sandbox owned by a
 * live omp process holds a running subagent's uncaptured work and must survive.
 */
describe("worktree clear task-isolation ownership", () => {
	let base: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-clear-"));
		savedEnv = process.env.OMP_WORKTREE_DIR;
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(base);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(async () => {
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		vi.restoreAllMocks();
		await fs.rm(base, { recursive: true, force: true });
	});

	async function makeSandbox(name: string): Promise<string> {
		const dir = path.join(base, name);
		await fs.mkdir(path.join(dir, "m"), { recursive: true });
		await Bun.write(path.join(dir, "m", "work.txt"), "uncaptured\n");
		return dir;
	}

	/** A pid that has been spawned and reaped, so `kill(pid, 0)` reports ESRCH. */
	async function deadPid(): Promise<number> {
		const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		await proc.exited;
		return proc.pid;
	}

	it("keeps live-owned, unreadable-marker and markerless sandboxes, reclaims dead-owner ones", async () => {
		const live = await makeSandbox("tlive0001");
		await writeIsolationOwner(live, "live0001"); // marker names this test process

		const dead = await makeSandbox("tdead0002");
		await Bun.write(path.join(dead, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "dead0002" }));

		// No marker at all: a pre-marker leftover, or one whose marker something
		// removed. Neither proves no task is working in there, and a crashed run
		// now always leaves a marker naming its dead process.
		const orphan = await makeSandbox("tnone0003");

		// A marker nobody can parse says nothing about whether a task is
		// running in there, and deletion needs proof. `--all` is the way to
		// remove it anyway.
		const corrupt = await makeSandbox("tbad00004");
		await Bun.write(path.join(corrupt, ISOLATION_OWNER_FILE), "{ not json");

		// Setup race: marker written before the backend materialises `m`. The
		// dir holds only the live-owner marker and no mount yet.
		const pending = path.join(base, "tpend0005");
		await fs.mkdir(pending, { recursive: true });
		await writeIsolationOwner(pending, "pend0005");

		// Recycled pid: the crashed owner's pid was reassigned to this live test
		// process, but the recorded start-time token no longer matches.
		const recycled = await makeSandbox("trecyc06");
		await Bun.write(
			path.join(recycled, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: process.pid, id: "recyc06", startToken: "not-the-current-token" }),
		);

		await clearWorktrees({ all: false, dryRun: false, json: true });

		const exists = async (p: string): Promise<boolean> =>
			await fs.stat(p).then(
				() => true,
				() => false,
			);
		expect(await Bun.file(path.join(live, "m", "work.txt")).exists()).toBe(true);
		expect(await exists(dead)).toBe(false);
		expect(await exists(orphan)).toBe(true);
		expect(await exists(corrupt)).toBe(true);
		expect(await exists(pending)).toBe(true);
		// Windows reports neither /proc start times nor `ps`, so pid-only liveness
		// cannot spot the recycled pid and the sandbox is conservatively kept.
		expect(await exists(recycled)).toBe(process.platform === "win32");
	});

	it("lists why plain clear keeps a sandbox that cannot prove it is finished, and what removes it", async () => {
		// Nothing removes such a sandbox on its own, and the reason naming
		// `--all` was computed and then dropped: the list called it `live`.
		const orphan = await makeSandbox("tnone0012");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await listWorktrees({ json: true });

		const entries = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as WorktreeEntry[];
		expect(entries.find(entry => entry.path === orphan)).toMatchObject({
			kind: "task-isolation",
			keptReason: "no owner marker (use --all to remove)",
		});
	});

	it("says a sandbox is kept for a teardown still stopping it, not for the run that built it", async () => {
		// A teardown whose stop outran its bound marks the sandbox retiring
		// under its own process; the list called that process the one that
		// built the sandbox.
		const stopping = await makeSandbox("tstop0014");
		await markIsolationRetiring(stopping);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await listWorktrees({ json: true });

		const entries = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as WorktreeEntry[];
		expect(entries.find(entry => entry.path === stopping)?.keptReason).toStartWith(
			`a teardown's backend stop is still running on it (pid ${process.pid})`,
		);
	});

	it("keeps a sandbox a live session still leases, and reclaims one its owner retired", async () => {
		// `clear` judges by proof, like the owner's teardown: a dead owner whose
		// sandbox a live session is working in stays, and a directory the
		// owner's teardown already retired goes even though its marker names a
		// live process.
		const leased = await makeSandbox("tlease10");
		await Bun.write(path.join(leased, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "lease10" }));
		await Bun.write(path.join(leased, ISOLATION_LEASE_DIR, "live.json"), JSON.stringify({ pid: process.pid }));

		const retired = await makeSandbox("tretire11");
		await markIsolationRetired(retired);

		await clearWorktrees({ all: false, dryRun: false, json: true });

		expect(await Bun.file(path.join(leased, "m", "work.txt")).exists()).toBe(true);
		await expect(fs.stat(retired)).rejects.toThrow();
	});

	it("unmounts retained mounting-backend workspaces before removal", async () => {
		const retained = await makeSandbox("tret0007");
		await Bun.write(
			path.join(retained, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: await deadPid(), id: "ret0007" }),
		);
		await writeRetainedBackend(retained, natives.IsoBackendKind.Overlayfs);
		// A live overlay at `m`: the mount table reports it until the stop runs.
		// `clear` reads the table, so an ordinary directory alone is not a mount.
		const mountDir = path.join(retained, "m");
		let mounted = true;
		vi.spyOn(isolationFs, "liveMountsUnder").mockImplementation(async dir =>
			mounted && (mountDir === dir || mountDir.startsWith(`${dir}/`)) ? [mountDir] : [],
		);
		const isoStopSpy = vi.spyOn(natives, "isoStop").mockImplementation(async () => {
			mounted = false;
		});

		await clearWorktrees({ all: false, dryRun: false, json: true });

		expect(isoStopSpy).toHaveBeenCalledWith(natives.IsoBackendKind.Overlayfs, path.join(retained, "m"));
		await expect(fs.stat(retained)).rejects.toThrow();
	});

	it("removes sandboxes without a retained-mount sidecar without unmounting", async () => {
		const plain = await makeSandbox("tplain08");
		await Bun.write(path.join(plain, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "plain08" }));
		const isoStopSpy = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);

		await clearWorktrees({ all: false, dryRun: false, json: true });

		expect(isoStopSpy).not.toHaveBeenCalled();
		await expect(fs.stat(plain)).rejects.toThrow();
	});

	it("keeps the workspace when its retained mount cannot stop", async () => {
		const retained = await makeSandbox("tbusy0009");
		await Bun.write(
			path.join(retained, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: await deadPid(), id: "busy0009" }),
		);
		await writeRetainedBackend(retained, natives.IsoBackendKind.Overlayfs);
		// A live overlay at `m` that will not stop, as the mount table reports it.
		const mountDir = path.join(retained, "m");
		vi.spyOn(isolationFs, "liveMountsUnder").mockImplementation(async dir =>
			mountDir === dir || mountDir.startsWith(`${dir}/`) ? [mountDir] : [],
		);
		vi.spyOn(natives, "isoStop").mockRejectedValue(new Error("umount EBUSY"));

		const { failed } = await clearWorktrees({ all: false, dryRun: false, json: true });
		expect(failed).toBe(1);

		expect(await Bun.file(path.join(retained, "m", "work.txt")).exists()).toBe(true);
	});

	it("keeps workspaces whose retained-mount metadata is unreadable", async () => {
		const retained = await makeSandbox("tbad0010");
		await Bun.write(
			path.join(retained, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: await deadPid(), id: "bad0010" }),
		);
		await Bun.write(path.join(retained, RETAINED_BACKEND_FILE), "{ not json");
		const isoStopSpy = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);

		await clearWorktrees({ all: false, dryRun: false, json: true });

		expect(isoStopSpy).not.toHaveBeenCalled();
		expect(await Bun.file(path.join(retained, "m", "work.txt")).exists()).toBe(true);
	});

	it("keeps a sandbox that finishes materialising after the scan saw it empty", async () => {
		// Failure mode: `ensureIsolation` mints an empty directory, resolves its
		// backend, and only then takes the sandbox lock and claims it. `clear`
		// called that directory an empty shell and removed it on the scan's word
		// alone — after the materialisation had finished and a task had written
		// into it.
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-clear-repo-"));
		temporary.push(repo);
		for (const args of [
			["init", "-q"],
			[
				"-c",
				"user.name=Clear Test",
				"-c",
				"user.email=clear@example.com",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"seed",
			],
		]) {
			const git = Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" });
			expect(await git.exited).toBe(0);
		}
		const resolving = Promise.withResolvers<void>();
		const materialise = Promise.withResolvers<void>();
		const isoResolve = natives.isoResolve;
		vi.spyOn(natives, "isoResolve").mockImplementation(async preferred => {
			resolving.resolve();
			await materialise.promise;
			return await isoResolve(preferred);
		});
		const creating = ensureIsolation(repo, "race", natives.IsoBackendKind.Rcopy);
		await resolving.promise;
		const [minted] = await fs.readdir(base);
		// Hold the removal at its act — a delete of what the scan saw, or the
		// rename that takes it out of circulation — while the materialisation
		// runs to the end it can reach.
		const atRemoval = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		const rm = isolationFs.rm;
		const rename = isolationFs.rename;
		vi.spyOn(isolationFs, "rm").mockImplementation((async (target: string, options) => {
			if (path.basename(target) === minted) {
				atRemoval.resolve();
				await proceed.promise;
			}
			return await rm(target, options);
		}) as typeof isolationFs.rm);
		vi.spyOn(isolationFs, "rename").mockImplementation((async (from: string, to: string) => {
			if (path.basename(from) === minted && path.basename(to).startsWith(`${minted}.removing-`)) {
				atRemoval.resolve();
				await proceed.promise;
			}
			return await rename(from, to);
		}) as typeof isolationFs.rename);

		const clearing = clearWorktrees({ all: false, dryRun: false, json: true });
		await atRemoval.promise;
		materialise.resolve();
		// Unlocked, the materialisation finishes now; under the lock it waits
		// for the removal to end.
		const finishedFirst = await Promise.race([creating.then(() => true), scheduler.wait(2_000).then(() => false)]);
		if (finishedFirst) await Bun.write(path.join((await creating).mergedDir, "new-work.txt"), "only copy\n");
		proceed.resolve();
		await clearing;
		const handle = await creating;
		if (!finishedFirst) await Bun.write(path.join(handle.mergedDir, "new-work.txt"), "only copy\n");

		expect(await Bun.file(path.join(handle.mergedDir, "new-work.txt")).text()).toBe("only copy\n");
		vi.restoreAllMocks();
		await cleanupIsolation(handle);
	}, 30_000);
	it("re-decides a live checkout that became a sandbox after the scan, under --all", async () => {
		// Failure mode: `clear --all` removed a pr-checkout on the scan's word; a
		// sandbox claimed at that path after the scan was deleted with a task's
		// only copy, because the checkout removal did not take the lock, pin the
		// directory, or classify it again.
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-clear-co-"));
		temporary.push(repo);
		for (const args of [
			["init", "-q"],
			["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "seed"],
		]) {
			const git = Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" });
			expect(await git.exited).toBe(0);
		}
		const checkout = path.join(base, "checkout");
		const add = Bun.spawn(["git", "worktree", "add", "--detach", checkout, "HEAD"], {
			cwd: repo,
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(await add.exited).toBe(0);
		const realStatLookup = isolationFs.statLookup;
		let swapped = false;
		vi.spyOn(isolationFs, "statLookup").mockImplementation(async target => {
			const result = await realStatLookup(target);
			// The scan's look at the parent repo is when a successor claims the path.
			if (!swapped && String(target) === repo) {
				swapped = true;
				await fs.rename(checkout, `${checkout}-saved`);
				await fs.mkdir(path.join(checkout, "m"), { recursive: true });
				await writeIsolationOwner(checkout, "successor");
				await Bun.write(path.join(checkout, "m", "only-copy"), "NEW SANDBOX\n");
			}
			return result;
		});

		await clearWorktrees({ all: true, dryRun: false, json: true });

		expect(await Bun.file(path.join(checkout, "m", "only-copy")).text()).toBe("NEW SANDBOX\n");
	});

	it("does not stop or remove a sandbox through a symlinked mount directory", async () => {
		// Failure mode: `clear` stopped the recorded backend through `m` with a
		// symlink-following stat, so a mount dir that is a symlink sent the native
		// stop into a foreign directory and unmounted or deleted what it targeted.
		const foreign = await fs.mkdtemp(path.join(os.tmpdir(), "omp-foreign-"));
		temporary.push(foreign);
		await Bun.write(path.join(foreign, "keep.txt"), "another tree\n");
		const dir = path.join(base, "tsym0011");
		await fs.mkdir(dir, { recursive: true });
		await fs.symlink(foreign, path.join(dir, "m"));
		await Bun.write(path.join(dir, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "sym0011" }));
		await writeRetainedBackend(dir, natives.IsoBackendKind.Overlayfs);
		const isoStop = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);

		const { failed } = await clearWorktrees({ all: false, dryRun: false, json: true });

		expect(isoStop).not.toHaveBeenCalled();
		expect(failed).toBe(1);
		expect(await Bun.file(path.join(foreign, "keep.txt")).text()).toBe("another tree\n");
		expect(await Bun.file(path.join(dir, ISOLATION_OWNER_FILE)).exists()).toBe(true);
	});

	it("removes a sandbox whose mount backend was recorded before a mount that never happened", async () => {
		// Failure mode: the backend record is now written before the mount, so a
		// run killed between the record and the mount — or one whose stop already
		// succeeded — leaves an ordinary, unmounted `m`. `clear` called native
		// stop on it, the stop failed because nothing was mounted, and the
		// sandbox was stranded with no way to remove it.
		const dir = await makeSandbox("tpre0012");
		await Bun.write(path.join(dir, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "pre0012" }));
		await writeRetainedBackend(dir, natives.IsoBackendKind.Overlayfs);
		const isoStop = vi
			.spyOn(natives, "isoStop")
			.mockRejectedValue(new Error("fusermount: entry not found in /etc/mtab"));

		const { removed, failed } = await clearWorktrees({ all: false, dryRun: false, json: true });

		expect(isoStop).not.toHaveBeenCalled();
		expect(removed).toBe(1);
		expect(failed).toBe(0);
		await expect(fs.stat(dir)).rejects.toThrow();
	});
});

afterEach(async () => {
	setWorktreesDir(undefined);
	vi.restoreAllMocks();
	for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

it("keeps the parent of a child it could not read, instead of calling it a stray", async () => {
	// The child was kept and the parent removed as a stray — and removing the
	// container takes the child with it, so the keep meant nothing.
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-clear-unknown-"));
	temporary.push(root);
	setWorktreesDir(root);
	const parent = path.join(root, "project");
	const child = path.join(parent, "sandbox");
	await fs.mkdir(child, { recursive: true });
	await Bun.write(path.join(child, "payload.txt"), "work nobody else has\n");
	const spy = vi.spyOn(fs, "stat");
	spy.mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (String(target) === child) throw Object.assign(new Error("EACCES: denied"), { code: "EACCES" });
		return await (realStat as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
	}) as unknown as typeof fs.stat);

	const result = await clearWorktrees({ json: true, all: false, dryRun: false });

	spy.mockRestore();
	expect(result.removed).toBe(0);
	expect(await Bun.file(path.join(child, "payload.txt")).exists()).toBe(true);
});
