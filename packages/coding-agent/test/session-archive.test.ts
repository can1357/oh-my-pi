import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import {
	collectGcErrors,
	type GcResult,
	renderText as renderGcText,
	runGcCommand,
} from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { resolveSessionFileArg } from "@oh-my-pi/pi-coding-agent/cli/session-arg";
import { exportFromFile } from "@oh-my-pi/pi-coding-agent/export/html";
import {
	ARCHIVED_RESIDUE,
	getArchivedSessionsDir,
	materializeSessionFile,
	mintStagingGround,
	type RestoredSession,
	restoreArchivedSession,
	removeStagingGround,
	type StagingGround,
	restoreRecordPath,
	stagingLedgerDir,
	stagingResidueNote,
} from "@oh-my-pi/pi-coding-agent/session/session-archive";
import { withGcLock } from "@oh-my-pi/pi-coding-agent/session/gc-lock";
import { resolveResumableSession, resolveResumeTarget } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	sessionStagingPath,
	tryAcquireSessionLease,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { type FileLockHandle, getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const SESSION_ID = "01a18630-42ae-7117-ba7c-029b1eee0f4b";
const PROMPT = "reply with exactly BRIDGE-PROOF-ONE";
let root: string;
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
 * Whether `target` is a file a run staged — inside the directory this
 * change mints, or at the flat staging name the head before it used, so the
 * same witness runs against both.
 */
function isStagedFile(target: string): boolean {
	return target.includes(".tmp/") || target.endsWith(".tmp");
}

/** A staging path below `root` that a copy is about to write. */
function isStagingUnder(root: string): (target: string) => boolean {
	return target => target.startsWith(root) && isStagedFile(target);
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
 * Archive every cold session and then give up each live copy — what a single
 * `--archive --apply` used to do, and what it now takes two commands to do.
 * The result returned is the archive phase's, because that is what the tests
 * below are about; a reclaim that refuses adds its reason to the errors.
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
		const reclaimed = await runGcCommand({
			flags: {
				agentDir: root,
				reclaim: path.join(archiveBucket, entry),
				apply: true,
				forwardOnly: true,
				json: true,
			},
		});
		const kept = reclaimed.reclaim?.errors ?? [];
		if (kept.length > 0 && result.archive) result.archive.errors.push(...kept);
	}
	return result;
}

beforeEach(async () => {
	originalAgentDir = getAgentDir();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-archive-"));
	setAgentDir(root);
	sessionFile = await writeSession("2026-01-01T00-00-00-000Z", SESSION_ID);
	archiveFile = archivePathFor(sessionFile);
});

afterEach(async () => {
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
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody("sub-1", "nested subagent prompt", root));
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
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody("sub-1", "nested", root));
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

test("a symlinked transcript is archived by content, and the file it points at is left alone", async () => {
	const store = path.join(root, "offload");
	await fs.mkdir(store, { recursive: true });
	const target = path.join(store, "offloaded.jsonl");
	const original = await fs.readFile(sessionFile);
	await fs.rename(sessionFile, target);
	await fs.symlink(target, sessionFile);

	const result = await archiveEverything();

	expect(result.archive).toMatchObject({ archived: 1, errors: [] });
	expect(await Bun.file(sessionFile).exists()).toBe(false);
	expect(Bun.gunzipSync(await fs.readFile(archiveFile))).toEqual(new Uint8Array(original));
	// omp deletes nothing outside its own storage: the link's target stays,
	// and so does the link until someone reclaims the live copy.
	expect(await Bun.file(target).exists()).toBe(true);
});

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
	await Bun.write(archiveFile, gzipSync(Buffer.from(sessionBody("someone-else", "other", root))));

	const result = await archiveEverything();

	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.errors.join("\n")).toContain("holds a different session");
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

test("gc --archive keeps the session's artifact tree readable from the archive", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	const nestedStore = path.join(root, "offload-nested");
	await fs.mkdir(nestedStore, { recursive: true });
	const nestedTarget = path.join(nestedStore, "sub.jsonl");
	await Bun.write(nestedTarget, sessionBody("sub-1", "nested", root));
	await fs.mkdir(artifacts, { recursive: true });
	await fs.symlink(nestedTarget, path.join(artifacts, "sub.jsonl"));

	await archiveEverything();

	// The archive holds the bytes, not a pointer into a tree that may move.
	const archivedNested = path.join(archiveFile.slice(0, -".jsonl.gz".length), "sub.jsonl");
	expect((await fs.lstat(archivedNested)).isSymbolicLink()).toBe(false);
	expect(await Bun.file(archivedNested).text()).toContain("sub-1");
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

test("a symlinked sessions directory is not reported as an orphaned link target", async () => {
	const real = path.join(root, "sessions-elsewhere");
	await fs.rename(getSessionsDir(root), real);
	await fs.symlink(real, getSessionsDir(root));

	const result = await archiveEverything();

	expect(result.archive).toMatchObject({ archived: 1, errors: [] });
});

test("a broken link inside an artifact tree is skipped and counted, not left blocking the session", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "kept.txt"), "kept");
	await fs.symlink(path.join(root, "gone.jsonl"), path.join(artifacts, "dangling.jsonl"));

	const result = await archiveEverything();

	expect(result.archive).toMatchObject({ archived: 1, brokenLinks: 1, errors: [] });
	expect(await Bun.file(archiveFile).exists()).toBe(true);
	expect(await Bun.file(path.join(archiveFile.slice(0, -".jsonl.gz".length), "kept.txt")).text()).toBe("kept");
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
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody("sub-1", "nested", root));
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
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody("sub-1", "nested", root));
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
	await ground.handle.close();

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
	const continuationId = "01a18630-42ae-7117-ba7c-ffffffffffff";
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
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody("sub-1", "nested subagent prompt", root));
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
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody("sub-1", "nested subagent prompt", root));
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
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody("sub-1", "nested", root));
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
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody("sub-1", "nested", root));
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

