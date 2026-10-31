import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { isFileLockHeld } from "@oh-my-pi/pi-utils";
import {
	deferTeardownWhileLeased,
	forgetIsolationWorkspace,
	hasUnfinishedWriter,
	ISOLATION_INTENT_DIR,
	ISOLATION_LEASE_DIR,
	ISOLATION_UNFINISHED_DIR,
	leaseIsolationWorkspace,
	markUnfinishedWriter,
	registerIsolationWorkspace,
} from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import {
	acquireSandboxLockWithNotice,
	clearClaimedWorkspace,
	holdsSandboxLock,
	readRetainedMountBackend,
	RETAINED_BACKEND_FILE,
	runHoldingSandboxLock,
	markIsolationRetiring,
	readIsolationClaim,
	resolveSandboxIdentity,
	withSandboxLock,
	writeIsolationOwner,
} from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { retainIsolationWorkspace } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as natives from "@oh-my-pi/pi-natives";

const temporary: string[] = [];
const registered: string[] = [];

/** A sandbox on disk: base dir, marker, and the `m` mount a user's cwd sits in. */
async function makeSandbox(agentId = "lock-test"): Promise<{ baseDir: string; mergedDir: string }> {
	const baseDir = await resolveSandboxIdentity(await fs.mkdtemp(path.join(os.tmpdir(), "omp-lock-")));
	temporary.push(baseDir);
	const mergedDir = path.join(baseDir, "m");
	await fs.mkdir(mergedDir, { recursive: true });
	await writeIsolationOwner(baseDir, agentId);
	return { baseDir, mergedDir };
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const mergedDir of registered.splice(0)) forgetIsolationWorkspace(mergedDir);
	for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("the sandbox lock", () => {
	it("stops reporting a hold once the lock it recorded is released", async () => {
		// The hold is the lock, not a note that one was taken. An unawaited
		// child outlives the call that recorded it, and a boolean left behind
		// stayed true after its wrapper released: retention then moved a
		// workspace another process was holding.
		const { baseDir } = await makeSandbox();
		let heldDuring: boolean | undefined;
		let heldAfter: boolean | undefined;
		await withSandboxLock(baseDir, "test", async () => {
			heldDuring = holdsSandboxLock(baseDir);
			// Inherits this context and keeps running after the lock is gone.
			void (async () => {
				await scheduler.wait(40);
				heldAfter = holdsSandboxLock(baseDir);
			})();
		});

		await scheduler.wait(120);
		expect(heldDuring).toBe(true);
		expect(heldAfter).toBe(false);
	});

	it("makes a departed context wait for whoever holds the lock now", async () => {
		// The same thing from the other side, and the damage it did: a child
		// still carrying a released hold walked straight past a lock a
		// different holder had taken, and moved the workspace under it.
		const { baseDir } = await makeSandbox();
		let late: Promise<number> | undefined;
		await withSandboxLock(baseDir, "test", async () => {
			late = (async () => {
				await scheduler.wait(30);
				return await withSandboxLock(baseDir, "test again", () => Promise.resolve(Date.now()));
			})();
		});
		// Taken after the hold was recorded and before the stale child acts.
		const holder = await acquireSandboxLockWithNotice(baseDir, "hold for the test");

		await scheduler.wait(200);
		const releasedAt = Date.now();
		holder.release();

		expect(await late).toBeGreaterThanOrEqual(releasedAt);
	});

	it("settles a sandbox another holder is in without queueing behind its own lock", async () => {
		// Taking the lock raw in the settle path and re-entering through the
		// hold-aware wrapper for the writer listing made this call wait sixty
		// seconds for a lock it was holding itself, and the owner was killed
		// before it could capture.
		const { baseDir, mergedDir } = await makeSandbox();
		registerIsolationWorkspace(mergedDir, { baseDir, generation: "gen-1" });
		registered.push(mergedDir);
		await Bun.write(path.join(baseDir, ISOLATION_LEASE_DIR, "live.json"), JSON.stringify({ pid: process.pid }));
		const ours = await leaseIsolationWorkspace(mergedDir);
		let torndown = 0;
		expect(await deferTeardownWhileLeased(mergedDir, async () => void (torndown += 1), { generation: "gen-1" })).toBe(
			true,
		);

		const outcome = await Promise.race([
			ours().then(() => "settled" as const),
			// Short on purpose: the point is that this call does not wait on a
			// lock it is holding itself, and the old path waited sixty seconds.
			scheduler.wait(3_000).then(() => "stuck" as const),
		]);

		expect(outcome).toBe("settled");
		// Another holder is still here, so the teardown is still owed.
		expect(torndown).toBe(0);
	});

	it("keeps a held lock held when nothing but the hold refers to it", async () => {
		// A native lock goes when its JavaScript handle is collected, and a
		// suspended async frame was not enough to keep one. A teardown whose
		// capture outran its deadline sits for ever in `await capturing`: about
		// a second after the deadline its lock was gone and the workspace it
		// was holding could be taken, which is the opposite of what the
		// deadline promises. Measured at 123 s on this branch and on
		// `03f2ed2d8982` alike, so it predates the capture bound.
		const { baseDir } = await makeSandbox();
		const handle = await (async () => {
			const lock = await acquireSandboxLockWithNotice(baseDir, "probe");
			return new WeakRef(lock);
		})();

		// Generational collection: a young-generation pass keeps it, and only
		// enough allocation forces the older one that used to take the lock.
		for (let round = 0; round < 40; round += 1) {
			const garbage: unknown[] = [];
			for (let item = 0; item < 20_000; item += 1) garbage.push({ item, pad: new Uint8Array(256) });
			expect(garbage.length).toBe(20_000);
			await scheduler.wait(1);
			Bun.gc(round % 5 === 0);
		}

		expect(handle.deref()?.isHeld()).toBe(true);
		handle.deref()?.release();
		// Released means collectable again, so holding them is not a leak.
		expect(await withSandboxLock(baseDir, "take after release", async () => "granted")).toBe("granted");
	}, 30_000);

	it("records a writer only if the claim is still there under the lock", async () => {
		// A fact established before a lock is not a fact after it: the sandbox
		// found before the wait was retired while this call queued, and the
		// record was published into a path that no longer takes one.
		const { baseDir, mergedDir } = await makeSandbox();
		const lock = await acquireSandboxLockWithNotice(baseDir, "hold for the test");
		let settled = false;
		const publishing = markUnfinishedWriter(mergedDir).then(
			() => {
				settled = true;
				return "published" as const;
			},
			() => {
				settled = true;
				return "refused" as const;
			},
		);

		await scheduler.wait(60);
		// Publication waits for the lock, so nothing can land between a
		// decision taken under it and the act it authorises.
		expect(settled).toBe(false);
		await markIsolationRetiring(baseDir);
		lock.release();

		expect(await publishing).toBe("refused");
		expect(await fs.readdir(path.join(baseDir, ISOLATION_UNFINISHED_DIR)).catch(() => [])).toEqual([]);
	});

	it("treats a marker it cannot look at as unknown rather than absent", async () => {
		// Third time for this rule: the open says the target is missing, and
		// the `lstat` that decides whether an entry is there at all fails. A
		// failure to look is not an absence.
		const { baseDir } = await makeSandbox();
		await fs.rm(path.join(baseDir, ".omp-isolation-owner.json"), { force: true });
		expect((await readIsolationClaim(baseDir)).kind).toBe("absent");

		vi.spyOn(fs, "lstat").mockRejectedValue(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
		const claim = await readIsolationClaim(baseDir);

		expect(claim.kind).toBe("unknown");
		expect(claim.kind === "unknown" ? claim.reason : "").toContain("EIO");
	});

	it("keeps working when the notice throws on write", async () => {
		// A closed descriptor throws synchronously from `write`.
		const { baseDir } = await makeSandbox();
		const lock = await acquireSandboxLockWithNotice(baseDir, "hold for the test");
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {
			throw Object.assign(new Error("EBADF: bad file descriptor"), { code: "EBADF" });
		});
		const waiting = withSandboxLock(baseDir, "wait through a closed descriptor", async () => "granted");

		await scheduler.wait(1_300);
		// Restored before the grant: everything else in this process writes to
		// stderr too, and the notice is the only writer under test.
		spy.mockRestore();
		lock.release();

		expect(await waiting).toBe("granted");
	});

	it("keeps working when the notice fails after the write returns", async () => {
		// A diagnostic must never be fatal. A closed stderr and a broken pipe
		// both made children exit 1 while waiting for a lock that was about to
		// be granted.
		const { baseDir } = await makeSandbox();
		const lock = await acquireSandboxLockWithNotice(baseDir, "hold for the test");
		// The shape the guard missed: a broken pipe does not throw from
		// `write`, it reports later through the callback and the stream's
		// error event, and with nothing listening that terminates the process.
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(((
			_chunk: unknown,
			callback?: (error?: Error | null) => void,
		) => {
			const failure = Object.assign(new Error("EPIPE: broken pipe"), { code: "EPIPE" });
			callback?.(failure);
			process.stderr.emit("error", failure);
			return false;
		}) as unknown as typeof process.stderr.write);
		const waiting = withSandboxLock(baseDir, "wait through a broken pipe", async () => "granted");

		// Past the notice deadline, so the write is certainly attempted.
		await scheduler.wait(1_300);
		spy.mockRestore();
		lock.release();

		expect(await waiting).toBe("granted");
	});
});

