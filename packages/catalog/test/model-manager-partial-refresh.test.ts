import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "../src/models";

test("partial authoritative refresh does not revive pruned static models", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "partial-authority-"));
	try {
		const kept = getBundledModels("cloudflare-ai-gateway").find(model => model.api === "openai-completions");
		if (!kept) throw new Error("Expected a gateway model");
		const pruned = { ...kept, id: `${kept.id}-pruned` };
		const { compat: _compat, ...discovered } = kept;
		let partial = false;
		let now = 1_000_000;
		let calls = 0;
		const manager = createModelManager({
			providerId: "cloudflare-ai-gateway",
			staticModels: [kept, pruned],
			dynamicModelsAuthoritative: true,
			cacheDbPath: path.join(dir, "cache.db"),
			now: () => now,
			fetchDynamicModels: async () => {
				calls++;
				return partial
					? Object.assign([{ ...discovered, name: `${discovered.name} updated` }], { complete: false as const })
					: [discovered];
			},
		});
		const full = await manager.refresh("online");
		expect(full.models.map(model => model.id)).toEqual([kept.id]);
		partial = true;
		for (let i = 0; i < 2; i++) {
			const result = await manager.refresh("online");
			expect(result.models.map(model => model.id)).toEqual([kept.id]);
			expect(result.stale).toBe(true);
		}
		const offline = await manager.refresh("offline");
		expect(offline.models.map(model => model.id)).toEqual([kept.id]);
		expect(offline.stale).toBe(true);
		expect(offline.models[0]?.name).toBe(`${discovered.name} updated`);
		now += 5 * 60 * 1000 + 1;
		await manager.refresh("online-if-uncached");
		expect(calls).toBe(4);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("partial refresh preserves changed bundled models with a non-authoritative cache", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "partial-snapshot-"));
	try {
		const bundled = getBundledModels("cloudflare-ai-gateway").find(model => model.api === "openai-completions");
		if (!bundled) throw new Error("Expected a gateway model");
		const added = { ...bundled, id: `${bundled.id}-added` };
		const { compat: _compat, ...discovered } = bundled;
		const cacheDbPath = path.join(dir, "cache.db");
		const options = {
			providerId: "cloudflare-ai-gateway" as const,
			dynamicModelsAuthoritative: true,
			cacheDbPath,
			fetchDynamicModels: async () => Object.assign([discovered], { complete: false as const }),
		};
		const original = createModelManager({ ...options, staticModels: [bundled] });
		const first = await original.refresh("online");
		expect(first.models.map(model => model.id)).toEqual([bundled.id]);
		expect(first.stale).toBe(true);

		const updated = createModelManager({ ...options, staticModels: [bundled, added] });
		const partial = await updated.refresh("online");
		expect(partial.models.map(model => model.id)).toEqual(expect.arrayContaining([bundled.id, added.id]));
		expect(partial.stale).toBe(true);
		const offline = await updated.refresh("offline");
		expect(offline.models.map(model => model.id)).toEqual(expect.arrayContaining([bundled.id, added.id]));
		expect(offline.stale).toBe(true);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("empty partial cold result does not delay next discovery attempt", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "partial-empty-"));
	try {
		let calls = 0;
		const manager = createModelManager({
			providerId: "cloudflare-ai-gateway",
			staticModels: [],
			cacheDbPath: path.join(dir, "cache.db"),
			fetchDynamicModels: async () => {
				calls++;
				return Object.assign([], { complete: false as const });
			},
		});
		await manager.refresh("online-if-uncached");
		await manager.refresh("online-if-uncached");
		expect(calls).toBe(2);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
