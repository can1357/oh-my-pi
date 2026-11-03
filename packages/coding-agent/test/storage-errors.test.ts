import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

async function corruptDatabase(dbPath: string): Promise<Uint8Array<ArrayBuffer>> {
	const db = new Database(dbPath);
	db.run("CREATE TABLE IF NOT EXISTS preserved (value TEXT)");
	// An unfinalized prepared statement would leave the closed connection a zombie
	// still holding the files, which Windows then refuses to quarantine.
	db.run("INSERT INTO preserved (value) VALUES (?)", ["salvage this data"]);
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	db.close();

	const damaged = await Bun.file(dbPath).bytes();
	// Keep the SQLite header valid while corrupting the first b-tree page type.
	// Opening the file succeeds, but reading its schema raises SQLITE_CORRUPT.
	damaged[100] = 0xff;
	await Bun.write(dbPath, damaged);
	return damaged;
}

/**
 * Damages one b-tree page the store reads while opening, leaving everything else
 * readable. Modeled on the field reports: a cache or bookkeeping page is what
 * gets hurt, while the credential rows themselves survive in the preserved copy.
 */
async function corruptStorePage(dbPath: string, table: string): Promise<Uint8Array<ArrayBuffer>> {
	const db = new Database(dbPath);
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	const root = db
		.query<{ rootpage: number }, [string]>("SELECT rootpage FROM sqlite_master WHERE name = ?")
		.get(table);
	db.close();
	if (!root) throw new Error(`no table root page named ${table} in ${dbPath}`);

	const damaged = await Bun.file(dbPath).bytes();
	const pageSize = (damaged[16]! << 8) | damaged[17]!;
	// An invalid page type makes every read that reaches this page fail, while the
	// file still opens and the other tables' pages stay intact.
	damaged[(root.rootpage - 1) * pageSize] = 0xff;
	await Bun.write(dbPath, damaged);
	return damaged;
}

async function expectQuarantinedDamage(dbPath: string, damaged: Uint8Array<ArrayBuffer>): Promise<void> {
	const prefix = `${path.basename(dbPath)}.corrupt-`;
	const backupNames = (await fs.readdir(path.dirname(dbPath))).filter(
		name => name.startsWith(prefix) && !name.endsWith("-wal") && !name.endsWith("-shm") && !name.endsWith("-journal"),
	);
	expect(backupNames).toHaveLength(1);
	expect(await Bun.file(path.join(path.dirname(dbPath), backupNames[0]!)).bytes()).toEqual(damaged);
}

test("agent startup quarantines corruption and persists new usage", async () => {
	await using tempDir = await TempDir.create("@omp-storage-errors-");
	const dbPath = tempDir.join("agent.db");

	AgentStorage.close();
	const original = await AgentStorage.open(dbPath);
	original.recordModelUsage("openai/damaged");
	AgentStorage.close();
	const damaged = await corruptDatabase(dbPath);

	try {
		const storage = await AgentStorage.open(dbPath);
		expect(storage.getModelUsageOrder()).toEqual([]);
		storage.recordModelUsage("openai/recovered");
	} finally {
		AgentStorage.close();
	}

	const reopened = await AgentStorage.open(dbPath);
	try {
		expect(reopened.getModelUsageOrder()).toEqual(["openai/recovered"]);
	} finally {
		AgentStorage.close();
	}
	await expectQuarantinedDamage(dbPath, damaged);
});

test("history startup quarantines corruption and persists searchable prompts", async () => {
	await using tempDir = await TempDir.create("@omp-storage-errors-");
	const dbPath = tempDir.join("history.db");

	HistoryStorage.close();
	const original = HistoryStorage.open(dbPath);
	await original.add("damaged history prompt", "/damaged", "damaged-session");
	HistoryStorage.close();
	const damaged = await corruptDatabase(dbPath);

	try {
		const storage = HistoryStorage.open(dbPath);
		expect(storage.getRecent(10)).toEqual([]);
		await storage.add("recovered searchable prompt", "/recovered", "recovered-session");
	} finally {
		HistoryStorage.close();
	}

	const reopened = HistoryStorage.open(dbPath);
	try {
		expect(reopened.search("searchable", 10)).toMatchObject([
			{
				prompt: "recovered searchable prompt",
				cwd: "/recovered",
				sessionId: "recovered-session",
			},
		]);
	} finally {
		HistoryStorage.close();
	}
	await expectQuarantinedDamage(dbPath, damaged);
});

test("auth startup quarantines corruption and persists new credentials", async () => {
	await using tempDir = await TempDir.create("@omp-storage-errors-");
	const dbPath = tempDir.join("auth.db");

	const original = await SqliteAuthCredentialStore.open(dbPath);
	await original.saveApiKey("damaged-provider", "damaged-secret");
	original.close();
	const damaged = await corruptDatabase(dbPath);

	const storage = await SqliteAuthCredentialStore.open(dbPath);
	try {
		// The damaged page is the schema page itself, so the preserved copy cannot be
		// read back at all: best-effort credential recovery has nothing to restore.
		expect(storage.listProviders()).toEqual([]);
		expect(storage.getApiKey("damaged-provider")).toBeNull();
		await storage.saveApiKey("recovered-provider", "recovered-secret");
	} finally {
		storage.close();
	}

	const reopened = await SqliteAuthCredentialStore.open(dbPath);
	try {
		expect(reopened.getApiKey("recovered-provider")).toBe("recovered-secret");
	} finally {
		reopened.close();
	}
	await expectQuarantinedDamage(dbPath, damaged);
});