test("an artifact tree that cannot be dropped leaves the archive complete, not deleted", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody("sub-1", "nested", root));
	const realUnlink = fs.unlink;
	const rm = spyOn(fs, "unlink").mockImplementation(async target => {
		// A locked artifact: the copy into the archive succeeded, dropping the
		// live tree did not.
		if (String(target).startsWith(`${artifacts}${path.sep}`)) {
			throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		}
		return await realUnlink(target);
	});
	try {
		const result = await archiveEverything();

		// The removal could not be finished, and the report names that rather
		// than claiming the tree was kept whole.
		expect(result.archive?.errors.join("\n")).toContain("was kept:");
		// The session is recoverable: the archive holds the transcript and the tree.
		expect(await Bun.file(archiveFile).exists()).toBe(true);
		expect(await Bun.file(path.join(archiveFile.slice(0, -".jsonl.gz".length), "sub.jsonl")).text()).toContain(
			"nested",
		);
	} finally {
		rm.mockRestore();
	}
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
	const childId = "01a18630-42ae-7117-ba7c-029b1eee0f4c";
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
		`${serializeTitleSlot({ title, source: "user", updatedAt: stamp })}${sessionBody("01a18630-42ae-7117-ba7c-029b1eee0f4c", "nested turn", root)}`;
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
	const other = "01a18630-42ae-7117-ba7c-029b1eee0f4c";
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
	expect(result.archive?.errors.join("\n")).toContain("the archive is left as it is");
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
		`${JSON.stringify({ type: "session", version: 3, id: "example", title })}\n${JSON.stringify({
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
	const childId = "01a18630-42ae-7117-ba7c-029b1eee0f4c";
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
	expect(restored?.notRestored.join("\n")).toContain("is not what this run staged there, so it was left alone");
});

test("a failed archive leaves no empty directory behind its own staging residue", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "z.log"), "SECOND");

	// The stage for the second file cannot be removed, and the run then
	// fails: the directory it was minted in stays, with its own file in it,
	// and nothing else of this run's is left behind.
	const realRm = fs.rm;
	let blocked = true;
	const rm = spyOn(fs, "rm").mockImplementation(async (target, options) => {
		if (blocked && isStagedFile(String(target)) && String(target).includes("z.log")) {
			blocked = false;
			throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
		}
		return await realRm(target, options);
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
	expect(result.archive?.errors.join("\n")).toContain("could not be removed");
	// Only this run's own staging ground is left, and it is named in the
	// errors rather than quietly swept by the shape of its name.
	for (const name of await fs.readdir(archivedArtifacts).catch(() => [])) {
		expect(/^\..+\.[0-9a-f]{16}\.tmp$/.test(name)).toBe(true);
	}
});

test("a restore sees an owner whose transcript opens the way the session loader allows", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	const childId = "01a18630-42ae-7117-ba7c-029b1eee0f4c";
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
	const lateId = "01a18630-42ae-7117-ba7c-029b1eee0f4c";
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
	const other = "01a18630-42ae-7117-ba7c-029b1eee0f4c";
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
	const lateId = "01a18630-42ae-7117-ba7c-029b1eee0f4c";
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
	const other = "01a18630-42ae-7117-ba7c-029b1eee0f4c";
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
	const other = "01a18630-42ae-7117-ba7c-029b1eee0f4c";
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
	const childId = "01a18630-42ae-7117-ba7c-029b1eee0f4c";
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
	expect(result.reclaim?.errors.join("\n")).toContain("subagent sessions");
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
	expect(result.reclaim?.partiallyRemoved ?? []).toEqual([]);
	expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("FIRST");
	expect(await Bun.file(path.join(liveArtifacts, "child", "only.log")).text()).toBe("NESTED");
	expect(await Bun.file(path.join(liveArtifacts, "z.log")).text()).toBe("DIVERGED");
	expect(await Bun.file(sessionFile).exists()).toBe(true);
});

test("a reclaim whose removal fails part-way names what it had already removed", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "z.log"), "LAST");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);

	const realUnlink = fs.unlink;
	const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
		if (String(target).endsWith("z.log")) throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
		return await realUnlink(target);
	});
	let result: GcResult;
	try {
		result = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
	} finally {
		unlink.mockRestore();
	}

	// Part of the tree is gone, so saying it was kept would be false. What
	// went is named, and so is the command that brings it back.
	expect(result.reclaim?.reclaimed).toBe(0);
	expect(result.reclaim?.partiallyRemoved).toEqual([path.join(liveArtifacts, "a.log")]);
	expect(collectGcErrors(result).join("\n")).toContain("was partly given up");
	expect(renderGcText(result)).toContain("reclaim removed before it stopped:");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
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

test("a reclaim that removed nothing does not say it gave anything up", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);

	const realUnlink = fs.unlink;
	const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
		if (String(target).endsWith("a.log")) throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
		return await realUnlink(target);
	});
	let result: GcResult;
	try {
		result = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
	} finally {
		unlink.mockRestore();
	}

	// The very first removal failed, so nothing was given up and the report
	// must not borrow the wording for a run that gave up part of a tree.
	expect(result.reclaim?.partiallyRemoved ?? []).toEqual([]);
	expect(collectGcErrors(result).join("\n")).toContain("was kept:");
	expect(collectGcErrors(result).join("\n")).not.toContain("partly given up");
	expect(await Bun.file(path.join(liveArtifacts, "a.log")).text()).toBe("FIRST");
});

test("a reclaim's recovery instruction can be copied literally with --agent-dir", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "z.log"), "LAST");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);

	const realUnlink = fs.unlink;
	const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
		if (String(target).endsWith("z.log")) throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
		return await realUnlink(target);
	});
	let result: GcResult;
	try {
		result = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
	} finally {
		unlink.mockRestore();
	}

	// Copied as printed, it has to reach this agent directory rather than the
	// default one.
	expect(collectGcErrors(result).join("\n")).toContain(`--agent-dir ${root}`);
});

test("resuming a session whose artifacts are still archived finishes the restore", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "sub.jsonl"), "SUBAGENT TRANSCRIPT\n");
	await archiveEverything();
	// What a kill between publishing the transcript and carrying the tree
	// home leaves: the live transcript back, the artifacts still archived,
	// and the restore's record of being unfinished still down.
	await halfRestore();

	const materialized = await materializeSessionFile(sessionFile, root);

	// Opening it as if it were whole would give a session with its subagent
	// transcripts missing and nothing said.
	expect(materialized).toBe(sessionFile);
	expect(await Bun.file(path.join(liveArtifacts, "sub.jsonl")).text()).toBe("SUBAGENT TRANSCRIPT\n");
});
test("the resume route finishes a half restore rather than opening a session without its artifacts", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "sub.jsonl"), "SUBAGENT TRANSCRIPT\n");
	await archiveEverything();
	// The same half restore. Resume-by-id resolves to the live `.jsonl`, not
	// the archive, so a materialize that only looks at `.gz` never runs.
	await halfRestore();

	const manager = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
	await manager.close();

	expect(await Bun.file(path.join(liveArtifacts, "sub.jsonl")).text()).toBe("SUBAGENT TRANSCRIPT\n");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});
test("a complete session that carried on since it was archived still opens", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const childId = "01a18630-42ae-7117-ba7c-029b1eee0f4c";
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
	expect(result.archive?.errors.join("\n")).toContain("is not what this run staged there, so it was left alone");
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
	expect(renderGcText(preview)).toContain(`reclaim: would give up ${sessionFile}`);
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
		const sub = sessionBody("01a18630-42ae-7117-ba7c-029b1eee0f4d", "SUB", root);
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
	const name = "2026-01-01T00-00-00-000Z_01a18630-42ae-7117-ba7c-029b1eee0f4e.jsonl";
	const spacedSession = path.join(getSessionsDir(spaced), "--work--", name);
	await Bun.write(spacedSession, sessionBody("01a18630-42ae-7117-ba7c-029b1eee0f4e", PROMPT, spaced));
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

	expect(restored.notRestored.join("\n")).toContain("already holds something else");
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

test("archiving a session again clears a restore record an earlier attempt left", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "FIRST");
	await archiveEverything();
	await halfRestore();
	await Bun.write(path.join(liveArtifacts, "tool.log"), "FIRST");

	expect((await archiveOnly()).archive?.archived).toBe(1);

	// The archive is the live session's own copy again, so the unfinished
	// restore it records is about a state that no longer exists.
	expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(false);
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

test("a staged artifact rewritten in place before it is published does not become the archived copy", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "FIRST");

	// Same inode, same length: device, inode, size and both timestamps can
	// all agree afterwards. Only the bytes say what happened, which is why
	// the publication is read back and digested rather than identified.
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

	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(path.join(archivedArtifacts, "tool.log")).exists()).toBe(false);
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
	expect(await materializeSessionFile(sessionFile, root)).toBe(sessionFile);
	expect(await Bun.file(path.join(liveArtifacts, "only-archived.log")).text()).toBe("ONLY ARCHIVED");
});

test("a restore whose record cannot be written releases the leases it took", async () => {
	await archiveEverything();
	// The record is written into a file made for it, then renamed into place;
	// the failure is injected where that file is made.
	const record = restoreRecordPath(archiveFile);
	const realOpen = fs.open;
	const open = spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (String(target).startsWith(`${record}.`) && rest[0] === "wx") {
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
		const childId = "01a18630-42ae-7117-ba7c-029b1eee0f4c";
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

test("a reclaim holds the lease of every transcript it removes until the file is gone", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	const childId = "01a18630-42ae-7117-ba7c-029b1eee0f4c";
	const child = path.join(liveArtifacts, "child.jsonl");

	// A child that joined and is gone: a dead owner writes nothing late, so
	// its file may go — but only while nothing can claim it in between.
	const readdir = joinChildOnFirstWalk(childId, sessionBody(childId, "CHILD TURN", root));
	const realUnlink = fs.unlink;
	let claimable: boolean | undefined;
	const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
		if (claimable === undefined && String(target) === child) {
			const claim = tryAcquireSessionLease(childId);
			claimable = claim !== null;
			claim?.release();
		}
		await realUnlink(target);
	});
	let result: GcResult;
	try {
		result = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
	} finally {
		unlink.mockRestore();
		readdir.mockRestore();
	}

	expect(result.reclaim?.errors).toEqual([]);
	expect(result.reclaim?.reclaimed).toBe(1);
	expect(claimable).toBe(false);
});

test("a link replaced by a file after the reclaim walked past it is kept", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "b.log"), "SECOND");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	// A link has nothing to compare: what the walk proved is the entry, so
	// that is what has to still stand at the name when it goes.
	await fs.rm(path.join(liveArtifacts, "b.log"));
	await fs.symlink(path.join(archivedArtifacts, "b.log"), path.join(liveArtifacts, "b.log"));

	const realUnlink = fs.unlink;
	let replaced = false;
	const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
		await realUnlink(target);
		if (!replaced && String(target) === path.join(liveArtifacts, "a.log")) {
			replaced = true;
			await realUnlink(path.join(liveArtifacts, "b.log"));
			await Bun.write(path.join(liveArtifacts, "b.log"), "UNIQUE TURN");
		}
	});
	let result: GcResult;
	try {
		result = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
	} finally {
		unlink.mockRestore();
	}

	expect(replaced).toBe(true);
	expect(result.reclaim?.reclaimed).toBe(0);
	expect(await Bun.file(path.join(liveArtifacts, "b.log")).text()).toBe("UNIQUE TURN");
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

	const realRename = fs.rename;
	let renames = 0;
	const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
		await realRename(from, to);
		if (String(to) !== target) return;
		renames += 1;
		// The superseding copy is spoiled once it lands, so the run puts the
		// earlier copy back — and that is taken off the name and replaced by
		// a link onto the very bytes the run wrote back.
		if (renames === 1) await Bun.write(target, "WRONG");
		if (renames === 2) {
			await realRename(target, aside);
			await fs.symlink(aside, target);
		}
	});
	let result: GcResult;
	try {
		result = await archiveOnly();
	} finally {
		rename.mockRestore();
	}

	expect(renames).toBe(2);
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
		// Somebody else's session, put at the root name while an earlier entry
		// was being removed: the root goes last, and it has to be the file
		// that was proved, not whatever wears its name by then.
		const foreign = sessionBody("01a18630-42ae-7117-ba7c-029b1eee0f4d", "UNIQUE FOREIGN TURN", root);
		const realUnlink = fs.unlink;
		let rebound = false;
		const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
			await realUnlink(target);
			if (!rebound && String(target) === path.join(liveArtifacts, "a.log")) {
				rebound = true;
				if (how === "moved aside") await fs.rename(sessionFile, path.join(root, "aside.jsonl"));
				else await realUnlink(sessionFile);
				await Bun.write(sessionFile, foreign);
			}
		});
		let result: GcResult;
		try {
			result = await runGcCommand({
				flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
			});
		} finally {
			unlink.mockRestore();
		}

		expect(rebound).toBe(true);
		expect(result.reclaim?.reclaimed).toBe(0);
		expect(await Bun.file(sessionFile).text()).toBe(foreign);
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
	await ground.handle.close();
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

for (const which of ["an artifact", "the transcript"] as const) {
	test(`a reclaim does not give up ${which} for an archived copy more readable than it`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await fs.chmod(sessionFile, 0o644);
		await fs.chmod(path.join(liveArtifacts, "a.log"), 0o644);
		await archiveOnly();
		const live = which === "an artifact" ? path.join(liveArtifacts, "a.log") : sessionFile;
		const archived =
			which === "an artifact" ? path.join(archiveFile.slice(0, -".jsonl.gz".length), "a.log") : archiveFile;
		// Tightened after it was archived: the archive's copy would come back
		// readable by more than the file it replaced.
		await fs.chmod(live, 0o600);
		const reclaim = { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true };

		const refused = await runGcCommand({ flags: reclaim });
		expect(refused.reclaim?.reclaimed).toBe(0);
		expect(refused.reclaim?.errors.join("\n")).toContain("more than");
		expect((await fs.stat(live)).mode & 0o777).toBe(0o600);

		// Archiving again carries the tighter mode into the archive.
		await archiveOnly();
		expect((await fs.stat(archived)).mode & 0o777).toBe(0o600);
		const reclaimed = await runGcCommand({ flags: reclaim });
		expect(reclaimed.reclaim?.errors).toEqual([]);
		expect(reclaimed.reclaim?.reclaimed).toBe(1);
	});
}

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

test("a reclaim keeps a file whose mode changed after it was proved", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "b.log"), "SECOND");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	const b = path.join(liveArtifacts, "b.log");

	// Same inode, same bytes, tighter mode: the archive's copy would come
	// back wider than the file it replaced.
	const realUnlink = fs.unlink;
	let changed = false;
	const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
		await realUnlink(target);
		if (!changed && String(target) === path.join(liveArtifacts, "a.log")) {
			changed = true;
			await fs.chmod(b, 0o600);
		}
	});
	let result: GcResult;
	try {
		result = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
	} finally {
		unlink.mockRestore();
	}

	expect(changed).toBe(true);
	expect(result.reclaim?.reclaimed).toBe(0);
	expect((await fs.stat(b)).mode & 0o777).toBe(0o600);
});

test("a link replaced while the reclaim was reading it is kept", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "b.log"), "SECOND");
	await archiveEverything();
	await restoreArchivedSession(archiveFile, root);
	const link = path.join(liveArtifacts, "b.log");
	await fs.rm(link);
	await fs.symlink(path.join(archivedArtifacts, "b.log"), link);

	// Replaced between the walk's `lstat` and its `readlink`: an identity
	// put together from the two would describe the replacement.
	const elsewhere = path.join(root, "elsewhere.log");
	const realReadlink = fs.readlink;
	let replaced = false;
	const readlink = spyOn(fs, "readlink").mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (!replaced && String(target) === link) {
			replaced = true;
			await fs.unlink(link);
			await fs.symlink(elsewhere, link);
		}
		return await (realReadlink as (...args: unknown[]) => Promise<string>)(target, ...rest);
	}) as typeof fs.readlink);
	let result: GcResult;
	try {
		result = await runGcCommand({
			flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
		});
	} finally {
		readlink.mockRestore();
	}

	expect(replaced).toBe(true);
	expect(result.reclaim?.reclaimed).toBe(0);
	expect(await fs.readlink(link)).toBe(elsewhere);
});

for (const shape of ["a different link", "a FIFO"] as const) {
	test(`a link replaced by ${shape} after the reclaim walked past it is kept`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await Bun.write(path.join(liveArtifacts, "b.log"), "SECOND");
		await archiveEverything();
		await restoreArchivedSession(archiveFile, root);
		const link = path.join(liveArtifacts, "b.log");
		await fs.rm(link);
		await fs.symlink(path.join(archivedArtifacts, "b.log"), link);

		// The replacement can come back on the inode the link just freed, so
		// only its kind and, for a link, its target tell the two apart.
		const elsewhere = path.join(root, "elsewhere.log");
		const realUnlink = fs.unlink;
		let replaced = false;
		const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
			await realUnlink(target);
			if (!replaced && String(target) === path.join(liveArtifacts, "a.log")) {
				replaced = true;
				await realUnlink(link);
				if (shape === "a FIFO") expect(await Bun.spawn(["mkfifo", link]).exited).toBe(0);
				else await fs.symlink(elsewhere, link);
			}
		});
		let result: GcResult;
		try {
			result = await runGcCommand({
				flags: { agentDir: root, reclaim: archiveFile, apply: true, forwardOnly: true, json: true },
			});
		} finally {
			unlink.mockRestore();
		}

		expect(replaced).toBe(true);
		expect(result.reclaim?.reclaimed).toBe(0);
		const standing = await fs.lstat(link);
		if (shape === "a FIFO") expect(standing.isFIFO()).toBe(true);
		else expect(await fs.readlink(link)).toBe(elsewhere);
	});
}

test("staging cleanup leaves a FIFO that took the staged file's place", async () => {
	const ground = await mintStagingGround(path.join(root, "target.log"), stagingLedgerDir(root));
	await ground.handle.close();
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

	expect(restored.notRestored.join("\n")).toContain("could not be read");
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
	await Bun.write(path.join(artifacts, "sub.jsonl"), sessionBody("sub-1", "nested", root));
	await fs.chmod(artifacts, 0o755);
	await archiveEverything();
	// A directory the live tree already holds, tightened against other local users.
	await fs.mkdir(artifacts, { recursive: true });
	await fs.chmod(artifacts, 0o700);
	const broken = failWithEio("lstat", artifacts);
	let restored: RestoredSession;
	try {
		restored = await restoreArchivedSession(archiveFile, root);
	} finally {
		broken.mockRestore();
	}

	expect((await fs.stat(artifacts)).mode & 0o777).toBe(0o700);
	expect(restored.notRestored.join("\n")).toContain("EIO: injected");
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
	["the directory cannot be followed", "stat", "directory", "is not a directory"],
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

		const told = preview.restore?.errors.join("\n") ?? "";
		expect(told).toContain(`${entry} could not be checked`);
		expect(told).toContain("EIO: injected");
		expect(told).not.toContain(misread);
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
	await ground.handle.close();

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

test("a killed run's recorded stage is quarantined by gc, and the restore then finishes", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	const ground = await mintStagingGround(path.join(archivedArtifacts, "b.log"), stagingLedgerDir(root));
	await ground.handle.writeFile("PARTIAL STAGE");
	await ground.handle.close();
	const record = path.basename(ground.record);

	const refused = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	// The omission is in the public list as well as the errors, and the
	// advice is the command that moves it, not a path to delete.
	expect(refused.restore?.notRestored.join("\n")).toContain(ground.dir);
	const advice = refused.restore?.errors.join("\n") ?? "";
	expect(advice).toContain(`--quarantine`);
	expect(advice).toContain(record);

	const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
	expect(preview.quarantine?.errors).toEqual([]);
	expect((await fs.stat(ground.dir)).isDirectory()).toBe(true);

	const moved = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	expect(moved.quarantine?.errors).toEqual([]);
	expect(moved.quarantine?.moved).toBe(true);
	const quarantine = moved.quarantine?.quarantine ?? "";
	expect(await Bun.file(path.join(quarantine, path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(path.join(quarantine, record)).exists()).toBe(true);
	expect(await fs.stat(ground.dir).catch(() => undefined)).toBeUndefined();
	expect(await Bun.file(ground.record).exists()).toBe(false);
	for (const tree of [getArchivedSessionsDir(root), path.join(root, "sessions")]) {
		expect(path.relative(tree, quarantine).startsWith("..")).toBe(true);
	}

	const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	expect(restored.restore?.errors).toEqual([]);
	expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
	expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(false);
});

/** A session archived and reclaimed, with a killed run's recorded partial stage left in its archived tree. */
async function archivedWithKilledStage(): Promise<{ ground: StagingGround; record: string; liveArtifacts: string }> {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await archiveEverything();
	const ground = await mintStagingGround(path.join(archivedArtifacts, "b.log"), stagingLedgerDir(root));
	await ground.handle.writeFile("PARTIAL STAGE");
	await ground.handle.close();
	return { ground, record: path.basename(ground.record), liveArtifacts };
}

test("quarantine refuses a destination that resolves into a session tree, and moves nothing", async () => {
	const { ground, record, liveArtifacts } = await archivedWithKilledStage();
	// The quarantine directory is a link back into the archived artifact
	// tree, so a move into it would put the partial stage where a restore
	// carries it home.
	await fs.symlink(archiveFile.slice(0, -".jsonl.gz".length), path.join(root, "archive", "gc-quarantine"));

	const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
	const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

	expect(preview.quarantine?.errors.join("\n")).toContain("inside a session tree");
	expect(applied.quarantine?.errors.join("\n")).toContain("inside a session tree");
	expect(applied.quarantine?.moved).toBe(false);
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(ground.record).exists()).toBe(true);
	expect(restored.restore?.errors.length).toBeGreaterThan(0);
	expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
});

test("a quarantine killed after making its destination can be run again", async () => {
	const { ground, record, liveArtifacts } = await archivedWithKilledStage();
	// What a kill right after the destination `mkdir` leaves: the empty
	// destination, with the record and the directory where they were.
	const destination = path.join(root, "archive", "gc-quarantine", path.basename(record, ".json"));
	await fs.mkdir(destination, { recursive: true, mode: 0o700 });

	const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
	const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

	expect(preview.quarantine?.errors).toEqual([]);
	expect(applied.quarantine?.errors).toEqual([]);
	expect(applied.quarantine?.moved).toBe(true);
	expect(await Bun.file(path.join(destination, path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");
	expect(restored.restore?.errors).toEqual([]);
	expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
});

for (const obstacle of ["a destination holding something else", "a destination parent nobody can write"] as const) {
	test(`the quarantine preview reports ${obstacle}, as applying would`, async () => {
		const { ground, record } = await archivedWithKilledStage();
		const quarantineRoot = path.join(root, "archive", "gc-quarantine");
		const destination = path.join(quarantineRoot, path.basename(record, ".json"));
		if (obstacle === "a destination holding something else") {
			await Bun.write(path.join(destination, "unrelated"), "UNRELATED");
		} else {
			await fs.mkdir(quarantineRoot, { recursive: true });
			await fs.chmod(quarantineRoot, 0o500);
		}
		try {
			const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
			const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

			expect(applied.quarantine?.moved).toBe(false);
			expect(applied.quarantine?.errors.length).toBeGreaterThan(0);
			expect(preview.quarantine?.errors.length).toBeGreaterThan(0);
			expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
		} finally {
			await fs.chmod(quarantineRoot, 0o700).catch(() => undefined);
		}
	});
}

test("the restore's advice names the quarantine, which moves the stage outside both trees when the agent directory resolves into a session tree", async () => {
	const base = path.join(root, "nest");
	const agentDir = path.join(base, "agent");
	await fs.mkdir(path.join(agentDir, "archive", "sessions", "x"), { recursive: true });
	await fs.symlink(base, path.join(agentDir, "sessions"));
	const ground = await mintStagingGround(
		path.join(agentDir, "archive", "sessions", "x", "b.log"),
		stagingLedgerDir(agentDir),
	);
	await ground.handle.writeFile("PARTIAL STAGE");
	await ground.handle.close();
	const record = path.basename(ground.record);

	const advice = stagingResidueNote(ground.dir, ground.record, ARCHIVED_RESIDUE);
	expect(advice).toContain(`omp gc --quarantine ${record} --apply --agent-dir ${agentDir}`);
	const moved = await runGcCommand({ flags: { agentDir, quarantine: record, apply: true, json: true } });

	expect(moved.quarantine?.errors).toEqual([]);
	expect(moved.quarantine?.moved).toBe(true);
	const quarantine = moved.quarantine?.quarantine ?? "";
	expect(await Bun.file(path.join(quarantine, path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");
	// Where it landed, by real path: outside both trees, the nested one included.
	const landed = await fs.realpath(quarantine);
	for (const tree of [path.join(agentDir, "sessions"), path.join(agentDir, "archive", "sessions")]) {
		const real = await fs.realpath(tree);
		expect(landed === real || landed.startsWith(`${real}${path.sep}`)).toBe(false);
	}
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
	await ground.handle.close();
	return { ground, liveArtifacts };
}

test("a killed restore's recorded stage in the live tree makes the restore say so, with the recovery, in its preview as in applying", async () => {
	const { ground, liveArtifacts } = await restoredWithKilledLiveStage();

	const preview = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });
	const retried = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });

	for (const run of [preview, retried]) {
		const told = run.restore?.errors.join("\n") ?? "";
		expect(told).toContain(ground.dir);
		expect(told).toContain(`--quarantine ${path.basename(ground.record)} --apply`);
	}
	expect(retried.restore?.errors.join("\n")).not.toContain("could not restore");
	expect(await Bun.file(restoreRecordPath(archiveFile)).exists()).toBe(true);

	// The step the advice gives.
	const moved = await runGcCommand({
		flags: { agentDir: root, quarantine: path.basename(ground.record), apply: true, json: true },
	});
	expect(moved.quarantine?.errors).toEqual([]);
	expect(moved.quarantine?.moved).toBe(true);
	const finished = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	expect(finished.restore?.errors).toEqual([]);
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
	expect(reclaimed.reclaim?.errors.join("\n")).toContain(`--quarantine ${path.basename(ground.record)} --apply`);
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(ground.record).exists()).toBe(true);
	expect(restored.restore?.errors.join("\n")).toContain(ground.dir);
	expect((await fs.readdir(liveArtifacts)).sort()).toEqual(["a.log", path.basename(ground.dir)].sort());
});

for (const occupant of [
	"a symlink to somebody's file",
	"a FIFO",
	"a directory",
	"a file of somebody's notes",
	"a read-only file of somebody's notes",
] as const) {
	test(`a restore refuses ${occupant} at its record's name, in its preview as in applying, and writes nothing through it`, async () => {
		const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
		await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
		await archiveEverything();
		const record = restoreRecordPath(archiveFile);
		const precious = path.join(root, "precious");
		await Bun.write(precious, "ONLY COPY OF IRREPLACEABLE USER DATA");
		if (occupant === "a symlink to somebody's file") await fs.symlink(precious, record);
		else if (occupant === "a FIFO") expect(await Bun.spawn(["mkfifo", record]).exited).toBe(0);
		else if (occupant === "a directory") await fs.mkdir(record);
		else {
			// The name being a restore record's says nothing about what holds it.
			await fs.link(precious, record);
			if (occupant === "a read-only file of somebody's notes") await fs.chmod(record, 0o400);
		}
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

	expect(restored.restore?.errors.join("\n")).toContain(`${ground.record} could not be read`);
	expect(await fs.stat(path.join(liveArtifacts, path.basename(ground.dir))).catch(() => undefined)).toBeUndefined();
});
for (const shape of [
	"a file identity without a directory identity",
	"a directory identity without a file identity",
] as const) {
	test(`quarantine refuses a record with ${shape}, which no gc run writes`, async () => {
		const { ground, record } = await archivedWithKilledStage();
		const identity = { dev: -1, ino: -2 };
		const forged =
			shape === "a file identity without a directory identity"
				? { dir: ground.dir, file: ground.file, identity }
				: { dir: ground.dir, file: ground.file, dirIdentity: identity };
		await Bun.write(ground.record, JSON.stringify(forged));

		const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

		expect(applied.quarantine?.moved).toBe(false);
		expect(applied.quarantine?.errors.join("\n")).toContain("could not be read");
		expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
	});
}

