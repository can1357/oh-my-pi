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
});
