/**
 * `alwaysRefetchDynamicModels` contract: providers whose dynamic result
 * encodes fast-changing live state (factory-droid's serving-region filtering)
 * must not have a TTL-fresh cache replayed at them — the fetch runs on every
 * online-eligible refresh, with the cache kept only for offline/failure
 * fallback. An explicit "offline" strategy still serves the cache untouched.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { syntheticModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

function payload(id: string) {
	return {
		data: [
			{
				id,
				object: "model",
				name: id,
				input_modalities: ["text"],
				context_length: 128000,
				max_output_length: 8192,
				supported_features: ["tools"],
				pricing: { prompt: "$0.000001", completion: "$0.000002" },
			},
		],
	};
}

describe("alwaysRefetchDynamicModels", () => {
	it("replays a fresh cache under online-if-uncached without the option, refetches with it", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "always-refetch-"));
		try {
			let served = "syn:first";
			const fetchMock = vi.fn(
				async () =>
					new Response(JSON.stringify(payload(served)), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			);

			// Baseline: without the option a fresh authoritative cache satisfies the refresh.
			const baseline = createModelManager({
				...syntheticModelManagerOptions({ apiKey: "cache-test-key", fetch: fetchMock }),
				cacheDbPath: path.join(tempDir, "baseline.db"),
			});
			await baseline.refresh("online");
			const seededCalls = fetchMock.mock.calls.length;
			const cached = await baseline.refresh("online-if-uncached");
			expect(fetchMock.mock.calls.length).toBe(seededCalls);
			expect(cached.models.some(m => m.id === "syn:first")).toBe(true);

			// With the option the fetcher runs again and the new payload wins.
			const refetching = createModelManager({
				...syntheticModelManagerOptions({ apiKey: "cache-test-key", fetch: fetchMock }),
				alwaysRefetchDynamicModels: true,
				cacheDbPath: path.join(tempDir, "refetch.db"),
			});
			await refetching.refresh("online");
			const afterSeed = fetchMock.mock.calls.length;
			served = "syn:second";
			const fresh = await refetching.refresh("online-if-uncached");
			expect(fetchMock.mock.calls.length).toBeGreaterThan(afterSeed);
			expect(fresh.models.some(m => m.id === "syn:second")).toBe(true);

			// Explicit offline still serves the cache without touching the network.
			const beforeOffline = fetchMock.mock.calls.length;
			const offline = await refetching.refresh("offline");
			expect(fetchMock.mock.calls.length).toBe(beforeOffline);
			expect(offline.models.some(m => m.id === "syn:second")).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
