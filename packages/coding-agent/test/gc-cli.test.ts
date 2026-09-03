import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { withStatsSyncLock } from "@oh-my-pi/omp-stats/aggregator";
import { type GcResult, runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	getAgentDir,
	getBlobsDir,
	getHistoryDbPath,
	getSessionsDir,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { runCli } from "../src/cli";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let root: string;
let writes: string[] = [];
let stderrWrites: string[] = [];
let stdoutSpy: { mockRestore(): void } | undefined;
let stderrSpy: { mockRestore(): void } | undefined;
let settingsState: SettingsTestState | undefined;
const originalExitCode = process.exitCode;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gc-"));
	writes = [];
	stderrWrites = [];
	process.exitCode = 0;
	stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(String(chunk));
		return true;
	});
	stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
		stderrWrites.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	stdoutSpy?.mockRestore();
	stdoutSpy = undefined;
	stderrSpy?.mockRestore();
	stderrSpy = undefined;
	process.exitCode = originalExitCode;
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	await fs.rm(root, { recursive: true, force: true });
});

function hashFor(label: string): string {
	return new Bun.SHA256().update(label).digest("hex");
}

async function writeSession(
	agentDir: string,
	project: string,
	id: string,
	status: "complete" | "pending" | "interrupted",
	options: { blobRef?: string; ageDays?: number; filename?: string } = {},
): Promise<string> {
	const sessionDir = path.join(getSessionsDir(agentDir), project);
	await fs.mkdir(sessionDir, { recursive: true });
	const file = path.join(sessionDir, `${options.filename ?? id}.jsonl`);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
	];
	if (options.blobRef) {
		lines.push(JSON.stringify({ type: "message", message: { role: "user", content: options.blobRef } }));
	}
	if (status === "complete") {
		lines.push(JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }));
	} else if (status === "pending") {
		lines.push(JSON.stringify({ type: "message", message: { role: "user", content: "waiting" } }));
	} else {
		lines.push(
			JSON.stringify({
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "tool-1" }] },
			}),
		);
	}
	await Bun.write(file, `${lines.join("\n")}\n`);
	if (options.ageDays !== undefined) {
		const ts = new Date(Date.now() - options.ageDays * 86_400_000);
		await fs.utimes(file, ts, ts);
	}
	return file;
}

async function writeBlob(agentDir: string, hash: string, content: string): Promise<string> {
	const file = path.join(getBlobsDir(agentDir), hash);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, content);
	return file;
}

async function agePath(file: string, ageDays = 1): Promise<void> {
	const ts = new Date(Date.now() - ageDays * 86_400_000);
	await fs.utimes(file, ts, ts);
}

async function writeConfig(agentDir: string, body: string): Promise<void> {
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(path.join(agentDir, "config.yml"), body);
}

async function writeProjectConfig(projectDir: string, body: string): Promise<void> {
	const configDir = path.join(projectDir, ".omp");
	await fs.mkdir(configDir, { recursive: true });
	await Bun.write(path.join(configDir, "config.yml"), body);
}

