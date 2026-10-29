import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { type GcResult, runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { resolveSessionFileArg } from "@oh-my-pi/pi-coding-agent/cli/session-arg";
import { exportFromFile } from "@oh-my-pi/pi-coding-agent/export/html";
import { restoreArchivedSession } from "@oh-my-pi/pi-coding-agent/session/session-archive";
import { withGcLock } from "@oh-my-pi/pi-coding-agent/session/gc-lock";
import { resolveResumableSession, resolveResumeTarget } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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
	// A live file back under the archived name: --apply would refuse this.
	await Bun.write(sessionFile, sessionBody(SESSION_ID, PROMPT, root));

	const result = await runGcCommand({ flags: { agentDir: root, restore: SESSION_ID, json: true } });

	expect(result.restore?.sessionPath).toBeUndefined();
	expect(result.restore?.errors.join("\n")).toContain("already exists");
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

test("a restore never overwrites a live artifact file with the archived copy", async () => {
	const artifacts = sessionFile.slice(0, -".jsonl".length);
	await fs.mkdir(artifacts, { recursive: true });
	await Bun.write(path.join(artifacts, "sub.jsonl"), "ARCHIVED\n");
	await archiveEverything();
	await Bun.write(sessionFile, Bun.gunzipSync(await fs.readFile(archiveFile)));
	await Bun.write(path.join(artifacts, "sub.jsonl"), "NEWER-LIVE\n");

	await restoreArchivedSession(archiveFile, root);

	expect(await Bun.file(path.join(artifacts, "sub.jsonl")).text()).toBe("NEWER-LIVE\n");
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
		flags: { agentDir: root, archive: true, apply: true, json: true, retainNewestGlobal: 99 },
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
