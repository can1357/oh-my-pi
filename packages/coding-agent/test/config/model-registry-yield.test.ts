import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "bulk";
const BASE_URL = "http://bulk.test/v1";
const BULK_IDS = Array.from({ length: 3000 }, (_, index) => `bulk-model-${String(index).padStart(4, "0")}`);
// A clock that advances a quarter millisecond per reading spends a merge slice's
// budget every few dozen rows on any machine; a frozen one never spends it.
const SLICED_CLOCK_STEP_MS = 0.25;
const FROZEN_CLOCK_STEP_MS = 0;

const MODELS_YML = [
	"providers:",
	`  ${PROVIDER}:`,
	`    baseUrl: ${BASE_URL}`,
	"    api: openai-completions",
	"    auth: none",
	"    discovery:",
	"      type: openai-models-list",
].join("\n");

/** Serves every bulk id from `GET {baseUrl}/models`, the request openai-models-list discovery makes. */
async function fetchBulkModels(input: string | URL | Request): Promise<Response> {
	const url = input instanceof Request ? input.url : String(input);
	if (url !== `${BASE_URL}/models`) throw new Error(`unexpected discovery request: ${url}`);
	return Response.json({
		data: BULK_IDS.map(id => ({ id, context_length: 65_536, max_output_tokens: 8_192 })),
	});
}

function modelKeys(models: readonly Model<Api>[]): string[] {
	return models.map(model => `${model.provider}/${model.id}`);
}

describe("ModelRegistry sliced discovery merge", () => {
	const tempDirs: TempDir[] = [];
	const authStorages: AuthStorage[] = [];
	let clockSpy: { mockRestore: () => void } | undefined;

	afterEach(async () => {
		clockSpy?.mockRestore();
		clockSpy = undefined;
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		await Promise.all(tempDirs.splice(0).map(tempDir => tempDir.remove().catch(() => {})));
	});

	async function createRegistry(): Promise<ModelRegistry> {
		const tempDir = TempDir.createSync("@model-registry-yield-");
		tempDirs.push(tempDir);
		const modelsPath = path.join(tempDir.path(), "models.yml");
		await Bun.write(modelsPath, MODELS_YML);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorages.push(authStorage);
		return new ModelRegistry(authStorage, modelsPath, { fetch: fetchBulkModels, settings: Settings.isolated({}) });
	}

	/**
	 * Runs one online discovery of the bulk provider with `performance.now`
	 * advancing `stepMs` per reading. Every event-loop turn taken after the
	 * provider reports its fetch done but before its rows are findable falls
	 * inside the merge: it is counted, and `onMergeTurn` reads the registry there.
	 */
	async function discoverBulk(registry: ModelRegistry, stepMs: number, onMergeTurn?: () => void): Promise<number> {
		let clock = 0;
		clockSpy = spyOn(performance, "now").mockImplementation(() => {
			clock += stepMs;
			return clock;
		});
		let pending = true;
		let mergeTurns = 0;
		const turn = () => {
			if (!pending) return;
			const fetched = registry.getProviderDiscoveryState(PROVIDER)?.status === "ok";
			if (fetched && registry.find(PROVIDER, BULK_IDS[0]) === undefined) {
				mergeTurns++;
				onMergeTurn?.();
			}
			setImmediate(turn);
		};
		// Scheduled before the pass starts, so before its merge does.
		setImmediate(turn);
		try {
			await registry.refreshDiscoverableProviders([PROVIDER], "online");
		} finally {
			pending = false;
			clockSpy.mockRestore();
			clockSpy = undefined;
		}
		return mergeTurns;
	}

	test("merges thousands of discovered models across event-loop turns into the catalog an unsliced merge lands", async () => {
		const unslicedRegistry = await createRegistry();
		unslicedRegistry.getAll("all");
		const unslicedMergeTurns = await discoverBulk(unslicedRegistry, FROZEN_CLOCK_STEP_MS);

		const slicedRegistry = await createRegistry();
		slicedRegistry.getAll("all");
		const slicedMergeTurns = await discoverBulk(slicedRegistry, SLICED_CLOCK_STEP_MS);

		expect(slicedMergeTurns).toBeGreaterThanOrEqual(3);
		expect(slicedMergeTurns).toBeGreaterThan(unslicedMergeTurns);

		const unsliced = unslicedRegistry.getAll("all");
		const sliced = slicedRegistry.getAll("all");
		expect(unsliced.filter(model => model.provider === PROVIDER)).toHaveLength(BULK_IDS.length);
		expect(modelKeys(sliced)).toEqual(modelKeys(unsliced));
		// Same fields: the JSON form holds every data field of every row.
		expect(JSON.parse(JSON.stringify(sliced))).toEqual(JSON.parse(JSON.stringify(unsliced)));
	}, 60_000);

	test("serves the last landed catalog to readers while a sliced merge is pending", async () => {
		const registry = await createRegistry();
		const before = registry.getAll();
		const beforeKeys = modelKeys(before);
		expect(before.some(model => model.provider === PROVIDER)).toBe(false);

		const pendingReads: Model<Api>[][] = [];
		const mergeTurns = await discoverBulk(registry, SLICED_CLOCK_STEP_MS, () => pendingReads.push(registry.getAll()));

		expect(mergeTurns).toBeGreaterThanOrEqual(3);
		for (const read of pendingReads) expect(modelKeys(read)).toEqual(beforeKeys);

		const after = registry.getAll();
		expect(
			after
				.filter(model => model.provider === PROVIDER)
				.map(model => model.id)
				.sort(),
		).toEqual(BULK_IDS);
		expect(modelKeys(after.filter(model => model.provider !== PROVIDER)).sort()).toEqual([...beforeKeys].sort());
	}, 60_000);
});
