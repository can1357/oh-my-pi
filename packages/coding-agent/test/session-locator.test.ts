import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import {
	ArchivedSessionError,
	findSessionFiles,
	resolveResumableSession,
	resolveResumeTarget,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import {
	archiveRootFor,
	configureSessionExtraRoots,
	locateSessions,
	rebuildSessionLocator,
	recordSessionLocation,
	SESSION_LOCATOR_BASE_FILE,
	SESSION_LOCATOR_FILE,
	type SessionLocatorRebuild,
	sessionLocatorMayBeIncomplete,
} from "@oh-my-pi/pi-coding-agent/session/session-locator";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeDefaultSessionDir } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { resolveSeanceSource } from "@oh-my-pi/pi-coding-agent/task/seance";
import { getConfigRootDir, getSessionsDir, setAgentDir, Snowflake } from "@oh-my-pi/pi-utils";
import { __resetDirsFromEnvForTests, setProfile } from "@oh-my-pi/pi-utils/dirs";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { makeAssistantMessage } from "./session-manager/helpers";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

async function persistedSession(cwd: string, text = "hello"): Promise<SessionManager> {
	const session = SessionManager.create(cwd);
	session.appendMessage({ role: "user", content: text, timestamp: 1 });
	session.appendMessage(makeAssistantMessage());
	await session.flush();
	return session;
}

/** A subagent transcript the way the task executor makes one: `<parent artifacts>/<Agent>.jsonl`. */
async function subagentSession(parent: SessionManager, cwd: string, name: string): Promise<SessionManager> {
	const file = path.join(parent.getSessionFile()!.slice(0, -".jsonl".length), `${name}.jsonl`);
	const child = await SessionManager.open(file, undefined, undefined, {
		initialCwd: cwd,
		parentSession: parent.getSessionFile(),
		suppressBreadcrumb: true,
	});
	child.appendMessage({ role: "user", content: `subagent ${name}`, timestamp: 2 });
	child.appendMessage(makeAssistantMessage());
	await child.flush();
	return child;
}

function writeTranscript(file: string, id: string, cwd: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const header = { type: "session", version: 3, id, timestamp: "2026-01-02T03:04:05.000Z", cwd };
	const message = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: "2026-01-02T03:04:06.000Z",
		message: { role: "user", content: "legacy", timestamp: 1 },
	};
	fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
}

/** A finished transcript (a user turn and its answer), as `omp gc --archive` takes it. */
function writeFinishedTranscript(file: string, id: string, cwd: string): void {
	writeTranscript(file, id, cwd);
	const answer = {
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp: "2026-01-02T03:04:07.000Z",
		message: makeAssistantMessage(),
	};
	fs.appendFileSync(file, `${JSON.stringify(answer)}\n`);
}

/** Counts every directory listing under `root` except `allowed`, through each API omp lists with. */
function countListings(root: string, allowed: string): { count: () => number; listed: string[]; restore: () => void } {
	const listed: string[] = [];
	const inside = (dir: unknown): void => {
		if (typeof dir !== "string" && !(dir instanceof URL)) return;
		const resolved = path.resolve(String(dir));
		if (resolved === path.resolve(allowed)) return;
		if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) listed.push(resolved);
	};
	const spies = [
		spyOn(fs.promises, "readdir").mockImplementation(
			((original: typeof fs.promises.readdir) =>
				((dir: fs.PathLike, ...rest: unknown[]) => {
					inside(dir);
					return (original as (...args: unknown[]) => unknown)(dir, ...rest);
				}) as typeof fs.promises.readdir)(fs.promises.readdir.bind(fs.promises)),
		),
		spyOn(fs, "readdirSync").mockImplementation(
			((original: typeof fs.readdirSync) =>
				((dir: fs.PathLike, ...rest: unknown[]) => {
					inside(dir);
					return (original as (...args: unknown[]) => unknown)(dir, ...rest);
				}) as typeof fs.readdirSync)(fs.readdirSync.bind(fs)),
		),
		spyOn(fs.promises, "opendir").mockImplementation(
			((original: typeof fs.promises.opendir) =>
				((dir: fs.PathLike, ...rest: unknown[]) => {
					inside(dir);
					return (original as (...args: unknown[]) => unknown)(dir, ...rest);
				}) as typeof fs.promises.opendir)(fs.promises.opendir.bind(fs.promises)),
		),
	];
	const scan = Bun.Glob.prototype.scan;
	const scanSync = Bun.Glob.prototype.scanSync;
	Bun.Glob.prototype.scan = function (this: Bun.Glob, options?: Parameters<Bun.Glob["scan"]>[0]) {
		inside(typeof options === "string" ? options : (options?.cwd ?? process.cwd()));
		return scan.call(this, options);
	};
	Bun.Glob.prototype.scanSync = function (this: Bun.Glob, options?: Parameters<Bun.Glob["scanSync"]>[0]) {
		inside(typeof options === "string" ? options : (options?.cwd ?? process.cwd()));
		return scanSync.call(this, options);
	};
	return {
		count: () => listed.length,
		listed,
		restore: () => {
			for (const spy of spies) spy.mockRestore();
			Bun.Glob.prototype.scan = scan;
			Bun.Glob.prototype.scanSync = scanSync;
		},
	};
}

