import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("provider API key visibility", () => {
	let tempDir = "";
	let authStorage: AuthStorage;
	let modelsPath = "";

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-provider-api-key-visibility-${Snowflake.next()}`);
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

	test("operator can tell which key is active: after a cycle, the credential source description names a different key index than before", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: ["sk-live-AAA111", "sk-live-BBB222"],
						models: [{ id: "custom-model", name: "Custom Model" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const before = authStorage.describeCredentialSource("custom-proxy");
		expect(before).toContain("key 1/2");
		expect(registry.cycleProviderApiKey("custom-proxy")).toBe(true);
		const after = authStorage.describeCredentialSource("custom-proxy");
		expect(after).toContain("key 2/2");
		expect(after).not.toBe(before);
		for (const secret of ["sk-live-AAA111", "sk-live-BBB222"]) {
			expect(before).not.toContain(secret);
			expect(after ?? "").not.toContain(secret);
		}
	});
});
