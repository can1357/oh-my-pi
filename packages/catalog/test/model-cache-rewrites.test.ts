import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	getModelCacheWriteStats,
	readCacheForHeaderRestore,
	readModelCache,
	readModelCaches,
	retainModelCacheConnection,
	staticCatalogSources,
	writeModelCache,
} from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { modelsDevCatalogFallback } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { VERSION } from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "../../utils/src/temp";
import rules from "../src/compat/rules.json" with { type: "json" };

const TTL_MS = 24 * 60 * 60 * 1000;

function spec(id: string, provider = "rewrite-test"): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://rewrite.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function model(id: string, provider = "rewrite-test"): Model<"openai-completions"> {
	return buildModel(spec(id, provider));
}

interface PayloadRow {
	updated_at: number;
	authoritative: number;
	models: string;
}

function payloadRow(dbPath: string, providerId: string): PayloadRow | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.query<PayloadRow, [string]>("SELECT updated_at, authoritative, models FROM model_cache WHERE provider_id = ?")
			.get(providerId);
	} finally {
		db.close();
	}
}

function payloadWrites(): number {
	return getModelCacheWriteStats().payloadWrites;
}

describe("model cache write churn", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-cache-rewrites-"));
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
			dbPath = "";
		}
	});

	it("advances freshness of an unchanged refresh without rewriting the payload row", () => {
		const models = [model("a"), model("b")];
		const before = payloadWrites();
		writeModelCache("rewrite-test", 1_000, models, true, "fp", dbPath);
		expect(payloadWrites() - before).toBe(1);

		writeModelCache("rewrite-test", 2_000, [model("a"), model("b")], true, "fp", dbPath);
		expect(payloadWrites() - before).toBe(1);
		// The multi-MB record is untouched; freshness lives in the side row.
		expect(payloadRow(dbPath, "rewrite-test")?.updated_at).toBe(1_000);
		const refreshed = readModelCache("rewrite-test", TTL_MS, () => 2_500, dbPath);
		expect(refreshed?.updatedAt).toBe(2_000);
		expect(refreshed?.fresh).toBe(true);
		expect(refreshed?.authoritative).toBe(true);

		// An identical repeat is a complete no-op.
		const skippedBefore = getModelCacheWriteStats().skippedWrites;
		writeModelCache("rewrite-test", 2_000, models, true, "fp", dbPath);
		expect(getModelCacheWriteStats().skippedWrites - skippedBefore).toBe(1);
		expect(payloadWrites() - before).toBe(1);
	});

	it("flips authority without rewriting an unchanged payload", () => {
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		const before = payloadWrites();
		writeModelCache("rewrite-test", 2_000, [model("a")], false, "fp", dbPath);
		expect(payloadWrites()).toBe(before);
		const entry = readModelCache("rewrite-test", TTL_MS, () => 2_000, dbPath);
		expect(entry?.authoritative).toBe(false);
		expect(entry?.updatedAt).toBe(2_000);
		// The side row carries freshness and retry authority only; the payload still
		// records that its models came from an authoritative discovery result.
		expect(entry?.payloadAuthoritative).toBe(true);
		expect(payloadRow(dbPath, "rewrite-test")?.authoritative).toBe(1);
	});

	it("rewrites a changed payload and drops the stale freshness row", () => {
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		writeModelCache("rewrite-test", 2_000, [model("a")], true, "fp", dbPath);
		const before = payloadWrites();
		writeModelCache("rewrite-test", 3_000, [model("a"), model("c")], false, "fp", dbPath);
		expect(payloadWrites() - before).toBe(1);
		const entry = readModelCache("rewrite-test", TTL_MS, () => 3_000, dbPath);
		expect(entry?.models.map(m => m.id)).toEqual(["a", "c"]);
		expect(entry?.updatedAt).toBe(3_000);
		expect(entry?.authoritative).toBe(false);
		const db = new Database(dbPath, { readonly: true });
		const refreshRows = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM model_cache_freshness").get();
		db.close();
		expect(refreshRows?.count).toBe(0);
	});

	it("revalidates header provenance even when the model payload is unchanged", () => {
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		const before = readModelCache("rewrite-test", TTL_MS, () => 1_000, dbPath);
		expect(before?.headerOmittedModelIds).toEqual([]);
		const db = new Database(dbPath);
		try {
			const update = db.query(
				"UPDATE model_cache SET header_omitted_model_ids = ? WHERE provider_id = 'rewrite-test'",
			);
			update.run('["a"]');
			const after = readModelCache("rewrite-test", TTL_MS, () => 1_000, dbPath);
			expect(after?.models).toBe(before?.models);
			expect(after?.headerOmittedModelIds).toEqual(["a"]);
			update.run("invalid");
			expect(readModelCache("rewrite-test", TTL_MS, () => 1_000, dbPath)).toBeNull();
			expect(payloadRow(dbPath, "rewrite-test")).toBeNull();
		} finally {
			db.close();
		}
	});

	it("batch reads isolate corrupt rows, observe repairs and refresh side rows, and age preloaded entries", () => {
		using _connection = retainModelCacheConnection(dbPath);
		const ids = ["absent", "good", "bad", "good"];
		const load = (now: number) => readModelCaches(ids, 100, () => now, dbPath);
		for (const id of ["good", "bad"]) writeModelCache(id, 1_000, [model("initial", id)], true, "fp", dbPath);
		const first = load(1_000);
		expect(first.size).toBe(2);
		expect(first.get("good")?.fresh).toBe(true);

		const db = new Database(dbPath);
		try {
			db.run("UPDATE model_cache SET header_omitted_model_ids = 'invalid' WHERE provider_id = 'bad'");
			db.run("UPDATE model_cache SET models_hash = '' WHERE provider_id = 'good'");
			const stale = load(2_000);
			expect([...stale.keys()]).toEqual(["good"]);
			// The legacy writer left no hash. Its actual bytes still identify the parsed models.
			expect(stale.get("good")?.models).toBe(first.get("good")?.models);
			expect(stale.get("good")?.payloadIdentity).toBeUndefined();
			expect(stale.get("good")?.fresh).toBe(false);
			expect(payloadRow(dbPath, "bad")).toBeNull();
			db.run("UPDATE model_cache SET models = '[]' WHERE provider_id = 'good'");
			expect(load(2_000).get("good")?.models).toEqual([]);
		} finally {
			db.close();
		}

		writeModelCache("bad", 2_000, [model("recovered", "bad")], true, "fp", dbPath);
		writeModelCache("bad", 3_000, [model("recovered", "bad")], false, "fp", dbPath);
		writeModelCache("absent", 3_000, [model("new", "absent")], true, "fp", dbPath);
		const recovered = load(3_000);
		expect(recovered.get("absent")?.models[0].id).toBe("new");
		expect(recovered.get("bad")).toMatchObject({ updatedAt: 3_000, authoritative: false, fresh: true });
		expect(recovered.get("bad")?.models[0].id).toBe("recovered");
	});

	it("does not reuse a retained connection's change counter after reopening the same path", () => {
		const ids = ["rewrite-test", "absent"];
		{
			using _connection = retainModelCacheConnection(dbPath);
			writeModelCache("rewrite-test", 1_000, [model("original")], true, "fp", dbPath);
			expect(readModelCaches(ids, 100, () => 1_000, dbPath).get("rewrite-test")?.fresh).toBe(true);
			expect(readModelCaches(ids, 100, () => 2_000, dbPath).get("rewrite-test")?.fresh).toBe(false);
		}
		const db = new Database(dbPath);
		db.run("UPDATE model_cache SET models = '[]' WHERE provider_id = 'rewrite-test'");
		db.close();
		using _reopened = retainModelCacheConnection(dbPath);
		expect(readModelCaches(ids, 100, () => 1_000, dbPath).get("rewrite-test")?.models).toEqual([]);
	});

	it("ignores a side row left behind by a payload another writer replaced", () => {
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		writeModelCache("rewrite-test", 5_000, [model("a")], true, "fp", dbPath);
		// Simulate an older binary rewriting the payload without knowing the side table.
		const db = new Database(dbPath);
		db.run("UPDATE model_cache SET updated_at = 3000, authoritative = 0 WHERE provider_id = 'rewrite-test'");
		db.close();
		const entry = readModelCache("rewrite-test", TTL_MS, () => 3_000, dbPath);
		expect(entry?.updatedAt).toBe(3_000);
		expect(entry?.authoritative).toBe(false);
	});

	/** Serialized `models` payload for `ids`, as this binary writes it. */
	function payloadFor(ids: string[]): string {
		const otherPath = path.join(tempDir, "payload-source.db");
		writeModelCache(
			"rewrite-test",
			1_000,
			ids.map(id => model(id)),
			true,
			"fp",
			otherPath,
		);
		const row = payloadRow(otherPath, "rewrite-test");
		if (!row) throw new Error("expected payload row");
		return row.models;
	}

	it("re-reads a row an older binary replaced without recording its payload hash", () => {
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		expect(readModelCache("rewrite-test", TTL_MS, () => 1_000, dbPath)?.models.map(m => m.id)).toEqual(["a"]);
		const replacement = payloadFor(["a", "legacy"]);
		const db = new Database(dbPath);
		db.run(
			`INSERT OR REPLACE INTO model_cache (
				provider_id, version, materialization_policy, updated_at, authoritative, static_fingerprint,
				header_omitted_model_ids, unrestorable_header_model_ids, header_restore_version, models
			)
			SELECT provider_id, version, materialization_policy, updated_at, authoritative, static_fingerprint,
				header_omitted_model_ids, unrestorable_header_model_ids, header_restore_version, ?
			FROM model_cache WHERE provider_id = 'rewrite-test'`,
			[replacement],
		);
		db.close();
		expect(readModelCache("rewrite-test", TTL_MS, () => 1_000, dbPath)?.models.map(m => m.id)).toEqual([
			"a",
			"legacy",
		]);
	});

	/** Copy this build's `rewrite-test` row under `policy`, the way another build's `INSERT OR REPLACE` lands. */
	function writeAsOtherBuild(policy: string, updatedAt: number): void {
		const db = new Database(dbPath);
		db.run(
			`INSERT OR REPLACE INTO model_cache (
				provider_id, version, materialization_policy, updated_at, authoritative, static_fingerprint,
				header_omitted_model_ids, unrestorable_header_model_ids, header_restore_version, models
			)
			SELECT provider_id, version, ?, ?, authoritative, static_fingerprint,
				header_omitted_model_ids, unrestorable_header_model_ids, header_restore_version, ?
			FROM model_cache WHERE provider_id = 'rewrite-test' LIMIT 1`,
			[policy, updatedAt, payloadFor(["other-build"])],
		);
		db.close();
	}

	function policyRows(): string[] {
		const db = new Database(dbPath, { readonly: true });
		try {
			return db
				.query<{ policy: string }, []>(
					"SELECT materialization_policy AS policy FROM model_cache WHERE provider_id = 'rewrite-test' ORDER BY updated_at",
				)
				.all()
				.map(row => row.policy);
		} finally {
			db.close();
		}
	}

	it("uses a plain snapshot offline until a compact refresh wins in every startup reader", () => {
		const provider = "rewrite-test";
		const legacyPolicy = `app-${VERSION}:builder-2:rules-${rules.version}-${rules.hash}`;
		const db = new Database(dbPath);
		try {
			writeModelCache(provider, 1_000, [model("previous")], true, "fp", dbPath);
			db.run("UPDATE model_cache SET materialization_policy = ?", [legacyPolicy]);
			expect(readModelCache(provider, TTL_MS, () => 2_000, dbPath)?.models.map(m => m.id)).toEqual(["previous"]);
			writeModelCache(provider, 2_000, [model("current-a"), model("current-b")], true, "fp", dbPath);
			const ids = [provider, "absent"];
			expect(
				readModelCaches(ids, TTL_MS, () => 2_000, dbPath)
					.get(provider)
					?.models.map(m => m.id),
			).toEqual(["current-a", "current-b"]);
			expect(staticCatalogSources(ids, TTL_MS, 2_000, dbPath)?.updatedAt.get(provider)).toBe(2_000);
			expect(
				db.query("SELECT updated_at FROM model_cache WHERE materialization_policy = ?").get(legacyPolicy),
			).toEqual({ updated_at: 1_000 });
		} finally {
			db.close();
		}
	});

	it("restores independently writable and enumerable compat records through chained references", () => {
		const rows = ["anchor", "sibling", "chained"].map(id =>
			buildModel({
				...spec(id),
				headers: { "X-Route": "fixture" },
				compat: { reasoningEffortMap: { high: "high-test" } },
			}),
		);
		writeModelCache("rewrite-test", 1_000, rows, true, "fp", dbPath);
		const db = new Database(dbPath);
		try {
			db.run(`UPDATE model_cache SET models = json_set(models,
				'$[0].compat.__proto__', json('[{"effort":"original"}]'), '$[2].compat', 1)`);
		} finally {
			db.close();
		}
		const entry = readCacheForHeaderRestore<"openai-completions">("rewrite-test", TTL_MS, () => 1_000, dbPath);
		if (!entry) throw new Error("missing compact models");
		const [anchor, sibling, chained] = entry.models;
		for (const row of [sibling, chained]) {
			expect(Object.keys(row.compat)).toEqual(Object.keys(anchor.compat));
			expect(JSON.stringify(row.compat)).toBe(JSON.stringify(anchor.compat));
			expect(Object.getPrototypeOf(row.compat)).toBe(Object.prototype);
		}
		const settings = (row: typeof anchor) => Reflect.get(row.compat, "__proto__") as { effort: string }[];
		anchor.compat.reasoningEffortMap.high = "anchor-only";
		sibling.compat.reasoningEffortMap.high = "sibling-only";
		settings(sibling)[0].effort = "sibling-only";
		settings(chained).push({ effort: "chained-only" });
		expect(chained.compat.reasoningEffortMap.high).toBe("high-test");
		expect(settings(anchor)).toEqual([{ effort: "original" }]);
		expect(settings(chained)[0].effort).toBe("original");
		expect(settings(sibling)).toEqual([{ effort: "sibling-only" }]);
	});

	it("rejects a compat reference with no preceding anchor and reloads a repaired row", () => {
		const provider = "rewrite-test";
		writeModelCache(provider, 1_000, [model("only")], true, "fp", dbPath);
		const db = new Database(dbPath);
		try {
			db.run("UPDATE model_cache SET models = json_set(models, '$[0].compat', 0)");
			expect(readModelCache(provider, TTL_MS, () => 1_000, dbPath)).toBeNull();
			expect(payloadRow(dbPath, provider)).toBeNull();
			writeModelCache(provider, 2_000, [model("repaired")], true, "fp", dbPath);
			expect(readModelCache(provider, TTL_MS, () => 2_000, dbPath)?.models[0]?.id).toBe("repaired");
		} finally {
			db.close();
		}
	});

	it("keeps this build's row when another app version writes the same provider", () => {
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		writeAsOtherBuild("app-0.0.0:builder-1:rules-other", 2_000);

		expect(readModelCache("rewrite-test", TTL_MS, () => 2_000, dbPath)?.models.map(m => m.id)).toEqual(["a"]);
		// An unchanged rewrite by this build only advances freshness; the other build's row stays.
		const before = payloadWrites();
		writeModelCache("rewrite-test", 3_000, [model("a")], true, "fp", dbPath);
		expect(payloadWrites()).toBe(before);
		expect(policyRows()).toHaveLength(2);
	});

	it("prunes other builds' rows to the most recently written ones on a payload write", () => {
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		for (let i = 1; i <= 4; i++) writeAsOtherBuild(`app-0.0.${i}:builder-1:rules-other`, 1_000 + i);

		writeModelCache("rewrite-test", 9_000, [model("a"), model("b")], true, "fp", dbPath);
		const rows = policyRows();
		expect(rows).toHaveLength(3);
		expect(rows.slice(0, 2)).toEqual(["app-0.0.3:builder-1:rules-other", "app-0.0.4:builder-1:rules-other"]);
		expect(readModelCache("rewrite-test", TTL_MS, () => 9_000, dbPath)?.models.map(m => m.id)).toEqual(["a", "b"]);
	});

	it("rekeys a provider-keyed table from an older build without losing its rows", () => {
		const db = new Database(dbPath);
		db.run(`
			CREATE TABLE model_cache (
				provider_id TEXT PRIMARY KEY,
				version INTEGER NOT NULL,
				materialization_policy TEXT NOT NULL DEFAULT '',
				updated_at INTEGER NOT NULL,
				authoritative INTEGER NOT NULL DEFAULT 0,
				static_fingerprint TEXT NOT NULL DEFAULT '',
				header_omitted_model_ids TEXT NOT NULL DEFAULT '[]',
				unrestorable_header_model_ids TEXT NOT NULL DEFAULT '[]',
				header_restore_version INTEGER NOT NULL DEFAULT 0,
				models_hash TEXT NOT NULL DEFAULT '',
				models TEXT NOT NULL
			)
		`);
		db.run(
			"INSERT INTO model_cache (provider_id, version, materialization_policy, updated_at, models) VALUES (?, 15, ?, 500, '[]')",
			["rewrite-test", "app-0.0.0:builder-1:rules-old"],
		);
		db.close();

		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		expect(policyRows()).toEqual(["app-0.0.0:builder-1:rules-old", expect.stringMatching(/^app-/)]);
		// The older build's provider-keyed upsert now replaces only its own row.
		writeAsOtherBuild("app-0.0.0:builder-1:rules-old", 2_000);
		expect(readModelCache("rewrite-test", TTL_MS, () => 2_000, dbPath)?.models.map(m => m.id)).toEqual(["a"]);
		expect(policyRows()).toHaveLength(2);
	});

	it("re-reads and rewrites a payload edited in place", () => {
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		expect(readModelCache("rewrite-test", TTL_MS, () => 1_000, dbPath)?.models.map(m => m.id)).toEqual(["a"]);
		const edited = payloadFor(["a", "edited"]);
		const db = new Database(dbPath);
		db.run("UPDATE model_cache SET models = ? WHERE provider_id = 'rewrite-test'", [edited]);
		db.close();
		expect(readModelCache("rewrite-test", TTL_MS, () => 1_000, dbPath)?.models.map(m => m.id)).toEqual([
			"a",
			"edited",
		]);

		// Writing the original snapshot again must replace the edited row, not skip it as unchanged.
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		expect(readModelCache("rewrite-test", TTL_MS, () => 1_000, dbPath)?.models.map(m => m.id)).toEqual(["a"]);
	});

	it("does not re-persist an unchanged snapshot while discovery keeps failing", async () => {
		let online = true;
		let clock = 10_000;
		const options = {
			providerId: "failing-discovery-test",
			staticModels: [spec("static-a", "failing-discovery-test")],
			cacheDbPath: dbPath,
			now: () => clock,
			fetchDynamicModels: async () => {
				if (!online) throw new Error("offline");
				return [spec("dynamic-a", "failing-discovery-test")];
			},
		};
		await resolveProviderModels(options, "online");
		online = false;
		clock += 60_000;
		await resolveProviderModels(options, "online");
		const before = payloadWrites();
		const row = payloadRow(dbPath, "failing-discovery-test");
		for (let attempt = 0; attempt < 3; attempt++) {
			clock += 5 * 60_000;
			await resolveProviderModels(options, "online");
		}
		expect(payloadWrites()).toBe(before);
		expect(payloadRow(dbPath, "failing-discovery-test")).toEqual(row);
		// Freshness still advances so the non-authoritative retry backoff holds.
		const entry = readModelCache("failing-discovery-test", TTL_MS, () => clock, dbPath);
		expect(entry?.updatedAt).toBe(clock);
		expect(entry?.authoritative).toBe(false);
		expect(entry?.models.map(m => m.id).sort()).toEqual(["dynamic-a", "static-a"]);
	});

	it("reads back every bundled provider snapshot it writes", () => {
		const rejected: string[] = [];
		for (const providerId of getBundledProviders()) {
			const models = getBundledModels(providerId as GeneratedProvider);
			writeModelCache(providerId, Date.now(), models, false, "fp", dbPath);
			const entry = readModelCache(providerId, TTL_MS, Date.now, dbPath);
			if (entry?.models.length !== models.length) rejected.push(providerId);
		}
		expect(rejected).toEqual([]);
	});

	it("keeps an offline fallback snapshot instead of writing and deleting it every startup", async () => {
		const offlineFetch: FetchImpl = async () => {
			throw new Error("offline");
		};
		const modelsDev = modelsDevCatalogFallback("azure", offlineFetch);
		if (!modelsDev) throw new Error("azure has no shared catalog fallback");
		const options = { providerId: "azure", modelsDev, cacheDbPath: dbPath };
		const bundled = getBundledModels("azure");
		expect(bundled.length).toBeGreaterThan(0);
		expect(bundled.some(m => m.baseUrl === "")).toBe(true);

		await resolveProviderModels(options, "online");
		const snapshot = readModelCache("azure", TTL_MS, Date.now, dbPath);
		expect(snapshot?.models.length).toBe(bundled.length);

		const before = payloadWrites();
		await resolveProviderModels(options, "online");
		expect(payloadWrites()).toBe(before);
		expect(readModelCache("azure", TTL_MS, Date.now, dbPath)?.models.length).toBe(bundled.length);
	});
});

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

