import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel } from "../src/build";
import { readModelCache, writeModelCache } from "../src/model-cache";
import { createModelManager, resolveProviderModels } from "../src/model-manager";
import type { ModelSpec } from "../src/types";

function model(id: string, headers?: Record<string, string>): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		provider: "lifecycle-test",
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
		...(headers ? { headers } : {}),
	};
}

test("complete membership survives failure, bundle upgrades, and unavailable header restoration", async () => {
	const directory = await mkdtemp(join(tmpdir(), "omp-membership-"));
	let clock = 1000;
	let response: readonly ModelSpec<"openai-completions">[] | null = [model("A"), model("B")];
	const options = {
		providerId: "lifecycle-test",
		cacheDbPath: join(directory, "models.db"),
		staticModels: [model("A"), model("B")],
		dynamicModelsAuthoritative: true,
		now: () => clock,
		fetchDynamicModels: async () => response,
	};
	try {
		await resolveProviderModels(options, "online");
		clock += 1000;
		response = [model("B"), model("C", { Secret: "never-persist" })];
		const success = await resolveProviderModels(options, "online");
		expect(success.models.map(row => row.id)).toEqual(["B", "C"]);
		clock += 10_000_000;
		response = null;
		options.staticModels = [model("A"), model("B"), model("D")];
		for (const strategy of ["online", "offline"] as const) {
			const result = await resolveProviderModels(options, strategy);
			expect(result.models.map(row => row.id)).toEqual(["B"]);
			expect(result.authoritative).toBe(true);
			expect(result.updatedAt).toBe(success.updatedAt);
			expect(result.stale).toBe(true);
		}
		expect(JSON.stringify(readModelCache(options.providerId, 1, () => clock, options.cacheDbPath))).not.toContain(
			"never-persist",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("empty membership survives short retry and failed refresh without resetting success time", async () => {
	const directory = await mkdtemp(join(tmpdir(), "omp-empty-membership-"));
	let clock = 1000;
	let calls = 0;
	const options = {
		providerId: "lifecycle-test",
		cacheDbPath: join(directory, "models.db"),
		staticModels: [model("A")],
		dynamicModelsAuthoritative: true,
		now: () => clock,
		fetchDynamicModels: async () => {
			calls++;
			return calls === 1 ? [] : null;
		},
	};
	try {
		const first = await resolveProviderModels(options, "online");
		clock += 1000;
		expect((await resolveProviderModels(options)).models).toEqual([]);
		expect(calls).toBe(1);
		clock += 300_000;
		const retried = await resolveProviderModels(options);
		expect(calls).toBe(2);
		expect(retried.models).toEqual([]);
		expect(retried.updatedAt).toBe(first.updatedAt);
		clock += 1000;
		expect((await resolveProviderModels(options)).models).toEqual([]);
		expect(calls).toBe(2);
		expect((await resolveProviderModels(options, "offline")).authoritative).toBe(true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

for (const lateFailure of [false, true]) {
	test(`independent managers discard a late ${lateFailure ? "failure" : "success"}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "omp-ordering-"));
		const pending = Promise.withResolvers<readonly ModelSpec<"openai-completions">[] | null>();
		const options = {
			providerId: "lifecycle-test",
			cacheDbPath: join(directory, "models.db"),
			staticModels: [model("A")],
			dynamicModelsAuthoritative: true,
		};
		try {
			await resolveProviderModels({ ...options, fetchDynamicModels: async () => [model("B")] }, "online");
			const old = createModelManager({ ...options, fetchDynamicModels: () => pending.promise }).refresh("online");
			expect((await resolveProviderModels(options, "offline")).models.map(row => row.id)).toEqual(["B"]);
			await createModelManager({ ...options, fetchDynamicModels: async () => [model("C")] }).refresh("online");
			pending.resolve(lateFailure ? null : [model("A")]);
			expect((await old).models.map(row => row.id)).toEqual(["C"]);
			expect((await resolveProviderModels(options, "offline")).models.map(row => row.id)).toEqual(["C"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test("legacy merged cache never establishes complete endpoint membership", async () => {
	const directory = await mkdtemp(join(tmpdir(), "omp-legacy-membership-"));
	const cacheDbPath = join(directory, "models.db");
	try {
		writeModelCache("lifecycle-test", Date.now(), [buildModel(model("B"))], true, "legacy", cacheDbPath);
		const result = await resolveProviderModels(
			{ providerId: "lifecycle-test", cacheDbPath, staticModels: [model("A")], dynamicModelsAuthoritative: true },
			"offline",
		);
		expect(result.models.map(row => row.id)).toEqual(["A", "B"]);
		expect(result.authoritative).toBe(false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