/** Where `gc --quarantine` puts a record and its stage: beside the archived tree, named for the record. */
function quarantineDestination(record: string): string {
	return path.join(root, "archive", "gc-quarantine", path.basename(record, ".json"));
}

// The review's occupied-destination fixtures: something at the very name the
// record takes in its quarantine, which no quarantine of this record put
// there. The name being the expected one says nothing about whose it is.
const occupants: [string, (at: string, fixture: { wanted: string; record: string }) => Promise<unknown>][] = [
	["a file of somebody's notes", async at => await Bun.write(at, "ONLY COPY OF UNRELATED QUARANTINE NOTES")],
	["a symlink", async (at, { wanted }) => await fs.symlink(wanted, at)],
	["a FIFO", async at => expect(await Bun.spawn(["mkfifo", at]).exited).toBe(0)],
	["a directory", async at => await Bun.write(path.join(at, "wanted"), "UNRELATED UNIQUE DATA")],
	[
		"the start of the record that another name holds as well",
		async (at, { record }) => {
			await fs.writeFile(at, (await Bun.file(record).bytes()).subarray(0, 10), { mode: 0o600 });
			await fs.link(at, path.join(root, "also-wanted"));
		},
	],
];
for (const [shape, occupy] of occupants) {
	test(`quarantine refuses, in its preview as in applying, when ${shape} has the record's name in the destination`, async () => {
		const { ground, record } = await archivedWithKilledStage();
		const destination = quarantineDestination(record);
		await fs.mkdir(destination, { recursive: true, mode: 0o700 });
		const wanted = path.join(root, "wanted");
		await Bun.write(wanted, "UNRELATED UNIQUE DATA");
		const occupant = path.join(destination, record);
		await occupy(occupant, { wanted, record: ground.record });
		const before = await fs.lstat(occupant);
		const held = before.isFile() ? await Bun.file(occupant).bytes() : undefined;

		const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
		const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

		expect(preview.quarantine?.errors.join("\n")).toContain(occupant);
		expect(applied.quarantine?.errors.join("\n")).toContain(occupant);
		expect(applied.quarantine?.moved).toBe(false);
		// Refused before anything moved: the stage and its record are where
		// the killed run left them.
		expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
		expect(await Bun.file(ground.record).exists()).toBe(true);
		expect(await fs.readdir(destination)).toEqual([record]);
		// And whatever had the name still has it, as it was.
		const after = await fs.lstat(occupant);
		expect([after.ino, after.mode, after.nlink]).toEqual([before.ino, before.mode, before.nlink]);
		if (held) expect(await Bun.file(occupant).bytes()).toEqual(held);
		if (shape === "a directory")
			expect(await Bun.file(path.join(occupant, "wanted")).text()).toBe("UNRELATED UNIQUE DATA");
		expect(await Bun.file(wanted).text()).toBe("UNRELATED UNIQUE DATA");
	});
}

