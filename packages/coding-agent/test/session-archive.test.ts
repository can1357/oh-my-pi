import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { type GcResult, runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { resolveSessionFileArg } from "@oh-my-pi/pi-coding-agent/cli/session-arg";
import { exportFromFile } from "@oh-my-pi/pi-coding-agent/export/html";
import {
	getArchivedSessionsDir,
	type RestoredSession,
	restoreArchivedSession,
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
import { getAgentDir, getSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

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

async function archiveEverything(): Promise<GcResult> {
	// Reading a session can touch its mtime, and gc keeps anything written
	// inside its five-minute write grace — the nested transcripts too.
	const old = new Date(Date.now() - 30 * 86_400_000);
	const bucket = path.join(getSessionsDir(root), "--work--");
	for (const entry of await fs.readdir(bucket, { recursive: true })) {
		await fs.utimes(path.join(bucket, entry), old, old).catch(() => undefined);
	}
	return runGcCommand({
		flags: {
			agentDir: root,
			forwardOnly: true,
			archive: true,
			apply: true,
			json: true,
			coldArchiveAfterDays: 0,
			retainNewestGlobal: 0,
			retainNewestPerCwd: 0,
		},
	});
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
		// One copy only: a session left in both places is archived again next run.
		expect(await Bun.file(archiveFile).exists()).toBe(false);
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
	expect(await Bun.file(archiveFile).exists()).toBe(false);
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
	// omp deletes nothing outside its own storage, and says what it left.
	expect(await Bun.file(target).exists()).toBe(true);
	expect(result.archive?.orphanedTargets).toEqual([target]);
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
	// Only a transcript that is itself a link has a target to report.
	expect(result.archive?.orphanedTargets).toEqual([]);
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
	expect(await Bun.file(archiveFile).exists()).toBe(false);
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
	expect(await Bun.file(archiveFile).exists()).toBe(false);
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
	expect(await Bun.file(archiveFile).exists()).toBe(false);
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

test("gc reclaims the temps a killed restore leaves behind, transcript or not", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	// The names `copyEntryDereferenced` publishes through, left by a kill. An
	// artifact tree is mostly not transcripts.
	const old = new Date(Date.now() - 86_400_000);
	const leftovers = [
		path.join(artifacts, ".sub.jsonl.0123456789abcdef.tmp"),
		path.join(artifacts, ".0.bash.log.0123456789abcdee.tmp"),
	];
	for (const leftover of leftovers) {
		await Bun.write(leftover, "half an artifact");
		await fs.utimes(leftover, old, old);
	}

	const result = await runGcCommand({
		flags: { agentDir: root, archive: true, apply: true, json: true, forwardOnly: true, retainNewestGlobal: 99 },
	});

	expect(result.archive?.deletedTemps).toBe(2);
	for (const leftover of leftovers) expect(await Bun.file(leftover).exists()).toBe(false);
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
	expect(await Bun.file(archiveFile).exists()).toBe(false);
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

		expect(result.archive).toMatchObject({ archived: 1, errors: [] });
		expect(result.archive?.leftoverArtifactTrees).toEqual([artifacts]);
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

	const realCopyFile = fs.copyFile;
	const copyFile = spyOn(fs, "copyFile").mockImplementation(async (source, destination, mode) => {
		if (String(source).startsWith(liveArtifacts)) {
			throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
		}
		return await realCopyFile(source, destination, mode);
	});
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		copyFile.mockRestore();
	}

	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.errors.join("\n")).toContain("ENOSPC");
	// The artifact the live tree never had is still the archive's to give back.
	expect(await Bun.file(path.join(archivedArtifacts, "only-copy.log")).text()).toBe("UNIQUE-ARCHIVED-ARTIFACT");
	// A whole directory the live tree never had survives too.
	expect(await Bun.file(path.join(archivedArtifacts, "subagent-1", "deep.log")).text()).toBe(
		"UNIQUE-ARCHIVED-SUBTREE",
	);
	// Both halves stay reachable: the transcript is live again, and the archive
	// copy beside the surviving tree is what `gc --restore` and a resume by id
	// look for.
	expect(await Bun.file(sessionFile).exists()).toBe(true);
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
	expect(await Bun.file(archiveFile).exists()).toBe(false);
	// The rename is kept: the restore matched the session, it did not undo it.
	expect(await Bun.file(sessionFile).text()).toContain("Renamed after the restore");
});

test("archiving refuses to apply until the one-way step is accepted, and changes nothing", async () => {
	const old = new Date(Date.now() - 30 * 86_400_000);
	await fs.utimes(sessionFile, old, old);

	await expect(
		runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				apply: true,
				json: true,
				coldArchiveAfterDays: 0,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
			},
		}),
	).rejects.toThrow("--forward-only");

	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await Bun.file(archiveFile).exists()).toBe(false);
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

	// `fs.cp(force)` truncates before it writes, so this must never start.
	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.errors.join("\n")).toContain("the archive is left as it is");
	expect(await Bun.file(path.join(archivedArtifacts, "tool.log")).text()).toBe("TOOL OUTPUT: KEEP USER HISTORY\n");
	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("TOOL OUTPUT: ");
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
	expect(await Bun.file(archiveFile).exists()).toBe(false);
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