// A physically corrupt models.db must not permanently disable the model cache.
// On an unrecoverable SQLITE_CORRUPT/NOTADB failure the shared cache quarantines
// the broken file, recreates a fresh database, and retries the operation once.
describe("model cache corruption self-heal", () => {
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
		writeModelCache("runtime-ext", Date.now(), [model("bootstrap", "runtime-ext")], true, "fp1", dbPath);
		await corruptDbPages(dbPath);

		// A read of the corrupt file must not throw and must self-heal to an empty cache.
		expect(readModelCache<"openai-completions">("runtime-ext", TTL_MS, Date.now, dbPath)).toBeNull();
		expect((await quarantinedFiles(tempDir)).length).toBeGreaterThan(0);

		// The successful live catalog now persists into the recreated database...
		writeModelCache(
			"runtime-ext",
			Date.now(),
			[model("discovered-a", "runtime-ext"), model("discovered-b", "runtime-ext")],
			true,
			"fp2",
			dbPath,
		);

		// ...and a later process (fresh read) sees it instead of a permanent miss.
		const healed = readModelCache<"openai-completions">("runtime-ext", TTL_MS, Date.now, dbPath);
		expect(healed?.models.map(entry => entry.id)).toEqual(["discovered-a", "discovered-b"]);
	});

	it("recreates a SQLITE_NOTADB cache on write so discovery can persist", async () => {
		writeModelCache("runtime-ext", Date.now(), [model("bootstrap", "runtime-ext")], true, "fp1", dbPath);
		// Overwrite with bytes that are not a SQLite database at all.
		await fs.writeFile(dbPath, Buffer.from("not a database".repeat(64)));

		writeModelCache("runtime-ext", Date.now(), [model("discovered", "runtime-ext")], true, "fp2", dbPath);

		expect((await quarantinedFiles(tempDir)).length).toBeGreaterThan(0);
		const healed = readModelCache<"openai-completions">("runtime-ext", TTL_MS, Date.now, dbPath);
		expect(healed?.models.map(entry => entry.id)).toEqual(["discovered"]);
	});

	it("never quarantines a healthy cache", async () => {
		writeModelCache("runtime-ext", Date.now(), [model("bootstrap", "runtime-ext")], true, "fp1", dbPath);
		const cached = readModelCache<"openai-completions">("runtime-ext", TTL_MS, Date.now, dbPath);
		expect(cached?.models.map(entry => entry.id)).toEqual(["bootstrap"]);
		expect(await quarantinedFiles(tempDir)).toEqual([]);
	});
});
