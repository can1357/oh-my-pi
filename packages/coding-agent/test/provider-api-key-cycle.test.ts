import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("ModelRegistry provider API key cycling", () => {
	let tempDir = "";
	let authStorage: AuthStorage;
	let modelsPath = "";

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-provider-api-key-cycle-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		authStorage.close();
		if (!tempDir || !fs.existsSync(tempDir)) return;
		try {
			removeSyncWithRetries(tempDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
		}
	});

	test("user can configure two keys for one provider, cycle once, and the next resolved key is the second key", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: ["key-one", "key-two"],
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(await registry.getApiKeyForProvider("custom-proxy", "sess-1")).toBe("key-one");
		expect(registry.cycleProviderApiKey("custom-proxy")).toBe(true);
		expect(await registry.getApiKeyForProvider("custom-proxy", "sess-1")).toBe("key-two");
	});

	test("cycle reports failure when no configured key is usable: with keys [bad-cmd, missing-env] (both unresolvable), cycle returns false and the resolved key stays undefined", async () => {
		const missingEnv = "OMP_KEY_CYCLE_TEST_MISSING_9Z7Q";
		const savedEnv = process.env[missingEnv];
		delete process.env[missingEnv];
		try {
			const failCmd = `!${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(1)")}`;
			const envCmd = `!${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.exit(process.env.${missingEnv} ? 0 : 1)`)}`;
			fs.writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						"custom-proxy": {
							baseUrl: "https://custom-proxy.example.com/v1",
							api: "openai-completions",
							apiKey: [failCmd, envCmd],
							models: [{ id: "custom-model", name: "Custom Model" }],
						},
					},
				}),
			);

			const registry = new ModelRegistry(authStorage, modelsPath);
			expect(await registry.getApiKeyForProvider("custom-proxy", "sess-1")).toBeUndefined();
			expect(registry.cycleProviderApiKey("custom-proxy")).toBe(false);
			expect(await registry.getApiKeyForProvider("custom-proxy", "sess-1")).toBeUndefined();
			expect(registry.getProviderApiKeyPosition("custom-proxy")).toEqual({ index: 0, total: 2 });
		} finally {
			if (savedEnv === undefined) delete process.env[missingEnv];
			else process.env[missingEnv] = savedEnv;
		}
	});

	test("cycle skips a poisoned middle element and reports the actual resolved index (key 3/3), with the next advance continuing from it", async () => {
		const failCmd = `!${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(1)")}`;
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: ["key-one", failCmd, "key-three"],
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(await registry.getApiKeyForProvider("custom-proxy", "sess-1")).toBe("key-one");
		expect(registry.cycleProviderApiKey("custom-proxy")).toBe(true);
		// The resolver skips the failing middle element, so the live key is key-three…
		expect(await registry.getApiKeyForProvider("custom-proxy", "sess-1")).toBe("key-three");
		// …and the reported position/override must agree with the actual slot, not the poisoned one.
		expect(registry.getProviderApiKeyPosition("custom-proxy")).toEqual({ index: 2, total: 3 });
		expect(authStorage.describeCredentialSource("custom-proxy")).toContain("key 3/3");
		// The next advance continues from the actual slot (wraps to key-one), not from the poisoned slot.
		expect(registry.cycleProviderApiKey("custom-proxy")).toBe(true);
		expect(await registry.getApiKeyForProvider("custom-proxy", "sess-1")).toBe("key-one");
		expect(registry.getProviderApiKeyPosition("custom-proxy")).toEqual({ index: 0, total: 3 });
	});

	test("cycle cursor survives a fresh ModelRegistry on the same storage: two sequential registries continue the rotation", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: ["key-one", "key-two", "key-three"],
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const first = new ModelRegistry(authStorage, modelsPath);
		expect(await first.getApiKeyForProvider("custom-proxy", "sess-1")).toBe("key-one");
		expect(first.cycleProviderApiKey("custom-proxy")).toBe(true);
		expect(await first.getApiKeyForProvider("custom-proxy", "sess-1")).toBe("key-two");

		const second = new ModelRegistry(authStorage, modelsPath);
		expect(await second.getApiKeyForProvider("custom-proxy", "sess-1")).toBe("key-two");
		expect(second.cycleProviderApiKey("custom-proxy")).toBe(true);
		expect(await second.getApiKeyForProvider("custom-proxy", "sess-1")).toBe("key-three");
	});

	test("cycle cursor persists across processes: a new AuthStorage on the same database continues the rotation (omp key-cycle)", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: ["key-one", "key-two", "key-three"],
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const dbPath = path.join(tempDir, "auth-cycle.db");
		const firstStorage = await AuthStorage.create(dbPath);
		try {
			const first = new ModelRegistry(firstStorage, modelsPath);
			expect(first.cycleProviderApiKey("custom-proxy")).toBe(true);
			expect(await first.getApiKeyForProvider("custom-proxy", "sess-1")).toBe("key-two");
		} finally {
			firstStorage.close();
		}

		const secondStorage = await AuthStorage.create(dbPath);
		try {
			const second = new ModelRegistry(secondStorage, modelsPath);
			expect(await second.getApiKeyForProvider("custom-proxy", "sess-1")).toBe("key-two");
			expect(second.cycleProviderApiKey("custom-proxy")).toBe(true);
			expect(await second.getApiKeyForProvider("custom-proxy", "sess-1")).toBe("key-three");
		} finally {
			secondStorage.close();
		}
	});

	test("cycling refreshes live model headers: an authHeader:true model's Authorization follows the new key", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: ["key-one", "key-two"],
						authHeader: true,
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(registry.find("custom-proxy", "custom-model")?.headers?.Authorization).toBe("Bearer key-one");
		expect(registry.cycleProviderApiKey("custom-proxy")).toBe(true);
		expect(registry.find("custom-proxy", "custom-model")?.headers?.Authorization).toBe("Bearer key-two");
		// The full-snapshot path serves the same refreshed headers.
		expect(registry.getAll().find(model => model.provider === "custom-proxy")?.headers?.Authorization).toBe(
			"Bearer key-two",
		);
	});

	test("cycleProviderKeys prefers the models.yml list and reports its position", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: ["key-one", "key-two"],
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(await registry.cycleProviderKeys("custom-proxy")).toEqual({ source: "config", index: 1, total: 2 });
		expect(await registry.getApiKeyForProvider("custom-proxy", "sess-1")).toBe("key-two");
	});

	test("cycleProviderKeys returns undefined with a single key and no stored rows", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: "only-key",
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(await registry.cycleProviderKeys("custom-proxy")).toBeUndefined();
		expect(await registry.getApiKeyForProvider("custom-proxy", "sess-1")).toBe("only-key");
	});
});