test("a quarantine whose record is gone does not report it moved, whatever its destination holds", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	await Bun.write(path.join(destination, record), "ONLY COPY OF UNRELATED QUARANTINE NOTES");
	await fs.unlink(ground.record);

	const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	expect(applied.quarantine?.moved).toBe(false);
	expect(applied.quarantine?.errors.length).toBeGreaterThan(0);
	expect(await Bun.file(path.join(destination, record)).text()).toBe("ONLY COPY OF UNRELATED QUARANTINE NOTES");
});

test("quarantine refuses a ledger record that is a symlink, which no gc run writes", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const elsewhere = path.join(root, "record-elsewhere.json");
	await fs.rename(ground.record, elsewhere);
	await fs.symlink(elsewhere, ground.record);

	const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
	const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	expect(preview.quarantine?.errors.join("\n")).toContain("not a regular file");
	expect(applied.quarantine?.errors.join("\n")).toContain("not a regular file");
	expect(applied.quarantine?.moved).toBe(false);
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
	expect((await fs.lstat(ground.record)).isSymbolicLink()).toBe(true);
	expect(await fs.stat(quarantineDestination(record)).catch(() => undefined)).toBeUndefined();
});

test("a quarantine retry that finds no record anywhere says where the directory in its destination is and what to do with it", async () => {
	const { ground, record, liveArtifacts } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	const stranded = path.join(destination, path.basename(ground.dir));
	// The directory in the destination with no copy of the record beside it,
	// which this command never leaves itself, then an archive run, which
	// drops a record whose directory has left its tree.
	await fs.mkdir(destination, { recursive: true, mode: 0o700 });
	await fs.rename(ground.dir, stranded);
	await archiveOnly();
	expect(await Bun.file(ground.record).exists()).toBe(false);

	const retried = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	const told = retried.quarantine?.errors.join("\n") ?? "";
	expect(told).toContain(stranded);
	expect(told).toContain("copy out anything you want to keep");
	expect(retried.quarantine?.moved).toBe(false);
	expect(retried.quarantine?.quarantine).toBe(destination);
	expect(await Bun.file(path.join(stranded, "b.log")).text()).toBe("PARTIAL STAGE");
	const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	expect(restored.restore?.errors).toEqual([]);
	expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
});

