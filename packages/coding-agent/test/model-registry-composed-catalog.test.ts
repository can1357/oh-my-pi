import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgExtendedContext } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("composed startup catalog", () => {
	let dir: TempDir;
	let config: string;
	let dbPath: string;
	let auth: AuthStorage;
	let settings: Settings;
	const open = () => new ModelRegistry(auth, config, { settings });
	const stamp = () => {
		using db = new Database(dbPath);
		return db
			.query<{ inputs: string; created_at: number }, []>("SELECT inputs, created_at FROM composed_catalog")
			.get()!;
	};
	const cacheRow = (name: string, at: number) => {
		const model = buildModel({
			id: "snapshot-probe",
			name,
			api: "openai-completions",
			provider: "zai",
			baseUrl: "https://example.invalid/v1",
			input: ["text"],
			reasoning: false,
			contextWindow: 32000,
			maxTokens: 2048,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		});
		writeModelCache(resolveModelCacheProviderId("zai"), at, [model], true, "unrelated-bundle", dbPath);
	};
	beforeEach(async () => {
		dir = TempDir.createSync("@composed-catalog-");
		config = path.join(dir.path(), "models.yml");
		dbPath = path.join(dir.path(), "models.db");
		auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		settings = Settings.isolated();
	});
	afterEach(async () => {
		auth.close();
		await dir.remove();
	});

	test("a cache hit preserves order, tiers and current headers without persisting credentials", async () => {
		const secret = "snapshot-test-header-never-store-1734";
		await Bun.write(config, `providers:\n  anthropic:\n    headers:\n      X-Gateway-Token: ${secret}\n`);
		const then = Date.now() - 1000;
		cacheRow("first", then);
		const cold = open();
		const expected = cold.getAll("all");
		const tiers = expected.map(m => cold.contextWindowTiers(m));
		{
			using db = new Database(dbPath);
			const payload = db.query<{ payload: Uint8Array }, []>("SELECT payload FROM composed_catalog").get()!.payload;
			expect(Buffer.from(payload).includes(Buffer.from(secret))).toBe(false);
			expect(Buffer.from(payload).includes(Buffer.from(secret, "utf16le"))).toBe(false);
			db.run("UPDATE composed_catalog SET created_at=1");
		}
		// An unchanged payload can be refreshed between launches. The catalog
		// stays reusable but reports the new discovery time.
		const refreshed = Date.now();
		cacheRow("first", refreshed);
		const warm = open();
		const actual = warm.getAll("all");
		expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
		expect(actual.map(m => warm.contextWindowTiers(m))).toEqual(tiers);
		expect(stamp().created_at).toBe(1);
		expect(warm.getProviderDiscoveryState("zai")?.fetchedAt).toBe(refreshed);
		const protectedRow = actual.find(m => m.provider === "anthropic")!;
		expect((await warm.resolveModelHeaders(protectedRow))?.["X-Gateway-Token"]).toBe(secret);
	});

	test("provider payloads, effective window settings and models.yml content invalidate the old composition", async () => {
		cacheRow("first", Date.now() - 1000);
		cfgExtendedContext.set(settings, false);
		const windows = open().getAll("all");
		const key = stamp().inputs;
		cfgExtendedContext.set(settings, true);
		const extended = open().getAll("all");
		expect(extended.some((model, i) => model.contextWindow !== windows[i].contextWindow)).toBe(true);
		const settingsKey = stamp().inputs;
		expect(settingsKey).not.toBe(key);
		cacheRow("second", Date.now());
		expect(
			open()
				.getAll("all")
				.find(m => m.id === "snapshot-probe")?.name,
		).toBe("second");
		const payloadKey = stamp().inputs;
		expect(payloadKey).not.toBe(settingsKey);
		await Bun.write(config, "providers:\n  anthropic:\n    baseUrl: https://configured.invalid/v1\n");
		expect(
			open()
				.getAll("all")
				.find(m => m.provider === "anthropic")?.baseUrl,
		).toBe("https://configured.invalid/v1");
		expect(stamp().inputs).not.toBe(payloadKey);
	});

	test("snapshots produced by a foreign app, compiled rule set or bundled catalog are not loaded", () => {
		open().getAll();
		const { inputs } = stamp();
		for (const old of [
			inputs.replace(/app-[^:]+/, "app-other"),
			inputs.replace(/rules-[^:]+/, "rules-other"),
			inputs.replace(/bundle-[^/]+/, "bundle-other"),
		]) {
			expect(old).not.toBe(inputs);
			{
				using db = new Database(dbPath);
				db.run("UPDATE composed_catalog SET inputs=?,created_at=1", [old]);
			}
			open().getAll();
			expect(stamp().inputs).toBe(inputs);
			expect(stamp().created_at).not.toBe(1);
		}
	});
});
