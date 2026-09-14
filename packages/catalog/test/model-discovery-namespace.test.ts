import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProviderModels } from "../src/model-manager";
import type { ModelSpec } from "../src/types";

test("late discovery cannot replace a newer snapshot in its newly resolved account namespace", async () => {
	const directory = await mkdtemp(join(tmpdir(), "omp-account-ordering-"));
	const pending = Promise.withResolvers<void>();
	const oldModel: ModelSpec<"openai-completions"> = {
		id: "old",
		name: "Old",
		provider: "account-test",
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
	const options = {
		providerId: "account-test",
		cacheProviderId: "initial",
		cacheDbPath: join(directory, "models.db"),
		staticModels: [oldModel],
		dynamicModelsAuthoritative: true,
		fetchDynamicModels: async () => {
			await pending.promise;
			options.cacheProviderId = "resolved-account";
			return [oldModel];
		},
	};
	try {
		const old = resolveProviderModels(options, "online");
		await resolveProviderModels(
			{
				...options,
				cacheProviderId: "resolved-account",
				fetchDynamicModels: async () => [{ ...oldModel, id: "new", name: "New" }],
			},
			"online",
		);
		pending.resolve();
		expect((await old).models.map(row => row.id)).toEqual(["new"]);
		expect((await resolveProviderModels(options, "offline")).models.map(row => row.id)).toEqual(["new"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
