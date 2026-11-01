import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { TempDir } from "@oh-my-pi/pi-utils";

function providerConfig(name: string, extra: string): string {
	return `providers:
  ${name}:
    baseUrl: http://localhost:8000/v1
    api: openai-completions
${extra}
    models:
      - id: ${name}-model
        name: ${name} model
        input: [text]
        contextWindow: 8192
        maxTokens: 4096
`;
}

test("an in-process reload retains keyless and override state from the last-good snapshot", async () => {
	const tmp = TempDir.createSync("@last-good-snapshot-");
	const auth = await AuthStorage.create(":memory:");
	const modelsPath = tmp.join("models.yml");
	try {
		fs.writeFileSync(modelsPath, providerConfig("keyless", "    auth: none"));
		const registry = new ModelRegistry(auth, modelsPath);
		expect(registry.getAvailable().some(model => model.provider === "keyless")).toBe(true);

		fs.writeFileSync(modelsPath, "providers: [invalid");
		await registry.refresh("offline");
		expect(registry.isUsingLastGoodConfig()).toBe(true);
		expect(registry.getAvailable().some(model => model.provider === "keyless")).toBe(true);

		// A second failed reload must still see the intact snapshot.
		await registry.refresh("offline");
		expect(registry.getAvailable().some(model => model.provider === "keyless")).toBe(true);
	} finally {
		auth.close();
		await tmp.remove();
	}
});

test("an in-process reload re-installs config credentials from the last-good snapshot", async () => {
	const tmp = TempDir.createSync("@last-good-credentials-");
	const auth = await AuthStorage.create(":memory:");
	const modelsPath = tmp.join("models.yml");
	try {
		fs.writeFileSync(modelsPath, providerConfig("keyed", "    apiKey: literal-test-key"));
		const registry = new ModelRegistry(auth, modelsPath);
		const [model] = registry.getAvailable().filter(candidate => candidate.provider === "keyed");
		expect(model).toBeDefined();

		fs.writeFileSync(modelsPath, "providers: [invalid");
		await registry.refresh("offline");
		expect(registry.isUsingLastGoodConfig()).toBe(true);
		expect(registry.hasConfiguredAuth(model!)).toBe(true);
		expect(registry.getAvailable().some(candidate => candidate.provider === "keyed")).toBe(true);
		expect(await registry.getApiKeyForProvider("keyed")).toBe("literal-test-key");
	} finally {
		auth.close();
		await tmp.remove();
	}
});

test("last-good sidecars are namespaced by the configured file", async () => {
	const tmp = TempDir.createSync("@last-good-namespace-");
	const auth = await AuthStorage.create(":memory:");
	const pathA = tmp.join("a.yml");
	const pathB = tmp.join("b.yml");
	try {
		fs.writeFileSync(pathA, providerConfig("alpha", "    auth: none"));
		fs.writeFileSync(pathB, providerConfig("beta", "    auth: none"));
		new ModelRegistry(auth, pathA);
		new ModelRegistry(auth, pathB);
		expect(fs.existsSync(tmp.join("a.last-good.yml"))).toBe(true);
		expect(fs.existsSync(tmp.join("b.last-good.yml"))).toBe(true);

		fs.writeFileSync(pathA, "providers: [invalid");
		const fresh = new ModelRegistry(auth, pathA);
		expect(fresh.isUsingLastGoodConfig()).toBe(true);
		expect(fresh.getAvailable().some(model => model.provider === "alpha")).toBe(true);
		expect(fresh.getAvailable().some(model => model.provider === "beta")).toBe(false);
	} finally {
		auth.close();
		await tmp.remove();
	}
});

test("a schema failure on a sequence element reports that element's line", async () => {
	const tmp = TempDir.createSync("@last-good-seq-line-");
	const auth = await AuthStorage.create(":memory:");
	const modelsPath = tmp.join("models.yml");
	try {
		fs.writeFileSync(
			modelsPath,
			`providers:
  broken:
    baseUrl: http://localhost:8000/v1
    api: openai-completions
    auth: none
    models:
      - id: ok-model
        name: OK
        input: [text]
        contextWindow: 8192
        maxTokens: 4096
      - null
`,
		);
		const registry = new ModelRegistry(auth, modelsPath);
		expect(registry.getError()).toBeDefined();
		expect(registry.getError()?.line).toBe(12);
	} finally {
		auth.close();
		await tmp.remove();
	}
});
