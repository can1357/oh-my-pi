/**
 * Test suite for models.yml last-good provider retention on validation failures.
 *
 * When models.yml fails to validate:
 * - Custom providers from the last successful load should remain available
 * - A warning should be shown with file:line attribution
 * - Next valid change should restore normal operation
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { runModelsListing } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { TempDir } from "@oh-my-pi/pi-utils";

let tmp: TempDir;

beforeAll(() => {
	tmp = TempDir.createSync("@models-last-good-");
});

afterAll(async () => {
	await tmp.remove();
});

test("1a: Invalid YAML keeps last-good providers in getAvailable() and error in getError() with file:line", async () => {
	const modelsPath = tmp.join("models.yml");
	const authStorage = await AuthStorage.create(":memory:");

	try {
		// Write a valid config with a custom provider
		await fs.writeFile(
			modelsPath,
			`providers:
  myprovider:
    baseUrl: http://localhost:8000/v1
    api: openai-completions
    auth: none
    models:
      - id: my-model
        name: My Model
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 8192
        maxTokens: 4096
`,
		);

		// Load the valid config
		const registry1 = new ModelRegistry(authStorage, modelsPath);
		const available1 = registry1.getAvailable();
		expect(available1.some(m => m.provider === "myprovider")).toBe(true);
		expect(registry1.getError()).toBeUndefined();

		// Now corrupt the YAML (invalid syntax)
		await fs.writeFile(
			modelsPath,
			`providers:
  myprovider:
    baseUrl: http://localhost:8000/v1
    api: openai-completions
    invalid: [unclosed
    models:
      - id: my-model
`,
		);

		// Force reload with a new registry instance
		const registry2 = new ModelRegistry(authStorage, modelsPath);
		const available2 = registry2.getAvailable();

		// Last-good providers should still be available
		expect(available2.some(m => m.provider === "myprovider")).toBe(true);

		// Error should be set with file:line info
		const error = registry2.getError();
		expect(error).toBeDefined();
		expect(error?.filePath || "").toContain("models.yml");
		expect(error?.line || 0).toBeGreaterThan(0);
	} finally {
		authStorage.close();
	}
});

test("1b: Invalid schema after good load keeps last-good providers with file:line error", async () => {
	const modelsPath = tmp.join("models-schema.yml");
	const authStorage = await AuthStorage.create(":memory:");

	try {
		// Write a valid config first
		await fs.writeFile(
			modelsPath,
			`providers:
  testprovider:
    baseUrl: http://localhost:8000/v1
    api: openai-completions
    auth: none
    models:
      - id: test-model
        name: Test Model
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 4096
`,
		);

		const registry1 = new ModelRegistry(authStorage, modelsPath);
		expect(registry1.getAvailable().some(m => m.provider === "testprovider")).toBe(true);
		expect(registry1.getError()).toBeUndefined();

		// Now make the models field invalid (null instead of array)
		await fs.writeFile(
			modelsPath,
			`providers:
  testprovider:
    baseUrl: http://localhost:8000/v1
    api: openai-completions
    auth: none
    models: null
`,
		);

		// Create new registry - should keep last-good
		const registry2 = new ModelRegistry(authStorage, modelsPath);
		const available2 = registry2.getAvailable();

		// Last-good should still be available
		expect(available2.some(m => m.provider === "testprovider")).toBe(true);

		// Error should show file:line
		const error = registry2.getError();
		expect(error).toBeDefined();
		expect(error?.message || "").toContain("models");
	} finally {
		authStorage.close();
	}
});

test("1c: Fresh registry restores providers from the sidecar only", async () => {
	const modelsPath = tmp.join("models-fresh.yml");
	const authStorage = await AuthStorage.create(":memory:");

	try {
		// First registry loads valid config
		await fs.writeFile(
			modelsPath,
			`providers:
  firstprovider:
    baseUrl: http://localhost:8000/v1
    api: openai-completions
    auth: none
    models:
      - id: model1
        name: Model 1
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 2048
`,
		);

		const registry1 = new ModelRegistry(authStorage, modelsPath);
		expect(registry1.getAvailable().some(m => m.provider === "firstprovider")).toBe(true);

		// Corrupt the file after the good load has persisted its validated snapshot.
		await fs.writeFile(
			modelsPath,
			`providers:
  firstprovider:
    baseUrl: http://localhost:8000/v1
    api: openai-completions
    invalid syntax here {{{
`,
		);

		const sidecarPath = path.join(path.dirname(modelsPath), "models-fresh.last-good.yml");
		expect(await fs.readFile(sidecarPath, "utf8")).toContain("firstprovider:");
		// A new registry has no in-memory snapshot; restoration must come from disk.
		const registry2 = new ModelRegistry(authStorage, modelsPath);
		expect(registry2.getAvailable().some(m => m.provider === "firstprovider")).toBe(true);
		const error2 = registry2.getError();
		expect(error2?.filePath).toContain("models-fresh.yml");
	} finally {
		authStorage.close();
	}
});

test("2: Valid edit takes effect on next load and error clears", async () => {
	const modelsPath = tmp.join("models-reload.yml");
	const authStorage = await AuthStorage.create(":memory:");

	try {
		// Start with valid config
		await fs.writeFile(
			modelsPath,
			`providers:
  reloadprov:
    baseUrl: http://localhost:8000/v1
    api: openai-completions
    auth: none
    models:
      - id: reload-model
        name: Reload Model
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 1024
`,
		);

		const registry1 = new ModelRegistry(authStorage, modelsPath);
		expect(registry1.getAvailable().some(m => m.provider === "reloadprov")).toBe(true);
		expect(registry1.getError()).toBeUndefined();

		// Corrupt it
		await fs.writeFile(
			modelsPath,
			`providers:
  reloadprov:
    invalid: [
`,
		);

		const registry2 = new ModelRegistry(authStorage, modelsPath);
		expect(registry2.getError()).toBeDefined();

		// Fix it with a different provider
		await fs.writeFile(
			modelsPath,
			`providers:
  newprovider:
    baseUrl: http://localhost:9000/v1
    api: openai-completions
    auth: none
    models:
      - id: new-model
        name: New Model
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 512
`,
		);

		const registry3 = new ModelRegistry(authStorage, modelsPath);
		expect(registry3.getAvailable().some(m => m.provider === "newprovider")).toBe(true);
		expect(registry3.getError()).toBeUndefined(); // Error should clear on valid load
		const sidecar = await fs.readFile(path.join(path.dirname(modelsPath), "models-reload.last-good.yml"), "utf8");
		expect(sidecar).toContain("newprovider:");
		expect(sidecar).not.toContain("reloadprov:");
	} finally {
		authStorage.close();
	}
});

test("3: models.yml with no custom providers loads with no error warning", async () => {
	const modelsPath = tmp.join("models-empty.yml");
	const authStorage = await AuthStorage.create(":memory:");

	try {
		// Write an empty models.yml (no custom providers)
		await fs.writeFile(
			modelsPath,
			`{}
			`,
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(registry.getError()).toBeUndefined();
	} finally {
		authStorage.close();
	}
});

test("4: Deleted models.yml retains the existing not-found behavior", async () => {
	const modelsPath = tmp.join("models-deleted.yml");
	const authStorage = await AuthStorage.create(":memory:");
	try {
		await fs.writeFile(
			modelsPath,
			`providers:\n  deletedprov:\n    baseUrl: http://localhost:8000/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: deleted-model\n        name: Deleted Model\n        input: [text]\n        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n        contextWindow: 1024\n`,
		);
		const loaded = new ModelRegistry(authStorage, modelsPath);
		expect(loaded.getAvailable().some(model => model.provider === "deletedprov")).toBe(true);
		await fs.rm(modelsPath);
		const deleted = new ModelRegistry(authStorage, modelsPath);
		expect(deleted.getError()).toBeUndefined();
		expect(deleted.getAvailable().some(model => model.provider === "deletedprov")).toBe(false);
	} finally {
		authStorage.close();
	}
});

const lineFixtures = [
	{
		name: "b-broken",
		line: 18,
		content: `providers:
  qa-dummy:
    baseUrl: http://127.0.0.1:18765
    api: typesafe
    auth: apiKey
    apiKey: qa-dummy
    models:
      - id: qa-model-alpha
        name: QA Model Alpha (qa-model-alpha)
        api: typesafe
        kind: judge
        reasoning: false
        input: [text]
        contextWindow: 65536
        maxTokens: 1
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}
  qa-broken:
    baseUrl: [this is not valid yaml
`,
	},
	{
		name: "c-null-models",
		line: 22,
		content: `providers:
  qa-dummy:
    baseUrl: http://127.0.0.1:18765
    api: typesafe
    auth: apiKey
    apiKey: qa-dummy
    models:
      - id: qa-model-alpha
        name: QA Model Alpha (qa-model-alpha)
        api: typesafe
        kind: judge
        reasoning: false
        input: [text]
        contextWindow: 65536
        maxTokens: 1
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}
  qa-null:
    baseUrl: http://127.0.0.1:18765
    api: typesafe
    auth: apiKey
    apiKey: qa-null
    models: null
`,
	},
	{
		name: "nested-model-id",
		line: 8,
		content: `providers:
  qa-nested:
    baseUrl: http://127.0.0.1:18765
    api: openai-completions
    auth: none
    models:
      - id: good-model
      - id: null
`,
	},
	{
		name: "missing-model-id",
		line: 7,
		content: `providers:
  qa-missing:
    baseUrl: http://127.0.0.1:18765
    api: openai-completions
    auth: none
    models:
      - name: Missing ID
`,
	},
];

for (const fixture of lineFixtures) {
	test(`exact warning line: ${fixture.name}`, async () => {
		const fixtureDir = tmp.join(fixture.name);
		await fs.mkdir(fixtureDir);
		const modelsPath = path.join(fixtureDir, "models.yml");
		await fs.writeFile(modelsPath, fixture.content);
		const authStorage = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(authStorage, modelsPath);
			expect(registry.getError()?.line).toBe(fixture.line);
			const captured: string[] = [];
			const originalWrite = process.stdout.write;
			Reflect.set(process.stdout, "write", (chunk: string | Uint8Array) => {
				captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
				return true;
			});
			try {
				await runModelsListing({
					modelRegistry: registry,
					cwd: fixtureDir,
					action: "ls",
					pattern: "qa-*",
					disableExtensionDiscovery: true,
				});
			} finally {
				process.stdout.write = originalWrite;
			}
			expect(captured.join("")).toContain(
				`Warning: models.yml validation failed at ${modelsPath}:${fixture.line} —`,
			);
		} finally {
			authStorage.close();
		}
	});
}