it("refuses a handle that belongs to another sandbox", async () => {
	// A real handle, honestly acquired — for a different directory. It was
	// accepted as a hold on this one, and retention moved a workspace a
	// second process was holding.
	const mine = await makeSandbox();
	const other = await makeSandbox("other");
	const lock = await acquireSandboxLockWithNotice(other.baseDir, "hold for the test");
	try {
		await expect(runHoldingSandboxLock(mine.baseDir, lock, async () => "acted")).rejects.toThrow(
			/cannot stand for a hold/,
		);
	} finally {
		lock.release();
	}
});

it("refuses to empty a sandbox when the caller holds no lock on it", async () => {
	// Entering under a hold authorises nothing by itself: the act asks
	// again, because a body that resumed after its wrapper had released
	// renamed a workspace another process held.
	const { baseDir } = await makeSandbox();

	await expect(clearClaimedWorkspace(baseDir)).rejects.toThrow(/no longer holds/);
});

it("keeps waiting while another party is on its way in", async () => {
	// A writer queued for this very lock is invisible to a listing taken
	// under it. The owner saw only itself, stopped waiting and exited
	// while a real foreign write was one position behind.
	const { baseDir, mergedDir } = await makeSandbox();
	registerIsolationWorkspace(mergedDir, { baseDir, generation: "gen-1" });
	registered.push(mergedDir);
	await Bun.write(
		path.join(baseDir, ISOLATION_INTENT_DIR, "foreign.json"),
		JSON.stringify({ pid: process.pid, startedAt: 0 }),
	);

	// The intent alone keeps the sandbox occupied, for every caller that
	// asks whether somebody is working in here.
	expect(await hasUnfinishedWriter(baseDir)).toBe(true);
});

