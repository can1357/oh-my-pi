import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import {
	closeSessionIndex,
	listSessionRecaps,
	lookupSessionTitle,
	recordSessionRecap,
	recordSessionTitle,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { getAgentDir, logger, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir;
let originalAgentDir: string;
let originalAgentEnv: string | undefined;
const peers = new Set<Bun.Subprocess<"pipe", "pipe", "pipe">>();

beforeEach(() => {
	HistoryStorage.close();
	closeSessionIndex();
	originalAgentDir = getAgentDir();
	originalAgentEnv = process.env.PI_CODING_AGENT_DIR;
	tempDir = TempDir.createSync("@omp-history-wal-guard-");
	setAgentDir(tempDir.path());
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const peer of peers) peer.kill();
	await Promise.all([...peers].map(peer => peer.exited));
	peers.clear();
	closeSessionIndex();
	HistoryStorage.close();
	setAgentDir(originalAgentDir);
	if (originalAgentEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentEnv;
	await tempDir.remove();
});

async function runPeer(script: string): Promise<string> {
	const peer = Bun.spawn([process.execPath, "--eval", script], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		peer.exited,
		new Response(peer.stdout).text(),
		new Response(peer.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	return stdout;
}

async function writePeer(dbPath: string, prefix: string, count: number, keepOpen = false) {
	const peer = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
				import { Database } from "bun:sqlite";
				const db = new Database(${JSON.stringify(dbPath)});
				db.run("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0;");
				const insert = db.query("INSERT INTO history (prompt) VALUES (?)");
				db.transaction(() => {
					for (let i = 0; i < ${count}; i++) insert.run(${JSON.stringify(prefix)} + i);
				})();
				${keepOpen ? 'console.log("ready"); await Bun.stdin.text();' : ""}
				db.close();
			`,
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	peers.add(peer);
	if (keepOpen) {
		const reader = peer.stdout.getReader();
		const { value } = await reader.read();
		reader.releaseLock();
		expect(new TextDecoder().decode(value)).toContain("ready");
	} else {
		await finishPeer(peer);
	}
	return peer;
}

async function finishPeer(peer: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
	peer.stdin.end();
	const [exitCode, stderr] = await Promise.all([peer.exited, new Response(peer.stderr).text()]);
	peers.delete(peer);
	expect(exitCode, stderr).toBe(0);
}

function loseLocks(dbPath: string): void {
	// POSIX close() drops this process's SQLite locks even on an unrelated fd.
	for (const file of [dbPath, `${dbPath}-shm`]) {
		if (fs.existsSync(file)) fs.closeSync(fs.openSync(file, "r"));
	}
}

function checksum(file: string): string | undefined {
	if (!fs.existsSync(file)) return undefined;
	// Reading the DB in this process would itself cancel SQLite's POSIX locks.
	const result = Bun.spawnSync(["sha256sum", file], { stdout: "pipe", stderr: "pipe" });
	expect(result.exitCode, result.stderr.toString()).toBe(0);
	return result.stdout.toString().split(" ")[0];
}

async function liveState(dbPath: string) {
	return JSON.parse(
		await runPeer(`
			import { Database } from "bun:sqlite";
			const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
			console.log(JSON.stringify({
				count: db.query("SELECT count(*) AS count FROM history").get().count,
				integrity: db.query("PRAGMA integrity_check").get().integrity_check,
			}));
			db.close();
		`),
	);
}

function substituteQuery(from: string, to: string) {
	const query = Database.prototype.query;
	return vi.spyOn(Database.prototype, "query").mockImplementation(function <
		Row,
		Params extends SQLQueryBindings | SQLQueryBindings[],
	>(this: Database, sql: string) {
		return query.bind(this)<Row, Params>(sql === from ? to : sql);
	});
}

describe("HistoryStorage WAL identity", () => {
	it("keeps one connection for ordinary writes, including a reopened empty store", async () => {
		const dbPath = tempDir.join("history.db");
		HistoryStorage.open(dbPath);
		HistoryStorage.close();
		const storage = HistoryStorage.open(dbPath);
		expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
		const prepare = vi.spyOn(Database.prototype, "prepare");

		await storage.add("first prompt");
		await storage.add("second prompt");
		await storage.add("first prompt");

		expect(prepare).not.toHaveBeenCalled();
		expect(storage.getRecent(10)).toHaveLength(2);
	});

	it.skipIf(process.platform !== "linux")("reopens exactly once when a peer replaces the WAL inode", async () => {
		const dbPath = tempDir.join("history.db");
		const storage = HistoryStorage.open(dbPath);
		await storage.add("before replacement");
		const original = fs.statSync(`${dbPath}-wal`);
		loseLocks(dbPath);
		await writePeer(dbPath, "checkpointed-", 1);
		const peer = await writePeer(dbPath, "live-", 1, true);
		expect(fs.statSync(`${dbPath}-wal`).ino).not.toBe(original.ino);
		const close = vi.spyOn(Database.prototype, "close");

		await storage.add("after replacement");
		expect(close).toHaveBeenCalledTimes(1);
		await storage.add("next prompt");
		expect(close).toHaveBeenCalledTimes(1);
		await finishPeer(peer);
		HistoryStorage.close();
		expect(await liveState(dbPath)).toEqual({ count: 5, integrity: "ok" });
	});

	it.skipIf(process.platform !== "linux")(
		"stops both writers without checkpointing when a replacement WAL has unbackfilled frames",
		async () => {
			const dbPath = tempDir.join("history.db");
			const storage = HistoryStorage.open(dbPath);
			await storage.add("before replacement");
			recordSessionTitle("session", "original title");
			recordSessionRecap("session", "/repo", "original recap");
			const walPath = `${dbPath}-wal`;
			fs.renameSync(walPath, `${walPath}.old`);
			fs.copyFileSync(`${walPath}.old`, walPath);
			const before = checksum(dbPath);
			const walBefore = checksum(walPath);
			const close = vi.spyOn(Database.prototype, "close");
			const prepare = vi.spyOn(Database.prototype, "prepare");
			const warning = vi.spyOn(logger, "warn");
			const added = vi.fn();
			const failed = vi.fn();
			storage.setAddListener(added);
			storage.setErrorListener(failed);

			await storage.add("must not persist");
			await storage.add("still must not persist");
			recordSessionTitle("session", "must not replace title");
			recordSessionRecap("session", "/repo", "must not append recap");
			expect(storage.getRecent(10).map(entry => entry.prompt)).toEqual(["before replacement"]);
			expect(lookupSessionTitle("session")).toBe("original title");
			closeSessionIndex();
			HistoryStorage.close();

			expect(close).not.toHaveBeenCalled();
			expect(prepare).not.toHaveBeenCalled();
			expect(listSessionRecaps({ sessionIds: ["session"] }).map(entry => entry.recap)).toEqual(["original recap"]);
			expect(added).not.toHaveBeenCalled();
			expect(failed).toHaveBeenCalledTimes(1);
			expect(failed).toHaveBeenCalledWith(new Error("History writes are disabled for this database"));
			expect(warning).toHaveBeenCalledTimes(1);
			expect(checksum(dbPath)).toBe(before);
			expect(checksum(walPath)).toBe(walBefore);
		},
	);

	it.skipIf(process.platform !== "linux")(
		"opens prompt history read-only after the session index disables writes",
		async () => {
			const dbPath = tempDir.join("history.db");
			await runPeer(`
				import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
				const storage = HistoryStorage.open(${JSON.stringify(dbPath)});
				await storage.add("saved prompt", "/repo", "saved-session");
				HistoryStorage.close();
			`);
			recordSessionTitle("session", "original title");
			const walPath = `${dbPath}-wal`;
			fs.renameSync(walPath, `${walPath}.old`);
			fs.copyFileSync(`${walPath}.old`, walPath);
			const warning = vi.spyOn(logger, "warn");
			recordSessionTitle("session", "must not replace title");
			expect(warning).toHaveBeenCalledTimes(1);
			expect(lookupSessionTitle("session")).toBe("original title");
			const before = checksum(dbPath);
			const walBefore = checksum(walPath);
			const run = vi.spyOn(Database.prototype, "run");
			const close = vi.spyOn(Database.prototype, "close");

			const storage = HistoryStorage.open();
			expect(storage.getRecent(10).map(entry => entry.prompt)).toEqual(["saved prompt"]);
			expect(storage.search("saved", 10).map(entry => entry.prompt)).toEqual(["saved prompt"]);
			expect(storage.search("aved", 10).map(entry => entry.prompt)).toEqual(["saved prompt"]);
			expect(storage.matchingSessionIds("saved")).toEqual(["saved-session"]);
			const added = vi.fn();
			const failed = vi.fn();
			storage.setAddListener(added);
			storage.setErrorListener(failed);
			await storage.add("must not persist");
			await storage.add("still must not persist");
			expect(added).not.toHaveBeenCalled();
			expect(failed).toHaveBeenCalledTimes(1);
			expect(failed).toHaveBeenCalledWith(new Error("History writes are disabled for this database"));
			expect(run).not.toHaveBeenCalled();
			HistoryStorage.close();

			expect(close).not.toHaveBeenCalled();
			expect(checksum(dbPath)).toBe(before);
			expect(checksum(walPath)).toBe(walBefore);
		},
	);

	it.skipIf(process.platform !== "linux")("never attempts NOOP on SQLite older than 3.51", async () => {
		const dbPath = tempDir.join("history.db");
		const storage = HistoryStorage.open(dbPath);
		await storage.add("before replacement");
		loseLocks(dbPath);
		await writePeer(dbPath, "peer-", 1);
		const before = checksum(dbPath);
		const queries = substituteQuery("SELECT sqlite_version() AS version", "SELECT '3.50.4' AS version");
		const close = vi.spyOn(Database.prototype, "close");
		const prepare = vi.spyOn(Database.prototype, "prepare");

		await storage.add("must not persist");
		HistoryStorage.close();

		expect(queries.mock.calls.some(([sql]) => sql.includes("sqlite_version()"))).toBe(true);
		expect(queries.mock.calls.some(([sql]) => sql.includes("wal_checkpoint(NOOP)"))).toBe(false);
		expect(close).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
		expect(checksum(dbPath)).toBe(before);
		expect(await liveState(dbPath)).toEqual({ count: 2, integrity: "ok" });
	});

	for (const [name, sql] of [
		["unavailable WAL counters", "SELECT 0 AS busy, -1 AS log, -1 AS checkpointed"],
		["failed NOOP inspection", "SELECT no_such_function()"],
	]) {
		it.skipIf(process.platform !== "linux")(`retains both handles after ${name}`, async () => {
			const dbPath = tempDir.join("history.db");
			const storage = HistoryStorage.open(dbPath);
			await storage.add("seed prompt");
			recordSessionTitle("session", "original title");
			loseLocks(dbPath);
			await writePeer(dbPath, "peer-", 1);
			const before = checksum(dbPath);
			const queries = substituteQuery("PRAGMA wal_checkpoint(NOOP)", sql);
			const close = vi.spyOn(Database.prototype, "close");
			const prepare = vi.spyOn(Database.prototype, "prepare");

			await storage.add("must not persist");
			recordSessionTitle("session", "must not persist");
			closeSessionIndex();
			HistoryStorage.close();

			expect(queries.mock.calls.some(([query]) => query === "PRAGMA wal_checkpoint(NOOP)")).toBe(true);
			expect(close).not.toHaveBeenCalled();
			expect(prepare).not.toHaveBeenCalled();
			expect(checksum(dbPath)).toBe(before);
			expect(await liveState(dbPath)).toEqual({ count: 2, integrity: "ok" });
		});
	}

	it.skipIf(process.platform !== "linux")(
		"adopts a replaced main file without checkpointing the live store",
		async () => {
			const dbPath = tempDir.join("history.db");
			const storage = HistoryStorage.open(dbPath);
			await storage.add("old prompt");
			recordSessionTitle("session", "old title");
			for (const suffix of ["", "-wal", "-shm"]) {
				fs.renameSync(`${dbPath}${suffix}`, `${dbPath}.old${suffix}`);
			}
			await runPeer(`
			import { Database } from "bun:sqlite";
			const db = new Database(${JSON.stringify(dbPath)});
			db.run(\`
				CREATE TABLE history (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					prompt TEXT NOT NULL UNIQUE,
					created_at INTEGER NOT NULL DEFAULT 0,
					cwd TEXT, session_id TEXT,
					use_count INTEGER NOT NULL DEFAULT 1
				);
				INSERT INTO history (prompt) VALUES ('replacement prompt');
				PRAGMA user_version=1;
			\`);
			db.close();
		`);
			const nativeClose = Database.prototype.close;
			const close = vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database, force) {
				const before = checksum(dbPath);
				nativeClose.call(this, force);
				expect(checksum(dbPath)).toBe(before);
			});

			await storage.add("new prompt");
			expect(close).toHaveBeenCalledTimes(2);
			close.mockRestore();
			recordSessionTitle("session", "new title");
			expect(lookupSessionTitle("session")).toBe("new title");
			closeSessionIndex();
			HistoryStorage.close();
			expect(await liveState(dbPath)).toEqual({ count: 2, integrity: "ok" });
		},
	);
});