test("a refused archive run does not migrate the settings it read", async () => {
	const old = new Date(Date.now() - 30 * 86_400_000);
	await fs.utimes(sessionFile, old, old);
	// A legacy agent directory: `Settings.loadIsolated` renames this on its way
	// in and writes `config.yml` beside it, so a refusal decided after that
	// load has already changed the directory it refused to touch.
	const legacy = path.join(root, "settings.json");
	await Bun.write(legacy, JSON.stringify({ gc: { archive: true } }));

	await expect(runGcCommand({ flags: { agentDir: root, archive: true, apply: true, json: true } })).rejects.toThrow(
		"--forward-only",
	);

	expect(await Bun.file(legacy).exists()).toBe(true);
	expect(await Bun.file(`${legacy}.bak`).exists()).toBe(false);
	expect(await Bun.file(path.join(root, "config.yml")).exists()).toBe(false);
	expect(await Bun.file(path.join(root, "agent.db")).exists()).toBe(false);
	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await Bun.file(archiveFile).exists()).toBe(false);
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

	// The live file loses the archived suffix after it was staged for the copy.
	// The comparison has to run on what is being written, so this is refused.
	const realCopyFile = fs.copyFile;
	const copyFile = spyOn(fs, "copyFile").mockImplementation(async (source, destination, mode) => {
		if (String(source) === path.join(liveArtifacts, "tool.log")) {
			await Bun.write(String(source), "PREFIX");
		}
		return await realCopyFile(source, destination, mode);
	});
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		copyFile.mockRestore();
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
	expect(await Bun.file(archiveFile).exists()).toBe(false);
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
	const realCopyFile = fs.copyFile;
	const copyFile = spyOn(fs, "copyFile").mockImplementation(async (source, destination, mode) => {
		const result = await realCopyFile(source, destination, mode);
		if (String(source) === path.join(liveArtifacts, "a-first.log")) {
			await Bun.write(path.join(archivedArtifacts, "z-later.log"), "BASE-ARCHIVED-ONLY");
		}
		return result;
	});
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		copyFile.mockRestore();
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

	const realCopyFile = fs.copyFile;
	const copyFile = spyOn(fs, "copyFile").mockImplementation(async (source, destination, mode) => {
		if (String(source).endsWith("new.log")) throw new Error("ENOSPC injected");
		return await realCopyFile(source, destination, mode);
	});
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		copyFile.mockRestore();
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
	const copyFile = spyOn(fs, "copyFile").mockImplementation(async () => {
		throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
	});
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		copyFile.mockRestore();
	}

	expect(result.archive?.archived).toBe(0);
	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await Bun.file(path.join(liveArtifacts, "only.log")).text()).toBe("LIVE-ARTIFACT");
	expect(await Bun.file(archiveFile).exists()).toBe(false);
});

