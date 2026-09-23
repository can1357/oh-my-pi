// Contract (#8867): a physically corrupt models.db must not permanently
// disable the model cache. On an unrecoverable SQLITE_CORRUPT/NOTADB failure
// the shared cache quarantines the broken file, recreates a fresh database,
// and retries the operation once — so a successful live catalog can be
// persisted and read back by later processes. Non-corruption reads of a
// healthy cache never quarantine anything.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { removeWithRetries } from "../../utils/src/temp";

const TTL_MS = 24 * 60 * 60 * 1000;

function createModel(id: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "runtime-ext",
		baseUrl: "https://ext.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	});
}

async function foldWalIntoMainDb(dbPath: string): Promise<void> {
	const db = new Database(dbPath);
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	db.close();
	await removeWithRetries(`${dbPath}-wal`);
	await removeWithRetries(`${dbPath}-shm`);
}

/** Clobber every byte after the 100-byte header — a valid header over garbage pages yields SQLITE_CORRUPT. */
async function corruptDbPages(dbPath: string): Promise<void> {
	await foldWalIntoMainDb(dbPath);
	const buf = await fs.readFile(dbPath);
	buf.fill(0xff, 100);
	await fs.writeFile(dbPath, buf);
}

async function quarantinedFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir);
	return entries.filter(name => name.startsWith("models.db.corrupt-"));
}

describe("model cache corruption self-heal (#8867)", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-corrupt-cache-"));
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
			dbPath = "";
		}
	});

	it("quarantines a SQLITE_CORRUPT cache and persists the authoritative catalog", async () => {
		writeModelCache("runtime-ext", Date.now(), [createModel("bootstrap")], true, "fp1", dbPath);
		await corruptDbPages(dbPath);

		// A read of the corrupt file must not throw and must self-heal to an empty cache.
		expect(readModelCache<"openai-completions">("runtime-ext", TTL_MS, Date.now, dbPath)).toBeNull();
		expect((await quarantinedFiles(tempDir)).length).toBeGreaterThan(0);

		// The successful live catalog now persists into the recreated database...
		writeModelCache(
			"runtime-ext",
			Date.now(),
			[createModel("discovered-a"), createModel("discovered-b")],
			true,
			"fp2",
			dbPath,
		);

		// ...and a later process (fresh read) sees it instead of a permanent miss.
		const healed = readModelCache<"openai-completions">("runtime-ext", TTL_MS, Date.now, dbPath);
		expect(healed?.models.map(model => model.id)).toEqual(["discovered-a", "discovered-b"]);
	});

	it("recreates a SQLITE_NOTADB cache on write so discovery can persist", async () => {
		writeModelCache("runtime-ext", Date.now(), [createModel("bootstrap")], true, "fp1", dbPath);
		// Overwrite with bytes that are not a SQLite database at all.
		await fs.writeFile(dbPath, Buffer.from("not a database".repeat(64)));

		writeModelCache("runtime-ext", Date.now(), [createModel("discovered")], true, "fp2", dbPath);

		expect((await quarantinedFiles(tempDir)).length).toBeGreaterThan(0);
		const healed = readModelCache<"openai-completions">("runtime-ext", TTL_MS, Date.now, dbPath);
		expect(healed?.models.map(model => model.id)).toEqual(["discovered"]);
	});

	it("never quarantines a healthy cache", async () => {
		writeModelCache("runtime-ext", Date.now(), [createModel("bootstrap")], true, "fp1", dbPath);
		const cached = readModelCache<"openai-completions">("runtime-ext", TTL_MS, Date.now, dbPath);
		expect(cached?.models.map(model => model.id)).toEqual(["bootstrap"]);
		expect(await quarantinedFiles(tempDir)).toEqual([]);
	});
});