for (const withSessionIndex of [false, true]) {
	it.skipIf(process.platform !== "linux")(
		`keeps all 801 prompts after four rounds of lost POSIX locks${withSessionIndex ? " with titles and recaps" : ""}`,
		async () => {
			const dbPath = tempDir.join("history.db");
			const storage = HistoryStorage.open(dbPath);
			await storage.add("seed prompt");
			if (withSessionIndex) recordSessionTitle("session", "initial title");
			expect(storage.search("ed", 10)).toHaveLength(1);
			for (let round = 0; round < 4; round++) {
				loseLocks(dbPath);
				await writePeer(dbPath, `peer-${round}-`, 100);
				if (withSessionIndex) {
					// Exercise both entry points as the first writer after lock loss.
					if (round % 2 === 0) recordSessionTitle("session", `title ${round}`);
					else recordSessionRecap("session", "/repo", `recap ${round}`);
				}
				for (let i = 0; i < 100; i++) await storage.add(`local-${round}-${i}`);
			}
			if (withSessionIndex) expect(lookupSessionTitle("session")).toBe("title 2");
			closeSessionIndex();
			HistoryStorage.close();

			expect(await liveState(dbPath)).toEqual({ count: 801, integrity: "ok" });
			if (withSessionIndex) {
				const recaps = await runPeer(`
					import { Database } from "bun:sqlite";
					const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
					console.log(JSON.stringify(db.query("SELECT recap FROM session_recaps ORDER BY id").all()));
					db.close();
				`);
				expect(JSON.parse(recaps)).toEqual([{ recap: "recap 1" }, { recap: "recap 3" }]);
			}
		},
	);
}