describe("runGcCommand blob sweep", () => {
	test("uses the active configured agent dir when --agent-dir is omitted", async () => {
		const originalAgentDir = getAgentDir();
		try {
			setAgentDir(root);
			await agePath(await writeBlob(root, hashFor("orphan"), "orphan"));

			const result = await runGcCommand({ flags: { blobs: true } });

			expect(result.agentDir).toBe(root);
			expect(result.blobs?.wouldDelete).toBe(1);
		} finally {
			setAgentDir(originalAgentDir);
		}
	});

	test("dry-run reports unreferenced blobs without deleting them", async () => {
		const hash = hashFor("orphan");
		const blob = await writeBlob(root, hash, "orphan");
		await agePath(blob);

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true } });

		expect(result.blobs?.wouldDelete).toBe(1);
		expect(result.blobs?.deleted).toBe(0);
		expect(await Bun.file(blob).exists()).toBe(true);
	});

	test("--apply deletes unreferenced blobs and keeps referenced blobs", async () => {
		const orphanHash = hashFor("orphan");
		const referencedHash = hashFor("referenced");
		const orphan = await writeBlob(root, orphanHash, "orphan");
		const referenced = await writeBlob(root, referencedHash, "referenced");
		await agePath(orphan);
		await agePath(referenced);
		await writeSession(root, "project", "session-1", "complete", {
			blobRef: `blob:sha256:${referencedHash}`,
		});

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.wouldDelete).toBe(1);
		expect(result.blobs?.deleted).toBe(1);
		expect(await Bun.file(orphan).exists()).toBe(false);
		expect(await Bun.file(referenced).exists()).toBe(true);
	});

	test("--apply keeps fresh unreferenced blobs out of sweep candidates", async () => {
		const blob = await writeBlob(root, hashFor("fresh-orphan"), "fresh");

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.wouldDelete).toBe(0);
		expect(result.blobs?.deleted).toBe(0);
		expect(await Bun.file(blob).exists()).toBe(true);
	});

	test("--apply scans recoverable session backups before deleting blobs", async () => {
		const referencedHash = hashFor("backup-reference");
		const referenced = await writeBlob(root, referencedHash, "referenced");
		await agePath(referenced);
		const sessionDir = path.join(getSessionsDir(root), "project");
		await fs.mkdir(sessionDir, { recursive: true });
		await Bun.write(
			path.join(sessionDir, "lost.jsonl.1234567890.bak"),
			[
				JSON.stringify({ type: "session", version: 3, id: "lost", timestamp: "2026-01-01T00:00:00.000Z" }),
				JSON.stringify({ type: "message", message: { role: "user", content: `blob:sha256:${referencedHash}` } }),
				"",
			].join("\n"),
		);

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.referenced).toBe(1);
		expect(result.blobs?.wouldDelete).toBe(0);
		expect(result.blobs?.deleted).toBe(0);
		expect(await Bun.file(referenced).exists()).toBe(true);
	});

	test("uses configured gc selectors and retention defaults", async () => {
		await agePath(await writeBlob(root, hashFor("orphan"), "orphan"));
		await writeSession(root, "project", "archive-me", "complete", { ageDays: 10 });
		await writeConfig(
			root,
			[
				"gc:",
				"  blobs: false",
				"  archive: true",
				"  wal: false",
				"  coldArchiveAfterDays: 7",
				"  retainNewestGlobal: 0",
				"  retainNewestPerCwd: 0",
				"",
			].join("\n"),
		);

		const result = await runGcCommand({ flags: { agentDir: root, apply: true } });

		expect(result.blobs).toBeUndefined();
		expect(result.wal).toBeUndefined();
		expect(result.archive?.archived).toBe(1);
		expect(await Bun.file(path.join(root, "archive", "sessions", "project", "archive-me.jsonl.gz")).exists()).toBe(
			true,
		);
	});

	test("--apply loads gc config from each requested agent dir", async () => {
		const initializedAgentDir = path.join(root, "initialized-agent");
		const targetAgentDir = path.join(root, "target-agent");
		await writeConfig(
			initializedAgentDir,
			["gc:", "  blobs: false", "  archive: false", "  wal: false", ""].join("\n"),
		);
		await Settings.init({ agentDir: initializedAgentDir });
		await writeSession(targetAgentDir, "project", "archive-me", "complete", { ageDays: 10 });
		await writeConfig(
			targetAgentDir,
			[
				"gc:",
				"  blobs: false",
				"  archive: true",
				"  wal: false",
				"  coldArchiveAfterDays: 7",
				"  retainNewestGlobal: 0",
				"  retainNewestPerCwd: 0",
				"",
			].join("\n"),
		);

		const result = await runGcCommand({ flags: { agentDir: targetAgentDir, apply: true } });

		expect(result.blobs).toBeUndefined();
		expect(result.wal).toBeUndefined();
		expect(result.archive?.archived).toBe(1);
		expect(
			await Bun.file(path.join(targetAgentDir, "archive", "sessions", "project", "archive-me.jsonl.gz")).exists(),
		).toBe(true);
	});

	test("invalid configured archive age falls back to schema default", async () => {
		const session = await writeSession(root, "project", "too-new", "complete", { ageDays: 1 });
		await writeConfig(
			root,
			[
				"gc:",
				"  blobs: false",
				"  archive: true",
				"  wal: false",
				"  coldArchiveAfterDays: nope",
				"  retainNewestGlobal: 0",
				"  retainNewestPerCwd: 0",
				"",
			].join("\n"),
		);

		const result = await runGcCommand({ flags: { agentDir: root, apply: true } });

		expect(result.archive?.wouldArchive).toBe(0);
		expect(result.archive?.archived).toBe(0);
		expect(await Bun.file(session).exists()).toBe(true);
	});

	test("invalid configured retention counts fall back to schema defaults", async () => {
		const session = await writeSession(root, "project", "kept-by-default", "complete", { ageDays: 90 });
		await writeConfig(
			root,
			[
				"gc:",
				"  blobs: false",
				"  archive: true",
				"  wal: false",
				"  coldArchiveAfterDays: 0",
				"  retainNewestGlobal: nope",
				"  retainNewestPerCwd: nope",
				"",
			].join("\n"),
		);

		const result = await runGcCommand({ flags: { agentDir: root, apply: true } });

		expect(result.archive?.keptNewestGlobal).toBe(1);
		expect(result.archive?.archived).toBe(0);
		expect(await Bun.file(session).exists()).toBe(true);
	});

	test("explicit selectors override disabled gc config", async () => {
		const blob = await writeBlob(root, hashFor("orphan"), "orphan");
		await agePath(blob);
		await writeConfig(root, ["gc:", "  blobs: false", "  archive: false", "  wal: false", ""].join("\n"));

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.deleted).toBe(1);
		expect(result.archive).toBeUndefined();
		expect(result.wal).toBeUndefined();
		expect(await Bun.file(blob).exists()).toBe(false);
	});

	test("dry-run reads gc config without initializing settings storage", async () => {
		await writeSession(root, "project", "archive-me", "complete", { ageDays: 10 });
		await writeConfig(
			root,
			[
				"gc:",
				"  blobs: false",
				"  archive: true",
				"  wal: false",
				"  coldArchiveAfterDays: 7",
				"  retainNewestGlobal: 0",
				"  retainNewestPerCwd: 0",
				"",
			].join("\n"),
		);

		const result = await runGcCommand({ flags: { agentDir: root } });

		expect(result.blobs).toBeUndefined();
		expect(result.archive?.wouldArchive).toBe(1);
		expect(result.archive?.archived).toBe(0);
		expect(result.wal).toBeUndefined();
		expect(await Bun.file(path.join(root, "agent.db")).exists()).toBe(false);
		expect(await Bun.file(path.join(root, "settings.json.bak")).exists()).toBe(false);
	});

	test("dry-run merges project gc settings like apply without initializing settings storage", async () => {
		const projectRoot = path.join(root, "project-root");
		await fs.mkdir(projectRoot, { recursive: true });
		setProjectDir(projectRoot);
		await writeSession(root, "project", "archive-me", "complete", { ageDays: 10 });
		await writeConfig(
			root,
			[
				"gc:",
				"  blobs: false",
				"  archive: false",
				"  wal: false",
				"  coldArchiveAfterDays: 30",
				"  retainNewestGlobal: 1",
				"  retainNewestPerCwd: 1",
				"",
			].join("\n"),
		);
		await writeProjectConfig(
			projectRoot,
			[
				"gc:",
				"  archive: true",
				"  coldArchiveAfterDays: 7",
				"  retainNewestGlobal: 0",
				"  retainNewestPerCwd: 0",
				"",
			].join("\n"),
		);

		const dryRun = await runGcCommand({ flags: { agentDir: root } });

		expect(dryRun.blobs).toBeUndefined();
		expect(dryRun.archive?.wouldArchive).toBe(1);
		expect(dryRun.archive?.archived).toBe(0);
		expect(dryRun.wal).toBeUndefined();
		expect(await Bun.file(path.join(root, "agent.db")).exists()).toBe(false);
		expect(await Bun.file(path.join(root, "settings.json.bak")).exists()).toBe(false);

		const applied = await runGcCommand({ flags: { agentDir: root, apply: true } });

		expect(applied.archive?.archived).toBe(1);
	});
});

describe("runGcCommand history checkpoint", () => {
	test("dry-run reports WAL checkpoint without truncating it", async () => {
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT)");
		db.run("INSERT INTO history (prompt) VALUES ('hello')");
		const walPath = `${dbPath}-wal`;
		const walBytes = (await fs.stat(walPath)).size;

		const result = await runGcCommand({ flags: { agentDir: root, wal: true } });
		const afterBytes = (await fs.stat(walPath)).size;
		db.close();

		expect(result.wal?.wouldCheckpoint).toBe(true);
		expect(result.wal?.checkpointed).toBe(false);
		expect(result.wal?.walBytes).toBeGreaterThan(0);
		expect(afterBytes).toBe(walBytes);
	});

	test("--apply checkpoints history WAL", async () => {
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("PRAGMA journal_mode=WAL");
		db.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT)");
		db.run("INSERT INTO history (prompt) VALUES ('hello')");
		db.close();

		const result = await runGcCommand({ flags: { agentDir: root, wal: true, apply: true } });

		expect(result.wal?.checkpointed).toBe(true);
		expect(result.wal?.walBytes).toBe(0);
		expect((await fs.stat(`${dbPath}-wal`)).size).toBe(0);
	});

	test("--apply propagates WAL checkpoint failures and releases the gc lock", async () => {
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(dbPath, { recursive: true });

		await expect(runGcCommand({ flags: { agentDir: root, wal: true, apply: true } })).rejects.toThrow(
			"unable to open database file",
		);

		expect(await Bun.file(path.join(root, "gc.lock")).exists()).toBe(false);
	});

	test("--apply reports busy WAL checkpoints and releases the gc lock", async () => {
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const writer = new Database(dbPath);
		const reader = new Database(dbPath);
		try {
			writer.run("PRAGMA journal_mode=WAL");
			writer.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT)");
			writer.run("INSERT INTO history (prompt) VALUES ('before-reader')");
			reader.run("PRAGMA journal_mode=WAL");
			reader.run("BEGIN");
			reader.prepare("SELECT * FROM history").all();
			writer.run("INSERT INTO history (prompt) VALUES ('after-reader')");

			await expect(runGcCommand({ flags: { agentDir: root, wal: true, apply: true } })).rejects.toThrow(
				`WAL checkpoint failed for ${dbPath}: busy=1`,
			);

			expect(await Bun.file(path.join(root, "gc.lock")).exists()).toBe(false);
		} finally {
			try {
				reader.run("COMMIT");
			} catch {}
			reader.close();
			writer.close();
		}
	}, 10_000);
});