test("a legacy-configured archive phase meets the same refusal as a configured one", async () => {
	const old = new Date(Date.now() - 30 * 86_400_000);
	await fs.utimes(sessionFile, old, old);
	// Archiving is on, but only the pre-config.yml file says so. A gate that
	// cannot see it would let an unqualified `--apply` reach the phase.
	await Bun.write(path.join(root, "settings.json"), JSON.stringify({ gc: { archive: true } }));

	await expect(runGcCommand({ flags: { agentDir: root, apply: true, json: true } })).rejects.toThrow("--forward-only");

	expect(await Bun.file(sessionFile).exists()).toBe(true);
	expect(await Bun.file(archiveFile).exists()).toBe(false);
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

	const realCopyFile = fs.copyFile;
	const copyFile = spyOn(fs, "copyFile").mockImplementation(async (source, destination, mode) => {
		const result = await realCopyFile(source, destination, mode);
		await Bun.write(path.join(liveArtifacts, "tool.log"), "NEW USER WORK");
		return result;
	});
	let restored: RestoredSession | undefined;
	try {
		restored = await restoreArchivedSession(archiveFile, root);
	} finally {
		copyFile.mockRestore();
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

	const realCopyFile = fs.copyFile;
	const copyFile = spyOn(fs, "copyFile").mockImplementation(async (source, destination, mode) => {
		const result = await realCopyFile(source, destination, mode);
		if (String(source).endsWith("tool.log")) await Bun.write(String(source), "NEW WORK");
		return result;
	});
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		copyFile.mockRestore();
	}

	expect(result.archive?.leftoverArtifactTrees).toEqual([liveArtifacts]);
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

test("staging residue in the archive is not carried home as an artifact", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "ARTIFACT");
	await archiveEverything();
	const residue = sessionStagingPath(path.join(archivedArtifacts, "tool.log"));
	await Bun.write(residue, "half a copy");

	const restored = await restoreArchivedSession(archiveFile, root);

	expect(restored.artifactsRestored).toBe(true);
	expect(await Bun.file(path.join(liveArtifacts, path.basename(residue))).exists()).toBe(false);
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
test("archiving never writes over an archived artifact, even to repair a short one", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "tool.log"), "PREFIX");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	// The live file now holds everything the archived one does and more. There
	// is no way to replace a name only while it still holds what was examined,
	// so the archive is left alone and the operator is told how to finish it.
	await Bun.write(path.join(liveArtifacts, "tool.log"), "PREFIX-AND-MORE");

	const result = await archiveEverything();

	expect(result.archive?.archived).toBe(0);
	expect(result.archive?.errors.join("\n")).toContain("the archive is left as it is");
	expect(await Bun.file(path.join(archivedArtifacts, "tool.log")).text()).toBe("PREFIX");
	expect(await Bun.file(path.join(liveArtifacts, "tool.log")).text()).toBe("PREFIX-AND-MORE");
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
	const realCopyFile = fs.copyFile;
	const copyFile = spyOn(fs, "copyFile").mockImplementation(async (source, destination, mode) => {
		if (String(source).endsWith("z.log")) {
			const replacement = path.join(root, "someone-elses-file");
			await Bun.write(replacement, "NEW USER WORK");
			await fs.rename(replacement, path.join(archivedArtifacts, "a.log"));
			throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
		}
		return await realCopyFile(source, destination, mode);
	});
	let result: GcResult;
	try {
		result = await archiveEverything();
	} finally {
		copyFile.mockRestore();
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
	expect(await Bun.file(archiveFile).exists()).toBe(false);
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
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	const movedAside = path.join(root, "moved-aside.log");

	// What a crashed publication leaves: the staging name still on the file it
	// published, with the destination moved elsewhere. The guard that takes
	// that name off its data is the one thing between the restore and emptying
	// the moved-aside copy, so the collision is forced where the guard runs.
	const realRm = fs.rm;
	const rm = spyOn(fs, "rm").mockImplementation(async (target, options) => {
		const staged = String(target);
		if (staged.startsWith(liveArtifacts) && staged.endsWith(".tmp") && !(await Bun.file(staged).exists())) {
			await Bun.write(movedAside, "SOMEONE ELSE'S DATA");
			await fs.link(movedAside, staged);
		}
		return await realRm(target, options);
	});
	try {
		await restoreArchivedSession(archiveFile, root);
	} finally {
		rm.mockRestore();
	}

	expect(await Bun.file(movedAside).text()).toBe("SOMEONE ELSE'S DATA");
});

