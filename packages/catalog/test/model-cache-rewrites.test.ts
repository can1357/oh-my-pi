import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getModelCacheWriteStats, readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { modelsDevCatalogFallback } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { removeWithRetries } from "../../utils/src/temp";

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
		const refreshRows = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM model_cache_refresh").get();
		db.close();
		expect(refreshRows?.count).toBe(0);
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
