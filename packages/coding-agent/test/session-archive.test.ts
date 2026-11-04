import { dlopen, FFIType, ptr } from "bun:ffi";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { appendFileSync, constants as fsConstants, renameSync, type Stats, statSync } from "node:fs";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import {
	collectGcErrors,
	type GcCommandFlags,
	type GcResult,
	renderText as renderGcText,
	runGcCommand,
} from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { resolveSessionFileArg } from "@oh-my-pi/pi-coding-agent/cli/session-arg";
import { exportFromFile } from "@oh-my-pi/pi-coding-agent/export/html";
import {
	getArchivedSessionsDir,
	materializeSessionFile,
	mintStagingGround,
	type RestoredSession,
	restoreArchivedSession,
	removeStagingGround,
	type StagingGround,
	restoreRecordLeftNote,
	restoreRecordPath,
	stagingLedgerDir,
	stagingResidueNote,
} from "@oh-my-pi/pi-coding-agent/session/session-archive";
import { withGcLock } from "@oh-my-pi/pi-coding-agent/session/gc-lock";
import * as libcModule from "@oh-my-pi/pi-coding-agent/session/libc";
import * as holders from "@oh-my-pi/pi-coding-agent/session/open-file-holders";
import * as regularFile from "@oh-my-pi/pi-coding-agent/session/regular-file";
import { makeHeldDirectory } from "@oh-my-pi/pi-coding-agent/session/regular-file";
import * as sessionArchive from "@oh-my-pi/pi-coding-agent/session/session-archive";
import { resolveResumableSession, resolveResumeTarget } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	isSessionLeaseHeld,
	sessionStagingPath,
	tryAcquireSessionLease,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { type FileLockHandle, getAgentDir, getBlobsDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";
import * as fileLock from "@oh-my-pi/pi-utils/file-lock";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { leaveDeadGcLock } from "./helpers/gc-lock-fixture";
import { getXattr, setXattr } from "./helpers/xattr";

// A session's lease is an abstract socket named by its id, and on Linux that
// name is shared by the whole machine. Every id here starts with a part made
// fresh for each test, so neither another run of this file nor an earlier test
// in this one — one that timed out with a restore still running, say — holds
// the lease a test needs.
let testPrefix = "";
const sessionId = (last: string): string => `${testPrefix}-42ae-7117-ba7c-${last}`;
let SESSION_ID = "";
const PROMPT = "reply with exactly BRIDGE-PROOF-ONE";
let root: string;
const originalUmask = process.umask();
let originalAgentDir: string;
let sessionFile: string;
let archiveFile: string;

/** The archive copy `gc --archive --apply` writes for a live transcript. */
function archivePathFor(file: string): string {
	return path.join(root, "archive", "sessions", `${path.relative(getSessionsDir(root), file)}.gz`);
}

function sessionBody(id: string, prompt: string, cwd: string): string {
	return `${[
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
		JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: prompt } }),
		JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [] } }),
	].join("\n")}\n`;
}

async function writeSession(stamp: string, id: string, prompt = PROMPT): Promise<string> {
	const dir = path.join(getSessionsDir(root), "--work--");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${stamp}_${id}.jsonl`);
	await Bun.write(file, sessionBody(id, prompt, root));
	return file;
}

/**
 * Fail a staging copy the way a full disk does, at the write rather than at
 * `copyFile`: the archive and the restore copy through descriptors they own
 * so the bytes they publish are the bytes they digested.
 */
function failStagingWrite(when: (target: string) => boolean, code = "ENOSPC") {
	const realOpen = fs.open;
	return spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
		const handle = await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
		if (!when(String(target))) return handle;
		handle.write = (async () => {
			throw Object.assign(new Error(`${code}: injected`), { code });
		}) as typeof handle.write;
		return handle;
	}) as typeof fs.open);
}

/**
 * Whether `target` is a file a run staged: a name inside the staging
 * directory a run mints. The directory itself is not one — a run now opens
 * it to prove it made it, and a spy meant for the staged file must not fire
 * on that open.
 */
function isStagedFile(target: string): boolean {
	return target.includes(".tmp/");
}

/** A staging path below `root` that a copy is about to write. */
function isStagingUnder(root: string): (target: string) => boolean {
	return target => target.startsWith(root) && isStagedFile(target);
}

/**
 * Whether `target` is the private name a removal moves `file` to before it
 * judges and unlinks it: `.<name>.<16 hex digits>.leaving`, beside it.
 */
function isMovedAside(target: string, file: string): boolean {
	return (
		path.dirname(target) === path.dirname(file) &&
		path.basename(target).startsWith(`.${path.basename(file)}.`) &&
		target.endsWith(".leaving")
	);
}

/** Run `action` the first time a staging file for `match` is opened. */
function onStagingOpen(match: string, action: () => Promise<void>) {
	const realOpen = fs.open;
	let fired = false;
	return spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (!fired && isStagedFile(String(target)) && String(target).includes(match)) {
			fired = true;
			await action();
		}
		return await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
	}) as typeof fs.open);
}

/**
 * What a restore killed between the transcript and the artifact tree leaves:
 * the live transcript back, the artifacts still archived, and the restore's
 * own record of being unfinished still down.
 */
async function halfRestore(): Promise<void> {
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await Bun.write(restoreRecordPath(archiveFile), "omp gc --restore <id> --apply\n");
}

/**
 * Stall the first `link` onto `destination` the way a kill leaves a run: the
 * stage written, nothing after it run, and none of its cleanup either.
 * `kill` lets the stalled call fail so the run unwinds once the test has
 * looked at what it left.
 */
function stallLinkOnto(destination: string) {
	const realLink = fs.link;
	const reached = Promise.withResolvers<string>();
	const killed = Promise.withResolvers<void>();
	const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
		if (String(to) === destination) {
			reached.resolve(String(from));
			await killed.promise;
		}
		await realLink(from, to);
	});
	return {
		reached: reached.promise,
		stop: () => link.mockRestore(),
		kill: () => killed.reject(new Error("killed")),
	};
}

/**
 * Leave a staging ground the way a run killed after it minted leaves it: the
 * directory, the staged file and the record on disk, and nothing of the run
 * holding them open.
 */
async function abandonGround(ground: StagingGround): Promise<void> {
	await ground.handle.close();
	await ground.recordHeld.handle.close();
	await ground.dirHeld.handle.close();
}

/** Age every live session and archive it, keeping the live copy. */
async function archiveOnly(agentDir = root): Promise<GcResult> {
	const old = new Date(Date.now() - 30 * 86_400_000);
	const bucket = path.join(getSessionsDir(agentDir), "--work--");
	for (const entry of await fs.readdir(bucket, { recursive: true }).catch(() => [])) {
		await fs.utimes(path.join(bucket, entry), old, old).catch(() => undefined);
	}
	return await runGcCommand({
		flags: {
			agentDir,
			archive: true,
			apply: true,
			json: true,
			coldArchiveAfterDays: 0,
			retainNewestGlobal: 0,
			retainNewestPerCwd: 0,
		},
	});
}

/**
 * Archive every cold session, then remove each live copy by hand: a session
 * only the archive's copies hold, which is what an older `gc --archive
 * --apply` left, and what the restore tests below start from. `gc --reclaim`
 * no longer makes this state — it moves the live copy into the archive and
 * frees the copies; the tests of that are at the end of this file. A live
 * copy goes only where a reclaim preview finds nothing to refuse, the proof
 * the old removal ran; otherwise the preview's reasons go in the errors and
 * the live copy stays. The result returned is the archive phase's.
 */
async function archiveEverything(): Promise<GcResult> {
	// Reading a session can touch its mtime, and gc keeps anything written
	// inside its five-minute write grace — the nested transcripts too.
	const old = new Date(Date.now() - 30 * 86_400_000);
	const bucket = path.join(getSessionsDir(root), "--work--");
	for (const entry of await fs.readdir(bucket, { recursive: true })) {
		await fs.utimes(path.join(bucket, entry), old, old).catch(() => undefined);
	}
	const result = await runGcCommand({
		flags: {
			agentDir: root,
			archive: true,
			apply: true,
			json: true,
			coldArchiveAfterDays: 0,
			retainNewestGlobal: 0,
			retainNewestPerCwd: 0,
		},
	});
	const archiveBucket = path.join(getArchivedSessionsDir(root), "--work--");
	for (const entry of await fs.readdir(archiveBucket).catch(() => [])) {
		if (!entry.endsWith(".jsonl.gz")) continue;
		const preview = await runGcCommand({
			flags: { agentDir: root, reclaim: path.join(archiveBucket, entry), forwardOnly: true, json: true },
		});
		if (preview.reclaim?.wouldReclaim !== 1) {
			// Applying says why it keeps the session in its own words, and keeps it.
			const applied = await runGcCommand({
				flags: {
					agentDir: root,
					reclaim: path.join(archiveBucket, entry),
					apply: true,
					forwardOnly: true,
					json: true,
				},
			});
			if (applied.reclaim?.reclaimed) throw new Error(`the reclaim preview refused ${entry}, and applying moved it`);
			const kept = applied.reclaim?.errors ?? [];
			if (kept.length > 0 && result.archive) result.archive.errors.push(...kept);
			continue;
		}
		const live = path.join(bucket, entry.slice(0, -".gz".length));
		await fs.rm(live, { force: true });
		await fs.rm(live.slice(0, -".jsonl".length), { recursive: true, force: true });
	}
	return result;
}

beforeEach(async () => {
	testPrefix = randomBytes(4).toString("hex");
	SESSION_ID = sessionId("029b1eee0f4b");
	originalAgentDir = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-archive-"));
	setAgentDir(root);
	sessionFile = await writeSession("2026-01-01T00-00-00-000Z", SESSION_ID);
	archiveFile = archivePathFor(sessionFile);
});

afterEach(async () => {
	// A test that times out is abandoned, not stopped: its body runs on, and
	// its own `finally` restores its spies only when that body ends, inside
	// the next test. Until then the next test's `spyOn` on the same function
	// takes over that spy, captures it as the function it wraps, and calls
	// itself until the stack is gone. Every spy goes here, before the next
	// test starts; a late `mockRestore()` on one leaves the next test's alone.
	mock.restore();
	process.umask(originalUmask);
	setAgentDir(originalAgentDir);
	await fs.rm(root, { recursive: true, force: true });
});

test("a session archived by gc resumes by id and comes back byte for byte", async () => {
	const original = await fs.readFile(sessionFile);
	expect((await archiveEverything()).archive).toMatchObject({ archived: 1, errors: [] });
	expect(await Bun.file(sessionFile).exists()).toBe(false);
	expect(await Bun.file(archiveFile).exists()).toBe(true);

	const match = await resolveResumableSession(SESSION_ID, root);
	expect(match?.scope).toBe("archive");
	expect(match?.session.id).toBe(SESSION_ID);

	const manager = await SessionManager.open(match?.session.path ?? "", undefined, undefined, {
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	try {
		expect(manager.getSessionFile()).toBe(sessionFile);
		expect(await fs.readFile(sessionFile)).toEqual(original);
		// The archive stays: a restore publishes, it does not reclaim. Only
		// `gc --archive`, which someone invokes by name, takes a copy away.
		expect(await Bun.file(archiveFile).exists()).toBe(true);
		const texts = manager
			.getEntries()
			.filter(entry => entry.type === "message")
			.map(entry => JSON.stringify(entry));
		expect(texts.some(text => text.includes(PROMPT))).toBe(true);
	} finally {
		await manager.close();
	}
});

test("exporting an archived session yields the same document as live, subagent transcripts included", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody(sessionId("sub-1"), "nested subagent prompt", root));
	const livePath = path.join(root, "live.html");
	await exportFromFile(sessionFile, { outputPath: livePath });
	const live = await Bun.file(livePath).text();
	expect(live).toContain("subSessions");
	await archiveEverything();
	const archivedPath = path.join(root, "archived.html");

	await exportFromFile(archiveFile, { outputPath: archivedPath });

	expect(await Bun.file(archivedPath).text()).toBe(live);
});

test("gc --restore brings an archived session back and names what it cannot restore", async () => {
	await archiveEverything();

	const result = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

	expect(result.restore?.errors).toEqual([]);
	expect(result.restore?.sessionPath).toBe(sessionFile);
	expect(result.restore?.bytes).toBeGreaterThan(0);
	expect(result.restore?.notRestored.join("\n")).toContain("prompt history");
	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	// A restore runs alone, so nothing else in this agent dir was swept.
	expect(result.archive).toBeUndefined();
});

test("gc --restore reports an unknown session instead of claiming success", async () => {
	await archiveEverything();

	const result = await runGcCommand({ flags: { agentDir: root, restore: "deadbeef", apply: true, json: true } });

	expect(result.restore?.sessionPath).toBeUndefined();
	expect(result.restore?.errors.join("\n")).toContain('no archived session matches "deadbeef"');
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("gc --restore refuses an id prefix that matches two archived sessions", async () => {
	const second = await writeSession(
		"2026-01-02T00-00-00-000Z",
		`${SESSION_ID.slice(0, 8)}-0000-7000-0000-000000000000`,
	);
	await archiveEverything();

	const result = await runGcCommand({
		flags: { agentDir: root, restore: SESSION_ID.slice(0, 8), apply: true, json: true },
	});

	expect(result.restore?.sessionPath).toBeUndefined();
	expect(result.restore?.errors.join("\n")).toContain("matches 2 archived sessions");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	expect(await Bun.file(archivePathFor(second)).exists()).toBe(true);
});

test("gc --restore dry run reports the refusal instead of promising a restore", async () => {
	await archiveEverything();
	// Another session's turns under the archived name: --apply would refuse this.
	await Bun.write(sessionFile, sessionBody(SESSION_ID, "a different conversation", root));

	const result = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });

	expect(result.restore?.sessionPath).toBeUndefined();
	expect(result.restore?.errors.join("\n")).toContain("a different session file already exists");
});

test("gc --restore dry run reports the artifact recovery --apply would finish", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody(sessionId("sub-1"), "nested", root));
	await archiveEverything();
	// What an interrupted restore leaves: the transcript live and carried on,
	// the artifact tree still in the archive. `--apply` finishes that; the dry
	// run must not report an error for work applying performs.
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await fs.appendFile(
		sessionFile,
		`${JSON.stringify({ type: "message", id: "m3", message: { role: "user", content: "later" } })}\n`,
	);

	const result = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });

	expect(result.restore?.errors).toEqual([]);
	expect(result.restore?.sessionPath).toBe(sessionFile);
	// A dry run changes nothing.
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).exists()).toBe(false);
});

test("gc --restore refuses to run beside a phase it would silently skip", async () => {
	await archiveEverything();

	await expect(
		runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, archive: true, apply: true, json: true } }),
	).rejects.toThrow("--restore runs alone");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("gc --restore leaves a .jsonl.gz outside the archive where its owner put it", async () => {
	const foreign = path.join(root, "backups", "mine.jsonl.gz");
	await Bun.write(foreign, gzipSync(Buffer.from(sessionBody(SESSION_ID, PROMPT, root))));

	const result = await runGcCommand({ flags: { agentDir: root, restore: foreign, apply: true, json: true } });

	expect(result.restore?.errors.join("\n")).toContain("gunzip");
	expect(await Bun.file(foreign).exists()).toBe(true);
	expect(await Bun.file(path.join(root, "backups", "mine.jsonl")).exists()).toBe(false);
});

for (const relative of [false, true]) {
	test(`round56 archive reads a ${relative ? "relative" : "absolute"} live transcript link by content`, async () => {
		const target = path.join(root, "offloaded.jsonl");
		const original = await fs.readFile(sessionFile);
		await fs.rename(sessionFile, target);
		await fs.symlink(relative ? path.relative(path.dirname(sessionFile), target) : target, sessionFile);
		expect(await new FileSessionStorage().readText(sessionFile)).toBe(original.toString());

		const result = await archiveOnly();

		expect(result.archive).toMatchObject({ archived: 1, errors: [] });
		expect(Bun.gunzipSync(await fs.readFile(archiveFile))).toEqual(new Uint8Array(original));
		expect((await fs.lstat(sessionFile)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(target)).toEqual(original);
	});
}

test("a file a transcript was symlinked to is not deleted when it is shared", async () => {
	const keep = path.join(root, "notes", "keep.jsonl");
	await fs.mkdir(path.dirname(keep), { recursive: true });
	await fs.rename(sessionFile, keep);
	await fs.symlink(keep, sessionFile);
	const second = path.join(path.dirname(sessionFile), `2026-01-02T00-00-00-000Z_${SESSION_ID}.jsonl`);
	await fs.symlink(keep, second);

	await archiveEverything();

	// Archiving one name must not destroy the bytes the other name still reads.
	expect(await Bun.file(keep).exists()).toBe(true);
	expect(await Bun.file(keep).text()).toContain(PROMPT);
});

test("gc --archive finishes a move a killed run left half-done instead of wedging", async () => {
	await archiveEverything();
	// A run killed between the archive landing and the transcript being dropped.
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));

	const result = await archiveEverything();

	expect(result.archive).toMatchObject({ archived: 1, errors: [] });
	expect(await Bun.file(sessionFile).exists()).toBe(false);
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("gc --archive refuses an archive destination holding a different session", async () => {
	await Bun.write(archiveFile, gzipSync(Buffer.from(sessionBody(sessionId("someone-else"), "other", root))));

	const result = await archiveEverything();

	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.errors.join("\n")).toContain("holds a different session");
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

test("round56 archive reads a linked nested transcript by content and keeps its original", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	const nestedTarget = path.join(root, "offloaded-sub.jsonl");
	const body = sessionBody(sessionId("sub-1"), "nested", root);
	await Bun.write(nestedTarget, body);
	await fs.utimes(nestedTarget, new Date(0), new Date(0));
	await fs.mkdir(artifacts, { recursive: true });
	const link = path.join(artifacts, "sub.jsonl");
	await fs.symlink(nestedTarget, link);

	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	expect(await Bun.file(path.join(archiveFile.slice(0, -9), "sub.jsonl")).text()).toBe(body);
	expect((await runGcCommand({ flags: reclaimApply() })).reclaim?.reclaimed).toBe(0);
	expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
	expect(await Bun.file(nestedTarget).text()).toBe(body);
});

test("round56 archive reads a linked artifact root by content and reclaim keeps the original tree", async () => {
	const artifacts = sessionFile.slice(0, -6);
	const target = path.join(root, "offloaded-artifacts");
	await Bun.write(path.join(target, "tool.log"), "OFFLOADED ARTIFACT");
	await fs.symlink(target, artifacts);

	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	expect(await Bun.file(path.join(archiveFile.slice(0, -9), "tool.log")).text()).toBe("OFFLOADED ARTIFACT");
	expect((await runGcCommand({ flags: reclaimApply() })).reclaim?.reclaimed).toBe(0);
	expect((await fs.lstat(artifacts)).isSymbolicLink()).toBe(true);
	expect(await Bun.file(path.join(target, "tool.log")).text()).toBe("OFFLOADED ARTIFACT");
});

test("restoring an archived session waits for a maintenance run instead of failing", async () => {
	await archiveEverything();
	const acquired = Promise.withResolvers<void>();
	const holder = Promise.withResolvers<void>();
	const held = withGcLock(root, async () => {
		acquired.resolve();
		await holder.promise;
	});
	await acquired.promise;

	const restoring = restoreArchivedSession(archiveFile, root);
	// The lock is a file and waiting for it is a real retry loop against the
	// real clock; there is no signal to await for "the restore is queued".
	await Bun.sleep(100);
	holder.resolve();
	await held;

	expect((await restoring).sessionPath).toBe(sessionFile);
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

test("restoring an archived session does not wait behind a gc.lock gc did not write, and names it at once", async () => {
	await archiveEverything();
	// The reviewer's file: what a crash can leave once a size is committed
	// and its data is not — 48 NUL bytes, an hour old.
	const lock = path.join(root, "gc.lock");
	await Bun.write(lock, Buffer.alloc(48));
	const old = new Date(Date.now() - 60 * 60_000);
	await fs.utimes(lock, old, old);
	// Each attempt to take the lock opens it; waiting would make hundreds.
	const realOpen = fs.open;
	let opens = 0;
	const open = spyOn(fs, "open").mockImplementation((async (file: string, ...rest: unknown[]) => {
		if (String(file) === lock) opens++;
		return await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(file, ...rest);
	}) as typeof fs.open);
	let failure = "";
	try {
		await restoreArchivedSession(archiveFile, root);
	} catch (error) {
		failure = String(error);
	} finally {
		open.mockRestore();
	}

	expect(failure).toContain(`${lock} holds something gc does not write`);
	expect(opens).toBeLessThan(10);
	expect(await Bun.file(lock).bytes()).toEqual(new Uint8Array(48));
});

test("a symlinked sessions directory is not reported as an orphaned link target", async () => {
	const real = path.join(root, "sessions-elsewhere");
	await fs.rename(getSessionsDir(root), real);
	await fs.symlink(real, getSessionsDir(root));

	const result = await archiveEverything();

	expect(result.archive).toMatchObject({ archived: 1, errors: [] });
});

test("a broken link inside an artifact tree is skipped and counted, not left blocking the archive, and keeps the live tree", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "kept.txt"), "kept");
	const dangling = path.join(artifacts, "dangling.jsonl");
	await fs.symlink(path.join(root, "gone.jsonl"), dangling);

	const result = await archiveOnly();
	const reclaimed = await runGcCommand({
		flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
	});

	expect(result.archive).toMatchObject({ archived: 1, brokenLinks: 1, errors: [] });
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	expect(await Bun.file(path.join(archiveFile.slice(0, -".jsonl.gz".length), "kept.txt")).text()).toBe("kept");
	// The archive could not hold it, so giving up the live tree would lose it.
	expect(reclaimed.reclaim?.reclaimed).toBe(0);
	expect(reclaimed.reclaim?.errors.join("\n")).toContain(
		`${dangling} is a symbolic link, which a reclaim does not give up`,
	);
	expect((await fs.lstat(dangling)).isSymbolicLink()).toBe(true);
});

test("a damaged archive is reported as unreadable, not as a session that does not exist", async () => {
	await archiveEverything();
	// Truncating the gzip member: trailing bytes after a complete member are
	// tolerated by design, a short member is not.
	const archived = await fs.readFile(archiveFile);
	await Bun.write(archiveFile, archived.subarray(0, archived.length - 8));

	const match = await resolveResumableSession(SESSION_ID, root);
	expect(match?.scope).toBe("archive");
	expect(match?.session.path).toBe(archiveFile);

	await expect(
		SessionManager.open(archiveFile, undefined, undefined, { suppressBreadcrumb: true, throwIfMissing: true }),
	).rejects.toThrow(archiveFile);
	const dryRun = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });
	expect(dryRun.restore?.sessionPath).toBeUndefined();
	expect(dryRun.restore?.errors.join("\n")).toContain("cannot be read");
});

test("opening an archived session a second time finds the one already restored", async () => {
	await archiveEverything();
	const first = await restoreArchivedSession(archiveFile, root);

	// What a second process that queued for the lock sees: the archive is gone
	// and the live transcript is there, which is what it wanted.
	const second = await restoreArchivedSession(archiveFile, root);

	expect(second.sessionPath).toBe(first.sessionPath);
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

test("a restore whose artifact tree did not come back can be finished by a retry", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody(sessionId("sub-1"), "nested", root));
	await archiveEverything();
	// The shape an interrupted restore leaves: transcript live, tree still in
	// the archive beside the `.gz` the first attempt kept.
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));

	const second = await restoreArchivedSession(archiveFile, root);

	expect(second.artifactsRestored).toBe(true);
	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).text()).toContain("sub-1");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a restore refuses an archive that is not the session already at that path", async () => {
	await archiveEverything();
	await Bun.write(sessionFile, sessionBody(SESSION_ID, "a different conversation", root));

	await expect(restoreArchivedSession(archiveFile, root)).rejects.toThrow("different session file");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a half-restored session that has since been resumed still gets its artifact tree back", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody(sessionId("sub-1"), "nested", root));
	await archiveEverything();
	// Transcript back and carried on, artifact tree still in the archive.
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await fs.appendFile(
		sessionFile,
		`${JSON.stringify({ type: "message", id: "m3", message: { role: "user", content: "later" } })}\n`,
	);

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.artifactsRestored).toBe(true);
	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).text()).toContain("sub-1");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	// The turn taken after the restore is still there.
	expect(await Bun.file(sessionFile).text()).toContain("later");
});

test("a restore keeps both copies when a different file stands where an archived artifact belongs", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), "ONLY-ARCHIVED-CONVERSATION\n");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	// A name collision, not a finished copy: this is another conversation that
	// happens to sit at the path the archived one is named for.
	await Bun.write(path.join(artifacts, "sub.jsonl"), "OTHER-CONVERSATION\n");

	const restored = await restoreArchivedSession(archiveFile, root);

	// The live file is not overwritten, and the archived one is not deleted for
	// standing in its way: it was the only copy of that conversation.
	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).text()).toBe("OTHER-CONVERSATION\n");
	expect(await Bun.file(path.join(archiveFile.slice(0, -".jsonl.gz".length), "sub.jsonl")).text()).toBe(
		"ONLY-ARCHIVED-CONVERSATION\n",
	);
	expect(restored.artifactsRestored).toBe(false);
	expect(restored.notRestored.join("\n")).toContain("sub.jsonl");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a dangling link at an artifact's destination does not count as a restored file", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), "ONLY-ARCHIVED-CONVERSATION\n");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await fs.mkdir(artifacts, { recursive: true });
	await fs.symlink(path.join(root, "target-that-is-gone"), path.join(artifacts, "sub.jsonl"));

	const restored = await restoreArchivedSession(archiveFile, root);

	// An entry whose target does not exist holds nothing, so treating it as
	// "already restored" would leave the conversation in neither place.
	expect(await Bun.file(path.join(archiveFile.slice(0, -".jsonl.gz".length), "sub.jsonl")).text()).toBe(
		"ONLY-ARCHIVED-CONVERSATION\n",
	);
	expect(restored.artifactsRestored).toBe(false);
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a restore finishes when the archive's copy of an artifact is the truncated one", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), "COMPLETE-SUBAGENT-TRANSCRIPT\n");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await Bun.write(path.join(artifacts, "sub.jsonl"), "COMPLETE-SUBAGENT-TRANSCRIPT\n");
	// What a killed archive run leaves: the live file complete, the archive's
	// copy of it cut short. The live file holds every archived byte, so the
	// restore may finish and drop the archive.
	await Bun.write(path.join(archiveFile.slice(0, -".jsonl.gz".length), "sub.jsonl"), "COMPLETE-SUBAG");

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.notRestored).toEqual([]);
	expect(restored.artifactsRestored).toBe(true);
	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).text()).toBe("COMPLETE-SUBAGENT-TRANSCRIPT\n");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a restore interrupted mid-copy leaves no partial file for the retry to mistake for a finished one", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), "COMPLETE-SUBAGENT-TRANSCRIPT\n");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	// What a killed copy used to leave behind: a short file at the real path.
	// A restore must not take it for the finished one and drop the archive's.
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl.1.2.restore.tmp"), "COMPLETE-SUBAG");

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.artifactsRestored).toBe(true);
	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).text()).toBe("COMPLETE-SUBAGENT-TRANSCRIPT\n");
});

test("a restore reports a live directory standing where an archived artifact file belongs", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), "ARCHIVED\n");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await fs.mkdir(path.join(artifacts, "sub.jsonl"), { recursive: true });

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.artifactsRestored).toBe(false);
	expect(restored.notRestored.join("\n")).toContain("artifact tree");
	// Nothing archived is dropped while it has nowhere to go.
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	expect(await Bun.file(path.join(archiveFile.slice(0, -".jsonl.gz".length), "sub.jsonl")).text()).toBe("ARCHIVED\n");
});

test("the staging directory a killed restore left stays where it is, reported, and is not carried home", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "UNIQUE PARTIAL STAGE");
	await archiveEverything();

	const stall = stallLinkOnto(path.join(liveArtifacts, "a.log"));
	const restoring = restoreArchivedSession(archiveFile, root).catch(() => undefined);
	let ground: string | undefined;
	let standing: Stats | undefined;
	let result: GcResult;
	try {
		const stage = await stall.reached;
		ground = path.dirname(stage);
		stall.stop();
		// The dead run's lock is broken the way a dead owner's always is.
		await fs.rm(path.join(root, "gc.lock"));
		result = await runGcCommand({
			flags: { agentDir: root, archive: true, apply: true, json: true, forwardOnly: true, retainNewestGlobal: 99 },
		});
		// Looked at before the stalled run is let go, since its own cleanup
		// would otherwise take it away.
		standing = await fs.stat(ground).catch(() => undefined);
	} finally {
		stall.stop();
		stall.kill();
		await restoring;
	}

	// Only the run that made a staging directory removes it; a later run has
	// a record, which anybody running as this user could have written.
	expect(standing?.isDirectory()).toBe(true);
	expect(result.archive?.stagingResidue).toEqual([ground]);
});

test("a restore does not carry home, and does not remove, a staging directory a killed run recorded in the archive", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	// What an archive run killed mid-publication leaves beside an archived
	// artifact: its recorded stage, half written, in a directory the restore
	// would otherwise walk as part of the tree.
	const ground = await mintStagingGround(path.join(archivedArtifacts, "b.log"), stagingLedgerDir(root));
	await ground.handle.writeFile("HALF A COPY");
	await abandonGround(ground);

	const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

	// Leaving something out is not a restore that finished: it is named, the
	// record stays down, the command fails, and nothing advises removing it.
	const errors = restored.restore?.errors.join("\n") ?? "";
	expect(errors).toContain(ground.dir);
	expect(errors).not.toContain("by hand");
	expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(true);
	expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
	expect(await Bun.file(ground.file).text()).toBe("HALF A COPY");
});

test("resuming an archived id opens the live file its conversation went on in", async () => {
	await archiveEverything();
	const continuationId = sessionId("ffffffffffff");
	const continuationFile = path.join(path.dirname(sessionFile), `2026-02-01T00-00-00-000Z_${continuationId}.jsonl`);
	await Bun.write(
		continuationFile,
		`${[
			JSON.stringify({
				type: "session",
				version: 3,
				id: continuationId,
				timestamp: "2026-02-01T00:00:00.000Z",
				cwd: root,
				continuationOf: SESSION_ID,
			}),
			JSON.stringify({
				type: "message",
				id: "m9",
				timestamp: "2026-02-01T00:00:01.000Z",
				message: { role: "user", content: "the conversation went on here" },
			}),
		].join("\n")}\n`,
	);

	const target = await resolveResumeTarget(SESSION_ID, root);

	// The archived copy is the stale one; resuming it would diverge.
	expect(target?.session.path).toBe(continuationFile);
	expect(target?.continuation?.from).toBe(archiveFile);
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("forking an archived session brings its subagent transcripts along", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody(sessionId("sub-1"), "nested subagent prompt", root));
	await archiveEverything();

	const fork = await SessionManager.forkFrom(archiveFile, root, undefined, undefined, {
		suppressBreadcrumb: true,
	});
	try {
		const forked = fork.getSessionFile() ?? "";
		expect(forked.endsWith(".jsonl")).toBe(true);
		expect(await Bun.file(path.join(forked.slice(0, -".jsonl".length), "sub.jsonl")).text()).toContain(
			"nested subagent prompt",
		);
	} finally {
		await fork.close();
	}
});

test("a plain-file command resolves an archived id to a live transcript with its artifacts", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody(sessionId("sub-1"), "nested subagent prompt", root));
	await archiveEverything();

	// `omp render`, `omp session pack`/`moved` and `omp anonymize` all read
	// what this returns as an ordinary file beside its artifact tree.
	const resolved = await resolveSessionFileArg(SESSION_ID, root);

	expect(resolved).toBe(sessionFile);
	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).text()).toContain("nested subagent prompt");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a restore keeps the permissions of an artifact directory it merges into", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody(sessionId("sub-1"), "nested", root));
	await fs.chmod(artifacts, 0o755);
	await archiveEverything();
	// A directory the live tree already holds, tightened against other local users.
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "later.txt"), "written after the archive");
	await fs.chmod(artifacts, 0o700);

	await restoreArchivedSession(archiveFile, root);

	expect((await fs.stat(artifacts)).mode & 0o777).toBe(0o700);
	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).text()).toContain("nested");
});

test("opening an archive another process already restored and carried on reads the live turns", async () => {
	await archiveEverything();
	// The window between an opener reading the archive and its restore taking
	// the gc lock: another process restored the session and appended a turn.
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await fs.appendFile(
		sessionFile,
		`${JSON.stringify({ type: "message", id: "m3", message: { role: "user", content: "APPENDED-AFTER-RESTORE" } })}\n`,
	);

	const manager = await SessionManager.open(archiveFile, undefined, undefined, { suppressBreadcrumb: true });
	try {
		expect(manager.getSessionFile()).toBe(sessionFile);
		const entries = manager.getEntries().map(entry => JSON.stringify(entry));
		expect(entries.some(entry => entry.includes("APPENDED-AFTER-RESTORE"))).toBe(true);
	} finally {
		await manager.close();
	}
});

test("opening a session whose artifact tree could not be restored fails instead of hiding it", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody(sessionId("sub-1"), "nested", root));
	await archiveEverything();
	// A live directory standing where the archived artifact file belongs: the
	// transcript comes back, the tree cannot.
	await fs.mkdir(path.join(artifacts, "sub.jsonl"), { recursive: true });

	await expect(SessionManager.open(archiveFile, undefined, undefined, { suppressBreadcrumb: true })).rejects.toThrow(
		"artifact tree",
	);
	// The archive is kept, so the retry the error names has both halves.
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("an empty --restore is refused instead of running the configured phases", async () => {
	const old = new Date(Date.now() - 30 * 86_400_000);
	await fs.utimes(sessionFile, old, old);

	await expect(
		runGcCommand({
			flags: {
				agentDir: root,
				restore: "",
				apply: true,
				json: true,
				coldArchiveAfterDays: 0,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
			},
		}),
	).rejects.toThrow("--restore needs a session id");
	// Nothing was archived under cover of a restore that named no session.
	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await Bun.file(archiveFile).exists()).toBe(false);
});

test("an artifact tree that cannot be moved puts the transcript back and leaves the archive complete", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody(sessionId("sub-1"), "nested", root));
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	const transcript = (await fs.stat(sessionFile)).ino;
	// A locked artifact tree: the transcript moved into the archive, the tree
	// will not follow it.
	const realMove = libcModule.renameNoReplace;
	spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		if (from === artifacts) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		return await realMove(from, to);
	});

	const result = await runGcCommand({ flags: reclaimApply() });
	mock.restore();

	expect(result.reclaim?.reclaimed).toBe(0);
	expect(result.reclaim?.moved).toBeUndefined();
	expect(result.reclaim?.errors.join("\n")).toContain("what had moved was moved back");
	expect((await fs.stat(sessionFile)).ino).toBe(transcript);
	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).text()).toContain("nested");
	// The archive is complete: nothing was freed.
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	expect(await Bun.file(path.join(archiveFile.slice(0, -".jsonl.gz".length), "sub.jsonl")).text()).toContain("nested");
});

test("re-archiving a half-restored session keeps the artifacts only the archive holds", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await fs.mkdir(liveArtifacts, { recursive: true });
	await Bun.write(path.join(liveArtifacts, "first.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "only-copy.log"), "UNIQUE-ARCHIVED-ARTIFACT");
	await Bun.write(path.join(liveArtifacts, "subagent-1", "deep.log"), "UNIQUE-ARCHIVED-SUBTREE");
	await archiveEverything();
	// A restore that brought the transcript and one artifact home and stopped:
	// the archive still holds the complete tree, the live tree part of it.
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await Bun.write(path.join(liveArtifacts, "first.log"), "FIRST");

	const open = failStagingWrite(isStagingUnder(archivedArtifacts));
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		open.mockRestore();
	}

	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.errors.join("\n")).toContain("ENOSPC");
	// The artifact the live tree never had is still the archive's to give back.
	expect(await Bun.file(path.join(archivedArtifacts, "only-copy.log")).text()).toBe("UNIQUE-ARCHIVED-ARTIFACT");
	// A whole directory the live tree never had survives too.
	expect(await Bun.file(path.join(archivedArtifacts, "subagent-1", "deep.log")).text()).toBe(
		"UNIQUE-ARCHIVED-SUBTREE",
	);
	// The archive is reachable, and that is what matters: the live copy was
	// given up only because the archive was shown to hold everything it had.
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a session is left alone while a process owns a transcript below a symlinked artifact directory", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const offloaded = path.join(root, "offloaded-children");
	const childId = sessionId("029b1eee0f4c");
	const child = path.join(offloaded, "child.jsonl");
	await Bun.write(child, sessionBody(childId, "nested turn", root));
	await fs.mkdir(liveArtifacts, { recursive: true });
	await fs.symlink(offloaded, path.join(liveArtifacts, "child-dir"));
	const old = new Date(Date.now() - 30 * 86_400_000);
	await fs.utimes(child, old, old);

	// The child's owner: a live process holding its ownership lease.
	const lease = tryAcquireSessionLease(childId);
	expect(lease).not.toBeNull();
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		lease?.release();
	}

	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.skippedActive).toBe(1);
	// Archiving would have copied the child's current bytes and removed the
	// directory link while its writer was still appending to the target.
	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await Bun.file(child).text()).toContain("nested turn");
});

test("a half-restored session still restores after it has been renamed", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	const stamp = "2026-01-01T00:00:00.000Z";
	// What the session writer puts at byte zero: a fixed-width title slot it
	// later rewrites in place, leaving every other byte where it was.
	await Bun.write(sessionFile, `${serializeTitleSlot({ updatedAt: stamp })}${sessionBody(SESSION_ID, PROMPT, root)}`);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), "UNRESTORED-CHILD\n");
	await archiveEverything();
	// A restore that landed the transcript and stopped before its tree.
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await new FileSessionStorage().updateSessionTitle(sessionFile, {
		title: "Renamed after the restore",
		source: "user",
		updatedAt: stamp,
	});

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.artifactsRestored).toBe(true);
	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).text()).toBe("UNRESTORED-CHILD\n");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	// The rename is kept: the restore matched the session, it did not undo it.
	expect(await Bun.file(sessionFile).text()).toContain("Renamed after the restore");
});

test("reclaiming refuses to apply until the one-way step is accepted, and changes nothing", async () => {
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);

	await expect(
		runGcCommand({ flags: { agentDir: root, reclaim: archiveFile, apply: true, json: true } }),
	).rejects.toThrow("--forward-only");

	// Archiving itself needs no such flag now: it copies and keeps both sides.
	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("an unqualified gc --apply leaves every session where it is", async () => {
	const old = new Date(Date.now() - 365 * 86_400_000);
	await fs.utimes(sessionFile, old, old);

	const result = await runGcCommand({ flags: { agentDir: root, apply: true, json: true } });

	expect(result.archive).toBeUndefined();
	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await Bun.file(archiveFile).exists()).toBe(false);
});

test("archiving refuses while the archive holds artifact bytes the live tree lost", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "TOOL OUTPUT: KEEP USER HISTORY\n");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	// A restore that refused to merge this artifact, so the archive kept the
	// complete copy and the live tree holds a truncated one.
	await Bun.write(path.join(liveArtifacts, "tool.log"), "TOOL OUTPUT: ");

	const result = await archiveEverything();

	// `fs.cp(force)` truncates before it writes, so the archive copy is never
	// replaced by the shorter live one.
	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.errors.join("\n")).toContain("the archive is left as it is");
	expect(await Bun.file(path.join(archivedArtifacts, "tool.log")).text()).toBe("TOOL OUTPUT: KEEP USER HISTORY\n");
});

test("restoring over a link into the archive keeps the archive instead of deleting the only copy", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "sub.jsonl"), "ONLY-ARCHIVED-CONVERSATION\n");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	// The live artifact is the archived file under another name. Reading equal
	// bytes through it proves the archive is reachable, not that a second copy
	// exists — and the restore is about to delete the tree it points into.
	await fs.mkdir(liveArtifacts, { recursive: true });
	await fs.symlink(path.join(archivedArtifacts, "sub.jsonl"), path.join(liveArtifacts, "sub.jsonl"));

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.artifactsRestored).toBe(false);
	expect(restored.notRestored.join("\n")).toContain("sub.jsonl");
	expect(await Bun.file(path.join(archivedArtifacts, "sub.jsonl")).text()).toBe("ONLY-ARCHIVED-CONVERSATION\n");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("restoring into a directory link aimed at the archive keeps the archive", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "sub.jsonl"), "ONLY-ARCHIVED-CONVERSATION\n");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	// The parent alias: every child resolves into the archive without any
	// child itself being a link.
	await fs.symlink(archivedArtifacts, liveArtifacts);

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.artifactsRestored).toBe(false);
	expect(restored.notRestored.join("\n")).toContain(path.basename(liveArtifacts));
	expect(await Bun.file(path.join(archivedArtifacts, "sub.jsonl")).text()).toBe("ONLY-ARCHIVED-CONVERSATION\n");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a legacy transcript that gains a title slot after a half restore still restores", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	// Archived before title slots existed: the body starts at the header.
	await Bun.write(sessionFile, sessionBody(SESSION_ID, PROMPT, root));
	await Bun.write(path.join(artifacts, "sub.jsonl"), "UNRESTORED-CHILD\n");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	// Resuming it on a build that writes slots inserts one ahead of the body.
	await Bun.write(
		sessionFile,
		`${serializeTitleSlot({ title: "Named on resume", source: "user", updatedAt: "2026-01-02T00:00:00.000Z" })}${sessionBody(SESSION_ID, PROMPT, root)}`,
	);

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.artifactsRestored).toBe(true);
	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).text()).toBe("UNRESTORED-CHILD\n");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a nested transcript renamed after a half restore keeps both copies", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	const stamp = "2026-01-01T00:00:00.000Z";
	const nested = (title: string) =>
		`${serializeTitleSlot({ title, source: "user", updatedAt: stamp })}${sessionBody(sessionId("029b1eee0f4c"), "nested turn", root)}`;
	await Bun.write(path.join(artifacts, "sub.jsonl"), nested("Before"));
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	// The subagent session was resumed and renamed. Nothing in an artifact
	// tree earns transcript semantics — a name is not provenance — so this is
	// an artifact whose bytes differ, and both copies are kept.
	await Bun.write(path.join(artifacts, "sub.jsonl"), nested("After"));

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.artifactsRestored).toBe(false);
	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).text()).toBe(nested("After"));
	expect(await Bun.file(path.join(archivedArtifacts, "sub.jsonl")).text()).toBe(nested("Before"));
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a short title record does not let the comparison skip the session header", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	// A record the title-slot parser accepts in full, but far short of the
	// fixed width, so the header that carries the session id still lies inside
	// the first slot-sized window.
	const short = `${JSON.stringify({ type: "title", v: 1, title: "t", updatedAt: "2026-01-01T00:00:00.000Z", pad: "" })}\n`;
	const other = sessionId("029b1eee0f4c");
	await Bun.write(sessionFile, `${short}${sessionBody(SESSION_ID, PROMPT, root)}`);
	await Bun.write(path.join(artifacts, "sub.jsonl"), "ONLY-ARCHIVED-CHILD\n");
	await archiveEverything();
	// A different session under the archived name: same shape, different id.
	await Bun.write(sessionFile, `${short}${sessionBody(other, PROMPT, root)}`);

	await expect(restoreArchivedSession(archiveFile, root)).rejects.toThrow("different session file");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	expect(await Bun.file(path.join(archiveFile.slice(0, -".jsonl.gz".length), "sub.jsonl")).text()).toBe(
		"ONLY-ARCHIVED-CHILD\n",
	);
});

test("a refused reclaim does not migrate the settings it read", async () => {
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	// A legacy agent directory: `Settings.loadIsolated` renames this on its way
	// in and writes `config.yml` beside it, so a refusal decided after that
	// load has already changed the directory it refused to touch.
	const legacy = path.join(root, "settings.json");
	await Bun.write(legacy, JSON.stringify({ gc: { archive: true } }));

	await expect(
		runGcCommand({ flags: { agentDir: root, reclaim: archiveFile, apply: true, json: true } }),
	).rejects.toThrow("--forward-only");

	expect(await Bun.file(legacy).exists()).toBe(true);
	expect(await Bun.file(`${legacy}.bak`).exists()).toBe(false);
	expect(await Bun.file(path.join(root, "config.yml")).exists()).toBe(false);
	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

// A restore and a reclaim read no setting, so neither may load — and so
// migrate — the agent directory's configuration: the legacy migration renames
// `settings.json` onto `settings.json.bak`, and a review lost an existing
// backup's only copy that way to both commands, each exiting 0.
for (const command of ["restore", "reclaim"] as const) {
	test(`a ${command} leaves a legacy settings.json and an existing backup of it as they are`, async () => {
		await archiveOnly();
		if (command === "restore") await fs.rm(sessionFile);
		const legacy = path.join(root, "settings.json");
		await Bun.write(legacy, `${JSON.stringify({ gc: { archive: true } })}\n`);
		await Bun.write(`${legacy}.bak`, "ONLY PRIVATE SETTINGS BACKUP");

		const result = await runGcCommand({
			flags:
				command === "restore"
					? { agentDir: root, restore: SESSION_ID, apply: true, json: true }
					: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});

		expect(collectGcErrors(result)).toEqual([]);
		expect(await Bun.file(`${legacy}.bak`).text()).toBe("ONLY PRIVATE SETTINGS BACKUP");
		expect(await Bun.file(legacy).text()).toBe(`${JSON.stringify({ gc: { archive: true } })}\n`);
		expect(await Bun.file(path.join(root, "config.yml")).exists()).toBe(false);
	});
}

test("archiving refuses a conflict below a symlinked archive directory", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "nested", "tool.log"), "PREFIX-ARCHIVED-ONLY-SUFFIX\n");
	await archiveEverything();
	// The archive keeps its nested directory somewhere else and links to it —
	// a walk that stops at the link sees none of the files the copy overwrites.
	const offloaded = path.join(root, "offloaded-archive-tree");
	await fs.rename(path.join(archivedArtifacts, "nested"), offloaded);
	await fs.symlink(offloaded, path.join(archivedArtifacts, "nested"));
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await Bun.write(path.join(liveArtifacts, "nested", "tool.log"), "PREFIX");

	const result = await archiveEverything();

	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.errors.join("\n")).toContain("is a symbolic link");
	expect(await Bun.file(path.join(offloaded, "tool.log")).text()).toBe("PREFIX-ARCHIVED-ONLY-SUFFIX\n");
});

test("archiving checks the bytes it is about to write, not the live file it read earlier", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "PREFIX-ARCHIVED-ONLY-SUFFIX\n");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await Bun.write(path.join(liveArtifacts, "tool.log"), "PREFIX-ARCHIVED-ONLY-SUFFIX\n");

	// The live file loses the archived suffix before the copy reads it. What
	// the archive compares is what this run copied, so the shorter live file
	// is refused rather than written over the longer archived one.
	const open = onStagingOpen("tool.log", async () => {
		await Bun.write(path.join(liveArtifacts, "tool.log"), "PREFIX");
	});
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		open.mockRestore();
	}

	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.errors.join("\n")).toContain("the archive is left as it is");
	expect(await Bun.file(path.join(archivedArtifacts, "tool.log")).text()).toBe("PREFIX-ARCHIVED-ONLY-SUFFIX\n");
});

test("an artifact that only looks like a transcript is compared byte for byte", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	// Tool output whose first line happens to fill a title slot, with the only
	// copy of its content inside that line. Nothing about the file is a
	// session, so none of its bytes may be read as a name and skipped.
	const titled = (content: string) =>
		`${serializeTitleSlot({ title: content, source: "user", updatedAt: "2026-01-01T00:00:00.000Z" })}SHARED TAIL\n`;
	await Bun.write(path.join(liveArtifacts, "tool-output.log"), titled("UNIQUE ARCHIVED OUTPUT"));
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await Bun.write(path.join(liveArtifacts, "tool-output.log"), titled("DIFFERENT LIVE OUTPUT"));

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.artifactsRestored).toBe(false);
	expect(await Bun.file(path.join(archivedArtifacts, "tool-output.log")).text()).toBe(
		titled("UNIQUE ARCHIVED OUTPUT"),
	);
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a restore refuses to delete the archive when the live tree becomes an alias of it mid-copy", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "sub.jsonl"), "ONLY-ARCHIVED-CONVERSATION\n");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));

	// The live tree becomes the archived tree under another name once the file
	// has been carried home. Every path checked before that is stale, so the
	// question has to be asked again with nothing left to do but delete.
	const realLink = fs.link;
	const rename = spyOn(fs, "link").mockImplementation(async (source, destination) => {
		await realLink(source, destination);
		if (String(destination) !== path.join(liveArtifacts, "sub.jsonl")) return;
		await fs.rm(liveArtifacts, { recursive: true, force: true });
		await fs.symlink(archivedArtifacts, liveArtifacts);
	});
	let restored: RestoredSession | undefined;
	try {
		restored = await restoreArchivedSession(archiveFile, root);
	} finally {
		rename.mockRestore();
	}

	expect(restored?.artifactsRestored).toBe(false);
	expect(await Bun.file(path.join(archivedArtifacts, "sub.jsonl")).text()).toBe("ONLY-ARCHIVED-CONVERSATION\n");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a legacy transcript the writer renames in its header still restores", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	const header = {
		type: "session",
		version: 3,
		id: SESSION_ID,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: root,
	};
	const turns = `${[
		JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: PROMPT } }),
		JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [] } }),
	].join("\n")}\n`;
	// Archived before title slots: the header is the first line and carries no name.
	await Bun.write(sessionFile, `${JSON.stringify(header)}\n${turns}`);
	await Bun.write(path.join(artifacts, "sub.jsonl"), "UNRESTORED-CHILD\n");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	// What the legacy rewrite leaves: a slot in front and the name written into
	// the header record too.
	await Bun.write(
		sessionFile,
		`${serializeTitleSlot({ title: "Renamed", source: "user", updatedAt: "2026-01-02T00:00:00.000Z" })}${JSON.stringify(
			{ ...header, title: "Renamed", titleSource: "user" },
		)}\n${turns}`,
	);

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.notRestored).toEqual([]);
	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).text()).toBe("UNRESTORED-CHILD\n");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	expect(await Bun.file(sessionFile).text()).toContain("Renamed");
});
test("a conflict that appears after an earlier artifact copied still keeps its archived bytes", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a-first.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "z-later.log"), "BASE");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await Bun.write(path.join(liveArtifacts, "a-first.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "z-later.log"), "BASE");

	// The second file's archived copy grows after the first one has been
	// published, so a decision taken before the walk started would be stale.
	const open = onStagingOpen("a-first.log", async () => {
		await Bun.write(path.join(archivedArtifacts, "z-later.log"), "BASE-ARCHIVED-ONLY");
	});
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		open.mockRestore();
	}

	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(path.join(archivedArtifacts, "z-later.log")).text()).toBe("BASE-ARCHIVED-ONLY");
});

test("a failed archive copy keeps archive-only entries below a symlinked archive directory", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "nested", "shared.log"), "SHARED");
	await archiveEverything();
	const offloaded = path.join(root, "offloaded-archive-tree");
	await fs.rename(path.join(archivedArtifacts, "nested"), offloaded);
	await fs.symlink(offloaded, path.join(archivedArtifacts, "nested"));
	await Bun.write(path.join(offloaded, "only.log"), "ARCHIVED ONLY");
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await Bun.write(path.join(liveArtifacts, "nested", "shared.log"), "SHARED");
	await Bun.write(path.join(liveArtifacts, "nested", "new.log"), "NEW");

	const open = failStagingWrite(target => target.includes("new.log") && isStagedFile(target));
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		open.mockRestore();
	}

	expect(result.archive?.archived).toBe(0);
	// The cleanup walks the same tree the copy wrote into, so what the archive
	// held through the link is still there.
	expect(await Bun.file(path.join(offloaded, "only.log")).text()).toBe("ARCHIVED ONLY");
	expect(await Bun.file(path.join(offloaded, "shared.log")).text()).toBe("SHARED");
});

test("a first archive that runs out of space leaves the live session whole", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "only.log"), "LIVE-ARTIFACT");
	const open = failStagingWrite(isStagedFile);
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		open.mockRestore();
	}

	// The transcript's own copy landed before the artifact copy ran out of
	// space, so the archive holds a partial session. Nothing was given up for
	// it: the live session is whole, and a later run supersedes the partial
	// archive rather than tripping over it.
	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await Bun.file(path.join(liveArtifacts, "only.log")).text()).toBe("LIVE-ARTIFACT");
});

test("a legacy-configured archive phase copies without needing the one-way flag", async () => {
	const old = new Date(Date.now() - 30 * 86_400_000);
	await fs.utimes(sessionFile, old, old);
	// Archiving is on, but only the pre-config.yml file says so. Reading it is
	// still the gate's job; what it gates is reclaiming, and archiving alone
	// hides nothing because it keeps the live copy.
	await Bun.write(path.join(root, "settings.json"), JSON.stringify({ gc: { archive: true } }));

	const result = await runGcCommand({
		flags: {
			agentDir: root,
			apply: true,
			json: true,
			coldArchiveAfterDays: 0,
			retainNewestGlobal: 0,
			retainNewestPerCwd: 0,
		},
	});

	expect(result.archive?.errors).toEqual([]);
	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a FIFO where the legacy settings.json belongs is not waited on before gc runs", async () => {
	// What the read-only settings view looks at when there is no config.yml:
	// a FIFO there blocked the open until a writer came, before gc took its
	// lock, and the command printed nothing.
	const legacy = path.join(root, "settings.json");
	expect(await Bun.spawn(["mkfifo", legacy]).exited).toBe(0);

	const run = runGcCommand({ flags: { agentDir: root, json: true } });
	// A real timer, for the same reason as the transcript FIFO tests: the
	// defect is a blocking open, which no fake clock reaches.
	const outcome = await Promise.race([run, Bun.sleep(5_000).then(() => "hung" as const)]);
	if (outcome === "hung") {
		const writer = await fs.open(legacy, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
		await writer.close();
		await run.catch(() => undefined);
	}

	expect(outcome).not.toBe("hung");
	expect((await fs.lstat(legacy)).isFIFO()).toBe(true);
}, 15_000);

test("an archived artifact nobody can read is refused, not written over", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ARCHIVED UNIQUE SUFFIX");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ARCHIVED");
	// Unreadable, in a writable directory: a failure to read says nothing
	// about what is there, and nothing may be written over it on that basis.
	await fs.chmod(path.join(archivedArtifacts, "tool.log"), 0o000);

	const result = await archiveEverything();

	expect(result.archive?.archived).toBe(0);
	await fs.chmod(path.join(archivedArtifacts, "tool.log"), 0o600);
	expect(await Bun.file(path.join(archivedArtifacts, "tool.log")).text()).toBe("ARCHIVED UNIQUE SUFFIX");
});

test("archived names hard-linked to one file are not independent live copies", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "ONLY BYTES");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	// Both archived names are one file, and both live names point at them, so
	// removing the archive tree would leave no directory entry at all — which
	// a link count cannot say.
	await fs.link(path.join(archivedArtifacts, "a.log"), path.join(archivedArtifacts, "b.log"));
	await fs.mkdir(liveArtifacts, { recursive: true });
	await fs.symlink(path.join(archivedArtifacts, "a.log"), path.join(liveArtifacts, "a.log"));
	await fs.symlink(path.join(archivedArtifacts, "b.log"), path.join(liveArtifacts, "b.log"));

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.artifactsRestored).toBe(false);
	expect(await Bun.file(path.join(archivedArtifacts, "a.log")).text()).toBe("ONLY BYTES");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a restore does not write over a file that appeared while it was staging", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ARCHIVED");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));

	const open = onStagingOpen("tool.log", async () => {
		await Bun.write(path.join(liveArtifacts, "tool.log"), "NEW USER WORK");
	});
	let restored: RestoredSession | undefined;
	try {
		restored = await restoreArchivedSession(archiveFile, root);
	} finally {
		open.mockRestore();
	}

	expect(restored?.artifactsRestored).toBe(false);
	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("NEW USER WORK");
	expect(await Bun.file(path.join(archivedArtifacts, "tool.log")).text()).toBe("ARCHIVED");
});

test("a restored artifact changed to the same length before the delete keeps the archive", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "UNIQUE");
	await Bun.write(path.join(liveArtifacts, "z.log"), "SECOND");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));

	// The first restored file is rewritten to different bytes of the same
	// length while the second is still being carried home. Size and inode both
	// still look right; only the content says otherwise.
	const realLink = fs.link;
	const link = spyOn(fs, "link").mockImplementation(async (source, destination) => {
		await realLink(source, destination);
		if (String(destination).endsWith("z.log")) await Bun.write(path.join(liveArtifacts, "a.log"), "OTHER!");
	});
	let restored: RestoredSession | undefined;
	try {
		restored = await restoreArchivedSession(archiveFile, root);
	} finally {
		link.mockRestore();
	}

	expect(restored?.artifactsRestored).toBe(false);
	expect(await Bun.file(path.join(archivedArtifacts, "a.log")).text()).toBe("UNIQUE");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a live artifact rewritten after it was staged is kept, not deleted", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ORIGINAL");

	const realLink = fs.link;
	const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
		await realLink(from, to);
		if (String(to).endsWith("tool.log")) await Bun.write(path.join(liveArtifacts, "tool.log"), "NEW WORK");
	});
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		link.mockRestore();
	}

	expect(result.archive?.errors.join("\n")).toContain("was kept:");
	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("NEW WORK");
});

test("archiving keeps a deliberately private artifact directory private", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "nested", "tool.log"), "PRIVATE");
	await fs.chmod(path.join(liveArtifacts, "nested"), 0o700);
	await fs.chmod(liveArtifacts, 0o700);

	expect((await archiveEverything()).archive?.archived).toBe(1);

	expect((await fs.stat(archivedArtifacts)).mode & 0o777).toBe(0o700);
	expect((await fs.stat(path.join(archivedArtifacts, "nested"))).mode & 0o777).toBe(0o700);
});

test("an archived file whose name only looks like a staging temp is carried home like any other", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ARTIFACT");
	await archiveEverything();
	// Nothing recorded staging it, so nothing here can tell it from a file
	// somebody keeps under that name.
	const lookalike = sessionStagingPath(path.join(archivedArtifacts, "tool.log"));
	await Bun.write(lookalike, "SOMEBODY'S BYTES");

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.notRestored).toEqual([]);
	expect(await Bun.file(path.join(liveArtifacts, path.basename(lookalike))).text()).toBe("SOMEBODY'S BYTES");
	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("ARTIFACT");
});
test("an interrupted repair never truncates the live file the archive is linked to", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "COMPLETE-PREFIX-AND-SUFFIX");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	// The live artifact is the archived file under another name. Writing into
	// the archived file would write into this one too.
	await fs.mkdir(liveArtifacts, { recursive: true });
	await fs.link(path.join(archivedArtifacts, "tool.log"), path.join(liveArtifacts, "tool.log"));

	const result = await archiveEverything();

	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(path.join(archivedArtifacts, "tool.log")).text()).toBe("COMPLETE-PREFIX-AND-SUFFIX");
	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("COMPLETE-PREFIX-AND-SUFFIX");
});

test("a failed archive leaves alone the file its own refusal protected", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "ORIGINAL");
	await Bun.write(path.join(liveArtifacts, "z.log"), "SECOND");

	// Someone writes the first destination just before it is published, so the
	// publish refuses; the cleanup must not then delete what it refused to
	// replace.
	const realLink = fs.link;
	const link = spyOn(fs, "link").mockImplementation(async (source, destination) => {
		if (String(destination).endsWith("a.log")) await Bun.write(String(destination), "NEW USER WORK");
		return await realLink(source, destination);
	});
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		link.mockRestore();
	}

	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(path.join(archivedArtifacts, "a.log")).text()).toBe("NEW USER WORK");
	expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("ORIGINAL");
});

test("tool output named like a transcript keeps every byte", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	// A log named `.jsonl` whose first record is session-shaped, with the only
	// copy of its content in a field a transcript would treat as a name.
	// Neither its name nor its shape says omp wrote it as a transcript, so
	// none of its bytes may be read as a name and skipped.
	const shaped = (title: string) =>
		`${JSON.stringify({ type: "session", version: 3, id: sessionId("example"), title })}\n${JSON.stringify({
			type: "message",
			id: "a",
			message: { role: "assistant", content: [] },
		})}\n`;
	const archivedTitle = "ARCHIVED UNIQUE OUTPUT";
	await Bun.write(path.join(liveArtifacts, "tool-output.jsonl"), shaped(archivedTitle));
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await Bun.write(path.join(liveArtifacts, "tool-output.jsonl"), shaped("live"));

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.artifactsRestored).toBe(false);
	expect(await Bun.file(path.join(archivedArtifacts, "tool-output.jsonl")).text()).toBe(shaped(archivedTitle));
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a transcript is never restored over one that appeared in the meantime", async () => {
	await archiveEverything();
	const realLink = fs.link;
	const link = spyOn(fs, "link").mockImplementation(async (source, destination) => {
		if (String(destination) === sessionFile) await Bun.write(sessionFile, "NEW USER WORK\n");
		return await realLink(source, destination);
	});
	try {
		await expect(restoreArchivedSession(archiveFile, root)).rejects.toThrow();
	} finally {
		link.mockRestore();
	}

	expect(await Bun.file(sessionFile).text()).toBe("NEW USER WORK\n");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a migrated transcript whose entry tree was reparented is refused", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	const header = { type: "session", version: 1, id: SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: root };
	const user = (id: string, parentId: string | null, content: string) =>
		JSON.stringify({ type: "message", id, parentId, message: { role: "user", content } });
	const assistant = (id: string, parentId: string) =>
		JSON.stringify({ type: "message", id, parentId, message: { role: "assistant", content: [] } });
	await Bun.write(
		sessionFile,
		`${JSON.stringify(header)}\n${user("u", null, "FIRST")}\n${user("m", "u", "MIDDLE")}\n${assistant("a", "m")}\n`,
	);
	await Bun.write(path.join(artifacts, "sub.jsonl"), "UNRESTORED-CHILD\n");
	await archiveEverything();
	// Migrated to version 3, every record kept — but the middle record now
	// hangs off nothing instead of the first one, which is a different
	// conversation however intact the records look.
	await Bun.write(
		sessionFile,
		`${JSON.stringify({ ...header, version: 3 })}\n${user("u2", null, "FIRST")}\n${user("m2", null, "MIDDLE")}\n${assistant("a2", "m2")}\n`,
	);

	await expect(restoreArchivedSession(archiveFile, root)).rejects.toThrow("different session file");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("archiving into an existing private archive directory does not widen it", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "first.log"), "FIRST");
	await archiveEverything();
	await fs.chmod(archivedArtifacts, 0o700);
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await Bun.write(path.join(liveArtifacts, "first.log"), "FIRST");
	await fs.chmod(liveArtifacts, 0o755);

	expect((await archiveEverything()).archive?.archived).toBe(1);

	expect((await fs.stat(archivedArtifacts)).mode & 0o777).toBe(0o700);
});

test("a restored session that advances can be archived again", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "PREFIX");
	await archiveEverything();
	// What a restore leaves: both copies, the live one free to carry on. The
	// live transcript and artifact then grow past the archive, and archiving
	// has to take the longer copy — the shorter one is inside it — or a
	// restored session could never be archived again.
	await restoreArchivedSession(archiveFile, root);
	await Bun.write(sessionFile, `${await Bun.file(sessionFile).text()}${JSON.stringify({ type: "later" })}\n`);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "PREFIX-AND-MORE");
	const old = new Date(Date.now() - 30 * 86_400_000);
	await fs.utimes(sessionFile, old, old);

	const result = await archiveEverything();

	expect(result.archive?.errors).toEqual([]);
	expect(result.archive?.archived).toBe(1);
	expect(await Bun.file(path.join(archivedArtifacts, "tool.log")).text()).toBe("PREFIX-AND-MORE");
	expect(new TextDecoder().decode(Bun.gunzipSync(await fs.readFile(archiveFile)))).toContain("later");
	expect(await Bun.file(sessionFile).exists()).toBe(false);
});

test("the archived transcript is never written over one that appeared at its name", async () => {
	const old = new Date(Date.now() - 30 * 86_400_000);
	await fs.utimes(sessionFile, old, old);
	const realLink = fs.link;
	const link = spyOn(fs, "link").mockImplementation(async (source, destination) => {
		if (String(destination) === archiveFile) await Bun.write(archiveFile, "NEW USER WORK\n");
		return await realLink(source, destination);
	});
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		link.mockRestore();
	}

	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(archiveFile).text()).toBe("NEW USER WORK\n");
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

test("a rollback leaves alone a name this run created and something else replaced", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "ORIGINAL A");
	await Bun.write(path.join(liveArtifacts, "z.log"), "SECOND");

	// `a.log` is published, then replaced by someone else's file, and the run
	// then fails. The replacement is not this run's to undo.
	const open = onStagingOpen("z.log", async () => {
		const replacement = path.join(root, "someone-elses-file");
		await Bun.write(replacement, "NEW USER WORK");
		await fs.rename(replacement, path.join(archivedArtifacts, "a.log"));
	});
	const realLink = fs.link;
	const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
		if (String(to).endsWith("z.log")) throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
		await realLink(from, to);
	});
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		link.mockRestore();
		open.mockRestore();
	}

	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(path.join(archivedArtifacts, "a.log")).text()).toBe("NEW USER WORK");
});

test("a restore refuses while a running process owns the session", async () => {
	await archiveEverything();
	const lease = tryAcquireSessionLease(SESSION_ID);
	expect(lease).not.toBeNull();
	try {
		await expect(restoreArchivedSession(archiveFile, root)).rejects.toThrow("owns this session");
	} finally {
		lease?.release();
	}

	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a genuine version 1 transcript the writer migrates still restores", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	// Version 1: no entry names, no parents — the shape the migration exists
	// to give an entry tree to.
	const header = { type: "session", version: 1, id: SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: root };
	const body = `${JSON.stringify(header)}\n${JSON.stringify({
		type: "message",
		message: { role: "user", content: "KEEP" },
	})}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })}\n`;
	await Bun.write(sessionFile, body);
	await Bun.write(path.join(artifacts, "sub.jsonl"), "UNRESTORED-CHILD\n");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	const manager = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
	await manager.setSessionName("Renamed", "user");
	await manager.close();

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.notRestored).toEqual([]);
	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).text()).toBe("UNRESTORED-CHILD\n");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a staging name left linked to an archived file does not damage it", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ARCHIVED CONTENT");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await Bun.write(path.join(liveArtifacts, "nested", "tool.log"), "ARCHIVED CONTENT");

	// What a kill between `link` and the temp's removal leaves: a second name
	// on the published archive file. The next run must take that name off the
	// data before it stages anything through it, not write into it.
	const archived = path.join(archivedArtifacts, "tool.log");
	const realCopyFile = fs.copyFile;
	const copyFile = spyOn(fs, "copyFile").mockImplementation(async (source, destination, mode) => {
		const staged = String(destination);
		if (staged.endsWith(".tmp") && !(await Bun.file(staged).exists())) await fs.link(archived, staged);
		return await realCopyFile(source, staged, mode);
	});
	try {
		await archiveEverything();
	} finally {
		copyFile.mockRestore();
	}

	expect(await Bun.file(archived).text()).toBe("ARCHIVED CONTENT");
});

test("a restore refuses while a process owns the session under a name of its own", async () => {
	// A transcript archiving accepts under any filename: the id lives in the
	// header, and the writer leases that, not the name.
	const custom = path.join(getSessionsDir(root), "--work--", "my-session.jsonl");
	await Bun.write(custom, sessionBody(SESSION_ID, PROMPT, root));
	await fs.rm(sessionFile, { force: true });
	const old = new Date(Date.now() - 30 * 86_400_000);
	await fs.utimes(custom, old, old);
	expect((await archiveEverything()).archive?.archived).toBe(1);
	const archived = path.join(getArchivedSessionsDir(root), "--work--", "my-session.jsonl.gz");
	expect(await Bun.file(archived).exists()).toBe(true);

	const lease = tryAcquireSessionLease(SESSION_ID);
	expect(lease).not.toBeNull();
	try {
		await expect(restoreArchivedSession(archived, root)).rejects.toThrow("owns this session");
	} finally {
		lease?.release();
	}

	expect(await Bun.file(archived).exists()).toBe(true);
	expect(await Bun.file(custom).exists()).toBe(false);
});

test("a restore refuses while a process owns a subagent session below it", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	const childId = sessionId("029b1eee0f4c");
	// Named `.log`, because a name says nothing: the header is what the owner
	// leases and what archiving reads.
	await Bun.write(path.join(liveArtifacts, "child.log"), sessionBody(childId, "UNIQUE ORIGINAL", root));
	await archiveEverything();

	const lease = tryAcquireSessionLease(childId);
	expect(lease).not.toBeNull();
	try {
		await expect(restoreArchivedSession(archiveFile, root)).rejects.toThrow("subagent sessions");
	} finally {
		lease?.release();
	}

	expect(await Bun.file(path.join(archivedArtifacts, "child.log")).text()).toContain("UNIQUE ORIGINAL");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("an archived name that only points into the live tree is not a surviving copy", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "CONTENT");
	await Bun.write(path.join(liveArtifacts, "b.log"), "CONTENT");
	// The archive's `a` is a link into the live tree. It reads the same bytes
	// as the live `a`, and holds none of its own.
	await fs.mkdir(archivedArtifacts, { recursive: true });
	await fs.symlink(path.join(liveArtifacts, "b.log"), path.join(archivedArtifacts, "a.log"));

	const result = await archiveEverything();

	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("CONTENT");
	expect(await Bun.file(path.join(liveArtifacts, "b.log")).text()).toBe("CONTENT");
});

test("a migrated transcript whose entry names point at nothing is refused", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	const header = { type: "session", version: 1, id: SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: root };
	const user = (content: string) => JSON.stringify({ type: "message", message: { role: "user", content } });
	const assistant = JSON.stringify({ type: "message", message: { role: "assistant", content: [] } });
	await Bun.write(sessionFile, `${JSON.stringify(header)}\n${user("FIRST")}\n${user("MIDDLE")}\n${assistant}\n`);
	await Bun.write(path.join(artifacts, "sub.jsonl"), "UNRESTORED-CHILD\n");
	await archiveEverything();
	// Every record is still there, and the names are strings — but the first
	// names nothing and the second's parent points at nothing, so the history
	// the session would rebuild starts at MIDDLE.
	await Bun.write(
		sessionFile,
		`${JSON.stringify({ ...header, version: 3 })}\n${JSON.stringify({
			type: "message",
			id: "",
			parentId: null,
			message: { role: "user", content: "FIRST" },
		})}\n${JSON.stringify({
			type: "message",
			id: "m2",
			parentId: "",
			message: { role: "user", content: "MIDDLE" },
		})}\n${JSON.stringify({ type: "message", id: "a2", parentId: "m2", message: { role: "assistant", content: [] } })}\n`,
	);

	await expect(restoreArchivedSession(archiveFile, root)).rejects.toThrow("different session file");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a restore does not write through a staging name left on real data", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ONLY ARCHIVED COPY");
	await archiveEverything();
	await halfRestore();
	const movedAside = path.join(root, "moved-aside.log");
	await Bun.write(movedAside, "SOMEONE ELSE'S DATA");

	// The staging name is taken off this restore's file and put on someone
	// else's, between publication and cleanup. A cleanup that removes the
	// name empties data that exists nowhere else.
	const realLink = fs.link;
	const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
		await realLink(from, to);
		if (!String(from).includes("tool.log")) return;
		await fs.rm(String(from), { force: true });
		await realLink(movedAside, String(from));
	});
	let restored: RestoredSession | undefined;
	try {
		restored = await restoreArchivedSession(archiveFile, root);
	} finally {
		link.mockRestore();
	}

	expect(await Bun.file(movedAside).text()).toBe("SOMEONE ELSE'S DATA");
	expect(restored?.notRestored.join("\n")).toContain("is not what this run staged there");
});

test("a failed archive leaves no empty directory behind its own staging residue", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "z.log"), "SECOND");

	// The stage for the second file cannot be removed, and the run then
	// fails: the directory it was minted in stays, with its own file in it,
	// and nothing else of this run's is left behind.
	// The removal is the `unlink` of the stage by its name.
	const realUnlink = fs.unlink;
	let blocked = true;
	const rm = spyOn(fs, "unlink").mockImplementation(async target => {
		if (blocked && isStagedFile(String(target)) && String(target).includes("z.log")) {
			blocked = false;
			throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
		}
		return await realUnlink(target);
	});
	const open = failStagingWrite(target => isStagedFile(target) && target.includes("z.log"));
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		open.mockRestore();
		rm.mockRestore();
	}

	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.errors.join("\n")).toContain("could not be checked or removed");
	// Only this run's own staging ground is left, and it is named in the
	// errors rather than quietly swept by the shape of its name.
	for (const name of await fs.readdir(archivedArtifacts).catch(() => [])) {
		expect(/^\..+\.[0-9a-f]{16}\.tmp$/.test(name)).toBe(true);
	}
});

test("a restore sees an owner whose transcript opens the way the session loader allows", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	const childId = sessionId("029b1eee0f4c");
	const body = sessionBody(childId, "UNIQUE ORIGINAL", root);
	const header = body.slice(0, body.indexOf("\n"));
	// Headers the production reader accepts and a hand-rolled one does not:
	// blank lines first, the header pretty-printed, and more leading
	// whitespace than any sniff window.
	const shapes = [
		`\n\n${body}`,
		`${JSON.stringify(JSON.parse(header), null, 2)}\n${body.slice(body.indexOf("\n") + 1)}`,
		`${" ".repeat(200)}\n${body}`,
	];
	for (const [index, shape] of shapes.entries()) {
		await Bun.write(path.join(liveArtifacts, `child-${index}.jsonl`), shape);
	}
	await archiveEverything();

	const lease = tryAcquireSessionLease(childId);
	expect(lease).not.toBeNull();
	try {
		await expect(restoreArchivedSession(archiveFile, root)).rejects.toThrow("subagent sessions");
	} finally {
		lease?.release();
	}

	for (const index of shapes.keys()) {
		expect(await Bun.file(path.join(archivedArtifacts, `child-${index}.jsonl`)).text()).toContain("UNIQUE ORIGINAL");
	}
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a child that appears after the owners were counted still stops the restore", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "first.log"), "FIRST");
	await archiveEverything();
	const lateId = sessionId("029b1eee0f4c");
	const late: { lease: { release(): void } | null } = { lease: null };

	// A subagent session joins the tree after the owners were counted and
	// before the tree moves — the transcript landing is exactly that moment —
	// with its own lease, the way one started mid-restore would.
	const realLink = fs.link;
	const link = spyOn(fs, "link").mockImplementation(async (source, destination) => {
		await realLink(source, destination);
		if (late.lease === null && String(destination) === sessionFile) {
			await Bun.write(path.join(archivedArtifacts, "late.jsonl"), sessionBody(lateId, "LATE CHILD", root));
			late.lease = tryAcquireSessionLease(lateId);
		}
	});
	try {
		await expect(restoreArchivedSession(archiveFile, root)).rejects.toThrow("subagent sessions");
	} finally {
		link.mockRestore();
		late.lease?.release();
	}

	expect(await Bun.file(path.join(archivedArtifacts, "late.jsonl")).text()).toContain("LATE CHILD");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("an archived transcript that only points elsewhere is not a finished move", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	// The archive's canonical name points at a gzip inside the live artifact
	// tree: it reads as this very transcript and holds none of it.
	const inside = path.join(liveArtifacts, "copy.jsonl.gz");
	await Bun.write(inside, Bun.gzipSync(await Bun.file(sessionFile).bytes()));
	await fs.mkdir(path.dirname(archiveFile), { recursive: true });
	await fs.symlink(inside, archiveFile);

	const result = await archiveEverything();

	// Finishing the move through that name would leave the archive naming a
	// file this run removes, with nothing for discovery or restore to find.
	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await Bun.file(inside).exists()).toBe(true);
});

test("a migrated transcript that gives one entry another's name is refused", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	const header = { type: "session", version: 1, id: SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: root };
	const user = (content: string) => JSON.stringify({ type: "message", message: { role: "user", content } });
	const assistant = JSON.stringify({ type: "message", message: { role: "assistant", content: [] } });
	await Bun.write(sessionFile, `${JSON.stringify(header)}\n${user("FIRST")}\n${user("MIDDLE")}\n${assistant}\n`);
	await Bun.write(path.join(artifacts, "sub.jsonl"), "UNRESTORED-CHILD\n");
	await archiveEverything();
	// Every record present and every name a string — but the last entry wears
	// the first's name, so the history rebuilt from it loses FIRST.
	const named = (id: string, parentId: string | null, content: string) =>
		JSON.stringify({ type: "message", id, parentId, message: { role: "user", content } });
	await Bun.write(
		sessionFile,
		`${JSON.stringify({ ...header, version: 3 })}\n${named("e1", null, "FIRST")}\n${named("e2", "e1", "MIDDLE")}\n${JSON.stringify(
			{ type: "message", id: "e1", parentId: "e2", message: { role: "assistant", content: [] } },
		)}\n`,
	);

	await expect(restoreArchivedSession(archiveFile, root)).rejects.toThrow("different session file");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("archiving over a different archived session names the way back", async () => {
	const other = sessionId("029b1eee0f4c");
	await fs.mkdir(path.dirname(archiveFile), { recursive: true });
	await Bun.write(archiveFile, Bun.gzipSync(Buffer.from(sessionBody(other, "ANOTHER SESSION", root))));
	const old = new Date(Date.now() - 30 * 86_400_000);
	await fs.utimes(sessionFile, old, old);

	const result = await archiveEverything();

	const errors = result.archive?.errors.join("\n") ?? "";
	expect(errors).toContain("--restore");
	expect(errors).toContain("--apply");
	expect(errors).toContain("--agent-dir");
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

test("a child that joins while the tree is being copied stops the archive going", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "UNIQUE ORIGINAL");
	await Bun.write(path.join(liveArtifacts, "z.log"), "SECOND");
	await archiveEverything();
	const lateId = sessionId("029b1eee0f4c");
	const late: { lease: { release(): void } | null } = { lease: null };

	// A subagent session joins the tree while the copy is running — after
	// every count a restore could take before it starts — and holds its own
	// lease. The tree being moved is no longer the one that was leased.
	const realLink = fs.link;
	const link = spyOn(fs, "link").mockImplementation(async (source, destination) => {
		await realLink(source, destination);
		if (late.lease === null && String(destination).endsWith("a.log")) {
			await Bun.write(path.join(liveArtifacts, "late.jsonl"), sessionBody(lateId, "LATE CHILD", root));
			late.lease = tryAcquireSessionLease(lateId);
		}
	});
	let restored: RestoredSession | undefined;
	try {
		restored = await restoreArchivedSession(archiveFile, root);
	} finally {
		link.mockRestore();
		late.lease?.release();
	}

	expect(restored?.artifactsRestored).toBe(false);
	expect(await Bun.file(path.join(archivedArtifacts, "a.log")).text()).toBe("UNIQUE ORIGINAL");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("the divergent-transcript refusal does not send anyone down a route that fails", async () => {
	await archiveEverything();
	const other = sessionId("029b1eee0f4c");
	await Bun.write(sessionFile, sessionBody(other, "ANOTHER SESSION", root));

	const refusal = await restoreArchivedSession(archiveFile, root).then(
		() => "",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);

	// Keeping the archived one is a command; keeping the live one is not, and
	// the message must not offer `--restore` for it, because by then there is
	// no archive left to match.
	expect(refusal).toContain("different session file");
	expect(refusal).toContain(`move ${sessionFile}`);
	expect(refusal).toContain("no archived session matches");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("archiving over a different archived session names both halves to move", async () => {
	const other = sessionId("029b1eee0f4c");
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await fs.mkdir(path.dirname(archiveFile), { recursive: true });
	await Bun.write(archiveFile, Bun.gzipSync(Buffer.from(sessionBody(other, "ANOTHER SESSION", root))));
	await Bun.write(path.join(archivedArtifacts, "other.log"), "OTHER ARTIFACT");
	const old = new Date(Date.now() - 30 * 86_400_000);
	await fs.utimes(sessionFile, old, old);

	const errors = (await archiveEverything()).archive?.errors.join("\n") ?? "";

	// Moving the transcript alone leaves the other session's artifact tree in
	// the way, so the message has to name it too.
	expect(errors).toContain(archiveFile);
	expect(errors).toContain(archivedArtifacts);
	expect(errors).toContain("Moving the transcript alone is not enough");
});

test("a restore leaves the archive whole, however the live tree changes while it runs", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "UNIQUE ORIGINAL");
	await Bun.write(path.join(liveArtifacts, "z.log"), "SECOND");
	await archiveEverything();

	// Past every sample a restore can take: a live file is replaced after its
	// own proof, while the rest of the tree is still being carried home. No
	// sample catches that, which is why the restore gives nothing up — the
	// archive is whole afterwards whatever happened.
	let replaced = false;
	const realLink = fs.link;
	const link = spyOn(fs, "link").mockImplementation(async (source, destination) => {
		await realLink(source, destination);
		if (replaced || !String(destination).endsWith("a.log")) return;
		replaced = true;
		await Bun.write(path.join(liveArtifacts, "a.log"), "NEW CHILD OWNER WORK");
	});
	try {
		await restoreArchivedSession(archiveFile, root);
	} finally {
		link.mockRestore();
	}

	expect(replaced).toBe(true);
	expect(await Bun.file(path.join(archivedArtifacts, "a.log")).text()).toBe("UNIQUE ORIGINAL");
	expect(await Bun.file(path.join(archivedArtifacts, "z.log")).text()).toBe("SECOND");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a restore leaves nothing a maintenance sweep would collect as scratch", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "ARTIFACT");
	await archiveEverything();

	await restoreArchivedSession(archiveFile, root);

	// Retained state under a staging name is state no sweep counts and no
	// command finds. The archive stays at the name `gc --restore` and blob
	// collection already know.
	const bucket = path.dirname(archiveFile);
	for (const name of await fs.readdir(bucket)) expect(name.endsWith(".tmp")).toBe(false);
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});
test("reclaiming refuses while a process owns the session", async () => {
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	const lease = tryAcquireSessionLease(SESSION_ID);
	expect(lease).not.toBeNull();

	let result: GcResult;
	try {
		result = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
	} finally {
		lease?.release();
	}

	expect(result.reclaim?.reclaimed).toBe(0);
	expect(result.reclaim?.errors.join("\n")).toContain("owns");
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

test("reclaiming refuses while a process owns a subagent session below it", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const childId = sessionId("029b1eee0f4c");
	await Bun.write(path.join(liveArtifacts, "child.log"), sessionBody(childId, "UNIQUE CHILD TURN", root));
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	const lease = tryAcquireSessionLease(childId);
	expect(lease).not.toBeNull();

	let result: GcResult;
	try {
		result = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
	} finally {
		lease?.release();
	}

	// The owner was there before this ran; nothing about it is the disclosed
	// window, and its file is still where it left it.
	expect(result.reclaim?.reclaimed).toBe(0);
	expect(result.reclaim?.errors.join("\n")).toContain(
		`a running process owns ${path.join(liveArtifacts, "child.log")}`,
	);
	expect(await Bun.file(path.join(liveArtifacts, "child.log")).text()).toContain("UNIQUE CHILD TURN");
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

test("reclaiming proves the session under its lease, not before taking it", async () => {
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);

	// A turn taken after the archive was made. The proof now runs under the
	// leases rather than before them, so it reads the session as it stands and
	// refuses instead of deleting a transcript it checked earlier.
	await Bun.write(sessionFile, `${await Bun.file(sessionFile).text()}${JSON.stringify({ type: "late" })}\n`);

	const result = await runGcCommand({
		flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
	});

	expect(result.reclaim?.reclaimed).toBe(0);
	expect(result.reclaim?.errors.join("\n")).toContain("is not a copy of");
	expect(await Bun.file(sessionFile).text()).toContain("late");
});

test("reclaiming gives the live copy up once the archive is shown to hold it", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ARTIFACT");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	expect(await Bun.file(sessionFile).exists()).toBe(true);

	const result = await runGcCommand({
		flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
	});

	expect(result.reclaim?.errors).toEqual([]);
	expect(result.reclaim?.reclaimed).toBe(1);
	expect(await Bun.file(sessionFile).exists()).toBe(false);
	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).exists()).toBe(false);
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("an archived artifact updated in place is not written over by a superseding copy", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "PREFIX");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "PREFIX-AND-MORE");

	// The archived file is rewritten in place the moment this run opens it,
	// while the copy is deciding: same inode, same length, different
	// content. A name or inode comparison cannot see that; reading the
	// descriptor again can.
	const realOpen = fs.open;
	let touched = false;
	const open = spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
		const handle = await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
		if (!touched && String(target) === path.join(archivedArtifacts, "tool.log")) {
			touched = true;
			const writer = await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(String(target), "r+");
			await writer.write(Buffer.from("XXXXXX"), 0, 6, 0);
			await writer.close();
		}
		return handle;
	}) as typeof fs.open);
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		open.mockRestore();
	}

	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(path.join(archivedArtifacts, "tool.log")).text()).toBe("XXXXXX");
});
test("a reclaim that gives up nothing says so and exits nonzero", async () => {
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	// Advanced past the archive, so the proof refuses.
	await Bun.write(sessionFile, `${await Bun.file(sessionFile).text()}${JSON.stringify({ type: "late" })}\n`);

	const result = await runGcCommand({
		flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
	});

	// A refusal nobody can see is the same as no refusal: the reason has to
	// reach `collectGcErrors`, which is what sets the exit status, and the
	// rendered output has to say nothing was given up.
	expect(collectGcErrors(result).join("\n")).toContain("reclaim: ");
	expect(renderGcText(result)).toContain("reclaim: gave up nothing");
	expect(result.reclaim?.reclaimed).toBe(0);
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

test("an unknown reclaim target is reported, not thrown past the result", async () => {
	const result = await runGcCommand({
		flags: { agentDir: root, reclaim: "no-such-session", apply: true, forwardOnly: true, json: true },
	});

	expect(result.reclaim?.reclaimed).toBe(0);
	expect(collectGcErrors(result).join("\n")).toContain("reclaim: no archived session matches");
});

test("a reclaim names the live tree it kept, on every refusal", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ARTIFACT");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	const lease = tryAcquireSessionLease(SESSION_ID);
	expect(lease).not.toBeNull();

	let owned: GcResult;
	try {
		owned = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
	} finally {
		lease?.release();
	}
	await Bun.write(sessionFile, `${await Bun.file(sessionFile).text()}${JSON.stringify({ type: "late" })}\n`);
	const advanced = await runGcCommand({
		flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
	});

	for (const result of [owned, advanced]) {
		expect(result.reclaim?.keptArtifactTree).toBe(liveArtifacts);
		expect(renderGcText(result)).toContain("reclaim kept the live artifact tree:");
	}
	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("ARTIFACT");
});

test("a reclaim that refuses on one artifact has removed none of the others", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "child", "only.log"), "NESTED");
	await Bun.write(path.join(liveArtifacts, "z.log"), "LAST");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	// The last file by sort order diverges, so the proof refuses at the end.
	// Everything proved before it must still be there: the tree is settled
	// whole before any of it goes.
	await Bun.write(path.join(liveArtifacts, "z.log"), "DIVERGED");

	const result = await runGcCommand({
		flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
	});

	expect(result.reclaim?.reclaimed).toBe(0);
	expect(result.reclaim?.moved).toBeUndefined();
	expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("FIRST");
	expect(await Bun.file(path.join(liveArtifacts, "child", "only.log")).text()).toBe("NESTED");
	expect(await Bun.file(path.join(liveArtifacts, "z.log")).text()).toBe("DIVERGED");
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

/**
 * Stop a reclaim with its transcript in the archive: the artifact tree will
 * not move after it, and the transcript will not move back.
 */
function strandTranscript(): void {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const realMove = libcModule.renameNoReplace;
	spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		if (from === liveArtifacts || to === sessionFile) {
			throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
		}
		return await realMove(from, to);
	});
}

test("a reclaim that cannot put its transcript back names where it is, and opening the session brings it home", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "z.log"), "LAST");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	const transcript = (await fs.stat(sessionFile)).ino;
	const names = reclaimedNames();

	strandTranscript();
	const result = await runGcCommand({ flags: reclaimApply() });
	mock.restore();

	// Nothing was deleted and nothing reads as kept that is not: the
	// transcript is at its reclaimed name, the tree never moved, and the
	// command that brings the transcript home is named.
	expect(result.reclaim?.reclaimed).toBe(0);
	expect(result.reclaim?.moved).toEqual({ transcript: names.transcript });
	expect(result.reclaim?.keptArtifactTree).toBe(liveArtifacts);
	expect(collectGcErrors(result).join("\n")).toContain("was not reclaimed");
	expect(collectGcErrors(result).join("\n")).toContain("omp gc --restore");
	expect(renderGcText(result)).toContain(`reclaim: stopped with part of ${sessionFile} at ${names.transcript}`);
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	// Opening the session moves the transcript home, the very file.
	const preview = await runGcCommand({ flags: restoreApply(false) });
	expect(preview.restore?.movedHome).toEqual([sessionFile]);
	expect(await materializeSessionFile(sessionFile, root)).toBe(sessionFile);
	expect((await fs.stat(sessionFile)).ino).toBe(transcript);
	expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("FIRST");
	expect(await Bun.file(path.join(liveArtifacts, "z.log")).text()).toBe("LAST");
});
test("an ordinary nested tree is reclaimed whole, with nothing injected", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "child", "only.log"), "NESTED");
	await Bun.write(path.join(liveArtifacts, "z.log"), "LAST");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);

	const result = await runGcCommand({
		flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
	});

	// No injected error, no owner, nothing unusual — a nested tree is the
	// ordinary shape, and removing a directory before its children made every
	// one of them delete its files and then fail.
	expect(result.reclaim?.errors).toEqual([]);
	expect(result.reclaim?.reclaimed).toBe(1);
	expect(collectGcErrors(result)).toEqual([]);
	expect(await Bun.file(sessionFile).exists()).toBe(false);
	expect(await fs.readdir(liveArtifacts).catch(() => undefined)).toBeUndefined();
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a reclaim preview reports what applying would refuse", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ARTIFACT");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	const lease = tryAcquireSessionLease(SESSION_ID);
	expect(lease).not.toBeNull();

	let owned: GcResult;
	try {
		owned = await runGcCommand({ flags: { agentDir: root, reclaim: archiveFile, json: true } });
	} finally {
		lease?.release();
	}
	await Bun.write(path.join(liveArtifacts, "tool.log"), "DIVERGED");
	const diverged = await runGcCommand({ flags: { agentDir: root, reclaim: archiveFile, json: true } });

	// A preview that exits 0 with an empty stderr tells a script the run will
	// work. Both of these would refuse.
	expect(collectGcErrors(owned).join("\n")).toContain("owns");
	expect(collectGcErrors(diverged).join("\n")).toContain("would be kept");
	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("DIVERGED");
});

test("a reclaim whose first move fails does not say it moved anything", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);

	// The transcript moves first, so the very first move is the transcript's.
	const realMove = libcModule.renameNoReplace;
	spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		if (from === sessionFile) throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
		return await realMove(from, to);
	});
	const result = await runGcCommand({ flags: reclaimApply() });
	mock.restore();

	// Nothing moved, so the report must not borrow the wording for a run that
	// left part of the session in the archive.
	expect(result.reclaim?.moved).toBeUndefined();
	expect(collectGcErrors(result).join("\n")).toContain("was kept:");
	expect(collectGcErrors(result).join("\n")).not.toContain("was not reclaimed");
	expect(renderGcText(result)).toContain("reclaim: gave up nothing");
	expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("FIRST");
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

test("a reclaim's recovery instruction can be copied literally with --agent-dir", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "z.log"), "LAST");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);

	strandTranscript();
	const result = await runGcCommand({ flags: reclaimApply() });
	mock.restore();

	// Copied as printed, it has to reach this agent directory rather than the
	// default one.
	expect(collectGcErrors(result).join("\n")).toContain(`--agent-dir ${root}`);
});

test("resuming a session whose artifacts are still archived brings them home, sets the killed run's record aside, and opens", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "sub.jsonl"), "SUBAGENT TRANSCRIPT\n");
	await archiveEverything();
	// What a kill between publishing the transcript and carrying the tree
	// home leaves: the live transcript back, the artifacts still archived,
	// and the restore's record of being unfinished still down.
	await halfRestore();
	const record = restoreRecordPath(archiveFile);

	// Opening takes the gc lock, so the restore that wrote the record is not
	// running: the record is set aside, whole, and the tree comes home.
	expect(await materializeSessionFile(sessionFile, root)).toBe(sessionFile);
	expect(await Bun.file(path.join(liveArtifacts, "sub.jsonl")).text()).toBe("SUBAGENT TRANSCRIPT\n");
	expect(await fs.lstat(record).catch(() => undefined)).toBeUndefined();
	const setAside = (await fs.readdir(path.dirname(record))).filter(name =>
		name.startsWith(`${path.basename(record)}.`),
	);
	expect(setAside).toHaveLength(1);
	expect(await Bun.file(path.join(path.dirname(record), setAside[0])).text()).toBe("omp gc --restore <id> --apply\n");
});
test("the resume route finishes a half restore, sets the killed run's record aside, and opens the session", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "sub.jsonl"), "SUBAGENT TRANSCRIPT\n");
	await archiveEverything();
	// The same half restore. Resume-by-id resolves to the live `.jsonl`, not
	// the archive, so a materialize that only looks at `.gz` never runs.
	await halfRestore();
	const record = restoreRecordPath(archiveFile);

	await (
		await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		})
	).close();

	expect(await Bun.file(path.join(liveArtifacts, "sub.jsonl")).text()).toBe("SUBAGENT TRANSCRIPT\n");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	expect(await fs.lstat(record).catch(() => undefined)).toBeUndefined();
});
test("a complete session that carried on since it was archived still opens", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const childId = sessionId("029b1eee0f4c");
	const child = path.join(liveArtifacts, "child.jsonl");
	await Bun.write(child, sessionBody(childId, "FIRST TURN", root));
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ORIGINAL");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	// Ordinary living after a restore: a child takes another turn, a tool
	// rewrites its output. The archive is retained and now differs, which is
	// what retention means — it is not an interrupted restore.
	await Bun.write(child, `${await Bun.file(child).text()}${JSON.stringify({ type: "later" })}\n`);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "REPLACED");

	const manager = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
	await manager.close();

	expect(await Bun.file(child).text()).toContain("later");
	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("REPLACED");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a live file emptied while it is being archived leaves the archive holding what was read", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	const live = path.join(liveArtifacts, "tool.log");
	await Bun.write(live, "FIRST");

	// Emptied in place after the copy has read it. An archive that measured
	// the source again here would publish nothing and call it archived.
	const realLink = fs.link;
	const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
		if (String(from).includes("tool.log")) await fs.truncate(live, 0);
		await realLink(from, to);
	});
	let result: GcResult;
	try {
		result = await archiveOnly();
	} finally {
		link.mockRestore();
	}

	expect(result.archive?.archived).toBe(1);
	expect(await Bun.file(path.join(archivedArtifacts, "tool.log")).text()).toBe("FIRST");
});

test("a staging failure leaves no temp behind", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "FIRST");

	const realOpen = fs.open;
	const open = spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (isStagedFile(String(target)) && String(target).includes("tool.log")) {
			throw Object.assign(new Error("EMFILE: injected"), { code: "EMFILE" });
		}
		return await (realOpen as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
	}) as typeof fs.open);
	try {
		await archiveEverything();
	} finally {
		open.mockRestore();
	}

	// The copy is inside the cleanup now, so a descriptor this run could not
	// open does not strand the file it had already staged.
	for (const name of await fs.readdir(archivedArtifacts).catch(() => [])) {
		expect(name.endsWith(".tmp")).toBe(false);
	}
	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("FIRST");
});
for (const [shape, plant] of [
	["an empty file", async (at: string) => await Bun.write(at, "")],
	["a directory", async (at: string) => await fs.mkdir(at, { recursive: true })],
] as const) {
	test(`a resume that refused over ${shape} refuses again rather than opening the session without it`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await Bun.write(path.join(liveArtifacts, "b.log"), "SECOND");
		await archiveEverything();
		await halfRestore();
		// What a restore killed part-way leaves: one artifact carried home,
		// and in the other's place something it refused to write over.
		await fs.mkdir(liveArtifacts, { recursive: true });
		await plant(path.join(liveArtifacts, "b.log"));

		const resume = async (): Promise<void> => {
			const manager = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), {
				suppressBreadcrumb: true,
			});
			await manager.close();
		};
		await expect(resume()).rejects.toThrow();
		// The second identical attempt is the one that matters: a user who
		// retries and is told nothing believes the session came home.
		await expect(resume()).rejects.toThrow();

		expect(await Bun.file(path.join(archivedArtifacts, "b.log")).text()).toBe("SECOND");
	});
}

test("a live file rewritten in place while it is being archived does not change what is archived", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	const live = path.join(liveArtifacts, "tool.log");
	await Bun.write(live, "FIRST");

	// Same length, same inode, and on a one-second-resolution filesystem the
	// same size, mtime, ctime and device too — there is no stat comparison
	// that sees this. The copy does not need one: it publishes the bytes it
	// read and digested.
	const realLink = fs.link;
	const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
		if (String(to).endsWith("tool.log")) {
			const writer = await fs.open(live, "r+");
			await writer.write(Buffer.from("WRONG"), 0, 5, 0);
			await writer.close();
		}
		await realLink(from, to);
	});
	let result: GcResult;
	try {
		result = await archiveOnly();
	} finally {
		link.mockRestore();
	}

	expect(result.archive?.archived).toBe(1);
	expect(result.archive?.errors).toEqual([]);
	// Either reading is defensible; publishing `WRONG` and calling it a copy
	// of what was read is not.
	expect(await Bun.file(path.join(archivedArtifacts, "tool.log")).text()).toBe("FIRST");
	expect(await Bun.file(live).text()).toBe("WRONG");
});

test("a staging name rebound to someone else's file is left alone, not deleted", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "FIRST");
	const theirs = path.join(root, "theirs.log");
	await Bun.write(theirs, "WRONG");

	// The staging path is rebound to a file whose bytes exist nowhere else,
	// after the entry is published and before the cleanup runs. Removing a
	// path by its name is how that file dies.
	const realLink = fs.link;
	const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
		await realLink(from, to);
		if (!String(from).includes("tool.log")) return;
		await fs.rm(String(from), { force: true });
		await realLink(theirs, String(from));
	});
	let result: GcResult;
	try {
		result = await archiveOnly();
	} finally {
		link.mockRestore();
	}

	expect(await Bun.file(theirs).text()).toBe("WRONG");
	expect(result.archive?.errors.join("\n")).toContain("is not what this run staged there");
});

test("a staging close that fails still leaves no temp behind", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "FIRST");

	const realOpen = fs.open;
	const open = spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
		const handle = await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
		if (!isStagedFile(String(target))) return handle;
		const realClose = handle.close.bind(handle);
		handle.close = (async () => {
			await realClose();
			throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
		}) as typeof handle.close;
		return handle;
	}) as typeof fs.open);
	try {
		await archiveEverything();
	} finally {
		open.mockRestore();
	}

	for (const name of await fs.readdir(archivedArtifacts).catch(() => [])) {
		expect(name.endsWith(".tmp")).toBe(false);
	}
});
test("a preview that would give up the session says so rather than reporting nothing", async () => {
	const archive = await archiveOnly();
	expect(archive.archive?.archived).toBe(1);

	const preview = await runGcCommand({
		flags: { agentDir: root, reclaim: archiveFile, forwardOnly: true, json: true },
	});

	// "would give up nothing" is the refusal's wording; a preview with
	// nothing to refuse printing it tells the reader the opposite of what
	// applying would do.
	expect(preview.reclaim?.errors).toEqual([]);
	expect(preview.reclaim?.wouldReclaim).toBe(1);
	expect(renderGcText(preview)).toContain(`reclaim: would move ${sessionFile} into the archive`);
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

test("a reclaim whose transcript is already gone names the artifact tree it leaves", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "FIRST");
	await archiveOnly();
	// Someone removed the transcript by hand. The artifact tree — usually
	// the larger half — is still there.
	await fs.unlink(sessionFile);

	const result = await runGcCommand({
		flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
	});

	expect(result.reclaim?.keptArtifactTree).toBe(liveArtifacts);
	expect(collectGcErrors(result).join("\n")).toContain("its live artifact tree is still there");
	expect(renderGcText(result)).toContain(`reclaim kept the live artifact tree: ${liveArtifacts}`);
	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("FIRST");
});

for (const apply of [false, true]) {
	test(`a session tree that cannot be listed is reported as that, not as an owner (${apply ? "apply" : "preview"})`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const sub = sessionBody(sessionId("029b1eee0f4d"), "SUB", root);
		await Bun.write(path.join(liveArtifacts, "sub.jsonl"), sub);
		await archiveOnly();

		const realScan = Bun.Glob.prototype.scan;
		const scan = spyOn(Bun.Glob.prototype, "scan").mockImplementation(function (
			this: InstanceType<typeof Bun.Glob>,
			options?: Parameters<typeof realScan>[0],
		) {
			const cwd = typeof options === "string" ? options : options?.cwd;
			if (String(cwd ?? "").startsWith(liveArtifacts)) {
				throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
			}
			return realScan.call(this, options as never);
		});
		let result: GcResult;
		try {
			result = await runGcCommand({
				flags: { agentDir: root, reclaim: archiveFile, apply, forwardOnly: true, json: true },
			});
		} finally {
			scan.mockRestore();
		}

		// Telling the reader to close a process that does not exist is a
		// refusal they cannot act on, and the preview must report it rather
		// than throwing past the result the command renders.
		const errors = collectGcErrors(result).join("\n");
		expect(errors).toContain("could not be listed");
		expect(errors).not.toContain("a running process owns");
		expect(result.reclaim?.reclaimed).toBe(0);
		expect(await Bun.file(sessionFile).exists()).toBe(true);
	});
}

test("a printed recovery command survives an agent directory with a space in it", async () => {
	const spaced = path.join(root, "agent dir");
	await fs.mkdir(path.join(getSessionsDir(spaced), "--work--"), { recursive: true });
	const name = `2026-01-01T00-00-00-000Z_${sessionId("029b1eee0f4e")}.jsonl`;
	const spacedSession = path.join(getSessionsDir(spaced), "--work--", name);
	await Bun.write(spacedSession, sessionBody(sessionId("029b1eee0f4e"), PROMPT, spaced));
	const old = new Date(Date.now() - 30 * 86_400_000);
	await fs.utimes(spacedSession, old, old);
	await archiveOnly(spaced);
	const spacedArchive = path.join(getArchivedSessionsDir(spaced), "--work--", `${name}.gz`);
	// Advanced past the archive, so the reclaim refuses and prints the way back.
	await Bun.write(spacedSession, `${await Bun.file(spacedSession).text()}${JSON.stringify({ type: "late" })}\n`);

	const result = await runGcCommand({
		flags: { agentDir: spaced, reclaim: spacedArchive, apply: true, forwardOnly: true, json: true },
	});

	// One shell word, or the reader's terminal looks in "…/agent" and the
	// recovery reports success for a session it never touched.
	expect(collectGcErrors(result).join("\n")).toContain(`--agent-dir '${spaced}'`);
});
test("a FIFO where an artifact belongs is refused rather than waited on", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ARCHIVED");
	await archiveEverything();
	await halfRestore();
	await fs.mkdir(liveArtifacts, { recursive: true });
	await Bun.spawn(["mkfifo", path.join(liveArtifacts, "tool.log")]).exited;

	// An ordinary read-only open of a FIFO waits for a writer that never
	// comes; this test would then end as a timeout rather than a refusal.
	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.notRestored.join("\n")).toContain("is a FIFO, not a regular file");
});

test("a tool output the session empties after a restore does not refuse the next resume", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ORIGINAL");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	// The session carries on and truncates its own tool output. The archive
	// still holds eight bytes at that path; a size test reads that as an
	// unfinished restore and refuses to open a session nothing is wrong with.
	await Bun.write(path.join(liveArtifacts, "tool.log"), "");

	const manager = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
	await manager.close();

	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("");
});

test("an entry that is empty in the archive restores and opens", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "empty.log"), "");
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ORIGINAL");
	await archiveEverything();

	const materialized = await materializeSessionFile(archiveFile, root);

	expect(materialized).toBe(sessionFile);
	expect(await Bun.file(path.join(liveArtifacts, "empty.log")).exists()).toBe(true);
	expect(await fs.stat(path.join(liveArtifacts, "empty.log"))).toHaveProperty("size", 0);
	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("ORIGINAL");
});

test("archiving a session again leaves a restore record an earlier attempt left, and says so", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "FIRST");
	await archiveEverything();
	await halfRestore();
	await Bun.write(path.join(liveArtifacts, "tool.log"), "FIRST");
	const record = restoreRecordPath(archiveFile);
	const before = await fs.lstat(record);

	const result = await archiveOnly();

	// The archive is the live session's own copy again, but the record is
	// not this run's to remove: what it holds says nothing of who wrote it.
	expect(result.archive?.archived).toBe(1);
	expect(result.archive?.errors.join("\n")).toContain(`${record} records a restore that did not finish`);
	const after = await fs.lstat(record);
	expect([after.ino, after.size]).toEqual([before.ino, before.size]);
	await fs.rename(record, path.join(root, "record-moved-aside"));
	const manager = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
	await manager.close();
});
for (const [shape, plant] of [
	["a different file", async (at: string, foreign: string) => await fs.link(foreign, at)],
	["a symlink", async (at: string, foreign: string) => await fs.symlink(foreign, at)],
	["a FIFO", async (at: string) => void (await Bun.spawn(["mkfifo", at]).exited)],
] as const) {
	test(`a staged artifact replaced by ${shape} before it is published does not become the archived copy`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
		await Bun.write(path.join(liveArtifacts, "tool.log"), "FIRST");
		const foreign = path.join(root, "foreign.log");
		await Bun.write(foreign, "WRONG");

		// The stage is taken off this run's file and the name given to
		// something else, between the copy and the publication. Publishing a
		// name rather than what was digested archives whatever is there.
		const realLink = fs.link;
		let swapped = false;
		const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
			if (!swapped && String(from).includes("tool.log") && isStagedFile(String(from))) {
				swapped = true;
				await fs.rename(String(from), `${String(from)}.original`);
				await plant(String(from), foreign);
			}
			await realLink(from, to);
		});
		let result: GcResult;
		try {
			result = await archiveOnly();
		} finally {
			link.mockRestore();
		}

		expect(result.archive?.archived).toBe(0);
		expect(await Bun.file(path.join(archivedArtifacts, "tool.log")).exists()).toBe(false);
		expect(await Bun.file(foreign).text()).toBe("WRONG");
		expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("FIRST");
	});
}

// Same inode, same length: device, inode, size and both timestamps can all
// agree afterwards. Only the bytes say what happened, which is why the
// publication is read back and digested rather than identified. The run's
// own file, holding bytes it did not write, is not taken back from its
// archived name: those bytes are in no other copy, and the archived name is
// one any process of this user can write by. It stays, named, and the
// session is not counted archived.
test("a staged artifact rewritten in place before it is published is not counted archived, and is left at its name and named", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "FIRST");

	const realLink = fs.link;
	let rewritten = false;
	const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
		if (!rewritten && String(from).includes("tool.log") && isStagedFile(String(from))) {
			rewritten = true;
			const writer = await fs.open(String(from), "r+");
			await writer.write(Buffer.from("WRONG"), 0, 5, 0);
			await writer.close();
		}
		await realLink(from, to);
	});
	let result: GcResult;
	try {
		result = await archiveOnly();
	} finally {
		link.mockRestore();
	}

	const archived = path.join(archivedArtifacts, "tool.log");
	expect(rewritten).toBe(true);
	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(archived).text()).toBe("WRONG");
	expect(collectGcErrors(result).join("\n")).toContain(`${archived} is not what this run published there`);
	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("FIRST");
});

test("a transcript stage replaced before it is published leaves the archive unwritten", async () => {
	const foreign = path.join(root, "foreign.jsonl.gz");
	await Bun.write(foreign, Bun.gzipSync(Buffer.from("NOT A SESSION\n")));

	const realLink = fs.link;
	let swapped = false;
	const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
		if (!swapped && isStagedFile(String(from))) {
			swapped = true;
			await fs.rename(String(from), `${String(from)}.original`);
			await realLink(foreign, String(from));
		}
		await realLink(from, to);
	});
	let result: GcResult;
	try {
		result = await archiveOnly();
	} finally {
		link.mockRestore();
	}

	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(archiveFile).exists()).toBe(false);
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

test("a restored transcript that is not what the restore wrote is reported, not announced as restored", async () => {
	await archiveEverything();
	const foreign = path.join(root, "foreign.jsonl");
	await Bun.write(foreign, "NOT A SESSION\n");

	const realLink = fs.link;
	let swapped = false;
	const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
		if (!swapped && isStagedFile(String(from))) {
			swapped = true;
			await fs.rename(String(from), `${String(from)}.original`);
			await realLink(foreign, String(from));
		}
		await realLink(from, to);
	});
	try {
		await expect(restoreArchivedSession(archiveFile, root)).rejects.toThrow();
	} finally {
		link.mockRestore();
	}

	expect(await Bun.file(foreign).text()).toBe("NOT A SESSION\n");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("re-archiving an incompletely restored session keeps the record and says why", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "kept.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "only-archived.log"), "ONLY ARCHIVED");
	await archiveEverything();
	// What an interrupted restore leaves: the transcript and one artifact
	// home, the other still only in the archive, and the record still down.
	await halfRestore();
	await fs.mkdir(liveArtifacts, { recursive: true });
	await Bun.write(path.join(liveArtifacts, "kept.log"), "FIRST");

	const result = await archiveOnly();

	// Clearing the record because a later command ran would let the next
	// ordinary resume open this session without the artifact it never
	// carried home.
	expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(true);
	expect(result.archive?.errors.join("\n")).toContain("still missing");
	// The resume brings the missing artifact home, sets the killed run's
	// record aside, and opens the session.
	expect(await materializeSessionFile(sessionFile, root)).toBe(sessionFile);
	expect(await Bun.file(path.join(liveArtifacts, "only-archived.log")).text()).toBe("ONLY ARCHIVED");
	expect(await fs.lstat(restoreRecordPath(archiveFile)).catch(() => undefined)).toBeUndefined();
});

test("a restore whose record cannot be written releases the leases it took", async () => {
	await archiveEverything();
	// The record is created exclusively at its name; the failure is injected
	// where it is made.
	const record = restoreRecordPath(archiveFile);
	const realOpen = fs.open;
	const open = spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (String(target) === record && rest[0] === "wx") {
			throw Object.assign(new Error("ENOSPC: injected"), { code: "ENOSPC" });
		}
		return await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
	}) as typeof fs.open);
	try {
		await expect(restoreArchivedSession(archiveFile, root)).rejects.toThrow("ENOSPC");
	} finally {
		open.mockRestore();
	}

	// A lease held past the failure makes every later attempt report that a
	// running process owns the session — this one's own handle.
	const lease = tryAcquireSessionLease(SESSION_ID);
	expect(lease).not.toBeNull();
	lease?.release();
});

/**
 * Put a subagent transcript into both trees the first time the reclaim reads
 * the live artifact directory — after the leases were taken, before the walk
 * proves anything — the way a child that joins mid-run arrives.
 */
function joinChildOnFirstWalk(childId: string, body: string, onJoin: () => void = () => {}) {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	const realReaddir = fs.readdir;
	let joined = false;
	return spyOn(fs, "readdir").mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (!joined && String(target) === liveArtifacts) {
			joined = true;
			await Bun.write(path.join(liveArtifacts, "child.jsonl"), body);
			await Bun.write(path.join(archivedArtifacts, "child.jsonl"), body);
			onJoin();
		}
		return await (realReaddir as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
	}) as typeof fs.readdir);
}

for (const apply of [false, true]) {
	test(`a subagent that joins under its own lease after the tree was listed stops the reclaim (${apply ? "apply" : "preview"})`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await archiveEverything();
		await restoreArchivedSession(archiveFile, root);
		const childId = sessionId("029b1eee0f4c");
		const child = path.join(liveArtifacts, "child.jsonl");
		const body = sessionBody(childId, "UNIQUE CHILD TURN", root);

		// The archive holds the child's bytes, so every proof passes. What
		// the proof cannot cover is the turn the child takes after it: the
		// child holds its own lease, and nothing short of not taking what a
		// live lease covers keeps that turn.
		const held: { lease?: FileLockHandle | null } = {};
		const readdir = joinChildOnFirstWalk(childId, body, () => {
			held.lease = tryAcquireSessionLease(childId);
		});
		let result: GcResult;
		try {
			result = await runGcCommand({
				flags: { agentDir: root, reclaim: archiveFile, apply, forwardOnly: true, json: true },
			});
		} finally {
			readdir.mockRestore();
			held.lease?.release();
		}

		expect(held.lease).toBeTruthy();
		expect(result.reclaim?.reclaimed).toBe(0);
		expect(result.reclaim?.wouldReclaim).toBeUndefined();
		expect(result.reclaim?.errors.join("\n")).toContain(`a running process owns ${child}`);
		expect(await Bun.file(child).text()).toBe(body);
		expect(await Bun.file(sessionFile).exists()).toBe(true);
	});
}

test("a reclaim holds the lease of every transcript it moves until it has moved", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	const childId = sessionId("029b1eee0f4c");

	// A child that joined and is gone: a dead owner writes nothing late, so
	// its file may move — but only while nothing can claim it in between.
	const readdir = joinChildOnFirstWalk(childId, sessionBody(childId, "CHILD TURN", root));
	const realMove = libcModule.renameNoReplace;
	let claimable: boolean | undefined;
	const move = spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		if (claimable === undefined && from === liveArtifacts) {
			const claim = tryAcquireSessionLease(childId);
			claimable = claim !== null;
			claim?.release();
		}
		return await realMove(from, to);
	});
	let result: GcResult;
	try {
		result = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
	} finally {
		move.mockRestore();
		readdir.mockRestore();
	}

	expect(result.reclaim?.errors).toEqual([]);
	expect(result.reclaim?.reclaimed).toBe(1);
	expect(claimable).toBe(false);
});

test("a link a reclaim would once have replaced by a file is kept and named, and nothing is unlinked", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "b.log"), "SECOND");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	// A link onto the archive's own copy: the walk refuses it before anything
	// goes, so the replacement this test once raced against never happens.
	await fs.rm(path.join(liveArtifacts, "b.log"));
	await fs.symlink(path.join(archivedArtifacts, "b.log"), path.join(liveArtifacts, "b.log"));
	const unlinked: string[] = [];
	const realUnlink = fs.unlink;
	const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
		unlinked.push(String(target));
		await realUnlink(target);
	});
	let result: GcResult;
	try {
		result = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
	} finally {
		unlink.mockRestore();
	}

	// The gc lock's own file goes as the run ends; nothing of the session does.
	expect(
		unlinked.filter(
			gone =>
				gone === sessionFile || isMovedAside(gone, sessionFile) || gone.startsWith(`${liveArtifacts}${path.sep}`),
		),
	).toEqual([]);
	expect(result.reclaim?.reclaimed).toBe(0);
	expect(result.reclaim?.errors.join("\n")).toContain(
		`${path.join(liveArtifacts, "b.log")} is a symbolic link, which a reclaim does not give up`,
	);
	expect(await fs.readlink(path.join(liveArtifacts, "b.log"))).toBe(path.join(archivedArtifacts, "b.log"));
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

for (const site of ["an archived artifact", "an archived transcript", "a restored transcript", "a restored artifact"]) {
	for (const moment of ["as it is opened", "after it was read"]) {
		test(`${site} whose name is rebound ${moment} to be read back is not taken as published`, async () => {
			const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
			const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
			await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
			const restoring = site.startsWith("a restored");
			if (restoring) await archiveEverything();
			const target = {
				"an archived artifact": path.join(archivedArtifacts, "a.log"),
				"an archived transcript": archiveFile,
				"a restored transcript": sessionFile,
				"a restored artifact": path.join(liveArtifacts, "a.log"),
			}[site] as string;

			// Somebody else's regular file put at the canonical name while
			// this run's descriptor still holds the inode it published: the
			// descriptor reads right and the name is wrong.
			let published = false;
			let rebound = false;
			const rebind = async (): Promise<void> => {
				rebound = true;
				await fs.rename(target, path.join(root, "published-aside"));
				await Bun.write(target, "WRONG");
			};
			const realLink = fs.link;
			const realOpen = fs.open;
			const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
				await realLink(from, to);
				if (String(to) === target) published = true;
			});
			const open = spyOn(fs, "open").mockImplementation((async (
				file: string,
				flags: unknown,
				...rest: unknown[]
			) => {
				const handle = await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(file, flags, ...rest);
				const readBack = typeof flags === "number" && (flags & fsConstants.O_NONBLOCK) !== 0;
				if (!published || rebound || !readBack || String(file) !== target) return handle;
				if (moment === "as it is opened") {
					await rebind();
				} else {
					const close = handle.close.bind(handle);
					handle.close = (async () => {
						await close();
						if (!rebound) await rebind();
					}) as typeof handle.close;
				}
				return handle;
			}) as typeof fs.open);
			let archived: number | undefined;
			let notRestored: string[] | undefined;
			let failure: unknown;
			try {
				if (restoring) notRestored = (await restoreArchivedSession(archiveFile, root)).notRestored;
				else archived = (await archiveOnly()).archive?.archived;
			} catch (error) {
				failure = error;
			} finally {
				open.mockRestore();
				link.mockRestore();
			}

			expect(rebound).toBe(true);
			// The name holds somebody else's file, and it stays theirs.
			expect(await Bun.file(target).text()).toBe("WRONG");
			if (!restoring) {
				expect(archived).toBe(0);
			} else if (site === "a restored transcript") {
				expect(failure).toBeDefined();
				expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(true);
			} else {
				expect(notRestored?.length).toBeGreaterThan(0);
			}
		});
	}
}

test("an earlier archived copy that cannot be put back says so instead of reading it through a link", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveOnly();
	// The session carried on, so the next archive supersedes the shorter copy.
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST APPENDED");
	const target = path.join(archivedArtifacts, "a.log");
	const aside = path.join(root, "copied-aside");

	const realLink = fs.link;
	const realRename = fs.rename;
	const realMove = libcModule.renameNoReplace;
	let links = 0;
	let putBack = 0;
	// The superseding copy is spoiled once it lands, so the run puts back what
	// it moved aside — and that is taken off the name and replaced by a link
	// onto the very bytes the run put back.
	const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
		await realLink(from, to);
		if (String(to) !== target) return;
		links += 1;
		if (links === 1) await Bun.write(target, "WRONG");
	});
	const move = spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		const moved = await realMove(from, to);
		if (to === target && moved.outcome === "renamed") {
			putBack += 1;
			await realRename(target, aside);
			await fs.symlink(aside, target);
		}
		return moved;
	});
	let result: GcResult;
	try {
		result = await archiveOnly();
	} finally {
		link.mockRestore();
		move.mockRestore();
	}

	expect(links).toBe(1);
	expect(putBack).toBe(1);
	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.errors.join("\n")).toContain(`${target} could not be put back`);
	expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
	expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("FIRST APPENDED");
});

test("a FIFO where an outstanding artifact belongs does not clear the restore record", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "kept.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "only-archived.log"), "ONLY ARCHIVED");
	await archiveEverything();
	await halfRestore();
	await fs.mkdir(liveArtifacts, { recursive: true });
	await Bun.write(path.join(liveArtifacts, "kept.log"), "FIRST");
	// Something stands at the name, and it is not the artifact: a reader of
	// it waits for a writer instead of reading the archived bytes.
	expect(await Bun.spawn(["mkfifo", path.join(liveArtifacts, "only-archived.log")]).exited).toBe(0);

	const result = await archiveOnly();

	expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(true);
	expect(result.archive?.errors.join("\n")).toContain("still missing");
});

test("a staging name that is always taken fails the restore instead of retrying for ever", async () => {
	await archiveEverything();
	const realMkdir = fs.mkdir;
	let attempts = 0;
	const mkdir = spyOn(fs, "mkdir").mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (/^\..+\.[0-9a-f]{16}\.tmp$/.test(path.basename(String(target)))) {
			attempts += 1;
			// The test's own cap, so a retry with no bound fails here rather
			// than hanging the run.
			if (attempts > 1000) throw Object.assign(new Error("EIO: runaway retry"), { code: "EIO" });
			throw Object.assign(new Error("EEXIST: injected"), { code: "EEXIST" });
		}
		return await (realMkdir as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
	}) as typeof fs.mkdir);
	let failure: unknown;
	try {
		await restoreArchivedSession(archiveFile, root);
	} catch (error) {
		failure = error;
	} finally {
		mkdir.mockRestore();
	}

	expect(failure).toBeDefined();
	expect(String(failure)).not.toContain("runaway retry");
	expect(attempts).toBeLessThan(1000);
	expect(await Bun.file(sessionFile).exists()).toBe(false);
});

test("a rollback that cannot look at an entry it made says so", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "z.log"), "LAST");
	const archivedA = path.join(archivedArtifacts, "a.log");

	// `a.log` is published, `z.log` fails, and the rollback cannot look at
	// what it would take back. "It was not there" and "I could not tell" are
	// different answers.
	const realLink = fs.link;
	const realLstat = fs.lstat;
	let rollingBack = false;
	let looked = false;
	const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
		if (String(to) === path.join(archivedArtifacts, "z.log")) {
			rollingBack = true;
			throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
		}
		await realLink(from, to);
	});
	const lstat = spyOn(fs, "lstat").mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (rollingBack && !looked && String(target) === archivedA) {
			looked = true;
			throw Object.assign(new Error("EIO: cannot look"), { code: "EIO" });
		}
		return await (realLstat as (...args: unknown[]) => Promise<Stats>)(target, ...rest);
	}) as typeof fs.lstat);
	let result: GcResult;
	try {
		result = await archiveOnly();
	} finally {
		lstat.mockRestore();
		link.mockRestore();
	}

	expect(looked).toBe(true);
	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.errors.join("\n")).toContain(`${archivedA} could not be looked at`);
	expect(await Bun.file(archivedA).text()).toBe("FIRST");
});

for (const how of ["moved aside", "deleted"] as const) {
	test(`a reclaim keeps a transcript that took the session's name after the original was ${how}`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await archiveEverything();
		await restoreArchivedSession(archiveFile, root);
		// Somebody else's session, put at the root name while the tree below
		// it was being proved: the root is looked at before that proof and
		// goes first after it, and it has to be the file that was proved, not
		// whatever wears its name by then.
		const foreign = sessionBody(sessionId("029b1eee0f4d"), "UNIQUE FOREIGN TURN", root);
		const realOpen = fs.open;
		let rebound = false;
		const open = spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
			if (!rebound && String(target) === path.join(liveArtifacts, "a.log")) {
				rebound = true;
				if (how === "moved aside") await fs.rename(sessionFile, path.join(root, "aside.jsonl"));
				else await fs.unlink(sessionFile);
				await Bun.write(sessionFile, foreign);
			}
			return await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
		}) as typeof fs.open);
		let result: GcResult;
		try {
			result = await runGcCommand({
				flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
			});
		} finally {
			open.mockRestore();
		}

		expect(rebound).toBe(true);
		expect(result.reclaim?.reclaimed).toBe(0);
		expect(result.reclaim?.moved).toBeUndefined();
		expect(await Bun.file(sessionFile).text()).toBe(foreign);
		expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("FIRST");
	});
}

test("a recorded staging directory that could not be cleared is not carried home as an artifact", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	// A run's recorded stage with somebody else's file beside it: cleanup
	// leaves both and keeps the record, so the directory is still residue.
	const ground = await mintStagingGround(path.join(archivedArtifacts, "b.log"), stagingLedgerDir(root));
	await ground.handle.writeFile("HALF A COPY");
	await abandonGround(ground);
	await Bun.write(path.join(ground.dir, "planted"), "PLANTED");

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.notRestored.join("\n")).toContain(ground.dir);
	expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
	expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(true);
	expect(await Bun.file(path.join(ground.dir, "planted")).text()).toBe("PLANTED");
});

test("a staging directory a run recorded only its intent for is left and not carried home", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	// A run killed after recording what it was about to make and before it
	// knew the staged file's inode: the directory and an empty file.
	const dir = sessionStagingPath(path.join(archivedArtifacts, "b.log"));
	const file = path.join(dir, "b.log");
	await fs.mkdir(dir, { mode: 0o700 });
	await Bun.write(file, "");
	await Bun.write(path.join(stagingLedgerDir(root), "1.json"), JSON.stringify({ dir, file }));

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.notRestored.join("\n")).toContain(dir);
	expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(true);
	expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
	expect(await Bun.file(file).exists()).toBe(true);
});

test("a record with a hand-made directory's real identity deletes nothing anywhere", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	// Every check a record can be put to passes — the name, the place, the
	// inode — and nothing about it says a run made this directory.
	const dir = path.join(archivedArtifacts, ".work.0123456789abcdef.tmp");
	await Bun.write(path.join(dir, "work"), "CUSTOMER WORK");
	await Bun.write(path.join(dir, "other"), "CUSTOMER OTHER");
	await plantStagingRecord(dir, path.join(dir, "work"));

	await restoreArchivedSession(archiveFile, root);
	await archiveOnly();

	expect(await Bun.file(path.join(dir, "work")).text()).toBe("CUSTOMER WORK");
	expect(await Bun.file(path.join(dir, "other")).text()).toBe("CUSTOMER OTHER");
});

// Tightened after it was archived: a copy would come back readable by more
// than the file it replaced. A reclaim moves the file itself, so the restore
// gives back the very file with its own tighter mode.
for (const which of ["an artifact", "the transcript"] as const) {
	test(`a reclaim moves ${which} tightened after archiving, and the restore gives back its own mode`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await fs.chmod(sessionFile, 0o644);
		await fs.chmod(path.join(liveArtifacts, "a.log"), 0o644);
		await archiveOnly();
		const live = which === "an artifact" ? path.join(liveArtifacts, "a.log") : sessionFile;
		await fs.chmod(live, 0o600);
		const inode = (await fs.stat(live)).ino;

		await reclaimThenRestore();

		expect((await fs.stat(live)).mode & 0o777).toBe(0o600);
		expect((await fs.stat(live)).ino).toBe(inode);
	});
}

/** Set the extended attribute `user.omp_test` on `target` — see `helpers/xattr.ts` for why not through Python. */
function setTestXattr(target: string, value: string): void {
	setXattr(target, "user.omp_test", value);
}

/** The value of `user.omp_test` on `target`, or undefined when it has none. */
function testXattr(target: string): string | undefined {
	return getXattr(target, "user.omp_test");
}

/**
 * A process of its own that opens `file` for append and holds it, the way a
 * background job keeps its log open; `finish` has it write `text` through
 * that descriptor and exit, and resolves with its exit status. Started from
 * this process's own executable: `python3` here was mise's shim in an agent
 * session, which took 2.6 to 10 seconds a start on a loaded machine, and with
 * it this test took 28 seconds where it now takes one or two.
 */
async function heldOpenForAppend(file: string, text: string): Promise<{ pid: number; finish(): Promise<number> }> {
	const script =
		'import * as fs from "node:fs";\nconst fd = fs.openSync(process.env.HOLD_FILE ?? "", "a");\n' +
		'console.log("READY");\nfor await (const _ of console) {\n' +
		'\tfs.writeSync(fd, process.env.HOLD_TEXT ?? "");\n\tfs.fsyncSync(fd);\n\tfs.closeSync(fd);\n\tbreak;\n}\n';
	const child = Bun.spawn([process.execPath, "-e", script], {
		env: { ...process.env, HOLD_FILE: file, HOLD_TEXT: text },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = child.stdout.getReader();
	let said = "";
	while (!said.includes("READY")) {
		const chunk = await reader.read();
		if (chunk.done)
			throw new Error(`the writer exited before opening ${file}: ${await new Response(child.stderr).text()}`);
		said += new TextDecoder().decode(chunk.value);
	}
	reader.releaseLock();
	return {
		pid: child.pid,
		finish: async () => {
			child.stdin.write("go\n");
			await child.stdin.end();
			return await child.exited;
		},
	};
}

// A writer that opened a file before the reclaim keeps writing through its
// descriptor whatever happens to the name; a reclaim that unlinked the file
// left those writes in an inode nothing names, and the restore after it
// brought back only what the archive held.
for (const which of ["an artifact", "the transcript"] as const) {
	test(`a reclaim keeps ${which} another process holds open, and what it writes afterwards stays`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await archiveOnly();
		const target = which === "an artifact" ? path.join(liveArtifacts, "a.log") : sessionFile;
		const before = await fs.readFile(target);
		const tail =
			which === "an artifact"
				? "UNIQUE LATE OUTPUT"
				: `${JSON.stringify({ type: "message", id: "m3", parentId: "m2", message: { role: "user", content: "UNIQUE LATE TURN" } })}\n`;
		const writer = await heldOpenForAppend(target, tail);

		const result = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
		const writerExit = await writer.finish();

		expect(writerExit).toBe(0);
		expect(result.reclaim?.reclaimed).toBe(0);
		expect(result.reclaim?.moved).toBeUndefined();
		expect(result.reclaim?.errors.join("\n")).toContain(`process ${writer.pid}`);
		expect(await fs.readFile(target).catch(() => undefined)).toEqual(Buffer.concat([before, Buffer.from(tail)]));
	}, 60_000);
}

test("a reclaim does not remove an empty directory put in place of the tree it proved", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveOnly();
	const foreign = path.join(root, "foreign-empty");
	await fs.mkdir(foreign, { mode: 0o700 });
	setTestXattr(foreign, "ONLY DIRECTORY METADATA");
	const marked = (await fs.lstat(foreign)).ino;
	const proved = path.join(root, "proved-tree");
	// Whatever the last call naming the tree is — the removal's own — the
	// directory at that name is swapped for the marked one just before it.
	const realRename = fs.rename;
	const realRmdir = fs.rmdir;
	let swapped = false;
	const swap = async (target: string): Promise<void> => {
		if (swapped || target !== liveArtifacts) return;
		swapped = true;
		await realRename(liveArtifacts, proved);
		await realRename(foreign, liveArtifacts);
	};
	const realMove = libcModule.renameNoReplace;
	spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		await swap(from);
		return await realMove(from, to);
	});
	spyOn(fs, "rename").mockImplementation(async (from, to) => {
		await swap(String(from));
		return await realRename(from, to);
	});
	spyOn(fs, "rmdir").mockImplementation((async (target: string, ...rest: unknown[]) => {
		await swap(String(target));
		return await (realRmdir as (...args: unknown[]) => Promise<void>)(target, ...rest);
	}) as typeof fs.rmdir);

	const result = await runGcCommand({
		flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
	});
	mock.restore();

	expect(swapped).toBe(true);
	expect((await fs.lstat(liveArtifacts).catch(() => undefined))?.ino).toBe(marked);
	expect(testXattr(liveArtifacts)).toBe("ONLY DIRECTORY METADATA");
	expect(result.reclaim?.reclaimed).toBe(0);
	expect(result.reclaim?.errors.join("\n")).toContain(liveArtifacts);
}, 60_000);

test("an archive that fails does not remove a directory put in place of one it made", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedNested = path.join(archiveFile.slice(0, -".jsonl.gz".length), "nested");
	await fs.mkdir(path.join(liveArtifacts, "nested"), { recursive: true, mode: 0o700 });
	await fs.chmod(path.join(liveArtifacts, "nested"), 0o700);
	await Bun.write(path.join(liveArtifacts, "nested", "a.log"), "FIRST");
	const foreign = path.join(root, "foreign-empty");
	await fs.mkdir(foreign, { mode: 0o700 });
	await fs.chmod(foreign, 0o700);
	setTestXattr(foreign, "ONLY DIRECTORY METADATA");
	const marked = (await fs.lstat(foreign)).ino;
	// The archive's `mkdir` of the archived directory, then the marked
	// directory swapped in before the archive looks at what it made.
	const realMkdir = fs.mkdir;
	let swapped = false;
	spyOn(fs, "mkdir").mockImplementation((async (target: string, ...rest: unknown[]) => {
		const made = await (realMkdir as (...args: unknown[]) => Promise<string | undefined>)(target, ...rest);
		if (!swapped && String(target) === archivedNested) {
			swapped = true;
			await fs.rename(archivedNested, path.join(root, "made-by-archive"));
			await fs.rename(foreign, archivedNested);
		}
		return made;
	}) as typeof fs.mkdir);
	// And then the copy into it fails, so the archive takes back what it made.
	failStagingWrite(isStagingUnder(archivedNested));

	const result = await archiveOnly();
	mock.restore();

	expect(swapped).toBe(true);
	expect(result.archive?.errors.length).toBeGreaterThan(0);
	expect((await fs.lstat(archivedNested).catch(() => undefined))?.ino).toBe(marked);
	expect(testXattr(archivedNested)).toBe("ONLY DIRECTORY METADATA");
}, 60_000);

// The archive copies bytes and modes, not extended attributes. A reclaim
// moves the entry itself, so the restore gives back the very entry with them.
for (const which of ["an artifact", "an artifact directory", "the transcript"] as const) {
	test(`a reclaim moves ${which} carrying extended attributes, and the restore gives them back`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "nested", "a.log"), "FIRST");
		const target =
			which === "an artifact"
				? path.join(liveArtifacts, "nested", "a.log")
				: which === "an artifact directory"
					? path.join(liveArtifacts, "nested")
					: sessionFile;
		setTestXattr(target, "ONLY ATTRIBUTE VALUE");
		const inode = (await fs.stat(target)).ino;
		await archiveOnly();

		await reclaimThenRestore();

		expect(testXattr(target)).toBe("ONLY ATTRIBUTE VALUE");
		expect((await fs.stat(target)).ino).toBe(inode);
		expect(await Bun.file(path.join(liveArtifacts, "nested", "a.log")).text()).toBe("FIRST");
	}, 60_000);
}

test("archiving into an archived directory more readable than the live one narrows it", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const live = path.join(liveArtifacts, "private");
	const archived = path.join(archiveFile.slice(0, -".jsonl.gz".length), "private");
	await Bun.write(path.join(live, "secret"), "PRIVATE ARTIFACT");
	await fs.chmod(live, 0o755);
	await archiveOnly();
	expect((await fs.stat(archived)).mode & 0o777).toBe(0o755);
	await fs.chmod(live, 0o700);

	const result = await archiveOnly();

	expect(result.archive?.errors).toEqual([]);
	expect((await fs.stat(archived)).mode & 0o777).toBe(0o700);
});

test("a reclaim moves a live directory more private than its archived copy, and the restore keeps it private", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const live = path.join(liveArtifacts, "private");
	await Bun.write(path.join(live, "secret"), "PRIVATE ARTIFACT");
	await fs.chmod(live, 0o755);
	await archiveOnly();
	// Tightened after it was archived: a copy of the archived directory would
	// come back open to more than the live one is.
	await fs.chmod(live, 0o700);
	const inode = (await fs.stat(live)).ino;

	await reclaimThenRestore();

	expect((await fs.stat(live)).mode & 0o777).toBe(0o700);
	expect((await fs.stat(live)).ino).toBe(inode);
	expect(await Bun.file(path.join(live, "secret")).text()).toBe("PRIVATE ARTIFACT");
});

test("a directory tightened after it was archived stays private through archive, reclaim and restore", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const live = path.join(liveArtifacts, "private");
	await Bun.write(path.join(live, "secret"), "PRIVATE ARTIFACT");
	await fs.chmod(live, 0o755);
	await archiveOnly();
	await fs.chmod(live, 0o700);

	const archived = await archiveOnly();
	const reclaimed = await runGcCommand({
		flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
	});
	const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

	expect(archived.archive?.errors).toEqual([]);
	expect(reclaimed.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	expect(restored.restore?.errors).toEqual([]);
	expect((await fs.stat(live)).mode & 0o777).toBe(0o700);
	expect(await Bun.file(path.join(live, "secret")).text()).toBe("PRIVATE ARTIFACT");
});

test("a restore into a live directory that already stands keeps that directory's mode", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const live = path.join(liveArtifacts, "private");
	await Bun.write(path.join(live, "kept"), "KEPT");
	await Bun.write(path.join(live, "secret"), "PRIVATE ARTIFACT");
	await fs.chmod(live, 0o755);
	await archiveOnly();
	await fs.rm(path.join(live, "secret"));
	await fs.chmod(live, 0o700);

	const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

	expect(restored.restore?.errors).toEqual([]);
	expect((await fs.stat(live)).mode & 0o777).toBe(0o700);
	expect(await Bun.file(path.join(live, "secret")).text()).toBe("PRIVATE ARTIFACT");
});

test("artifacts whose names only look like staging survive archive, reclaim and restore", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const nested = path.join(liveArtifacts, ".evidence.0123456789abcdef.tmp", "customer-artifact");
	const flat = path.join(liveArtifacts, ".version.0123456789abcdef.tmp");
	await Bun.write(nested, "CUSTOMER EVIDENCE");
	await Bun.write(flat, "VERSION 7");

	const archived = await archiveEverything();
	expect(archived.archive?.errors).toEqual([]);
	expect(await Bun.file(sessionFile).exists()).toBe(false);
	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.notRestored).toEqual([]);
	expect(await Bun.file(nested).text()).toBe("CUSTOMER EVIDENCE");
	expect(await Bun.file(flat).text()).toBe("VERSION 7");
});

test("a reclaim moves a file whose mode changed after it was proved, and the restore gives back that mode", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "b.log"), "SECOND");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	const b = path.join(liveArtifacts, "b.log");
	const inode = (await fs.stat(b)).ino;

	// Same inode, same bytes, tighter mode, changed the moment before the
	// first move: the file itself moves, so its mode does not matter.
	const realMove = libcModule.renameNoReplace;
	let changed = false;
	const rename = spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		if (!changed && from === sessionFile) {
			changed = true;
			await fs.chmod(b, 0o600);
		}
		return await realMove(from, to);
	});
	try {
		await reclaimThenRestore();
	} finally {
		rename.mockRestore();
	}

	expect(changed).toBe(true);
	expect((await fs.stat(b)).mode & 0o777).toBe(0o600);
	expect((await fs.stat(b)).ino).toBe(inode);
});

// The other three of the replacements above — a link replaced by a
// different link or a FIFO after the walk, or while it was being read — each
// assumed the reclaim would come to remove the link. It never does now: the
// walk refuses it, so nothing is unlinked and the replacement has nothing to
// race.
for (const shape of ["a different link", "a FIFO", "a link while it was being read"] as const) {
	test(`a link a reclaim would once have replaced by ${shape} is kept and named, and nothing is unlinked`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await Bun.write(path.join(liveArtifacts, "b.log"), "SECOND");
		await archiveEverything();
		await restoreArchivedSession(archiveFile, root);
		const link = path.join(liveArtifacts, "b.log");
		await fs.rm(link);
		await fs.symlink(path.join(archivedArtifacts, "b.log"), link);
		const unlinked: string[] = [];
		const realUnlink = fs.unlink;
		const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
			unlinked.push(String(target));
			await realUnlink(target);
		});
		let result: GcResult;
		try {
			result = await runGcCommand({
				flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
			});
		} finally {
			unlink.mockRestore();
		}

		// The gc lock's own file goes as the run ends; nothing of the session does.
		expect(
			unlinked.filter(
				gone =>
					gone === sessionFile ||
					isMovedAside(gone, sessionFile) ||
					gone.startsWith(`${liveArtifacts}${path.sep}`),
			),
		).toEqual([]);
		expect(result.reclaim?.reclaimed).toBe(0);
		expect(result.reclaim?.errors.join("\n")).toContain(
			`${link} is a symbolic link, which a reclaim does not give up`,
		);
		expect(await fs.readlink(link)).toBe(path.join(archivedArtifacts, "b.log"));
		expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("FIRST");
		expect(await Bun.file(sessionFile).exists()).toBe(true);
	});
}

test("staging cleanup leaves a FIFO that took the staged file's place", async () => {
	const ground = await mintStagingGround(path.join(root, "target.log"), stagingLedgerDir(root));
	await abandonGround(ground);
	await fs.unlink(ground.file);
	expect(await Bun.spawn(["mkfifo", ground.file]).exited).toBe(0);

	const note = await removeStagingGround(ground);

	expect((await fs.lstat(ground.file)).isFIFO()).toBe(true);
	expect(note).toContain("is not what this run staged there");
	await fs.rm(ground.dir, { recursive: true, force: true });
});

for (const apply of [false, true]) {
	test(`a FIFO at the live transcript's name is refused rather than waited on (${apply ? "apply" : "preview"})`, async () => {
		await archiveEverything();
		expect(await Bun.spawn(["mkfifo", sessionFile]).exited).toBe(0);

		const run = runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply, json: true } });
		// A real timer, because the defect is a blocking open on a FIFO in the
		// thread pool: no fake clock reaches it, and it raises no signal to
		// await. A passing run resolves first and pays nothing.
		const outcome = await Promise.race([run, Bun.sleep(5_000).then(() => "hung" as const)]);
		if (outcome === "hung") {
			// Give the blocked reader a writer and an end, so the run can finish
			// and release the gc lock before the next test.
			const writer = await fs.open(sessionFile, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
			await writer.close();
			await run.catch(() => undefined);
		}

		expect(outcome).not.toBe("hung");
		if (outcome !== "hung") expect(outcome.restore?.errors.length).toBeGreaterThan(0);
		expect((await fs.lstat(sessionFile)).isFIFO()).toBe(true);
	}, 15_000);
}

test("a private transcript stays private through archive, reclaim and restore", async () => {
	await fs.chmod(sessionFile, 0o600);

	await archiveEverything();
	expect((await fs.stat(archiveFile)).mode & 0o777).toBe(0o600);
	await restoreArchivedSession(archiveFile, root);

	expect((await fs.stat(sessionFile)).mode & 0o777).toBe(0o600);
});

/** A staging record written by somebody other than a run: whatever it names, with identities to match. */
async function plantStagingRecord(dir: string, file: string): Promise<void> {
	const [dirStat, fileStat] = await Promise.all([fs.stat(dir), fs.stat(file)]);
	await fs.mkdir(stagingLedgerDir(root), { recursive: true, mode: 0o700 });
	await Bun.write(
		path.join(stagingLedgerDir(root), "1.json"),
		JSON.stringify({
			dir,
			file,
			dirIdentity: { dev: dirStat.dev, ino: dirStat.ino },
			identity: { dev: fileStat.dev, ino: fileStat.ino },
		}),
	);
}

test("a planted record cannot make a restore skip, or a sweep delete, an archived directory", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "customer", "work", "doc.txt"), "ONLY COPY");
	await archiveEverything();
	const archived = path.join(archivedArtifacts, "customer", "work");
	await plantStagingRecord(archived, path.join(archived, "doc.txt"));

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.notRestored).toEqual([]);
	expect(await Bun.file(path.join(liveArtifacts, "customer", "work", "doc.txt")).text()).toBe("ONLY COPY");
	expect(await Bun.file(path.join(archived, "doc.txt")).text()).toBe("ONLY COPY");
});

test("a planted record naming a directory outside the session trees deletes nothing", async () => {
	const outside = sessionStagingPath(path.join(root, "documents", "doc.txt"));
	await Bun.write(path.join(outside, "doc.txt"), "");

	await plantStagingRecord(outside, path.join(outside, "doc.txt"));
	const result = await archiveOnly();

	expect(await Bun.file(path.join(outside, "doc.txt")).exists()).toBe(true);
	expect(result.archive?.errors.join("\n")).toContain("outside");
});

test("a staging ledger other users can write is refused, not trusted", async () => {
	await fs.mkdir(stagingLedgerDir(root), { recursive: true });
	await fs.chmod(stagingLedgerDir(root), 0o777);

	const result = await archiveOnly();

	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.errors.join("\n")).toContain("is not a private directory");
});

test("a staging record that cannot be read stops the restore of the artifact tree", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	// Truncated mid-write: whatever it named can no longer be told apart
	// from an artifact, so nothing may be carried home on the strength of
	// its absence.
	await fs.mkdir(stagingLedgerDir(root), { recursive: true, mode: 0o700 });
	await Bun.write(path.join(stagingLedgerDir(root), "1.json"), '{"dir":"');

	const restored = await restoreArchivedSession(archiveFile, root);

	const told = restored.notRestored.join("\n");
	expect(told).toContain("does not hold a staging record");
	expect(told).toContain(`move it out of ${stagingLedgerDir(root)}, and run the same command again`);
	expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(true);
	expect(await Bun.file(path.join(liveArtifacts, "a.log")).exists()).toBe(false);
});

test("a restore preview reports a FIFO where an archived artifact belongs", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	await fs.mkdir(liveArtifacts, { recursive: true });
	expect(await Bun.spawn(["mkfifo", path.join(liveArtifacts, "a.log")]).exited).toBe(0);

	const preview = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });
	const applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

	expect(applied.restore?.errors.length).toBeGreaterThan(0);
	expect(preview.restore?.errors.join("\n")).toContain(path.join(liveArtifacts, "a.log"));
});

/**
 * Make `fs[method]` fail with an injected EIO on exactly `at`, or on every
 * path `at` matches, until restored: a look that fails, which says nothing
 * about what is there.
 */
function failWithEio(method: "lstat" | "realpath" | "stat" | "open", at: string | ((target: string) => boolean)) {
	const matches = typeof at === "string" ? (target: string) => target === at : at;
	const real = fs[method] as (...args: unknown[]) => Promise<unknown>;
	return spyOn(fs, method).mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (matches(String(target))) {
			throw Object.assign(new Error(`EIO: injected, ${method} ${target}`), { code: "EIO" });
		}
		return await real(target, ...rest);
	}) as never);
}

test("a restore that cannot check the transcript it staged reports that failure, not a replaced file or a damaged archive", async () => {
	await archiveEverything();
	const staged = failWithEio(
		"lstat",
		target => isStagedFile(target) && target.endsWith(`${path.sep}${path.basename(sessionFile)}`),
	);
	let failure: unknown;
	try {
		await restoreArchivedSession(archiveFile, root);
	} catch (error) {
		failure = error;
	} finally {
		staged.mockRestore();
	}

	expect(String(failure)).toContain("EIO: injected");
	expect(String(failure)).not.toContain("was replaced");
	expect(String(failure)).not.toContain("damaged");
	expect(await Bun.file(sessionFile).exists()).toBe(false);
});

test("a restore that cannot check a live artifact directory leaves its mode alone and says why", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody(sessionId("sub-1"), "nested", root));
	await fs.chmod(artifacts, 0o755);
	await archiveEverything();
	// A directory the live tree already holds, tightened against other local users.
	await fs.mkdir(artifacts, { recursive: true });
	await fs.chmod(artifacts, 0o700);
	const broken = failWithEio("lstat", artifacts);
	let restored: GcResult;
	try {
		restored = await runGcCommand({ flags: restoreApply() });
	} finally {
		broken.mockRestore();
	}

	expect((await fs.stat(artifacts)).mode & 0o777).toBe(0o700);
	expect(restored.restore?.errors.join("\n")).toContain("EIO: injected");
});

test("a restore that cannot resolve a live artifact says so, not that it is the archived file itself", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	// What an interrupted restore leaves: the transcript and this artifact home.
	await halfRestore();
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	const broken = failWithEio("realpath", path.join(liveArtifacts, "a.log"));
	let restored: RestoredSession;
	try {
		restored = await restoreArchivedSession(archiveFile, root);
	} finally {
		broken.mockRestore();
	}

	const told = restored.notRestored.join("\n");
	expect(told).toContain("EIO: injected");
	expect(told).not.toContain("itself");
});

test("a restore that cannot resolve the archive does not carry a recorded stage home as an artifact", async () => {
	const { ground, liveArtifacts } = await archivedWithKilledStage();
	const broken = failWithEio("realpath", getArchivedSessionsDir(root));
	let restored: GcResult;
	try {
		restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	} finally {
		broken.mockRestore();
	}

	expect(await fs.readdir(liveArtifacts).catch(() => [])).not.toContain(path.basename(ground.dir));
	expect(restored.restore?.errors.join("\n")).toContain(`${getArchivedSessionsDir(root)} could not be resolved`);
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
});

test("an archive run that cannot resolve the archive says so, not that a recorded stage is outside it", async () => {
	await archivedWithKilledStage();
	const broken = failWithEio("realpath", getArchivedSessionsDir(root));
	let result: GcResult;
	try {
		result = await archiveOnly();
	} finally {
		broken.mockRestore();
	}

	const told = result.archive?.errors.join("\n") ?? "";
	expect(told).toContain(`${getArchivedSessionsDir(root)} could not be resolved`);
	expect(told).toContain("EIO: injected");
	expect(told).not.toContain("outside the sessions and archive trees");
});

// The restore preview, one failed look at a time: each is reported as a look
// that failed, never read as an empty slot or as something else standing there.
const unlookable: [string, "lstat" | "stat" | "open", "file" | "directory", string][] = [
	["the name cannot be checked", "lstat", "file", "already holds something else"],
	["the directory name cannot be checked", "lstat", "directory", "is not a directory"],
	["the file cannot be opened", "open", "file", "already holds something else"],
];
for (const [shape, method, kind, misread] of unlookable) {
	test(`a restore preview reports a live artifact it cannot look at when ${shape}`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const entry = path.join(liveArtifacts, kind === "file" ? "a.log" : "nested");
		await Bun.write(kind === "file" ? entry : path.join(entry, "b.log"), "FIRST");
		await archiveEverything();
		await Bun.write(kind === "file" ? entry : path.join(entry, "b.log"), "FIRST");
		const broken = failWithEio(method, entry);
		let preview: GcResult;
		try {
			preview = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });
		} finally {
			broken.mockRestore();
		}

		// The preview runs the restore's own steps, so it fails where the
		// restore would, naming the entry and the failed look, and never reads
		// the failure as something else standing there or as a live owner.
		const told = preview.restore?.errors.join("\n") ?? "";
		expect(told).toContain(entry);
		expect(told).toContain("could not be");
		expect(told).toContain("EIO: injected");
		expect(told).not.toContain(misread);
		expect(told).not.toContain("a running process owns this session");
	});
}

test("a reclaim that cannot open an archived artifact reports that failure, not different bytes", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveOnly();
	const broken = failWithEio("open", path.join(archiveFile.slice(0, -".jsonl.gz".length), "a.log"));
	let result: GcResult;
	try {
		result = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
	} finally {
		broken.mockRestore();
	}

	const told = result.reclaim?.errors.join("\n") ?? "";
	expect(told).toContain("EIO: injected");
	expect(told).not.toContain("does not");
	expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("FIRST");
});

test("a restore that cannot resolve a recorded stage does not carry it home as an artifact", async () => {
	const { ground, liveArtifacts } = await archivedWithKilledStage();
	const broken = failWithEio("realpath", ground.dir);
	let restored: GcResult;
	try {
		restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	} finally {
		broken.mockRestore();
	}

	expect(await fs.readdir(liveArtifacts).catch(() => [])).not.toContain(path.basename(ground.dir));
	expect(restored.restore?.errors.join("\n")).toContain(`${ground.dir} could not be resolved`);
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
});

test("a restore whose second look at a recorded stage fails does not carry it home as an artifact", async () => {
	const { ground, liveArtifacts } = await archivedWithKilledStage();
	// The record is checked first, then the directory resolved again for its
	// path under the tree: only that second look fails.
	let looks = 0;
	const broken = failWithEio("realpath", target => target === ground.dir && ++looks === 2);
	let restored: GcResult;
	try {
		restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	} finally {
		broken.mockRestore();
	}

	expect(await fs.readdir(liveArtifacts).catch(() => [])).not.toContain(path.basename(ground.dir));
	expect(restored.restore?.errors.join("\n")).toContain(`${ground.dir} could not be resolved`);
});

test("an archive run that cannot resolve a live artifact tree does not archive a killed restore's stage in it", async () => {
	const { ground, liveArtifacts } = await restoredWithKilledLiveStage();
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	const broken = failWithEio("realpath", liveArtifacts);
	let result: GcResult;
	try {
		result = await archiveOnly();
	} finally {
		broken.mockRestore();
	}

	expect(await fs.readdir(archivedArtifacts)).not.toContain(path.basename(ground.dir));
	expect(result.archive?.errors.join("\n")).toContain(`${liveArtifacts} could not be resolved`);
});

test("re-archiving changes the mode of the archived transcript only, never what its name was rebound to", async () => {
	await archiveOnly();
	const unrelated = path.join(root, "private.txt");
	await Bun.write(unrelated, "DIFFERENT PRIVATE FILE");
	await fs.chmod(unrelated, 0o600);
	await fs.chmod(sessionFile, 0o664);
	await fs.chmod(archiveFile, 0o644);

	// As the run opens the archived transcript to give it the live mode, the
	// name is moved aside and pointed at somebody else's private file.
	const realOpen = fs.open;
	let rebound = false;
	const open = spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (!rebound && String(target) === archiveFile) {
			rebound = true;
			await fs.rename(archiveFile, `${archiveFile}.held`);
			await fs.symlink(unrelated, archiveFile);
		}
		return await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
	}) as typeof fs.open);
	try {
		await archiveOnly();
	} finally {
		open.mockRestore();
	}

	expect(rebound).toBe(true);
	expect((await fs.stat(unrelated)).mode & 0o777).toBe(0o600);
	expect(await Bun.file(unrelated).text()).toBe("DIFFERENT PRIVATE FILE");
});

for (const subject of ["an artifact", "the transcript"] as const) {
	test(`archiving gives ${subject} the live mode as it is when the archive is written, not as it was earlier`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await fs.chmod(sessionFile, 0o664);
		await fs.chmod(path.join(liveArtifacts, "a.log"), 0o664);
		const live = subject === "an artifact" ? path.join(liveArtifacts, "a.log") : sessionFile;
		const archived = subject === "an artifact" ? path.join(archivedArtifacts, "a.log") : archiveFile;

		// Tightened the moment the run first opens the archived name.
		const realOpen = fs.open;
		let tightened = false;
		const open = spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
			const handle = await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
			if (!tightened && String(target) === archived) {
				tightened = true;
				await fs.chmod(live, 0o600);
			}
			return handle;
		}) as typeof fs.open);
		try {
			await archiveOnly();
		} finally {
			open.mockRestore();
		}

		expect(tightened).toBe(true);
		expect((await fs.stat(archived)).mode & 0o777).toBe(0o600);
	});
}

for (const apply of [false, true]) {
	test(`a FIFO among the staging records is refused rather than waited on (${apply ? "apply" : "preview"})`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await archiveEverything();
		expect(await Bun.spawn(["mkfifo", path.join(stagingLedgerDir(root), "planted.json")]).exited).toBe(0);

		const run = runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply, json: true } });
		// A real timer, because the defect is a blocking open on a FIFO in the
		// thread pool: no fake clock reaches it, and it raises no signal to
		// await. A passing run resolves first and pays nothing.
		const outcome = await Promise.race([run, Bun.sleep(5_000).then(() => "hung" as const)]);
		if (outcome === "hung") {
			const writer = await fs.open(
				path.join(stagingLedgerDir(root), "planted.json"),
				fsConstants.O_WRONLY | fsConstants.O_NONBLOCK,
			);
			await writer.close();
			await run.catch(() => undefined);
		}

		expect(outcome).not.toBe("hung");
		if (outcome !== "hung") expect(outcome.restore?.errors.join("\n")).toContain("planted.json");
	}, 15_000);
}

test("an archived transcript keeps the mode of the file it was read from, whatever takes the live name later", async () => {
	await fs.chmod(sessionFile, 0o600);
	const original = await Bun.file(sessionFile).text();
	// Once the archive is published, the live name is given to another file
	// with the same bytes and a wider mode.
	const realLink = fs.link;
	let swapped = false;
	const link = spyOn(fs, "link").mockImplementation(async (from, to) => {
		await realLink(from, to);
		if (!swapped && String(to) === archiveFile) {
			swapped = true;
			await fs.rename(sessionFile, path.join(root, "aside.jsonl"));
			await Bun.write(sessionFile, original);
			await fs.chmod(sessionFile, 0o666);
		}
	});
	try {
		await archiveOnly();
	} finally {
		link.mockRestore();
	}

	expect(swapped).toBe(true);
	expect((await fs.stat(archiveFile)).mode & 0o777).toBe(0o600);
});

test("a restore preview reports a recorded staging directory the restore would leave in the archive", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	const ground = await mintStagingGround(path.join(archivedArtifacts, "b.log"), stagingLedgerDir(root));
	await ground.handle.writeFile("HALF A COPY");
	await abandonGround(ground);

	const preview = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });

	expect(preview.restore?.errors.join("\n")).toContain(ground.dir);
	expect(preview.restore?.notRestored.join("\n")).toContain(ground.dir);
});

test("re-archiving keeps the restore record over an empty staging directory the restore left out", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	// A run killed right after the staging `mkdir`: its intent recorded and
	// the directory empty.
	const dir = sessionStagingPath(path.join(archivedArtifacts, "b.log"));
	await fs.mkdir(dir, { mode: 0o700 });
	await fs.mkdir(stagingLedgerDir(root), { recursive: true, mode: 0o700 });
	await Bun.write(path.join(stagingLedgerDir(root), "1.json"), JSON.stringify({ dir, file: path.join(dir, "b.log") }));
	const restored = await restoreArchivedSession(archiveFile, root);
	expect(restored.notRestored.join("\n")).toContain(dir);

	const result = await archiveOnly();

	expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(true);
	expect(result.archive?.errors.join("\n")).toContain("still missing");
});

test("the restore's advice for a killed run's recorded stage, followed as written, lets the restore finish without carrying the stage home", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	const ground = await mintStagingGround(path.join(archivedArtifacts, "b.log"), stagingLedgerDir(root));
	await ground.handle.writeFile("PARTIAL STAGE");
	await abandonGround(ground);

	const refused = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	// The omission is in the public list as well as the errors, and the
	// advice is the five steps a review ran on a genuine killed archive,
	// with a command that moves the directory and then its record.
	expect(refused.restore?.notRestored.join("\n")).toContain(ground.dir);
	const advice = refused.restore?.errors.join("\n") ?? "";
	expect(advice).toContain("5. run the same command again");
	// A directory it moves out of that cannot be written is named, with the fix.
	expect(advice).toContain(`${path.dirname(ground.dir)}, which holds the staging directory`);
	expect(advice).toContain("chmod u+w");
	const move = /`(\(d=[^`]+)`/.exec(advice)?.[1];
	expect(move).toBeDefined();
	// It moves things aside: neither its prose nor its command removes
	// anything — no `rm`, no `rmdir`, no `unlink`.
	expect(advice.replace(move!, "")).not.toMatch(/\brm\b|remov/);
	expect(move).not.toMatch(/\b(rm|rmdir|unlink)\b/);
	const aside = path.join(root, `gc-quarantine-${path.basename(ground.record, ".json")}`);

	expect(await Bun.spawn(["sh", "-c", move!]).exited).toBe(0);
	// Into a numbered directory of its own, made by this run.
	expect(await fs.readdir(aside)).toEqual(["1"]);
	expect(await Bun.file(path.join(aside, "1", path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(path.join(aside, "1", path.basename(ground.record))).exists()).toBe(true);
	// Where it landed, by real path, not by name.
	const landed = await fs.realpath(aside);
	for (const tree of [getArchivedSessionsDir(root), path.join(root, "sessions")]) {
		const real = await fs.realpath(tree);
		expect(landed === real || landed.startsWith(`${real}${path.sep}`)).toBe(false);
	}
	// Run again, it finds nothing left to move, moves nothing, and says nothing is wrong.
	expect(await Bun.spawn(["sh", "-c", move!]).exited).toBe(0);
	expect(await fs.readdir(aside)).toEqual(["1"]);
	expect((await fs.readdir(path.join(aside, "1"))).sort()).toEqual(
		[path.basename(ground.dir), path.basename(ground.record)].sort(),
	);
	expect(await Bun.file(path.join(aside, "1", path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");

	await finishAfterRecovery();
	expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
	expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(false);
});

/** A session archived and reclaimed, with a killed run's recorded partial stage left in its archived tree. */
async function archivedWithKilledStage(): Promise<{ ground: StagingGround; liveArtifacts: string }> {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	const ground = await mintStagingGround(path.join(archivedArtifacts, "b.log"), stagingLedgerDir(root));
	await ground.handle.writeFile("PARTIAL STAGE");
	await abandonGround(ground);
	return { ground, liveArtifacts };
}

// The reviews' aliases for the destination the advice names: the shared
// `gc-quarantine` directory linked into the archived tree, and the very
// directory the command would make, linked there before it runs.
for (const alias of ["gc-quarantine", "the directory the command makes"] as const) {
	test(`the restore's printed command does not put the stage back in a session tree through ${alias === "gc-quarantine" ? "a gc-quarantine link" : "a link at the directory it makes"}`, async () => {
		const { ground, liveArtifacts } = await archivedWithKilledStage();
		const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
		const linked =
			alias === "gc-quarantine"
				? path.join(root, "gc-quarantine")
				: path.join(root, `gc-quarantine-${path.basename(ground.record, ".json")}`);
		await fs.symlink(archivedArtifacts, linked);

		const refused = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
		const move = /`(\(d=[^`]+)`/.exec(refused.restore?.errors.join("\n") ?? "")?.[1];
		expect(move).toBeDefined();
		const ran = await Bun.spawn(["sh", "-c", move!], { stderr: "ignore" }).exited;
		const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

		// Either the command stops before it moves anything, or what it
		// moves lands outside both trees; either way nothing comes home. The
		// whole of each tree is searched: a link can land the stage anywhere
		// inside one.
		const holds = async (tree: string, name: string): Promise<boolean> =>
			(await fs.readdir(tree, { recursive: true }).catch(() => [] as string[])).some(
				entry => path.basename(String(entry)) === name,
			);
		if (ran !== 0) expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
		expect(await holds(liveArtifacts, path.basename(ground.dir))).toBe(false);
		expect(await holds(archivedArtifacts, path.basename(ground.record))).toBe(false);
		if (alias === "the directory the command makes") {
			expect(ran).not.toBe(0);
			expect(restored.restore?.errors.join("\n")).toContain(ground.dir);
		} else {
			expect(ran).toBe(0);
			expect(restored.restore?.errors).toEqual([]);
		}
	});
}

test("the restore's advice gives no command when the agent directory resolves into a session tree", async () => {
	const base = path.join(root, "nest");
	const agentDir = path.join(base, "agent");
	await fs.mkdir(path.join(agentDir, "archive", "sessions"), { recursive: true });
	await fs.symlink(base, path.join(agentDir, "sessions"));
	const dir = path.join(agentDir, "archive", "sessions", "x", ".b.log.0123456789abcdef.tmp");

	const advice = await stagingResidueNote(dir, path.join(agentDir, "gc-staging", "1.json"), "so a restore leaves it");

	expect(advice).not.toContain("mkdir");
	expect(advice).toContain("inside a session tree");
	expect(advice).toContain(await fs.realpath(base));
});

// What a restore killed while it staged leaves: its recorded stage, part
// written, in the live artifact tree, where every restore stages.
async function restoredWithKilledLiveStage(): Promise<{ ground: StagingGround; liveArtifacts: string }> {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	const first = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	expect(first.restore?.errors).toEqual([]);
	const ground = await mintStagingGround(path.join(liveArtifacts, "b.log"), stagingLedgerDir(root));
	await ground.handle.writeFile("PARTIAL STAGE");
	await abandonGround(ground);
	return { ground, liveArtifacts };
}

test("a killed restore's recorded stage in the live tree makes the restore say so, with the recovery, in its preview as in applying", async () => {
	const { ground, liveArtifacts } = await restoredWithKilledLiveStage();

	const preview = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });
	const retried = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

	for (const run of [preview, retried]) {
		const told = run.restore?.errors.join("\n") ?? "";
		expect(told).toContain(ground.dir);
		expect(told).toContain("5. run the same command again");
	}
	expect(retried.restore?.errors.join("\n")).not.toContain("could not restore");
	expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(true);

	const move = /`(\(d=[^`]+)`/.exec(retried.restore?.errors.join("\n") ?? "")?.[1];
	expect(move).toBeDefined();
	expect(await Bun.spawn(["sh", "-c", move!]).exited).toBe(0);
	await finishAfterRecovery();
	expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
	expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(false);
});

test("a killed restore's recorded stage in the live tree is not archived, and a reclaim keeps it, naming it", async () => {
	const { ground, liveArtifacts } = await restoredWithKilledLiveStage();
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);

	// The reviews' sequence on from there, with nothing removed or forged:
	// an ordinary archive run, a reclaim, and a restore.
	await archiveOnly();
	expect(await fs.readdir(archivedArtifacts)).not.toContain(path.basename(ground.dir));
	const reclaimed = await runGcCommand({
		flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
	});
	const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

	expect(reclaimed.reclaim?.reclaimed).toBe(0);
	expect(reclaimed.reclaim?.errors.join("\n")).toContain(ground.dir);
	expect(reclaimed.reclaim?.errors.join("\n")).toContain("5. run the same command again");
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(ground.record).exists()).toBe(true);
	expect(restored.restore?.errors.join("\n")).toContain(ground.dir);
	expect((await fs.readdir(liveArtifacts)).sort()).toEqual(["a.log", path.basename(ground.dir)].sort());
});

for (const occupant of ["a symlink to somebody's file", "a FIFO", "a directory"] as const) {
	test(`a restore refuses ${occupant} at its record's name, in its preview as in applying, and writes nothing through it`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await archiveEverything();
		const record = restoreRecordPath(archiveFile);
		const precious = path.join(root, "precious");
		await Bun.write(precious, "ONLY COPY OF IRREPLACEABLE USER DATA");
		if (occupant === "a symlink to somebody's file") await fs.symlink(precious, record);
		else if (occupant === "a FIFO") expect(await Bun.spawn(["mkfifo", record]).exited).toBe(0);
		else await fs.mkdir(record);
		const before = await fs.lstat(record);

		const preview = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });
		const applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

		for (const run of [preview, applied]) expect(run.restore?.errors.join("\n")).toContain(record);
		const after = await fs.lstat(record);
		expect([after.ino, after.mode]).toEqual([before.ino, before.mode]);
		expect(await Bun.file(precious).text()).toBe("ONLY COPY OF IRREPLACEABLE USER DATA");
		expect(await Bun.file(sessionFile).exists()).toBe(false);
	});
}

// The review's forged-prefix fixtures, and a read-only file and a hard link to
// someone's only copy: a regular file at the record's name that this run did
// not create. What it holds — even a first line that reads as a restore
// command — says nothing of who wrote it, so nothing of it is lost: under the
// gc lock no restore is running to own it, and applying sets it aside, the
// very file by rename, and finishes under a record of its own.
for (const occupant of [
	"a record for another session",
	"the restore command with no newline",
	"a hard link to somebody's only copy",
	"a read-only file of somebody's notes",
] as const) {
	test(`a restore sets aside, whole, ${occupant} at the record's name, and finishes`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await archiveEverything();
		const record = restoreRecordPath(archiveFile);
		const precious = path.join(root, "precious");
		if (occupant === "a record for another session") {
			await Bun.write(record, "omp gc --restore bogus --apply\nFOREIGN: NOT A RESTORE RECORD\n");
		} else if (occupant === "the restore command with no newline") {
			await Bun.write(record, `omp gc --restore ${SESSION_ID} --apply`);
		} else {
			await Bun.write(precious, "ONLY COPY OF IRREPLACEABLE USER DATA");
			await fs.link(precious, record);
			if (occupant === "a read-only file of somebody's notes") await fs.chmod(record, 0o400);
		}
		const before = await fs.lstat(record);
		const bytes = await fs.readFile(record);

		const preview = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });
		const applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
		// The review's re-archive: a restored session archived again, still live.
		const rearchived = await archiveOnly();

		expect(preview.restore?.errors).toEqual([]);
		expect(preview.restore?.setAsideRecord).toBe(record);
		expect(applied.restore?.errors).toEqual([]);
		const setAside = applied.restore?.setAsideRecord;
		expect(setAside).toStartWith(`${record}.`);
		expect(rearchived.archive?.errors).toEqual([]);
		const after = await fs.lstat(setAside!);
		expect([after.ino, after.mode, after.nlink]).toEqual([before.ino, before.mode, before.nlink]);
		expect(await fs.readFile(setAside!)).toEqual(bytes);
		expect(await fs.lstat(record).catch(() => undefined)).toBeUndefined();
		// Everything else came home.
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
	});
}

test.skipIf(process.getuid?.() === 0)(
	"a record that cannot move out of a read-only bucket reports the rename error and a later restore finishes",
	async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await archiveEverything();
		const record = restoreRecordPath(archiveFile);
		const bucket = path.dirname(record);
		// The review's fixture: the archive bucket at mode 0500, with a file at
		// the record's name that this run did not create.
		await Bun.write(record, "not a record");
		await fs.chmod(bucket, 0o500);
		let applied: GcResult;
		let moved: number;
		try {
			applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
			moved = await Bun.spawn(["mv", record, path.join(root, "aside")], { stderr: "ignore" }).exited;
		} finally {
			await fs.chmod(bucket, 0o700);
		}

		const told = applied.restore?.errors.join("\n") ?? "";
		expect(told).toContain("EACCES");
		expect(told).not.toContain("chmod u+w");
		expect(moved).not.toBe(0);
		// With permissions restored, setting the unchanged record aside permits retry.
		await fs.rename(record, path.join(root, "aside"));
		const finished = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
		expect(finished.restore?.errors).toEqual([]);
		expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
	},
);

test("a restore that cannot take its own record down says which directory to make writable", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	const record = restoreRecordPath(archiveFile);
	// The review's mid-run case: the archive bucket made read-only while the
	// restore runs, so the first call that changes the bucket to take the
	// record down — its move to a private name — is refused.
	const refused = (): never => {
		throw Object.assign(new Error(`EACCES: permission denied, rename '${record}'`), { code: "EACCES" });
	};
	const realUnlink = fs.unlink;
	const realMove = libcModule.renameNoReplace;
	const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
		if (String(target) === record) refused();
		return await realUnlink(target);
	});
	const open = spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		if (from === record && isMovedAside(to, record)) refused();
		return await realMove(from, to);
	});
	let applied: GcResult;
	try {
		applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	} finally {
		unlink.mockRestore();
		open.mockRestore();
	}

	const told = applied.restore?.errors.join("\n") ?? "";
	expect(told).toContain(`${path.dirname(record)} is not writable`);
	expect(told).toContain("could not take down its record");
	expect(told).toContain("chmod u+w");
	expect(await Bun.file(record).exists()).toBe(true);
	expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
});

test.skipIf(process.getuid?.() === 0)(
	"a restore that cannot make its record in a read-only archive bucket restores nothing and says which directory to make writable",
	async () => {
		await archiveEverything();
		const record = restoreRecordPath(archiveFile);
		const bucket = path.dirname(record);
		await fs.chmod(bucket, 0o500);
		let applied: GcResult;
		try {
			applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
		} finally {
			await fs.chmod(bucket, 0o700);
		}

		const told = applied.restore?.errors.join("\n") ?? "";
		expect(told).toContain(`${bucket} is not writable`);
		expect(told).toContain("restored nothing");
		expect(told).toContain("chmod u+w");
		expect(await Bun.file(sessionFile).exists()).toBe(false);
		expect(await Bun.file(record).exists()).toBe(false);
	},
);

// Round 38. The restore record sits in an archive bucket, where any process
// of this user can write it by name. A file renamed onto the name, or bytes
// appended to it, at the last call the restore makes on that name — the
// `unlink` that took the record down, at the review's head — were removed
// with it while the restore exited 0. The record is moved to a private name,
// by a rename that replaces nothing, and judged there now: what is not
// exactly the record this run wrote goes back under the name.
for (const late of ["a file renamed onto it", "bytes appended to it"] as const) {
	test(`a restore keeps ${late} at its record's name at the last call it makes on that name`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await archiveEverything();
		const record = restoreRecordPath(archiveFile);
		const lateBytes = "ONLY COPY OF A LATE WRITER'S DATA";
		const realRename = fs.rename;
		const realUnlink = fs.unlink;
		let planted = false;
		const plant = async (): Promise<void> => {
			planted = true;
			if (late === "a file renamed onto it") {
				const temp = path.join(root, "planted");
				await Bun.write(temp, lateBytes);
				await realRename(temp, record);
			} else {
				await fs.appendFile(record, lateBytes);
			}
		};
		const realMove = libcModule.renameNoReplace;
		const rename = spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
			if (!planted && from === record) await plant();
			return await realMove(from, to);
		});
		const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
			if (!planted && String(target) === record) await plant();
			return await realUnlink(target);
		});
		let applied: GcResult;
		try {
			applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
		} finally {
			rename.mockRestore();
			unlink.mockRestore();
		}

		expect(planted).toBe(true);
		expect(applied.restore?.errors.join("\n")).toContain("held something other than the record this restore wrote");
		expect(await Bun.file(record).text()).toEndWith(lateBytes);
		expect((await fs.readdir(path.dirname(record))).filter(name => name.endsWith(".leaving"))).toEqual([]);
	});
}

test("a restore that finds its record's name taken as it makes it leaves what took it", async () => {
	await archiveEverything();
	const record = restoreRecordPath(archiveFile);
	// The review's other late plant: a file put at the name after the check
	// and before the restore creates its record there.
	const realOpen = fs.open;
	const open = spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (String(target) === record && rest[0] === "wx") await Bun.write(record, "ONLY COPY OF A LATE WRITER'S DATA");
		return await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
	}) as typeof fs.open);
	let applied: GcResult;
	try {
		applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	} finally {
		open.mockRestore();
	}

	expect(applied.restore?.errors).toEqual([restoreRecordLeftNote(record)]);
	expect(await Bun.file(record).text()).toBe("ONLY COPY OF A LATE WRITER'S DATA");
});

test("a killed restore's live stage is named, in the preview as in applying, when the archived artifact tree is missing", async () => {
	const { ground, liveArtifacts } = await restoredWithKilledLiveStage();
	// The review's fixture: only the archived artifact directory moved aside,
	// outside both trees, the archived transcript and the ledger left.
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await fs.rename(archivedArtifacts, path.join(root, "archived-artifacts-aside"));

	const preview = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });
	const applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

	for (const run of [preview, applied]) expect(run.restore?.errors.join("\n")).toContain(ground.dir);
	expect(applied.restore?.artifactsRestored).toBe(false);
	expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(true);
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
	expect(await fs.readdir(liveArtifacts)).toContain(path.basename(ground.dir));
});

test("the printed command stops, moving nothing, when a session tree has moved to hold its destination since the message", async () => {
	const { ground } = await archivedWithKilledStage();
	const refused = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	const move = /`(\(d=[^`]+)`/.exec(refused.restore?.errors.join("\n") ?? "")?.[1];
	expect(move).toBeDefined();
	// The review's tree move: the sessions tree, relinked after the message so
	// that it resolves to the agent directory, which holds the destination.
	const sessions = path.join(root, "sessions");
	await fs.rename(sessions, path.join(root, "sessions-aside"));
	await fs.symlink(root, sessions);
	let ran: number;
	let said: string;
	try {
		const child = Bun.spawn(["sh", "-c", move!], { stderr: "pipe" });
		ran = await child.exited;
		said = await new Response(child.stderr).text();
	} finally {
		await fs.unlink(sessions);
		await fs.rename(path.join(root, "sessions-aside"), sessions);
	}

	expect(ran).not.toBe(0);
	expect(said).toContain("is inside the session tree");
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(ground.record).exists()).toBe(true);
	// It checks the name before it makes the directory, so nothing was made, and the same command runs again once the tree is back.
	const aside = path.join(await fs.realpath(root), `gc-quarantine-${path.basename(ground.record, ".json")}`);
	expect(await fs.lstat(aside).catch(() => undefined)).toBeUndefined();
	expect(await Bun.spawn(["sh", "-c", move!]).exited).toBe(0);
	expect(await Bun.file(path.join(aside, "1", path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");
});

/** The printed recovery command from a refused restore's message; the refusal keeps the restore record. */
async function printedCommand(): Promise<string> {
	const refused = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	const move = /`(\(d=[^`]+)`/.exec(refused.restore?.errors.join("\n") ?? "")?.[1];
	expect(move).toBeDefined();
	return move!;
}

async function runPrinted(move: string, env?: Record<string, string>): Promise<{ exit: number; said: string }> {
	const child = Bun.spawn(["sh", "-c", move], { stderr: "pipe", env: env ? { ...process.env, ...env } : undefined });
	const exit = await child.exited;
	return { exit, said: await new Response(child.stderr).text() };
}

// The review's rerun: a directory the command moves out of at 0500, the
// command run as printed, the permission fixed as the message says, and the
// identical string run again. The staging directory itself at 0500 passes
// the command's own check — its parent is writable — and fails at `mv`,
// which may not move a directory it cannot write to a new parent; the
// command leaves the directory it made, empty, and takes it again.
for (const where of [
	"the archived tree",
	"the live tree",
	"the staging ledger",
	"the staging directory itself",
] as const) {
	test.skipIf(process.getuid?.() === 0)(
		`the printed command, stopped by a read-only directory in ${where}, runs again unchanged once it is writable`,
		async () => {
			const { ground, liveArtifacts } =
				where === "the live tree" ? await restoredWithKilledLiveStage() : await archivedWithKilledStage();
			const move = await printedCommand();
			const aside = path.join(await fs.realpath(root), `gc-quarantine-${path.basename(ground.record, ".json")}`);
			const locked =
				where === "the staging ledger"
					? path.dirname(ground.record)
					: where === "the staging directory itself"
						? ground.dir
						: path.dirname(ground.dir);
			const mode = (await fs.stat(locked)).mode & 0o7777;
			await fs.chmod(locked, 0o500);
			let first: { exit: number; said: string };
			try {
				first = await runPrinted(move);
			} finally {
				await fs.chmod(locked, mode);
			}

			expect(first.exit).not.toBe(0);
			if (where === "the staging directory itself") {
				expect(first.said).toContain(`the move of ${await fs.realpath(ground.dir)} did not finish`);
				expect(first.said).toContain("nothing was deleted");
				expect(await fs.readdir(path.join(aside, "1"))).toEqual([]);
			} else {
				expect(first.said).toContain(`${await fs.realpath(locked)} is not writable`);
				expect(await fs.lstat(aside).catch(() => undefined)).toBeUndefined();
			}
			expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
			expect(await Bun.file(ground.record).exists()).toBe(true);
			expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(true);

			expect((await runPrinted(move)).exit).toBe(0);
			// A stop after its numbered directory was made leaves it, empty; the next run takes the next number.
			const landed = path.join(aside, where === "the staging directory itself" ? "2" : "1");
			expect(await Bun.file(path.join(landed, path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");
			expect(await Bun.file(path.join(landed, path.basename(ground.record))).exists()).toBe(true);
			await finishAfterRecovery();
			expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
		},
	);
}

test("the printed command, stopped after moving the staging directory, moves the record when run again", async () => {
	const { ground, liveArtifacts } = await archivedWithKilledStage();
	const move = await printedCommand();
	const aside = path.join(await fs.realpath(root), `gc-quarantine-${path.basename(ground.record, ".json")}`);
	// The record's move fails for a reason the first check cannot see: an
	// `mv` on the PATH that refuses the record and passes everything else on.
	const bin = path.join(root, "failing-bin");
	await fs.mkdir(bin);
	await Bun.write(
		path.join(bin, "mv"),
		`#!/bin/sh\nfor a in "$@"; do [ "$a" = ${JSON.stringify(await fs.realpath(ground.record))} ] && { echo "mv: injected failure" >&2; exit 1; }; done\nexec ${Bun.which("mv")!} "$@"\n`,
	);
	await fs.chmod(path.join(bin, "mv"), 0o755);

	const first = await runPrinted(move, { PATH: `${bin}:${process.env.PATH ?? ""}` });

	expect(first.exit).not.toBe(0);
	expect(first.said).toContain(`${await fs.realpath(ground.record)} was not moved`);
	expect(await Bun.file(path.join(aside, "1", path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(ground.record).exists()).toBe(true);
	expect((await runPrinted(move)).exit).toBe(0);
	expect(await Bun.file(path.join(aside, "2", path.basename(ground.record))).exists()).toBe(true);
	expect(await Bun.file(ground.record).exists()).toBe(false);
	await finishAfterRecovery();
	expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
});

test("the printed command, killed after moving the staging directory, finishes when run again, and nothing is carried home", async () => {
	const { ground, liveArtifacts } = await archivedWithKilledStage();
	const move = await printedCommand();
	const aside = path.join(await fs.realpath(root), `gc-quarantine-${path.basename(ground.record, ".json")}`);
	const bin = path.join(root, "killing-bin");
	await fs.mkdir(bin);
	// An `mv` that moves the staging directory and then kills the shell running the command.
	await Bun.write(
		path.join(bin, "mv"),
		`#!/bin/sh\nfor a in "$@"; do [ "$a" = ${JSON.stringify(await fs.realpath(ground.dir))} ] && { ${Bun.which("mv")!} "$@"; kill -KILL $PPID; exit 0; }; done\nexec ${Bun.which("mv")!} "$@"\n`,
	);
	await fs.chmod(path.join(bin, "mv"), 0o755);

	const first = await runPrinted(move, { PATH: `${bin}:${process.env.PATH ?? ""}` });
	expect(first.exit).not.toBe(0);
	expect(await Bun.file(ground.record).exists()).toBe(true);
	expect((await runPrinted(move)).exit).toBe(0);

	expect(await Bun.file(path.join(aside, "1", path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(path.join(aside, "2", path.basename(ground.record))).exists()).toBe(true);
	await finishAfterRecovery();
	expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
});

test("the printed command, finding its directory already holding a numbered directory, takes the next number and writes over nothing", async () => {
	const { ground } = await archivedWithKilledStage();
	const move = await printedCommand();
	const aside = path.join(await fs.realpath(root), `gc-quarantine-${path.basename(ground.record, ".json")}`);
	const stageName = path.basename(ground.dir);
	const recordName = path.basename(ground.record);
	await Bun.write(path.join(aside, "1", stageName, "b.log"), "ALREADY THERE");
	await Bun.write(path.join(aside, "1", recordName), "ALREADY THERE");

	expect((await runPrinted(move)).exit).toBe(0);

	expect(await Bun.file(path.join(aside, "1", stageName, "b.log")).text()).toBe("ALREADY THERE");
	expect(await Bun.file(path.join(aside, "1", recordName)).text()).toBe("ALREADY THERE");
	expect(await Bun.file(path.join(aside, "2", stageName, "b.log")).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(path.join(aside, "2", recordName)).exists()).toBe(true);
});

// The second review's planted link: a link to a session tree put, just
// before the move, at the name the staging directory would take. The
// command names no destination — it moves into the directory it holds,
// under the source's own name — so `mv -n` meets the link and declines to
// replace it. GNU `mv` then exits 1 and busybox `mv` exits 0, which is why
// the command checks the source is gone rather than trusting either: it
// stops, says so, and nothing reaches the session tree.
const busybox = Bun.which("busybox");
for (const mover of ["GNU mv", "busybox mv"] as const) {
	test.skipIf(mover === "busybox mv" && !busybox)(
		`the printed command, meeting a link planted where the staging directory would land, moves nothing into it (${mover})`,
		async () => {
			const { ground } = await archivedWithKilledStage();
			const move = await printedCommand();
			const sessions = path.join(root, "sessions");
			const before = (await fs.readdir(sessions, { recursive: true })).sort();
			const real = await fs.realpath(ground.dir);
			const bin = path.join(root, "planting-bin");
			await fs.mkdir(bin);
			const run = mover === "busybox mv" ? `${busybox} mv` : Bun.which("mv")!;
			await Bun.write(
				path.join(bin, "mv"),
				`#!/bin/sh\nfor a in "$@"; do [ "$a" = ${JSON.stringify(real)} ] && ln -s ${JSON.stringify(sessions)} ./${JSON.stringify(path.basename(real))}; done\nexec ${run} "$@"\n`,
			);
			await fs.chmod(path.join(bin, "mv"), 0o755);

			const first = await runPrinted(move, { PATH: `${bin}:${process.env.PATH ?? ""}` });

			expect(first.exit).not.toBe(0);
			expect(first.said).toContain(`the move of ${real} did not finish`);
			expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
			expect(await Bun.file(ground.record).exists()).toBe(true);
			expect((await fs.readdir(sessions, { recursive: true })).sort()).toEqual(before);
		},
	);
}

// The review's destination switch: between the failed move and whatever
// comes next, the new directory is renamed away and its name pointed at an
// unrelated directory holding a file of the staging directory's name. The
// command deletes nothing, so nothing there can be lost, and run again it
// will not enter a link.
test("the printed command deletes nothing when its directory's name is switched to an unrelated directory", async () => {
	const { ground } = await archivedWithKilledStage();
	const move = await printedCommand();
	const aside = path.join(await fs.realpath(root), `gc-quarantine-${path.basename(ground.record, ".json")}`);
	const saved = path.join(root, "aside-renamed");
	const unrelated = path.join(root, "user-important");
	await Bun.write(path.join(unrelated, path.basename(ground.dir), "priceless"), "USER FILE");
	const bin = path.join(root, "switching-bin");
	await fs.mkdir(bin);
	await Bun.write(
		path.join(bin, "mv"),
		`#!/bin/sh\nfor a in "$@"; do [ "$a" = ${JSON.stringify(await fs.realpath(ground.dir))} ] && { echo "mv: injected failure" >&2; ${Bun.which("mv")!} ${JSON.stringify(aside)} ${JSON.stringify(saved)}; ln -s ${JSON.stringify(unrelated)} ${JSON.stringify(aside)}; exit 1; }; done\nexec ${Bun.which("mv")!} "$@"\n`,
	);
	await fs.chmod(path.join(bin, "mv"), 0o755);

	const first = await runPrinted(move, { PATH: `${bin}:${process.env.PATH ?? ""}` });
	const second = await runPrinted(move);

	expect(first.exit).not.toBe(0);
	expect(first.said).toContain("injected failure");
	expect(second.exit).not.toBe(0);
	expect(await Bun.file(path.join(unrelated, path.basename(ground.dir), "priceless")).text()).toBe("USER FILE");
	expect(await fs.readdir(unrelated)).toEqual([path.basename(ground.dir)]);
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(ground.record).exists()).toBe(true);
});

// A second filesystem for the archived tree, as the reviews arranged it: the
// archive's `sessions` a symlink onto /dev/shm, the agent directory and the
// directory the printed command makes on the test's own filesystem, so the
// command's `mv` of the staging directory is a copy and then a delete — which
// can stop part-way and leave a partial copy, and only a real failure does.
const otherFilesystem = (() => {
	try {
		return statSync("/dev/shm").dev !== statSync(os.tmpdir()).dev ? "/dev/shm" : undefined;
	} catch {
		return undefined;
	}
})();

/** Puts the archived tree on {@link otherFilesystem}; returns the directory to remove afterwards. */
async function archiveOnOtherFilesystem(): Promise<string> {
	const external = await fs.mkdtemp(path.join(otherFilesystem!, "omp-session-archive-"));
	await fs.mkdir(path.dirname(getArchivedSessionsDir(root)), { recursive: true });
	await fs.symlink(external, getArchivedSessionsDir(root));
	return external;
}

for (const failure of ["an unreadable file", "a write the kernel refuses part-way"] as const) {
	test.skipIf(!otherFilesystem || (failure === "an unreadable file" && process.getuid?.() === 0))(
		`the printed command's move onto another filesystem, stopped part-way by ${failure}, keeps its partial copy, and the identical command then finishes`,
		async () => {
			const external = await archiveOnOtherFilesystem();
			try {
				const { ground, liveArtifacts } = await archivedWithKilledStage();
				// Large enough that a 128 KiB file-size limit stops the copy inside it.
				await fs.appendFile(ground.file, Buffer.alloc(1 << 20, 0x61));
				const before = await Bun.file(ground.file).bytes();
				const move = await printedCommand();
				const aside = path.join(await fs.realpath(root), `gc-quarantine-${path.basename(ground.record, ".json")}`);
				const name = path.basename(ground.dir);
				expect((await fs.stat(ground.dir)).dev).not.toBe((await fs.stat(root)).dev);

				let first: { exit: number; said: string };
				if (failure === "an unreadable file") {
					// The copy makes the directory, then cannot open the file in it.
					await fs.chmod(ground.file, 0o000);
					try {
						first = await runPrinted(move);
					} finally {
						await fs.chmod(ground.file, 0o600);
					}
				} else {
					// A real `EFBIG` from the kernel at 128 KiB — `ulimit -f` counts
					// 512-byte blocks, and an ignored SIGXFSZ turns the signal into
					// the error — standing in for a full disk, which a test cannot
					// make without mounting one: the copy stops inside the file.
					first = await runPrinted(`trap '' XFSZ; ulimit -f 256; ${move}`);
				}

				expect(first.exit).not.toBe(0);
				expect(first.said).toContain(`the move of ${await fs.realpath(ground.dir)} did not finish`);
				expect(first.said).toContain("nothing was deleted");
				// The partial copy is there, as the message says, and the original whole.
				expect((await fs.lstat(path.join(aside, "1", name))).isDirectory()).toBe(true);
				expect(await Bun.file(ground.file).bytes()).toEqual(before);
				expect(await Bun.file(ground.record).exists()).toBe(true);

				const second = await runPrinted(move);
				expect(second.exit).toBe(0);
				expect(await Bun.file(path.join(aside, "2", name, "b.log")).bytes()).toEqual(before);
				expect((await fs.lstat(path.join(aside, "1", name))).isDirectory()).toBe(true);
				expect(await Bun.file(path.join(aside, "2", path.basename(ground.record))).exists()).toBe(true);
				await finishAfterRecovery();
				expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
			} finally {
				await fs.rm(external, { recursive: true, force: true });
			}
		},
	);
}

// A move onto another filesystem whose copy finished and whose delete did
// not, and the same with a writer changing the original while the delete
// runs — an entry of its own put in, or other bytes under the name the
// delete took: what a count of entries could not tell from a whole
// original. The command deletes nothing, so the copy holding what the
// original lost stays; the review's literal follow-through then fixes the
// cause, runs the identical command again, and requires that the restore
// which exits 0 has really finished, nothing of the stage carried home.
for (const writer of [
	undefined,
	"adds an entry of its own",
	"puts other bytes under the name the delete took",
] as const) {
	test.skipIf(!otherFilesystem || process.getuid?.() === 0)(
		`the printed command's move onto another filesystem that copied everything but could not delete the original${writer ? `, while something ${writer},` : ""} keeps every byte, and finishes when run again as it says`,
		async () => {
			const external = await archiveOnOtherFilesystem();
			// The original's locked directory, and its copy, which `mv` gives the same mode.
			const lockedDirs: string[] = [];
			try {
				const { ground, liveArtifacts } = await archivedWithKilledStage();
				// Something the move's delete cannot take out of the original.
				const locked = path.join(ground.dir, "locked");
				await fs.mkdir(locked);
				await Bun.write(path.join(locked, "kept"), "LEFT IN THE ORIGINAL");
				await fs.chmod(locked, 0o500);
				const move = await printedCommand();
				const aside = path.join(await fs.realpath(root), `gc-quarantine-${path.basename(ground.record, ".json")}`);
				const name = path.basename(ground.dir);
				lockedDirs.push(locked, path.join(aside, "1", name, "locked"));
				const real = await fs.realpath(ground.dir);
				let env: Record<string, string> | undefined;
				if (writer) {
					const write =
						writer === "adds an entry of its own"
							? `printf INTRUDER > ${JSON.stringify(path.join(real, "intruder"))}`
							: `printf OTHER > ${JSON.stringify(path.join(real, "b.log"))}`;
					const bin = path.join(root, "writer-bin");
					await fs.mkdir(bin);
					await Bun.write(
						path.join(bin, "mv"),
						`#!/bin/sh\nfor a in "$@"; do [ "$a" = ${JSON.stringify(real)} ] && { ${Bun.which("mv")!} "$@"; moved=$?; ${write}; exit $moved; }; done\nexec ${Bun.which("mv")!} "$@"\n`,
					);
					await fs.chmod(path.join(bin, "mv"), 0o755);
					env = { PATH: `${bin}:${process.env.PATH ?? ""}` };
				}

				const first = await runPrinted(move, env);

				expect(first.exit).not.toBe(0);
				expect(first.said).toContain(`the move of ${real} did not finish`);
				expect(first.said).toContain("run again, moves what is left into a new directory beside it");
				// The whole copy is in the new directory; what the delete could not take, and the record, where they were.
				expect(await Bun.file(path.join(aside, "1", name, "b.log")).text()).toBe("PARTIAL STAGE");
				expect(await Bun.file(path.join(aside, "1", name, "locked", "kept")).text()).toBe("LEFT IN THE ORIGINAL");
				expect(await Bun.file(path.join(locked, "kept")).text()).toBe("LEFT IN THE ORIGINAL");
				expect(await Bun.file(ground.record).exists()).toBe(true);

				// The cause, fixed; then the identical command, as the message says.
				await fs.chmod(locked, 0o700);
				expect((await runPrinted(move)).exit).toBe(0);

				expect(await Bun.file(path.join(aside, "2", name, "locked", "kept")).text()).toBe("LEFT IN THE ORIGINAL");
				if (writer === "adds an entry of its own") {
					expect(await Bun.file(path.join(aside, "2", name, "intruder")).text()).toBe("INTRUDER");
				}
				if (writer === "puts other bytes under the name the delete took") {
					expect(await Bun.file(path.join(aside, "2", name, "b.log")).text()).toBe("OTHER");
				}
				expect(await Bun.file(path.join(aside, "1", name, "b.log")).text()).toBe("PARTIAL STAGE");
				expect(await Bun.file(path.join(aside, "2", path.basename(ground.record))).exists()).toBe(true);
				expect(await fs.lstat(ground.dir).catch(() => undefined)).toBeUndefined();
				await finishAfterRecovery();
				expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
			} finally {
				for (const dir of lockedDirs) await fs.chmod(dir, 0o700).catch(() => undefined);
				await fs.rm(external, { recursive: true, force: true });
			}
		},
	);
}

test("the printed command moves the stage where it said, though the agent directory is relinked after the message", async () => {
	const realAgent = path.join(root, "agent-real");
	const link = path.join(root, "agent-link");
	const elsewhere = path.join(root, "elsewhere");
	for (const tree of [realAgent, elsewhere]) {
		await fs.mkdir(path.join(tree, "sessions"), { recursive: true });
		await fs.mkdir(path.join(tree, "archive", "sessions"), { recursive: true });
	}
	await fs.symlink(realAgent, link);
	const stage = path.join(link, "archive", "sessions", "x", ".b.log.0123456789abcdef.tmp");
	await Bun.write(path.join(stage, "b.log"), "PARTIAL STAGE");
	const record = path.join(link, "gc-staging", "1.json");
	await Bun.write(record, "{}");
	const advice = await stagingResidueNote(stage, record, "so a restore leaves it");
	const move = /`(\(d=[^`]+)`/.exec(advice)?.[1];
	expect(move).toBeDefined();
	// The review's flip: the agent directory's link repointed after the
	// message was printed.
	await fs.unlink(link);
	await fs.symlink(elsewhere, link);

	expect(await Bun.spawn(["sh", "-c", move!]).exited).toBe(0);

	const aside = path.join(realAgent, "gc-quarantine-1");
	expect(await Bun.file(path.join(aside, "1", path.basename(stage), "b.log")).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(path.join(aside, "1", "1.json")).exists()).toBe(true);
	expect(await fs.readdir(path.join(elsewhere, "archive", "sessions"))).toEqual([]);
});

/**
 * The advice's last step: run the restore again. Under the gc lock it finds
 * the record a killed restore left, sets it aside whole — its writer cannot
 * be running — and finishes clean under a record of its own.
 */
async function finishAfterRecovery(): Promise<void> {
	const record = restoreRecordPath(archiveFile);
	const left = await fs.readFile(record);
	const again = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	expect(again.restore?.errors).toEqual([]);
	const setAside = again.restore?.setAsideRecord;
	expect(setAside).toStartWith(`${record}.`);
	expect(await fs.readFile(setAside!)).toEqual(left);
	expect(await fs.lstat(record).catch(() => undefined)).toBeUndefined();
}

// A reclaim gives up no symbolic link in the artifact tree. What a link
// leads to is outside the tree and its leases, so it can change after any
// proof of it — the review added a child to a linked directory, and rebound
// a hop of a chain, after the proof and before the `unlink` — and a reference
// cannot be archived, only what it led to at one moment. So every shape keeps
// the tree and names the link, whether or not the archive holds what it led
// to, and nothing of the tree or what it leads to is touched.
const linkShapes = [
	"leads nowhere",
	"was made after the archive",
	"leads to a directory that gained a file after the archive",
	"leads to a file the archive holds",
	"leads to a directory the archive holds",
	"leads through a second link to a directory the archive holds",
	"leads to a file inside the tree",
	"leads to the archived copy itself",
] as const;
for (const shape of linkShapes) {
	test(`a reclaim keeps the live tree and names the link when a link in it ${shape}, in its preview as in applying`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
		const outside = path.join(root, "outside");
		await Bun.write(path.join(outside, "target.log"), "TARGET");
		await Bun.write(path.join(outside, "dir", "one.log"), "ONE");
		await fs.symlink(path.join(outside, "dir"), path.join(outside, "hop"));
		await Bun.write(path.join(liveArtifacts, "plain.log"), "PLAIN");
		const link = path.join(liveArtifacts, "the.link");
		const before: Record<(typeof linkShapes)[number], string | undefined> = {
			"leads nowhere": path.join(outside, "missing.log"),
			"was made after the archive": undefined,
			"leads to a directory that gained a file after the archive": path.join(outside, "dir"),
			"leads to a file the archive holds": path.join(outside, "target.log"),
			"leads to a directory the archive holds": path.join(outside, "dir"),
			"leads through a second link to a directory the archive holds": path.join(outside, "hop"),
			"leads to a file inside the tree": "plain.log",
			"leads to the archived copy itself": undefined,
		};
		if (before[shape] !== undefined) await fs.symlink(before[shape]!, link);
		const archived = await archiveOnly();
		expect(archived.archive).toMatchObject({ archived: 1, brokenLinks: shape === "leads nowhere" ? 1 : 0 });
		if (shape === "was made after the archive") await fs.symlink(path.join(outside, "target.log"), link);
		if (shape === "leads to the archived copy itself")
			await fs.symlink(path.join(archivedArtifacts, "plain.log"), link);
		if (shape === "leads to a directory that gained a file after the archive") {
			await Bun.write(path.join(outside, "dir", "two.log"), "TWO");
		}
		const target = await fs.readlink(link);

		const preview = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, forwardOnly: true, json: true },
		});
		const reclaimed = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});

		expect(preview.reclaim?.wouldReclaim).toBeUndefined();
		expect(reclaimed.reclaim?.reclaimed).toBe(0);
		expect(reclaimed.reclaim?.moved).toBeUndefined();
		expect(reclaimed.reclaim?.keptArtifactTree).toBe(liveArtifacts);
		for (const run of [preview, reclaimed]) {
			const said = run.reclaim?.errors.join("\n") ?? "";
			expect(said).toContain(`${link} is a symbolic link, which a reclaim does not give up`);
			expect(said).toContain("move the link out of the tree");
		}
		expect(await fs.readlink(link)).toBe(target);
		expect(await Bun.file(path.join(liveArtifacts, "plain.log")).text()).toBe("PLAIN");
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		expect(await Bun.file(path.join(outside, "target.log")).text()).toBe("TARGET");
		expect(await Bun.file(path.join(outside, "dir", "one.log")).text()).toBe("ONE");
	});
}

// The message's one step, done as it says: the link moved out of the tree,
// then the same reclaim again. The link keeps leading where it led, and the
// archive's copy of what it led to comes back as regular files.
test("a reclaim that kept a link finishes once the link is moved out of the tree, as its message says", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const outside = path.join(root, "outside");
	await Bun.write(path.join(outside, "dir", "one.log"), "ONE");
	await Bun.write(path.join(liveArtifacts, "plain.log"), "PLAIN");
	const link = path.join(liveArtifacts, "dir.link");
	await fs.symlink(path.join(outside, "dir"), link);
	await archiveOnly();
	const reclaim = { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true };
	expect((await runGcCommand({ flags: reclaim })).reclaim?.reclaimed).toBe(0);

	const movedTo = path.join(root, "dir.link");
	await fs.rename(link, movedTo);
	const reclaimed = await runGcCommand({ flags: reclaim });

	expect(reclaimed.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	expect(await fs.lstat(liveArtifacts).catch(() => undefined)).toBeUndefined();
	expect(await Bun.file(path.join(movedTo, "one.log")).text()).toBe("ONE");
	const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	expect(restored.restore?.errors).toEqual([]);
	expect((await fs.lstat(path.join(liveArtifacts, "dir.link"))).isDirectory()).toBe(true);
	expect(await Bun.file(path.join(liveArtifacts, "dir.link", "one.log")).text()).toBe("ONE");
});

// The second review's contradiction: a recorded stage in the archived tree
// was listed as something applying would bring back, while the same preview
// said applying leaves it in the archive. Applying restores the ordinary
// missing artifact and leaves the stage; the list says the same.
test("a restore preview does not list a recorded staging directory among what applying brings back", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "z.log"), "LAST");
	await archiveOnly();
	await fs.rm(path.join(liveArtifacts, "z.log"));
	const ground = await mintStagingGround(path.join(archivedArtifacts, "b.log"), stagingLedgerDir(root));
	await ground.handle.writeFile("PARTIAL STAGE");
	await abandonGround(ground);

	const preview = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });
	const applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

	expect(preview.restore?.missingArtifacts).toEqual(["z.log"]);
	expect(preview.restore?.errors.join("\n")).toContain(ground.dir);
	expect(applied.restore?.errors.join("\n")).toContain(ground.dir);
	expect(await Bun.file(path.join(liveArtifacts, "z.log")).text()).toBe("LAST");
	expect(await fs.lstat(path.join(liveArtifacts, path.basename(ground.dir))).catch(() => undefined)).toBeUndefined();
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
});

// The third review's two: a dangling link where an archived file belongs is
// absent to `stat`, so a separate presence walk listed it as coming back
// while the conflict walk said it would be left; and a directory the restore
// would stage in that cannot be written was promised too. One walk answers
// both, and an entry applying could not publish is a refusal, not a promise.
for (const shape of ["a dangling link stands at its name", "the directory it would land in is not writable"] as const) {
	test.skipIf(shape === "the directory it would land in is not writable" && process.getuid?.() === 0)(
		`a restore preview does not promise an archived file applying would refuse, when ${shape}`,
		async () => {
			const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
			await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
			await Bun.write(path.join(liveArtifacts, "b.log"), "SECOND");
			await archiveOnly();
			await fs.rm(path.join(liveArtifacts, "b.log"));
			if (shape === "a dangling link stands at its name") {
				await fs.symlink(path.join(root, "gone.log"), path.join(liveArtifacts, "b.log"));
			} else {
				await fs.chmod(liveArtifacts, 0o500);
			}
			let preview: GcResult;
			let applied: GcResult;
			try {
				preview = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });
				applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
			} finally {
				await fs.chmod(liveArtifacts, 0o755);
			}

			expect(preview.restore?.missingArtifacts).toEqual([]);
			expect(preview.restore?.errors.join("\n")).toContain(
				shape === "a dangling link stands at its name"
					? `${path.join(liveArtifacts, "b.log")} is a symbolic link`
					: `${liveArtifacts} is not writable`,
			);
			// Applying agrees: it does not bring the file back, and says so.
			expect(applied.restore?.errors.length).toBeGreaterThan(0);
			expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("FIRST");
		},
	);
}

// A live transcript over part of its tree — what a reclaim killed part-way
// through its tree left before the transcript went first, and what removing
// artifacts by hand still leaves: the preview names what applying brings
// home instead of reporting nothing to do.
test("a restore preview names the archived artifacts a live transcript's tree lacks", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "child", "only.log"), "NESTED");
	await Bun.write(path.join(liveArtifacts, "z.log"), "LAST");
	await archiveOnly();
	await fs.rm(path.join(liveArtifacts, "child"), { recursive: true });
	await fs.rm(path.join(liveArtifacts, "z.log"));

	const preview = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });

	expect(preview.restore?.errors).toEqual([]);
	expect(preview.restore?.missingArtifacts).toEqual(["child", "z.log"]);
	expect(renderGcText(preview)).toContain("would bring back 2 artifact entries the live tree lacks");
	const applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	expect(applied.restore?.errors).toEqual([]);
	expect(await Bun.file(path.join(liveArtifacts, "child", "only.log")).text()).toBe("NESTED");
	expect(await Bun.file(path.join(liveArtifacts, "z.log")).text()).toBe("LAST");
});

test("a reclaim keeps a live tree holding a FIFO the archive could not hold", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	const pipe = path.join(liveArtifacts, "pipe");
	expect(await Bun.spawn(["mkfifo", pipe]).exited).toBe(0);
	await archiveOnly();

	const reclaimed = await runGcCommand({
		flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
	});

	expect(reclaimed.reclaim?.reclaimed).toBe(0);
	expect(reclaimed.reclaim?.errors.join("\n")).toContain(pipe);
	expect((await fs.lstat(pipe)).isFIFO()).toBe(true);
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

test("a staging record naming a relative path is not one a gc run wrote", async () => {
	const { ground, liveArtifacts } = await archivedWithKilledStage();
	const entry = JSON.parse(await Bun.file(ground.record).text());
	await Bun.write(ground.record, JSON.stringify({ ...entry, dir: path.relative(process.cwd(), entry.dir) }));

	const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

	const told = restored.restore?.errors.join("\n") ?? "";
	expect(told).toContain(`${ground.record} does not hold a staging record: it is JSON, but not what a gc run writes`);
	expect(told).toContain(`move it out of ${stagingLedgerDir(root)}, and run the same command again`);
	expect(told).toContain("a restore takes it for an artifact and carries it home");
	expect(await fs.stat(path.join(liveArtifacts, path.basename(ground.dir))).catch(() => undefined)).toBeUndefined();
});

for (const shape of [
	"a file identity without a directory identity",
	"a directory identity without a file identity",
] as const) {
	test(`a restore stops at a staging record with ${shape}, which no gc run writes`, async () => {
		const { ground, liveArtifacts } = await archivedWithKilledStage();
		// A run writes both identities at once, so a record holding one is not
		// one a run wrote, and what it names cannot be told from an artifact.
		const { dirIdentity, identity, ...names } = JSON.parse(await Bun.file(ground.record).text());
		const forged =
			shape === "a file identity without a directory identity" ? { ...names, identity } : { ...names, dirIdentity };
		await Bun.write(ground.record, JSON.stringify(forged));

		const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

		const told = restored.restore?.errors.join("\n") ?? "";
		expect(told).toContain(
			`${ground.record} does not hold a staging record: it is JSON, but not what a gc run writes`,
		);
		expect(told).toContain(`move it out of ${stagingLedgerDir(root)}, and run the same command again`);
		expect(told).toContain("nothing was carried");
		expect(await fs.stat(path.join(liveArtifacts, path.basename(ground.dir))).catch(() => undefined)).toBeUndefined();
		expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
	});
}

/**
 * How long a FIFO test waits before calling a run hung, and how long such a
 * test may take in all. A real hang is unbounded, so a long window costs
 * only the red runs; a short one called runs that were merely slow hung on a
 * box at a load of 500, where a clean refusal can take seconds.
 */
const HANG_MS = 20_000;
const FIFO_TEST_MS = 60_000;
const PIPE_PAYLOAD = "UNIQUE USER INPUT WAITING IN A PIPE, 52 BYTES LONG.\n";

/**
 * A FIFO with `PIPE_PAYLOAD` waiting in it and its writer gone, and a reader
 * of our own held open so that whatever a run does not take stays in the
 * pipe: `left()` says what is still there.
 */
async function pipeHolding(fifo: string): Promise<{ left(): Promise<string>; close(): Promise<void> }> {
	expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
	const reader = await fs.open(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
	const writer = await fs.open(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
	await writer.write(PIPE_PAYLOAD);
	await writer.close();
	return {
		async left(): Promise<string> {
			const buffer = Buffer.alloc(4096);
			const { bytesRead } = await reader.read(buffer, 0, buffer.byteLength, null);
			return buffer.subarray(0, bytesRead).toString();
		},
		close: async () => await reader.close(),
	};
}

// A FIFO at `gc.lock`, itself or through a link, with input waiting: every
// gc command reads the lock before it does anything, when it cannot create
// one, to see whether its holder is gone.
const lockedCommands: [string, () => Promise<() => Promise<GcResult>>][] = [
	["archive --apply", async () => () => archiveOnly()],
	[
		"reclaim (preview)",
		async () => {
			await archiveOnly();
			return () => runGcCommand({ flags: { agentDir: root, reclaim: archiveFile, forwardOnly: true, json: true } });
		},
	],
	[
		"reclaim --apply",
		async () => {
			await archiveOnly();
			return () =>
				runGcCommand({
					flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
				});
		},
	],
	[
		"restore --apply",
		async () => {
			await archiveEverything();
			return () => runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
		},
	],
];
for (const form of ["a FIFO", "a link to a FIFO"] as const) {
	for (const [command, prepare] of lockedCommands) {
		test(
			`${command} neither waits on nor drains ${form} at gc.lock, and names it`,
			async () => {
				const lock = path.join(root, "gc.lock");
				const run = await prepare();
				const fifo = form === "a FIFO" ? lock : path.join(root, "outside-lock.fifo");
				const pipe = await pipeHolding(fifo);
				if (form === "a link to a FIFO") await fs.symlink(fifo, lock);
				try {
					const attempt = run().then(
						() => "",
						(failure: unknown) => String(failure),
					);
					// A real timer: a blocking open of a FIFO waits in the thread
					// pool, where no fake clock reaches it.
					const outcome = await Promise.race([attempt, Bun.sleep(HANG_MS).then(() => "hung" as const)]);
					if (outcome === "hung") {
						const writer = await fs.open(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
						await writer.close();
						await attempt;
					}

					expect(outcome).not.toBe("hung");
					expect(await pipe.left()).toBe(PIPE_PAYLOAD);
					expect(outcome).toContain(
						`${lock} is ${form === "a FIFO" ? "a FIFO" : "a symbolic link"}, not a regular file`,
					);
					expect((await fs.lstat(lock)).isFIFO() || (await fs.lstat(lock)).isSymbolicLink()).toBe(true);
					// The breaker lock it took to look is given back: the review saw
					// `gc.lock.break` held for as long as the read hung.
					expect(await fs.lstat(`${lock}.break`).catch(() => undefined)).toBeUndefined();
					// Moved aside, as the message says, and the same command runs.
					await fs.rename(lock, path.join(root, "gc.lock.aside"));
					const again = await run().then(
						() => "",
						(failure: unknown) => String(failure),
					);
					expect(again).not.toContain("gc.lock");
					expect(again).not.toContain("GC already running");
				} finally {
					await pipe.close();
				}
			},
			FIFO_TEST_MS,
		);
	}
}

// A later run removes nothing it did not create in that run, identified by
// what it captured when it created it: a name in the staging ledger, a
// suffix or a record's shape is not provenance.

test("an archive run keeps a file in the staging ledger whose name ends in .part, in its preview as in applying", async () => {
	const ledger = stagingLedgerDir(root);
	await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
	const foreign = path.join(ledger, "user-notes.json.part");
	await Bun.write(foreign, "FOREIGN USER DATA NOT WRITTEN BY GC");
	await runGcCommand({
		flags: {
			agentDir: root,
			archive: true,
			json: true,
			coldArchiveAfterDays: 0,
			retainNewestGlobal: 0,
			retainNewestPerCwd: 0,
		},
	});
	expect(await Bun.file(foreign).text()).toBe("FOREIGN USER DATA NOT WRITTEN BY GC");

	const applied = await archiveOnly();

	expect(applied.archive?.archived).toBe(1);
	expect(await Bun.file(foreign).text()).toBe("FOREIGN USER DATA NOT WRITTEN BY GC");
});

test("an archive run keeps a staging record whose directory is gone", async () => {
	const ledger = stagingLedgerDir(root);
	await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
	const dir = sessionStagingPath(path.join(getSessionsDir(root), "--work--", "x.log"));
	const record = path.join(ledger, "1234567890123456.json");
	const text = JSON.stringify({ dir, file: path.join(dir, "x.log") });
	await Bun.write(record, text);

	await archiveOnly();

	expect(await Bun.file(record).text()).toBe(text);
});

test("a staging ground that cannot write its record's replacement keeps what already holds that name", async () => {
	const ledger = stagingLedgerDir(root);
	await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
	// Fixed names, so the collision is the kernel's EEXIST and not a made-up error.
	let sequence = 0;
	spyOn(Snowflake, "next").mockImplementation(() => {
		sequence += 1;
		return (sequence === 1 ? "1111111111111111" : "2222222222222222") as ReturnType<typeof Snowflake.next>;
	});
	const part = path.join(ledger, "2222222222222222.json.part");
	await Bun.write(part, "SOMEBODY'S FILE, WRITTEN BEFORE THIS RUN");
	const target = path.join(root, "staged-here", "example.log");
	await fs.mkdir(path.dirname(target), { recursive: true });
	let failure = "";
	try {
		const ground = await mintStagingGround(target, ledger);
		await abandonGround(ground);
	} catch (error) {
		failure = String(error);
	}

	expect(failure).toContain("EEXIST");
	expect(failure).toContain(`${part} is not a record this run wrote, so it was left as it is`);
	expect(await Bun.file(part).text()).toBe("SOMEBODY'S FILE, WRITTEN BEFORE THIS RUN");
	// What this attempt did write is gone again: its record and its directory.
	expect((await fs.readdir(ledger)).sort()).toEqual(["2222222222222222.json.part"]);
	expect(await fs.readdir(path.dirname(target))).toEqual([]);
});

test("a run keeps a staging record that something else replaced, and says so", async () => {
	const target = path.join(root, "staged-here", "example.log");
	await fs.mkdir(path.dirname(target), { recursive: true });
	const ground = await mintStagingGround(target, stagingLedgerDir(root));
	await ground.handle.close();
	// Another file at the record's name: written aside, then moved over it.
	await Bun.write(`${ground.record}.aside`, "SOMEBODY ELSE'S RECORD");
	await fs.rename(`${ground.record}.aside`, ground.record);

	const note = await removeStagingGround(ground);

	expect(note).toContain(`${ground.record} is not the record this run wrote, so it was left as it is`);
	expect(await Bun.file(ground.record).text()).toBe("SOMEBODY ELSE'S RECORD");
	expect(await fs.lstat(ground.dir).catch(() => undefined)).toBeUndefined();
});

test("a gc run keeps a gc.lock that holds something gc does not write, however old, and names it", async () => {
	const lock = path.join(root, "gc.lock");
	await Bun.write(lock, "MY NOTES ABOUT GC, NOT A LOCK\n");
	const old = new Date(Date.now() - 60 * 60_000);
	await fs.utimes(lock, old, old);

	const failure = await archiveOnly().then(
		() => "",
		(error: unknown) => String(error),
	);

	expect(failure).toContain(`${lock} holds something gc does not write`);
	expect(await Bun.file(lock).text()).toBe("MY NOTES ABOUT GC, NOT A LOCK\n");
	expect(await fs.lstat(`${lock}.break`).catch(() => undefined)).toBeUndefined();
});

// A lock is gc's to remove only when it holds exactly what gc writes. What
// earlier versions wrote carries no random value, so it cannot be told from
// a file shaped like it.

test("a gc run still takes over a gc.lock a killed gc run left", async () => {
	await leaveDeadGcLock(root);

	const result = await archiveOnly();

	expect(result.archive?.archived).toBe(1);
	expect(await fs.lstat(path.join(root, "gc.lock")).catch(() => undefined)).toBeUndefined();
});

test("a gc run keeps a lock-shaped gc.lock with no random value, whose process is gone, names it, and runs once it is moved aside", async () => {
	const lock = path.join(root, "gc.lock");
	// What earlier versions write: a pid no process holds, and a start time.
	const earlier = `4194305\n${new Date(Date.now() - 60 * 60_000).toISOString()}\n`;
	await Bun.write(lock, earlier);

	const failure = await archiveOnly().then(
		() => "",
		(error: unknown) => String(error),
	);

	expect(failure).toContain(`${lock} looks like a lock an earlier version of gc took`);
	expect(failure).toContain("move it aside");
	expect(await Bun.file(lock).text()).toBe(earlier);
	await fs.rename(lock, path.join(root, "gc.lock.aside"));
	expect((await archiveOnly()).archive?.archived).toBe(1);
});

// The review's file: a number on the first line, anything on the second.
const LOCK_SHAPED = "4194305\nFOREIGN USER DATA, NOT A GC TIMESTAMP\n";
for (const [command, prepare] of lockedCommands) {
	test(`${command} keeps a foreign gc.lock with a number on its first line, and names it`, async () => {
		const lock = path.join(root, "gc.lock");
		const run = await prepare();
		await Bun.write(lock, LOCK_SHAPED);

		const failure = await run().then(
			() => "",
			(error: unknown) => String(error),
		);

		expect(failure).toContain(`${lock} holds something gc does not write`);
		expect(await Bun.file(lock).text()).toBe(LOCK_SHAPED);
	});
}

test("a gc run keeps a foreign gc.lock.break with a number on its first line, and names it", async () => {
	const lock = path.join(root, "gc.lock");
	// A lock being written this moment, so the breaker is consulted.
	await Bun.write(lock, "");
	await Bun.write(`${lock}.break`, LOCK_SHAPED);

	const failure = await archiveOnly().then(
		() => "",
		(error: unknown) => String(error),
	);

	expect(failure).toContain(`${lock}.break holds something gc does not write`);
	expect(await Bun.file(`${lock}.break`).text()).toBe(LOCK_SHAPED);
	expect(await Bun.file(lock).text()).toBe("");
});

/**
 * Once `armed()` says so, the next look at `at` finds it replaced: unlinked,
 * and a file holding `foreign` created there, again up to a few times, until
 * the kernel gives it the inode number `old` had. Measured on ext4: once
 * nothing holds the old inode open, the first create after the unlink gets
 * its number; while any descriptor holds it, no create can, however many
 * times it is tried — 2,000 attempts got it none, and cost the test most of
 * its five seconds on a loaded machine. Returns what happened.
 */
function replaceOnNextLook(at: string, foreign: string, armed: () => Stats | undefined) {
	const happened = { replaced: false, reused: false };
	const replace = async (old: Stats): Promise<void> => {
		happened.replaced = true;
		await fs.unlink(at);
		for (let attempt = 0; attempt < 8 && !happened.reused; attempt++) {
			const handle = await fs.open(at, "wx", 0o600);
			await handle.writeFile(foreign);
			const now = await handle.stat();
			await handle.close();
			happened.reused = now.dev === old.dev && now.ino === old.ino;
			if (!happened.reused) await fs.unlink(at);
		}
		if (!happened.reused) await Bun.write(at, foreign);
	};
	for (const method of ["lstat", "stat"] as const) {
		const real = fs[method] as (...args: unknown[]) => Promise<Stats>;
		spyOn(fs, method).mockImplementation((async (target: string, ...rest: unknown[]) => {
			const old = String(target) === at && !happened.replaced ? armed() : undefined;
			if (old) await replace(old);
			return await real(target, ...rest);
		}) as never);
	}
	return happened;
}

test("a gc run keeps a file put at gc.lock while it ran, even one given its lock's inode number", async () => {
	const lock = path.join(root, "gc.lock");
	const foreign = "A FILE SOMEBODY PUT AT gc.lock WHILE GC RAN\n";
	let old: Stats | undefined;
	const happened = replaceOnNextLook(lock, foreign, () => old);

	await expect(
		withGcLock(root, async () => {
			const handle = await fs.open(lock, "r");
			old = await handle.stat();
			await handle.close();
		}),
	).rejects.toThrow("not the lock this run took");

	expect(happened.replaced).toBe(true);
	expect(await Bun.file(lock).text()).toBe(foreign);
});

test("a staging ground never writes its record at the record's own name, so a kill cannot leave one cut short", async () => {
	const ledger = stagingLedgerDir(root);
	const target = path.join(root, "staged-here", "example.log");
	await fs.mkdir(path.dirname(target), { recursive: true });
	// Every name in the ledger opened for writing.
	const written: string[] = [];
	const realOpen = fs.open;
	spyOn(fs, "open").mockImplementation((async (at: string, flags?: unknown, ...rest: unknown[]) => {
		const writing = typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" && (flags & 3) !== 0;
		if (writing && path.dirname(String(at)) === ledger) written.push(path.basename(String(at)));
		return await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(at, flags, ...rest);
	}) as typeof fs.open);

	const ground = await mintStagingGround(target, ledger);
	await abandonGround(ground);

	expect(written.length).toBeGreaterThan(0);
	expect(written.filter(name => !name.endsWith(".part"))).toEqual([]);
	expect(JSON.parse(await Bun.file(ground.record).text())).toMatchObject({ dir: ground.dir, file: ground.file });
	expect((await fs.readdir(ledger)).filter(name => name.endsWith(".part"))).toEqual([]);
});

test("a staging ground keeps a file put at its first record's name while it minted, and says so", async () => {
	const ledger = stagingLedgerDir(root);
	const target = path.join(root, "staged-here", "example.log");
	await fs.mkdir(path.dirname(target), { recursive: true });
	const foreign = "SOMEBODY ELSE'S RECORD";
	// Once the directory is made and the record's identities are about to be
	// written, another file takes the first record's name.
	const parts: string[] = [];
	const realOpen = fs.open;
	const open = spyOn(fs, "open").mockImplementation((async (at: string, ...rest: unknown[]) => {
		if (String(at).endsWith(".json.part")) {
			parts.push(String(at));
			if (parts.length === 2) {
				const first = parts[0].slice(0, -".part".length);
				await Bun.write(`${first}.aside`, foreign);
				await fs.rename(`${first}.aside`, first);
			}
		}
		return await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(at, ...rest);
	}) as typeof fs.open);
	let failure = "";
	try {
		const ground = await mintStagingGround(target, ledger);
		await abandonGround(ground);
	} catch (error) {
		failure = String(error);
	} finally {
		open.mockRestore();
	}

	const first = parts[0].slice(0, -".part".length);
	expect(await Bun.file(first).text()).toBe(foreign);
	expect(failure).toContain(`${first} is not a record this run wrote, so it was left as it is`);
	// What this attempt did write is gone again: its records and its directory.
	expect(await fs.readdir(ledger)).toEqual([path.basename(first)]);
	expect(await fs.readdir(path.dirname(target))).toEqual([]);
});

test("an archive run names a ledger record that does not parse, with the way out, and runs once it is moved", async () => {
	const ledger = stagingLedgerDir(root);
	await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
	// What an earlier version left when killed while writing a record.
	const record = path.join(ledger, "1234567890123456.json");
	await Bun.write(record, "");

	const stopped = await archiveOnly();

	const told = stopped.archive?.errors.join("\n") ?? "";
	expect(told).toContain(`${record} does not hold a staging record`);
	expect(told).toContain(`move it out of ${ledger}, and run the same command again`);
	// The way out, as written.
	await fs.rename(record, path.join(root, "moved-out-of-the-ledger"));
	const again = await archiveOnly();
	expect(again.archive?.errors).toEqual([]);
	expect(again.archive?.archived).toBe(1);
});

for (const [command, prepare] of lockedCommands) {
	test(`${command} names a ledger file that is JSON but not a staging record, with the way out`, async () => {
		const ledger = stagingLedgerDir(root);
		// An artifact tree, which every command checks against the ledger
		// before it acts on it.
		await Bun.write(path.join(sessionFile.slice(0, -".jsonl".length), "a.log"), "HELLO");
		const run = await prepare();
		await fs.mkdir(ledger, { recursive: true, mode: 0o700 });
		// The review's file: well-formed JSON no gc run writes.
		const record = path.join(ledger, "0000000000000000.json");
		const body = JSON.stringify({ note: "SOMEBODY'S JSON, NOT A STAGING RECORD" });
		await Bun.write(record, body);

		const told = await run().then(
			result => JSON.stringify(result),
			(error: unknown) => String(error),
		);

		expect(told).toContain(`${record} does not hold a staging record: it is JSON, but not what a gc run writes`);
		expect(told).toContain(`move it out of ${ledger}, and run the same command again`);
		expect(await Bun.file(record).text()).toBe(body);
	});
}

test("an archive run lists a staging record whose directory is gone, and stops once it is moved out", async () => {
	const { ground } = await archivedWithKilledStage();
	// The stage gone by hand; its record stays, since no run removes it.
	await fs.unlink(ground.file);
	await fs.rmdir(ground.dir);

	const listed = await archiveOnly();

	expect(listed.archive?.errors).toEqual([]);
	expect(listed.archive?.stagingRecordsWithoutDirectory).toEqual([ground.record]);
	expect(await Bun.file(ground.record).exists()).toBe(true);
	await fs.rename(ground.record, path.join(root, "moved-out-of-the-ledger"));
	expect((await archiveOnly()).archive?.stagingRecordsWithoutDirectory).toBeUndefined();
});
// Round 33. A real FIFO an artifact links to, with input waiting in it, and
// the same FIFO with nobody writing: what consumed the input, and what hung,
// was the run looking for transcripts among the artifacts — the archive run
// and the reclaim both do, before anything refuses. The kind is judged on
// the descriptor before a byte is read, so neither waits and the input stays.
const fifoLinkCommands: [string, () => Promise<GcResult>][] = [
	[
		"archive (preview)",
		async () => {
			// Aged as `archiveOnly` ages it, so the dry run takes the session up
			// and looks for its owners — the step that read the FIFO.
			const old = new Date(Date.now() - 30 * 86_400_000);
			const bucket = path.join(getSessionsDir(root), "--work--");
			for (const entry of await fs.readdir(bucket, { recursive: true })) {
				await fs.lutimes(path.join(bucket, entry), old, old).catch(() => undefined);
			}
			return await runGcCommand({
				flags: {
					agentDir: root,
					archive: true,
					json: true,
					coldArchiveAfterDays: 0,
					retainNewestGlobal: 0,
					retainNewestPerCwd: 0,
				},
			});
		},
	],
	["archive --apply", () => archiveOnly()],
	[
		"reclaim (preview)",
		() => runGcCommand({ flags: { agentDir: root, reclaim: archiveFile, forwardOnly: true, json: true } }),
	],
	[
		"reclaim --apply",
		() =>
			runGcCommand({ flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true } }),
	],
];
for (const writer of ["with input waiting", "with nobody writing"] as const) {
	for (const [command, run] of fifoLinkCommands) {
		test(
			`${command} neither waits on nor reads a FIFO an artifact links to, ${writer}`,
			async () => {
				const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
				await Bun.write(path.join(liveArtifacts, "plain.log"), "PLAIN");
				if (command.startsWith("reclaim")) await archiveOnly();
				const fifo = path.join(root, "outside.fifo");
				const pipe = writer === "with input waiting" ? await pipeHolding(fifo) : undefined;
				if (!pipe) expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
				const link = path.join(liveArtifacts, "notes.jsonl");
				await fs.symlink(fifo, link);
				try {
					const attempt = run().then(
						result => JSON.stringify(result),
						(failure: unknown) => String(failure),
					);
					// A real timer: a read of a FIFO waits in the thread pool, where
					// no fake clock reaches it.
					const outcome = await Promise.race([attempt, Bun.sleep(HANG_MS).then(() => "hung" as const)]);
					if (outcome === "hung") {
						const unblock = await fs.open(fifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
						await unblock.close();
						await attempt;
					}

					expect(outcome).not.toBe("hung");
					if (pipe) expect(await pipe.left()).toBe(PIPE_PAYLOAD);
					expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
					if (command.startsWith("archive")) {
						expect(outcome).toContain(`${link} is a FIFO`);
						expect(outcome).toContain('"wouldArchive":0');
						expect(await Bun.file(sessionFile).exists()).toBe(true);
					}
					if (command.startsWith("reclaim")) {
						expect(outcome).toContain(`${link} is a symbolic link, which a reclaim does not give up`);
						expect(await Bun.file(sessionFile).exists()).toBe(true);
					}
				} finally {
					await pipe?.close();
				}
			},
			FIFO_TEST_MS,
		);
	}
}

// The archived transcript itself a FIFO holding a whole compressed
// transcript: the restore, and its preview, read it to find the session's
// owner and to inflate it. Refused unread, the bytes stay and nothing waits.
for (const apply of [false, true]) {
	test(
		`a restore ${apply ? "--apply" : "preview"} neither waits on nor reads an archived transcript that is a FIFO`,
		async () => {
			await archiveOnly();
			const compressed = await fs.readFile(archiveFile);
			await fs.rm(sessionFile);
			await fs.rm(archiveFile);
			expect(await Bun.spawn(["mkfifo", archiveFile]).exited).toBe(0);
			const reader = await fs.open(archiveFile, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
			const writer = await fs.open(archiveFile, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
			await writer.write(compressed);
			await writer.close();
			try {
				// By id, as a user asks — the listing offers a FIFO at an archived
				// name, so a restore by id says what stands there, the same answer
				// opening the session gives, not that nothing matches.
				const attempt = runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply, json: true } }).then(
					result => JSON.stringify(result),
					(failure: unknown) => String(failure),
				);
				const outcome = await Promise.race([attempt, Bun.sleep(HANG_MS).then(() => "hung" as const)]);
				if (outcome === "hung") {
					const unblock = await fs.open(archiveFile, fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
					await unblock.close();
					await attempt;
				}

				expect(outcome).not.toBe("hung");
				const left = Buffer.alloc(compressed.byteLength + 64);
				const { bytesRead } = await reader.read(left, 0, left.byteLength, null);
				expect(bytesRead).toBe(compressed.byteLength);
				expect(outcome).toContain("not a regular file");
				expect(outcome).not.toContain("no archived session matches");
				expect(await Bun.file(sessionFile).exists()).toBe(false);
			} finally {
				await reader.close();
			}
		},
		FIFO_TEST_MS,
	);
}

// A transcript that is a symbolic link is kept, like a link in the tree: a
// turn appended to the file it leads to after the last comparison would be
// left where the session no longer looks — the review appended one at the
// very `unlink`, and the reclaim and the restore after it exited 0 without it.
for (const apply of [false, true]) {
	test(`a reclaim ${apply ? "--apply" : "preview"} keeps a session whose transcript is a symbolic link, and names it`, async () => {
		await archiveOnly();
		const outside = path.join(root, "outside-transcript.jsonl");
		await fs.rename(sessionFile, outside);
		await fs.symlink(outside, sessionFile);
		const before = await Bun.file(outside).text();
		const unlinked: string[] = [];
		const realUnlink = fs.unlink;
		const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
			unlinked.push(String(target));
			await realUnlink(target);
		});
		let result: GcResult;
		try {
			result = await runGcCommand({
				flags: { agentDir: root, reclaim: archiveFile, apply, forwardOnly: true, json: true },
			});
		} finally {
			unlink.mockRestore();
		}

		expect(unlinked.filter(gone => gone === sessionFile || isMovedAside(gone, sessionFile))).toEqual([]);
		expect(result.reclaim?.reclaimed ?? 0).toBe(0);
		expect(result.reclaim?.errors.join("\n")).toContain(`${sessionFile} is a symbolic link, to ${outside}`);
		expect(result.reclaim?.errors.join("\n")).toContain("replace the link with a copy of the transcript");
		expect((await fs.lstat(sessionFile)).isSymbolicLink()).toBe(true);
		expect(await Bun.file(outside).text()).toBe(before);
	});
}

// The advice for a relative link, followed as written: made absolute, then
// moved out of the tree, it still leads where it led, and the reclaim goes.
test("a reclaim's advice for a relative link keeps it leading where it led when followed", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(root, "outside", "target.log"), "TARGET");
	await Bun.write(path.join(liveArtifacts, "plain.log"), "PLAIN");
	const link = path.join(liveArtifacts, "rel.link");
	await fs.symlink(path.relative(liveArtifacts, path.join(root, "outside", "target.log")), link);
	await archiveOnly();
	const reclaim = { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true };
	const first = await runGcCommand({ flags: reclaim });
	const said = first.reclaim?.errors.join("\n") ?? "";
	const command = /`(ln -sfn [^`]+)`/.exec(said)?.[1];
	expect(command).toBeDefined();

	expect(await Bun.spawn(["sh", "-c", command!]).exited).toBe(0);
	const movedTo = path.join(root, "rel.link");
	await fs.rename(link, movedTo);

	expect(await Bun.file(movedTo).text()).toBe("TARGET");
	expect((await runGcCommand({ flags: reclaim })).reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	expect(await Bun.file(movedTo).text()).toBe("TARGET");
});

// The review's six stationary cases: for each, whatever the preview
// promises the apply brings home, and whatever the apply refuses the
// preview refuses first — because the preview now runs the apply's own
// steps with each write replaced by a check.
const previewShapes = [
	"an archived file this user cannot read",
	"an archived directory at mode 0500",
	"a live tree that is the archived directory itself",
	"a staging ledger this user cannot write",
	"a missing live tree under a directory this user cannot write",
	"a missing transcript under a directory this user cannot write",
] as const;
for (const shape of previewShapes) {
	test.skipIf(process.getuid?.() === 0)(
		`a restore preview refuses exactly when applying fails, for ${shape}`,
		async () => {
			const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
			const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
			await Bun.write(path.join(liveArtifacts, "keep.log"), "KEEP");
			await archiveOnly();
			const restoreModes: [string, number][] = [];
			const lock = async (target: string, mode: number): Promise<void> => {
				restoreModes.push([target, (await fs.stat(target)).mode & 0o7777]);
				await fs.chmod(target, mode);
			};
			if (shape === "an archived file this user cannot read") {
				await Bun.write(path.join(archivedArtifacts, "only"), "UNIQUE ARCHIVED BYTES");
				await lock(path.join(archivedArtifacts, "only"), 0);
			}
			if (shape === "an archived directory at mode 0500") {
				await Bun.write(path.join(archivedArtifacts, "private", "only"), "UNIQUE ARCHIVED BYTES");
				await lock(path.join(archivedArtifacts, "private"), 0o500);
			}
			// The review's two shapes with an empty archived tree: nothing for a
			// separate walk to compare, so only the apply's own steps refuse.
			if (shape === "a live tree that is the archived directory itself") {
				await fs.rm(path.join(archivedArtifacts, "keep.log"));
				await fs.rm(liveArtifacts, { recursive: true });
				await fs.symlink(archivedArtifacts, liveArtifacts);
			}
			if (shape === "a staging ledger this user cannot write") {
				await Bun.write(path.join(archivedArtifacts, "only"), "UNIQUE ARCHIVED BYTES");
				await fs.mkdir(stagingLedgerDir(root), { recursive: true, mode: 0o700 });
				await lock(stagingLedgerDir(root), 0o500);
			}
			if (shape === "a missing live tree under a directory this user cannot write") {
				await fs.rm(path.join(archivedArtifacts, "keep.log"));
				await fs.rm(liveArtifacts, { recursive: true });
				await lock(path.dirname(liveArtifacts), 0o500);
			}
			if (shape === "a missing transcript under a directory this user cannot write") {
				await fs.rm(sessionFile);
				await Bun.write(path.join(archivedArtifacts, "only"), "UNIQUE ARCHIVED BYTES");
				await lock(path.dirname(sessionFile), 0o500);
			}
			let preview: GcResult;
			let applied: GcResult;
			try {
				preview = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });
				applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
			} finally {
				for (const [target, mode] of restoreModes.reverse()) await fs.chmod(target, mode).catch(() => undefined);
			}

			const previewRefused = (preview.restore?.errors.length ?? 0) > 0;
			const applyFailed = (applied.restore?.errors.length ?? 0) > 0;
			expect(previewRefused).toBe(applyFailed);
			for (const entry of preview.restore?.missingArtifacts ?? []) {
				expect(await fs.lstat(path.join(liveArtifacts, entry)).catch(() => undefined)).toBeDefined();
			}
			if (shape === "an archived directory at mode 0500") {
				// Made with the owner's bits added, so it can be filled: applying succeeds.
				expect(applyFailed).toBe(false);
				expect(preview.restore?.missingArtifacts).toEqual(["private"]);
				expect(await Bun.file(path.join(liveArtifacts, "private", "only")).text()).toBe("UNIQUE ARCHIVED BYTES");
				expect((await fs.stat(path.join(liveArtifacts, "private"))).mode & 0o7777).toBe(0o700);
			} else {
				expect(applyFailed).toBe(true);
			}
		},
	);
}

// A move that stops after the directory it moved into was renamed by
// someone else: the message names where the copy is now, read from the
// directory the command holds, not the path it had when the command began.
test("the printed command, stopped after its directory was renamed, names where that directory is now", async () => {
	const { ground } = await archivedWithKilledStage();
	const move = await printedCommand();
	const aside = path.join(await fs.realpath(root), `gc-quarantine-${path.basename(ground.record, ".json")}`);
	const renamed = path.join(root, "renamed-aside");
	const bin = path.join(root, "renaming-bin");
	await fs.mkdir(bin);
	await Bun.write(
		path.join(bin, "mv"),
		`#!/bin/sh\nfor a in "$@"; do [ "$a" = ${JSON.stringify(await fs.realpath(ground.dir))} ] && { ${Bun.which("mv")!} ${JSON.stringify(aside)} ${JSON.stringify(renamed)}; exit 1; }; done\nexec ${Bun.which("mv")!} "$@"\n`,
	);
	await fs.chmod(path.join(bin, "mv"), 0o755);

	const first = await runPrinted(move, { PATH: `${bin}:${process.env.PATH ?? ""}` });

	expect(first.exit).not.toBe(0);
	expect(first.said).toContain(`anything it copied is in ${await fs.realpath(renamed)}/1`);
	expect(first.said).not.toContain(`anything it copied is in ${aside}/1`);
});

// One archive bucket this user cannot read: the bucket is exactly where
// another candidate might be, so a lookup by id chooses nothing and names it.
// Skipping it instead let a formerly ambiguous prefix resolve to the one
// session the reclaim could see and give up that session's live copy — the
// review's wrong-session reclaim, exit 0, `reclaimed: 1`.
test.skipIf(process.getuid?.() === 0)(
	"an archive bucket this user cannot read stops a lookup by id from choosing, and a reclaim gives up nothing",
	async () => {
		const otherId = sessionId("029b1eee0f4c");
		const hiddenLive = path.join(getSessionsDir(root), "--hidden--");
		await fs.mkdir(hiddenLive, { recursive: true });
		const otherFile = path.join(hiddenLive, `2026-01-01T00-00-00-000Z_${otherId}.jsonl`);
		await Bun.write(otherFile, sessionBody(otherId, PROMPT, root));
		const old = new Date(Date.now() - 30 * 86_400_000);
		await fs.utimes(otherFile, old, old);
		await archiveOnly();
		const reclaim = { agentDir: root, reclaim: testPrefix, apply: true, forwardOnly: true, json: true };
		// Both readable: the shared prefix is ambiguous, and nothing is chosen.
		const ambiguous = await runGcCommand({ flags: reclaim });
		expect(ambiguous.reclaim?.reclaimed ?? 0).toBe(0);
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		const hidden = path.join(getArchivedSessionsDir(root), "--hidden--");
		expect(await Bun.file(path.join(hidden, `2026-01-01T00-00-00-000Z_${otherId}.jsonl.gz`)).exists()).toBe(true);
		await fs.chmod(hidden, 0o000);
		try {
			const reclaimed = await runGcCommand({ flags: reclaim });
			const restored = await runGcCommand({ flags: { agentDir: root, restore: testPrefix, json: true } });
			const unknown = await runGcCommand({ flags: { agentDir: root, restore: "zzzz9999", json: true } });
			// With no session directory given, as \`omp --resume <id>\` asks: one given
			// stops the lookup before it reaches the archive, and proves nothing.
			const resumed = resolveResumableSession("zzzz9999", root);

			expect(reclaimed.reclaim?.reclaimed ?? 0).toBe(0);
			expect(reclaimed.reclaim?.errors.join("\n")).toContain(`${hidden} (EACCES:`);
			expect(await Bun.file(sessionFile).exists()).toBe(true);
			expect(await Bun.file(otherFile).exists()).toBe(true);
			expect(restored.restore?.errors.join("\n")).toContain(`${hidden} (EACCES:`);
			expect(unknown.restore?.errors.join("\n")).toContain("none was chosen");
			await expect(resumed).rejects.toThrow(`${hidden} (EACCES:`);
		} finally {
			await fs.chmod(hidden, 0o700);
		}
	},
);

// Round 35. The review's chmod race, real: after the fill, the directory this
// restore made is renamed away and its name linked to a private directory of
// someone else's. No mode is set after the `mkdir` that makes a directory, so
// the private directory keeps `0700`, its file is untouched, and the restore
// says its directory was moved.
test.skipIf(process.getuid?.() === 0)(
	"a restore sets no mode on a name someone relinked after the fill, and says its directory was moved",
	async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "keep.log"), "KEEP");
		await Bun.write(path.join(liveArtifacts, "shared", "file.log"), "ARCHIVED");
		await fs.chmod(path.join(liveArtifacts, "shared"), 0o777);
		await archiveOnly();
		await fs.rm(path.join(liveArtifacts, "shared"), { recursive: true });
		const privateDir = path.join(root, "someone-private");
		await Bun.write(path.join(privateDir, "UNIQUE-ONLY-COPY"), "PRIVATE");
		await fs.chmod(privateDir, 0o700);
		const made = path.join(liveArtifacts, "shared");
		const movedAside = path.join(root, "moved-aside");
		let switched = false;
		const realRmdir = fs.rmdir;
		// The real removal of the stage staged inside the new directory is the
		// moment after the fill; the switch is a real rename and a real link.
		const rmdir = spyOn(fs, "rmdir").mockImplementation((async (target: string, ...rest: unknown[]) => {
			await (realRmdir as (...args: unknown[]) => Promise<void>)(target, ...rest);
			if (!switched && String(target).startsWith(`${made}${path.sep}`)) {
				switched = true;
				await fs.rename(made, movedAside);
				await fs.symlink(privateDir, made);
			}
		}) as typeof fs.rmdir);
		let result: GcResult;
		try {
			result = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
		} finally {
			rmdir.mockRestore();
		}

		expect(switched).toBe(true);
		expect((await fs.stat(privateDir)).mode & 0o7777).toBe(0o700);
		expect(await Bun.file(path.join(privateDir, "UNIQUE-ONLY-COPY")).text()).toBe("PRIVATE");
		// The mode the directory was made with, wherever it is now.
		expect((await fs.stat(movedAside)).mode & 0o7777).toBe(0o777 & ~process.umask());
		expect(result.restore?.errors.join("\n")).toContain(`${made} is no longer the directory this restore made`);
	},
);

// Round 36. The swap a descriptor opened after the `mkdir` cannot catch: a
// writer of this user's own renames the directory a restore just made away
// and puts a private directory of its own at the name before the restore
// opens it. A mode set through that descriptor reached the private
// directory, gave it the archived `0777`, and another user removed its only
// file — an inotify watcher won that race about a third of the time. No mode
// is set after the `mkdir` now, so the directory keeps its own, and one that
// is not empty is not filled.
test.skipIf(process.getuid?.() === 0)(
	"a directory swapped in between a restore's mkdir and its open keeps its own mode and is not filled",
	async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const archivedShared = path.join(archiveFile.slice(0, -".jsonl.gz".length), "shared");
		await Bun.write(path.join(liveArtifacts, "keep.log"), "KEEP");
		await Bun.write(path.join(liveArtifacts, "shared", "file.log"), "ARCHIVED");
		await archiveOnly();
		await fs.chmod(archivedShared, 0o777);
		await fs.rm(path.join(liveArtifacts, "shared"), { recursive: true });
		const privateDir = path.join(root, "someone-private");
		await Bun.write(path.join(privateDir, "UNIQUE-ONLY-COPY"), "PRIVATE");
		await fs.chmod(privateDir, 0o700);
		const made = path.join(liveArtifacts, "shared");
		let swapped = false;
		const realMkdir = fs.mkdir;
		// A real `mkdir`, then two real renames before the restore's next call.
		const mkdir = spyOn(fs, "mkdir").mockImplementation((async (target: string, ...rest: unknown[]) => {
			const created = await (realMkdir as (...args: unknown[]) => Promise<string | undefined>)(target, ...rest);
			if (!swapped && String(target) === made) {
				swapped = true;
				await fs.rename(made, path.join(root, "made-moved-aside"));
				await fs.rename(privateDir, made);
			}
			return created;
		}) as typeof fs.mkdir);
		let result: GcResult;
		try {
			result = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
		} finally {
			mkdir.mockRestore();
		}

		expect(swapped).toBe(true);
		expect((await fs.stat(made)).mode & 0o7777).toBe(0o700);
		expect(await fs.readdir(made)).toEqual(["UNIQUE-ONLY-COPY"]);
		expect(await Bun.file(path.join(made, "UNIQUE-ONLY-COPY")).text()).toBe("PRIVATE");
		expect(result.restore?.errors.join("\n")).toContain(`${made} is not the directory this run just made`);
		expect(await Bun.file(path.join(archivedShared, "file.log")).text()).toBe("ARCHIVED");
	},
);

// Round 36. A file an archive copy published, removed by somebody else, and
// its inode number handed by the kernel to a new file of theirs at the same
// name: a rollback that knew its file by that number deleted the new file,
// its only copy, and the error named only the other conflict. The copy now
// holds what it published open until it has finished or been undone, so the
// number cannot be handed out, and what the rollback leaves it names.
test("a failed archive copy's rollback keeps a file put where its copy was, and names it", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "ARCHIVED COPY");
	await Bun.write(path.join(liveArtifacts, "z.log"), "SECOND SESSION OUTPUT");
	// A different file the archive already holds: the real conflict that fails the copy.
	await Bun.write(path.join(archivedArtifacts, "z.log"), "UNRELATED ARCHIVE CONTENT");
	const archivedA = path.join(archivedArtifacts, "a.log");
	let reached = false;
	let reusedInode = false;
	const realStat = fs.stat;
	// After `a.log` is published and as `z.log` is reached: a real removal of
	// the published copy, then real creates until one is given its number.
	const stat = spyOn(fs, "stat").mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (
			!reached &&
			String(target) === path.join(liveArtifacts, "z.log") &&
			(await realStat(archivedA).catch(() => undefined))
		) {
			reached = true;
			const freed = (await realStat(archivedA)).ino;
			await fs.unlink(archivedA);
			let candidate = "";
			for (let i = 0; i < 64 && !reusedInode; i++) {
				candidate = path.join(archivedArtifacts, `scratch-${i}`);
				await Bun.write(candidate, "ONLY PRIVATE FILE");
				reusedInode = (await realStat(candidate)).ino === freed;
			}
			await fs.rename(candidate, archivedA);
		}
		return await (realStat as (...args: unknown[]) => Promise<Stats>)(target, ...rest);
	}) as typeof fs.stat);
	let result: GcResult;
	try {
		result = await archiveOnly();
	} finally {
		stat.mockRestore();
	}

	expect(reached).toBe(true);
	// Held open since it was published, the copy's number was not handed out.
	expect(reusedInode).toBe(false);
	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(archivedA).text()).toBe("ONLY PRIVATE FILE");
	expect(result.archive?.errors.join("\n")).toContain(`${archivedA} is not the copy this run put in the archive`);
	expect(await Bun.file(path.join(archivedArtifacts, "z.log")).text()).toBe("UNRELATED ARCHIVE CONTENT");
	expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("ARCHIVED COPY");
});

// Round 36. A writer without a lease that writes by name between the last
// proof and the removal: an `unlink` of the name took the late write with
// it. A reclaim now moves the file itself and deletes no original, so the
// write is never lost: written before the move, it moves with the file and a
// restore brings it home; written after — appended, or saved by renaming a
// new file onto the name — it is a new file of the writer's own at the live
// name, which makes the reclaim move the session back and say so.
for (const which of ["transcript", "artifact"] as const) {
	for (const when of [
		"appends before it is moved",
		"appends after it moved",
		"saves over it after it moved",
	] as const) {
		test(`a reclaim loses nothing a writer without a lease ${when}, by the ${which}'s name`, async () => {
			const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
			await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
			await archiveEverything();
			await restoreArchivedSession(archiveFile, root);
			const target = which === "transcript" ? sessionFile : path.join(liveArtifacts, "a.log");
			const container = which === "transcript" ? sessionFile : liveArtifacts;
			const late =
				which === "transcript"
					? `${JSON.stringify({ type: "message", id: "late", parentId: "m2", message: { role: "user", content: "ONLY LATE TURN" } })}\n`
					: "ONLY LATE TURN\n";
			let wrote = false;
			const write = async (): Promise<void> => {
				wrote = true;
				if (when === "saves over it after it moved") {
					const temp = path.join(path.dirname(target), "editor-save.tmp");
					await Bun.write(temp, late);
					await fs.rename(temp, target);
				} else {
					await fs.mkdir(path.dirname(target), { recursive: true });
					await fs.appendFile(target, late);
				}
			};
			// Before: once the walk has proved the file and before the run asks
			// the kernel for its lease. After: the moment the file's own move
			// (the transcript's, or the tree's) is made.
			const realLease = holders.takeSoleOpenLease;
			const lease = spyOn(holders, "takeSoleOpenLease").mockImplementation(fd => {
				if (!wrote && when === "appends before it is moved") {
					appendFileSync(target, late);
					wrote = true;
				}
				return realLease(fd);
			});
			const realMove = libcModule.renameNoReplace;
			const move = spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
				const moved = await realMove(from, to);
				if (!wrote && when !== "appends before it is moved" && from === container && moved.outcome === "renamed") {
					await write();
				}
				return moved;
			});
			let result: GcResult;
			try {
				result = await runGcCommand({ flags: reclaimApply() });
			} finally {
				lease.mockRestore();
				move.mockRestore();
			}
			const names = reclaimedNames();

			expect(wrote).toBe(true);
			if (when === "appends before it is moved") {
				// In the file when it moves, so it is in the archive with it, and
				// the restore brings it home.
				expect(result.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
				expect((await runGcCommand({ flags: restoreApply() })).restore?.errors).toEqual([]);
				expect(await Bun.file(target).text()).toContain("ONLY LATE TURN");
				return;
			}
			// A new file of the writer's own at the name, kept; the session's own
			// entry it displaced is named where it is now.
			expect(result.reclaim?.reclaimed).toBe(0);
			expect(await Bun.file(target).text()).toBe(late);
			expect(collectGcErrors(result).join("\n")).toContain(`${container} was written to after`);
			if (which === "transcript") {
				expect(result.reclaim?.moved).toEqual({ transcript: names.transcript });
				expect(await Bun.file(names.transcript).text()).not.toContain("ONLY LATE TURN");
				expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("FIRST");
			} else {
				expect(result.reclaim?.moved).toEqual({ artifacts: names.artifacts });
				expect(await Bun.file(path.join(names.artifacts, "a.log")).text()).toBe("FIRST");
				expect(await Bun.file(sessionFile).exists()).toBe(true);
			}
		});
	}
}

// The private name a reclaim moves an archived copy to before freeing it is
// taken by a rename that replaces nothing, so a file already standing at that
// name — planted, left over, or a collision — is never replaced by the move:
// the name is given up for a fresh one.
test("a file already at the private name a copy's freeing picks is kept, and another name is used", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	const copy = path.join(archivedArtifacts, "a.log");
	let planted: string | undefined;
	const realMove = libcModule.renameNoReplace;
	// A real file at the first private name, just before the run moves the copy there.
	const open = spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		if (planted === undefined && from === copy && isMovedAside(to, copy)) {
			planted = to;
			await Bun.write(planted, "SOMEBODY ELSE'S ONLY COPY");
		}
		return await realMove(from, to);
	});
	let result: GcResult;
	try {
		result = await runGcCommand({ flags: reclaimApply() });
	} finally {
		open.mockRestore();
	}

	expect(planted).toBeDefined();
	expect(await Bun.file(planted!).text()).toBe("SOMEBODY ELSE'S ONLY COPY");
	// The copy went by another private name; the planted file keeps its directory.
	expect(result.reclaim?.reclaimed).toBe(1);
	expect(result.reclaim?.freedCopies).toContain(copy);
	expect(await fs.readdir(archivedArtifacts)).toEqual([path.basename(planted!)]);
	expect(await Bun.file(path.join(reclaimedNames().artifacts, "a.log")).text()).toBe("FIRST");
});

// Round 36. A preview named a directory it would make as brought home while
// a step inside it refused; applying then made the directory and nothing
// past the refusal. A directory is named only when everything in it would
// come home, and what the preview names is what applying brings home.
for (const shape of [
	"a umask that takes the owner's write bit",
	"a file inside it too long a name to stage",
] as const) {
	test.skipIf(process.getuid?.() === 0)(`a restore preview does not promise a directory with ${shape}`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
		await Bun.write(path.join(liveArtifacts, "keep.log"), "KEEP");
		await archiveOnly();
		// Sorted after `a.txt`, and refused where applying stages it: a name
		// too long to stage beside its destination.
		const refused = path.join(archivedArtifacts, "folder", "x".repeat(244));
		await Bun.write(path.join(archivedArtifacts, "folder", "a.txt"), "UNIQUE ARCHIVED A");
		await Bun.write(refused, "UNIQUE ARCHIVED B");
		let umask: number | undefined;
		if (shape === "a umask that takes the owner's write bit") umask = process.umask(0o277);
		let preview: GcResult;
		let applied: GcResult;
		try {
			preview = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });
			applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
		} finally {
			if (umask !== undefined) process.umask(umask);
		}

		expect(preview.restore?.errors.length).toBeGreaterThan(0);
		expect(applied.restore?.errors.length).toBeGreaterThan(0);
		expect(preview.restore?.missingArtifacts ?? []).not.toContain("folder");
		for (const entry of preview.restore?.missingArtifacts ?? []) {
			expect(await fs.lstat(path.join(liveArtifacts, entry)).catch(() => undefined)).toBeDefined();
		}
		if (umask !== undefined) {
			// Refused before the directory is made, in the preview and in the apply alike.
			expect(preview.restore?.missingArtifacts ?? []).toEqual([]);
			expect(await fs.lstat(path.join(liveArtifacts, "folder")).catch(() => undefined)).toBeUndefined();
		} else {
			expect(preview.restore?.missingArtifacts).toEqual([path.join("folder", "a.txt")]);
		}
	});
}

// A restore preview looks at the session's ownership lease without taking
// it: one it held made a session opened meanwhile fork its next turn into a
// new session — the review saw the turn land in a new file, not the original.
test("a restore preview leaves the session's ownership lease free while it looks", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveOnly();
	const seen: (boolean | null)[] = [];
	const realReaddir = fs.readdir;
	const readdir = spyOn(fs, "readdir").mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (String(target) === archivedArtifacts) seen.push(isSessionLeaseHeld(SESSION_ID));
		return await (realReaddir as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
	}) as typeof fs.readdir);
	try {
		await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });
		const previewed = [...seen];
		seen.length = 0;
		await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

		expect(previewed.length).toBeGreaterThan(0);
		expect(previewed.every(held => held === false)).toBe(true);
		// Not vacuous: applying does take it, at the same boundary.
		expect(seen).toContain(true);
	} finally {
		readdir.mockRestore();
	}
});

// The relative-link advice keeps the names a link goes through: a link to
// `outside/current`, made absolute as the message says and moved out, still
// follows `current` when it moves from `v1` to `v2`. A resolved target would
// have frozen it at `v1`.
test("a reclaim's advice for a relative link through an alias keeps following the alias", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const outside = path.join(root, "outside");
	await Bun.write(path.join(outside, "v1", "f"), "FIRST");
	await Bun.write(path.join(outside, "v2", "f"), "SECOND UNIQUE");
	await fs.symlink("v1", path.join(outside, "current"));
	await Bun.write(path.join(liveArtifacts, "plain.log"), "PLAIN");
	const link = path.join(liveArtifacts, "cur.link");
	await fs.symlink(path.relative(liveArtifacts, path.join(outside, "current")), link);
	await archiveOnly();
	const reclaim = { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true };
	const said = (await runGcCommand({ flags: reclaim })).reclaim?.errors.join("\n") ?? "";
	const command = /`(ln -sfn [^`]+)`/.exec(said)?.[1];
	expect(command).toBeDefined();
	expect(command).toContain(path.join(await fs.realpath(outside), "current"));

	expect(await Bun.spawn(["sh", "-c", command!]).exited).toBe(0);
	const movedTo = path.join(root, "cur.link");
	await fs.rename(link, movedTo);
	expect((await runGcCommand({ flags: reclaim })).reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	await fs.rm(path.join(outside, "current"));
	await fs.symlink("v2", path.join(outside, "current"));

	expect(await Bun.file(path.join(movedTo, "f")).text()).toBe("SECOND UNIQUE");
});

// A target that steps back after a name that may be a link has no absolute
// form that keeps it: the message says so and lets the user choose.
test("a reclaim's advice says when a relative link's names cannot all be kept", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(root, "outside", "v1", "f"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "plain.log"), "PLAIN");
	const link = path.join(liveArtifacts, "back.link");
	const toOutside = path.relative(liveArtifacts, path.join(root, "outside"));
	await fs.symlink(`${toOutside}/v1/../v1/f`, link);
	await archiveOnly();

	const said =
		(
			await runGcCommand({ flags: { agentDir: root, reclaim: archiveFile, forwardOnly: true, json: true } })
		).reclaim?.errors.join("\n") ?? "";

	expect(said).toContain("so no absolute form keeps it as it is");
	expect(said).not.toContain("ln -sfn");
});

// The review's two stationary disagreements: preview and apply on unchanged
// objects. A name too long to stage, and a umask that leaves its maker unable
// to write the directories a restore makes by name: the preview now refuses
// where applying fails, and promises nothing it would not bring home.
for (const shape of ["an archived file whose name is too long to stage", "a umask of 0277"] as const) {
	test.skipIf(process.getuid?.() === 0)(
		`a restore preview refuses exactly when applying fails, for ${shape}`,
		async () => {
			const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
			const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
			await Bun.write(path.join(liveArtifacts, "keep.log"), "KEEP");
			await archiveOnly();
			if (shape === "an archived file whose name is too long to stage") {
				await Bun.write(path.join(archivedArtifacts, "x".repeat(244)), "UNIQUE ARCHIVED BYTES");
			} else {
				await Bun.write(path.join(archivedArtifacts, "only"), "UNIQUE ARCHIVED BYTES");
			}
			const previous = shape === "a umask of 0277" ? process.umask(0o277) : undefined;
			let preview: GcResult;
			let applied: GcResult;
			try {
				preview = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });
				applied = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
			} finally {
				if (previous !== undefined) process.umask(previous);
			}

			expect((preview.restore?.errors.length ?? 0) > 0).toBe(true);
			expect((applied.restore?.errors.length ?? 0) > 0).toBe(true);
			expect(preview.restore?.errors.join("\n")).toContain(
				shape === "a umask of 0277" ? "would be made under umask 0277" : "has a name too long to stage",
			);
			expect(preview.restore?.missingArtifacts ?? []).toEqual([]);
		},
	);
}

// Round 36. Opening a reclaimed session with 4,001 artifacts took 21 s under
// load with nothing printed, which reads as a program that has hung. Whoever
// opens it is told at once that it is coming out of the archive, and then
// how many of its artifact files have come home.
test("opening a session the archive holds says it is bringing it back, with a count of its artifact files", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	for (let i = 0; i < 3; i++) await Bun.write(path.join(liveArtifacts, `a${i}.log`), `ART-${i}`);
	await archiveEverything();
	expect(await Bun.file(sessionFile).exists()).toBe(false);

	const said: string[] = [];
	expect(await materializeSessionFile(archiveFile, root, line => said.push(line))).toBe(sessionFile);

	expect(said[0]).toBe(`Bringing session ${SESSION_ID} back from the archive…`);
	expect(said.at(-1)).toBe(`Bringing session ${SESSION_ID} back from the archive: 3 of 3 artifact files`);
	expect(await Bun.file(path.join(liveArtifacts, "a2.log")).text()).toBe("ART-2");
});

/**
 * A restore of a session whose archived `shared` directory has mode `0700`
 * and holds one file, with the live `shared` gone, so the restore makes it.
 */
async function restoreThatMakesShared(): Promise<{ made: string; archivedShared: string }> {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "keep.log"), "KEEP");
	await Bun.write(path.join(liveArtifacts, "shared", "file.log"), "ARCHIVED");
	await fs.chmod(path.join(liveArtifacts, "shared"), 0o700);
	await archiveOnly();
	await fs.rm(path.join(liveArtifacts, "shared"), { recursive: true });
	return {
		made: path.join(liveArtifacts, "shared"),
		archivedShared: path.join(archiveFile.slice(0, -".jsonl.gz".length), "shared"),
	};
}

// Round 38, the fill. A same-user process swaps an empty `0777` directory in
// at the name of the directory a restore just made, before the restore
// looks. It is a directory, this user's and empty, so a check of only those
// took it for the restore's own: the restore filled it, reported success,
// and another user could list and delete the restored artifact. A directory
// the `mkdir` made carries exactly the mode the `mkdir` gave it, and this one
// does not, so it is refused and nothing is put into it.
test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
	"an empty directory swapped in at a restore's new directory with another mode is refused, not filled",
	async () => {
		const { made, archivedShared } = await restoreThatMakesShared();
		const planted = path.join(root, "planted-open");
		await fs.mkdir(planted);
		await fs.chmod(planted, 0o777);
		let swapped = false;
		const realMkdir = fs.mkdir;
		// A real `mkdir`, then two real renames before the restore's next call.
		const mkdir = spyOn(fs, "mkdir").mockImplementation((async (target: string, ...rest: unknown[]) => {
			const created = await (realMkdir as (...args: unknown[]) => Promise<string | undefined>)(target, ...rest);
			if (!swapped && String(target) === made) {
				swapped = true;
				await fs.rename(made, path.join(root, "made-moved-aside"));
				await fs.rename(planted, made);
			}
			return created;
		}) as typeof fs.mkdir);
		let result: GcResult;
		try {
			result = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
		} finally {
			mkdir.mockRestore();
		}

		expect(swapped).toBe(true);
		expect(await fs.readdir(made)).toEqual([]);
		expect((await fs.stat(made)).mode & 0o777).toBe(0o777);
		expect(result.restore?.errors.join("\n")).toContain(`${made} is not the directory this run just made`);
		expect(await Bun.file(path.join(archivedShared, "file.log")).text()).toBe("ARCHIVED");
	},
);

// Round 38, where the open follows a link. gVisor was measured following a
// link to a directory under `O_DIRECTORY | O_NOFOLLOW`, which an ordinary
// Linux kernel refuses with `ENOTDIR`; that is emulated here by opening the
// name without `O_NOFOLLOW`. The link leads to an empty directory of this
// user's with exactly the mode the restore's own would have, so it passes
// every check but one: the descriptor's device and inode against what the
// look straight after the `mkdir` found.
test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
	"a link put at a restore's new directory is refused by its identity even where the open follows it",
	async () => {
		const { made, archivedShared } = await restoreThatMakesShared();
		const planted = path.join(root, "planted-private");
		await fs.mkdir(planted, { mode: 0o700 });
		let swapped = false;
		const realOpen = fs.open;
		const open = spyOn(fs, "open").mockImplementation((async (target: string, flags: unknown, ...rest: unknown[]) => {
			const opening = realOpen as (...args: unknown[]) => Promise<fs.FileHandle>;
			if (
				!swapped &&
				String(target) === made &&
				typeof flags === "number" &&
				(flags & fsConstants.O_DIRECTORY) !== 0
			) {
				swapped = true;
				await fs.rename(made, path.join(root, "made-moved-aside"));
				await fs.symlink(planted, made);
				// What gVisor does with these flags: it follows the link.
				return await opening(target, flags & ~fsConstants.O_NOFOLLOW, ...rest);
			}
			return await opening(target, flags, ...rest);
		}) as typeof fs.open);
		let result: GcResult;
		try {
			result = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
		} finally {
			open.mockRestore();
		}

		expect(swapped).toBe(true);
		expect(await fs.readdir(planted)).toEqual([]);
		expect(result.restore?.errors.join("\n")).toContain(`${made} is not the directory this run just made`);
		expect(await Bun.file(path.join(archivedShared, "file.log")).text()).toBe("ARCHIVED");
	},
);

// Round 38, the delete. An empty directory of somebody's, put at the name of
// an archive's staging directory once the staged file had gone: an `rmdir` of
// the name removed it, with what it carried — the review's held a unique
// extended attribute — and the archive reported success. The staging
// directory goes only while its name holds the very directory this run made.
test("an empty directory put at an archive's staging directory is kept, and named", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "A");
	const foreign = path.join(root, "foreign-empty");
	await fs.mkdir(foreign);
	const foreignIno = (await fs.stat(foreign)).ino;
	let stage = "";
	const realUnlink = fs.unlink;
	const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
		await realUnlink(target);
		const at = String(target);
		if (
			!stage &&
			at.startsWith(`${archivedArtifacts}${path.sep}`) &&
			isStagedFile(at) &&
			path.basename(at) === "a.log"
		) {
			stage = path.dirname(at);
			await fs.rename(stage, path.join(root, "stage-moved-aside"));
			await fs.rename(foreign, stage);
		}
	});
	let result: GcResult;
	try {
		result = await archiveOnly();
	} finally {
		unlink.mockRestore();
	}

	expect(stage).not.toBe("");
	expect((await fs.stat(stage)).ino).toBe(foreignIno);
	expect(collectGcErrors(result).join("\n")).toContain(`${stage} is not the directory this run made`);
	expect(await Bun.file(path.join(archivedArtifacts, "a.log")).text()).toBe("A");
});

// Round 38, the same for a reclaim: an empty directory put where a proved
// live directory stood went with an `rmdir` of the name. A reclaim moves a
// tree only while every directory's name holds the very directory it proved,
// held open since, and once it has moved finds any entry it never proved.
for (const when of ["before the moves", "between the moves"] as const) {
	test(`an empty directory put where a reclaim's proved directory stood ${when} is kept, and named`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const sub = path.join(liveArtifacts, "sub");
		await Bun.write(path.join(sub, "a.log"), "A");
		await archiveOnly();
		const foreign = path.join(root, "foreign-empty");
		await fs.mkdir(foreign);
		const foreignIno = (await fs.stat(foreign)).ino;
		let swapped = false;
		const swap = (): void => {
			if (swapped) return;
			swapped = true;
			renameSync(sub, path.join(root, "sub-moved-aside"));
			renameSync(foreign, sub);
		};
		const realLease = holders.takeSoleOpenLease;
		spyOn(holders, "takeSoleOpenLease").mockImplementation(fd => {
			if (when === "before the moves") swap();
			return realLease(fd);
		});
		const realMove = libcModule.renameNoReplace;
		spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
			if (when === "between the moves" && from === liveArtifacts) swap();
			return await realMove(from, to);
		});
		let result: GcResult;
		try {
			result = await runGcCommand({ flags: reclaimApply() });
		} finally {
			mock.restore();
		}

		expect(swapped).toBe(true);
		expect((await fs.stat(sub)).ino).toBe(foreignIno);
		expect(result.reclaim?.reclaimed).toBe(0);
		expect(result.reclaim?.moved).toBeUndefined();
		expect(collectGcErrors(result).join("\n")).toContain(sub);
		expect(await Bun.file(sessionFile).exists()).toBe(true);
		expect(await fs.lstat(reclaimedNames().artifacts).catch(() => undefined)).toBeUndefined();
	});
}

// Round 38. A shorter archived copy a longer one supersedes was judged at its
// private name by identity alone, so bytes appended to it by name between
// the proof and the move went with it while the archive exited 0. It goes
// only while it holds exactly the bytes proved; anything more goes back.
for (const which of ["transcript", "artifact"] as const) {
	test(`an archive keeps bytes appended to the shorter archived ${which} just before it is superseded`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const archivedTool = path.join(archiveFile.slice(0, -".jsonl.gz".length), "tool.log");
		await Bun.write(path.join(liveArtifacts, "tool.log"), "PREFIX");
		await archiveEverything();
		await restoreArchivedSession(archiveFile, root);
		await Bun.write(sessionFile, `${await Bun.file(sessionFile).text()}${JSON.stringify({ type: "later" })}\n`);
		await Bun.write(path.join(liveArtifacts, "tool.log"), "PREFIX-AND-MORE");
		const target = which === "transcript" ? archiveFile : archivedTool;
		const unique =
			which === "transcript" ? Buffer.from(gzipSync("UNIQUE APPENDED MEMBER\n")) : Buffer.from("UNIQUE APPENDED");
		let appended = false;
		const realMove = libcModule.renameNoReplace;
		const rename = spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
			if (!appended && from === target && isMovedAside(to, target)) {
				appended = true;
				await fs.appendFile(target, unique);
			}
			return await realMove(from, to);
		});
		let result: GcResult;
		try {
			result = await archiveOnly();
		} finally {
			rename.mockRestore();
		}

		expect(appended).toBe(true);
		const held = await fs.readFile(target);
		expect(held.subarray(held.length - unique.length).equals(unique)).toBe(true);
		expect(collectGcErrors(result).join("\n")).toContain(`${target} changed while it was being archived`);
	});
}

// Round 38. A failed archive copy's rollback judged the copy it published by
// identity alone, so bytes appended to it by name before the move went with
// it. It goes only while it holds exactly what this copy wrote.
test("an archive rollback keeps bytes appended by name to a copy it published", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "ORIGINAL A");
	await Bun.write(path.join(liveArtifacts, "z.log"), "SECOND SESSION OUTPUT");
	// A different file the archive already holds: the conflict that fails the copy.
	await Bun.write(path.join(archivedArtifacts, "z.log"), "UNRELATED ARCHIVE CONTENT");
	const archivedA = path.join(archivedArtifacts, "a.log");
	let appended = false;
	const realMove = libcModule.renameNoReplace;
	const rename = spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		if (!appended && from === archivedA && isMovedAside(to, archivedA)) {
			appended = true;
			await fs.appendFile(archivedA, " UNIQUE LATE BYTES");
		}
		return await realMove(from, to);
	});
	let result: GcResult;
	try {
		result = await archiveOnly();
	} finally {
		rename.mockRestore();
	}

	expect(appended).toBe(true);
	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(archivedA).text()).toBe("ORIGINAL A UNIQUE LATE BYTES");
	expect(collectGcErrors(result).join("\n")).toContain(`${archivedA} is not the copy this run put in the archive`);
});

// Round 38. A staging directory the `mkdir` made but the run could not then
// prove it made — here the `open` that proves it is refused — had its record
// taken down, and the directory stayed with nothing naming it: a later
// restore would carry it home as somebody's artifact. The record stays while
// anything stands at the name, and the run names both.
test("a staging directory the run could not prove it made keeps its record, and is named", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "A");
	let refused = "";
	const realOpen = fs.open;
	const open = spyOn(fs, "open").mockImplementation((async (target: string, flags: unknown, ...rest: unknown[]) => {
		const at = String(target);
		if (
			!refused &&
			at.startsWith(`${archivedArtifacts}${path.sep}.a.log.`) &&
			at.endsWith(".tmp") &&
			typeof flags === "number" &&
			(flags & fsConstants.O_DIRECTORY) !== 0
		) {
			refused = at;
			throw Object.assign(new Error("EMFILE: injected"), { code: "EMFILE" });
		}
		return await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, flags, ...rest);
	}) as typeof fs.open);
	let result: GcResult;
	try {
		result = await archiveOnly();
	} finally {
		open.mockRestore();
	}

	expect(refused).not.toBe("");
	expect((await fs.lstat(refused)).isDirectory()).toBe(true);
	expect(collectGcErrors(result).join("\n")).toContain(`${refused} was left where it is, and the staging record`);
	const records = await Promise.all(
		(await fs.readdir(stagingLedgerDir(root)))
			.filter(name => name.endsWith(".json"))
			.map(
				async name => JSON.parse(await Bun.file(path.join(stagingLedgerDir(root), name)).text()) as { dir: string },
			),
	);
	expect(records.map(record => record.dir)).toContain(refused);
});

/** Lines a child process prints, one at a time; an ended stream reads as the empty line. */
function linesOf(stream: ReadableStream<Uint8Array>): () => Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	return async () => {
		for (;;) {
			const at = buffered.indexOf("\n");
			if (at >= 0) {
				const line = buffered.slice(0, at);
				buffered = buffered.slice(at + 1);
				return line;
			}
			const chunk = await reader.read();
			if (chunk.done) {
				const rest = buffered;
				buffered = "";
				return rest;
			}
			buffered += decoder.decode(chunk.value, { stream: true });
		}
	};
}

// A process list is a snapshot. A writer that opened an artifact before the
// reclaim forked once the list was read and closed its own copy, so the
// descriptor lived on only in a child no list held; the reclaim gave the
// file up and the child's output went into an inode nothing named. The
// kernel's lease counts the descriptor however it was passed on.
test("a reclaim keeps a file only a forked child holds open, and what the child writes stays", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const artifact = path.join(liveArtifacts, "a.log");
	await Bun.write(artifact, "FIRST");
	await archiveOnly();
	// A shell, not `python3`: in an agent session `python3` is mise's shim,
	// which took 2.6 to 10 seconds a start on a loaded machine. The subshell
	// is a fork that inherits fd 3; the parent closes its own copy once the
	// child exists. The child reads its go-ahead from a copy of stdin, since a
	// background list's own stdin is `/dev/null`.
	const script = [
		'exec 3>>"$1"',
		"exec 4<&0",
		"echo READY",
		"read -r line",
		"( read -r more <&4; printf ' LATE CHILD OUTPUT' >&3; exit 0 ) &",
		"child=$!",
		"exec 3>&-",
		'echo "FORKED $child"',
		'wait "$child"',
	].join("\n");
	const writer = Bun.spawn(["sh", "-c", script, "sh", artifact], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const next = linesOf(writer.stdout);
	expect(await next()).toBe("READY");
	// The fork lands just after the reclaim reads the process list, so the
	// child is in no list it reads.
	const realReaddir = fs.readdir;
	let child = 0;
	spyOn(fs, "readdir").mockImplementation((async (...args: unknown[]) => {
		const listed = await (realReaddir as (...rest: unknown[]) => Promise<unknown[]>)(...args);
		if (child === 0 && String(args[0]) === "/proc") {
			writer.stdin.write("fork\n");
			writer.stdin.flush();
			child = Number((await next()).split(" ")[1]);
			expect(listed.map(String)).not.toContain(String(child));
		}
		return listed;
	}) as unknown as typeof fs.readdir);
	let result: GcResult;
	try {
		result = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
	} finally {
		mock.restore();
		writer.stdin.write("write\n");
		await writer.stdin.end();
	}
	const exit = await writer.exited;

	expect(child).toBeGreaterThan(0);
	expect(exit).toBe(0);
	expect(result.reclaim?.reclaimed).toBe(0);
	expect(result.reclaim?.moved).toBeUndefined();
	const said = result.reclaim?.errors.join("\n") ?? "";
	expect(said).toContain(`${artifact} is open or mapped elsewhere`);
	expect(said).toMatch(/nor does this process through another descriptor|This process holds no other descriptor/);
	expect(said).toContain("EAGAIN");
	expect(said).toContain("fuser -v");
	expect(await Bun.file(artifact).text()).toBe("FIRST LATE CHILD OUTPUT");
	expect(await Bun.file(sessionFile).exists()).toBe(true);
}, 60_000);

// While the lease stands, another process's open of the file waits; the
// reclaim sees the break once it has moved the session, moves it back, and
// lets go, so the opener goes on at once and what it writes stays under the
// file's name.
test("a reclaim moves back a file another process opens while it is moving it, and lets that process go on", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const artifact = path.join(liveArtifacts, "a.log");
	await Bun.write(artifact, "FIRST");
	await archiveOnly();
	const inode = (await fs.stat(artifact)).ino;
	// Another process, started from this one's own executable rather than
	// `python3`, mise's slow shim in an agent session. Its `open` waits in the
	// kernel while the lease stands.
	const script =
		'import * as fs from "node:fs";\nconst started = performance.now();\n' +
		'const fd = fs.openSync(process.env.OPEN_FILE ?? "", "a");\n' +
		"const waited = (performance.now() - started) / 1000;\n" +
		'fs.writeSync(fd, " OPENER BYTES");\nfs.fsyncSync(fd);\nfs.closeSync(fd);\nconsole.log(waited.toFixed(2));\n';
	let opener: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
	const realMove = libcModule.renameNoReplace;
	spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		if (opener === undefined && from === sessionFile) {
			const started = Bun.spawn([process.execPath, "-e", script], {
				env: { ...process.env, OPEN_FILE: artifact },
				stdout: "pipe",
				stderr: "pipe",
			});
			opener = started;
			// The open is under way once the kernel lists the lease on that inode
			// as breaking — or, with no lease to wait on, once the opener is done.
			// No call returns when a lease starts to break, so this looks.
			const deadline = Date.now() + 20_000;
			const breaking = async (): Promise<boolean> =>
				(await fs.readFile("/proc/locks", "utf8"))
					.split("\n")
					.some(line => line.includes("BREAKING") && line.includes(`:${inode} `));
			while (started.exitCode === null && !(await breaking()) && Date.now() < deadline) await Bun.sleep(10);
		}
		return await realMove(from, to);
	});

	const result = await runGcCommand({ flags: reclaimApply() });
	mock.restore();
	expect(opener).toBeDefined();
	const exit = await opener!.exited;
	const waited = Number((await new Response(opener!.stdout).text()).trim());

	expect(exit).toBe(0);
	expect(result.reclaim?.reclaimed).toBe(0);
	expect(result.reclaim?.moved).toBeUndefined();
	expect(result.reclaim?.errors.join("\n")).toContain(
		`the kernel broke this run's lease on ${artifact}: an open of it was made or tried, or it was truncated`,
	);
	expect(result.reclaim?.errors.join("\n")).not.toContain("was opened by another process");
	// Well short of the kernel's 45-second break time: the reclaim let go.
	expect(waited).toBeLessThan(30);
	expect(await Bun.file(artifact).text()).toBe("FIRST OPENER BYTES");
	expect((await fs.stat(artifact)).ino).toBe(inode);
}, 90_000);

// A refusal after the leases were taken lets every one of them go: another
// process opens the file at once rather than waiting out the kernel's break.
test("a reclaim that refuses after taking its leases lets go of them", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const artifact = path.join(liveArtifacts, "a.log");
	await Bun.write(artifact, "FIRST");
	await archiveOnly();
	const realMove = libcModule.renameNoReplace;
	let injected = false;
	spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		if (from === liveArtifacts) {
			injected = true;
			throw new Error("INJECTED FAILURE AFTER THE LEASE");
		}
		return await realMove(from, to);
	});

	const result = await runGcCommand({ flags: reclaimApply() });
	mock.restore();
	// Another process, started from this one's own executable: a `python3`
	// here is mise's shim in an agent session, whose start-up alone can
	// outlast the bound below.
	const started = performance.now();
	const opened = Bun.spawnSync(
		[process.execPath, "-e", 'require("node:fs").closeSync(require("node:fs").openSync(process.env.OPEN_FILE, "a"))'],
		{ env: { ...process.env, OPEN_FILE: artifact } },
	);
	const waited = performance.now() - started;

	expect(injected).toBe(true);
	expect(result.reclaim?.reclaimed).toBe(0);
	expect(result.reclaim?.errors.join("\n")).toContain("INJECTED FAILURE AFTER THE LEASE");
	expect(opened.exitCode).toBe(0);
	expect(waited).toBeLessThan(10_000);
	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await fs.lstat(reclaimedNames().transcript).catch(() => undefined)).toBeUndefined();
}, 60_000);

// An attribute given to a file, a directory or the transcript after the
// proof was lost with it when the reclaim deleted the original. It moves
// with the entry now, and the restore gives it back.
for (const which of ["an artifact", "an artifact directory", "the transcript"] as const) {
	test(`a reclaim moves ${which} given an extended attribute after it was proved, and the restore gives it back`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const nested = path.join(liveArtifacts, "nested");
		await Bun.write(path.join(nested, "a.log"), "FIRST");
		const target =
			which === "an artifact"
				? path.join(nested, "a.log")
				: which === "an artifact directory"
					? nested
					: sessionFile;
		const inode = (await fs.stat(target)).ino;
		await archiveOnly();
		const realMove = libcModule.renameNoReplace;
		let fired = false;
		spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
			if (!fired && from === sessionFile) {
				fired = true;
				setTestXattr(target, "ADDED AFTER THE PROOF");
			}
			return await realMove(from, to);
		});
		try {
			await reclaimThenRestore();
		} finally {
			mock.restore();
		}

		expect(fired).toBe(true);
		expect(testXattr(target)).toBe("ADDED AFTER THE PROOF");
		expect((await fs.stat(target)).ino).toBe(inode);
		expect(await Bun.file(path.join(nested, "a.log")).text()).toBe("FIRST");
	}, 60_000);
}

test("a reclaim moves a directory narrowed after it was proved, and the restore gives back that mode", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const nested = path.join(liveArtifacts, "nested");
	await Bun.write(path.join(nested, "a.log"), "FIRST");
	await fs.chmod(nested, 0o755);
	await archiveOnly();
	const realMove = libcModule.renameNoReplace;
	let fired = false;
	spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		if (!fired && from === sessionFile) {
			fired = true;
			await fs.chmod(nested, 0o700);
		}
		return await realMove(from, to);
	});
	try {
		await reclaimThenRestore();
	} finally {
		mock.restore();
	}

	expect(fired).toBe(true);
	expect((await fs.stat(nested)).mode & 0o777).toBe(0o700);
	expect(await Bun.file(path.join(nested, "a.log")).text()).toBe("FIRST");
}, 60_000);

// What a moved original gains while it is in the archive — an attribute
// given to a directory once the tree moved and its copies are being freed —
// is the original's, and the restore brings it home.
test("a directory given an attribute after it moved into the archive comes back with it", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const nested = path.join(liveArtifacts, "nested");
	await Bun.write(path.join(nested, "a.log"), "FIRST");
	await archiveOnly();
	const movedNested = path.join(reclaimedNames().artifacts, "nested");
	const realMove = libcModule.renameNoReplace;
	let fired = false;
	spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		const moved = await realMove(from, to);
		if (!fired && from === liveArtifacts && moved.outcome === "renamed") {
			fired = true;
			setTestXattr(movedNested, "ADDED ONCE IT MOVED");
		}
		return moved;
	});
	try {
		await reclaimThenRestore();
	} finally {
		mock.restore();
	}

	expect(fired).toBe(true);
	expect(testXattr(nested)).toBe("ADDED ONCE IT MOVED");
	expect(await Bun.file(path.join(nested, "a.log")).text()).toBe("FIRST");
}, 60_000);

// An archive narrows an archived directory it already holds; it must narrow
// what the directory is when it changes it, not what it was when first seen.
test("archiving narrows an archived directory from the mode it has, never widening it", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const live = path.join(liveArtifacts, "private");
	const archived = path.join(archiveFile.slice(0, -".jsonl.gz".length), "private");
	await Bun.write(path.join(live, "secret"), "PRIVATE ARTIFACT");
	await fs.chmod(live, 0o755);
	await archiveOnly();
	await fs.chmod(archived, 0o777);
	const realOpen = fs.open;
	let fired = false;
	spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
		const handle = await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
		if (!fired && String(target) === archived) {
			fired = true;
			await fs.chmod(archived, 0o700);
		}
		return handle;
	}) as typeof fs.open);

	const result = await archiveOnly();
	mock.restore();

	expect(fired).toBe(true);
	expect(result.archive?.errors).toEqual([]);
	expect((await fs.stat(archived)).mode & 0o777).toBe(0o700);
});

/** Reclaim the session, then restore it: both succeed, the reclaim by moving it and the restore by moving it back. */
async function reclaimThenRestore(): Promise<void> {
	expect((await runGcCommand({ flags: reclaimApply() })).reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	expect((await runGcCommand({ flags: restoreApply() })).restore?.errors).toEqual([]);
}

// A second name of a file is something no copy can carry. A reclaim moves
// the file itself, so the restore gives back the very file, both names on it.
test("a reclaim moves a file that has another name, and the restore gives back the very file", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const artifact = path.join(liveArtifacts, "a.log");
	await Bun.write(artifact, "FIRST");
	await archiveOnly();
	const second = path.join(root, "second-name");
	await fs.link(artifact, second);
	const before = await fs.stat(artifact);

	await reclaimThenRestore();

	const after = await fs.stat(artifact);
	expect([after.ino, after.nlink]).toEqual([before.ino, 2]);
	expect((await fs.stat(second)).ino).toBe(before.ino);
	expect(await Bun.file(artifact).text()).toBe("FIRST");
});

// A file made executable after it was archived: the archived copy's mode no
// longer matters, since the file itself is what moves.
test("a reclaim moves a file whose archived copy has a narrower mode, and the restore gives back its own mode", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const artifact = path.join(liveArtifacts, "run.sh");
	await Bun.write(artifact, "#!/bin/sh\necho ok\n");
	await fs.chmod(artifact, 0o644);
	await archiveOnly();
	await fs.chmod(artifact, 0o755);
	const inode = (await fs.stat(artifact)).ino;

	await reclaimThenRestore();

	expect((await fs.stat(artifact)).mode & 0o777).toBe(0o755);
	expect((await fs.stat(artifact)).ino).toBe(inode);
}, 60_000);

// A group no new file there would take: the file itself keeps it.
test("a reclaim moves a file with a group a new file would not take, and the restore gives it back", async () => {
	const egid = process.getegid?.();
	const other = process.getgroups?.().find(group => group !== egid);
	if (egid === undefined || other === undefined) return;
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const artifact = path.join(liveArtifacts, "a.log");
	await Bun.write(artifact, "FIRST");
	await fs.chown(artifact, process.getuid?.() ?? -1, other);
	await archiveOnly();

	await reclaimThenRestore();

	expect((await fs.stat(artifact)).gid).toBe(other);
});

// Inode flags are the filesystem's, and no copy takes them: a no-dump flag
// set by hand comes back on the very file a reclaim moved.
test("a reclaim moves a file carrying an inode flag set by hand, and the restore gives it back", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const artifact = path.join(liveArtifacts, "a.log");
	await Bun.write(artifact, "FIRST");
	const set = Bun.spawnSync(["chattr", "+d", artifact], { stdout: "ignore", stderr: "ignore" });
	// A filesystem that keeps no such flags has nothing to lose.
	if (set.exitCode !== 0) return;
	const flags = (): string =>
		Bun.spawnSync(["lsattr", "-d", artifact], { stdout: "pipe", stderr: "ignore" }).stdout.toString().split(" ")[0] ??
		"";
	const before = flags();
	expect(before).toContain("d");
	const inode = (await fs.stat(artifact)).ino;
	await archiveOnly();

	await reclaimThenRestore();

	expect(flags()).toBe(before);
	expect((await fs.stat(artifact)).ino).toBe(inode);
	expect(await Bun.file(artifact).text()).toBe("FIRST");
});

// A directory somebody put at the name before the run looked, carrying an
// attribute of its own, is not the one the `mkdir` made: it is refused, and
// nothing is put into it or removed with it.
test("a directory swapped in with the run's mode but an attribute of its own is refused", async () => {
	const target = path.join(root, "new-stage");
	const realMkdir = fs.mkdir;
	let fired = false;
	spyOn(fs, "mkdir").mockImplementation((async (dir: string, ...rest: unknown[]) => {
		const made = await (realMkdir as (...args: unknown[]) => Promise<string | undefined>)(dir, ...rest);
		if (!fired && String(dir) === target) {
			fired = true;
			await fs.rename(target, `${target}.made`);
			await realMkdir(target, { mode: 0o700 });
			await fs.chmod(target, 0o700 & ~process.umask());
			setTestXattr(target, "FOREIGN DIRECTORY");
		}
		return made;
	}) as typeof fs.mkdir);

	let refused: unknown;
	try {
		const held = await makeHeldDirectory(target, 0o700);
		await held.handle.close();
	} catch (error) {
		refused = error;
	}
	mock.restore();

	expect(fired).toBe(true);
	expect(String(refused)).toContain(`${target} is not the directory this run just made`);
	expect(testXattr(target)).toBe("FOREIGN DIRECTORY");
});

// A rename replaces whatever has the new name. A review's watcher learned the
// private name gc was about to move a file to from the directory's events,
// and renamed a file of its own onto it; gc then removed that file. A copy a
// reclaim frees moves to a private name by a rename that replaces nothing,
// and what is found there afterwards is put back or left, never removed.
test("a reclaim never removes a file another process renames onto the private name an archived copy moves to", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveOnly();
	const copy = path.join(archiveFile.slice(0, -".jsonl.gz".length), "a.log");
	const theirs = path.join(root, "their-file");
	await Bun.write(theirs, "USER_ONLY_UNARCHIVED");
	const realMove = libcModule.renameNoReplace;
	let acted: string | undefined;
	spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		const moved = await realMove(from, to);
		if (acted === undefined && from === copy && moved.outcome === "renamed") {
			acted = to;
			renameSync(theirs, acted);
		}
		return moved;
	});

	const result = await runGcCommand({ flags: reclaimApply() });
	mock.restore();

	expect(acted).toBeDefined();
	// The originals moved; only the copy's freeing stopped, and says where.
	expect(result.reclaim?.reclaimed).toBe(1);
	expect(result.reclaim?.errors.join("\n")).toContain(copy);
	const survivors = await Promise.all(
		[copy, acted!].map(at =>
			Bun.file(at)
				.text()
				.catch(() => ""),
		),
	);
	expect(survivors).toContain("USER_ONLY_UNARCHIVED");
	expect(await Bun.file(path.join(reclaimedNames().artifacts, "a.log")).text()).toBe("FIRST");
}, 60_000);

// The same for a directory: an emptied copy directory goes only while its
// name holds the very directory held open since freeing began, so one of
// another process's put there, with an attribute of its own, is kept.
test("a reclaim never removes a directory another process puts where an emptied copy directory stood", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "nested", "a.log"), "FIRST");
	await archiveOnly();
	const archivedNested = path.join(archiveFile.slice(0, -".jsonl.gz".length), "nested");
	const copy = path.join(archivedNested, "a.log");
	const theirs = path.join(root, "their-directory");
	await fs.mkdir(theirs, { mode: 0o700 });
	setTestXattr(theirs, "THEIR DIRECTORY ONLY");
	const realUnlink = fs.unlink;
	let swapped = false;
	spyOn(fs, "unlink").mockImplementation(async target => {
		await realUnlink(target);
		if (!swapped && isMovedAside(String(target), copy)) {
			swapped = true;
			await fs.rename(archivedNested, path.join(root, "emptied-copy-directory"));
			await fs.rename(theirs, archivedNested);
		}
	});

	const result = await runGcCommand({ flags: reclaimApply() });
	mock.restore();

	expect(swapped).toBe(true);
	expect(result.reclaim?.reclaimed).toBe(1);
	expect(testXattr(archivedNested)).toBe("THEIR DIRECTORY ONLY");
}, 60_000);

// An archived directory that is the live one under another name is no copy
// of it: a review made it a link to a descriptor a process held on the live
// directory, the reclaim removed the live directory, and once that process
// let go neither name led anywhere and a restore brought nothing back.
for (const via of ["a link to it", "a link to a descriptor held on it"] as const) {
	test(`a reclaim keeps a live directory whose archived copy is ${via}`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const live = path.join(liveArtifacts, "empty");
		await fs.mkdir(live, { recursive: true });
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await archiveOnly();
		const archived = path.join(archiveFile.slice(0, -".jsonl.gz".length), "empty");
		await fs.rmdir(archived);
		const holder = await fs.open(live, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
		let result: GcResult;
		try {
			await fs.symlink(via === "a link to it" ? live : `/proc/${process.pid}/fd/${holder.fd}`, archived);
			result = await runGcCommand({
				flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
			});
		} finally {
			await holder.close();
		}

		expect(result.reclaim?.reclaimed).toBe(0);
		expect(result.reclaim?.moved).toBeUndefined();
		expect(result.reclaim?.errors.join("\n")).toContain(`${archived} is a symbolic link, not a copy of ${live}`);
		expect((await fs.lstat(live)).isDirectory()).toBe(true);
		expect(await Bun.file(sessionFile).exists()).toBe(true);
	}, 60_000);
}

// A restore once made a directory with its owner's read, write and search,
// less the umask: a review's empty `0500` artifact directory came back
// `0700`. A reclaim moves the directory itself, so its mode comes back.
for (const mode of [0o500, 0o775] as const) {
	test(`a reclaim moves an empty ${mode.toString(8)} directory, and the restore gives back its mode`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const live = path.join(liveArtifacts, "kept");
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await fs.mkdir(live);
		await fs.chmod(live, mode);
		const inode = (await fs.stat(live)).ino;
		expect((await archiveOnly()).archive?.errors).toEqual([]);

		await reclaimThenRestore();

		expect((await fs.stat(live)).mode & 0o777).toBe(mode);
		expect((await fs.stat(live)).ino).toBe(inode);
	}, 60_000);
}

// ---------------------------------------------------------------------------
// gc never deletes an original. A reclaim moves the live transcript and its
// artifact tree into the archive by rename, so the inode — every bit, owner,
// group, attribute and time — is what a restore moves back; it deletes only
// copies gc made, at canonical archive names, whose bytes the moved original
// holds.
// ---------------------------------------------------------------------------

/** The reclaimed names: `<agentDir>/archive/reclaimed/<bucket>/<stem>/{<stem>.jsonl,<stem>}`, as the design gives them. */
function reclaimedNames(): { transcript: string; artifacts: string } {
	const stem = path.basename(archiveFile, ".jsonl.gz");
	const container = path.join(root, "archive", "reclaimed", path.basename(path.dirname(archiveFile)), stem);
	return { transcript: path.join(container, `${stem}.jsonl`), artifacts: path.join(container, stem) };
}

const reclaimApply = (): GcCommandFlags => ({
	agentDir: root,
	reclaim: archiveFile,
	apply: true,
	forwardOnly: true,
	json: true,
});

const restoreApply = (apply = true): GcCommandFlags => ({ agentDir: root, restore: SESSION_ID, apply, json: true });

/** What a restore must give back unchanged of each entry: the inode itself and what it carries. */
interface EntryFacts {
	dev: number;
	ino: number;
	mode: number;
	uid: number;
	gid: number;
	mtimeMs: number;
	attribute: string | undefined;
}

async function factsOf(entries: readonly string[]): Promise<Record<string, EntryFacts>> {
	const facts: Record<string, EntryFacts> = {};
	for (const entry of entries) {
		const stat = await fs.lstat(entry);
		facts[entry] = {
			dev: stat.dev,
			ino: stat.ino,
			mode: stat.mode,
			uid: stat.uid,
			gid: stat.gid,
			mtimeMs: stat.mtimeMs,
			attribute: testXattr(entry),
		};
	}
	return facts;
}

/** Age the session tree the way {@link archiveOnly} does, so a test can read its times before archiving. */
async function ageSessionTree(): Promise<void> {
	const old = new Date(Date.now() - 30 * 86_400_000);
	const bucket = path.dirname(sessionFile);
	for (const entry of await fs.readdir(bucket, { recursive: true })) {
		await fs.utimes(path.join(bucket, entry), old, old);
	}
}

/** Archive the already-aged tree, keeping the live copy, without touching a time again. */
async function archiveAged(): Promise<GcResult> {
	return await runGcCommand({
		flags: {
			agentDir: root,
			archive: true,
			apply: true,
			json: true,
			coldArchiveAfterDays: 0,
			retainNewestGlobal: 0,
			retainNewestPerCwd: 0,
		},
	});
}

test("a setuid artifact directory comes back 4755 through archive, reclaim and restore", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "SENTINEL");
	const setuid = path.join(liveArtifacts, "setuid");
	await fs.mkdir(setuid);
	await fs.chmod(setuid, 0o4755);
	expect((await fs.stat(setuid)).mode & 0o7777).toBe(0o4755);
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });

	const reclaimed = await runGcCommand({ flags: reclaimApply() });
	const restored = await runGcCommand({ flags: restoreApply() });

	expect(reclaimed.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	expect(restored.restore?.errors).toEqual([]);
	expect((await fs.stat(setuid)).mode & 0o7777).toBe(0o4755);
}, 60_000);

test("a directory whose inherited setgid was cleared comes back without it through archive, reclaim and restore", async () => {
	await fs.chmod(path.dirname(sessionFile), 0o2755);
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(liveArtifacts);
	await Bun.write(path.join(liveArtifacts, "a.log"), "SENTINEL");
	const cleared = path.join(liveArtifacts, "cleared-setgid");
	await fs.mkdir(cleared);
	await fs.chmod(cleared, 0o755);
	const parentMode = (await fs.stat(liveArtifacts)).mode & 0o7777;
	expect(parentMode & 0o2000).toBe(0o2000);
	expect((await fs.stat(cleared)).mode & 0o7777).toBe(0o755);
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });

	const reclaimed = await runGcCommand({ flags: reclaimApply() });
	const restored = await runGcCommand({ flags: restoreApply() });

	expect(reclaimed.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	expect(restored.restore?.errors).toEqual([]);
	expect((await fs.stat(liveArtifacts)).mode & 0o7777).toBe(parentMode);
	expect((await fs.stat(cleared)).mode & 0o7777).toBe(0o755);
}, 60_000);

/** Whether this user may run a command as root without a password: the `trusted.*` repro needs root to set and read one. */
const sudoWorks = Bun.spawnSync(["sudo", "-n", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

/** As root, set `trusted.review` on `file`, or read it back; gc itself runs as this user, who cannot see it. */
function rootTrustedAttribute(action: "set" | "get", file: string): string {
	const code =
		action === "set"
			? "import os,sys; os.setxattr(sys.argv[1], 'trusted.review', b'ROOT-ONLY-LABEL')"
			: "import os,sys; print(os.getxattr(sys.argv[1], 'trusted.review').decode())";
	const run = Bun.spawnSync(["sudo", "-n", "/usr/bin/python3", "-c", code, file], { stdout: "pipe", stderr: "pipe" });
	if (run.exitCode !== 0) throw new Error(`sudo ${action} trusted.review on ${file}: ${run.stderr.toString()}`);
	return run.stdout.toString().trim();
}

test.skipIf(!sudoWorks)(
	"(needs sudo -n) a trusted.* attribute the unprivileged gc cannot see survives archive, reclaim and restore",
	async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const artifact = path.join(liveArtifacts, "output.log");
		await Bun.write(artifact, "USER BYTES");
		rootTrustedAttribute("set", artifact);
		// The finding: this process, the one gc runs as, cannot even see it.
		expect(getXattr(artifact, "trusted.review")).toBeUndefined();
		expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });

		const reclaimed = await runGcCommand({ flags: reclaimApply() });
		const restored = await runGcCommand({ flags: restoreApply() });

		expect(reclaimed.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
		expect(restored.restore?.errors).toEqual([]);
		expect(rootTrustedAttribute("get", artifact)).toBe("ROOT-ONLY-LABEL");
		expect(await Bun.file(artifact).text()).toBe("USER BYTES");
	},
	60_000,
);

test("a 0775 directory reclaimed under umask 0002 comes back 0775 from a restore under umask 0077", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "PRESERVE");
	const access = path.join(liveArtifacts, "group-access");
	await fs.mkdir(access);
	await fs.chmod(access, 0o775);
	process.umask(0o002);
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	const reclaimed = await runGcCommand({ flags: reclaimApply() });
	process.umask(0o077);
	const restored = await runGcCommand({ flags: restoreApply() });

	expect(reclaimed.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	expect(restored.restore?.errors).toEqual([]);
	expect((await fs.stat(access)).mode & 0o777).toBe(0o775);
}, 60_000);

test("archive, reclaim and restore give back every live entry as the very inode it was, with its mode, owner, group, attribute and mtime", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const tool = path.join(liveArtifacts, "tool.log");
	const nested = path.join(liveArtifacts, "nested");
	const deep = path.join(nested, "deep");
	const data = path.join(deep, "data.bin");
	const subagents = path.join(liveArtifacts, "subagents");
	const child = path.join(subagents, "child.jsonl");
	await Bun.write(tool, "TOOL OUTPUT");
	await Bun.write(data, "DEEP BYTES");
	await Bun.write(child, sessionBody(sessionId("029b1eee0f4c"), "CHILD TURN", root));
	await fs.chmod(nested, 0o750);
	await fs.chmod(tool, 0o640);
	setTestXattr(data, "FILE ATTRIBUTE");
	setTestXattr(nested, "DIRECTORY ATTRIBUTE");
	setTestXattr(sessionFile, "TRANSCRIPT ATTRIBUTE");
	const entries = [sessionFile, liveArtifacts, tool, nested, deep, data, subagents, child];
	await ageSessionTree();
	const before = await factsOf(entries);
	expect((await archiveAged()).archive).toMatchObject({ archived: 1, errors: [] });

	const reclaimed = await runGcCommand({ flags: reclaimApply() });
	const names = reclaimedNames();
	const atReclaimedNames = await factsOf([names.transcript, names.artifacts]);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	const copiesLeft = await fs.lstat(archivedArtifacts).catch(() => undefined);
	const restored = await runGcCommand({ flags: restoreApply() });

	expect(reclaimed.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	// Moved, not copied: the originals sit at the reclaimed names, and the
	// copies they replace are gone; the archived transcript stays.
	expect(atReclaimedNames[names.transcript]?.ino).toBe(before[sessionFile]?.ino);
	expect(atReclaimedNames[names.artifacts]?.ino).toBe(before[liveArtifacts]?.ino);
	expect(copiesLeft).toBeUndefined();
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	expect(restored.restore?.errors).toEqual([]);
	expect(await factsOf(entries)).toEqual(before);
}, 60_000);

const shmDevice = statSync("/dev/shm", { throwIfNoEntry: false })?.dev;
const tmpDevice = statSync(os.tmpdir()).dev;

test.skipIf(shmDevice === undefined || shmDevice === tmpDevice)(
	"a reclaim whose archive is on another filesystem moves nothing, deletes nothing, and says why",
	async () => {
		const elsewhere = await fs.mkdtemp("/dev/shm/omp-archive-elsewhere-");
		try {
			await fs.symlink(elsewhere, path.join(root, "archive"));
			const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
			const artifact = path.join(liveArtifacts, "a.log");
			await Bun.write(artifact, "FIRST");
			expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
			const archivedCopy = path.join(archiveFile.slice(0, -".jsonl.gz".length), "a.log");
			const entries = [sessionFile, liveArtifacts, artifact];
			const before = await factsOf(entries);

			const preview = await runGcCommand({ flags: { ...reclaimApply(), apply: false } });
			const result = await runGcCommand({ flags: reclaimApply() });

			for (const said of [preview.reclaim?.errors.join("\n") ?? "", result.reclaim?.errors.join("\n") ?? ""]) {
				expect(said).toContain("another filesystem");
			}
			expect(preview.reclaim?.wouldReclaim).toBeUndefined();
			expect(result.reclaim?.reclaimed).toBe(0);
			expect(await factsOf(entries)).toEqual(before);
			expect(await Bun.file(archivedCopy).text()).toBe("FIRST");
			expect(await Bun.file(archiveFile).exists()).toBe(true);
			const names = reclaimedNames();
			expect(await fs.lstat(names.transcript).catch(() => undefined)).toBeUndefined();
			expect(await fs.lstat(names.artifacts).catch(() => undefined)).toBeUndefined();
		} finally {
			await fs.rm(elsewhere, { recursive: true, force: true });
		}
	},
	60_000,
);

test("a reclaim deletes only copies: an entry only the archive holds stays, and so does the archived transcript", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "child", "only.log"), "NESTED");
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	const onlyArchived = path.join(archivedArtifacts, "only-archived.log");
	const onlyArchivedDir = path.join(archivedArtifacts, "child", "only-archived-dir");
	await Bun.write(onlyArchived, "ONLY IN THE ARCHIVE");
	await fs.mkdir(onlyArchivedDir);

	const result = await runGcCommand({ flags: reclaimApply() });

	expect(result.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	expect(await Bun.file(onlyArchived).text()).toBe("ONLY IN THE ARCHIVE");
	expect((await fs.lstat(onlyArchivedDir)).isDirectory()).toBe(true);
	expect(await fs.lstat(path.join(archivedArtifacts, "a.log")).catch(() => undefined)).toBeUndefined();
	expect(await fs.lstat(path.join(archivedArtifacts, "child", "only.log")).catch(() => undefined)).toBeUndefined();
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	const names = reclaimedNames();
	expect(await Bun.file(path.join(names.artifacts, "a.log")).text()).toBe("FIRST");
	expect(await Bun.file(path.join(names.artifacts, "child", "only.log")).text()).toBe("NESTED");
});

test("a reclaim keeps an archived copy whose bytes the moved original does not hold, and names it", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	const archivedCopy = path.join(archiveFile.slice(0, -".jsonl.gz".length), "a.log");
	const names = reclaimedNames();
	// Once the tree has moved, and before its copies are freed, the archived
	// copy gains bytes the original never had.
	const realMove = libcModule.renameNoReplace;
	let appended = false;
	spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		const moved = await realMove(from, to);
		if (!appended && to === names.artifacts && moved.outcome === "renamed") {
			appended = true;
			await fs.appendFile(archivedCopy, " LATE ARCHIVE BYTES");
		}
		return moved;
	});

	const result = await runGcCommand({ flags: reclaimApply() });
	mock.restore();

	expect(appended).toBe(true);
	expect(result.reclaim?.reclaimed).toBe(1);
	expect(result.reclaim?.errors.join("\n")).toContain(archivedCopy);
	expect(await Bun.file(archivedCopy).text()).toBe("FIRST LATE ARCHIVE BYTES");
	expect(await Bun.file(path.join(names.artifacts, "a.log")).text()).toBe("FIRST");
});

test("a restore refuses, in its preview as in applying, when a live artifact directory stands where a reclaimed tree belongs", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	expect((await runGcCommand({ flags: reclaimApply() })).reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	await Bun.write(path.join(liveArtifacts, "new.log"), "NEW LIVE WORK");
	const names = reclaimedNames();

	const preview = await runGcCommand({ flags: restoreApply(false) });
	const applied = await runGcCommand({ flags: restoreApply() });

	for (const said of [preview.restore?.errors.join("\n") ?? "", applied.restore?.errors.join("\n") ?? ""]) {
		expect(said).toContain(liveArtifacts);
		expect(said).toContain(names.artifacts);
	}
	// Nothing moved, nothing copied over the reclaimed original.
	expect(await Bun.file(path.join(names.artifacts, "a.log")).text()).toBe("FIRST");
	expect(await Bun.file(path.join(liveArtifacts, "new.log")).text()).toBe("NEW LIVE WORK");
	expect(await fs.lstat(path.join(liveArtifacts, "a.log")).catch(() => undefined)).toBeUndefined();
	expect(await Bun.file(names.transcript).exists()).toBe(true);
	expect(await fs.lstat(sessionFile).catch(() => undefined)).toBeUndefined();
});

test("a restore preview names the two moves applying would make, and applying makes them", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	const inode = (await fs.stat(path.join(liveArtifacts, "a.log"))).ino;
	expect((await runGcCommand({ flags: reclaimApply() })).reclaim).toMatchObject({ reclaimed: 1, errors: [] });

	const preview = await runGcCommand({ flags: restoreApply(false) });
	const applied = await runGcCommand({ flags: restoreApply() });

	expect(preview.restore?.errors).toEqual([]);
	expect(preview.restore?.movedHome).toEqual([sessionFile, liveArtifacts]);
	expect(preview.restore?.missingArtifacts ?? []).toEqual([]);
	expect(applied.restore?.errors).toEqual([]);
	expect(applied.restore?.movedHome).toEqual([sessionFile, liveArtifacts]);
	expect((await fs.stat(path.join(liveArtifacts, "a.log"))).ino).toBe(inode);
});

test("a reclaim killed between its two moves leaves a session that opening brings home by rename", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	const transcript = (await fs.stat(sessionFile)).ino;
	const names = reclaimedNames();
	// What a reclaim killed after its first move leaves: the transcript at its
	// reclaimed name, the artifact tree still live.
	await fs.mkdir(path.dirname(names.transcript), { recursive: true, mode: 0o700 });
	await fs.rename(sessionFile, names.transcript);

	const opened = await materializeSessionFile(sessionFile, root);

	expect(opened).toBe(sessionFile);
	expect((await fs.stat(sessionFile)).ino).toBe(transcript);
	expect(await fs.lstat(names.transcript).catch(() => undefined)).toBeUndefined();
	expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("FIRST");
});

test("a live transcript beside a reclaimed artifact tree is not opened until the tree is home", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	const artifact = (await fs.stat(path.join(liveArtifacts, "a.log"))).ino;
	expect((await runGcCommand({ flags: reclaimApply() })).reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	const names = reclaimedNames();
	await fs.rename(names.transcript, sessionFile);

	const opened = await materializeSessionFile(sessionFile, root);

	expect(opened).toBe(sessionFile);
	expect((await fs.stat(path.join(liveArtifacts, "a.log"))).ino).toBe(artifact);
	expect(await fs.lstat(names.artifacts).catch(() => undefined)).toBeUndefined();
});

test("a restore reads the leases of subagent transcripts that are only in the reclaimed tree", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const childId = sessionId("029b1eee0f4c");
	await Bun.write(path.join(liveArtifacts, "child.jsonl"), sessionBody(childId, "CHILD TURN", root));
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	expect((await runGcCommand({ flags: reclaimApply() })).reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	const archivedChild = path.join(archiveFile.slice(0, -".jsonl.gz".length), "child.jsonl");
	expect(await fs.lstat(archivedChild).catch(() => undefined)).toBeUndefined();
	const lease = tryAcquireSessionLease(childId);
	expect(lease).not.toBeNull();

	let restored: GcResult;
	try {
		restored = await runGcCommand({ flags: restoreApply() });
	} finally {
		lease?.release();
	}

	expect(restored.restore?.errors.join("\n")).toContain("a running process owns");
	const names = reclaimedNames();
	expect(await Bun.file(path.join(names.artifacts, "child.jsonl")).exists()).toBe(true);
	expect(await fs.lstat(sessionFile).catch(() => undefined)).toBeUndefined();
});

test("gc --archive writes nothing for a session whose originals are at the reclaimed names", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	expect((await runGcCommand({ flags: reclaimApply() })).reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	const names = reclaimedNames();
	const archived = await fs.readFile(archiveFile);
	// A transcript written at the session's live name since: the archive must
	// not supersede the copy whose original is at the reclaimed name.
	const later = JSON.stringify({ type: "message", id: "m3", message: { role: "assistant", content: [] } });
	await Bun.write(sessionFile, `${sessionBody(SESSION_ID, PROMPT, root)}${later}\n`);
	await Bun.write(path.join(liveArtifacts, "b.log"), "SECOND");

	const result = await archiveOnly();

	expect(result.archive?.errors.join("\n")).toContain(names.transcript);
	expect(await fs.readFile(archiveFile)).toEqual(archived);
	const archivedB = path.join(archiveFile.slice(0, -".jsonl.gz".length), "b.log");
	expect(await fs.lstat(archivedB).catch(() => undefined)).toBeUndefined();
	expect(await Bun.file(path.join(names.artifacts, "a.log")).text()).toBe("FIRST");
	expect(await Bun.file(names.transcript).exists()).toBe(true);
});

test("the archive's outstanding entries include a reclaimed transcript and tree", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	expect((await runGcCommand({ flags: reclaimApply() })).reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	const names = reclaimedNames();

	const outstanding = await sessionArchive.archivedPathsWithoutLiveCopies(archiveFile, sessionFile);

	expect(outstanding).toContain(names.transcript);
	expect(outstanding).toContain(names.artifacts);
});

// ---------------------------------------------------------------------------
// Round 45's findings: reclaimed originals in a namespace no session can name,
// copies freed only while the kernel proves nothing else holds either file and
// the original holds every byte of the copy — judged again after the unlink —
// every name a transcript can hold counted by the blob sweep, and a preview
// that refuses where `rename(2)` would.
// ---------------------------------------------------------------------------

/** A Python process on `file` that waits for a line before each step and reports each; its stdout, read as it comes. */
function stepper(
	code: string,
	file: string,
): { child: Bun.Subprocess<"pipe", "pipe", "pipe">; until(marker: string): Promise<string> } {
	const child = Bun.spawn(["/usr/bin/python3", "-c", code, file], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const reader = child.stdout.getReader();
	let output = "";
	return {
		child,
		async until(marker) {
			while (!output.includes(marker)) {
				const read = await reader.read();
				if (read.done) throw new Error(`the writer ended before ${marker}: ${output}`);
				output += new TextDecoder().decode(read.value);
			}
			return output;
		},
	};
}

test("a session named like another's old reclaimed tree never touches that session's originals", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	const original = await fs.stat(path.join(liveArtifacts, "a.log"));
	const first = await runGcCommand({ flags: reclaimApply() });
	expect(first.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	const movedTree = first.reclaim?.moved?.artifacts;
	if (!movedTree) throw new Error("the reclaim moved no tree");
	const held = await fs.open(path.join(movedTree, "a.log"), "r");
	try {
		// `<stem>.reclaimed` is this second session's own artifact tree.
		const second = await writeSession("2026-01-01T00-00-00-000Z", `${SESSION_ID}.reclaimed`);
		const secondArtifacts = second.slice(0, -".jsonl".length);
		await Bun.write(path.join(secondArtifacts, "a.log"), "SECOND");
		const secondArchive = archivePathFor(second);
		expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
		const secondReclaim = await runGcCommand({ flags: { ...reclaimApply(), reclaim: secondArchive } });
		expect(secondReclaim.reclaim).toMatchObject({ reclaimed: 1, errors: [] });

		expect((await held.stat()).nlink).toBe(1);
		const restoredFirst = await runGcCommand({
			flags: { agentDir: root, restore: archiveFile, apply: true, json: true },
		});
		const restoredSecond = await runGcCommand({
			flags: { agentDir: root, restore: secondArchive, apply: true, json: true },
		});

		expect(restoredFirst.restore?.errors).toEqual([]);
		expect(restoredSecond.restore?.errors).toEqual([]);
		expect((await fs.stat(path.join(liveArtifacts, "a.log"))).ino).toBe(original.ino);
		expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("FIRST");
		expect(await Bun.file(path.join(secondArtifacts, "a.log")).text()).toBe("SECOND");
	} finally {
		await held.close();
	}
}, 120_000);

test("a reclaim keeps an archived copy another process holds open, and that process's later write stays", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "ORIGINAL");
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	const copy = path.join(archiveFile.slice(0, -".jsonl.gz".length), "a.log");
	const writer = stepper(
		"import os,sys; f=open(sys.argv[1],'ab',buffering=0); print('READY',flush=True); sys.stdin.readline(); " +
			"f.write(b' LATE'); os.fsync(f.fileno()); print('NLINK='+str(os.fstat(f.fileno()).st_nlink),flush=True)",
		copy,
	);
	try {
		await writer.until("READY");
		const result = await runGcCommand({ flags: reclaimApply() });
		writer.child.stdin.write("write\n");
		await writer.child.stdin.flush();
		const output = await writer.until("NLINK=");

		expect(result.reclaim?.reclaimed).toBe(1);
		expect(result.reclaim?.keptCopies?.join("\n")).toContain(copy);
		expect(output).not.toContain("NLINK=0");
		expect(await Bun.file(copy).text()).toBe("ORIGINAL LATE");
	} finally {
		writer.child.kill("SIGKILL");
		await writer.child.exited;
	}
}, 120_000);

/** `getrlimit`/`setrlimit` for `RLIMIT_FSIZE`, which makes the kernel cut a write short at the limit and refuse one past it (`EFBIG`). */
const fileSizeLimit = (() => {
	const lib = dlopen(process.platform === "linux" ? "libc.so.6" : "libc.dylib", {
		getrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
		setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	});
	const RLIMIT_FSIZE = 1;
	return {
		get(): BigUint64Array {
			const now = new BigUint64Array(2);
			if (lib.symbols.getrlimit(RLIMIT_FSIZE, ptr(now)) !== 0) throw new Error("getrlimit failed");
			return now;
		},
		set(limit: BigUint64Array): void {
			if (lib.symbols.setrlimit(RLIMIT_FSIZE, ptr(limit)) !== 0) throw new Error("setrlimit failed");
		},
	};
})();

// The write-back writes a copy's bytes to a new file; `write(2)` may write
// less than it is given, and a review's real reclaim, under a file size limit
// that cut every write in half, left half the copy and reported it written
// back. Each write here runs under a limit the kernel enforces, set just
// before it and put back after: half of what it is given, or a fixed limit
// the write-back cannot get past.
for (const writes of [
	"whole",
	"whole, though the unlinked copy's size cannot be read",
	"whole, though the read that would find its end fails",
	"cut short by the kernel each time",
	"stopped by the kernel part-way",
] as const) {
	test(`a reclaim writes a freed copy back when the original is truncated in the call before the copy's unlink, writes ${writes}`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const bytes = writes.startsWith("whole") ? Buffer.from("ORIGINAL") : Buffer.alloc(1024 * 1024, 65);
		await Bun.write(path.join(liveArtifacts, "a.log"), bytes);
		expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
		const copyDir = archiveFile.slice(0, -".jsonl.gz".length);
		const copy = path.join(copyDir, "a.log");
		const original = path.join(reclaimedNames().artifacts, "a.log");
		let truncator: Bun.Subprocess | undefined;
		let cutShort = 0;
		let copyUnlinked = false;
		const stoppedAt = 77_881;
		const realUnlink = fs.unlink;
		spyOn(fs, "unlink").mockImplementation(async file => {
			const name = String(file);
			if (!truncator && path.dirname(name) === copyDir && path.basename(name).startsWith(".a.log.")) {
				// The truncation an opener asks for blocks on the original's lease
				// until this run lets go, and shows as that lease breaking; the
				// unlink then goes ahead, as the one system call it is. Polled: the
				// kernel gives no event for an opener blocked on a lease, only its
				// `BREAKER` line in /proc/locks; without a lease (before this fix)
				// the truncation simply finishes, which ends the wait too.
				truncator = Bun.spawn(["/usr/bin/python3", "-c", "import sys; open(sys.argv[1],'wb').close()", original]);
				for (let tries = 0; tries < 400; tries++) {
					const locks = await Bun.file("/proc/locks").text();
					if (locks.includes(`BREAKER   WRITE ${truncator.pid} `) || truncator.exitCode !== null) break;
					await Bun.sleep(25);
				}
			}
			const removed = await realUnlink(file);
			if (path.dirname(name) === copyDir && path.basename(name).startsWith(".a.log.")) copyUnlinked = true;
			return removed;
		});
		// A review made `fstat` fail on the unlinked copy, and the write-back
		// threw before it wrote anything back; its size is for the report only.
		// Another failed the read that would have found the end, after every
		// byte was written back, and saw the whole copy reported lost.
		if (writes.startsWith("whole, though")) {
			const realOpen = regularFile.openRegularFile;
			spyOn(regularFile, "openRegularFile").mockImplementation(async (file, options) => {
				const handle = await realOpen(file, options);
				if (!handle || path.dirname(file) !== copyDir || !path.basename(file).startsWith(".a.log.")) return handle;
				if (writes === "whole, though the unlinked copy's size cannot be read") {
					const realStat = handle.stat.bind(handle);
					spyOn(handle, "stat").mockImplementation((async (...args: unknown[]) => {
						if (copyUnlinked) throw Object.assign(new Error("EIO: i/o error, fstat"), { code: "EIO" });
						return await (realStat as (...a: unknown[]) => Promise<Stats>)(...args);
					}) as typeof handle.stat);
				} else {
					const realRead = handle.read.bind(handle) as (...args: unknown[]) => Promise<{ bytesRead: number }>;
					spyOn(handle, "read").mockImplementation((async (...args: unknown[]) => {
						if (copyUnlinked && (args[3] as number) >= bytes.length) {
							throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
						}
						return await realRead(...args);
					}) as typeof handle.read);
				}
				return handle;
			});
		}
		if (!writes.startsWith("whole")) {
			const realCreate = regularFile.createExclusive;
			spyOn(regularFile, "createExclusive").mockImplementation(async (file, mode, readable) => {
				const handle = await realCreate(file, mode, readable);
				if (file !== copy) return handle;
				const realWrite = handle.write.bind(handle) as (...args: unknown[]) => Promise<{ bytesWritten: number }>;
				let end = 0;
				spyOn(handle, "write").mockImplementation((async (...args: unknown[]) => {
					const length = args[2] as number;
					const before = fileSizeLimit.get();
					// Stopped part-way through a 64 KiB window, so the file holds
					// more than the windows written whole.
					const limit = writes === "stopped by the kernel part-way" ? stoppedAt : end + Math.ceil(length / 2);
					fileSizeLimit.set(new BigUint64Array([BigInt(limit), before[1]]));
					try {
						const put = await realWrite(...args);
						if (put.bytesWritten < length) cutShort++;
						end = Math.max(end, (args[3] as number) + put.bytesWritten);
						return put;
					} finally {
						fileSizeLimit.set(before);
					}
				}) as typeof handle.write);
				return handle;
			});
		}
		const result = await runGcCommand({ flags: reclaimApply() });
		mock.restore();
		await truncator?.exited;

		expect(truncator).toBeDefined();
		expect(result.reclaim?.reclaimed).toBe(1);
		const kept = result.reclaim?.keptCopies?.join("\n") ?? "";
		const lost = result.reclaim?.lostCopies?.join("\n") ?? "";
		expect(result.reclaim?.errors.join("\n")).not.toContain("original is safe");
		if (writes === "stopped by the kernel part-way") {
			expect(kept).toBe("");
			expect(lost).not.toContain("were written back");
			expect(lost).toContain(`holds ${stoppedAt} of its ${bytes.length} bytes, and the rest was lost`);
			expect((await fs.stat(copy)).size).toBe(stoppedAt);
		} else {
			if (!writes.startsWith("whole")) expect(cutShort).toBeGreaterThan(0);
			expect(lost).toBe("");
			expect(kept).toContain("written back");
			expect(await fs.readFile(copy)).toEqual(bytes);
		}
	}, 120_000);
}

// Every write gc makes through a descriptor — a staged copy, an inflated
// transcript, a written-back copy, a restore record, a lock — goes through
// `writeAllAt`: a write the kernel cuts short is carried on, and one it
// refuses throws, never returning as if all of it were written.
test("writeAllAt writes every byte through writes the kernel cuts short, and throws when the kernel refuses one", async () => {
	const file = path.join(root, "short-writes");
	const bytes = Buffer.alloc(300_000, 66);
	const before = fileSizeLimit.get();
	const handle = await fs.open(file, "wx");
	let calls = 0;
	const realWrite = handle.write.bind(handle) as (...args: unknown[]) => Promise<{ bytesWritten: number }>;
	try {
		let end = 0;
		spyOn(handle, "write").mockImplementation((async (...args: unknown[]) => {
			calls++;
			fileSizeLimit.set(new BigUint64Array([BigInt(end + 1000), before[1]]));
			try {
				const put = await realWrite(...args);
				end += put.bytesWritten;
				return put;
			} finally {
				fileSizeLimit.set(before);
			}
		}) as typeof handle.write);
		await regularFile.writeAllAt(handle, bytes, 0);
		mock.restore();
		expect(calls).toBe(300);
		expect(await fs.readFile(file)).toEqual(bytes);

		fileSizeLimit.set(new BigUint64Array([BigInt(bytes.length + 10), before[1]]));
		await expect(regularFile.writeAllAt(handle, Buffer.alloc(100, 67), bytes.length)).rejects.toThrow("EFBIG");
	} finally {
		fileSizeLimit.set(before);
		mock.restore();
		await handle.close();
	}
});

for (const shape of ["plain", "compressed", "compressed, moved aside twice"] as const) {
	test(`the blob sweep keeps a blob only a killed run's ${shape} .leaving transcript references`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "child.jsonl"), "{}\n");
		expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
		const hash = new Bun.SHA256().update(`only in a leaving copy ${shape}`).digest("hex");
		const blob = path.join(getBlobsDir(root), hash);
		await Bun.write(blob, "BLOB");
		const old = new Date(Date.now() - 30 * 86_400_000);
		await fs.utimes(blob, old, old);
		// What a run killed while it moved a copy aside leaves beside it, which a
		// restore carries home — and, re-archived and killed again, the same
		// name moved aside once more, which ends in neither suffix.
		const copyDir = archiveFile.slice(0, -".jsonl.gz".length);
		const reference = `{"type":"message","note":"blob:sha256:${hash}"}\n`;
		const leaving =
			shape === "plain"
				? path.join(copyDir, ".child.jsonl.0123456789abcdef.leaving")
				: shape === "compressed"
					? path.join(path.dirname(archiveFile), `.${path.basename(archiveFile)}.0123456789abcdef.leaving`)
					: path.join(copyDir, "..child.jsonl.gz.0123456789abcdef.leaving.fedcba9876543210.leaving");
		await Bun.write(leaving, shape === "plain" ? reference : gzipSync(reference));

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true, json: true } });

		expect(result.blobs?.errors).toEqual([]);
		expect(await Bun.file(blob).exists()).toBe(true);
	}, 60_000);
}

for (const blocked of ["the live bucket", "the live artifact directory"] as const) {
	test(`a reclaim preview refuses, as applying does, when ${blocked} cannot be moved out of`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "ORIGINAL");
		expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
		const target = blocked === "the live bucket" ? path.dirname(sessionFile) : liveArtifacts;
		await fs.chmod(target, 0o500);
		try {
			const preview = await runGcCommand({ flags: { ...reclaimApply(), apply: false } });
			const applied = await runGcCommand({ flags: reclaimApply() });

			expect(applied.reclaim?.reclaimed).toBe(0);
			expect(preview.reclaim?.wouldReclaim).toBeUndefined();
			expect(preview.reclaim?.errors.join("\n")).toContain(target);
			expect(await Bun.file(sessionFile).exists()).toBe(true);
			expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("ORIGINAL");
		} finally {
			await fs.chmod(target, 0o700);
		}
	}, 60_000);
}

test("a reclaim preview says which copies applying would keep when the archive bucket is not writable", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "ORIGINAL");
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	const bucket = path.dirname(archiveFile);
	await fs.chmod(bucket, 0o500);
	try {
		const preview = await runGcCommand({ flags: { ...reclaimApply(), apply: false } });
		const applied = await runGcCommand({ flags: reclaimApply() });

		expect(preview.reclaim?.wouldReclaim).toBe(1);
		expect(preview.reclaim?.errors.join("\n")).toContain(bucket);
		expect(applied.reclaim?.reclaimed).toBe(1);
		expect(applied.reclaim?.errors.length).toBeGreaterThan(0);
	} finally {
		await fs.chmod(bucket, 0o700);
	}
}, 60_000);

/** Whether this user may run a command as root without a password: the sticky-bit case needs a directory another user owns. */
const sudoForSticky = Bun.spawnSync(["sudo", "-n", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

test.skipIf(!sudoForSticky)(
	"(needs sudo -n) a reclaim preview refuses, as applying does, to move another user's directory out of a sticky bucket",
	async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "ORIGINAL");
		expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
		const bucket = path.dirname(sessionFile);
		const asRoot = (...args: string[]): void => {
			const run = Bun.spawnSync(["sudo", "-n", ...args], { stdout: "pipe", stderr: "pipe" });
			if (run.exitCode !== 0) throw new Error(`sudo ${args.join(" ")}: ${run.stderr.toString()}`);
		};
		// The bucket root's and sticky, the artifact directory another user's:
		// only its owner or the bucket's may move it, whatever its own mode.
		asRoot("chown", "root", bucket);
		asRoot("chmod", "1777", bucket);
		asRoot("chown", "nobody", liveArtifacts);
		asRoot("chmod", "0777", liveArtifacts);
		try {
			const preview = await runGcCommand({ flags: { ...reclaimApply(), apply: false } });
			const applied = await runGcCommand({ flags: reclaimApply() });

			expect(preview.reclaim?.wouldReclaim).toBeUndefined();
			expect(preview.reclaim?.errors.join("\n")).toContain("sticky bit");
			expect(applied.reclaim?.reclaimed).toBe(0);
			expect(await Bun.file(sessionFile).exists()).toBe(true);
			expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("ORIGINAL");
		} finally {
			asRoot("chown", "-R", String(process.getuid?.() ?? ""), bucket);
			asRoot("chmod", "0755", bucket);
		}
	},
	60_000,
);

test("an empty directory somebody put at the session's reclaimed directory keeps its inode and attribute through reclaim and restore", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "ORIGINAL");
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	const container = path.dirname(reclaimedNames().transcript);
	await fs.mkdir(container, { recursive: true, mode: 0o700 });
	setXattr(container, "user.review", "ORIGINAL DIRECTORY ATTRIBUTE");
	const held = await fs.open(container, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
	try {
		const reclaimed = await runGcCommand({ flags: reclaimApply() });
		const restored = await runGcCommand({ flags: restoreApply() });

		expect(reclaimed.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
		expect(restored.restore?.errors).toEqual([]);
		expect((await held.stat()).nlink).toBeGreaterThan(0);
		expect((await fs.stat(container)).ino).toBe((await held.stat()).ino);
		expect(getXattr(container, "user.review")).toBe("ORIGINAL DIRECTORY ATTRIBUTE");
		expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("ORIGINAL");
	} finally {
		await held.close();
	}
}, 60_000);

test.skipIf(!sudoForSticky)(
	"(needs sudo -n) a restore preview says it leaves another user's record in a sticky bucket, as applying does",
	async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await archiveEverything();
		const record = restoreRecordPath(archiveFile);
		await Bun.write(record, "omp gc --restore <id> --apply\n");
		const bucket = path.dirname(record);
		const asRoot = (...args: string[]): void => {
			const run = Bun.spawnSync(["sudo", "-n", ...args], { stdout: "pipe", stderr: "pipe" });
			if (run.exitCode !== 0) throw new Error(`sudo ${args.join(" ")}: ${run.stderr.toString()}`);
		};
		asRoot("chown", "nobody", record);
		asRoot("chown", "root", bucket);
		asRoot("chmod", "1777", bucket);
		try {
			const preview = await runGcCommand({ flags: restoreApply(false) });
			const applied = await runGcCommand({ flags: restoreApply() });

			expect(preview.restore?.setAsideRecord).toBeUndefined();
			expect(preview.restore?.errors.join("\n")).toContain("sticky bit");
			expect(applied.restore?.setAsideRecord).toBeUndefined();
			expect(applied.restore?.errors.join("\n")).toContain("EPERM");
			expect(applied.restore?.errors.join("\n")).not.toContain("chmod u+w");
			expect(await Bun.file(record).text()).toBe("omp gc --restore <id> --apply\n");
		} finally {
			asRoot("chown", "-R", String(process.getuid?.() ?? ""), bucket);
			asRoot("chmod", "0755", bucket);
		}
	},
	60_000,
);

// A failed look is reported as a failed look, never as an event nobody saw.
// A review failed one owner read, or the last lookup of a restored directory,
// with `EIO`, and the restore said a running process owned the session, or
// that something had moved the directory.
for (const phase of [
	"before the artifacts' lease refresh",
	"after the artifacts' lease refresh",
	"at the restored directory's last lookup",
] as const) {
	test(`a restore reports a failed look ${phase} as a failed look`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "RESTORED UNIQUE BYTES\n");
		await archiveEverything();
		const live = path.join(liveArtifacts, "a.log");
		let transcriptPublished = false;
		let artifactPublished = false;
		let hit = false;
		const realLink = fs.link;
		const realLstat = fs.lstat;
		spyOn(fs, "link").mockImplementation(async (from, to) => {
			await realLink(from, to);
			if (String(to) === sessionFile) transcriptPublished = true;
			if (String(to) === live) artifactPublished = true;
		});
		const eio = (): Error => Object.assign(new Error(`EIO: injected ${phase}`), { code: "EIO" });
		if (phase === "at the restored directory's last lookup") {
			spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
				if (!hit && artifactPublished && String(args[0]) === liveArtifacts) {
					hit = true;
					throw eio();
				}
				return await Reflect.apply(realLstat, fs, args);
			}) as typeof fs.lstat);
		} else {
			// The refresh reads the archived transcript's header for its owner.
			const realOpen = regularFile.openRegularFile;
			spyOn(regularFile, "openRegularFile").mockImplementation(async (file, options) => {
				const due =
					phase === "before the artifacts' lease refresh"
						? transcriptPublished && !artifactPublished
						: artifactPublished;
				if (!hit && due && file === archiveFile) {
					hit = true;
					throw eio();
				}
				return await realOpen(file, options);
			});
		}
		const result = await runGcCommand({ flags: restoreApply() });
		mock.restore();

		expect(hit).toBe(true);
		const said = result.restore?.errors.join("\n") ?? "";
		expect(said).toContain(`EIO: injected ${phase}`);
		expect(said).not.toContain("a running process owns this session");
		expect(said).not.toContain("something moved it");
		expect(said).not.toContain("another entry stands at its name");
		expect(said).not.toContain("nothing stands at its name");
		expect(await new FileSessionStorage().readText(sessionFile)).toBe(await Bun.file(sessionFile).text());
		if (artifactPublished) expect(await Bun.file(live).text()).toBe("RESTORED UNIQUE BYTES\n");
	}, 120_000);
}

// A comparison that cannot read is said as one: a failed read of an archived
// transcript was reported as the live session being "a different session
// file".
test("a restore that cannot read the archive to compare it says so, not that the live file is another session", async () => {
	await archiveOnly();
	const realOpen = regularFile.openRegularFile;
	let hit = false;
	spyOn(regularFile, "openRegularFile").mockImplementation(async (file, options) => {
		const handle = await realOpen(file, options);
		if (!handle || file !== archiveFile) return handle;
		spyOn(handle, "read").mockImplementation((async () => {
			hit = true;
			throw Object.assign(new Error("EIO: injected archive read"), { code: "EIO" });
		}) as typeof handle.read);
		return handle;
	});
	const result = await runGcCommand({ flags: restoreApply() });
	mock.restore();

	expect(hit).toBe(true);
	const said = result.restore?.errors.join("\n") ?? "";
	expect(said).toContain("EIO: injected archive read");
	expect(said).not.toContain("different session file");
}, 60_000);

// Round 52's OpenAI arm: more failed checks said as events. Each of these
// asserts the error is named and no event or remedy it did not see is.
test("a reclaim of a transcript it cannot read says so, not that it is no session file", async () => {
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	await fs.chmod(sessionFile, 0o000);
	try {
		for (const apply of [false, true]) {
			const result = await runGcCommand({ flags: { ...reclaimApply(), apply } });
			const said = result.reclaim?.errors.join("\n") ?? "";
			expect(said).toContain(sessionFile);
			expect(said).toContain("EACCES");
			expect(said).not.toContain("is not a session file");
			// Said as a failed check — "whether … could not be checked" — never as an owner seen.
			expect(said).not.toMatch(/^a running process owns/m);
		}
	} finally {
		await fs.chmod(sessionFile, 0o600);
	}
}, 60_000);

test("an archive run that cannot read a subagent transcript to find its owner says so, not that it is active", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const child = path.join(liveArtifacts, "child.jsonl");
	await Bun.write(
		child,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId("c0ffee000001"), timestamp: "2026-01-01T00:00:00.000Z", cwd: "/" })}\n`,
	);
	await fs.chmod(child, 0o000);
	try {
		const result = await archiveOnly();
		const said = result.archive?.errors.join("\n") ?? "";
		expect(result.archive?.skippedActive).toBe(0);
		expect(said).toContain("its nested sessions could not be checked");
		expect(said).toContain(child);
		expect(said).toContain("EACCES");
	} finally {
		await fs.chmod(child, 0o600);
	}
}, 60_000);

test("a reclaim that cannot read the archive to compare it says so, not that it is no copy", async () => {
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	await fs.chmod(archiveFile, 0o000);
	try {
		const result = await runGcCommand({ flags: reclaimApply() });
		const said = result.reclaim?.errors.join("\n") ?? "";
		expect(result.reclaim?.reclaimed).toBe(0);
		expect(said).toContain("EACCES");
		expect(said).not.toContain("is not a copy of");
		expect(await Bun.file(sessionFile).exists()).toBe(true);
	} finally {
		await fs.chmod(archiveFile, 0o600);
	}
}, 60_000);

test("a restore preview whose permission probe fails with EIO says so, without a chmod it does not need", async () => {
	await archiveEverything();
	const bucket = path.dirname(sessionFile);
	const realAccess = fs.access;
	let hit = false;
	spyOn(fs, "access").mockImplementation((async (...args: Parameters<typeof fs.access>) => {
		if (String(args[0]) === bucket) {
			hit = true;
			throw Object.assign(new Error("EIO: injected access"), { code: "EIO" });
		}
		return await Reflect.apply(realAccess, fs, args);
	}) as typeof fs.access);
	const result = await runGcCommand({ flags: restoreApply(false) });
	mock.restore();

	expect(hit).toBe(true);
	const said = result.restore?.errors.join("\n") ?? "";
	expect(said).toContain("EIO: injected access");
	expect(said).not.toContain("chmod u+w");
}, 60_000);

test("a restore whose tree cannot follow the transcript home says the transcript was moved, never that nothing was", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "ORIGINAL");
	expect((await archiveOnly()).archive).toMatchObject({ archived: 1, errors: [] });
	expect((await runGcCommand({ flags: reclaimApply() })).reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	const before = await fs.stat(reclaimedNames().transcript);
	const realMove = libcModule.renameNoReplace;
	spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		if (from === reclaimedNames().artifacts) {
			throw Object.assign(new Error("EACCES: injected tree move"), { code: "EACCES" });
		}
		return await realMove(from, to);
	});
	const result = await runGcCommand({ flags: restoreApply() });
	mock.restore();

	const said = result.restore?.errors.join("\n") ?? "";
	expect(said).toContain("EACCES: injected tree move");
	expect(said).toContain(`Already moved home by this restore, and left there: ${sessionFile}`);
	expect(said).not.toContain("nothing was moved");
	expect((await fs.stat(sessionFile)).ino).toBe(before.ino);
	expect(await Bun.file(path.join(reclaimedNames().artifacts, "a.log")).text()).toBe("ORIGINAL");
}, 60_000);

// Each failed observation must retain its error, never invent a different file,
// actor or remedy. These drive the command, not the reporting helpers.
function round54Error(where: string, code = "EIO"): Error {
	return Object.assign(new Error(`${code}: round54 ${where}`), { code });
}

test("round54 reclaim preview reports a failed copy permission check without promising safety", async () => {
	const live = path.join(sessionFile.slice(0, -6), "sub", "a.log");
	await Bun.write(live, "ORIGINAL");
	await archiveOnly();
	const copyDir = path.join(archiveFile.slice(0, -9), "sub");
	const access = fs.access;
	spyOn(fs, "access").mockImplementation(async (target, mode) => {
		if (String(target) === copyDir) throw round54Error("copy access");
		return await access(target, mode);
	});
	const result = await runGcCommand({ flags: { ...reclaimApply(), apply: false } });
	const said = result.reclaim?.errors.join("\n") ?? "";
	expect(said).toContain("EIO: round54 copy access");
	expect(said).not.toContain("not writable");
	expect(said).not.toContain("would be safe");
	expect(await Bun.file(live).text()).toBe("ORIGINAL");
});

test("round54 rename ancestor lookup fails without promising a move or blaming an ancestor", async () => {
	const into = path.join(root, "destination");
	await fs.mkdir(into, { mode: 0o500 });
	const stat = fs.stat;
	spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
		if (String(args[0]) === into) throw round54Error("ancestor stat");
		return await Reflect.apply(stat, fs, args);
	}) as typeof fs.stat);
	await expect(regularFile.renameRefusal(sessionFile, into)).rejects.toThrow("EIO: round54 ancestor stat");
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
});

test("round54 post-link lookup failure does not call an intact archive damaged", async () => {
	await archiveEverything();
	const before = await fs.readFile(archiveFile);
	let published = false;
	const link = fs.link;
	const lstat = fs.lstat;
	spyOn(fs, "link").mockImplementation(async (from, to) => {
		await link(from, to);
		if (String(to) === sessionFile) published = true;
	});
	spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
		if (published && String(args[0]) === sessionFile) throw round54Error("post-link lookup");
		return await Reflect.apply(lstat, fs, args);
	}) as typeof fs.lstat);
	const result = await runGcCommand({ flags: restoreApply() });
	expect(result.restore?.errors.join("\n")).toContain("EIO: round54 post-link lookup");
	expect(result.restore?.errors.join("\n")).not.toContain("archive is damaged");
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
	expect(await fs.readFile(archiveFile)).toEqual(before);
});

for (const progress of [false, true]) {
	test(`round54 failed restore preserves its lock release failure with progress ${progress}`, async () => {
		await archiveEverything();
		const open = fs.open;
		const unlink = fs.unlink;
		spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
			if (String(args[0]) === archiveFile) throw round54Error("archive open");
			return await Reflect.apply(open, fs, args);
		}) as typeof fs.open);
		spyOn(fs, "unlink").mockImplementation(async file => {
			if (String(file) === path.join(root, "gc.lock")) throw round54Error("lock release");
			return await unlink(file);
		});
		const lines: string[] = [];
		const restore = restoreArchivedSession(archiveFile, root, progress ? line => lines.push(line) : undefined);
		await expect(restore).rejects.toThrow("EIO: round54 archive open");
		await expect(restore).rejects.toThrow("EIO: round54 lock release");
		expect(lines.join("\n")).not.toContain("session came back");
		expect(await Bun.file(sessionFile).exists()).toBe(false);
		expect(await Bun.file(archiveFile).exists()).toBe(true);
	});
}

test("round54 rearchive lookup failure is not a different session", async () => {
	await archiveOnly();
	await fs.appendFile(
		sessionFile,
		`${JSON.stringify({ type: "message", id: "m3", message: { role: "assistant", content: [] } })}\n`,
	);
	const lstat = fs.lstat;
	let looks = 0;
	spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
		if (String(args[0]) === archiveFile && ++looks === 2) throw round54Error("rearchive lookup");
		return await Reflect.apply(lstat, fs, args);
	}) as typeof fs.lstat);
	const result = await archiveOnly();
	expect(result.archive?.errors.join("\n")).toContain("EIO: round54 rearchive lookup");
	expect(result.archive?.errors.join("\n")).not.toContain("different session");
	expect(await Bun.file(sessionFile).text()).toContain('"m3"');
});

for (const kind of ["directory", "missing", "unreadable"] as const) {
	test(`round54 restore comparison reports a ${kind} live path rather than a different session`, async () => {
		await archiveOnly();
		if (kind === "directory") {
			await fs.unlink(sessionFile);
			await fs.mkdir(sessionFile);
		} else {
			const open = fs.open;
			spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
				if (String(args[0]) === sessionFile)
					throw round54Error("live comparison", kind === "missing" ? "ENOENT" : "EIO");
				return await Reflect.apply(open, fs, args);
			}) as typeof fs.open);
		}
		const result = await runGcCommand({ flags: restoreApply(false) });
		const said = result.restore?.errors.join("\n") ?? "";
		expect(said).toContain(
			kind === "directory" ? "is a directory" : kind === "missing" ? "ENOENT" : "EIO: round54 live comparison",
		);
		expect(said).not.toContain("different session");
		expect(await Bun.file(archiveFile).exists()).toBe(true);
	});
}

test("round54 reclaim names a hard-linked archived artifact as an alias, not different bytes", async () => {
	const artifact = path.join(sessionFile.slice(0, -6), "a.log");
	const copy = path.join(archiveFile.slice(0, -9), "a.log");
	await Bun.write(artifact, "ORIGINAL");
	await archiveOnly();
	await fs.unlink(copy);
	await fs.link(artifact, copy);
	const result = await runGcCommand({ flags: reclaimApply() });
	const said = result.reclaim?.errors.join("\n") ?? "";
	expect(said).toContain("is not a copy");
	expect(said).not.toContain("holds what");
	expect(await Bun.file(artifact).text()).toBe("ORIGINAL");
	expect(await Bun.file(copy).text()).toBe("ORIGINAL");
});

test("round54 vanished realpath is not reported as the archived file itself", async () => {
	const artifact = path.join(sessionFile.slice(0, -6), "a.log");
	await Bun.write(artifact, "ORIGINAL");
	await archiveOnly();
	const realpath = fs.realpath;
	spyOn(fs, "realpath").mockImplementation((async (...args: Parameters<typeof fs.realpath>) => {
		if (String(args[0]) === artifact) throw round54Error("vanished destination", "ENOENT");
		return await Reflect.apply(realpath, fs, args);
	}) as typeof fs.realpath);
	const result = await runGcCommand({ flags: restoreApply() });
	expect(result.restore?.errors.join("\n")).toContain("ENOENT: round54 vanished destination");
	expect(result.restore?.errors.join("\n")).not.toContain("itself, not a second copy");
	expect(await Bun.file(artifact).text()).toBe("ORIGINAL");
});

for (const operation of ["lstat", "open"] as const) {
	test(`round54 reclaim reports failed ${operation} of an archived copy directory`, async () => {
		const artifact = path.join(sessionFile.slice(0, -6), "sub", "a.log");
		const copyDir = path.join(archiveFile.slice(0, -9), "sub");
		await Bun.write(artifact, "ORIGINAL");
		await archiveOnly();
		let moved = false;
		const rename = libcModule.renameNoReplace;
		spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
			const answer = await rename(from, to);
			if (from === path.dirname(path.dirname(artifact)) && answer.outcome === "renamed") moved = true;
			return answer;
		});
		const original = fs[operation];
		spyOn(fs, operation).mockImplementation((async (...args: unknown[]) => {
			if (moved && String(args[0]) === copyDir) throw round54Error(`copy directory ${operation}`);
			return await Reflect.apply(original, fs, args);
		}) as typeof original);
		const result = await runGcCommand({ flags: reclaimApply() });
		expect(result.reclaim?.errors.join("\n")).toContain(`EIO: round54 copy directory ${operation}`);
		mock.restore();
		expect(await Bun.file(path.join(reclaimedNames().artifacts, "sub", "a.log")).text()).toBe("ORIGINAL");
	});
}

test("round54 publication withdrawal reports a failed read, not somebody else's publication", async () => {
	const artifact = path.join(sessionFile.slice(0, -6), "a.log");
	const copy = path.join(archiveFile.slice(0, -9), "a.log");
	await Bun.write(artifact, "ORIGINAL");
	let linked = false;
	const link = fs.link;
	const open = fs.open;
	spyOn(fs, "link").mockImplementation(async (from, to) => {
		await link(from, to);
		if (String(to) === copy) linked = true;
	});
	spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
		const handle = await Reflect.apply(open, fs, args);
		if (linked && (String(args[0]) === copy || String(args[0]).endsWith(".leaving"))) {
			handle.read = (async () => {
				throw round54Error("withdrawal read");
			}) as typeof handle.read;
		}
		return handle;
	}) as typeof fs.open);
	const result = await archiveOnly();
	expect(result.archive?.errors.join("\n")).toContain("EIO: round54 withdrawal read");
	expect(result.archive?.errors.join("\n")).not.toContain("is not what this run published");
	expect(await Bun.file(artifact).text()).toBe("ORIGINAL");
});

test("round54 stale restore record rename errors retain the failed operation", async () => {
	await archiveEverything();
	const record = restoreRecordPath(archiveFile);
	await Bun.write(record, "unfinished restore");
	const rename = libcModule.renameNoReplace;
	spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		if (from === record) throw round54Error("record rename");
		return await rename(from, to);
	});
	const result = await runGcCommand({ flags: restoreApply() });
	expect(result.restore?.errors.join("\n")).toContain("EIO: round54 record rename");
	expect(await Bun.file(record).text()).toBe("unfinished restore");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("round54 archive listing does not count entries whose stat failed", async () => {
	await archiveOnly();
	const stat = fs.lstat;
	spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
		if (String(args[0]) === archiveFile) throw round54Error("listing stat");
		return await Reflect.apply(stat, fs, args);
	}) as typeof fs.lstat);
	await expect(sessionArchive.listArchivedSessionFiles(root)).rejects.toThrow("EIO: round54 listing stat");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("round54 incomplete archive listing is unknown rather than a shorter list", async () => {
	await archiveOnly();
	const readdir = fs.readdir;
	spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
		if (String(args[0]) === path.dirname(archiveFile)) throw round54Error("listing bucket", "EACCES");
		return await Reflect.apply(readdir, fs, args);
	}) as typeof fs.readdir);
	await expect(sessionArchive.listArchivedSessionFiles(root)).rejects.toThrow("EACCES: round54 listing bucket");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

for (const operation of ["readlink", "realpath"] as const) {
	test(`round54 failed link ${operation} check gives no invented move advice`, async () => {
		const artifacts = sessionFile.slice(0, -6);
		await Bun.write(path.join(root, "outside.log"), "ORIGINAL");
		await fs.mkdir(artifacts);
		const link = path.join(artifacts, "link");
		await fs.symlink(path.join(root, "outside.log"), link);
		await archiveOnly();
		const original = fs[operation];
		spyOn(fs, operation).mockImplementation((async (...args: Parameters<typeof fs.realpath>) => {
			if (String(args[0]) === link) throw round54Error(`link ${operation}`);
			return await Reflect.apply(original, fs, args);
		}) as typeof original);
		const result = await runGcCommand({ flags: reclaimApply() });
		expect(result.reclaim?.errors.join("\n")).toContain(`EIO: round54 link ${operation}`);
		expect(result.reclaim?.errors.join("\n")).not.toContain("move the link out");
		expect(await Bun.file(path.join(root, "outside.log")).text()).toBe("ORIGINAL");
	});
}

test("round54 failed inode flag probe does not promise a rename", async () => {
	const real = libcModule.libc();
	spyOn(libcModule, "libc").mockReturnValue({
		...real,
		statx: () => -1,
		ioctl: () => -1,
		errno: () => os.constants.errno.EIO,
	});
	await expect(regularFile.renameRefusal(sessionFile, root)).rejects.toThrow("EIO");
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
});

test("round54 residue resolution failure gives no unverified recovery command", async () => {
	const record = path.join(stagingLedgerDir(root), "record.json");
	const dir = path.join(root, "stage");
	await fs.mkdir(dir);
	await Bun.write(record, "record bytes");
	const realpath = fs.realpath;
	spyOn(fs, "realpath").mockImplementation((async (...args: Parameters<typeof fs.realpath>) => {
		if (String(args[0]) === root) throw round54Error("residue resolution");
		return await Reflect.apply(realpath, fs, args);
	}) as typeof fs.realpath);
	await expect(stagingResidueNote(dir, record, "kept")).rejects.toThrow("EIO: round54 residue resolution");
	expect(await Bun.file(record).text()).toBe("record bytes");
});

test("round54 failed broken link lookup does not report a smaller broken link count", async () => {
	const artifact = path.join(sessionFile.slice(0, -6), "broken");
	await fs.mkdir(path.dirname(artifact));
	await fs.symlink(path.join(root, "absent"), artifact);
	const lstat = fs.lstat;
	spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
		if (String(args[0]) === artifact) throw round54Error("broken link lookup");
		return await Reflect.apply(lstat, fs, args);
	}) as typeof fs.lstat);
	const result = await archiveOnly();
	expect(result.archive?.errors.join("\n")).toContain("EIO: round54 broken link lookup");
	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.brokenLinks).toBeUndefined();
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
});

test("round54 failed staging existence check preserves both errors and the record", async () => {
	const open = fs.open;
	const lstat = fs.lstat;
	let openFailed = false;
	spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
		if (String(args[0]).endsWith(".tmp")) {
			openFailed = true;
			throw round54Error("stage open");
		}
		return await Reflect.apply(open, fs, args);
	}) as typeof fs.open);
	spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
		if (openFailed && String(args[0]).endsWith(".tmp")) throw round54Error("stage existence");
		return await Reflect.apply(lstat, fs, args);
	}) as typeof fs.lstat);
	const mint = mintStagingGround(sessionFile, stagingLedgerDir(root));
	await expect(mint).rejects.toThrow("EIO: round54 stage open");
	await expect(mint).rejects.toThrow("EIO: round54 stage existence");
	expect((await fs.readdir(stagingLedgerDir(root))).filter(name => name.endsWith(".json")).length).toBe(1);
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
});

test("round54 failed write-back size check is unknown with its error, not silently unknown", async () => {
	const file = path.join(root, "copy");
	await Bun.write(file, "ORIGINAL");
	const open = fs.open;
	let unlinked = false;
	const unlink = fs.unlink;
	spyOn(fs, "unlink").mockImplementation(async target => {
		await unlink(target);
		if (String(target).endsWith(".leaving")) unlinked = true;
	});
	spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
		const handle = await Reflect.apply(open, fs, args);
		if (String(args[0]) === file && unlinked) {
			handle.stat = (async () => {
				throw round54Error("write-back size");
			}) as typeof handle.stat;
		} else if (String(args[0]).endsWith(".leaving")) {
			const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
			handle.read = (async (...a: unknown[]) => {
				if (unlinked && Number(a[3]) >= 8) throw round54Error("write-back end");
				return await read(...a);
			}) as typeof handle.read;
		}
		return handle;
	}) as typeof fs.open);
	const result = await regularFile.removeFileOthersMayWrite(file, {
		matches: () => true,
		mismatch: "different file",
		judge: async () => undefined,
		confirm: async () => "copy must stay",
	});
	expect(result.outcome).toBe("kept");
	if (result.outcome !== "kept") throw new Error("copy was not retained");
	expect(result.note).toContain("EIO: round54 write-back size");
	expect(result.note).toContain("EIO: round54 write-back end");
	expect(result.lost).toBeUndefined();
	expect(await Bun.file(file).text()).toBe("ORIGINAL");
});

test("round54 failed reclaim container cleanup is reported with its original intact", async () => {
	await archiveOnly();
	const container = path.dirname(reclaimedNames().transcript);
	const rename = libcModule.renameNoReplace;
	let moved = false;
	spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		const answer = await rename(from, to);
		if (from === sessionFile && answer.outcome === "renamed") moved = true;
		return answer;
	});
	const lstat = fs.lstat;
	let refused = false;
	spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
		if (moved && !refused && String(args[0]) === reclaimedNames().transcript) {
			refused = true;
			throw round54Error("moved transcript lookup");
		}
		return await Reflect.apply(lstat, fs, args);
	}) as typeof fs.lstat);
	const rmdir = fs.rmdir;
	spyOn(fs, "rmdir").mockImplementation((async (...args: Parameters<typeof fs.rmdir>) => {
		if (String(args[0]) === container) throw round54Error("container cleanup");
		return await Reflect.apply(rmdir, fs, args);
	}) as typeof fs.rmdir);
	const result = await runGcCommand({ flags: reclaimApply() });
	expect(result.reclaim?.reclaimed).toBe(0);
	expect(result.reclaim?.errors.join("\n")).toContain("EIO: round54 moved transcript lookup");
	expect(result.reclaim?.errors.join("\n")).toContain("EIO: round54 container cleanup");
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
	expect(await fs.readdir(container)).toEqual([]);
});

test("round54 restore preview preserves the ownership probe's original error", async () => {
	await archiveOnly();
	spyOn(fileLock, "isFileLockHeld").mockImplementation(() => {
		throw round54Error("ownership probe");
	});
	const result = await runGcCommand({ flags: restoreApply(false) });
	expect(isSessionLeaseHeld(SESSION_ID)).toBeNull();
	expect(result.restore?.errors.join("\n")).toContain("EIO: round54 ownership probe");
	expect(result.restore?.errors.join("\n")).not.toMatch(/^a running process owns/m);
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("round54 unsupported attribute inspection is unknown, not an empty attribute list", async () => {
	const real = libcModule.libc();
	spyOn(libcModule, "libc").mockReturnValue({
		...real,
		flistxattr: () => -1,
		errno: () => os.constants.errno.ENOTSUP,
	});
	const result = await archiveOnly();
	expect(result.archive?.errors.join("\n")).toContain("ENOTSUP");
	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
});

for (const failure of ["bucket", "stat", "read", "FIFO", "symbolic link"] as const) {
	test(`round55 archive reports an unreadable ${failure} instead of an empty listing`, async () => {
		const original = await Bun.file(sessionFile).text();
		if (failure === "bucket") {
			const readdir = nodeFs.readdirSync;
			spyOn(nodeFs, "readdirSync").mockImplementation(((...args: Parameters<typeof nodeFs.readdirSync>) => {
				if (String(args[0]) === path.dirname(sessionFile)) throw round54Error("bucket listing");
				return Reflect.apply(readdir, nodeFs, args);
			}) as typeof nodeFs.readdirSync);
		} else if (failure === "stat") {
			const lstat = nodeFs.lstatSync;
			const stat = nodeFs.statSync;
			for (const [name, call] of [
				["lstatSync", lstat],
				["statSync", stat],
			] as const) {
				spyOn(nodeFs, name).mockImplementation(((...args: Parameters<typeof nodeFs.statSync>) => {
					if (String(args[0]) === sessionFile) throw round54Error("transcript stat");
					return Reflect.apply(call, nodeFs, args);
				}) as typeof stat);
			}
		} else if (failure === "read") {
			const open = fs.open;
			spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
				if (String(args[0]) === sessionFile) throw round54Error("transcript read");
				return await Reflect.apply(open, fs, args);
			}) as typeof fs.open);
		} else {
			await fs.unlink(sessionFile);
			if (failure === "FIFO") {
				const child = Bun.spawn(["mkfifo", sessionFile]);
				expect(await child.exited).toBe(0);
			} else {
				await fs.symlink(path.join(root, "missing-transcript"), sessionFile);
			}
		}
		const result = await archiveOnly();
		const said = result.archive?.errors.join("\n") ?? "";
		expect(said).toContain(failure === "bucket" ? path.dirname(sessionFile) : sessionFile);
		expect(said).toContain(
			failure === "FIFO" ? "a FIFO" : failure === "symbolic link" ? "a symbolic link" : "EIO: round54",
		);
		expect(result.archive?.archived).toBe(0);
		expect(result.archive?.scanned).toBeUndefined();
		mock.restore();
		if (failure === "FIFO" || failure === "symbolic link") {
			expect((await fs.lstat(sessionFile)).isFile()).toBe(false);
		} else expect(await Bun.file(sessionFile).text()).toBe(original);
	});
}

test("round55 an unreadable nested transcript keeps its parent with the read error", async () => {
	const child = path.join(sessionFile.slice(0, -6), "sub", "child.jsonl");
	await Bun.write(child, sessionBody(sessionId("000000000055"), "nested", root));
	const open = fs.open;
	let failed = false;
	spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
		if (String(args[0]) === child && !failed) {
			failed = true;
			throw round54Error("nested transcript read");
		}
		return await Reflect.apply(open, fs, args);
	}) as typeof fs.open);
	const result = await archiveOnly();
	expect(result.archive?.errors.join("\n")).toContain("EIO: round54 nested transcript read");
	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
	mock.restore();
	expect(await Bun.file(child).text()).toContain("nested");
});

test("round55 reclaim reports an unreadable transcript rather than a non-session", async () => {
	await archiveOnly();
	await fs.utimes(sessionFile, new Date(0), new Date(0));
	const open = fs.open;
	spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
		if (String(args[0]) === sessionFile) throw round54Error("reclaim transcript read");
		return await Reflect.apply(open, fs, args);
	}) as typeof fs.open);
	const result = await runGcCommand({ flags: reclaimApply() });
	expect(result.reclaim?.errors.join("\n")).toContain("EIO: round54 reclaim transcript read");
	expect(result.reclaim?.errors.join("\n")).not.toContain("is not a session file");
	expect(result.reclaim?.reclaimed).toBe(0);
	mock.restore();
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
});

test("round55 successful reclaim never tries to remove its occupied container", async () => {
	await archiveOnly();
	const container = path.dirname(reclaimedNames().transcript);
	const rename = libcModule.renameNoReplace;
	let moved = false;
	spyOn(libcModule, "renameNoReplace").mockImplementation(async (from, to) => {
		const answer = await rename(from, to);
		if (from === sessionFile && answer.outcome === "renamed") moved = true;
		return answer;
	});
	const lstat = fs.lstat;
	spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
		if (moved && String(args[0]) === container) throw round54Error("occupied container lookup");
		return await Reflect.apply(lstat, fs, args);
	}) as typeof fs.lstat);
	const rmdir = fs.rmdir;
	let attempted = false;
	spyOn(fs, "rmdir").mockImplementation((async (...args: Parameters<typeof fs.rmdir>) => {
		if (String(args[0]) === container) {
			attempted = true;
			throw round54Error("occupied container removal");
		}
		return await Reflect.apply(rmdir, fs, args);
	}) as typeof fs.rmdir);
	const result = await runGcCommand({ flags: reclaimApply() });
	expect(result.reclaim).toMatchObject({ reclaimed: 1, errors: [] });
	expect(attempted).toBe(false);
	expect(await Bun.file(reclaimedNames().transcript).text()).toContain(PROMPT);
});

for (const mode of [0o000, 0o200]) {
	test(`round55 restore preview can set aside an unreadable ${mode.toString(8)} record just like apply`, async () => {
		await archiveEverything();
		const record = restoreRecordPath(archiveFile);
		await Bun.write(record, "ORIGINAL RECORD");
		await fs.chmod(record, mode);
		const preview = await runGcCommand({ flags: restoreApply(false) });
		expect(preview.restore).toMatchObject({ errors: [], setAsideRecord: record });
		const applied = await runGcCommand({ flags: restoreApply() });
		expect(applied.restore?.errors).toEqual([]);
		const aside = applied.restore?.setAsideRecord;
		expect(aside).toBeDefined();
		await fs.chmod(aside!, 0o600);
		expect(await Bun.file(aside!).text()).toBe("ORIGINAL RECORD");
		expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
	});
}

test("round55 rename preview does not need read permission on a writable searchable directory", async () => {
	const from = path.join(root, "unreadable-directory");
	const into = path.join(root, "new-parent");
	await fs.mkdir(from, { mode: 0o300 });
	await fs.mkdir(into);
	try {
		expect(await regularFile.renameRefusal(from, into)).toBeUndefined();
		await fs.rename(from, path.join(into, "moved"));
		expect((await fs.lstat(path.join(into, "moved"))).isDirectory()).toBe(true);
	} finally {
		await fs.chmod(from, 0o700).catch(() => undefined);
		await fs.chmod(path.join(into, "moved"), 0o700).catch(() => undefined);
	}
});

for (const apply of [false, true]) {
	test(`round55 reclaim reports a failed destination check and its kept tree with apply ${apply}`, async () => {
		const tree = sessionFile.slice(0, -6);
		await Bun.write(path.join(tree, "a.log"), "ORIGINAL");
		await archiveOnly();
		const container = path.dirname(reclaimedNames().transcript);
		const stat = fs.stat;
		const lstat = fs.lstat;
		for (const [name, call] of [
			["stat", stat],
			["lstat", lstat],
		] as const) {
			spyOn(fs, name).mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
				if (String(args[0]) === container) throw round54Error("destination check");
				return await Reflect.apply(call, fs, args);
			}) as typeof stat);
		}
		const result = await runGcCommand({ flags: { ...reclaimApply(), apply } });
		expect(result.reclaim?.errors.join("\n")).toContain("EIO: round54 destination check");
		expect(result.reclaim?.keptArtifactTree).toBe(tree);
		expect(result.reclaim?.reclaimed).toBe(0);
		expect(await Bun.file(path.join(tree, "a.log")).text()).toBe("ORIGINAL");
	});
}

test("round55 reclaim reports an unreadable archive listing for an empty query", async () => {
	await archiveOnly();
	const readdir = fs.readdir;
	spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
		if (String(args[0]) === path.dirname(archiveFile)) throw round54Error("empty-query listing");
		return await Reflect.apply(readdir, fs, args);
	}) as typeof fs.readdir);
	const result = await runGcCommand({ flags: { ...reclaimApply(), reclaim: "", apply: false } });
	expect(result.reclaim?.errors.join("\n")).toContain("EIO: round54 empty-query listing");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("round55 reclaim names a missing archive without claiming space was given back", async () => {
	const result = await runGcCommand({ flags: reclaimApply() });
	expect(result.reclaim?.errors.join("\n")).toContain("no such archive file");
	expect(result.reclaim?.errors.join("\n")).not.toContain("already given back");
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
});

for (const site of [
	"live artifacts",
	"live transcript",
	"archive transcript",
	"archive artifacts",
	"reclaim container",
] as const) {
	test(`round55 reclaim reports a dangling symbolic link at ${site} in preview and apply`, async () => {
		await archiveOnly();
		const tree = sessionFile.slice(0, -6);
		const entry =
			site === "live artifacts"
				? tree
				: site === "live transcript"
					? sessionFile
					: site === "archive transcript"
						? archiveFile
						: site === "archive artifacts"
							? archiveFile.slice(0, -9)
							: path.dirname(reclaimedNames().transcript);
		if (site === "archive artifacts") await fs.mkdir(tree);
		await fs.rm(entry, { recursive: true, force: true });
		await fs.mkdir(path.dirname(entry), { recursive: true });
		await fs.symlink(path.join(root, "missing"), entry);
		for (const apply of [false, true]) {
			const result = await runGcCommand({ flags: { ...reclaimApply(), apply } });
			expect(result.reclaim?.errors.join("\n")).toContain("a symbolic link");
			expect(result.reclaim?.errors.join("\n")).not.toContain("was written to after");
			expect(result.reclaim?.reclaimed).toBe(0);
			if (site === "live artifacts") expect(result.reclaim?.keptArtifactTree).toBe(tree);
		}
		expect((await fs.lstat(entry)).isSymbolicLink()).toBe(true);
		if (site !== "live transcript") expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
	});
}

test("round55 restore reports a dangling live transcript rather than a late collision", async () => {
	await archiveEverything();
	await fs.symlink(path.join(root, "missing"), sessionFile);
	for (const apply of [false, true]) {
		const result = await runGcCommand({ flags: restoreApply(apply) });
		expect(result.restore?.errors.join("\n")).toContain("a symbolic link");
		expect(result.restore?.errors.join("\n")).not.toContain("EEXIST");
	}
	expect((await fs.lstat(sessionFile)).isSymbolicLink()).toBe(true);
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("round55 materialize reports a dangling unfinished-restore record", async () => {
	await archiveOnly();
	const record = restoreRecordPath(archiveFile);
	await fs.symlink(path.join(root, "missing"), record);
	await expect(materializeSessionFile(sessionFile, root)).rejects.toThrow("a symbolic link");
	expect((await fs.lstat(record)).isSymbolicLink()).toBe(true);
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
});

test("round55 archive names a symbolic link at its destination", async () => {
	await fs.mkdir(path.dirname(archiveFile), { recursive: true });
	await fs.symlink(path.join(root, "missing"), archiveFile);
	const result = await archiveOnly();
	expect(result.archive?.errors.join("\n")).toContain("a symbolic link");
	expect(result.archive?.errors.join("\n")).not.toContain("a special file");
	expect(result.archive?.archived).toBe(0);
	expect((await fs.lstat(archiveFile)).isSymbolicLink()).toBe(true);
});

for (const target of ["missing", "stale"] as const) {
	test(`round55 gc refuses a ${target} lock symbolic link in preview and apply`, async () => {
		await archiveOnly();
		const lock = path.join(root, "gc.lock");
		const outside = path.join(root, "outside-lock");
		if (target === "stale") await Bun.write(outside, `2147483647\n2026-01-01T00:00:00.000Z\n${"a".repeat(64)}\n`);
		await fs.symlink(outside, lock);
		for (const apply of [false, true]) {
			await expect(runGcCommand({ flags: { ...reclaimApply(), apply } })).rejects.toThrow("a symbolic link");
		}
		expect((await fs.lstat(lock)).isSymbolicLink()).toBe(true);
		if (target === "stale") expect(await Bun.file(outside).text()).toContain("2147483647");
		expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
	});
}

for (const site of ["archive tree", "live tree"] as const) {
	test(`round55 restore reports a dangling ${site} rather than treating it as absent`, async () => {
		await archiveOnly();
		const entry = site === "archive tree" ? archiveFile.slice(0, -9) : sessionFile.slice(0, -6);
		await fs.symlink(path.join(root, "missing-tree"), entry);
		for (const apply of [false, true]) {
			const result = await runGcCommand({ flags: restoreApply(apply) });
			expect(result.restore?.errors.join("\n")).toContain("a symbolic link");
		}
		expect((await fs.lstat(entry)).isSymbolicLink()).toBe(true);
		expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
	});
}

test("round55 a dangling archive name cannot hide an unfinished restore from materialize", async () => {
	await archiveOnly();
	await fs.unlink(archiveFile);
	await fs.symlink(path.join(root, "missing-archive"), archiveFile);
	await fs.symlink(path.join(root, "missing-record"), restoreRecordPath(archiveFile));
	await expect(materializeSessionFile(sessionFile, root)).rejects.toThrow("a symbolic link");
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
});

test("round55 a dangling breaker lock is reported without an invented acquisition race", async () => {
	await archiveOnly();
	await leaveDeadGcLock(root);
	const breaker = path.join(root, "gc.lock.break");
	await fs.symlink(path.join(root, "missing-breaker"), breaker);
	for (const apply of [false, true]) {
		await expect(runGcCommand({ flags: { ...reclaimApply(), apply } })).rejects.toThrow("a symbolic link");
	}
	expect((await fs.lstat(breaker)).isSymbolicLink()).toBe(true);
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
});

test("round55 a failed whole-transcript check cannot archive a partially scanned session", async () => {
	await Bun.write(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n`,
	);
	const open = fs.open;
	let reads = 0;
	spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
		if (String(args[0]) === sessionFile && ++reads === 2) throw round54Error("whole-transcript check");
		return await Reflect.apply(open, fs, args);
	}) as typeof fs.open);
	const result = await archiveOnly();
	expect(result.archive?.errors.join("\n")).toContain("EIO: round54 whole-transcript check");
	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.skippedActive).toBe(0);
	expect(result.archive?.scanned).toBeUndefined();
	expect(await Bun.file(sessionFile).text()).toContain(SESSION_ID);
});

test("round55 restore reports a failed archive-name lookup instead of rejecting its preview", async () => {
	await archiveOnly();
	const stat = fs.stat;
	const lstat = fs.lstat;
	for (const [name, call] of [
		["stat", stat],
		["lstat", lstat],
	] as const) {
		spyOn(fs, name).mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
			if (String(args[0]) === archiveFile) throw round54Error("restore archive lookup");
			return await Reflect.apply(call, fs, args);
		}) as typeof stat);
	}
	for (const apply of [false, true]) {
		const result = await runGcCommand({ flags: { ...restoreApply(apply), restore: archiveFile } });
		expect(result.restore?.errors.join("\n")).toContain("EIO: round54 restore archive lookup");
	}
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
});

test("round55 reclaim names a stranded tree symbolic link when its transcript is absent", async () => {
	await archiveOnly();
	await fs.unlink(sessionFile);
	const tree = sessionFile.slice(0, -6);
	await fs.symlink(path.join(root, "missing-tree"), tree);
	for (const apply of [false, true]) {
		const result = await runGcCommand({ flags: { ...reclaimApply(), apply } });
		expect(result.reclaim?.errors.join("\n")).toContain("a symbolic link");
		expect(result.reclaim?.keptArtifactTree).toBe(tree);
		expect(result.reclaim?.errors.join("\n")).not.toContain("already given back");
	}
	expect((await fs.lstat(tree)).isSymbolicLink()).toBe(true);
});

test("round55 archive reports a symbolic link at the legacy transcript name in preview and apply", async () => {
	const legacy = archiveFile.slice(0, -3);
	await fs.mkdir(path.dirname(legacy), { recursive: true });
	await fs.symlink(path.join(root, "missing-legacy"), legacy);
	const old = new Date(0);
	await fs.utimes(sessionFile, old, old);
	for (const apply of [false, true]) {
		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				apply,
				json: true,
				coldArchiveAfterDays: 0,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
			},
		});
		expect(result.archive?.errors.join("\n")).toContain("a symbolic link");
		expect(result.archive?.archived).toBe(0);
	}
	expect((await fs.lstat(legacy)).isSymbolicLink()).toBe(true);
	expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
});

test("round55 restore refuses a symbolic link at the reclaimed container before moving any original", async () => {
	await archiveOnly();
	expect((await runGcCommand({ flags: reclaimApply() })).reclaim?.reclaimed).toBe(1);
	const container = path.dirname(reclaimedNames().transcript);
	const moved = path.join(root, "originals-outside");
	await fs.rename(container, moved);
	await fs.symlink(moved, container);
	for (const apply of [false, true]) {
		const result = await runGcCommand({ flags: restoreApply(apply) });
		expect(result.restore?.errors.join("\n")).toContain("a symbolic link");
		expect(await Bun.file(sessionFile).exists()).toBe(false);
		expect(await Bun.file(path.join(moved, path.basename(sessionFile))).text()).toContain(PROMPT);
	}
	expect((await fs.lstat(container)).isSymbolicLink()).toBe(true);
});

test("round55 reclaim names a symbolic link instead of accepting an archived artifact alias", async () => {
	const artifact = path.join(sessionFile.slice(0, -6), "a.log");
	const copy = path.join(archiveFile.slice(0, -9), "a.log");
	await Bun.write(artifact, "ORIGINAL");
	await archiveOnly();
	await fs.unlink(copy);
	await fs.symlink(artifact, copy);
	for (const apply of [false, true]) {
		const result = await runGcCommand({ flags: { ...reclaimApply(), apply } });
		expect(result.reclaim?.errors.join("\n")).toContain("a symbolic link");
		expect(result.reclaim?.reclaimed).toBe(0);
	}
	expect(await Bun.file(artifact).text()).toBe("ORIGINAL");
	expect((await fs.lstat(copy)).isSymbolicLink()).toBe(true);
});

for (const site of ["transcript", "artifact"] as const) {
	test(`round55 archive reports a symbolic link put at its ${site} destination during open`, async () => {
		const artifact = path.join(sessionFile.slice(0, -6), "a.log");
		await Bun.write(artifact, "ORIGINAL ARTIFACT");
		const destination = site === "transcript" ? archiveFile : path.join(archiveFile.slice(0, -9), "a.log");
		const foreign = path.join(root, "foreign");
		const foreignBytes =
			site === "transcript" ? gzipSync(Buffer.from("FOREIGN TRANSCRIPT")) : Buffer.from("FOREIGN ARTIFACT");
		await Bun.write(foreign, foreignBytes);
		const open = fs.open;
		let replaced = false;
		spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
			if (!replaced && String(args[0]) === destination) {
				replaced = true;
				await fs.rename(destination, `${destination}.original`).catch(error => {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				});
				await fs.symlink(foreign, destination);
			}
			return await Reflect.apply(open, fs, args);
		}) as typeof fs.open);
		const result = await archiveOnly();
		expect(result.archive?.errors.join("\n")).toContain("a symbolic link");
		expect(result.archive?.archived).toBe(0);
		expect((await fs.lstat(destination)).isSymbolicLink()).toBe(true);
		expect(await fs.readFile(foreign)).toEqual(foreignBytes);
		expect(await Bun.file(artifact).text()).toBe("ORIGINAL ARTIFACT");
		expect(await Bun.file(sessionFile).text()).toContain(PROMPT);
	});
}