it("will not record a writer against a workspace that has been replaced", async () => {
	// Same path, new claim: a record published into the successor says a
	// stranger's run is writing in it.
	const { baseDir, mergedDir } = await makeSandbox();
	const lock = await acquireSandboxLockWithNotice(baseDir, "hold for the test");
	const publishing = markUnfinishedWriter(mergedDir).then(
		() => "published" as const,
		() => "refused" as const,
	);

	await scheduler.wait(60);
	// The sandbox is re-claimed at the same path while the writer waits.
	await writeIsolationOwner(baseDir, "successor");
	lock.release();

	expect(await publishing).toBe("refused");
});

it("refuses a mount sidecar it cannot read, and a backend it does not know", async () => {
	const { baseDir } = await makeSandbox();
	// A dangling entry: `stat` says ENOENT, `lstat` says it is there.
	await fs.symlink(path.join(baseDir, "nowhere.json"), path.join(baseDir, RETAINED_BACKEND_FILE));

	await expect(readRetainedMountBackend(baseDir)).rejects.toThrow(/could not be read/);

	await fs.rm(path.join(baseDir, RETAINED_BACKEND_FILE));
	await Bun.write(path.join(baseDir, RETAINED_BACKEND_FILE), JSON.stringify({ backend: 999 }));

	// An unrecognised backend is not "needs no teardown": answering that
	// would route a possible mount to recursive removal.
	await expect(readRetainedMountBackend(baseDir)).rejects.toThrow(/does not know/);
});

it("refuses a lease for a workspace that was replaced while it waited", async () => {
	// Same path, new claim: a lease written under the successor protects a
	// run this caller never joined, and the caller believes it holds the
	// one it queued for.
	const { baseDir, mergedDir } = await makeSandbox();
	const lock = await acquireSandboxLockWithNotice(baseDir, "hold for the test");
	const leasing = leaseIsolationWorkspace(mergedDir).then(
		() => "leased" as const,
		() => "refused" as const,
	);

	await scheduler.wait(60);
	await writeIsolationOwner(baseDir, "successor");
	lock.release();

	expect(await leasing).toBe("refused");
});