describe("runGcCommand cold-session archive", () => {
	test("archives old completed sessions while honoring keep-count and active-status skips", async () => {
		const archiveMe = await writeSession(root, "project", "archive-me", "complete", { ageDays: 90 });
		// 60d keeps keep-recent cold-eligible (>30d cutoff) yet unambiguously newer than
		// archive-me's 90d, so retainNewestGlobal:1 deterministically protects it regardless
		// of readdir order when two sessions would otherwise share an mtime millisecond.
		const keepRecent = await writeSession(root, "project", "keep-recent", "complete", { ageDays: 60 });
		const pending = await writeSession(root, "project", "pending", "pending", { ageDays: 90 });
		const interrupted = await writeSession(root, "project", "interrupted", "interrupted", { ageDays: 90 });
		await fs.mkdir(archiveMe.slice(0, -".jsonl".length), { recursive: true });
		await Bun.write(path.join(archiveMe.slice(0, -".jsonl".length), "0.bash.log"), "artifact");

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 1,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const archived = path.join(root, "archive", "sessions", "project", "archive-me.jsonl.gz");

		expect(result.archive?.archived).toBe(1);
		expect(result.archive?.skippedActive).toBe(2);
		expect(await Bun.file(archiveMe).exists()).toBe(false);
		expect(await Bun.file(archived).exists()).toBe(true);
		expect(new TextDecoder().decode(gunzipSync(await Bun.file(archived).bytes()))).toContain('"archive-me"');
		expect(await Bun.file(path.join(archived.slice(0, -".jsonl.gz".length), "0.bash.log")).exists()).toBe(true);
		expect(await Bun.file(keepRecent).exists()).toBe(true);
		expect(await Bun.file(pending).exists()).toBe(true);
		expect(await Bun.file(interrupted).exists()).toBe(true);
	});

	test("skips archiving parent sessions with live nested sessions", async () => {
		const parent = await writeSession(root, "project", "parent", "complete", { ageDays: 90 });
		const artifactsDir = parent.slice(0, -".jsonl".length);
		const nested = path.join(artifactsDir, "Tan-nested.jsonl");
		await fs.mkdir(artifactsDir, { recursive: true });
		await Bun.write(
			nested,
			[
				JSON.stringify({ type: "session", version: 3, id: "Tan-nested", timestamp: "2026-01-01T00:00:00.000Z" }),
				JSON.stringify({ type: "message", message: { role: "user", content: "waiting" } }),
				"",
			].join("\n"),
		);
		await agePath(nested, 90);

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		expect(result.archive?.skippedActive).toBe(1);
		expect(result.archive?.archived).toBe(0);
		expect(await Bun.file(parent).exists()).toBe(true);
		expect(await Bun.file(nested).exists()).toBe(true);
		expect(await Bun.file(path.join(root, "archive", "sessions", "project", "parent.jsonl.gz")).exists()).toBe(false);
	});

	test("removes archived session rows from history and rebuilds FTS", async () => {
		await writeSession(root, "project", "archive-me", "complete", { ageDays: 90 });
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, session_id TEXT)");
		db.run("CREATE VIRTUAL TABLE history_fts USING fts5(prompt, content='history', content_rowid='id')");
		db.run("INSERT INTO history (prompt, session_id) VALUES ('old prompt', 'archive-me')");
		db.run("INSERT INTO history (prompt, session_id) VALUES ('new prompt', 'keep-me')");
		db.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
		db.close();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		const check = new Database(dbPath);
		const rows = check.prepare("SELECT session_id FROM history ORDER BY id").all() as Array<{ session_id: string }>;
		const ftsRows = check
			.prepare("SELECT h.session_id FROM history_fts f JOIN history h ON h.id = f.rowid ORDER BY h.id")
			.all() as Array<{ session_id: string }>;
		check.close();

		expect(result.archive?.historyRowsDeleted).toBe(1);
		expect(result.archive?.ftsRebuilt).toBe(true);
		expect(rows.map(row => row.session_id)).toEqual(["keep-me"]);
		expect(ftsRows.map(row => row.session_id)).toEqual(["keep-me"]);
	});

	test("removes archived main and nested session rows from stats", async () => {
		const session = await writeSession(root, "project", "archive-me", "complete", { ageDays: 90 });
		const nestedSession = path.join(session.slice(0, -".jsonl".length), "nested.jsonl");
		const keepSession = path.join(getSessionsDir(root), "project", "keep.jsonl");
		const statsDbPath = path.join(root, "stats.db");
		const tables = ["messages", "user_messages", "tool_calls", "file_offsets"] as const;
		const db = new Database(statsDbPath);
		for (const table of tables) {
			db.run(`CREATE TABLE ${table} (session_file TEXT NOT NULL)`);
			const insert = db.prepare(`INSERT INTO ${table} (session_file) VALUES (?)`);
			insert.run(session);
			insert.run(nestedSession);
			insert.run(keepSession);
		}
		db.close();

		const dryRun = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
			},
		});
		const dryCheck = new Database(statsDbPath);
		for (const table of tables) {
			const row = dryCheck.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
			expect(row.count).toBe(3);
		}
		dryCheck.close();
		expect(dryRun.archive?.statsRowsDeleted).toBe(0);

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		const check = new Database(statsDbPath);
		const remaining = Object.fromEntries(
			tables.map(table => [
				table,
				(check.prepare(`SELECT session_file FROM ${table}`).all() as Array<{ session_file: string }>).map(
					row => row.session_file,
				),
			]),
		);
		check.close();

		expect(result.archive?.statsRowsDeleted).toBe(8);
		expect(remaining).toEqual(Object.fromEntries(tables.map(table => [table, [keepSession]])));
	});

	test("transfers shared stats among retained branches while pruning archived lineage members", async () => {
		const sessionsDir = path.join(getSessionsDir(root), "project");
		await fs.mkdir(sessionsDir, { recursive: true });
		const parent = path.join(sessionsDir, "20260626_parent-session.jsonl");
		const child = path.join(sessionsDir, "20260726_child-session.jsonl");
		const sibling = path.join(sessionsDir, "20260725_sibling-session.jsonl");
		const timestamp = "2026-06-26T12:00:00.000Z";
		const timestampMs = Date.parse(timestamp);
		const collisionTimestamp = "2026-06-27T12:00:00.000Z";
		const sharedUser = {
			type: "message",
			id: "shared-user",
			parentId: null,
			timestamp,
			message: { role: "user", content: "shared" },
		};
		const sharedAssistant = {
			type: "message",
			id: "shared-assistant",
			parentId: "shared-user",
			timestamp,
			message: {
				role: "assistant",
				model: "test-model",
				provider: "test-provider",
				content: [{ type: "toolCall", id: "shared-tool", name: "read" }],
			},
		};
		const parentOnlyUser = {
			type: "message",
			id: "parent-only-user",
			parentId: "shared-assistant",
			timestamp,
			message: { role: "user", content: "abandoned branch" },
		};
		const parentOnlyAssistant = {
			type: "message",
			id: "parent-only-assistant",
			parentId: "parent-only-user",
			timestamp,
			message: { role: "assistant", content: [] },
		};
		const archivedCollisionUser = {
			type: "message",
			id: "collision-user",
			parentId: "parent-only-assistant",
			timestamp,
			message: { role: "user", content: "archived collision" },
		};
		const archivedCollisionAssistant = {
			type: "message",
			id: "collision-assistant",
			parentId: "collision-user",
			timestamp,
			message: {
				role: "assistant",
				model: "test-model",
				provider: "test-provider",
				content: [{ type: "toolCall", id: "collision-tool", name: "read" }],
			},
		};
		const retainedCollisionUser = {
			...archivedCollisionUser,
			timestamp: collisionTimestamp,
			message: { role: "user", content: "different retained entry" },
		};
		const retainedCollisionAssistant = {
			...archivedCollisionAssistant,
			timestamp: collisionTimestamp,
		};
		const terminalAssistant = {
			type: "message",
			id: "terminal-assistant",
			parentId: null,
			timestamp,
			message: { role: "assistant", content: [] },
		};
		await Bun.write(
			parent,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "parent-session",
					timestamp,
					cwd: "/tmp",
				}),
				sharedUser,
				sharedAssistant,
				parentOnlyUser,
				parentOnlyAssistant,
				archivedCollisionUser,
				archivedCollisionAssistant,
				terminalAssistant,
				"",
			]
				.map(entry => (typeof entry === "string" ? entry : JSON.stringify(entry)))
				.join("\n"),
		);
		await agePath(parent, 90);
		await Bun.write(
			child,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp,
					cwd: "/tmp",
					parentSession: parent,
				}),
				JSON.stringify(sharedUser),
				JSON.stringify(sharedAssistant),
				JSON.stringify(retainedCollisionUser),
				JSON.stringify(retainedCollisionAssistant),
				JSON.stringify(terminalAssistant),
				"",
			].join("\n"),
		);
		await Bun.write(
			sibling,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "sibling-session",
					timestamp,
					cwd: "/tmp",
					parentSession: parent,
				}),
				JSON.stringify(sharedUser),
				JSON.stringify(sharedAssistant),
				JSON.stringify(terminalAssistant),
				"",
			].join("\n"),
		);
		await agePath(sibling, 1);
		const siblingStat = await fs.stat(sibling);
		const childStat = await fs.stat(child);

		const statsDbPath = path.join(root, "stats.db");
		const db = new Database(statsDbPath);
		db.run(
			"CREATE TABLE messages (session_file TEXT NOT NULL, entry_id TEXT NOT NULL, timestamp INTEGER NOT NULL, UNIQUE(session_file, entry_id))",
		);
		db.run(
			"CREATE TABLE user_messages (session_file TEXT NOT NULL, entry_id TEXT NOT NULL, timestamp INTEGER NOT NULL, UNIQUE(session_file, entry_id))",
		);
		db.run(
			"CREATE TABLE tool_calls (session_file TEXT NOT NULL, entry_id TEXT NOT NULL, timestamp INTEGER NOT NULL, tool_call_id TEXT NOT NULL, UNIQUE(session_file, tool_call_id))",
		);
		db.run(
			"CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, offset INTEGER NOT NULL, last_modified INTEGER NOT NULL)",
		);
		for (const [table, sharedId, parentOnlyId] of [
			["messages", "shared-assistant", "parent-only-assistant"],
			["user_messages", "shared-user", "parent-only-user"],
		] as const) {
			const insert = db.prepare(`INSERT INTO ${table} (session_file, entry_id, timestamp) VALUES (?, ?, ?)`);
			insert.run(parent, sharedId, timestampMs);
			insert.run(parent, parentOnlyId, timestampMs);
			insert.run(parent, table === "messages" ? "collision-assistant" : "collision-user", timestampMs);
		}
		const insertToolCall = db.prepare(
			"INSERT INTO tool_calls (session_file, entry_id, timestamp, tool_call_id) VALUES (?, ?, ?, ?)",
		);
		insertToolCall.run(parent, "shared-assistant", timestampMs, "shared-tool");
		insertToolCall.run(parent, "parent-only-assistant", timestampMs, "parent-only-tool");
		insertToolCall.run(parent, "collision-assistant", timestampMs, "collision-tool");
		db.prepare("INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)").run(parent, 444, 1);
		const insertOffset = db.prepare(
			"INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)",
		);
		insertOffset.run(child, childStat.size, childStat.mtimeMs);
		insertOffset.run(sibling, siblingStat.size, siblingStat.mtimeMs);
		db.close();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		const check = new Database(statsDbPath);
		const messages = check.prepare("SELECT session_file, entry_id FROM messages").all();
		const userMessages = check.prepare("SELECT session_file, entry_id FROM user_messages").all();
		const toolCalls = check.prepare("SELECT session_file, entry_id, tool_call_id FROM tool_calls").all();
		const offsets = check
			.prepare("SELECT session_file, offset, last_modified FROM file_offsets ORDER BY session_file")
			.all();
		check.close();

		expect(result.archive?.archived).toBe(1);
		expect(result.archive?.statsRowsDeleted).toBe(7);
		expect(result.archive?.errors).toEqual([]);
		expect(messages).toEqual([{ session_file: child, entry_id: "shared-assistant" }]);
		expect(userMessages).toEqual([{ session_file: child, entry_id: "shared-user" }]);
		expect(toolCalls).toEqual([{ session_file: child, entry_id: "shared-assistant", tool_call_id: "shared-tool" }]);
		expect(offsets).toEqual([
			{ session_file: sibling, offset: siblingStat.size, last_modified: siblingStat.mtimeMs },
			{ session_file: child, offset: childStat.size, last_modified: childStat.mtimeMs },
		]);

		await agePath(child, 90);
		const second = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const secondCheck = new Database(statsDbPath);
		const secondMessages = secondCheck.prepare("SELECT session_file, entry_id FROM messages").all();
		const secondUserMessages = secondCheck.prepare("SELECT session_file, entry_id FROM user_messages").all();
		const secondToolCalls = secondCheck.prepare("SELECT session_file, entry_id, tool_call_id FROM tool_calls").all();
		const secondOffsets = secondCheck.prepare("SELECT session_file, offset, last_modified FROM file_offsets").all();
		secondCheck.close();

		expect(second.archive?.archived).toBe(1);
		expect(second.archive?.statsRowsDeleted).toBe(1);
		expect(second.archive?.errors).toEqual([]);
		expect(secondMessages).toEqual([{ session_file: sibling, entry_id: "shared-assistant" }]);
		expect(secondUserMessages).toEqual([{ session_file: sibling, entry_id: "shared-user" }]);
		expect(secondToolCalls).toEqual([
			{ session_file: sibling, entry_id: "shared-assistant", tool_call_id: "shared-tool" },
		]);
		expect(secondOffsets).toEqual([
			{ session_file: sibling, offset: siblingStat.size, last_modified: siblingStat.mtimeMs },
		]);
	});

	test("scopes incompatible retained-entry deletion decisions to each cleanup plan", async () => {
		const sessionsDir = path.join(getSessionsDir(root), "project");
		await fs.mkdir(sessionsDir, { recursive: true });
		const parent = path.join(sessionsDir, "20260626_partial-parent.jsonl");
		const child = path.join(sessionsDir, "20260726_partial-child.jsonl");
		const timestamp = "2026-06-26T12:00:00.000Z";
		const sharedAssistant = {
			type: "message",
			id: "shared-assistant",
			parentId: null,
			timestamp,
			message: { role: "assistant", content: [] },
		};
		await Bun.write(
			parent,
			[
				JSON.stringify({ type: "session", version: 3, id: "partial-parent", timestamp, cwd: "/tmp" }),
				JSON.stringify(sharedAssistant),
				"",
			].join("\n"),
		);
		await agePath(parent, 90);
		await Bun.write(
			child,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "partial-child",
					timestamp,
					cwd: "/tmp",
					parentSession: parent,
				}),
				JSON.stringify(sharedAssistant),
				"",
			].join("\n"),
		);
		const unrelated = await writeSession(root, "project", "partial-unrelated", "complete", {
			ageDays: 90,
			filename: "20260625_partial-unrelated",
		});

		const statsDbPath = path.join(root, "stats.db");
		const db = new Database(statsDbPath);
		db.run(
			"CREATE TABLE messages (session_file TEXT NOT NULL, entry_id TEXT NOT NULL, timestamp INTEGER NOT NULL, UNIQUE(session_file, entry_id))",
		);
		db.run("CREATE TABLE user_messages (session_file TEXT NOT NULL)");
		db.run(
			"CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, offset INTEGER NOT NULL, last_modified INTEGER NOT NULL)",
		);
		db.prepare("INSERT INTO messages (session_file, entry_id, timestamp) VALUES (?, ?, ?)").run(
			parent,
			"shared-assistant",
			Date.parse(timestamp),
		);
		db.prepare("INSERT INTO user_messages (session_file) VALUES (?)").run(parent);
		db.prepare("INSERT INTO user_messages (session_file) VALUES (?)").run(unrelated);
		db.prepare("INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)").run(parent, 10, 1);
		db.close();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const check = new Database(statsDbPath);
		const messages = check.prepare("SELECT session_file, entry_id FROM messages").all();
		const legacyRows = check.prepare("SELECT session_file FROM user_messages").all();
		const offsets = check.prepare("SELECT session_file FROM file_offsets").all();
		check.close();

		expect(result.archive?.archived).toBe(2);
		expect(result.archive?.statsRowsDeleted).toBe(2);
		expect(result.archive?.errors).toEqual([]);
		expect(messages).toEqual([{ session_file: child, entry_id: "shared-assistant" }]);
		expect(legacyRows).toEqual([{ session_file: parent }]);
		expect(offsets).toEqual([]);
	});

	test("prunes stats still owned by a session's paths from before it moved", async () => {
		const original = await writeSession(root, "before-move", "moved-session", "complete", {
			filename: "20260626_moved-session",
		});
		const moved = path.join(getSessionsDir(root), "after-move", path.basename(original));
		await fs.mkdir(path.dirname(moved), { recursive: true });
		await fs.rename(original, moved);
		await agePath(moved, 90);
		const historicalNested = path.join(original.slice(0, -".jsonl".length), "nested.jsonl");

		const statsDbPath = path.join(root, "stats.db");
		const tables = ["messages", "user_messages", "tool_calls", "file_offsets"] as const;
		const db = new Database(statsDbPath);
		for (const table of tables) {
			db.run(`CREATE TABLE ${table} (session_file TEXT NOT NULL)`);
			const insert = db.prepare(`INSERT INTO ${table} (session_file) VALUES (?)`);
			insert.run(original);
			insert.run(historicalNested);
		}
		db.prepare("INSERT INTO file_offsets (session_file) VALUES (?)").run(moved);
		db.close();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		const check = new Database(statsDbPath);
		const remaining = Object.fromEntries(
			tables.map(table => [
				table,
				(check.prepare(`SELECT session_file FROM ${table}`).all() as Array<{ session_file: string }>).map(
					row => row.session_file,
				),
			]),
		);
		check.close();

		expect(result.archive?.archived).toBe(1);
		expect(result.archive?.statsRowsDeleted).toBe(9);
		expect(result.archive?.errors).toEqual([]);
		expect(remaining).toEqual(Object.fromEntries(tables.map(table => [table, []])));
	});

	test("uses persisted move history to prune custom names without claiming identity collisions", async () => {
		const timestamp = "2026-06-26T12:00:00.000Z";
		const timestampMs = Date.parse(timestamp);
		const original = await writeSession(root, "before-move", "custom-session-id", "complete", {
			filename: "custom-name",
		});
		const sharedAssistant = {
			type: "message",
			id: "custom-entry",
			parentId: null,
			timestamp,
			message: { role: "assistant", content: [] },
		};
		await Bun.write(
			original,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "custom-session-id",
					timestamp,
					cwd: "/tmp",
					previousSessionFiles: [original],
				}),
				JSON.stringify(sharedAssistant),
				"",
			].join("\n"),
		);
		const moved = path.join(getSessionsDir(root), "after-move", path.basename(original));
		await fs.mkdir(path.dirname(moved), { recursive: true });
		await fs.rename(original, moved);
		await agePath(moved, 90);
		const historicalNested = path.join(original.slice(0, -".jsonl".length), "nested.jsonl");
		const unrelated = path.join(getSessionsDir(root), "unrelated", path.basename(original));

		const statsDbPath = path.join(root, "stats.db");
		const db = new Database(statsDbPath);
		db.run(
			"CREATE TABLE messages (session_file TEXT NOT NULL, entry_id TEXT NOT NULL, timestamp INTEGER NOT NULL, UNIQUE(session_file, entry_id))",
		);
		db.run(
			"CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, offset INTEGER NOT NULL, last_modified INTEGER NOT NULL)",
		);
		const insertMessage = db.prepare("INSERT INTO messages (session_file, entry_id, timestamp) VALUES (?, ?, ?)");
		insertMessage.run(original, sharedAssistant.id, timestampMs);
		insertMessage.run(historicalNested, "nested-entry", timestampMs);
		insertMessage.run(unrelated, sharedAssistant.id, timestampMs);
		const insertOffset = db.prepare(
			"INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)",
		);
		insertOffset.run(original, 1, 1);
		insertOffset.run(moved, 2, 2);
		db.close();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const check = new Database(statsDbPath);
		const messages = check.prepare("SELECT session_file, entry_id FROM messages").all();
		const offsets = check.prepare("SELECT session_file FROM file_offsets").all();
		check.close();

		expect(result.archive?.archived).toBe(1);
		expect(result.archive?.statsRowsDeleted).toBe(4);
		expect(result.archive?.errors).toEqual([]);
		expect(messages).toEqual([{ session_file: unrelated, entry_id: sharedAssistant.id }]);
		expect(offsets).toEqual([]);
	});

	test("preserves a historical path claimed by multiple archived sessions", async () => {
		const timestamp = "2026-06-26T12:00:00.000Z";
		const previousSessionFile = path.join(getSessionsDir(root), "before-move", "custom-name.jsonl");
		for (const [project, id] of [
			["archive-one", "session-one"],
			["archive-two", "session-two"],
		] as const) {
			const current = path.join(getSessionsDir(root), project, "custom-name.jsonl");
			await fs.mkdir(path.dirname(current), { recursive: true });
			await Bun.write(
				current,
				[
					JSON.stringify({
						type: "session",
						version: 3,
						id,
						timestamp,
						cwd: "/tmp",
						previousSessionFiles: [previousSessionFile],
					}),
					JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }),
					"",
				].join("\n"),
			);
			await agePath(current, 90);
		}

		const statsDbPath = path.join(root, "stats.db");
		const db = new Database(statsDbPath);
		db.run("CREATE TABLE messages (session_file TEXT NOT NULL)");
		db.prepare("INSERT INTO messages (session_file) VALUES (?)").run(previousSessionFile);
		db.close();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const check = new Database(statsDbPath);
		const rows = check.prepare("SELECT session_file FROM messages").all();
		check.close();

		expect(result.archive?.archived).toBe(2);
		expect(result.archive?.statsRowsDeleted).toBe(0);
		expect(result.archive?.errors).toEqual([]);
		expect(rows).toEqual([{ session_file: previousSessionFile }]);
	});

	test("does not claim an unrelated historical path by basename alone", async () => {
		const session = await writeSession(root, "project", "actual-session-id", "complete", {
			ageDays: 90,
			filename: "custom-name",
		});
		const unrelated = path.join(root, "unrelated", path.basename(session));
		const statsDbPath = path.join(root, "stats.db");
		const db = new Database(statsDbPath);
		db.run("CREATE TABLE messages (session_file TEXT NOT NULL)");
		const insert = db.prepare("INSERT INTO messages (session_file) VALUES (?)");
		insert.run(session);
		insert.run(unrelated);
		db.close();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const check = new Database(statsDbPath);
		const rows = check.prepare("SELECT session_file FROM messages").all();
		check.close();

		expect(result.archive?.archived).toBe(1);
		expect(result.archive?.statsRowsDeleted).toBe(1);
		expect(result.archive?.errors).toEqual([]);
		expect(rows).toEqual([{ session_file: unrelated }]);
	});

	test("continues stats cleanup past a corrupt historical archive", async () => {
		const session = await writeSession(root, "project", "archive-me", "complete", { ageDays: 90 });
		const corruptArchive = path.join(root, "archive", "sessions", "older", "corrupt.jsonl.gz");
		await fs.mkdir(path.dirname(corruptArchive), { recursive: true });
		await Bun.write(corruptArchive, "not gzip");
		const statsDbPath = path.join(root, "stats.db");
		const db = new Database(statsDbPath);
		db.run("CREATE TABLE messages (session_file TEXT NOT NULL)");
		db.prepare("INSERT INTO messages (session_file) VALUES (?)").run(session);
		db.close();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const check = new Database(statsDbPath);
		const rows = check.prepare("SELECT session_file FROM messages").all();
		check.close();

		expect(result.archive?.archived).toBe(1);
		expect(result.archive?.statsRowsDeleted).toBe(1);
		expect(result.archive?.errors.some(error => error.startsWith(`stats cleanup scan ${corruptArchive}: `))).toBe(
			true,
		);
		expect(rows).toEqual([]);
	});

	test("preserves shared stats through an unreadable intermediate archive", async () => {
		const sessionsDir = path.join(getSessionsDir(root), "project");
		const archiveDir = path.join(root, "archive", "sessions", "project");
		await fs.mkdir(sessionsDir, { recursive: true });
		await fs.mkdir(archiveDir, { recursive: true });
		const ancestorPath = path.join(sessionsDir, "20260625_ancestor.jsonl");
		const intermediatePath = path.join(sessionsDir, "20260626_intermediate.jsonl");
		const retainedPath = path.join(sessionsDir, "20260726_retained.jsonl");
		const ancestorArchive = path.join(archiveDir, `${path.basename(ancestorPath)}.gz`);
		const corruptArchive = path.join(archiveDir, `${path.basename(intermediatePath)}.gz`);
		const timestamp = "2026-06-25T12:00:00.000Z";
		const timestampMs = Date.parse(timestamp);
		const sharedAssistant = {
			type: "message",
			id: "shared-assistant",
			parentId: null,
			timestamp,
			message: { role: "assistant", content: [] },
		};
		await Bun.write(
			ancestorArchive,
			gzipSync(
				[
					JSON.stringify({ type: "session", version: 3, id: "ancestor", timestamp, cwd: "/tmp" }),
					JSON.stringify(sharedAssistant),
					"",
				].join("\n"),
			),
		);
		await Bun.write(corruptArchive, "not gzip");
		await Bun.write(
			retainedPath,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "retained",
					timestamp,
					cwd: "/tmp",
					parentSession: intermediatePath,
				}),
				JSON.stringify(sharedAssistant),
				"",
			].join("\n"),
		);
		const retainedStat = await fs.stat(retainedPath);

		const statsDbPath = path.join(root, "stats.db");
		const db = new Database(statsDbPath);
		db.run(
			"CREATE TABLE messages (session_file TEXT NOT NULL, entry_id TEXT NOT NULL, timestamp INTEGER NOT NULL, UNIQUE(session_file, entry_id))",
		);
		db.run(
			"CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, offset INTEGER NOT NULL, last_modified INTEGER NOT NULL)",
		);
		db.prepare("INSERT INTO messages (session_file, entry_id, timestamp) VALUES (?, ?, ?)").run(
			ancestorPath,
			sharedAssistant.id,
			timestampMs,
		);
		const insertOffset = db.prepare(
			"INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)",
		);
		insertOffset.run(ancestorPath, 1, 1);
		insertOffset.run(retainedPath, retainedStat.size, retainedStat.mtimeMs);
		db.close();

		const first = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const firstCheck = new Database(statsDbPath);
		const firstMessages = firstCheck.prepare("SELECT session_file, entry_id FROM messages").all();
		const firstOffsets = firstCheck
			.prepare("SELECT session_file, offset, last_modified FROM file_offsets ORDER BY session_file")
			.all();
		firstCheck.close();

		expect(first.archive?.archived).toBe(0);
		expect(first.archive?.statsRowsDeleted).toBe(0);
		expect(first.archive?.errors.some(error => error.startsWith(`stats cleanup scan ${corruptArchive}: `))).toBe(
			true,
		);
		expect(firstMessages).toEqual([{ session_file: ancestorPath, entry_id: sharedAssistant.id }]);
		expect(firstOffsets).toEqual([
			{ session_file: ancestorPath, offset: 1, last_modified: 1 },
			{ session_file: retainedPath, offset: retainedStat.size, last_modified: retainedStat.mtimeMs },
		]);

		await Bun.write(
			corruptArchive,
			gzipSync(
				[
					JSON.stringify({
						type: "session",
						version: 3,
						id: "intermediate",
						timestamp,
						cwd: "/tmp",
						parentSession: ancestorPath,
					}),
					JSON.stringify(sharedAssistant),
					"",
				].join("\n"),
			),
		);
		const second = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const secondCheck = new Database(statsDbPath);
		const secondMessages = secondCheck.prepare("SELECT session_file, entry_id FROM messages").all();
		const secondOffsets = secondCheck.prepare("SELECT session_file, offset, last_modified FROM file_offsets").all();
		secondCheck.close();

		expect(second.archive?.archived).toBe(0);
		expect(second.archive?.statsRowsDeleted).toBe(1);
		expect(second.archive?.errors).toEqual([]);
		expect(secondMessages).toEqual([{ session_file: retainedPath, entry_id: sharedAssistant.id }]);
		expect(secondOffsets).toEqual([
			{ session_file: retainedPath, offset: retainedStat.size, last_modified: retainedStat.mtimeMs },
		]);
	});

	test("transfers shared tool calls with empty ids before pruning archived ownership", async () => {
		const sessionsDir = path.join(getSessionsDir(root), "project");
		const archiveDir = path.join(root, "archive", "sessions", "project");
		await fs.mkdir(sessionsDir, { recursive: true });
		await fs.mkdir(archiveDir, { recursive: true });
		const parentPath = path.join(sessionsDir, "20260625_parent.jsonl");
		const childPath = path.join(sessionsDir, "20260726_child.jsonl");
		const parentArchive = path.join(archiveDir, `${path.basename(parentPath)}.gz`);
		const timestamp = "2026-06-25T12:00:00.000Z";
		const timestampMs = Date.parse(timestamp);
		const assistant = {
			type: "message",
			id: "assistant",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "", name: "read" }],
			},
		};
		await Bun.write(
			parentArchive,
			gzipSync(
				[
					JSON.stringify({ type: "session", version: 3, id: "parent", timestamp, cwd: "/tmp" }),
					JSON.stringify(assistant),
					"",
				].join("\n"),
			),
		);
		await Bun.write(
			childPath,
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child",
					timestamp,
					cwd: "/tmp",
					parentSession: parentPath,
				}),
				JSON.stringify(assistant),
				"",
			].join("\n"),
		);
		const childStat = await fs.stat(childPath);

		const statsDbPath = path.join(root, "stats.db");
		const db = new Database(statsDbPath);
		db.run(
			"CREATE TABLE tool_calls (session_file TEXT NOT NULL, entry_id TEXT NOT NULL, timestamp INTEGER NOT NULL, tool_call_id TEXT NOT NULL, UNIQUE(session_file, tool_call_id))",
		);
		db.run(
			"CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, offset INTEGER NOT NULL, last_modified INTEGER NOT NULL)",
		);
		db.prepare("INSERT INTO tool_calls (session_file, entry_id, timestamp, tool_call_id) VALUES (?, ?, ?, ?)").run(
			parentPath,
			assistant.id,
			timestampMs,
			"",
		);
		const insertOffset = db.prepare(
			"INSERT INTO file_offsets (session_file, offset, last_modified) VALUES (?, ?, ?)",
		);
		insertOffset.run(parentPath, 1, 1);
		insertOffset.run(childPath, childStat.size, childStat.mtimeMs);
		db.close();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const check = new Database(statsDbPath);
		const toolCalls = check.prepare("SELECT session_file, entry_id, tool_call_id FROM tool_calls").all();
		const offsets = check.prepare("SELECT session_file, offset, last_modified FROM file_offsets").all();
		check.close();

		expect(result.archive?.archived).toBe(0);
		expect(result.archive?.statsRowsDeleted).toBe(1);
		expect(result.archive?.errors).toEqual([]);
		expect(toolCalls).toEqual([{ session_file: childPath, entry_id: assistant.id, tool_call_id: "" }]);
		expect(offsets).toEqual([{ session_file: childPath, offset: childStat.size, last_modified: childStat.mtimeMs }]);
	});

	test("skips decompressible historical archives without a valid session header", async () => {
		const archive = path.join(root, "archive", "sessions", "older", "headerless-session.jsonl.gz");
		await fs.mkdir(path.dirname(archive), { recursive: true });
		await Bun.write(
			archive,
			gzipSync(`${JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })}\n`),
		);
		const historicalStatsPath = path.join(root, "unrelated", "headerless-session.jsonl");
		const statsDbPath = path.join(root, "stats.db");
		const stats = new Database(statsDbPath);
		stats.run("CREATE TABLE messages (session_file TEXT NOT NULL)");
		stats.prepare("INSERT INTO messages (session_file) VALUES (?)").run(historicalStatsPath);
		stats.close();
		const historyDbPath = getHistoryDbPath(root);
		const history = new Database(historyDbPath);
		history.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT NOT NULL, session_id TEXT)");
		history.run("INSERT INTO history (prompt, session_id) VALUES ('keep me', 'headerless-session')");
		history.close();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const statsCheck = new Database(statsDbPath);
		const statsRows = statsCheck.prepare("SELECT session_file FROM messages").all();
		statsCheck.close();
		const historyCheck = new Database(historyDbPath);
		const historyRows = historyCheck.prepare("SELECT session_id FROM history").all();
		historyCheck.close();

		expect(result.archive?.statsRowsDeleted).toBe(0);
		expect(result.archive?.historyRowsDeleted).toBe(0);
		expect(result.archive?.errors).toContain(
			`stats cleanup scan ${archive}: archive is missing a valid session header`,
		);
		expect(statsRows).toEqual([{ session_file: historicalStatsPath }]);
		expect(historyRows).toEqual([{ session_id: "headerless-session" }]);
	});

	test("waits for the shared stats lock before archive reconciliation", async () => {
		const session = await writeSession(root, "project", "archive-me", "complete", { ageDays: 90 });
		const statsDbPath = path.join(root, "stats.db");
		const db = new Database(statsDbPath);
		db.run("CREATE TABLE messages (session_file TEXT NOT NULL)");
		db.prepare("INSERT INTO messages (session_file) VALUES (?)").run(session);
		db.close();
		const sessionMoved = (async () => {
			for await (const event of fs.watch(path.dirname(session))) {
				if (event.filename === path.basename(session)) return true;
			}
			return false;
		})();

		let gcPromise: Promise<GcResult> | undefined;
		let archivedWhileLocked = false;
		let rowsWhileLocked: unknown[] = [];
		await withStatsSyncLock(statsDbPath, async () => {
			gcPromise = runGcCommand({
				flags: {
					agentDir: root,
					archive: true,
					coldArchiveAfterDays: 30,
					retainNewestGlobal: 0,
					retainNewestPerCwd: 0,
					apply: true,
				},
			});
			archivedWhileLocked = await sessionMoved;
			const lockedCheck = new Database(statsDbPath);
			rowsWhileLocked = lockedCheck.prepare("SELECT session_file FROM messages").all();
			lockedCheck.close();
		});
		if (!gcPromise) throw new Error("GC did not start");
		const result = await gcPromise;
		const check = new Database(statsDbPath);
		const rows = check.prepare("SELECT session_file FROM messages").all();
		check.close();

		expect(archivedWhileLocked).toBe(true);
		expect(rowsWhileLocked).toEqual([{ session_file: session }]);
		expect(result.archive?.statsRowsDeleted).toBe(1);
		expect(rows).toEqual([]);
	});

	test("reports stats cleanup failures and retries rows for already archived sessions", async () => {
		const session = await writeSession(root, "project", "archive-me", "complete", {
			ageDays: 90,
			filename: "20260626_archive-me",
		});
		const statsDbPath = path.join(root, "stats.db");
		await Bun.write(statsDbPath, "not sqlite");

		const first = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		expect(first.archive?.archived).toBe(1);
		expect(first.archive?.errors.some(error => error.startsWith("stats cleanup: "))).toBe(true);

		await fs.rm(statsDbPath, { force: true });
		const db = new Database(statsDbPath);
		db.run("CREATE TABLE messages (session_file TEXT NOT NULL)");
		db.prepare("INSERT INTO messages (session_file) VALUES (?)").run(session);
		db.close();

		const second = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const check = new Database(statsDbPath);
		const rows = check.prepare("SELECT session_file FROM messages").all();
		check.close();

		expect(second.archive?.archived).toBe(0);
		expect(second.archive?.statsRowsDeleted).toBe(1);
		expect(second.archive?.errors).toEqual([]);
		expect(rows).toEqual([]);
	});

	test("reports history cleanup failures and retries rows for already archived sessions", async () => {
		await writeSession(root, "project", "archive-me", "complete", {
			ageDays: 90,
			filename: "20260626_archive-me",
		});
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		await Bun.write(dbPath, "not sqlite");

		const first = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const archived = path.join(root, "archive", "sessions", "project", "20260626_archive-me.jsonl.gz");

		expect(first.archive?.archived).toBe(1);
		expect(first.archive?.errors.some(error => error.startsWith("history cleanup: "))).toBe(true);
		expect(await Bun.file(archived).exists()).toBe(true);

		await fs.rm(dbPath, { force: true });
		const db = new Database(dbPath);
		db.run("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, session_id TEXT)");
		db.run("INSERT INTO history (prompt, session_id) VALUES ('old prompt', 'archive-me')");
		db.close();

		const second = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		const check = new Database(dbPath);
		const rows = check.prepare("SELECT session_id FROM history ORDER BY id").all();
		check.close();

		expect(second.archive?.archived).toBe(0);
		expect(second.archive?.historyRowsDeleted).toBe(1);
		expect(second.archive?.errors).toEqual([]);
		expect(rows).toEqual([]);
	});

	test("CLI returns nonzero status when apply records GC errors", async () => {
		await writeSession(root, "project", "archive-me", "complete", { ageDays: 90 });
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		await Bun.write(dbPath, "not sqlite");

		await runCli([
			"gc",
			"--agent-dir",
			root,
			"--archive",
			"--cold-archive-after-days",
			"30",
			"--retain-newest-global",
			"0",
			"--retain-newest-per-cwd",
			"0",
			"--apply",
		]);

		const stderr = stderrWrites.join("");
		expect(process.exitCode).toBe(1);
		expect(stderr).toContain("GC completed with 1 error:");
		expect(stderr).toContain("archive: history cleanup:");
	});

	test("archives sessions when legacy history has no session_id column", async () => {
		const session = await writeSession(root, "project", "legacy-history", "complete", { ageDays: 90 });
		const dbPath = getHistoryDbPath(root);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath);
		db.run("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL)");
		db.run("INSERT INTO history (prompt) VALUES ('old prompt')");
		db.close();

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		expect(result.archive?.archived).toBe(1);
		expect(result.archive?.historyRowsDeleted).toBe(0);
		expect(result.archive?.errors).toEqual([]);
		expect(await Bun.file(session).exists()).toBe(false);
	});

	test("does not archive fresh completed sessions that may still be live", async () => {
		const session = await writeSession(root, "project", "fresh-complete", "complete");

		const result = await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 0,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});

		expect(result.archive?.archived).toBe(0);
		expect(result.archive?.skippedActive).toBe(1);
		expect(await Bun.file(session).exists()).toBe(true);
	});

	test("dry-run does not recover orphaned session backups", async () => {
		const sessionDir = path.join(getSessionsDir(root), "project");
		await fs.mkdir(sessionDir, { recursive: true });
		const primary = path.join(sessionDir, "lost.jsonl");
		const backup = path.join(sessionDir, "lost.jsonl.1234567890.bak");
		await Bun.write(
			backup,
			`${JSON.stringify({ type: "session", version: 3, id: "lost", timestamp: "2026-01-01T00:00:00.000Z" })}\n`,
		);

		const result = await runGcCommand({ flags: { agentDir: root, archive: true } });

		expect(result.archive?.scanned).toBe(0);
		expect(await Bun.file(backup).exists()).toBe(true);
		expect(await Bun.file(primary).exists()).toBe(false);
	});

	test("sweeps blobs only after scanning references in compressed archived sessions", async () => {
		const referencedHash = hashFor("archived-reference");
		const referenced = await writeBlob(root, referencedHash, "referenced");
		await writeBlob(root, hashFor("orphan"), "orphan");
		await agePath(path.join(getBlobsDir(root), hashFor("orphan")));
		await writeSession(root, "project", "archive-me", "complete", {
			ageDays: 90,
			blobRef: `blob:sha256:${referencedHash}`,
		});

		await runGcCommand({
			flags: {
				agentDir: root,
				archive: true,
				coldArchiveAfterDays: 30,
				retainNewestGlobal: 0,
				retainNewestPerCwd: 0,
				apply: true,
			},
		});
		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.wouldDelete).toBe(1);
		expect(await Bun.file(referenced).exists()).toBe(true);
	});
});