test("concurrent agent and auth startup share one private recovered database", async () => {
	await using tempDir = await TempDir.create("@omp-storage-errors-");
	const dbPath = tempDir.join("agent.db");
	const damaged = await corruptDatabase(dbPath);

	AgentStorage.close();
	let auth: SqliteAuthCredentialStore | undefined;
	try {
		const [agent, openedAuth] = await Promise.all([
			AgentStorage.open(dbPath),
			SqliteAuthCredentialStore.open(dbPath),
		]);
		auth = openedAuth;
		agent.recordModelUsage("openai/concurrent-recovery");
		await auth.saveApiKey("concurrent-provider", "concurrent-secret");
		expect(agent.getModelUsageOrder()).toEqual(["openai/concurrent-recovery"]);
		expect(agent.listAuthCredentials("concurrent-provider")).toMatchObject([
			{ credential: { type: "api_key", key: "concurrent-secret" } },
		]);
		if (process.platform !== "win32") {
			expect((await fs.stat(dbPath)).mode & 0o777).toBe(0o600);
		}
	} finally {
		auth?.close();
		AgentStorage.close();
	}
	await expectQuarantinedDamage(dbPath, damaged);
});

test("auth corruption that spares the credential table restores the preserved credentials", async () => {
	await using tempDir = await TempDir.create("@omp-storage-errors-");
	const dbPath = tempDir.join("auth.db");

	const original = await SqliteAuthCredentialStore.open(dbPath);
	await original.saveApiKey("preserved-provider", "preserved-secret");
	await original.saveApiKey("second-provider", "second-secret");
	original.close();
	// The replacement starts empty, so only a preserved copy whose credential rows
	// survive the damage can bring these logins back.
	const damaged = await corruptStorePage(dbPath, "auth_schema_version");

	const storage = await SqliteAuthCredentialStore.open(dbPath);
	try {
		expect(storage.listProviders().sort()).toEqual(["preserved-provider", "second-provider"]);
		expect(storage.getApiKey("preserved-provider")).toBe("preserved-secret");
		expect(storage.getApiKey("second-provider")).toBe("second-secret");
	} finally {
		storage.close();
	}
	await expectQuarantinedDamage(dbPath, damaged);
});

test("agent.db corruption restores the credentials its preserved copy still holds", async () => {
	await using tempDir = await TempDir.create("@omp-storage-errors-");
	const dbPath = tempDir.join("agent.db");

	const seeded = await SqliteAuthCredentialStore.open(dbPath);
	await seeded.saveApiKey("preserved-provider", "preserved-secret");
	seeded.close();
	const damaged = await corruptStorePage(dbPath, "auth_schema_version");

	AgentStorage.close();
	const storage = await AgentStorage.open(dbPath);
	try {
		// The damaged cache tables come back empty…
		expect(storage.getModelUsageOrder()).toEqual([]);
		// …while the login only the preserved copy still had comes back with them.
		expect(storage.listAuthCredentials("preserved-provider")).toMatchObject([
			{ credential: { type: "api_key", key: "preserved-secret" } },
		]);
		expect(storage.hasAuthCredentials()).toBe(true);
	} finally {
		AgentStorage.close();
	}
	await expectQuarantinedDamage(dbPath, damaged);
});

test("every concurrent agent opener sees restored credentials before using the shared store", async () => {
	await using tempDir = await TempDir.create("@omp-storage-errors-");
	const dbPath = tempDir.join("agent.db");
	const seeded = await SqliteAuthCredentialStore.open(dbPath);
	// Different providers avoid login-time replacement entirely, isolating the
	// publication window from the mixed-provider salvage regression.
	const expected = Array.from({ length: 32 }, (_, index) => ({
		provider: `provider-${index}`,
		credential: { type: "api_key" as const, key: `preserved-key-${index}` },
	}));
	for (const { provider, credential } of expected) await seeded.saveApiKey(provider, credential.key);
	seeded.close();
	const damaged = await corruptStorePage(dbPath, "auth_schema_version");

	AgentStorage.close();
	try {
		const first = AgentStorage.open(dbPath);
		// Cover callers arriving across the initializer's microtask boundaries, not
		// only callers that await the initiating open before reading credentials.
		const observers = Array.from({ length: 16 }, async (_, delay) => {
			for (let tick = 0; tick < delay; tick++) await Promise.resolve();
			const storage = await AgentStorage.open(dbPath);
			return storage.listAuthCredentials().map(({ provider, credential }) => ({ provider, credential }));
		});
		await first;
		for (const credentials of await Promise.all(observers)) expect(credentials).toEqual(expected);
	} finally {
		AgentStorage.close();
	}
	await expectQuarantinedDamage(dbPath, damaged);
});
