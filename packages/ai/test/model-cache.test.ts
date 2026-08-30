import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { __closeSharedModelCacheForTests, readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getAgentDir, getModelDbPath, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const TTL_MS = 24 * 60 * 60 * 1000;

function createModel(id: string, name: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name,
		api: "openai-completions",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com/v1",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 4096,
		maxTokens: 1024,
	});
}

describe("model cache migrations", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-model-cache-"));
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
			dbPath = "";
		}
	});

	it("purges a v13 row written after the shared cache handle opened", async () => {
		const originalAgentDir = getAgentDir();
		const sharedAgentDir = path.join(tempDir, "agent");
		await fs.mkdir(sharedAgentDir, { recursive: true });
		setAgentDir(sharedAgentDir);
		try {
			const leakedHeader = "legacy-concurrent-secret";
			const model = createModel("concurrent-v13", "Concurrent v13");
			writeModelCache("concurrent-v13", Date.now(), [model], true, "");
			const dbPath = getModelDbPath();
			const oldProcess = new Database(dbPath);
			try {
				oldProcess.run("UPDATE model_cache SET version = 13, models = ? WHERE provider_id = ?", [
					JSON.stringify([{ headers: { Authorization: leakedHeader } }]),
					"concurrent-v13",
				]);
			} finally {
				oldProcess.close();
			}

			expect(readModelCache("concurrent-v13", TTL_MS, Date.now)).toBeNull();
			const verified = new Database(dbPath, { readonly: true });
			try {
				expect(
					verified.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM model_cache").get()?.count,
				).toBe(0);
			} finally {
				verified.close();
			}
			const persistedBytes = await Promise.all([
				fs.readFile(dbPath),
				fs.readFile(`${dbPath}-wal`).catch(() => new Uint8Array()),
			]);
			expect(persistedBytes.map(bytes => new TextDecoder().decode(bytes)).join()).not.toContain(leakedHeader);
		} finally {
			__closeSharedModelCacheForTests();
			setAgentDir(originalAgentDir);
		}
	});

	it("reads a clean shared cache while another connection holds the writer lock", async () => {
		const originalAgentDir = getAgentDir();
		const sharedAgentDir = path.join(tempDir, "agent");
		await fs.mkdir(sharedAgentDir, { recursive: true });
		setAgentDir(sharedAgentDir);
		try {
			const providerId = "clean-v14";
			writeModelCache(providerId, Date.now(), [createModel(providerId, "Clean v14")], true, "");
			const writer = new Database(getModelDbPath());
			try {
				writer.run("BEGIN IMMEDIATE");
				const cached = readModelCache(providerId, TTL_MS, Date.now);
				expect(cached?.models.map(model => model.id)).toEqual([providerId]);
			} finally {
				writer.run("ROLLBACK");
				writer.close();
			}
		} finally {
			__closeSharedModelCacheForTests();
			setAgentDir(originalAgentDir);
		}
	});

	it("does not checkpoint a v13 row written while the cleanup marker clears", async () => {
		const providerId = "post-cleanup-v13";
		const leakedHeader = "legacy-post-cleanup-secret";
		writeModelCache(providerId, Date.now(), [createModel(providerId, "Post-cleanup v13")], true, "", dbPath);
		const oldProcess = new Database(dbPath);
		try {
			oldProcess.run("UPDATE model_cache SET version = 13 WHERE provider_id = ?", [providerId]);
			oldProcess.run(`
				CREATE TRIGGER reintroduce_v13_when_cleanup_marker_clears
				AFTER DELETE ON model_cache_cleanup
				WHEN OLD.operation = 'truncate-wal'
				BEGIN
					INSERT OR REPLACE INTO model_cache (provider_id, version, updated_at, authoritative, models)
					VALUES ('${providerId}', 13, 0, 1, '[{"headers":{"Authorization":"' || 'legacy-' || 'post-' || 'cleanup-' || 'secret' || '"}}]');
				END
			`);

			expect(readModelCache(providerId, TTL_MS, Date.now, dbPath)).toBeNull();
			expect((await fs.readFile(dbPath)).includes(leakedHeader)).toBe(false);
		} finally {
			oldProcess.close();
		}
	});

	it("defers v13 WAL cleanup while a concurrent reader holds a snapshot", () => {
		const model = createModel("busy-v13", "Busy v13");
		writeModelCache("busy-v13", Date.now(), [model], true, "", dbPath);
		const oldProcess = new Database(dbPath);
		try {
			oldProcess.run("UPDATE model_cache SET version = 13 WHERE provider_id = ?", ["busy-v13"]);
		} finally {
			oldProcess.close();
		}
		const reader = new Database(dbPath, { readonly: true });
		try {
			reader.run("BEGIN");
			reader.query<{ version: number }, []>("SELECT version FROM model_cache WHERE provider_id = 'busy-v13'").get();

			expect(readModelCache("busy-v13", TTL_MS, Date.now, dbPath)).toBeNull();
			const pending = new Database(dbPath, { readonly: true });
			try {
				expect(
					pending
						.query<{ count: number }, []>(
							"SELECT COUNT(*) AS count FROM model_cache_cleanup WHERE operation = 'truncate-wal'",
						)
						.get()?.count,
				).toBe(1);
			} finally {
				pending.close();
			}
		} finally {
			reader.run("ROLLBACK");
			reader.close();
		}

		expect(readModelCache("busy-v13", TTL_MS, Date.now, dbPath)).toBeNull();
		const completed = new Database(dbPath, { readonly: true });
		try {
			expect(
				completed
					.query<{ count: number }, []>(
						"SELECT COUNT(*) AS count FROM model_cache_cleanup WHERE operation = 'truncate-wal'",
					)
					.get()?.count,
			).toBe(0);
		} finally {
			completed.close();
		}
	});

	it("invalidates and scrubs pre-v10 header-bearing cache rows", async () => {
		const legacyModel = {
			...createModel("legacy-cloud-model", "Legacy Cloud Model"),
			headers: { "X-Access-Token": "legacy-cached-secret" },
		};
		const legacyDb = new Database(dbPath, { create: true });
		legacyDb.run(`
			CREATE TABLE model_cache (
				provider_id TEXT PRIMARY KEY,
				version INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				authoritative INTEGER NOT NULL DEFAULT 0,
				models TEXT NOT NULL
			)
		`);
		legacyDb.run(
			"INSERT INTO model_cache (provider_id, version, updated_at, authoritative, models) VALUES (?, ?, ?, ?, ?)",
			["ollama-cloud", 9, Date.now(), 1, JSON.stringify([legacyModel])],
		);
		legacyDb.close();

		const migrated = readModelCache<"openai-completions">("ollama-cloud", TTL_MS, Date.now, dbPath);
		expect(migrated).toBeNull();
		expect((await fs.readFile(dbPath)).includes("legacy-cached-secret")).toBe(false);

		const replacementModel = createModel("fresh-cloud-model", "Fresh Cloud Model");
		writeModelCache("ollama-cloud", Date.now(), [replacementModel], true, "static-v3", dbPath);

		const fresh = readModelCache<"openai-completions">("ollama-cloud", TTL_MS, Date.now, dbPath);
		expect(fresh?.models.map(model => model.id)).toEqual(["fresh-cloud-model"]);
		expect(fresh?.staticFingerprint).toBe("static-v3");
	});

	it("omits every model header before persisting (#5780)", () => {
		const model = buildModel({
			id: "gated-model",
			name: "Gated Model",
			api: "openai-completions",
			provider: "runtime-ext",
			baseUrl: "https://ext.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
			headers: {
				Authorization: "Bearer standard-secret",
				"X-Goog-Api-Key": "google-secret",
				"X-Access-Token": "access-secret",
				"X-Project-Id": "proj-42",
			},
		});
		writeModelCache("runtime-ext", Date.now(), [model], true, "static-v1", dbPath);

		// Header names are provider-defined and any value may be a credential.
		// The plaintext SQLite payload therefore persists no model headers.
		const raw = new Database(dbPath, { readonly: true });
		const row = raw
			.query<{ models: string }, []>("SELECT models FROM model_cache WHERE provider_id = 'runtime-ext'")
			.get();
		raw.close();
		expect(row?.models).not.toContain("standard-secret");
		expect(row?.models).not.toContain("google-secret");
		expect(row?.models).not.toContain("access-secret");
		expect(row?.models).not.toContain("proj-42");

		const cached = readModelCache<"openai-completions">("runtime-ext", TTL_MS, Date.now, dbPath);
		expect(cached?.models[0]?.headers).toBeUndefined();
		expect(cached?.headerOmittedModelIds).toEqual(["gated-model"]);
		expect(cached?.unrestorableHeaderModelIds).toEqual(["gated-model"]);
	});
});