/**
 * The ledger on one filesystem and the quarantine on another, as the review
 * measured them: the record cannot go across by name, by `rename` or by
 * `link`, and has to be copied.
 */
function recordAcrossFilesystems(record: string): { restore(): void } {
	const spies = (["rename", "link"] as const).map(name => {
		const real = fs[name];
		return spyOn(fs, name).mockImplementation(async (from, to) => {
			if (String(from) === record && String(to).includes(`${path.sep}gc-quarantine${path.sep}`)) {
				throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
			}
			return await real(from, to);
		});
	});
	return {
		restore() {
			for (const spy of spies) spy.mockRestore();
		},
	};
}

for (const filesystems of ["across filesystems", "on one filesystem"] as const) {
	test(`a quarantine ${filesystems} killed once its record is in the destination finishes when run again`, async () => {
		const { ground, record, liveArtifacts } = await archivedWithKilledStage();
		const original = await Bun.file(ground.record).bytes();
		const destination = quarantineDestination(record);
		const across = filesystems === "across filesystems" ? recordAcrossFilesystems(ground.record) : undefined;
		try {
			// The review's kill point: the record is whole in the destination
			// and its ledger entry not yet removed.
			const realUnlink = fs.unlink;
			let killed = false;
			const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
				if (!killed && String(target) === ground.record) {
					killed = true;
					throw Object.assign(new Error("killed before the ledger entry went"), { code: "EINTR" });
				}
				return await realUnlink(target);
			});
			let first: GcResult;
			try {
				first = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
			} finally {
				unlink.mockRestore();
			}
			expect(killed).toBe(true);
			expect(first.quarantine?.moved).toBe(false);
			expect(await Bun.file(path.join(destination, record)).bytes()).toEqual(original);
			expect(await Bun.file(ground.record).bytes()).toEqual(original);

			const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
			const retried = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
			const repeated = await runGcCommand({
				flags: { agentDir: root, quarantine: record, apply: true, json: true },
			});

			expect(preview.quarantine?.errors).toEqual([]);
			expect(retried.quarantine?.errors).toEqual([]);
			expect(retried.quarantine?.moved).toBe(true);
			// Run again once finished, it finds no ledger record and refuses
			// rather than take what the destination holds for a finished move.
			expect(repeated.quarantine?.moved).toBe(false);
			expect(repeated.quarantine?.errors.join("\n")).toContain("does not report a quarantine of it finished");
		} finally {
			across?.restore();
		}
		expect(await Bun.file(path.join(destination, record)).bytes()).toEqual(original);
		expect(await Bun.file(ground.record).exists()).toBe(false);
		expect(await Bun.file(path.join(destination, path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");
		const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
		expect(restored.restore?.errors).toEqual([]);
		expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
	});
}

for (const written of ["nothing", "half"] as const) {
	for (const stage of ["still in its tree", "already in the destination"] as const) {
		test(`a quarantine across filesystems stopped with ${written} of its record copied and the stage ${stage} finishes when run again`, async () => {
			const { ground, record, liveArtifacts } = await archivedWithKilledStage();
			const original = await Bun.file(ground.record).bytes();
			const destination = quarantineDestination(record);
			// What a kill inside the copy leaves: the copy created and part
			// written, with the stage not yet moved, since the record goes
			// first; and the same with the stage moved, however it got there.
			await fs.mkdir(destination, { recursive: true, mode: 0o700 });
			if (stage === "already in the destination") {
				await fs.rename(ground.dir, path.join(destination, path.basename(ground.dir)));
			}
			const copied = written === "nothing" ? 0 : Math.floor(original.length / 2);
			await fs.writeFile(path.join(destination, record), original.subarray(0, copied), { mode: 0o600 });
			const before = await fs.stat(path.join(destination, record));

			const across = recordAcrossFilesystems(ground.record);
			let preview: GcResult;
			let retried: GcResult;
			let repeated: GcResult;
			try {
				preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
				retried = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
				repeated = await runGcCommand({
					flags: { agentDir: root, quarantine: record, apply: true, json: true },
				});
			} finally {
				across.restore();
			}

			expect(preview.quarantine?.errors).toEqual([]);
			expect(retried.quarantine?.errors).toEqual([]);
			expect(retried.quarantine?.moved).toBe(true);
			expect(repeated.quarantine?.moved).toBe(false);
			// Finished in the file the copy began, not in one put over it.
			expect((await fs.stat(path.join(destination, record))).ino).toBe(before.ino);
			expect(await Bun.file(path.join(destination, record)).bytes()).toEqual(original);
			expect(await Bun.file(ground.record).exists()).toBe(false);
			expect(await Bun.file(path.join(destination, path.basename(ground.dir), "b.log")).text()).toBe(
				"PARTIAL STAGE",
			);
			const restored = await runGcCommand({
				flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true },
			});
			expect(restored.restore?.errors).toEqual([]);
			expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
		});
	}
}

test.skipIf(process.getuid?.() === 0)(
	"quarantine refuses, in its preview as in applying, a part copy of the record it cannot write to finish",
	async () => {
		const { ground, record } = await archivedWithKilledStage();
		const original = await Bun.file(ground.record).bytes();
		const destination = quarantineDestination(record);
		await fs.mkdir(destination, { recursive: true, mode: 0o700 });
		// The review's fixture: the record's first byte, under no other name,
		// at mode 0400.
		const partial = path.join(destination, record);
		await fs.writeFile(partial, original.subarray(0, 1), { mode: 0o400 });
		const before = await fs.stat(partial);

		const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
		const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

		expect(preview.quarantine?.errors.join("\n")).toContain(partial);
		expect(applied.quarantine?.errors.join("\n")).toContain(partial);
		expect(applied.quarantine?.moved).toBe(false);
		// Refused before the stage moved.
		expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
		expect(await Bun.file(ground.record).bytes()).toEqual(original);
		const after = await fs.stat(partial);
		expect([after.ino, after.mode, after.size]).toEqual([before.ino, before.mode, before.size]);
	},
);

/**
 * Stop the record's way into the destination where the review killed it: before
 * the record is linked or copied, with its copy created and empty, or halfway
 * through writing the copy. Each stop throws, so the run ends there as a kill
 * would, with the steps after it not taken.
 */
