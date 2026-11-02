/**
 * Every caller that reads a `SqlSessionStorage` index synchronously first
 * refreshes the scope it reads, so a row another store on the same database
 * wrote after this one started is seen, and a row outside that scope is not
 * loaded. Each test opens the reading store first and writes through a second
 * store afterwards. These run against SQLite always, and against PostgreSQL
 * and MySQL when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a
 * throwaway database; every test makes its own tables and drops them.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadAdvisorTranscriptCosts } from "@oh-my-pi/pi-coding-agent/advisor/transcript-recorder";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createReportBundle } from "@oh-my-pi/pi-coding-agent/debug/report-bundle";
import { sessionFilesFromDisk } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { collectThreads } from "@oh-my-pi/pi-coding-agent/memories";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { loadSessionFile, visitEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import {
	findRecentSessionContinuation,
	findSessionContinuation,
	findSessionFiles,
	getRecentSessions,
	listAllSessionsForPicker,
	listSessionsForPicker,
	readSessionInfo,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	sessionDirForCwd,
	worktreeSessionDirs,
	writeTerminalBreadcrumb,
} from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { defaultSessionStorage, setDefaultSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { moveTranscriptTree } from "@oh-my-pi/pi-coding-agent/session/session-transcript-tree";
import { createSessionWorktree } from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import {
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	type SqlSessionStorageTransaction,
	SqlSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { collectSubSessions } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import {
	getBlobsDir,
	getConfigRootDir,
	getSessionsDir,
	getTerminalSessionsDir,
	setAgentDir,
	TempDir,
} from "@oh-my-pi/pi-utils";
import { $, SQL } from "bun";
import { sessionSqlTestClient } from "../helpers/session-sql-client";
import { beginSettingsTest, restoreSettingsTestState } from "../helpers/settings-test-state";

type SqlClient = InstanceType<typeof SQL>;

const BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite::memory:" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

/** Every index load `SqlSessionStorage` issues starts this way, at PR 1's head and after. */
const INDEX_READ = "SELECT path, mtime_ms";

const TIMESTAMP = "2026-11-02T00:00:00.000Z";

function entries(id: string, cwd: string, text: string): object[] {
	return [
		{ type: "session", version: 3, id, timestamp: TIMESTAMP, cwd },
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: TIMESTAMP,
			message: { role: "user", content: text, timestamp: 1 },
		},
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: TIMESTAMP,
			message: {
				role: "assistant",
				content: [{ type: "text", text: `${text} reply` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: { cost: { total: 0.5 } },
				stopReason: "stop",
				timestamp: 2,
			},
		},
	];
}

/** A current-version transcript: title slot, header, one user turn, one assistant reply. */
function transcript(id: string, cwd: string, text: string): string {
	const lines = entries(id, cwd, text).map(entry => JSON.stringify(entry));
	return `${serializeTitleSlot({ updatedAt: TIMESTAMP })}${lines.join("\n")}\n`;
}

