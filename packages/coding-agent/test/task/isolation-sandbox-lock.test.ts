import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
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
