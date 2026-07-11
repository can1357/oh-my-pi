import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { runGcCommand } from "@pk-nerdsaver-ai/pi-coding-agent/cli/gc-cli";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import {
	getAgentDir,
	getBlobsDir,
	getHistoryDbPath,
	getSessionsDir,
	setAgentDir,
	setProjectDir,
} from "@pk-nerdsaver-ai/pi-utils";
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