function stopRecordCopy(at: "before" | "created" | "half", recordInto: string): { restore(): void } {
	const realOpen = fs.open;
	const stop = () => Object.assign(new Error("stopped as a kill would"), { code: "EINTR" });
	const open = spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
		if (String(target) !== recordInto || rest[0] !== "wx") {
			return await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
		}
		if (at === "before") throw stop();
		const handle = await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
		handle.writeFile = (async (data: Uint8Array) => {
			if (at === "half") await handle.write(data, 0, Math.floor(data.length / 2), 0);
			throw stop();
		}) as typeof handle.writeFile;
		return handle;
	}) as typeof fs.open);
	return { restore: () => open.mockRestore() };
}

for (const at of ["before", "created", "half"] as const) {
	test(`a quarantine across filesystems stopped ${at === "before" ? "before its record is copied" : at === "created" ? "with its record copy created and empty" : "halfway through copying its record"}, then an archive run, finishes when run again`, async () => {
		const { ground, record, liveArtifacts } = await archivedWithKilledStage();
		const original = await Bun.file(ground.record).bytes();
		const destination = quarantineDestination(record);
		const across = recordAcrossFilesystems(ground.record);
		try {
			const stopped = stopRecordCopy(at, path.join(destination, record));
			let first: GcResult;
			try {
				first = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
			} finally {
				stopped.restore();
			}
			expect(first.quarantine?.moved).toBe(false);
			// An ordinary archive run between the stop and the retry: it drops
			// a record whose directory has left its tree.
			await archiveOnly();

			const retried = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

			expect(retried.quarantine?.errors).toEqual([]);
			expect(retried.quarantine?.moved).toBe(true);
			expect(retried.quarantine?.quarantine).toBe(destination);
		} finally {
			across.restore();
		}
		expect(await Bun.file(path.join(destination, record)).bytes()).toEqual(original);
		expect(await Bun.file(ground.record).exists()).toBe(false);
		expect(await Bun.file(path.join(destination, path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");
		const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
		expect(restored.restore?.errors).toEqual([]);
		expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
	});
}

/**
 * Run a quarantine that stops, as a kill would, at the step this names: once
 * the record is whole in the destination and before the directory moves,
 * once the directory has moved and before the ledger entry goes, or at the
 * removal of the ledger entry itself.
 */
async function quarantineStopped(
	ground: StagingGround,
	record: string,
	at: "before the directory moves" | "after the directory moves" | "before the ledger entry goes",
): Promise<void> {
	const stop = () => Object.assign(new Error("stopped as a kill would"), { code: "EINTR" });
	const realRename = fs.rename;
	const realUnlink = fs.unlink;
	const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (String(from) !== ground.dir) return await realRename(from, to);
		if (at === "before the directory moves") throw stop();
		await realRename(from, to);
		if (at === "after the directory moves") throw stop();
	});
	const unlink = spyOn(fs, "unlink").mockImplementation(async target => {
		if (at === "before the ledger entry goes" && String(target) === ground.record) throw stop();
		return await realUnlink(target);
	});
	try {
		await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	} finally {
		rename.mockRestore();
		unlink.mockRestore();
	}
}

test("a quarantine stopped before its directory moved, whose ledger record was then removed by hand, says the directory is still in its tree", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	await quarantineStopped(ground, record, "before the directory moves");
	await fs.unlink(ground.record);

	const retried = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	expect(retried.quarantine?.moved).toBe(false);
	const told = retried.quarantine?.errors.join("\n") ?? "";
	expect(told).toContain(ground.dir);
	expect(told).toContain(path.join(destination, record));
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
});

// The review's false-success fixtures: a whole copy of the record in the
// destination, the ledger record removed by hand, and the recorded directory
// not in the destination. A copy says the record arrived, not the directory.
const unarrived: [string, (dir: string) => Promise<() => Promise<void>>][] = [
	[
		"the tree it stood in cannot be read",
		async dir => {
			const parent = path.dirname(dir);
			const mode = (await fs.stat(parent)).mode & 0o7777;
			await fs.chmod(parent, 0);
			return async () => await fs.chmod(parent, mode);
		},
	],
	[
		"it was removed",
		async dir => {
			await fs.rm(dir, { recursive: true });
			return async () => {};
		},
	],
	[
		"another directory stands at its name",
		async dir => {
			await fs.rename(dir, path.join(root, "original-outside"));
			await Bun.write(path.join(dir, "work"), "FOREIGN REBOUND STAGE");
			return async () => {};
		},
	],
];
for (const [shape, arrange] of unarrived) {
	test.skipIf(shape === "the tree it stood in cannot be read" && process.getuid?.() === 0)(
		`a quarantine retry with no ledger record does not report done when the directory is not in the destination and ${shape}`,
		async () => {
			const { ground, record } = await archivedWithKilledStage();
			const destination = quarantineDestination(record);
			await quarantineStopped(ground, record, "before the directory moves");
			await fs.unlink(ground.record);
			const undo = await arrange(ground.dir);
			let preview: GcResult;
			let applied: GcResult;
			try {
				preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
				applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
			} finally {
				await undo();
			}

			for (const run of [preview, applied]) {
				expect(run.quarantine?.moved).toBe(false);
				expect(run.quarantine?.errors.join("\n")).toContain(ground.dir);
			}
			expect(
				await fs.lstat(path.join(destination, path.basename(ground.dir))).catch(() => undefined),
			).toBeUndefined();
			if (shape === "the tree it stood in cannot be read") {
				expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
			}
		},
	);
}

test("a quarantine retry with no whole record anywhere names every place a quarantine of it uses", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	await quarantineStopped(ground, record, "before the ledger entry goes");
	// The review's fixture: the ledger record and its copy removed by hand,
	// and something else in the other place a quarantine of this id uses.
	await fs.unlink(ground.record);
	await fs.unlink(path.join(destination, record));
	const other = path.join(root, "gc-quarantine", path.basename(record, ".json"), "other");
	await Bun.write(other, "OTHER STRANDED CONTENT");

	const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
	const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	for (const run of [preview, applied]) {
		expect(run.quarantine?.moved).toBe(false);
		const told = run.quarantine?.errors.join("\n") ?? "";
		expect(told).toContain(other);
		expect(told).toContain(path.join(destination, path.basename(ground.dir)));
	}
	expect(await Bun.file(path.join(destination, path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(other).text()).toBe("OTHER STRANDED CONTENT");
});

for (const kept of ["its first byte", "half of it"] as const) {
	test(`a quarantine retry with no ledger record and ${kept} copied warns that the directory left in its tree comes home with a restore`, async () => {
		const { ground, record } = await archivedWithKilledStage();
		const original = await Bun.file(ground.record).bytes();
		const destination = quarantineDestination(record);
		// The review's fixture: the stage still in its tree, a part copy of
		// the record in the destination, and the ledger record removed by hand.
		await quarantineStopped(ground, record, "before the directory moves");
		const length = kept === "its first byte" ? 1 : Math.floor(original.length / 2);
		await fs.writeFile(path.join(destination, record), original.subarray(0, length), { mode: 0o600 });
		await fs.unlink(ground.record);

		const retried = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

		expect(retried.quarantine?.moved).toBe(false);
		const told = retried.quarantine?.errors.join("\n") ?? "";
		expect(told).toContain(path.join(destination, record));
		expect(told).toContain("carries it home");
		// Half the record holds the directory's name, so that one is named.
		if (kept === "half of it") expect(told).toContain(ground.dir);
		expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
	});
}

test("a repeated quarantine that moved only its record refuses without a ledger record, and the copy back finishes it again", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	const copy = path.join(destination, record);
	// The directory gone before the quarantine: it moves only the record.
	await fs.rename(ground.dir, path.join(root, "gone-before"));
	const first = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	expect(first.quarantine?.errors).toEqual([]);
	expect(first.quarantine?.moved).toBe(true);
	expect(await fs.readdir(destination)).toEqual([record]);

	const repeated = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	// Nothing on disk says the first run finished, so the repeat does not
	// claim it; it names what is there and the step that settles it.
	expect(repeated.quarantine?.moved).toBe(false);
	const told = repeated.quarantine?.errors.join("\n") ?? "";
	expect(told).toContain("does not report a quarantine of it finished");
	expect(told).toContain(`copy ${copy} back to ${ground.record}`);
	expect(repeated.quarantine?.quarantine).toBe(destination);

	await fs.copyFile(copy, ground.record);
	const settled = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	expect(settled.quarantine?.errors).toEqual([]);
	expect(settled.quarantine?.moved).toBe(true);
	expect(await Bun.file(ground.record).exists()).toBe(false);
});

// The review's false-arrival fixtures, each standing before the retry starts:
// a whole copy of the record in the destination and the ledger record gone,
// with something beside the copy that matches the directory's identity
// without being the directory that moved.
test("a quarantine retry does not take a directory that reuses the recorded inode for the one that moved", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	await quarantineStopped(ground, record, "before the directory moves");
	await fs.unlink(ground.record);
	await fs.rm(ground.dir, { recursive: true });
	const replacement = path.join(destination, path.basename(ground.dir));
	await Bun.write(path.join(replacement, "foreign"), "UNRELATED DATA");
	// The review saw ext4 give the freed directory inode to the first new
	// directory. That reuse cannot be waited for here, so the copy is made
	// to name the replacement's inode, which is the state it leaves.
	const made = await fs.stat(replacement);
	const copy = path.join(destination, record);
	const entry = JSON.parse(await Bun.file(copy).text());
	await fs.writeFile(copy, JSON.stringify({ ...entry, dirIdentity: { dev: made.dev, ino: made.ino } }));

	const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
	const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	for (const run of [preview, applied]) {
		expect(run.quarantine?.moved).toBe(false);
		const told = run.quarantine?.errors.join("\n") ?? "";
		expect(told).toContain(replacement);
		expect(told).toContain("carries it home");
	}
	expect(await Bun.file(path.join(replacement, "foreign")).text()).toBe("UNRELATED DATA");
});