it.skipIf(process.platform !== "linux")(
	"coordinates lazy session-index initialization after peer cleanup",
	async () => {
		const dbPath = tempDir.join("history.db");
		const storage = HistoryStorage.open(dbPath);
		await storage.add("seed prompt");
		loseLocks(dbPath);
		await writePeer(dbPath, "peer-", 100);

		// A cold read opens the index and runs its DDL; existing read paths do no new checks.
		expect(lookupSessionTitle("session")).toBeUndefined();
		recordSessionTitle("session", "fresh title");
		for (let i = 0; i < 100; i++) await storage.add(`local-${i}`);
		expect(lookupSessionTitle("session")).toBe("fresh title");
		closeSessionIndex();
		HistoryStorage.close();

		expect(await liveState(dbPath)).toEqual({ count: 201, integrity: "ok" });
	},
);

it.skipIf(process.platform !== "linux")(
	"does not alter live files when severing both old handles while a peer has an uncheckpointed new WAL",
	async () => {
		const dbPath = tempDir.join("history.db");
		const storage = HistoryStorage.open(dbPath);
		await storage.add("seed prompt");
		recordSessionTitle("session", "initial title");
		for (let round = 0; round < 4; round++) {
			loseLocks(dbPath);
			await writePeer(dbPath, `peer-${round}-`, 100);
			const peer = await writePeer(dbPath, `held-${round}-`, 100, true);
			const nativeClose = Database.prototype.close;
			const close = vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database, force) {
				const mainBefore = checksum(dbPath);
				const walBefore = checksum(`${dbPath}-wal`);
				nativeClose.call(this, force);
				expect(checksum(dbPath)).toBe(mainBefore);
				expect(checksum(`${dbPath}-wal`)).toBe(walBefore);
			});

			await storage.add(`first-local-${round}`);
			expect(close).toHaveBeenCalledTimes(2);
			close.mockRestore();
			for (let i = 1; i < 100; i++) await storage.add(`local-${round}-${i}`);
			await finishPeer(peer);
		}
		closeSessionIndex();
		HistoryStorage.close();

		expect(await liveState(dbPath)).toEqual({ count: 1201, integrity: "ok" });
	},
);