describe("session index: lookups by id", () => {
	let agentDir: string;
	let cwdA: string;
	let cwdB: string;

	beforeEach(async () => {
		agentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-locator-"));
		setAgentDir(agentDir);
		configureSessionExtraRoots([]);
		cwdA = path.join(agentDir, "project-a");
		cwdB = path.join(agentDir, "project-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
	});

	afterEach(async () => {
		configureSessionExtraRoots(undefined);
		closeSessionIndex();
		setAgentDir(originalAgentDir ?? path.join(getConfigRootDir(), "agent"));
		await fsp.rm(agentDir, { recursive: true, force: true });
	});

	it("resolves a nested subagent transcript by id from another project", async () => {
		const parent = await persistedSession(cwdA);
		const child = await subagentSession(parent, cwdA, "Reviewer");
		const childFile = child.getSessionFile()!;
		const childId = child.getSessionId();
		await child.close();
		await parent.close();

		const match = await resolveResumableSession(childId, cwdB);
		expect(match?.scope).toBe("global");
		expect(match?.session.path).toBe(childFile);
		expect(match?.session.id).toBe(childId);
		expect(await findSessionFiles(childId.slice(0, 13))).toEqual([childFile]);
	});

	it("resolves without listing any directory but the current project's", async () => {
		// A tree of 200 project buckets beside the target, 25 transcripts each.
		const sessionsRoot = getSessionsDir();
		for (let bucket = 0; bucket < 200; bucket++) {
			const dir = path.join(sessionsRoot, `--noise-${bucket}--`);
			fs.mkdirSync(dir, { recursive: true });
			for (let n = 0; n < 25; n++)
				fs.writeFileSync(path.join(dir, `2026-01-01T00-00-00-000Z_noise-${bucket}-${n}.jsonl`), "{}\n");
		}
		const parent = await persistedSession(cwdA);
		const child = await subagentSession(parent, cwdA, "Deep");
		const childId = child.getSessionId();
		const parentId = parent.getSessionId();
		await child.close();
		await parent.close();

		const localDir = computeDefaultSessionDir(cwdB, new FileSessionStorage());
		const probe = countListings(path.resolve(sessionsRoot), localDir);
		try {
			expect((await resolveResumableSession(childId, cwdB))?.session.id).toBe(childId);
			expect((await resolveResumableSession(parentId.slice(0, 18), cwdB))?.session.id).toBe(parentId);
			expect(await resolveResumableSession("ffffffff-0000", cwdB)).toBeUndefined();
		} finally {
			probe.restore();
		}
		expect(probe.listed).toEqual([]);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"resolves without listing any directory after a move its index could not record",
		async () => {
			// The move is committed on disk and its index lines are not. Recovery
			// is `omp session reindex`, so the lookup still only reads index files.
			const parent = await persistedSession(cwdA);
			const child = await subagentSession(parent, cwdA, "Deep");
			const childId = child.getSessionId();
			await child.close();
			const log = path.join(getSessionsDir(), SESSION_LOCATOR_FILE);
			fs.chmodSync(log, 0o400);
			try {
				await parent.moveTo(cwdB);
			} finally {
				fs.chmodSync(log, 0o600);
			}
			await parent.close();

			const cwdC = path.join(agentDir, "project-c");
			fs.mkdirSync(cwdC);
			const localDir = computeDefaultSessionDir(cwdC, new FileSessionStorage());
			const probe = countListings(path.resolve(getSessionsDir()), localDir);
			try {
				await resolveResumableSession(childId, cwdC);
			} finally {
				probe.restore();
			}
			expect(probe.listed).toEqual([]);
		},
	);

	it("finds a session gc archived, and its subagents, and refuses to open the archive in place", async () => {
		const parent = await persistedSession(cwdA);
		const child = await subagentSession(parent, cwdA, "Archived");
		const parentFile = parent.getSessionFile()!;
		const parentId = parent.getSessionId();
		const childFile = child.getSessionFile()!;
		const childId = child.getSessionId();
		await child.close();
		await parent.close();
		const old = new Date(Date.now() - 90 * 86_400_000);
		for (const file of [parentFile, childFile]) fs.utimesSync(file, old, old);

		const result = await runGcCommand({
			flags: {
				agentDir,
				archive: true,
				apply: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
			},
		});
		expect(result.archive?.archived).toBe(1);
		const archiveRoot = archiveRootFor(getSessionsDir());
		const archivedFile = path.join(archiveRoot, `${path.relative(getSessionsDir(), parentFile)}.gz`);
		const archivedChild = path.join(archiveRoot, path.relative(getSessionsDir(), childFile));
		expect(fs.existsSync(archivedFile)).toBe(true);
		expect(fs.existsSync(archivedChild)).toBe(true);

		// The subagent transcript stays a plain `.jsonl` and resolves where gc put it.
		expect((await resolveResumableSession(childId, cwdB))?.session.path).toBe(archivedChild);
		// The compressed parent is found, and named with the path that restores it.
		const error = await resolveResumableSession(parentId, cwdB).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ArchivedSessionError);
		expect((error as ArchivedSessionError).archivePath).toBe(archivedFile);
		expect((error as ArchivedSessionError).livePath).toBe(parentFile);

		// The archive keeps its own index: rebuilding the sessions root loses nothing.
		await rebuildSessionLocator(getSessionsDir());
		expect((await locateSessions(parentId)).map(hit => hit.path)).toEqual([archivedFile]);
		expect(await fsp.readFile(path.join(archiveRoot, SESSION_LOCATOR_FILE), "utf8")).toContain(childId);
		// A real `omp gc --archive --apply` run: 20-30 s idle, over 4 minutes measured on a loaded host.
	}, 600_000);

	it("finds a tree moved wholesale to a configured extra root through the index that moved with it", async () => {
		const session = await persistedSession(cwdA);
		const child = await subagentSession(session, cwdA, "Moved");
		const id = session.getSessionId();
		const childId = child.getSessionId();
		await child.close();
		await session.close();

		const moved = path.join(agentDir, "durable", "sessions");
		fs.mkdirSync(path.dirname(moved), { recursive: true });
		fs.renameSync(getSessionsDir(), moved);
		expect(await resolveResumableSession(id, cwdB)).toBeUndefined();

		configureSessionExtraRoots([moved]);
		expect((await resolveResumableSession(id, cwdB))?.session.path.startsWith(moved)).toBe(true);
		expect((await resolveResumableSession(childId, cwdB))?.session.path.startsWith(moved)).toBe(true);
	});

	it("finds one bucket moved to an extra root by the row the sessions root kept", async () => {
		const session = await persistedSession(cwdA);
		const id = session.getSessionId();
		const file = session.getSessionFile()!;
		await session.close();
		const bucket = path.dirname(file);
		const extra = path.join(agentDir, "cold");
		fs.mkdirSync(extra, { recursive: true });
		fs.renameSync(bucket, path.join(extra, path.basename(bucket)));
		configureSessionExtraRoots([extra]);

		expect((await resolveResumableSession(id, cwdB))?.session.path).toBe(
			path.join(extra, path.basename(bucket), path.basename(file)),
		);
	});

	it("records a session moved to another project at its new path, with its subagents", async () => {
		const session = await persistedSession(cwdA);
		const child = await subagentSession(session, cwdA, "Carried");
		const childId = child.getSessionId();
		await child.close();
		await session.moveTo(cwdB);
		const movedFile = session.getSessionFile()!;
		await session.close();

		const cwdC = path.join(agentDir, "project-c");
		fs.mkdirSync(cwdC);
		expect((await resolveResumableSession(session.getSessionId(), cwdC))?.session.path).toBe(movedFile);
		expect((await resolveResumableSession(childId, cwdC))?.session.path).toBe(
			path.join(movedFile.slice(0, -".jsonl".length), "Carried.jsonl"),
		);
	});

	it("indexes sessions an older omp wrote only on reindex, and says so until then", async () => {
		const legacyId = "019a0000-1111-7222-8333-444455556666";
		const nestedId = "019a0000-9999-7222-8333-444455556666";
		const bucket = path.join(getSessionsDir(), "--legacy-project--");
		const legacy = path.join(bucket, `2026-01-02T03-04-05-000Z_${legacyId}.jsonl`);
		const nested = path.join(legacy.slice(0, -".jsonl".length), "Task.jsonl");
		writeTranscript(legacy, legacyId, "/legacy/project");
		writeTranscript(nested, nestedId, "/legacy/project");

		expect(await resolveResumableSession(legacyId, cwdB)).toBeUndefined();
		expect(await sessionLocatorMayBeIncomplete()).toBe(true);

		const rebuilt = await rebuildSessionLocator(getSessionsDir());
		expect(rebuilt.indexed).toBe(2);
		expect(rebuilt.unreadable).toEqual([]);
		expect(await sessionLocatorMayBeIncomplete()).toBe(false);
		expect((await resolveResumableSession(legacyId, cwdB))?.session.path).toBe(legacy);
		expect((await resolveResumableSession(nestedId, cwdB))?.session.path).toBe(nested);
		// The rebuilt index is renamed into place: no staging file is left behind.
		expect(fs.readdirSync(getSessionsDir()).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it("reports a transcript it read without finding an id, rather than counting it as walked", async () => {
		const bucket = path.join(getSessionsDir(), "--no-id--");
		const good = path.join(bucket, "2026-01-02T03-04-05-000Z_019a0019-0000-7000-8000-000000000001.jsonl");
		writeTranscript(good, "019a0019-0000-7000-8000-000000000001", "/p");
		// Readable and well-formed, but no session header and a name that
		// records no id: a rebuild derives nothing from it, and only this
		// report would ever say so.
		const silent = path.join(bucket, "Worker.jsonl");
		fs.writeFileSync(silent, `${JSON.stringify({ type: "message", id: "m1" })}\n`);

		const rebuilt = await rebuildSessionLocator(getSessionsDir());
		expect(rebuilt.indexed).toBe(1);
		expect(rebuilt.unreadable.map(entry => entry.bucket)).toEqual([silent]);
		expect(
			(await resolveResumableSession("019a0019-0000-7000-8000-000000000001", cwdB))?.session.path,
		).toBe(good);
	});

	it("`omp session reindex` rebuilds every root and prints what it indexed", async () => {
		const legacyId = "019a0000-2222-7222-8333-444455556666";
		const legacy = path.join(getSessionsDir(), "--legacy--", `2026-01-02T03-04-05-000Z_${legacyId}.jsonl`);
		writeTranscript(legacy, legacyId, "/legacy");
		const cli = path.join(import.meta.dir, "../src/cli.ts");
		const result = Bun.spawnSync([process.execPath, cli, "session", "reindex"], {
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SESSION_EXTRA_ROOTS: "" },
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(result.stdout.toString().split("\n")).toContain(`1\t${getSessionsDir()}`);
		expect((await resolveResumableSession(legacyId, cwdB))?.session.path).toBe(legacy);
	}, 60_000);

	it("skips a torn index line without losing the line appended after it", async () => {
		const indexFile = path.join(getSessionsDir(), SESSION_LOCATOR_FILE);
		fs.mkdirSync(getSessionsDir(), { recursive: true });
		fs.writeFileSync(indexFile, "019a0000-dead\t--gone--/2026-01-01T00-00-00-000Z_019a");
		const session = await persistedSession(cwdA);
		const id = session.getSessionId();
		await session.close();

		expect((await resolveResumableSession(id, cwdB))?.session.id).toBe(id);
		expect(await locateSessions("019a0000-dead")).toEqual([]);
	});

	it("loses no line other processes append while a reindex runs, including on a root with no index yet", async () => {
		// Transcripts outside every root: only the log can find them, never the walk.
		const offTree = path.join(agentDir, "custom-dir");
		const ids: string[] = [];
		for (let n = 0; n < 160; n++) {
			const id = `019a0001-0000-7000-8000-${String(n).padStart(12, "0")}`;
			ids.push(id);
			writeTranscript(path.join(offTree, `2026-01-02T03-04-05-000Z_${id}.jsonl`), id, "/off/tree");
		}
		// Enough tree for the walk to take a while, and no index file yet.
		for (let bucket = 0; bucket < 40; bucket++) {
			for (let n = 0; n < 10; n++) {
				const id = `019a0002-${String(bucket).padStart(4, "0")}-7000-8000-${String(n).padStart(12, "0")}`;
				writeTranscript(
					path.join(getSessionsDir(), `--tree-${bucket}--`, `2026-01-02T03-04-05-000Z_${id}.jsonl`),
					id,
					"/t",
				);
			}
		}
		expect(fs.existsSync(path.join(getSessionsDir(), SESSION_LOCATOR_FILE))).toBe(false);
		const writer = path.join(agentDir, "writer.ts");
		fs.writeFileSync(
			writer,
			[
				`import { recordSessionLocation } from ${JSON.stringify(path.join(import.meta.dir, "../src/session/session-locator.ts"))};`,
				`const [root, dir, ...ids] = process.argv.slice(2);`,
				"for (const id of ids) {",
				'\trecordSessionLocation(id, dir + "/2026-01-02T03-04-05-000Z_" + id + ".jsonl", [root]);',
				// Real separate processes: spread the appends across the reindex window on the real clock.
				"\tawait Bun.sleep(1);",
				"}",
			].join("\n"),
		);
		const writers = Array.from({ length: 8 }, (_, w) =>
			Bun.spawn([process.execPath, writer, getSessionsDir(), offTree, ...ids.filter((_, n) => n % 8 === w)], {
				stdout: "ignore",
				stderr: "inherit",
				// `setAgentDir` changes `process.env` after start; hand it to the child explicitly.
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			}),
		);
		const rebuilds = [rebuildSessionLocator(getSessionsDir()), rebuildSessionLocator(getSessionsDir())];
		expect(await Promise.all(writers.map(child => child.exited))).toEqual(Array(8).fill(0));
		for (const rebuilt of await Promise.all(rebuilds)) expect(rebuilt.indexed).toBe(400);
		await rebuildSessionLocator(getSessionsDir());

		const missing: string[] = [];
		for (const id of ids) if ((await locateSessions(id)).length !== 1) missing.push(id);
		expect(missing).toEqual([]);
	}, 600_000);

	it("keeps a --session-dir session findable after the default root is reindexed", async () => {
		const custom = path.join(agentDir, "elsewhere");
		const session = SessionManager.create(cwdA, custom);
		session.appendMessage({ role: "user", content: "custom dir", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const id = session.getSessionId();
		const file = session.getSessionFile()!;
		await session.close();
		expect((await resolveResumableSession(id, cwdB))?.session.path).toBe(file);

		await rebuildSessionLocator(getSessionsDir());
		expect((await resolveResumableSession(id, cwdB))?.session.path).toBe(file);
	});

	it("never answers an id with another session that a file named for it now holds, logged, reindexed or local", async () => {
		const namedId = "019a0004-0000-7000-8000-00000000000a";
		const occupantId = "019a0004-0000-7000-8000-00000000000b";
		const bucket = computeDefaultSessionDir(cwdA, new FileSessionStorage());
		const file = path.join(bucket, `2026-01-02T03-04-05-000Z_${namedId}.jsonl`);
		writeTranscript(file, namedId, cwdA);
		recordSessionLocation(namedId, file);
		writeTranscript(file, occupantId, cwdA);
		recordSessionLocation(occupantId, file);

		expect(await resolveResumableSession(namedId, cwdB)).toBeUndefined();
		await rebuildSessionLocator(getSessionsDir());
		expect(await resolveResumableSession(namedId, cwdB)).toBeUndefined();
		expect(await resolveResumableSession(`2026-01-02T03-04-05-000Z_${namedId}`, cwdB)).toBeUndefined();
		// The same file in the current project's own listing.
		expect(await resolveResumableSession(namedId, cwdA)).toBeUndefined();
		// Its occupant is still found by its own id, and a timestamp key still matches the file.
		expect((await resolveResumableSession(occupantId, cwdB))?.session.path).toBe(file);
		expect((await resolveResumableSession("2026-01-02T03-04", cwdA))?.session.id).toBe(occupantId);

		// A hand-named file whose `_<id>` suffix records another session counts the same way.
		const handNamedId = "019a0004-0000-7000-8000-00000000000c";
		const handNamed = path.join(bucket, `custom_name_${handNamedId}.jsonl`);
		writeTranscript(handNamed, occupantId, cwdA);
		recordSessionLocation(occupantId, handNamed);
		expect(await resolveResumableSession(handNamedId, cwdA)).toBeUndefined();
		expect(await resolveResumableSession(handNamedId, cwdB)).toBeUndefined();
		// Spelled-out custom file names still name that file.
		expect((await resolveResumableSession("custom_name", cwdA))?.session.path).toBe(handNamed);

		// A generated name whose recorded id holds an underscore: its whole id counts, not the text after the last `_`.
		const underscored = path.join(bucket, "2026-01-03T00-00-00-000Z_worker_aa11.jsonl");
		writeTranscript(underscored, occupantId, cwdA);
		recordSessionLocation(occupantId, underscored);
		for (const key of ["2026-01-03T00-00-00-000Z_worker", "worker", "worker_aa11"]) {
			expect({ key, local: await resolveResumableSession(key, cwdA) }).toEqual({ key, local: undefined });
			expect({ key, global: await resolveResumableSession(key, cwdB) }).toEqual({ key, global: undefined });
		}
	});

	it("follows a replaced file to its continuation for id, file-name and any-case keys, before and after reindex", async () => {
		const otherCwd = path.join(agentDir, "project-c");
		fs.mkdirSync(otherCwd);
		const cases = [
			{
				named: "019a0005-0000-7000-8000-00000000000a",
				fileId: "019a0005-0000-7000-8000-00000000000a",
				garbage: false,
			},
			{
				named: "019A0005-0000-7000-8000-0000000000AB",
				fileId: "019A0005-0000-7000-8000-0000000000AB",
				garbage: false,
			},
			// Replaced with bytes that are not a session at all: reindex must still record it by name.
			{
				named: "019a0005-0000-7000-8000-00000000000c",
				fileId: "019a0005-0000-7000-8000-00000000000c",
				garbage: true,
			},
		];
		for (const [n, { named, fileId, garbage }] of cases.entries()) {
			const bucket = path.join(getSessionsDir(), `--older-${n}--`);
			const stem = `2026-01-01T00-00-0${n}-000Z_${fileId}`;
			const replaced = path.join(bucket, `${stem}.jsonl`);
			// A tree an older omp wrote: no log, so only a reindex records it.
			if (garbage) {
				fs.mkdirSync(bucket, { recursive: true });
				fs.writeFileSync(replaced, "not a session\n");
			} else {
				writeTranscript(replaced, `019a0005-1111-7000-8000-00000000000${n}`, "/older");
			}
			const continuation = path.join(
				bucket,
				`2026-01-02T00-00-0${n}-000Z_019a0005-2222-7000-8000-00000000000${n}.jsonl`,
			);
			fs.writeFileSync(
				continuation,
				`${JSON.stringify({ type: "session", version: 3, id: `019a0005-2222-7000-8000-00000000000${n}`, timestamp: "2026-01-02T00:00:00.000Z", cwd: "/older", parentSession: named, continuationOf: named })}\n${JSON.stringify({ type: "message", id: "t1", parentId: null, timestamp: "2026-01-02T00:00:01.000Z", message: { role: "user", content: "went on", timestamp: 1 } })}\n`,
			);
			for (const pass of ["local-only", "reindexed"]) {
				if (pass === "reindexed") await rebuildSessionLocator(getSessionsDir());
				const keys = [named, named.toLowerCase(), stem, stem.slice(0, stem.indexOf("_") + 9)];
				for (const key of keys) {
					// From the project that owns the bucket (local scope) only before reindex has nothing to read.
					if (pass === "reindexed") {
						const target = await resolveResumeTarget(key, otherCwd);
						expect({ pass, key, path: target?.session.path }).toEqual({ pass, key, path: continuation });
					}
					const local = await resolveResumeTarget(key, otherCwd, bucket);
					expect({ pass, key, scope: "local", path: local?.session.path }).toEqual({
						pass,
						key,
						scope: "local",
						path: continuation,
					});
				}
				// The replaced file itself never answers for the session its name records.
				expect(await resolveResumableSession(named, otherCwd)).toBeUndefined();
			}
		}
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"keeps every readable session, and what it knew of the rest, when reindex meets an unreadable artifact directory",
		async () => {
			const bucket = path.join(getSessionsDir(), "--mixed--");
			const readableId = "019a0008-0000-7000-8000-000000000001";
			const lockedId = "019a0008-0000-7000-8000-000000000002";
			const nestedId = "019a0008-0000-7000-8000-000000000003";
			const readable = path.join(bucket, `2026-01-01T00-00-00-000Z_${readableId}.jsonl`);
			const locked = path.join(bucket, `2026-01-01T00-00-01-000Z_${lockedId}.jsonl`);
			const lockedArtifacts = locked.slice(0, -".jsonl".length);
			const nested = path.join(lockedArtifacts, "Worker.jsonl");
			writeTranscript(readable, readableId, "/m");
			writeTranscript(locked, lockedId, "/m");
			writeTranscript(nested, nestedId, "/m");
			expect((await rebuildSessionLocator(getSessionsDir())).indexed).toBe(3);

			fs.chmodSync(lockedArtifacts, 0o000);
			try {
				const rebuilt = await rebuildSessionLocator(getSessionsDir());
				expect(rebuilt.unreadable.map(entry => entry.bucket)).toEqual([lockedArtifacts]);
				expect(rebuilt.indexed).toBe(2);
				expect((await resolveResumableSession(readableId, cwdB))?.session.path).toBe(readable);
				expect((await resolveResumableSession(lockedId, cwdB))?.session.path).toBe(locked);
			} finally {
				fs.chmodSync(lockedArtifacts, 0o700);
			}
			// The line the earlier snapshot had for the nested transcript survived the partial walk.
			expect((await resolveResumableSession(nestedId, cwdB))?.session.path).toBe(nested);
		},
	);

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"keeps an indexed subagent transcript through a reindex that cannot read it",
		async () => {
			const parentId = "019a0009-0000-7000-8000-000000000001";
			const childId = "019a0009-0000-7000-8000-000000000002";
			const parent = path.join(getSessionsDir(), "--perm--", `2026-01-01T00-00-00-000Z_${parentId}.jsonl`);
			const child = path.join(parent.slice(0, -".jsonl".length), "Worker.jsonl");
			writeTranscript(parent, parentId, "/p");
			writeTranscript(child, childId, "/p");
			expect((await rebuildSessionLocator(getSessionsDir())).indexed).toBe(2);
			fs.chmodSync(child, 0o000);
			let rebuilt: SessionLocatorRebuild;
			try {
				rebuilt = await rebuildSessionLocator(getSessionsDir());
			} finally {
				fs.chmodSync(child, 0o600);
			}
			expect(rebuilt.unreadable.map(entry => entry.bucket)).toEqual([child]);
			expect((await resolveResumableSession(childId, cwdB))?.session.path).toBe(child);
		},
	);

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"records every readable subagent of a moved session, and keeps the id of one it cannot read",
		async () => {
			const parent = await persistedSession(cwdA);
			const childIds: string[] = [];
			for (let n = 0; n < 4; n++) {
				const child = await subagentSession(parent, cwdA, `Sub${n}`);
				childIds.push(child.getSessionId());
				await child.close();
			}
			// Each subagent's own artifact directory, so one can be made unreadable.
			const artifacts = parent.getSessionFile()!.slice(0, -".jsonl".length);
			const lockedDir = path.join(artifacts, "locked");
			const lockedId = "019a000a-0000-7000-8000-000000000001";
			writeTranscript(path.join(lockedDir, "Locked.jsonl"), lockedId, cwdA);
			recordSessionLocation(lockedId, path.join(lockedDir, "Locked.jsonl"));
			fs.chmodSync(lockedDir, 0o000);
			try {
				await parent.moveTo(cwdB);
			} finally {
				const movedLocked = path.join(parent.getSessionFile()!.slice(0, -".jsonl".length), "locked");
				fs.chmodSync(fs.existsSync(movedLocked) ? movedLocked : lockedDir, 0o700);
			}
			const moved = parent.getSessionFile()!.slice(0, -".jsonl".length);
			await parent.close();
			const cwdC = path.join(agentDir, "project-c");
			fs.mkdirSync(cwdC);
			for (const [n, id] of childIds.entries()) {
				expect((await resolveResumableSession(id, cwdC))?.session.path).toBe(path.join(moved, `Sub${n}.jsonl`));
			}
			// Not readable during the move, readable now: the move carried its recorded id to the new path.
			expect((await resolveResumableSession(lockedId, cwdC))?.session.path).toBe(
				path.join(moved, "locked", "Locked.jsonl"),
			);
		},
	);

	describe("an unreadable file or directory never costs a readable session", () => {
		const unlessRoot = process.platform === "win32" || process.getuid?.() === 0;

		it.skipIf(unlessRoot)(
			"keeps a header id across a reindex that cannot read the file, whatever its name says",
			async () => {
				const headerId = "019a000b-0000-7000-8000-00000000000a";
				const nameId = "019a000b-0000-7000-8000-00000000000b";
				const file = path.join(getSessionsDir(), "--named--", `2026-01-01T00-00-00-000Z_${nameId}.jsonl`);
				writeTranscript(file, headerId, "/n");
				await rebuildSessionLocator(getSessionsDir());
				expect((await resolveResumableSession(headerId, cwdB))?.session.path).toBe(file);
				fs.chmodSync(file, 0o000);
				let rebuilt: SessionLocatorRebuild;
				try {
					rebuilt = await rebuildSessionLocator(getSessionsDir());
				} finally {
					fs.chmodSync(file, 0o600);
				}
				expect(rebuilt.unreadable.map(entry => entry.bucket)).toEqual([file]);
				expect((await resolveResumableSession(headerId, cwdB))?.session.path).toBe(file);
			},
		);

		it.skipIf(unlessRoot)(
			"finds a fork's copy of a subagent transcript when the original cannot be read",
			async () => {
				const parent = await persistedSession(cwdA);
				const child = await subagentSession(parent, cwdA, "Worker");
				const childId = child.getSessionId();
				const original = child.getSessionFile()!;
				await child.close();
				await parent.close();
				const fork = await SessionManager.forkFrom(parent.getSessionFile()!, cwdB);
				await fork.flush();
				const copy = path.join(fork.getSessionFile()!.slice(0, -".jsonl".length), "Worker.jsonl");
				await fork.close();
				expect(fs.existsSync(copy)).toBe(true);
				fs.chmodSync(original, 0o000);
				try {
					const cwdC = path.join(agentDir, "project-c");
					fs.mkdirSync(cwdC);
					expect((await resolveResumableSession(childId, cwdC))?.session.path).toBe(copy);
				} finally {
					fs.chmodSync(original, 0o600);
				}
			},
		);

		it.skipIf(unlessRoot)(
			"keeps a subagent's id through gc archive and reindex while it cannot be read",
			async () => {
				const parentId = "019a000c-0000-7000-8000-000000000001";
				const childId = "019a000c-0000-7000-8000-000000000002";
				// A tree an older omp wrote: only a reindex records it, no log.
				const parent = path.join(getSessionsDir(), "--old-tree--", `2026-01-01T00-00-00-000Z_${parentId}.jsonl`);
				const child = path.join(parent.slice(0, -".jsonl".length), "Worker.jsonl");
				writeFinishedTranscript(parent, parentId, "/old");
				writeFinishedTranscript(child, childId, "/old");
				const old = new Date(Date.now() - 90 * 86_400_000);
				for (const file of [parent, child]) fs.utimesSync(file, old, old);
				await rebuildSessionLocator(getSessionsDir());
				fs.chmodSync(child, 0o000);
				try {
					const result = await runGcCommand({
						flags: {
							agentDir,
							archive: true,
							apply: true,
							coldArchiveAfterDays: 30,
							retainNewestGlobal: 0,
							retainNewestPerCwd: 0,
						},
					});
					expect(result.archive?.archived).toBe(1);
					await rebuildSessionLocator(getSessionsDir());
				} finally {
					const archived = path.join(archiveRootFor(getSessionsDir()), path.relative(getSessionsDir(), child));
					fs.chmodSync(fs.existsSync(archived) ? archived : child, 0o600);
				}
				expect((await resolveResumableSession(childId, cwdB))?.session.path).toBe(
					path.join(archiveRootFor(getSessionsDir()), path.relative(getSessionsDir(), child)),
				);
			},
			600_000,
		);

		it.skipIf(unlessRoot)("keeps a moved subagent's id when its rows live in another root's index", async () => {
			const session = await persistedSession(cwdA);
			const child = await subagentSession(session, cwdA, "Portable");
			const childId = child.getSessionId();
			await child.close();
			const file = session.getSessionFile()!;
			await session.close();
			// Move the bucket into an extra root: its rows stay in the original root's index.
			const extra = path.join(agentDir, "cold");
			fs.mkdirSync(extra, { recursive: true });
			const movedBucket = path.join(extra, path.basename(path.dirname(file)));
			fs.renameSync(path.dirname(file), movedBucket);
			configureSessionExtraRoots([extra]);
			const portable = path.join(movedBucket, path.basename(file));
			const portableChild = path.join(portable.slice(0, -".jsonl".length), "Portable.jsonl");
			expect((await resolveResumableSession(childId, cwdB))?.session.path).toBe(portableChild);

			const reopened = await SessionManager.open(portable, path.dirname(portable));
			fs.chmodSync(portableChild, 0o000);
			let movedChild: string;
			try {
				await reopened.moveTo(cwdB);
				movedChild = path.join(reopened.getSessionFile()!.slice(0, -".jsonl".length), "Portable.jsonl");
			} finally {
				const next = path.join(reopened.getSessionFile()!.slice(0, -".jsonl".length), "Portable.jsonl");
				fs.chmodSync(fs.existsSync(next) ? next : portableChild, 0o600);
			}
			await reopened.close();
			const cwdC = path.join(agentDir, "project-c");
			fs.mkdirSync(cwdC);
			expect((await resolveResumableSession(childId, cwdC))?.session.path).toBe(movedChild);
		});

		it.skipIf(unlessRoot)("refuses to replace a snapshot it cannot read, and loses nothing it held", async () => {
			const parentId = "019a000d-0000-7000-8000-000000000001";
			const childId = "019a000d-0000-7000-8000-000000000002";
			const parent = path.join(getSessionsDir(), "--snap--", `2026-01-01T00-00-00-000Z_${parentId}.jsonl`);
			const artifacts = parent.slice(0, -".jsonl".length);
			writeTranscript(parent, parentId, "/s");
			writeTranscript(path.join(artifacts, "Worker.jsonl"), childId, "/s");
			await rebuildSessionLocator(getSessionsDir());
			const snapshot = path.join(getSessionsDir(), ".session-index.base.tsv");
			const before = fs.readFileSync(snapshot, "utf8");
			fs.chmodSync(snapshot, 0o000);
			fs.chmodSync(artifacts, 0o000);
			try {
				await expect(rebuildSessionLocator(getSessionsDir())).rejects.toThrow(
					"cannot be read, so it was not replaced",
				);
			} finally {
				fs.chmodSync(artifacts, 0o700);
				fs.chmodSync(snapshot, 0o600);
			}
			expect(fs.readFileSync(snapshot, "utf8")).toBe(before);
			expect((await resolveResumableSession(childId, cwdB))?.session.id).toBe(childId);
		});

		it.skipIf(unlessRoot)("merges a reindex that published while another was still walking", async () => {
			const childId = "019a000e-0000-7000-8000-000000000001";
			const child = path.join(getSessionsDir(), "--race--", "parent", "Worker.jsonl");
			writeTranscript(child, childId, "/r");
			// Hold the first reindex after its walk, just before it takes the
			// per-root publish lock: `realpath` of the root is the last thing it
			// does outside the lock. (It used to be held at a permission probe
			// that no longer exists: a rebuild now keeps the read failure itself
			// rather than asking afterwards whether one happened.)
			const realpath = fs.promises.realpath.bind(fs.promises);
			const walked = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			let paused = false;
			const realpathSpy = spyOn(fs.promises, "realpath").mockImplementation((async (target: fs.PathLike) => {
				const result = await realpath(target);
				if (!paused && String(target) === getSessionsDir()) {
					paused = true;
					walked.resolve();
					await resume.promise;
				}
				return result;
			}) as typeof fs.promises.realpath);
			// A second session the first reindex never saw: if its publish
			// overwrote rather than merged, this row would be gone.
			const laterId = "019a000e-0000-7000-8000-000000000002";
			const later = path.join(getSessionsDir(), "--race--", "parent", "Later.jsonl");
			try {
				const stale = rebuildSessionLocator(getSessionsDir());
				await walked.promise;
				writeTranscript(later, laterId, "/r");
				expect((await rebuildSessionLocator(getSessionsDir())).indexed).toBe(2);
				expect((await resolveResumableSession(laterId, cwdB))?.session.path).toBe(later);
				resume.resolve();
				await stale;
			} finally {
				resume.resolve();
				realpathSpy.mockRestore();
			}
			expect((await resolveResumableSession(childId, cwdB))?.session.path).toBe(child);
			expect((await resolveResumableSession(laterId, cwdB))?.session.path).toBe(later);
		});

		it.skipIf(unlessRoot)(
			"finds an archived session by the id inside it when its name says another",
			async () => {
				const headerId = "019a000f-0000-7000-8000-00000000000a";
				const nameId = "019a000f-0000-7000-8000-00000000000b";
				const file = path.join(getSessionsDir(), "--gz--", `2026-01-01T00-00-00-000Z_${nameId}.jsonl`);
				writeFinishedTranscript(file, headerId, "/gz");
				const old = new Date(Date.now() - 90 * 86_400_000);
				fs.utimesSync(file, old, old);
				await rebuildSessionLocator(getSessionsDir());
				const result = await runGcCommand({
					flags: {
						agentDir,
						archive: true,
						apply: true,
						coldArchiveAfterDays: 30,
						retainNewestGlobal: 0,
						retainNewestPerCwd: 0,
					},
				});
				expect(result.archive?.archived).toBe(1);
				const archived = `${path.join(archiveRootFor(getSessionsDir()), path.relative(getSessionsDir(), file))}.gz`;
				const error = await resolveResumableSession(headerId, cwdB).catch((e: unknown) => e);
				expect(error).toBeInstanceOf(ArchivedSessionError);
				expect((error as ArchivedSessionError).archivePath).toBe(archived);
				// The name's id does not stand for the session inside.
				expect(await resolveResumableSession(nameId, cwdB)).toBeUndefined();
			},
			600_000,
		);

		it.skipIf(unlessRoot)("keeps every id a moved transcript had when it cannot be read", async () => {
			const parent = await persistedSession(cwdA);
			const headerId = "019a0010-0000-7000-8000-00000000000a";
			const nameId = "019a0010-0000-7000-8000-00000000000b";
			const artifacts = parent.getSessionFile()!.slice(0, -".jsonl".length);
			const childName = `2026-01-01T00-00-00-000Z_${nameId}.jsonl`;
			writeTranscript(path.join(artifacts, childName), headerId, cwdA);
			await rebuildSessionLocator(getSessionsDir());
			fs.chmodSync(path.join(artifacts, childName), 0o000);
			let movedChild = "";
			try {
				await parent.moveTo(cwdB);
				movedChild = path.join(parent.getSessionFile()!.slice(0, -".jsonl".length), childName);
			} finally {
				fs.chmodSync(movedChild && fs.existsSync(movedChild) ? movedChild : path.join(artifacts, childName), 0o600);
			}
			await parent.close();
			const cwdC = path.join(agentDir, "project-c");
			fs.mkdirSync(cwdC);
			expect((await resolveResumableSession(headerId, cwdC))?.session.path).toBe(movedChild);
		});

		it.skipIf(unlessRoot)(
			"`omp session reindex` reports a root it cannot read and still reindexes the others",
			async () => {
				const locked = path.join(agentDir, "locked-root");
				const good = path.join(agentDir, "good-root");
				const legacyId = "019a0011-0000-7000-8000-000000000001";
				const legacy = path.join(good, "--legacy--", `2026-01-01T00-00-00-000Z_${legacyId}.jsonl`);
				writeTranscript(legacy, legacyId, "/g");
				fs.mkdirSync(locked);
				fs.chmodSync(locked, 0o000);
				const cli = path.join(import.meta.dir, "../src/cli.ts");
				let result: Bun.SyncSubprocess<"pipe", "pipe">;
				try {
					result = Bun.spawnSync([process.execPath, cli, "session", "reindex"], {
						env: {
							...process.env,
							PI_CODING_AGENT_DIR: agentDir,
							PI_SESSION_EXTRA_ROOTS: [locked, good].join(path.delimiter),
						},
					});
				} finally {
					fs.chmodSync(locked, 0o700);
				}
				expect(result.exitCode).toBe(1);
				expect(result.stderr.toString()).toContain(`${locked} was not reindexed`);
				expect(result.stdout.toString().split("\n")).toContain(`1\t${good}`);
				configureSessionExtraRoots([good]);
				expect((await resolveResumableSession(legacyId, cwdB))?.session.path).toBe(legacy);
			},
			120_000,
		);

		it.skipIf(unlessRoot)("records a session once its index log can be written again", async () => {
			fs.mkdirSync(getSessionsDir(), { recursive: true });
			const log = path.join(getSessionsDir(), SESSION_LOCATOR_FILE);
			fs.writeFileSync(log, "");
			fs.chmodSync(log, 0o000);
			const session = SessionManager.create(cwdA);
			try {
				session.appendMessage({ role: "user", content: "first", timestamp: 1 });
				session.appendMessage(makeAssistantMessage());
				await session.flush();
			} finally {
				fs.chmodSync(log, 0o600);
			}
			session.appendMessage({ role: "user", content: "second", timestamp: 2 });
			await session.flush();
			const id = session.getSessionId();
			await session.close();
			expect((await resolveResumableSession(id, cwdB))?.session.id).toBe(id);
		});

		it.skipIf(unlessRoot)(
			"reports a failed index append no reindex could undo, and stays quiet about one it could",
			async () => {
				const bucket = path.join(getSessionsDir(), "--walked--");
				const outside = path.join(agentDir, "outside-bucket");
				fs.mkdirSync(bucket, { recursive: true });
				fs.mkdirSync(outside, { recursive: true });
				// The walk never enters a symlinked bucket, so for a transcript in
				// one the index line is the only record of where it is.
				const linked = path.join(getSessionsDir(), "--linked--");
				fs.symlinkSync(outside, linked);
				const log = path.join(getSessionsDir(), SESSION_LOCATOR_FILE);
				fs.writeFileSync(log, "");
				fs.chmodSync(log, 0o400);
				const warn = spyOn(logger, "warn").mockImplementation(() => {});
				const error = spyOn(logger, "error").mockImplementation(() => {});
				try {
					const walkedId = "019a0017-0000-7000-8000-000000000001";
					const strandedId = "019a0017-0000-7000-8000-000000000002";
					const walked = path.join(bucket, `2026-01-02T03-04-05-000Z_${walkedId}.jsonl`);
					const stranded = path.join(linked, `2026-01-02T03-04-05-000Z_${strandedId}.jsonl`);
					fs.writeFileSync(walked, "");
					fs.writeFileSync(stranded, "");
					expect(recordSessionLocation(walkedId, walked)).toBe(false);
					expect(error).not.toHaveBeenCalled();
					expect(warn).toHaveBeenCalledTimes(1);
					expect(recordSessionLocation(strandedId, stranded)).toBe(false);
					expect(warn).toHaveBeenCalledTimes(1);
					expect(error).toHaveBeenCalledTimes(1);
					expect(String(error.mock.calls[0]?.[0])).toContain("no reindex will recover this session");
					expect(error.mock.calls[0]?.[1]).toMatchObject({ id: strandedId, file: stranded });
				} finally {
					fs.chmodSync(log, 0o600);
					error.mockRestore();
					warn.mockRestore();
				}
			},
		);

		// The shape of a path is not evidence that a rebuild recovers it, and
		// neither is permission to open its transcript: the walk must be able to
		// list the bucket, an id must actually come out of the file, and the
		// reindex must be able to publish. Each case here is a well-shaped path
		// under a readable root whose recovery is nonetheless impossible, so a
		// quiet "`omp session reindex` rebuilds it" would be a false promise.
		for (const { what, obstruct } of [
			{
				what: "a bucket the walk cannot list",
				obstruct: (sessions: string, bucket: string) => fs.chmodSync(bucket, 0o300),
			},
			{
				what: "a snapshot the reindex will not publish over",
				obstruct: (sessions: string) => {
					const snapshot = path.join(sessions, SESSION_LOCATOR_BASE_FILE);
					fs.writeFileSync(snapshot, "");
					fs.chmodSync(snapshot, 0o000);
				},
			},
			{
				what: "a transcript whose bytes cannot be read",
				obstruct: (sessions: string, bucket: string, file: string) => fs.chmodSync(file, 0o000),
			},
			{
				// Readable, well-formed, and still yields no id: the first record
				// runs past the header reader's ceiling, so the rebuild derives
				// nothing from it. Permission was never the question.
				what: "a readable transcript whose header the rebuild cannot reach",
				obstruct: (sessions: string, bucket: string, file: string) => {
					const header = JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]) as Record<string, unknown>;
					header.title = "x".repeat(1024 * 1024);
					fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
				},
			},
			{
				// Nothing in the bytes and nothing in the name.
				what: "a transcript carrying no session id at all",
				obstruct: (sessions: string, bucket: string, file: string) => fs.writeFileSync(file, ""),
			},
		]) {
			it.skipIf(unlessRoot)(`reports a failed index append left unrecoverable by ${what}`, async () => {
				const sessions = getSessionsDir();
				const bucket = path.join(sessions, "--obstructed--");
				fs.mkdirSync(bucket, { recursive: true });
				const id = "019a0018-0000-7000-8000-000000000001";
				// A name that does NOT record the id, so deriving the row needs the
				// file's header — as it does for every subagent transcript. The
				// header is real, so the baseline below is genuinely recoverable
				// and the quiet control means something.
				const file = path.join(bucket, "Worker.jsonl");
				writeTranscript(file, id, cwdA);
				const log = path.join(sessions, SESSION_LOCATOR_FILE);
				fs.writeFileSync(log, "");
				const warn = spyOn(logger, "warn").mockImplementation(() => {});
				const error = spyOn(logger, "error").mockImplementation(() => {});
				try {
					// Quiet while nothing obstructs recovery: this is the control for
					// the obstruction below, in the same process and the same tree.
					fs.chmodSync(log, 0o400);
					expect(recordSessionLocation(id, file)).toBe(false);
					expect(error).not.toHaveBeenCalled();
					expect(warn).toHaveBeenCalledTimes(1);

					obstruct(sessions, bucket, file);
					expect(recordSessionLocation(id, file)).toBe(false);
					expect(warn).toHaveBeenCalledTimes(1);
					expect(error).toHaveBeenCalledTimes(1);
					expect(String(error.mock.calls[0]?.[0])).toContain("no reindex will recover this session");
					expect(error.mock.calls[0]?.[1]).toMatchObject({ id, file });
				} finally {
					fs.chmodSync(log, 0o600);
					fs.chmodSync(bucket, 0o700);
					fs.chmodSync(file, 0o600);
					const snapshot = path.join(sessions, SESSION_LOCATOR_BASE_FILE);
					if (fs.existsSync(snapshot)) fs.chmodSync(snapshot, 0o600);
					error.mockRestore();
					warn.mockRestore();
				}
			});
		}

		it.skipIf(unlessRoot)(
			"records a session moved while its index log could not be written, at its next write",
			async () => {
				const parent = await persistedSession(cwdA);
				const childId = "019a0013-0000-7000-8000-000000000001";
				const artifacts = parent.getSessionFile()!.slice(0, -".jsonl".length);
				writeTranscript(path.join(artifacts, "Worker.jsonl"), childId, cwdA);
				await rebuildSessionLocator(getSessionsDir());
				const log = path.join(getSessionsDir(), SESSION_LOCATOR_FILE);
				fs.chmodSync(log, 0o400);
				try {
					await parent.moveTo(cwdB);
				} finally {
					fs.chmodSync(log, 0o600);
				}
				const movedChild = path.join(parent.getSessionFile()!.slice(0, -".jsonl".length), "Worker.jsonl");
				parent.appendMessage({ role: "user", content: "after the log recovered", timestamp: 3 });
				await parent.flush();
				await parent.close();
				const cwdC = path.join(agentDir, "project-c");
				fs.mkdirSync(cwdC);
				expect((await resolveResumableSession(parent.getSessionId(), cwdC))?.session.path).toBe(
					parent.getSessionFile()!,
				);
				// The subagent transcript the move carried is not written again, and
				// nothing queues it: a reindex of its root is what derives it afresh.
				expect(await resolveResumableSession(childId, cwdC)).toBeUndefined();
				await rebuildSessionLocator(getSessionsDir());
				expect((await resolveResumableSession(childId, cwdC))?.session.path).toBe(movedChild);
			},
		);

		it.skipIf(unlessRoot)(
			"serialises reindexes of one root reached through a symlink and its real path",
			async () => {
				const childId = "019a0015-0000-7000-8000-000000000001";
				const child = path.join(getSessionsDir(), "--alias--", "parent", "Worker.jsonl");
				writeTranscript(child, childId, "/a");
				const alias = path.join(agentDir, "alias-root");
				fs.symlinkSync(getSessionsDir(), alias);
				fs.chmodSync(child, 0o000);
				// Hold the reindex through the alias inside its publish, just before its rename.
				const rename = fs.promises.rename.bind(fs.promises);
				const atRename = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
					if (path.resolve(String(to)) === path.join(alias, ".session-index.base.tsv")) {
						atRename.resolve();
						await release.promise;
					}
					return rename(from, to);
				});
				try {
					const stale = rebuildSessionLocator(alias);
					await atRename.promise;
					fs.chmodSync(child, 0o600);
					const fresh = rebuildSessionLocator(getSessionsDir());
					// Unserialised, the fresh reindex publishes now and the held one then
					// overwrites it; serialised, it waits for the held one's lock.
					await Promise.race([fresh, Bun.sleep(1_000)]);
					release.resolve();
					await stale;
					await fresh;
				} finally {
					release.resolve();
					renameSpy.mockRestore();
					fs.chmodSync(child, 0o600);
				}
				expect((await resolveResumableSession(childId, cwdB))?.session.path).toBe(child);
			},
		);

		it("clears a staged snapshot a killed reindex left behind", async () => {
			fs.mkdirSync(getSessionsDir(), { recursive: true });
			const leftover = path.join(getSessionsDir(), ".session-index.base.tsv.4242.dead.tmp");
			fs.writeFileSync(leftover, "partial");
			await rebuildSessionLocator(getSessionsDir());
			expect(fs.existsSync(leftover)).toBe(false);
		});

		it.skipIf(unlessRoot)("reports a symlinked transcript it cannot reach, and keeps what it knew", async () => {
			const childId = "019a0012-0000-7000-8000-000000000001";
			const dir = path.join(getSessionsDir(), "--links--", "parent");
			const target = path.join(agentDir, "elsewhere", "Real.jsonl");
			writeTranscript(target, childId, "/l");
			fs.mkdirSync(dir, { recursive: true });
			const link = path.join(dir, "Linked.jsonl");
			fs.symlinkSync(target, link);
			const loop = path.join(dir, "Loop.jsonl");
			fs.symlinkSync(loop, loop);
			expect((await rebuildSessionLocator(getSessionsDir())).indexed).toBe(1);
			fs.chmodSync(target, 0o000);
			let rebuilt: SessionLocatorRebuild;
			try {
				rebuilt = await rebuildSessionLocator(getSessionsDir());
			} finally {
				fs.chmodSync(target, 0o600);
			}
			expect(rebuilt.unreadable.map(entry => entry.bucket).sort()).toEqual([link, loop].sort());
			expect((await resolveResumableSession(childId, cwdB))?.session.path).toBe(link);
		});
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"finds a readable copy of a session when an older indexed copy cannot be read",
		async () => {
			const id = "019a0006-0000-7000-8000-000000000001";
			const older = path.join(getSessionsDir(), "--old--", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
			const newer = path.join(getSessionsDir(), "--new--", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
			writeTranscript(older, id, "/old");
			writeTranscript(newer, id, "/new");
			recordSessionLocation(id, older);
			recordSessionLocation(id, newer);
			fs.chmodSync(older, 0o000);
			try {
				expect((await resolveResumableSession(id, cwdB))?.session.path).toBe(newer);
				expect(await findSessionFiles(id)).toEqual([newer]);
				expect((await resolveResumeTarget(id, cwdB))?.session.path).toBe(newer);
			} finally {
				fs.chmodSync(older, 0o600);
			}
		},
	);

	it("follows a nested replaced file to its continuation after reindex", async () => {
		for (const [n, named] of ["019a0007-0000-7000-8000-000000000001", "worker_aa11"].entries()) {
			const dir = path.join(getSessionsDir(), `--nested-${n}--`, "parent");
			const replaced = path.join(dir, `2026-01-01T00-00-00-000Z_${named}.jsonl`);
			writeTranscript(replaced, `019a0007-1111-7000-8000-00000000000${n}`, "/nested");
			const continuation = path.join(dir, `2026-01-02T00-00-00-000Z_019a0007-2222-7000-8000-00000000000${n}.jsonl`);
			fs.writeFileSync(
				continuation,
				`${JSON.stringify({ type: "session", version: 3, id: `019a0007-2222-7000-8000-00000000000${n}`, timestamp: "2026-01-02T00:00:00.000Z", cwd: "/nested", parentSession: named, continuationOf: named })}\n${JSON.stringify({ type: "message", id: "t1", parentId: null, timestamp: "2026-01-02T00:00:01.000Z", message: { role: "user", content: "went on", timestamp: 1 } })}\n`,
			);
			await rebuildSessionLocator(getSessionsDir());
			expect({ named, path: (await resolveResumeTarget(named, cwdB))?.session.path }).toEqual({
				named,
				path: continuation,
			});
			expect(await resolveResumableSession(named, cwdB)).toBeUndefined();
		}
	});

	it("never answers an id with the session that now occupies its old path", async () => {
		const staleId = "019a0003-0000-7000-8000-000000000001";
		const otherId = "019a0003-0000-7000-8000-000000000002";
		const file = path.join(getSessionsDir(), "--project--", "parent", "Reviewer.jsonl");
		writeTranscript(file, staleId, "/p");
		recordSessionLocation(staleId, file);
		expect((await locateSessions(staleId)).map(hit => hit.path)).toEqual([file]);

		writeTranscript(file, otherId, "/p");
		expect(await locateSessions(staleId)).toEqual([]);
		expect(await findSessionFiles(staleId)).toEqual([]);
		expect(await resolveResumableSession(staleId, cwdB)).toBeUndefined();
		await expect(resolveSeanceSource(staleId, { cwd: cwdB, includeGlobal: true })).rejects.toThrow("was not found");
	});

	it("finds sessions of project paths holding a tab or a newline, before and after reindex", async () => {
		const ids: string[] = [];
		const files: string[] = [];
		for (const name of ["tab\there", "new\nline", "per%cent"]) {
			const cwd = path.join(agentDir, name);
			fs.mkdirSync(cwd);
			const session = await persistedSession(cwd);
			ids.push(session.getSessionId());
			files.push(session.getSessionFile()!);
			await session.close();
		}
		for (const pass of ["log", "reindexed"]) {
			if (pass === "reindexed") {
				fs.rmSync(path.join(getSessionsDir(), SESSION_LOCATOR_FILE));
				await rebuildSessionLocator(getSessionsDir());
			}
			for (let n = 0; n < ids.length; n++) {
				expect({ pass, path: (await resolveResumableSession(ids[n], cwdB))?.session.path }).toEqual({
					pass,
					path: files[n],
				});
			}
		}
	});

	it("`omp session pack <id>` consults the persisted session.extraRoots", async () => {
		const session = await persistedSession(cwdA);
		const id = session.getSessionId();
		await session.close();
		const moved = path.join(agentDir, "durable", "sessions");
		fs.mkdirSync(path.dirname(moved), { recursive: true });
		fs.renameSync(getSessionsDir(), moved);
		fs.writeFileSync(path.join(agentDir, "config.yml"), `session:\n  extraRoots:\n    - ${JSON.stringify(moved)}\n`);
		const out = path.join(agentDir, "pack.tar");
		const cli = path.join(import.meta.dir, "../src/cli.ts");
		const env: Record<string, string | undefined> = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
		delete env.PI_SESSION_EXTRA_ROOTS;
		const result = Bun.spawnSync([process.execPath, cli, "session", "pack", id, out], { cwd: cwdB, env });
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(fs.existsSync(out)).toBe(true);
	}, 60_000);
});

describe("session index: profiles", () => {
	const keys = ["PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "XDG_DATA_HOME"] as const;
	let saved: Partial<Record<(typeof keys)[number], string>>;
	let configRoot: string;
	let cwd: string;

	beforeEach(async () => {
		saved = {};
		for (const key of keys) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		const configDirName = `.omp-session-locator-${Snowflake.next()}`;
		configRoot = path.join(os.homedir(), configDirName);
		process.env.PI_CONFIG_DIR = configDirName;
		__resetDirsFromEnvForTests();
		configureSessionExtraRoots([]);
		cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-locator-cwd-"));
	});

	afterEach(async () => {
		configureSessionExtraRoots(undefined);
		closeSessionIndex();
		setProfile(undefined);
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		__resetDirsFromEnvForTests();
		await fsp.rm(configRoot, { recursive: true, force: true });
		await fsp.rm(cwd, { recursive: true, force: true });
	});

	it("resolves a session another profile created", async () => {
		setProfile("work");
		const session = await persistedSession(cwd);
		const id = session.getSessionId();
		const file = session.getSessionFile()!;
		await session.close();
		expect(file.startsWith(path.join(configRoot, "profiles", "work"))).toBe(true);

		setProfile(undefined);
		const otherCwd = path.join(cwd, "elsewhere");
		fs.mkdirSync(otherCwd);
		expect((await resolveResumableSession(id, otherCwd))?.session.path).toBe(file);
	});
});
