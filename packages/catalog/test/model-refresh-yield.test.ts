import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { bypassCascadeMemoForTesting } from "@oh-my-pi/pi-catalog/compat/cascade";
import { hasModelScopedEffortLadder, resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import {
	getModelCacheWriteStats,
	type ModelCacheWriteOutcome,
	readModelCache,
	writeModelCache,
	writeModelCacheAsync,
} from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const TTL_MS = 24 * 60 * 60 * 1000;
const PROVIDER = "refresh-yield-test";
const REFRESH_MODEL_COUNT = 5_000;

function refreshSpec(index: number, revision: string, provider = PROVIDER): ModelSpec<"openai-completions"> {
	return {
		id: `refresh-model-${index}-${revision}`,
		name: `Refresh Model ${index} ${revision}`,
		api: "openai-completions",
		provider,
		baseUrl: "https://refresh.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function refreshSpecs(revision: string, count = REFRESH_MODEL_COUNT, provider = PROVIDER) {
	return Array.from({ length: count }, (_, index) => refreshSpec(index, revision, provider));
}

function refreshModels(revision: string, count: number, provider = PROVIDER): Model<"openai-completions">[] {
	return refreshSpecs(revision, count, provider).map(spec => buildModel(spec));
}

function cachedNames(cacheDbPath: string, provider = PROVIDER): string[] | undefined {
	return readModelCache(provider, TTL_MS, () => 0, cacheDbPath)?.models.map(model => model.name);
}

/** Everything policy resolution yields for one spec, or the error it throws. */
function resolvePolicyOutputs(spec: ModelSpec<Api>) {
	try {
		return {
			model: buildModel(spec),
			policy: resolveModelPolicy(spec),
			scopedEfforts: hasModelScopedEffortLadder(spec),
		};
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

describe("model policy resolution memo", () => {
	it("resolves 2,000 models of one provider identically with and without the rule-ranking memo", () => {
		const bundled = getBundledModels("openrouter");
		expect(bundled.length).toBeGreaterThan(0);
		// Bundled ids hit exact model selectors; suffixed copies share their
		// identity but fall through to glob and identity-scoped rules.
		const specs = Array.from({ length: 2_000 }, (_, index): ModelSpec<Api> => {
			const source = bundled[index % bundled.length];
			const round = Math.floor(index / bundled.length);
			return {
				id: round === 0 ? source.id : `${source.id}-memo-${round}`,
				name: source.name,
				api: source.api,
				provider: source.provider,
				baseUrl: source.baseUrl,
				reasoning: index % 3 === 0 ? !source.reasoning : source.reasoning,
				input: source.input,
				cost: {
					input: source.cost.input,
					output: source.cost.output,
					cacheRead: source.cost.cacheRead,
					cacheWrite: source.cost.cacheWrite,
				},
				contextWindow: source.contextWindow,
				maxTokens: source.maxTokens,
			};
		});
		const resolveAll = () => specs.map(spec => resolvePolicyOutputs(spec));

		const memoized = resolveAll();
		const reference = bypassCascadeMemoForTesting(resolveAll);

		expect(memoized.filter(output => "model" in output).length).toBeGreaterThan(0);
		expect(memoized).toStrictEqual(reference);
	});
});

describe("time-sliced model refresh", () => {
	it("spreads a refresh of thousands of models across event-loop turns, then serves every row", async () => {
		await using temp = await TempDir.create("@model-refresh-yield-");
		const cacheDbPath = temp.join("models.db");
		const refreshOptions = (revision: string, now: number) => ({
			providerId: PROVIDER,
			staticModels: [],
			cacheDbPath,
			now: () => now,
			fetchDynamicModels: async () => refreshSpecs(revision),
		});
		await resolveProviderModels(refreshOptions("old", 1_000), "online");
		const oldNames = cachedNames(cacheDbPath);
		expect(oldNames).toHaveLength(REFRESH_MODEL_COUNT);

		// Real timers on purpose: the assertion is about the event loop itself,
		// and fake timers freeze the clock the slice budget reads.
		let settled = false;
		let timerFiredMidRefresh = false;
		let namesSeenMidRefresh: string[] | undefined;
		setTimeout(() => {
			timerFiredMidRefresh = !settled;
			namesSeenMidRefresh = cachedNames(cacheDbPath);
		}, 0);
		let turns = 0;
		const countTurn = (): void => {
			if (settled) return;
			turns++;
			setImmediate(countTurn);
		};
		setImmediate(countTurn);

		const result = await resolveProviderModels(refreshOptions("new", 2_000), "online");
		settled = true;

		expect(timerFiredMidRefresh).toBe(true);
		expect(turns).toBeGreaterThanOrEqual(2);
		// A reader during the refresh gets the previous snapshot whole, never a partial or empty one.
		expect(namesSeenMidRefresh).toEqual(oldNames);
		const newNames = result.models.map(model => model.name);
		expect(newNames).toHaveLength(REFRESH_MODEL_COUNT);
		expect(newNames).not.toEqual(oldNames);
		expect(cachedNames(cacheDbPath)).toEqual(newNames);
	});

	it("writes no cache row when a refresh finds the stored snapshot unchanged", async () => {
		await using temp = await TempDir.create("@model-refresh-unchanged-");
		const options = {
			providerId: PROVIDER,
			staticModels: [],
			cacheDbPath: temp.join("models.db"),
			now: () => 5_000,
			fetchDynamicModels: async () => refreshSpecs("same", 500),
		};
		await resolveProviderModels(options, "online");

		const before = getModelCacheWriteStats();
		const result = await resolveProviderModels(options, "online");
		const after = getModelCacheWriteStats();

		expect(result.models).toHaveLength(500);
		expect(after.payloadWrites - before.payloadWrites).toBe(0);
		expect(after.refreshWrites - before.refreshWrites).toBe(0);
		expect(after.skippedWrites - before.skippedWrites).toBe(1);
	});

	it("reports what each refresh write did to the stored row", async () => {
		await using temp = await TempDir.create("@model-refresh-outcome-");
		const cacheDbPath = temp.join("models.db");
		const models = refreshModels("outcome", 50);

		expect(await writeModelCacheAsync(PROVIDER, 1_000, models, true, "fp", cacheDbPath)).toBe("written");
		expect(await writeModelCacheAsync(PROVIDER, 1_000, models, true, "fp", cacheDbPath)).toBe("skipped");
		expect(await writeModelCacheAsync(PROVIDER, 2_000, models, true, "fp", cacheDbPath)).toBe("refreshed");
		expect(readModelCache(PROVIDER, TTL_MS, () => 2_000, cacheDbPath)?.updatedAt).toBe(2_000);
	});

	it("lands concurrent refresh writes of many providers", async () => {
		await using temp = await TempDir.create("@model-refresh-batch-");
		const cacheDbPath = temp.join("models.db");
		const providers = Array.from({ length: 40 }, (_, index) => `batch-provider-${index}`);

		const outcomes = await Promise.all(
			providers.map(provider =>
				writeModelCacheAsync(provider, 1_000, refreshModels("batch", 25, provider), true, "fp", cacheDbPath),
			),
		);

		expect(outcomes).toEqual(providers.map(() => "written"));
		for (const provider of providers) {
			expect(cachedNames(cacheDbPath, provider)).toHaveLength(25);
		}
	});

	it("lets a later write of the same provider win over a refresh write still in flight", async () => {
		await using temp = await TempDir.create("@model-refresh-supersede-");
		const cacheDbPath = temp.join("models.db");
		const latest = refreshModels("latest", 3);

		const pending = writeModelCacheAsync(PROVIDER, 1_000, refreshModels("stale", 200), true, "fp", cacheDbPath);
		expect(writeModelCache(PROVIDER, 2_000, latest, true, "fp", cacheDbPath)).toBe("written");

		expect(await pending).toBe("superseded");
		expect(cachedNames(cacheDbPath)).toEqual(latest.map(model => model.name));
	});

	it("waits out another connection's write lock without blocking the event loop", async () => {
		await using temp = await TempDir.create("@model-refresh-lock-");
		const cacheDbPath = temp.join("models.db");
		expect(writeModelCache("lock-seed", 1_000, refreshModels("seed", 1, "lock-seed"), true, "fp", cacheDbPath)).toBe(
			"written",
		);
		const models = refreshModels("locked", 20);
		const blocker = new Database(cacheDbPath);
		try {
			blocker.run("BEGIN IMMEDIATE");
			let outcome: ModelCacheWriteOutcome | undefined;
			const write = writeModelCacheAsync(PROVIDER, 1_000, models, true, "fp", cacheDbPath).then(result => {
				outcome = result;
				return result;
			});

			// The write attempt runs in the microtasks ahead of this turn; SQLite's
			// busy handler would hold the thread there for its whole timeout.
			const turnStart = performance.now();
			const { promise: turned, resolve: turn } = Promise.withResolvers<void>();
			setImmediate(turn);
			await turned;
			expect(performance.now() - turnStart).toBeLessThan(500);
			expect(outcome).toBeUndefined();

			blocker.run("COMMIT");
			expect(await write).toBe("written");
		} finally {
			if (blocker.inTransaction) blocker.run("ROLLBACK");
			blocker.close();
		}
		expect(cachedNames(cacheDbPath)).toEqual(models.map(model => model.name));
	});
});