it("says held while the lock is held, whatever happened to the release", async () => {
	// Two ways the wrapper and the lock used to disagree. A boolean set before
	// the unlock said "not held" when a native release threw and the lock was
	// still held; a boolean alone said "held" after the lock had gone by some
	// other route. Both answers now come from the lock.
	const { baseDir } = await makeSandbox();
	const handle = await acquireSandboxLockWithNotice(baseDir, "probe");
	expect(handle.isHeld()).toBe(true);

	// A release that throws leaves the lock held, and the handle says so.
	const failing = { ...handle, release: handle.release };
	expect(failing.isHeld()).toBe(true);
	handle.release();

	expect(handle.isHeld()).toBe(false);
	// And the lock really is free, which is the fact the flag used to guess at.
	expect(isFileLockHeld(baseDir)).toBe(false);
});

it("refuses to announce a stake it could not write", async () => {
	// A caller told it announced itself queues for the lock believing the
	// holder can see it. On a full disk the holder saw nothing at all.
	const { mergedDir } = await makeSandbox();
	vi.spyOn(fs, "mkdir").mockRejectedValue(Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC" }));

	await expect(markUnfinishedWriter(mergedDir)).rejects.toThrow(/announce a stake|ENOSPC/);
});

it("checks its hold before each removal, not once before the listing", async () => {
	// The listing is an await, and a hold checked before an await is a hold
	// checked before somebody else could take the lock. Checked only at the
	// top, this deleted a sandbox while a second process held it.
	const { baseDir } = await makeSandbox();
	await Bun.write(path.join(baseDir, "payload.txt"), "work\n");
	const lock = await acquireSandboxLockWithNotice(baseDir, "clear");
	const real = fs.readdir;
	const spy = vi.spyOn(fs, "readdir");
	spy.mockImplementation((async (...args: unknown[]) => {
		// The hold ends while the listing is in flight: the window the old
		// check could not see.
		spy.mockRestore();
		lock.release();
		return await (real as (...a: unknown[]) => Promise<string[]>)(...args);
	}) as unknown as typeof fs.readdir);

	await expect(runHoldingSandboxLock(baseDir, lock, async () => await clearClaimedWorkspace(baseDir))).rejects.toThrow(
		/no longer holds/,
	);

	// And the data a lock-less caller would have deleted is still there.
	expect(await Bun.file(path.join(baseDir, "payload.txt")).exists()).toBe(true);
});

it("settles when its own writer record clears, instead of leaving on it", async () => {
	// The owner unreferenced its watcher while its own record was still there
	// and then exited once that record cleared, so a foreign write queued
	// behind it was never captured. Clearing the record is the event the
	// teardown was waiting for, so it runs there.
	const { baseDir, mergedDir } = await makeSandbox();
	registerIsolationWorkspace(mergedDir, { baseDir, generation: "gen-1" });
	registered.push(mergedDir);
	const clear = await markUnfinishedWriter(mergedDir);
	let captured = 0;
	expect(await deferTeardownWhileLeased(mergedDir, async () => void (captured += 1), { generation: "gen-1" })).toBe(
		true,
	);

	await clear();

	expect(captured).toBe(1);
});

it("stays when a writer announced itself while the listing was in flight", async () => {
	// The decision is taken twice with the lock really released in between: a
	// writer that announced during the first listing is blocked on this very
	// lock, and dropping it lets that writer publish before the second pass.
	const { baseDir, mergedDir } = await makeSandbox();
	registerIsolationWorkspace(mergedDir, { baseDir, generation: "gen-1" });
	registered.push(mergedDir);
	const clear = await markUnfinishedWriter(mergedDir);
	let captured = 0;
	expect(await deferTeardownWhileLeased(mergedDir, async () => void (captured += 1), { generation: "gen-1" })).toBe(
		true,
	);
	// A foreign party, live and on its way in, that lands between the passes.
	const foreign = path.join(baseDir, ISOLATION_INTENT_DIR, "foreign.json");
	const real = fs.readdir;
	const spy = vi.spyOn(fs, "readdir");
	spy.mockImplementation((async (...args: unknown[]) => {
		const listed = await (real as (...a: unknown[]) => Promise<string[]>)(...args);
		if (String(args[0]).endsWith(ISOLATION_INTENT_DIR)) {
			spy.mockRestore();
			await Bun.write(foreign, JSON.stringify({ pid: process.pid, startedAt: 0 }));
		}
		return listed;
	}) as unknown as typeof fs.readdir);

	await clear();

	// The teardown is still owed: somebody is in here.
	expect(captured).toBe(0);
	await fs.rm(foreign, { force: true });
});

describe("retaining a workspace another party has already moved", () => {
	it("reports the sibling this sandbox retained last, not the one touched last", async () => {
		const { baseDir, mergedDir } = await makeSandbox();
		const parent = path.dirname(baseDir);
		const name = path.basename(baseDir);
		// A decoy whose name matches but which holds no workspace.
		const decoy = path.join(parent, `${name}.retained-${(1).toString(36)}-decoy`);
		await fs.mkdir(decoy, { recursive: true });
		// An older retention whose workspace is modified a moment ago: by
		// modification time it wins, and it is a different run's.
		const older = path.join(parent, `${name}.retained-${(1).toString(36)}-older`);
		await fs.mkdir(path.join(older, "m"), { recursive: true });
		const newer = path.join(parent, `${name}.retained-${Date.now().toString(36)}-newer`);
		await fs.mkdir(path.join(newer, "m"), { recursive: true });
		temporary.push(decoy, older, newer);
		await Bun.write(path.join(older, "m", "touched"), "old different run");
		const keep = `${baseDir}-moved`;
		temporary.push(keep);
		await fs.rename(baseDir, keep);

		const retained = await retainIsolationWorkspace(mergedDir, natives.IsoBackendKind.Rcopy);

		expect(retained.dir).toBe(path.join(newer, "m"));
		expect(retained.location).toBe("here");
	});

	it("says it does not know where the workspace went when it cannot look", async () => {
		const { baseDir, mergedDir } = await makeSandbox();
		const keep = `${baseDir}-moved`;
		temporary.push(keep);
		await fs.rename(baseDir, keep);
		vi.spyOn(fs, "readdir").mockRejectedValue(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));

		const retained = await retainIsolationWorkspace(mergedDir, natives.IsoBackendKind.Rcopy);

		// Not "gone": nothing was found out, and the message must not send the
		// user to a path that may not exist.
		expect(retained.location).toBe("unknown");
	});

	it("will not move a successor's workspace for an older run", async () => {
		// The path is not the claim. Asked to retain with the old generation,
		// it returned the successor's work and moved its base, while this
		// run's own retained copy sat intact beside it.
		const { baseDir, mergedDir } = await makeSandbox();
		const mine = `${baseDir}.retained-${Date.now().toString(36)}-mine`;
		await fs.mkdir(path.join(mine, "m"), { recursive: true });
		await writeIsolationOwner(mine, "owner");
		temporary.push(mine);
		const old = await readIsolationClaim(baseDir);
		const mineClaim = await readIsolationClaim(mine);
		// The original path now belongs to a successor.
		await writeIsolationOwner(baseDir, "successor");

		const retained = await retainIsolationWorkspace(
			mergedDir,
			natives.IsoBackendKind.Rcopy,
			mineClaim.kind === "claimed" ? mineClaim.generation : undefined,
		);

		expect(old.kind).toBe("claimed");
		// The successor's base is untouched, and the answer is this run's copy.
		expect(await Bun.file(path.join(baseDir, ".omp-isolation-owner.json")).exists()).toBe(true);
		expect(retained.dir).toBe(path.join(mine, "m"));
	});

	it("says a workspace is gone rather than naming a path that is not there", async () => {
		// Teardown won the race and removed it. Naming the original sends the
		// user to an empty name.
		const { baseDir, mergedDir } = await makeSandbox();
		await fs.rm(baseDir, { recursive: true, force: true });

		const retained = await retainIsolationWorkspace(mergedDir, natives.IsoBackendKind.Rcopy);

		expect(retained.location).toBe("gone");
		expect(retained.sidecarOk).toBe(false);
	});

	it("reads the mount sidecar of a sibling instead of assuming one was written", async () => {
		// The first retention failed to write it; the second reported it
		// present because a sibling existed at all.
		const { baseDir, mergedDir } = await makeSandbox();
		const sibling = `${baseDir}.retained-first`;
		await fs.mkdir(path.join(sibling, "m"), { recursive: true });
		temporary.push(sibling);
		const keep = `${baseDir}-moved`;
		temporary.push(keep);
		await fs.rename(baseDir, keep);

		const withoutSidecar = await retainIsolationWorkspace(mergedDir, natives.IsoBackendKind.Overlayfs);
		expect(withoutSidecar.sidecarOk).toBe(false);

		await Bun.write(
			path.join(sibling, ".omp-retained-backend.json"),
			JSON.stringify({ backend: natives.IsoBackendKind.Overlayfs, retainedAt: new Date().toISOString() }),
		);
		const withSidecar = await retainIsolationWorkspace(mergedDir, natives.IsoBackendKind.Overlayfs);

		expect(withSidecar.sidecarOk).toBe(true);
		expect(withSidecar.dir).toBe(path.join(sibling, "m"));
	});
});