test("a failed archive leaves no empty directory behind its own staging residue", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "FIRST");
	await Bun.write(path.join(liveArtifacts, "z.log"), "SECOND");

	// The stage for the second file cannot be removed, and the run then fails.
	const realRm = fs.rm;
	let blocked = true;
	const rm = spyOn(fs, "rm").mockImplementation(async (target, options) => {
		if (blocked && String(target).endsWith(".tmp") && String(target).includes("z.log")) {
			blocked = false;
			throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
		}
		return await realRm(target, options);
	});
	const realCopyFile = fs.copyFile;
	const copyFile = spyOn(fs, "copyFile").mockImplementation(async (source, destination, mode) => {
		if (String(source).endsWith("z.log")) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
		return await realCopyFile(source, destination, mode);
	});
	try {
		await archiveEverything();
	} finally {
		copyFile.mockRestore();
		rm.mockRestore();
	}

	expect(await Bun.file(archivedArtifacts).exists()).toBe(false);
	expect(await fs.readdir(archivedArtifacts).catch(() => undefined)).toBeUndefined();
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

test("work written over a restored artifact after its proof puts the archive back", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "UNIQUE ORIGINAL");
	await Bun.write(path.join(liveArtifacts, "z.log"), "SECOND");
	await archiveEverything();

	// Past every sample a restore can take: the live file is replaced after
	// its own proof, while the archive is being set aside. Nothing can be
	// asked about the owners that would catch this — only the pass over the
	// retained originals, which is why they are retained.
	let replaced = false;
	const realRename = fs.rename;
	const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
		await realRename(source, destination);
		if (replaced || !String(source).startsWith(`${archivedArtifacts}${path.sep}`)) return;
		replaced = true;
		await Bun.write(path.join(liveArtifacts, "a.log"), "NEW CHILD OWNER WORK");
	});
	let restored: RestoredSession | undefined;
	try {
		restored = await restoreArchivedSession(archiveFile, root);
	} finally {
		rename.mockRestore();
	}

	expect(restored?.artifactsRestored).toBe(false);
	// Put back exactly as it was, both halves of the archive and all of it.
	expect(await Bun.file(path.join(archivedArtifacts, "a.log")).text()).toBe("UNIQUE ORIGINAL");
	expect(await Bun.file(path.join(archivedArtifacts, "z.log")).text()).toBe("SECOND");
	expect(await Bun.file(archiveFile).exists()).toBe(true);
});

test("a transcript that diverges after its artifacts came home puts the archive back", async () => {
	const liveArtifacts = sessionFile.slice(0, -".jsonl".length);
	const archivedArtifacts = archiveFile.slice(0, -".jsonl.gz".length);
	await Bun.write(path.join(liveArtifacts, "a.log"), "ARTIFACT");
	await archiveEverything();
	const other = "01a18630-42ae-7117-ba7c-029b1eee0f4c";

	// The live transcript is replaced once the artifact tree has been proved
	// and its retained copy dropped, which is the last moment the archived
	// transcript could go.
	let diverged = false;
	const realRm = fs.rm;
	const rm = spyOn(fs, "rm").mockImplementation(async (target, options) => {
		const done = String(target).startsWith(path.dirname(archiveFile)) && String(target).endsWith(".tmp");
		if (done && !diverged) {
			diverged = true;
			await Bun.write(sessionFile, sessionBody(other, "ANOTHER SESSION", root));
		}
		return await realRm(target, options);
	});
	try {
		await expect(restoreArchivedSession(archiveFile, root)).rejects.toThrow("no longer holds");
	} finally {
		rm.mockRestore();
	}

	expect(await Bun.file(archiveFile).exists()).toBe(true);
});
