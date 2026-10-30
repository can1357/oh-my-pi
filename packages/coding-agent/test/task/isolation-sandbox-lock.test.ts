import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import {
	forgetIsolationWorkspace,
	ISOLATION_UNFINISHED_DIR,
	markUnfinishedWriter,
} from "@oh-my-pi/pi-coding-agent/task/isolation-lease";
import {
	acquireSandboxLockWithNotice,
	holdsSandboxLock,
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

	it("keeps working when the notice cannot be written", async () => {
		// A diagnostic must never be fatal. A closed stderr and a broken pipe
		// both made children exit 1 while waiting for a lock that was about to
		// be granted.
		const { baseDir } = await makeSandbox();
		const lock = await acquireSandboxLockWithNotice(baseDir, "hold for the test");
		vi.spyOn(process.stderr, "write").mockImplementation(() => {
			throw Object.assign(new Error("EPIPE: broken pipe"), { code: "EPIPE" });
		});
		const waiting = withSandboxLock(baseDir, "wait through a broken pipe", async () => "granted");

		// Past the notice deadline, so the write is certainly attempted.
		await scheduler.wait(1_300);
		lock.release();

		expect(await waiting).toBe("granted");
	});
});

describe("retaining a workspace another party has already moved", () => {
	it("reports the newest sibling that really holds a workspace", async () => {
		const { baseDir, mergedDir } = await makeSandbox();
		const parent = path.dirname(baseDir);
		// A decoy: the name matches, but there is no workspace inside it.
		await fs.mkdir(path.join(parent, `${path.basename(baseDir)}.retained-decoy`), { recursive: true });
		const older = path.join(parent, `${path.basename(baseDir)}.retained-older`);
		await fs.mkdir(path.join(older, "m"), { recursive: true });
		temporary.push(path.join(parent, `${path.basename(baseDir)}.retained-decoy`), older);
		await scheduler.wait(20);
		const newer = path.join(parent, `${path.basename(baseDir)}.retained-newer`);
		await fs.mkdir(path.join(newer, "m"), { recursive: true });
		temporary.push(newer);
		const keep = `${baseDir}-moved`;
		temporary.push(keep);
		await fs.rename(baseDir, keep);

		const retained = await retainIsolationWorkspace(mergedDir, natives.IsoBackendKind.Rcopy);

		expect(retained.dir).toBe(path.join(newer, "m"));
		expect(retained.present).toBe(true);
		expect(await fs.stat(retained.dir).then(entry => entry.isDirectory())).toBe(true);
	});

	it("says a workspace is gone rather than naming a path that is not there", async () => {
		// Teardown won the race and removed it. Naming the original sends the
		// user to an empty name.
		const { baseDir, mergedDir } = await makeSandbox();
		await fs.rm(baseDir, { recursive: true, force: true });

		const retained = await retainIsolationWorkspace(mergedDir, natives.IsoBackendKind.Rcopy);

		expect(retained.present).toBe(false);
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
