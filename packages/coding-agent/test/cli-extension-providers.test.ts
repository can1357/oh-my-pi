/**
 * Regression test for `loadCliExtensionProviders`.
 *
 * One-shot CLIs (`omp bench`, dry-balance) build a bare `ModelRegistry` that
 * only knows built-in catalog providers. Before the helper existed they never
 * loaded extensions, so a provider contributed by an extension
 * (`pi.registerProvider(...)`, e.g. a custom OpenAI-compatible gateway under
 * `~/.omp/agent/extensions/`) was invisible to model resolution and
 * `omp bench <provider>/<model>` failed with "Model not found".
 *
 * Contract under test: after `loadCliExtensionProviders` drains the extension's
 * provider registrations into the registry, a `provider/id` selector for that
 * extension provider resolves. Discovery is disabled and the extension path is
 * passed explicitly so the test never touches the developer's real `~/.omp`.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getModelMatchPreferences, resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadCliExtensionProviders } from "@oh-my-pi/pi-coding-agent/sdk";
import { TempDir } from "@oh-my-pi/pi-utils";

let tmp: TempDir;
let extPath: string;
let dbPath: string;

beforeAll(async () => {
	tmp = await TempDir.create("@cli-ext-providers-");
	extPath = tmp.join("ext.ts");
	dbPath = tmp.join("auth.db");
	await fs.writeFile(
		extPath,
		`export default function (pi) {
	pi.registerProvider("bench-gw", {
		baseUrl: "https://example.com/v1",
		apiKey: "literal-test-key",
		api: "openai-completions",
		models: [{
			id: "bench-model",
			name: "Bench Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
	});
}
`,
	);
});

afterAll(async () => {
	resetSettingsForTest();
	await tmp.remove();
});

test("loadCliExtensionProviders makes extension providers resolvable by selector", async () => {
	const authStorage = await AuthStorage.create(dbPath);
	try {
		const settings = await Settings.init({
			inMemory: true,
			cwd: tmp.path(),
			overrides: { extensions: [extPath], disabledExtensions: [] },
		});
		const modelRegistry = new ModelRegistry(authStorage);
		const preferences = getModelMatchPreferences(settings);

		// Before the drain the extension provider is unknown: resolution fails.
		const before = resolveCliModel({ cliModel: "bench-gw/bench-model", modelRegistry, preferences });
		expect(before.model).toBeUndefined();

		await loadCliExtensionProviders(modelRegistry, settings, tmp.path(), {
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [extPath],
		});

		// After the drain the same selector resolves to the extension provider.
		const after = resolveCliModel({ cliModel: "bench-gw/bench-model", modelRegistry, preferences });
		expect(after.error).toBeUndefined();
		expect(after.model?.provider).toBe("bench-gw");
		expect(after.model?.id).toBe("bench-model");
	} finally {
		authStorage.close();
	}
});