test("a quarantine retry does not take a directory and file that reuse both recorded inodes for the ones that moved", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	await quarantineStopped(ground, record, "before the directory moves");
	await fs.unlink(ground.record);
	await fs.rm(ground.dir, { recursive: true });
	// The review's ext4 run gave the replacement directory and the file made
	// at the staged file's name both freed inodes on their first creation.
	// That reuse cannot be waited for here, so the copy is made to name the
	// replacements' inodes, which is the state it leaves.
	const replacement = path.join(destination, path.basename(ground.dir));
	const unrelated = path.join(replacement, path.basename(ground.file));
	await Bun.write(unrelated, "UNRELATED DATA");
	const [dir, file] = await Promise.all([fs.stat(replacement), fs.stat(unrelated)]);
	const copy = path.join(destination, record);
	const entry = JSON.parse(await Bun.file(copy).text());
	await fs.writeFile(
		copy,
		JSON.stringify({
			...entry,
			dirIdentity: { dev: dir.dev, ino: dir.ino },
			identity: { dev: file.dev, ino: file.ino },
		}),
	);

	const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
	const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	for (const run of [preview, applied]) {
		expect(run.quarantine?.moved).toBe(false);
		const told = run.quarantine?.errors.join("\n") ?? "";
		expect(told).toContain("does not report a quarantine of it finished");
		expect(told).toContain("carries it home");
	}
	expect(await Bun.file(unrelated).text()).toBe("UNRELATED DATA");
});

test("a quarantine retry does not take an alias of a directory moved elsewhere in its tree for the one that moved", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	const stageAt = path.join(destination, path.basename(ground.dir));
	await quarantineStopped(ground, record, "before the directory moves");
	await fs.unlink(ground.record);
	// The review's fixture: the stage moved beside its old name, still in the
	// archived tree, and bound at its destination name. A bind mount needs
	// privileges a test does not take, so a look at that name is answered
	// from the moved directory, as the mount answers it.
	const relocated = path.join(path.dirname(ground.dir), "relocated-stage");
	await fs.rename(ground.dir, relocated);
	const realLstat = fs.lstat;
	const alias = spyOn(fs, "lstat").mockImplementation((async (target: string, ...rest: unknown[]) => {
		const at = String(target);
		const seen = at === stageAt || at.startsWith(`${stageAt}${path.sep}`) ? relocated + at.slice(stageAt.length) : at;
		return await (realLstat as (...args: unknown[]) => Promise<Stats>)(seen, ...rest);
	}) as typeof fs.lstat);
	let preview: GcResult;
	let applied: GcResult;
	try {
		preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
		applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	} finally {
		alias.mockRestore();
	}

	for (const run of [preview, applied]) {
		expect(run.quarantine?.moved).toBe(false);
		const told = run.quarantine?.errors.join("\n") ?? "";
		expect(told).toContain("does not report a quarantine of it finished");
		expect(told).toContain("carries it home");
	}
	expect(await Bun.file(path.join(relocated, path.basename(ground.file))).text()).toBe("PARTIAL STAGE");
});

test("a quarantine stopped right after it moved an emptied stage, then an archive run, is refused without blaming anyone else, and finishes once its record is put back", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	const copy = path.join(destination, record);
	const stageAt = path.join(destination, path.basename(ground.dir));
	// The review's sequence, nothing removed by hand: an archive run killed
	// once its cleanup had removed the staged file and before it removed the
	// directory, an ordinary archive run, a quarantine stopped right after
	// it moved the directory, and another ordinary archive run, which drops
	// the ledger entry of a directory that has left its tree.
	await fs.unlink(ground.file);
	await archiveOnly();
	expect(await Bun.file(ground.record).exists()).toBe(true);
	await quarantineStopped(ground, record, "after the directory moves");
	await archiveOnly();
	expect(await Bun.file(ground.record).exists()).toBe(false);

	const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
	const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	for (const run of [preview, applied]) {
		expect(run.quarantine?.moved).toBe(false);
		const told = run.quarantine?.errors.join("\n") ?? "";
		expect(told).toContain("does not report a quarantine of it finished");
		expect(told).toContain("stopped once its directory had left");
		expect(told).toContain(`copy ${copy} back to ${ground.record}`);
		expect(told).toContain(stageAt);
		expect(told).not.toContain("something other than gc");
	}

	// The step the refusal gives.
	await fs.copyFile(copy, ground.record);
	await fs.chmod(ground.record, 0o600);
	const finished = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	expect(finished.quarantine?.errors).toEqual([]);
	expect(finished.quarantine?.moved).toBe(true);
	expect((await fs.stat(stageAt)).isDirectory()).toBe(true);
	expect(await Bun.file(ground.record).exists()).toBe(false);
	const repeated = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	expect(repeated.quarantine?.moved).toBe(false);
});

test("a quarantine stopped before its ledger entry went, then an archive run, is refused, and finishes once its record is put back", async () => {
	const { ground, record, liveArtifacts } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	const copy = path.join(destination, record);
	await quarantineStopped(ground, record, "before the ledger entry goes");
	await archiveOnly();
	expect(await Bun.file(ground.record).exists()).toBe(false);

	const retried = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	expect(retried.quarantine?.moved).toBe(false);
	expect(retried.quarantine?.errors.join("\n")).toContain(`copy ${copy} back to ${ground.record}`);
	await fs.copyFile(copy, ground.record);
	const finished = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	expect(finished.quarantine?.errors).toEqual([]);
	expect(finished.quarantine?.moved).toBe(true);
	expect(await Bun.file(path.join(destination, path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");
	const restored = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, apply: true, json: true } });
	expect(restored.restore?.errors).toEqual([]);
	expect(await fs.readdir(liveArtifacts)).toEqual(["a.log"]);
});

test("a finished quarantine whose destination was later moved into a session tree is not reported finished", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	const finished = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	expect(finished.quarantine?.moved).toBe(true);
	// The review's fixture: the whole destination moved under the archived
	// session's artifact tree, and its old name a link to it.
	const inside = path.join(archiveFile.slice(0, -".jsonl.gz".length), "moved-quarantine");
	await fs.rename(destination, inside);
	await fs.symlink(inside, destination);

	const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
	const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	for (const run of [preview, applied]) {
		expect(run.quarantine?.moved).toBe(false);
		const told = run.quarantine?.errors.join("\n") ?? "";
		expect(told).toContain("inside a session tree");
		expect(told).toContain("carries it home");
	}
	expect(await Bun.file(path.join(inside, path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");
});

test("a finished quarantine whose directory was replaced afterwards is not reported finished", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	const stageAt = path.join(destination, path.basename(ground.dir));
	const finished = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	expect(finished.quarantine?.moved).toBe(true);
	// Another directory at the stage's name, made while the moved one still
	// exists, so it cannot be given the moved one's inode.
	await fs.rename(stageAt, path.join(root, "moved-stage-elsewhere"));
	await fs.mkdir(stageAt);

	const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	expect(applied.quarantine?.moved).toBe(false);
	expect(applied.quarantine?.errors.join("\n")).toContain("does not report a quarantine of it finished");
});

test("a record-only quarantine stopped before its ledger entry went, then an archive run, is refused, and finishes once its record is put back", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	const copy = path.join(destination, record);
	// The directory already gone, so the quarantine moves only the record,
	// and it is stopped as it removes the ledger entry; an archive run then
	// drops that entry, since its directory is not in its tree.
	await fs.rename(ground.dir, path.join(root, "gone-before"));
	await quarantineStopped(ground, record, "before the ledger entry goes");
	await archiveOnly();
	expect(await Bun.file(ground.record).exists()).toBe(false);

	const retried = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	expect(retried.quarantine?.moved).toBe(false);
	const told = retried.quarantine?.errors.join("\n") ?? "";
	expect(told).toContain("stopped once its directory had left");
	expect(told).toContain(`copy ${copy} back to ${ground.record}`);

	await fs.copyFile(copy, ground.record);
	const finished = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	const repeated = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	expect(finished.quarantine?.errors).toEqual([]);
	expect(finished.quarantine?.moved).toBe(true);
	expect(repeated.quarantine?.moved).toBe(false);
});

test("a quarantine retry whose destination resolves into the session tree it came from is refused", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	await quarantineStopped(ground, record, "before the directory moves");
	await fs.unlink(ground.record);
	// The record's copy beside the stage it names, and the destination a
	// link to that place: the stage is "beside the copy" without moving.
	const parent = path.dirname(ground.dir);
	await fs.rename(path.join(destination, record), path.join(parent, record));
	await fs.rmdir(destination);
	await fs.symlink(parent, destination);

	const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
	const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	for (const run of [preview, applied]) {
		expect(run.quarantine?.moved).toBe(false);
		const told = run.quarantine?.errors.join("\n") ?? "";
		expect(told).toContain("inside a session tree");
		expect(told).toContain("carries it home");
	}
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
});

