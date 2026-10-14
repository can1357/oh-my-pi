/**
 * Regression: configured discovery models whose request headers come from
 * models.yml disappeared from the registry once their discovery cache row was
 * written.
 *
 * The model cache never persists request headers (#5780): rows carrying
 * headers/resolveHeaders are recorded in `header_omitted_model_ids` and must be
 * rebuilt at cache-read time. The rebuild only covered the
 * `authHeader && apiKey` bearer case, so a model whose headers are configured
 * through `modelOverrides.<id>.headers` or provider-level `headers` was dropped
 * from every cached read — `find`/`resolveSessionModelSelector` missed it after
 * restart until a successful online refetch repopulated the catalog, surfacing
 * as `Could not restore model <provider/id>` on `--continue`/`--resume` while
 * `--model` still resolved the model.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { resolveSessionModelSelector } from "../src/config/model-resolver";
import type { AuthStorage } from "../src/session/auth-storage";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const baseUrl = "https://example.test/v1";

function mockDiscovery(ids: string[]): FetchImpl {
	return async input => {
		const url = String(input);
		if (url === `${baseUrl}/models`) {
			return Response.json({ data: ids.map(id => ({ id })) });
		}
		return new Response("not found", { status: 404 });
	};
}

const unreachableDiscovery: FetchImpl = async () => new Response("not found", { status: 404 });

describe("model registry discovery header restore", () => {
	let tempDir: string;
	const authStoragesToClose: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-discovery-headers-"));
	});

	afterEach(() => {
		for (const authStorage of authStoragesToClose) authStorage.close();
		authStoragesToClose.length = 0;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeModelsYaml(headerBlock: string): string {
		const modelsPath = path.join(tempDir, "models.yml");
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  my-provider:",
				`    baseUrl: ${baseUrl}`,
				"    api: openai-completions",
				"    apiKey: test-api-key",
				"    discovery:",
				"      type: openai-models-list",
				headerBlock,
			].join("\n"),
		);
		return modelsPath;
	}

	async function discoverOnce(modelsPath: string): Promise<void> {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime("my-provider", "test-api-key");
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: mockDiscovery(["gateway/model-a"]),
		});
		await registry.refreshDiscoverableProviders(["my-provider"], "online");
		const live = registry.find("my-provider", "gateway/model-a");
		expect(live).toBeDefined();
		expect(await registry.resolveModelHeaders(live!)).toMatchObject({ "X-Account": "acc-1" });
	}

	async function reloadFromCache(modelsPath: string): Promise<ModelRegistry> {
		// A second registry over the same models.db with the discovery endpoint
		// unreachable: every model must come back from the cache alone, with its
		// request headers rebuilt from local configuration.
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime("my-provider", "test-api-key");
		return new ModelRegistry(authStorage, modelsPath, { fetch: unreachableDiscovery });
	}

	test("rebuilds modelOverrides headers on cached discovery rows", async () => {
		const modelsPath = writeModelsYaml(
			["    modelOverrides:", "      gateway/model-a:", "        headers:", "          X-Account: acc-1"].join("\n"),
		);
		await discoverOnce(modelsPath);
		const registry = await reloadFromCache(modelsPath);
		const cached = registry.find("my-provider", "gateway/model-a");
		expect(cached).toBeDefined();
		expect(await registry.resolveModelHeaders(cached!)).toMatchObject({ "X-Account": "acc-1" });
		expect(resolveSessionModelSelector(registry, "my-provider/gateway/model-a")).toBeDefined();
	});

	test("rebuilds provider-level headers on cached discovery rows", async () => {
		const modelsPath = writeModelsYaml(["    headers:", "      X-Account: acc-1"].join("\n"));
		await discoverOnce(modelsPath);
		const registry = await reloadFromCache(modelsPath);
		const cached = registry.find("my-provider", "gateway/model-a");
		expect(cached).toBeDefined();
		expect(await registry.resolveModelHeaders(cached!)).toMatchObject({ "X-Account": "acc-1" });
		expect(resolveSessionModelSelector(registry, "my-provider/gateway/model-a")).toBeDefined();
	});
});
