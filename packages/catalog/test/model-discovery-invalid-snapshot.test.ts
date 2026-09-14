import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProviderModels } from "../src/model-manager";
import type { ModelSpec } from "../src/types";

test("invalid discovery preserves complete membership but a valid empty response clears it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "omp-invalid-discovery-"));
	const live: ModelSpec<"openai-completions"> = {
		id: "live",
		name: "Live",
		provider: "snapshot-test",
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
	let response: unknown = [live];
	let clock = 1000;
	const options = {
		providerId: live.provider,
		staticModels: [live],
		dynamicModelsAuthoritative: true,
		emptyDynamicModelsAuthoritative: true,
		cacheDbPath: join(directory, "models.db"),
		now: () => clock,
		fetchDynamicModels: async () => response as readonly ModelSpec<"openai-completions">[],
	};
	try {
		const first = await resolveProviderModels(options, "online");
		// Neither an invalid envelope nor a partially valid list is evidence of removal.
		for (const malformed of [{}, [{ ...live, id: "new" }, { id: "broken" }]]) {
			clock += 1000;
			response = malformed;
			const invalid = await resolveProviderModels(options, "online");
			expect(invalid.models.map(model => model.id)).toEqual(["live"]);
			expect(invalid.stale).toBe(true);
			expect(invalid.updatedAt).toBe(first.updatedAt);
			const offline = await resolveProviderModels(options, "offline");
			expect(offline.models.map(model => model.id)).toEqual(["live"]);
		}
		response = [];
		clock += 1000;
		const empty = await resolveProviderModels(options, "online");
		expect(empty.models).toEqual([]);
		expect(empty.stale).toBe(false);
		expect((await resolveProviderModels(options, "offline")).models).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
