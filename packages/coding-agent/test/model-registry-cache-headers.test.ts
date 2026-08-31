import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("startup model cache header restoration (#5780)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-cache-headers-"));
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	test("cached standard-provider models regain bundled static headers on registry startup", () => {
		const dbPath = path.join(tempDir, "models.db");
		const bundled = getBundledModels("github-copilot");
		const withHeaders = bundled.filter(model => model.headers && Object.keys(model.headers).length > 0);
		expect(withHeaders.length).toBeGreaterThan(0);

		// Prior process: cache the live copilot catalog. v10 never persists headers.
		const cacheProviderId = resolveModelCacheProviderId("github-copilot");
		writeModelCache(cacheProviderId, Date.now(), bundled, true, "fp-test", dbPath, bundled);
		const raw = fs.readFileSync(dbPath).toString("latin1");
		for (const model of withHeaders) {
			for (const value of Object.values(model.headers ?? {})) {
				expect(raw.includes(value)).toBe(false);
			}
		}

		// Next process start: the registry's startup cache loader must restore the
		// bundled static headers instead of serving header-less cached models.
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"), {
			fetch: () => Promise.reject(new Error("offline")),
		});
		for (const model of withHeaders) {
			const live = registry.find("github-copilot", model.id);
			if (!live) continue;
			expect(live.headers).toEqual(model.headers);
		}
	});

	test("uses an explicit cache path independently of the models config directory", async () => {
		const modelsPath = path.join(tempDir, "config", "models.json");
		const cacheDbPath = path.join(tempDir, "data", "models.db");
		await fs.promises.mkdir(path.dirname(cacheDbPath), { recursive: true });
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					probe: {
						baseUrl: "https://example.invalid/v1/",
						api: "openai-completions",
						authHeader: true,
						apiKey: "test-key",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);

		const primedRegistry = new ModelRegistry(authStorage, modelsPath, {
			cacheDbPath,
			fetch: async () => Response.json({ data: [{ id: "probe-model" }] }),
		});
		await primedRegistry.refreshProvider("probe", "online");

		expect(await Bun.file(cacheDbPath).exists()).toBe(true);
		expect(await Bun.file(path.join(path.dirname(modelsPath), "models.db")).exists()).toBe(false);

		const restartedRegistry = new ModelRegistry(authStorage, modelsPath, {
			cacheDbPath,
			fetch: () => Promise.reject(new Error("offline")),
		});
		expect(restartedRegistry.find("probe", "probe-model")).toBeDefined();
	});

	test("cached configured-discovery models regain derived auth headers on registry startup", async () => {
		const modelsPath = path.join(tempDir, "models.json");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					probe: {
						baseUrl: "https://example.invalid/v1/",
						api: "openai-completions",
						apiKey: "test-key",
						authHeader: true,
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		const primedRegistry = new ModelRegistry(authStorage, modelsPath, {
			fetch: async (input, init) => {
				expect(String(input)).toBe("https://example.invalid/v1/models");
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
				return Response.json({ data: [{ id: "probe-model" }] });
			},
		});
		await primedRegistry.refreshProvider("probe", "online");
		expect(primedRegistry.find("probe", "probe-model")?.headers?.Authorization).toBe("Bearer test-key");
		const cacheDbPath = path.join(tempDir, "models.db");
		const restartedRegistry = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		const cached = restartedRegistry.find("probe", "probe-model");
		expect(cached).toBeDefined();
		expect(cached?.headers?.Authorization).toBe("Bearer test-key");

		const oldCacheDb = new Database(cacheDbPath);
		oldCacheDb.run("UPDATE model_cache SET unrestorable_header_model_ids = ?", [JSON.stringify(["probe-model"])]);
		oldCacheDb.close();
		const upgradedRegistry = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		expect(upgradedRegistry.find("probe", "probe-model")?.headers?.Authorization).toBe("Bearer test-key");
		upgradedRegistry.refreshInBackground();
		await upgradedRegistry.awaitBackgroundRefresh();
		expect(upgradedRegistry.find("probe", "probe-model")?.headers?.Authorization).toBe("Bearer test-key");

		const nextRestartRegistry = new ModelRegistry(authStorage, modelsPath, {
			fetch: () => Promise.reject(new Error("offline")),
		});
		expect(nextRestartRegistry.find("probe", "probe-model")?.headers?.Authorization).toBe("Bearer test-key");
	});
});