for (const shutdown of ["natural", "postmortem"]) {
	it.skipIf(process.platform !== "linux")(
		`retains upstream's checkpoint-at-exit behavior during ${shutdown} exit`,
		async () => {
			const dbPath = tempDir.join("history.db");
			const result = JSON.parse(
				await runPeer(`
				import { Database } from "bun:sqlite";
				import * as fs from "node:fs";
				import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
				import { closeSessionIndex, recordSessionTitle } from "@oh-my-pi/pi-coding-agent/session/session-index";
				import { postmortem } from "@oh-my-pi/pi-utils";
				const dbPath = ${JSON.stringify(dbPath)};
				const nativeRun = Database.prototype.run;
				let captured;
				Database.prototype.run = function (...args) {
					captured ??= this;
					return nativeRun.apply(this, args);
				};
				const storage = HistoryStorage.open(dbPath);
				Database.prototype.run = nativeRun;
				await storage.add("seed prompt");
				recordSessionTitle("session", "original title");
				fs.renameSync(dbPath + "-wal", dbPath + "-wal.old");
				fs.copyFileSync(dbPath + "-wal.old", dbPath + "-wal");
				const hash = path => {
					const result = Bun.spawnSync(["sha256sum", path], { stdout: "pipe" });
					if (result.exitCode !== 0) throw new Error("checksum failed");
					return result.stdout.toString().split(" ")[0];
				};
				const before = hash(dbPath);
				await storage.add("must not persist");
				recordSessionTitle("session", "must not persist");
				if (!captured) throw new Error("History database was not opened");
				const expected = new Bun.CryptoHasher("sha256").update(captured.serialize()).digest("hex");
				const count = captured.query("SELECT count(*) AS count FROM history").get().count;
				${shutdown === "natural" ? "closeSessionIndex(); HistoryStorage.close(); Bun.gc(true);" : ""}
				console.log(JSON.stringify({ before, expected, count }));
				${shutdown === "postmortem" ? "await postmortem.quit(0);" : ""}
			`),
			);

			// Bun closes native SQLite handles at exit even while JavaScript retains
			// them. Like upstream, this checkpoints their last committed snapshot.
			expect(result.expected).not.toBe(result.before);
			expect(checksum(dbPath)).toBe(result.expected);
			expect(await liveState(dbPath)).toEqual({ count: result.count, integrity: "ok" });
		},
	);
}
