import { Database } from "bun:sqlite";
import { afterEach, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => vi.restoreAllMocks());

test("new registries reuse cached catalog preparation while preserving private overrides and external replacement", async () => {
	await using dir = TempDir.createSync("model-registry-cache-reuse-");
	const dbPath = path.join(dir.path(), "models.db");
	const modelsPath = path.join(dir.path(), "models.yml");
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	try {
		const cached = buildModel({
			id: "cache-reuse-fixture",
			name: "Cached fixture",
			provider: "azure",
			api: "openai-completions",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		});
		writeModelCache("azure", Date.now(), [cached], true, "fixture", dbPath);
		const registry = () =>
			new ModelRegistry(auth, modelsPath, { settings: Settings.isolated(), cacheDbPath: dbPath });
		expect(registry().find("azure", cached.id)?.maxTokens).toBe(1024);
		const stringify = vi.spyOn(JSON, "stringify");
		for (let launch = 0; launch < 6; launch++) {
			expect(registry().find("azure", cached.id)?.name).toBe("Cached fixture");
		}
		// The hot path must not serialize the cached catalog again to fingerprint it.
		const serializedCachedCatalog = stringify.mock.calls.some(
			([value]) => Array.isArray(value) && value.some(model => model?.id === cached.id),
		);
		expect(serializedCachedCatalog).toBe(false);
		stringify.mockRestore();
		await Bun.write(
			modelsPath,
			"providers:\n  azure:\n    modelOverrides:\n      cache-reuse-fixture:\n        maxTokens: 512\n",
		);
		expect(registry().find("azure", cached.id)?.maxTokens).toBe(512);
		const external = new Database(dbPath);
		try {
			external.run("DELETE FROM model_cache WHERE provider_id = 'azure'");
		} finally {
			external.close();
		}
		expect(registry().find("azure", cached.id)).toBeUndefined();
	} finally {
		auth.close();
	}
});
