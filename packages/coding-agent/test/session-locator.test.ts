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
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import {
	archiveRootFor,
	configureSessionExtraRoots,
	locateSessions,
	rebuildSessionLocator,
	recordSessionLocation,
	SESSION_LOCATOR_FILE,
	sessionLocatorMayBeIncomplete,
} from "@oh-my-pi/pi-coding-agent/session/session-locator";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeDefaultSessionDir } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { resolveSeanceSource } from "@oh-my-pi/pi-coding-agent/task/seance";
import { getConfigRootDir, getSessionsDir, setAgentDir, Snowflake } from "@oh-my-pi/pi-utils";
import { __resetDirsFromEnvForTests, setProfile } from "@oh-my-pi/pi-utils/dirs";
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