describe("runGcCommand lock handling", () => {
	test("refuses an active gc lock", async () => {
		const lockPath = path.join(root, "gc.lock");
		await Bun.write(lockPath, `${process.pid}\n${new Date().toISOString()}\n`);

		await expect(runGcCommand({ flags: { agentDir: root, blobs: true } })).rejects.toThrow(
			`GC already running: ${lockPath}`,
		);
		expect(await Bun.file(lockPath).exists()).toBe(true);
	});

	test("breaks stale gc locks before running", async () => {
		const lockPath = path.join(root, "gc.lock");
		await Bun.write(lockPath, "999999999\n2026-01-01T00:00:00.000Z\n");
		const blob = await writeBlob(root, hashFor("orphan"), "orphan");
		await agePath(blob);

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true } });

		expect(result.blobs?.wouldDelete).toBe(1);
		expect(await Bun.file(lockPath).exists()).toBe(false);
	});

	test("does not break gc locks while stale-lock takeover is already in progress", async () => {
		const lockPath = path.join(root, "gc.lock");
		const breakerPath = `${lockPath}.break`;
		await Bun.write(lockPath, "999999999\n2026-01-01T00:00:00.000Z\n");
		await Bun.write(breakerPath, `${process.pid}\n${new Date().toISOString()}\n`);

		await expect(runGcCommand({ flags: { agentDir: root, blobs: true } })).rejects.toThrow(
			`GC already running: ${lockPath}`,
		);
		expect(await Bun.file(lockPath).exists()).toBe(true);
		expect(await Bun.file(breakerPath).exists()).toBe(true);
	});
});
