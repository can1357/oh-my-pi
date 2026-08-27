import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "../../src/model-manager";
import { zedModelManagerOptions } from "../../src/provider-models/special";
import type { FetchImpl } from "../../src/types";

function createCredentialFetcher(calls: string[]): FetchImpl {
	return async (input, init) => {
		const url = String(input);
		if (!url.endsWith("/models")) return new Response("Not Found", { status: 404 });
		const authorization = new Headers(init?.headers).get("authorization") ?? "";
		const credential = authorization.replace(/^Bearer /, "");
		calls.push(credential);
		return new Response(
			JSON.stringify({
				models: [
					{
						provider: "anthropic",
						id: `${credential}-model`,
						display_name: `${credential} model`,
					},
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};
}

describe("Zed authoritative model cache identity", () => {
	it("does not reuse one credential's live catalog for another credential", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-zed-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const calls: string[] = [];
		const fetcher = createCredentialFetcher(calls);
		const makeOptions = (apiKey: string) => ({
			...zedModelManagerOptions({ apiKey, fetch: fetcher }),
			staticModels: [],
			cacheDbPath: dbPath,
			now: () => 1_000_000,
		});
		const accountA = makeOptions("zed-credential-a");
		const accountB = makeOptions("zed-credential-b");

		try {
			const fetchedA = await resolveProviderModels(accountA, "online");
			expect(fetchedA.models.map(model => model.id)).toEqual(["zed-credential-a-model"]);
			expect(calls).toEqual(["zed-credential-a"]);

			const cachedA = await resolveProviderModels(accountA, "offline");
			expect(cachedA.models.map(model => model.id)).toEqual(["zed-credential-a-model"]);

			const uncachedB = await resolveProviderModels(accountB, "offline");
			expect(uncachedB.models).toEqual([]);
			expect(calls).toEqual(["zed-credential-a"]);

			const fetchedB = await resolveProviderModels(accountB, "online");
			expect(fetchedB.models.map(model => model.id)).toEqual(["zed-credential-b-model"]);
			expect(calls).toEqual(["zed-credential-a", "zed-credential-b"]);

			const stillCachedA = await resolveProviderModels(accountA, "offline");
			expect(stillCachedA.models.map(model => model.id)).toEqual(["zed-credential-a-model"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
