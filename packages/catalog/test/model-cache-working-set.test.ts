import { Database } from "bun:sqlite";
import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readModelCache, retainModelCacheConnection, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";

let tempDir = "";
afterEach(async () => {
	vi.restoreAllMocks();
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

test("six startup sweeps reuse parsed payloads beyond 64 namespaces and observe external changes", async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-cache-working-set-"));
	const dbPath = path.join(tempDir, "models.db");
	using connection = retainModelCacheConnection(dbPath);
	const model = buildModel({
		id: "cached",
		name: "Cached",
		provider: "working-set",
		api: "openai-completions",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
	for (let i = 0; i < 80; i++) writeModelCache(`provider-${i}`, 1000, [model], true, "", dbPath);
	const sweep = () => {
		for (let i = 0; i < 80; i++) {
			expect(readModelCache(`provider-${i}`, 1000, () => 1500, dbPath)?.models.map(m => m.id)).toEqual(["cached"]);
		}
	};
	sweep();
	const parse = vi.spyOn(JSON, "parse");
	for (let launch = 0; launch < 6; launch++) sweep();
	// Repeated launches must not parse any unchanged payload or provenance JSON.
	expect(parse).not.toHaveBeenCalled();
	parse.mockRestore();
	const external = new Database(dbPath);
	try {
		external.run("UPDATE model_cache SET authoritative = 0 WHERE provider_id = 'provider-0'");
		expect(readModelCache("provider-0", 1000, () => 2500, dbPath)).toMatchObject({
			fresh: false,
			authoritative: false,
		});
		external.run("DELETE FROM model_cache WHERE provider_id = 'provider-0'");
		expect(readModelCache("provider-0", 1000, () => 1500, dbPath)).toBeNull();
	} finally {
		external.close();
	}
});
