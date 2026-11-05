import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

test("authoritative reasoning keeps a live false over the bundled dial through a failed-refresh cache merge", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "reasoning-authority-"));
	const bundled: ModelSpec<"openai-completions"> = {
		id: "future-model",
		name: "Future model",
		provider: "custom",
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 8192,
		thinking: { mode: "effort", efforts: [Effort.High] },
	};
	let fail = false;
	const fetchDynamicModels = async () => (fail ? null : [{ ...bundled, reasoning: false, thinking: undefined }]);
	const base = { providerId: "custom", staticModels: [bundled], fetchDynamicModels };
	try {
		// Default merge behavior stays additive for discovery that omits capabilities.
		const additive = await resolveProviderModels(
			{ ...base, cacheDbPath: path.join(tempDir, "additive.db") },
			"online",
		);
		expect(additive.models[0]?.reasoning).toBe(true);

		// The failing pass merges the cached live row back over the bundled one.
		const options = {
			...base,
			cacheDbPath: path.join(tempDir, "authoritative.db"),
			dynamicReasoningAuthoritative: true,
		};
		for (const failing of [false, true]) {
			fail = failing;
			const { models, stale } = await resolveProviderModels(options, "online");
			expect(stale).toBe(failing);
			expect(models[0]?.reasoning).toBe(false);
			expect(models[0]?.thinking).toBeUndefined();
		}
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