test("a quarantine retry does not take an alias of the directory still in its tree for the one that moved", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	const stageAt = path.join(destination, path.basename(ground.dir));
	await quarantineStopped(ground, record, "before the directory moves");
	await fs.unlink(ground.record);
	// What a bind mount of the stage at its destination name shows a
	// look at that name: the very directory still in its tree, by device
	// and inode. Mounting needs privileges a test does not take.
	const realLstat = fs.lstat;
	const alias = spyOn(fs, "lstat").mockImplementation(
		(async (target: string, ...rest: unknown[]) =>
			await (realLstat as (...args: unknown[]) => Promise<Stats>)(
				String(target) === stageAt ? ground.dir : target,
				...rest,
			)) as typeof fs.lstat,
	);
	let applied: GcResult;
	try {
		applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	} finally {
		alias.mockRestore();
	}

	expect(applied.quarantine?.moved).toBe(false);
	const told = applied.quarantine?.errors.join("\n") ?? "";
	expect(told).toContain(ground.dir);
	expect(told).toContain("carries it home");
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
});

test("a quarantine retry with no ledger record and nothing in any destination still warns about the directory left in its tree", async () => {
	const { ground, record } = await archivedWithKilledStage();
	// The review's fixture: a quarantine killed before its record was linked,
	// leaving an empty destination, and the ledger record then removed.
	await fs.mkdir(quarantineDestination(record), { recursive: true, mode: 0o700 });
	await fs.unlink(ground.record);

	const preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
	const applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });

	for (const run of [preview, applied]) {
		expect(run.quarantine?.moved).toBe(false);
		const told = run.quarantine?.errors.join("\n") ?? "";
		expect(told).toContain("carries it home");
		expect(told).toContain("session trees");
	}
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
});

// The review's unsearchable-ledger sequence: a quarantine stopped once its
// record was copied and before its directory moved, then a ledger this user
// cannot search. The record is still in it, so a copy back would land on it.
test.skipIf(process.getuid?.() === 0)(
	"a quarantine retry that cannot look in the ledger says so, in its preview as in applying, and gives no copy-back step",
	async () => {
		const { ground, record } = await archivedWithKilledStage();
		const destination = quarantineDestination(record);
		await quarantineStopped(ground, record, "before the directory moves");
		const ledger = stagingLedgerDir(root);
		await fs.chmod(ledger, 0);
		let preview: GcResult;
		let applied: GcResult;
		try {
			preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
			applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
		} finally {
			await fs.chmod(ledger, 0o700);
		}

		for (const run of [preview, applied]) {
			expect(run.quarantine?.moved).toBe(false);
			const told = run.quarantine?.errors.join("\n") ?? "";
			expect(told).toContain(`${ground.record} could not be checked`);
			expect(told).toContain("EACCES");
			expect(told).not.toContain(`is not in ${ledger}`);
			expect(told).not.toContain(`back to ${ground.record}`);
		}
		// The record was there all along: once the ledger can be searched, the
		// same command finishes the quarantine.
		const finished = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
		expect(finished.quarantine?.errors).toEqual([]);
		expect(finished.quarantine?.moved).toBe(true);
		expect(await Bun.file(path.join(destination, path.basename(ground.dir), "b.log")).text()).toBe("PARTIAL STAGE");
	},
);

// A whole copy of the record in the destination, the ledger record gone, and
// the copy kept from this user: it is there, and what it holds is unknown.
const unreadableCopies: [string, (copy: string) => Promise<() => Promise<void>>][] = [
	[
		"the copy cannot be read",
		async copy => {
			await fs.chmod(copy, 0);
			return async () => await fs.chmod(copy, 0o600);
		},
	],
	[
		"the destination cannot be searched",
		async copy => {
			await fs.chmod(path.dirname(copy), 0o400);
			return async () => await fs.chmod(path.dirname(copy), 0o700);
		},
	],
];
for (const [shape, arrange] of unreadableCopies) {
	test.skipIf(process.getuid?.() === 0)(
		`a quarantine retry with no ledger record does not say there is no copy to put back when ${shape}`,
		async () => {
			const { ground, record } = await archivedWithKilledStage();
			const copy = path.join(quarantineDestination(record), record);
			await quarantineStopped(ground, record, "before the ledger entry goes");
			await fs.unlink(ground.record);
			const undo = await arrange(copy);
			let preview: GcResult;
			let applied: GcResult;
			try {
				preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
				applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
			} finally {
				await undo();
			}

			for (const run of [preview, applied]) {
				expect(run.quarantine?.moved).toBe(false);
				const told = run.quarantine?.errors.join("\n") ?? "";
				expect(told).toContain(`${copy} could not be read`);
				expect(told).toContain("EACCES");
				expect(told).not.toContain("none to put back");
				expect(told).toContain("carries it home");
			}
			// Readable again, the copy is the step it always was.
			const told = (await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } })).quarantine;
			expect(told?.errors.join("\n")).toContain(`copy ${copy} back to ${ground.record}`);
		},
	);
}

test("a quarantine retry with no ledger record says where a place resolves could not be checked", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	await quarantineStopped(ground, record, "before the ledger entry goes");
	await fs.unlink(ground.record);
	const broken = failWithEio("realpath", destination);
	let applied: GcResult;
	try {
		applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	} finally {
		broken.mockRestore();
	}

	expect(applied.quarantine?.moved).toBe(false);
	const told = applied.quarantine?.errors.join("\n") ?? "";
	expect(told).toContain(`where ${destination} resolves could not be checked`);
	expect(told).toContain("EIO: injected");
});

test("a quarantine that cannot resolve the parent of a directory already gone refuses, and moves nothing", async () => {
	const { ground, record } = await archivedWithKilledStage();
	// The directory gone before the quarantine, so only the record would move,
	// into the quarantine beside the tree the directory's parent is in.
	await fs.rename(ground.dir, path.join(root, "gone-before"));
	const broken = failWithEio("realpath", path.dirname(ground.dir));
	let preview: GcResult;
	let applied: GcResult;
	try {
		preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
		applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	} finally {
		broken.mockRestore();
	}

	for (const run of [preview, applied]) {
		expect(run.quarantine?.moved).toBe(false);
		const told = run.quarantine?.errors.join("\n") ?? "";
		expect(told).toContain(`${path.dirname(ground.dir)} could not be resolved`);
		expect(told).toContain("EIO: injected");
	}
	expect(await Bun.file(ground.record).exists()).toBe(true);
	expect(await fs.lstat(path.join(root, "gc-quarantine")).catch(() => undefined)).toBeUndefined();
	expect(await fs.lstat(quarantineDestination(record)).catch(() => undefined)).toBeUndefined();
});

test("a quarantine that cannot check its destination refuses, and moves nothing beside what is there", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const destination = quarantineDestination(record);
	await Bun.write(path.join(destination, "unrelated"), "UNRELATED");
	const broken = failWithEio("lstat", destination);
	let preview: GcResult;
	let applied: GcResult;
	try {
		preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
		applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	} finally {
		broken.mockRestore();
	}

	for (const run of [preview, applied]) {
		expect(run.quarantine?.moved).toBe(false);
		const told = run.quarantine?.errors.join("\n") ?? "";
		expect(told).toContain(`${destination} could not be checked, so nothing was moved`);
		expect(told).toContain("EIO: injected");
	}
	expect(await fs.readdir(destination)).toEqual(["unrelated"]);
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(ground.record).exists()).toBe(true);
});

test("a quarantine that cannot resolve a session tree refuses, and moves nothing", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const broken = failWithEio("realpath", getSessionsDir(root));
	let preview: GcResult;
	let applied: GcResult;
	try {
		preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
		applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	} finally {
		broken.mockRestore();
	}

	for (const run of [preview, applied]) {
		expect(run.quarantine?.moved).toBe(false);
		const told = run.quarantine?.errors.join("\n") ?? "";
		expect(told).toContain(`${getSessionsDir(root)} could not be resolved`);
		expect(told).toContain("nothing was moved");
	}
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(ground.record).exists()).toBe(true);
	expect(await fs.lstat(quarantineDestination(record)).catch(() => undefined)).toBeUndefined();
});

test("a quarantine that cannot resolve the directory its record names refuses, and moves nothing", async () => {
	const { ground, record } = await archivedWithKilledStage();
	const broken = failWithEio("realpath", ground.dir);
	let preview: GcResult;
	let applied: GcResult;
	try {
		preview = await runGcCommand({ flags: { agentDir: root, quarantine: record, json: true } });
		applied = await runGcCommand({ flags: { agentDir: root, quarantine: record, apply: true, json: true } });
	} finally {
		broken.mockRestore();
	}

	for (const run of [preview, applied]) {
		expect(run.quarantine?.moved).toBe(false);
		const told = run.quarantine?.errors.join("\n") ?? "";
		expect(told).toContain(`${ground.dir} could not be resolved`);
		expect(told).not.toContain("outside the sessions and archive trees");
	}
	expect(await Bun.file(ground.file).text()).toBe("PARTIAL STAGE");
	expect(await Bun.file(ground.record).exists()).toBe(true);
	expect(await fs.lstat(quarantineDestination(record)).catch(() => undefined)).toBeUndefined();
});
