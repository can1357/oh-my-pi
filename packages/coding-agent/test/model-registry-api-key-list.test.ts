import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { clearConfigValueCache } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";

describe("models.yml ordered apiKey list", () => {
	let tmpDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-api-key-list-"));
		modelsPath = path.join(tmpDir, "models.yml");
		authStorage = await AuthStorage.create(":memory:");
		clearConfigValueCache();
	});

	afterEach(() => {
		authStorage.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
		clearConfigValueCache();
	});

	function loadRegistry(providerYaml: string): ModelRegistry {
		fs.writeFileSync(modelsPath, `providers:\n  mistral:\n${providerYaml}`);
		return new ModelRegistry(authStorage, modelsPath);
	}

	test("requests use the first entry and fall over to the next after a 401", async () => {
		const registry = loadRegistry("    apiKey:\n      - first-key\n      - second-key\n");
		expect(registry.getError()).toBeUndefined();
		expect(await registry.getApiKeyForProvider("mistral")).toBe("first-key");

		const resolver = registry.resolver("mistral");
		const rejected = Object.assign(new Error("401 Unauthorized"), { status: 401 });
		// Step (b) re-resolves the same entry; step (c) rotates to the next one.
		expect(await resolver({ lastChance: false, error: rejected, previousKey: "first-key" })).toMatchObject({
			apiKey: "first-key",
		});
		expect(await resolver({ lastChance: true, error: rejected, previousKey: "first-key" })).toMatchObject({
			apiKey: "second-key",
		});
		expect(await registry.getApiKeyForProvider("mistral")).toBe("second-key");
	});

	test("skips an entry whose command fails", async () => {
		const registry = loadRegistry("    apiKey:\n      - '!exit 1'\n      - '!printf second-key'\n");
		expect(registry.getError()).toBeUndefined();
		expect(registry.hasCommandBackedApiKey("mistral")).toBe(true);
		expect(await registry.getApiKeyForProvider("mistral")).toBe("second-key");
	});

	test("keeps the single string form", async () => {
		const registry = loadRegistry("    apiKey: only-key\n");
		expect(registry.getError()).toBeUndefined();
		expect(await registry.getApiKeyForProvider("mistral")).toBe("only-key");
	});

	test.each([
		["an empty list", "    apiKey: []\n", "must be apiKey a non-empty list of non-empty strings"],
		["a non-string entry", "    apiKey:\n      - 42\n", "apiKey.0: must be a string"],
		["an empty entry", "    apiKey:\n      - ''\n", "must be apiKey a non-empty list of non-empty strings"],
		[
			"a list with authHeader",
			"    authHeader: true\n    apiKey:\n      - first-key\n      - second-key\n",
			"must be apiKey a single string when authHeader is true",
		],
	])("rejects %s", (_label, providerYaml, message) => {
		const registry = loadRegistry(providerYaml);
		expect(registry.getError()?.message).toContain(message);
	});
});