/** The same transcript without a title slot, as the advisor recorder writes one. */
function bareTranscript(id: string, cwd: string, text: string): string {
	return `${entries(id, cwd, text)
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
}

/** The session file `<root>/<bucket>/<timestamp>_<id>.jsonl`, as `SessionManager` names one. */
function sessionFile(root: string, bucket: string, id: string): string {
	return path.join(root, bucket, `2026-11-02T00-00-00-000Z_${id}.jsonl`);
}

/** A client over `client` that counts every index load. */
function countingClient(client: SqlClient, reads: string[]): SqlSessionStorageClient {
	const run = async (sql: string, values: unknown[] | undefined, executor: SqlSessionStorageTransaction) => {
		if (sql.startsWith(INDEX_READ)) reads.push(sql);
		return executor.unsafe(sql, values);
	};
	return {
		options: client.options,
		unsafe: (sql, values) => run(sql, values, client),
		transaction: work =>
			client.transaction(transaction => work({ unsafe: (sql, values) => run(sql, values, transaction) })),
	};
}

let tableSeq = 0;

/** One test's tables on one database, dropped when done. */
class Db implements AsyncDisposable {
	readonly table = `omp_sc_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	readonly client: SqlClient;

	constructor(
		readonly adapter: SqlSessionStorageAdapter,
		readonly url: string,
		readonly root: string,
	) {
		this.client = sessionSqlTestClient(url);
	}

	open(client: SqlSessionStorageClient = this.client): Promise<SqlSessionStorage> {
		return SqlSessionStorage.create({ client, table: this.table, sessionsRoot: this.root, adapter: this.adapter });
	}

	/** A second store on the same database, as another omp process holds, with `files` written and published. */
	async peerWrites(files: ReadonlyArray<[string, string]>): Promise<SqlSessionStorage> {
		const writer = await this.open();
		for (const [file, content] of files) await writer.writeText(file, content);
		await writer.drain();
		return writer;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_parts`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_meta`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}`);
		await this.client.end();
	}
}

/** One test's scratch directories: the sessions root, a working directory, and the agent directory. */
function scratch(): { tempDir: TempDir; root: string; cwd: string } {
	const tempDir = TempDir.createSync("@omp-scoped-callers-");
	return { tempDir, root: tempDir.join("sessions"), cwd: tempDir.join("proj") };
}

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPane = process.env.TMUX_PANE;
const originalStorage = defaultSessionStorage();

afterEach(() => {
	vi.restoreAllMocks();
	setDefaultSessionStorage(originalStorage);
	if (originalPane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = originalPane;
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(path.join(getConfigRootDir(), "agent"));
		delete process.env.PI_CODING_AGENT_DIR;
	}
});

const ORIGINAL_ID = "01a00000-0000-7000-8000-0000000000e8";
const CONTINUATION_ID = "01a00000-0000-7000-8000-0000000000e9";

/** The session `ORIGINAL_ID` continued in a later file: its turns, then one more. */
function continuationTranscript(cwd: string): string {
	const later = "2026-11-02T00:05:00.000Z";
	const [, ...turns] = entries(ORIGINAL_ID, cwd, "before");
	const lines = [
		{ type: "session", version: 3, id: CONTINUATION_ID, timestamp: later, cwd, continuationOf: ORIGINAL_ID },
		...turns,
		{
			type: "message",
			id: "m3",
			parentId: "m2",
			timestamp: later,
			message: { role: "user", content: "after", timestamp: 3 },
		},
		{
			type: "message",
			id: "m4",
			parentId: "m3",
			timestamp: later,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "after reply" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: {},
				stopReason: "stop",
				timestamp: 4,
			},
		},
	].map(entry => JSON.stringify(entry));
	return `${serializeTitleSlot({ updatedAt: later })}${lines.join("\n")}\n`;
}

/** Host git settings must not leak into the fixture repository; worktrees stay under the temp root. */
const GIT_ENV_KEYS = [
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"OMP_WORKTREE_DIR",
] as const;

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`SqlSessionStorage scoped callers (${adapter})`, () => {
		it("--continue climbs this terminal's breadcrumb to a root session another store wrote", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			setAgentDir(tempDir.join("agent"));
			process.env.TMUX_PANE = `%scoped-callers-${adapter}`;
			await fs.rm(getTerminalSessionsDir(), { recursive: true, force: true });
			const dir = path.join(root, "-proj");
			const parent = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000c1");
			const child = path.join(parent.slice(0, -".jsonl".length), "Worker.jsonl");
			const newer = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000c2");

			const reader = await db.open();
			setDefaultSessionStorage(reader);
			await db.peerWrites([
				[parent, transcript("01a00000-0000-7000-8000-0000000000c1", cwd, "parent")],
				[child, transcript("child", cwd, "child")],
				[newer, transcript("01a00000-0000-7000-8000-0000000000c2", cwd, "newer")],
			]);
			// A subagent open left this terminal's breadcrumb on the child.
			writeTerminalBreadcrumb(cwd, child);

			const manager = await SessionManager.continueRecent(cwd, dir, reader);
			try {
				expect(manager.getSessionFile()).toBe(parent);
			} finally {
				await manager.close();
			}
		});

		it("history:// discovery lists the subagent transcripts another store wrote", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const parent = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000d1");
			const stem = parent.slice(0, -".jsonl".length);
			const other = sessionFile(root, "-other", "01a00000-0000-7000-8000-0000000000d2");

			const reader = await db.open();
			await db.peerWrites([
				[path.join(stem, "Worker.jsonl"), transcript("w", cwd, "worker")],
				[path.join(stem, "Worker", "Helper.jsonl"), transcript("h", cwd, "helper")],
				[other, transcript("o", cwd, "other")],
			]);

			const found = await sessionFilesFromDisk(stem, { onlyPreferred: true, storage: reader });

			expect([...found.keys()].sort()).toEqual(["Helper", "Worker"]);
			expect(reader.existsSync(other)).toBe(false);
		});

		it("export and /dump collect the subagent sessions another store wrote", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const parent = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000e1");
			const stem = parent.slice(0, -".jsonl".length);
			const other = sessionFile(root, "-other", "01a00000-0000-7000-8000-0000000000e2");

			const reader = await db.open();
			await db.peerWrites([
				[parent, transcript("01a00000-0000-7000-8000-0000000000e1", cwd, "parent")],
				[path.join(stem, "Worker.jsonl"), transcript("w", cwd, "worker")],
				[path.join(stem, "Worker", "Helper.jsonl"), transcript("h", cwd, "helper")],
				[other, transcript("o", cwd, "other")],
			]);

			const subs = await collectSubSessions(parent, { storage: reader });

			expect(Object.keys(subs).sort()).toEqual(["Worker", "Worker/Helper"]);
			expect(reader.existsSync(other)).toBe(false);
		});

		it("reads the info of a session another store wrote", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const id = "01a00000-0000-7000-8000-0000000000f1";
			const file = sessionFile(root, "-proj", id);
			const reader = await db.open();
			setDefaultSessionStorage(reader);
			await db.peerWrites([[file, transcript(id, cwd, "info")]]);

			expect((await readSessionInfo(file))?.id).toBe(id);
		});

		it("loads and visits the entries of a session another store wrote", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const id = "01a00000-0000-7000-8000-0000000000f2";
			const file = sessionFile(root, "-proj", id);
			const loading = await db.open();
			const visiting = await db.open();
			await db.peerWrites([[file, transcript(id, cwd, "entries")]]);

			const loaded = await loadSessionFile(file, loading);
			const visited: string[] = [];
			await visitEntriesFromFile(file, entry => void visited.push(entry.type), visiting);

			expect(loaded.entries.map(entry => entry.type)).toEqual(["session", "message", "message"]);
			expect(visited).toEqual(["session", "message", "message"]);
		});

		it("the history:// roster climbs from a subagent to a root session this process never loaded", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const parent = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000a1");
			const stem = parent.slice(0, -".jsonl".length);
			const worker = path.join(stem, "Worker.jsonl");
			const sibling = path.join(stem, "Sibling.jsonl");

			const reader = await db.open();
			await db.peerWrites([
				[parent, transcript("01a00000-0000-7000-8000-0000000000a1", cwd, "root")],
				[worker, transcript("worker", cwd, "worker brief")],
				[sibling, transcript("sibling", cwd, "sibling brief")],
			]);

			const registry = new AgentRegistry();
			expect(await ensurePersistedRoster(registry, worker, reader)).toBe(parent);
			expect(registry.get("Sibling")?.sessionFile).toBe(sibling);
		});

		it("the recent-session list reads its own directory, with sessions another store wrote", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const file = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000b1");
			const other = sessionFile(root, "-other", "01a00000-0000-7000-8000-0000000000b2");
			const reader = await db.open();
			await db.peerWrites([
				[file, transcript("01a00000-0000-7000-8000-0000000000b1", cwd, "recent")],
				[other, transcript("01a00000-0000-7000-8000-0000000000b2", cwd, "elsewhere")],
			]);

			const recent = await getRecentSessions(path.dirname(file), 4, reader);

			expect(recent.map(session => session.path)).toEqual([file]);
			expect(reader.existsSync(other)).toBe(false);
		});

		it("the global resume-by-id search sees another store's session and reads the table once per window", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			let now = performance.now();
			vi.spyOn(performance, "now").mockImplementation(() => now);
			const id = "01a00000-0000-7000-8000-0000000000b3";
			const file = sessionFile(root, "-proj", id);
			const reads: string[] = [];
			const reader = await db.open(countingClient(db.client, reads));
			await db.peerWrites([[file, transcript(id, cwd, "global")]]);

			expect(await findSessionFiles(id.slice(0, 8), root, reader)).toEqual([file]);
			now += 1000;
			expect(await findSessionFiles(id.slice(0, 8), root, reader)).toEqual([file]);
			expect(reads).toHaveLength(1);
		});

		it("the resume picker reads its directory, with sessions another store wrote", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const file = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000b4");
			const other = sessionFile(root, "-other", "01a00000-0000-7000-8000-0000000000b5");
			const reader = await db.open();
			await db.peerWrites([
				[file, transcript("01a00000-0000-7000-8000-0000000000b4", cwd, "picked")],
				[other, transcript("01a00000-0000-7000-8000-0000000000b5", cwd, "elsewhere")],
			]);

			const listing = await listSessionsForPicker(path.dirname(file), reader, new Set());

			expect((await listing.complete).map(session => session.path)).toEqual([file]);
			expect(reader.existsSync(other)).toBe(false);
		});

		it("memory collection reads the session's directory, with sessions another store wrote", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const id = "01a00000-0000-7000-8000-0000000000b6";
			const file = sessionFile(root, "-proj", id);
			const other = sessionFile(root, "-other", "01a00000-0000-7000-8000-0000000000b7");
			const reader = await db.open();
			await db.peerWrites([
				[file, transcript(id, cwd, "remember")],
				[other, transcript("01a00000-0000-7000-8000-0000000000b7", cwd, "elsewhere")],
			]);
			// Only the session manager's directory and storage are read.
			const session = {
				sessionManager: { getSessionDir: () => path.dirname(file), getStorage: () => reader },
			} as unknown as AgentSession;

			const threads = await collectThreads(session);

			expect(threads.map(thread => thread.id)).toEqual([id]);
			expect(reader.existsSync(other)).toBe(false);
		});

		it("subagent id allocation reserves a transcript another store wrote, reading only that directory", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const stem = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000b8").slice(0, -".jsonl".length);
			const other = sessionFile(root, "-other", "01a00000-0000-7000-8000-0000000000b9");
			const reader = await db.open();
			await db.peerWrites([
				[path.join(stem, "Worker.jsonl"), transcript("w", cwd, "worker")],
				[other, transcript("o", cwd, "elsewhere")],
			]);

			const outputs = new AgentOutputManager(() => stem, { storage: reader });

			expect(await outputs.allocate("Worker")).toBe("Worker-2");
			expect(reader.existsSync(other)).toBe(false);
		});

		it("resume restores the cost of an advisor transcript another store wrote, reading only its session", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const parent = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000ba");
			const stem = parent.slice(0, -".jsonl".length);
			const other = sessionFile(root, "-other", "01a00000-0000-7000-8000-0000000000bb");
			const reader = await db.open();
			await db.peerWrites([
				[path.join(stem, "__advisor.jsonl"), bareTranscript("advisor", cwd, "advice")],
				[other, transcript("o", cwd, "elsewhere")],
			]);

			const costs = await loadAdvisorTranscriptCosts(parent, { storage: reader });

			expect([...costs]).toEqual([["", 0.5]]);
			expect(reader.existsSync(other)).toBe(false);
		});

		it("a tree move carries children another store wrote, reading only the two trees", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const from = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000bc").slice(0, -".jsonl".length);
			const to = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000bd").slice(0, -".jsonl".length);
			const other = sessionFile(root, "-other", "01a00000-0000-7000-8000-0000000000be");
			const reader = await db.open();
			await db.peerWrites([
				[path.join(from, "Worker.jsonl"), transcript("w", cwd, "worker")],
				[path.join(from, "Worker", "Helper.jsonl"), transcript("h", cwd, "helper")],
				[other, transcript("o", cwd, "elsewhere")],
			]);

			const moved = await moveTranscriptTree(reader, from, to);

			expect(moved.map(placement => placement.to).sort()).toEqual([
				path.join(to, "Worker.jsonl"),
				path.join(to, "Worker", "Helper.jsonl"),
			]);
			expect(reader.existsSync(other)).toBe(false);

			// A destination child another store wrote since stops the next move whole.
			const next = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000bf").slice(0, -".jsonl".length);
			await db.peerWrites([[path.join(next, "Worker.jsonl"), transcript("taken", cwd, "taken")]]);
			await expect(moveTranscriptTree(reader, to, next)).rejects.toMatchObject({
				code: "EEXIST",
				path: path.join(next, "Worker.jsonl"),
			});
			expect(reader.existsSync(path.join(to, "Worker", "Helper.jsonl"))).toBe(true);
		});

		it("deleting a session removes children another store wrote, reading only that session", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const parent = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000bf");
			const child = path.join(parent.slice(0, -".jsonl".length), "Late.jsonl");
			const other = sessionFile(root, "-other", "01a00000-0000-7000-8000-0000000000c0");
			const reader = await db.open();
			await db.peerWrites([
				[parent, transcript("01a00000-0000-7000-8000-0000000000bf", cwd, "doomed")],
				[child, transcript("late", cwd, "late child")],
				[other, transcript("o", cwd, "elsewhere")],
			]);

			await reader.deleteSessionWithArtifacts(parent);
			await reader.drain();

			expect(reader.existsSync(other)).toBe(false);
			const fresh = await db.open();
			expect([await fresh.exists(parent), await fresh.exists(child), await fresh.exists(other)]).toEqual([
				false,
				false,
				true,
			]);
		});

		it("loads a key whose next character after its directory or session sorts below a space", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const dir = path.join(root, "-proj");
			const parent = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000c3");
			const stem = parent.slice(0, -".jsonl".length);
			const inDir = [path.join(dir, "\u0001low.jsonl"), path.join(dir, "\tTab.jsonl")];
			const inSession = [path.join(stem, "\u0001Low.jsonl"), path.join(stem, "\tTab.jsonl")];
			// Just past each range's bound: a sibling of the directory, and a sibling of the session's artifacts.
			const outside = [path.join(root, "-proj.x.jsonl"), `${stem}0.jsonl`];
			await db.peerWrites([...inDir, ...inSession, ...outside].map(file => [file, transcript("k", cwd, "k")]));

			const byDir = await db.open();
			await byDir.refresh({ kind: "dir", dir });
			const bySession = await db.open();
			await bySession.refresh({ kind: "session", file: parent });

			expect(inDir.map(file => byDir.existsSync(file))).toEqual([true, true]);
			expect(inSession.map(file => bySession.existsSync(file))).toEqual([true, true]);
			// Each range stops at its own bound: the directory before `-proj.`, the session before `<stem>0`.
			expect([byDir.existsSync(outside[0] ?? ""), bySession.existsSync(outside[1] ?? "")]).toEqual([false, false]);
		});

		it("a directory scope of the sessions root loads every root-relative row, and no row keyed abs:", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const underRoot = [
				path.join(root, "top.jsonl"),
				sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000c4"),
			];
			// Keyed `abs:`: a sibling of the root whose name starts with the root's, and a path elsewhere.
			const sibling = `${root}x/s.jsonl`;
			const elsewhere = "/srv/elsewhere/s.jsonl";
			await db.peerWrites(
				[...underRoot, sibling, elsewhere].map(file => [file, transcript("r", cwd, "r")] as [string, string]),
			);

			const byRoot = await db.open();
			await byRoot.refresh({ kind: "dir", dir: root });

			expect(underRoot.map(file => byRoot.existsSync(file))).toEqual([true, true]);
			expect([byRoot.existsSync(sibling), byRoot.existsSync(elsewhere)]).toEqual([false, false]);
			expect((await getRecentSessions(root, 4, byRoot)).map(session => session.path)).toEqual([underRoot[0]]);
		});

		it("a directory scope of a directory holding the sessions root loads its abs: rows and every root-relative row", async () => {
			const { tempDir, cwd } = scratch();
			using _ = tempDir;
			// The root two levels below the listed directory.
			const holder = tempDir.join("home");
			const root = path.join(holder, "agent", "sessions");
			await using db = new Db(adapter, url ?? "", root);
			const underRoot = [
				path.join(root, "top.jsonl"),
				sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000c6"),
			];
			// Keyed `abs:` under the holder: a file beside the root's parent, and a sibling of the root.
			const besideRoot = [path.join(holder, "beside.jsonl"), path.join(holder, "agent", "sessionsx", "s.jsonl")];
			// Keyed `abs:` outside the holder: a sibling whose name starts with the holder's, and a path elsewhere.
			const outside = [`${holder}x/s.jsonl`, "/srv/elsewhere/s.jsonl"];
			await db.peerWrites(
				[...underRoot, ...besideRoot, ...outside].map(
					file => [file, transcript("d", cwd, "d")] as [string, string],
				),
			);

			const byHolder = await db.open();
			await byHolder.refresh({ kind: "dir", dir: holder });

			expect([...underRoot, ...besideRoot].map(file => byHolder.existsSync(file))).toEqual([true, true, true, true]);
			expect(outside.map(file => byHolder.existsSync(file))).toEqual([false, false]);
		});

		it("a session scope whose artifacts directory holds the sessions root loads every root-relative row", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			// A session file beside the directory that holds the root: its artifacts directory is that directory.
			const holder = path.dirname(root);
			const session = `${holder}.jsonl`;
			const underRoot = [
				path.join(root, "top.jsonl"),
				sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000c5"),
			];
			const beside = path.join(holder, "beside.jsonl");
			const elsewhere = "/srv/elsewhere/s.jsonl";
			await db.peerWrites(
				[session, ...underRoot, beside, elsewhere].map(
					file => [file, transcript("h", cwd, "h")] as [string, string],
				),
			);

			const storage = await db.open();
			await storage.refresh({ kind: "session", file: session });

			expect([session, ...underRoot, beside].map(file => storage.existsSync(file))).toEqual([
				true,
				true,
				true,
				true,
			]);
			expect(storage.existsSync(elsewhere)).toBe(false);
		});

		it("the debug report bundles a subagent transcript another store wrote, reading only its session", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			setAgentDir(tempDir.join("agent"));
			const parent = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000d3");
			const other = sessionFile(root, "-other", "01a00000-0000-7000-8000-0000000000d4");
			const reader = await db.open();
			await db.peerWrites([
				[parent, transcript("01a00000-0000-7000-8000-0000000000d3", cwd, "reported")],
				[path.join(parent.slice(0, -".jsonl".length), "Worker.jsonl"), transcript("w", cwd, "worker")],
				[other, transcript("o", cwd, "elsewhere")],
			]);

			const bundle = await createReportBundle({ sessionFile: parent, storage: reader });

			expect(bundle.files).toContain("session.jsonl");
			expect(bundle.files).toContain("artifacts/Worker.jsonl");
			expect(reader.existsSync(other)).toBe(false);
		}, 30_000);

		it("resume follows a continuation another store wrote, reading only that directory", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const original = path.join(root, "-proj", `2026-11-02T00-00-00-000Z_${ORIGINAL_ID}.jsonl`);
			const continuation = path.join(root, "-proj", `2026-11-02T00-05-00-000Z_${CONTINUATION_ID}.jsonl`);
			const other = sessionFile(root, "-other", "01a00000-0000-7000-8000-0000000000d5");
			const findReader = await db.open();
			const recentReader = await db.open();
			await db.peerWrites([
				[original, transcript(ORIGINAL_ID, cwd, "before")],
				[continuation, continuationTranscript(cwd)],
				[other, transcript("o", cwd, "elsewhere")],
			]);

			const found = await findSessionContinuation(original, findReader);
			const recent = await findRecentSessionContinuation(original, recentReader);

			expect([found?.session.path, recent?.session.path]).toEqual([continuation, continuation]);
			expect([findReader.existsSync(other), recentReader.existsSync(other)]).toEqual([false, false]);
		});

		it("the all-projects picker lists every project's sessions another store wrote, reading the table once per window", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			let now = performance.now();
			vi.spyOn(performance, "now").mockImplementation(() => now);
			const first = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000d6");
			const second = sessionFile(root, "-other", "01a00000-0000-7000-8000-0000000000d7");
			const reads: string[] = [];
			const reader = await db.open(countingClient(db.client, reads));
			await db.peerWrites([
				[first, transcript("01a00000-0000-7000-8000-0000000000d6", cwd, "one")],
				[second, transcript("01a00000-0000-7000-8000-0000000000d7", cwd, "two")],
			]);

			const listed = async (): Promise<string[]> =>
				(await (await listAllSessionsForPicker(reader, new Set(), root)).complete)
					.map(session => session.path)
					.sort();
			expect(await listed()).toEqual([first, second].sort());
			now += 1000;
			expect(await listed()).toEqual([first, second].sort());
			expect(reads).toHaveLength(1);
		});

		it("a fork copies the subagent transcripts of a session another store wrote, reading only the two sessions", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const source = sessionFile(root, "-proj", "01a00000-0000-7000-8000-0000000000d8");
			const other = sessionFile(root, "-other", "01a00000-0000-7000-8000-0000000000d9");
			const reader = await db.open();
			await db.peerWrites([
				[source, transcript("01a00000-0000-7000-8000-0000000000d8", cwd, "forked")],
				[path.join(source.slice(0, -".jsonl".length), "Worker.jsonl"), transcript("w", cwd, "worker")],
				[other, transcript("o", cwd, "elsewhere")],
			]);

			const fork = await SessionManager.forkFrom(source, cwd, path.join(root, "-fork"), reader, {
				suppressBreadcrumb: true,
			});
			const forked = fork.getSessionFile() ?? "";
			await fork.close();
			await reader.drain();

			expect(reader.existsSync(other)).toBe(false);
			const fresh = await db.open();
			expect(await fresh.exists(path.join(forked.slice(0, -".jsonl".length), "Worker.jsonl"))).toBe(true);
		});

		it("a move refuses a destination another store wrote a session to, reading only the two sessions", async () => {
			const { tempDir, root, cwd } = scratch();
			using _ = tempDir;
			await using db = new Db(adapter, url ?? "", root);
			const reader = await db.open();
			const manager = SessionManager.create(cwd, path.join(root, "-proj"), reader);
			manager.appendMessage({ role: "user", content: "moving", timestamp: 1 });
			// The reply materializes the session, so the move has a file to move.
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			});
			await manager.flush();
			await reader.drain();
			const source = manager.getSessionFile() ?? "";
			const destination = path.join(root, "-dest", path.basename(source));
			const other = sessionFile(root, "-other", "01a00000-0000-7000-8000-0000000000da");
			try {
				await db.peerWrites([
					[destination, transcript("01a00000-0000-7000-8000-0000000000db", cwd, "someone else's")],
					[other, transcript("o", cwd, "elsewhere")],
				]);

				await expect(manager.moveTo(tempDir.join("dest"), path.join(root, "-dest"))).rejects.toThrow(
					"holds another session",
				);
				expect(manager.getSessionFile()).toBe(source);
				expect(reader.existsSync(other)).toBe(false);
			} finally {
				await manager.close();
			}
		});

		it.skipIf(process.platform === "win32")(
			"the picker's managed-worktree siblings include a bucket another store wrote, reading only those buckets",
			async () => {
				const { tempDir, cwd } = scratch();
				using _ = tempDir;
				const base = await fs.realpath(tempDir.path());
				const saved = Object.fromEntries(GIT_ENV_KEYS.map(key => [key, process.env[key]]));
				Object.assign(process.env, {
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_AUTHOR_NAME: "Test",
					GIT_AUTHOR_EMAIL: "test@example.com",
					GIT_COMMITTER_NAME: "Test",
					GIT_COMMITTER_EMAIL: "test@example.com",
					OMP_WORKTREE_DIR: path.join(base, "wt-base"),
				});
				try {
					setAgentDir(path.join(base, "agent"));
					const repo = path.join(base, "repo");
					await fs.mkdir(repo, { recursive: true });
					await $`git init -q && git commit -q --allow-empty -m init`.cwd(repo).quiet();
					await using db = new Db(adapter, url ?? "", getSessionsDir());
					const reader = await db.open();
					const { path: worktree } = await createSessionWorktree(repo, Settings.isolated(), "wt/gone");
					await $`git worktree remove --force ${worktree} && git worktree prune`.cwd(repo).quiet();
					const bucket = sessionDirForCwd(worktree);
					const other = path.join(
						sessionDirForCwd(path.join(base, "elsewhere")),
						"2026-11-02T00-00-00-000Z_o.jsonl",
					);
					await db.peerWrites([
						[path.join(bucket, "2026-11-02T00-00-00-000Z_w.jsonl"), transcript("w", worktree, "in the worktree")],
						[other, transcript("o", cwd, "elsewhere")],
					]);

					const siblings = await worktreeSessionDirs(repo, sessionDirForCwd(repo), reader);

					expect(siblings).toContain(bucket);
					expect(reader.existsSync(other)).toBe(false);
				} finally {
					for (const key of GIT_ENV_KEYS) {
						if (saved[key] === undefined) delete process.env[key];
						else process.env[key] = saved[key];
					}
				}
			},
		);
	});
}

/**
 * `omp gc` resolves the configured storage itself, on the default table, so
 * this runs on a SQLite file only: the shared test databases' default table
 * is not this test's to sweep.
 */
describe("omp gc --blobs with sessions another store wrote", () => {
	it("keeps a blob a subagent transcript another store wrote references", async () => {
		const { tempDir, cwd } = scratch();
		using _ = tempDir;
		const root = tempDir.path();
		const settings = beginSettingsTest();
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const savedStorage = process.env.OMP_SESSION_STORAGE;
		const savedDsn = process.env.OMP_SESSION_SQL_DSN_FILE;
		delete process.env.OMP_SESSION_STORAGE;
		delete process.env.OMP_SESSION_SQL_DSN_FILE;
		const url = `sqlite:${path.join(root, "sessions.db")}`;
		const early = new SQL(url);
		const late = new SQL(url);
		try {
			await Bun.write(path.join(root, "session.dsn"), url);
			await Bun.write(
				path.join(root, "config.yml"),
				["session:", "  storage: sql", "  sql:", `    dsnFile: ${path.join(root, "session.dsn")}`, ""].join("\n"),
			);
			const hash = (label: string): string => new Bun.SHA256().update(label).digest("hex");
			const aged = async (label: string): Promise<string> => {
				const blob = path.join(getBlobsDir(root), hash(label));
				await Bun.write(blob, label);
				const old = new Date(Date.now() - 86_400_000);
				await fs.utimes(blob, old, old);
				return blob;
			};
			const referenced = await aged("referenced");
			const orphan = await aged("orphan");
			// This process's store started before another wrote the session.
			await SqlSessionStorage.create({ client: early });
			const writer = await SqlSessionStorage.create({ client: late });
			const parent = path.join(getSessionsDir(root), "-proj", "2026-11-02T00-00-00-000Z_gc.jsonl");
			await writer.writeText(parent, transcript("gc", cwd, "no blob here"));
			await writer.writeText(
				path.join(parent.slice(0, -".jsonl".length), "Worker.jsonl"),
				transcript("w", cwd, `blob:sha256:${hash("referenced")}`),
			);
			await writer.drain();

			const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

			expect([await Bun.file(referenced).exists(), await Bun.file(orphan).exists()]).toEqual([true, false]);
			expect(result.blobs).toMatchObject({ referenced: 1, deleted: 1, errors: [] });
		} finally {
			stdout.mockRestore();
			if (savedStorage === undefined) delete process.env.OMP_SESSION_STORAGE;
			else process.env.OMP_SESSION_STORAGE = savedStorage;
			if (savedDsn === undefined) delete process.env.OMP_SESSION_SQL_DSN_FILE;
			else process.env.OMP_SESSION_SQL_DSN_FILE = savedDsn;
			await early.end();
			await late.end();
			restoreSettingsTestState(settings);
			AgentStorage.close();
		}
	});
});
