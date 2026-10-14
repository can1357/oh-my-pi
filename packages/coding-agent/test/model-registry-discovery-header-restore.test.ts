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
 * `--model` still resolved the model. Rows without a rebuildable header source
 * must stay excluded instead of surviving with their transport headers missing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
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

describe("model registry discovery header restore", () => {
	let tempDir: string;
	const authStoragesToClose: AuthStorage[] = [];

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-discovery-headers-"));
	});

	afterEach(async () => {
		for (const authStorage of authStoragesToClose) authStorage.close();
		authStoragesToClose.length = 0;
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	async function writeModelsYaml(headerBlock: string): Promise<string> {
		const modelsPath = path.join(tempDir, "models.yml");
		await Bun.write(
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

	async function newRegistry(modelsPath: string, fetchImpl: FetchImpl): Promise<ModelRegistry> {
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		authStorage.keys.setRuntime("my-provider", "test-api-key");
		return new ModelRegistry(authStorage, modelsPath, { fetch: fetchImpl });
	}

	async function reloadFromCache(modelsPath: string): Promise<ModelRegistry> {
		// A fresh registry over the same models.db with the discovery endpoint
		// unreachable: every model must come back from the cache alone, with its
		// request headers rebuilt from local configuration.
		return newRegistry(modelsPath, async () => new Response("not found", { status: 404 }));
	}

	test("rebuilds modelOverrides headers on cached discovery rows", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      gateway/model-a:", "        headers:", "          X-Account: acc-1"].join("\n"),
		);
		const registry1 = await newRegistry(modelsPath, mockDiscovery(["gateway/model-a"]));
		await registry1.refreshDiscoverableProviders(["my-provider"], "online");
		const live = registry1.find("my-provider", "gateway/model-a");
		expect(live).toBeDefined();
		expect(await registry1.resolveModelHeaders(live!)).toMatchObject({ "X-Account": "acc-1" });

		const registry2 = await reloadFromCache(modelsPath);
		const cached = registry2.find("my-provider", "gateway/model-a");
		expect(cached).toBeDefined();
		expect(await registry2.resolveModelHeaders(cached!)).toMatchObject({ "X-Account": "acc-1" });
		expect(resolveSessionModelSelector(registry2, "my-provider/gateway/model-a")).toBeDefined();
	});

	test("rebuilds provider-level headers on cached discovery rows", async () => {
		const modelsPath = await writeModelsYaml(["    headers:", "      X-Account: acc-1"].join("\n"));
		const registry1 = await newRegistry(modelsPath, mockDiscovery(["gateway/model-a"]));
		await registry1.refreshDiscoverableProviders(["my-provider"], "online");
		const live = registry1.find("my-provider", "gateway/model-a");
		expect(live).toBeDefined();
		expect(await registry1.resolveModelHeaders(live!)).toMatchObject({ "X-Account": "acc-1" });

		const registry2 = await reloadFromCache(modelsPath);
		const cached = registry2.find("my-provider", "gateway/model-a");
		expect(cached).toBeDefined();
		expect(await registry2.resolveModelHeaders(cached!)).toMatchObject({ "X-Account": "acc-1" });
		expect(resolveSessionModelSelector(registry2, "my-provider/gateway/model-a")).toBeDefined();
	});

	test("keeps only the cached rows whose headers can be rebuilt", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      gateway/model-a:", "        headers:", "          X-Account: acc-1"].join("\n"),
		);
		const registry1 = await newRegistry(modelsPath, mockDiscovery(["gateway/model-a", "gateway/model-b"]));
		await registry1.refreshDiscoverableProviders(["my-provider"], "online");
		// The authenticated /models fetch attaches request headers to every row,
		// so both rows are header-omitted at cache write time.
		const liveB = registry1.find("my-provider", "gateway/model-b");
		expect(liveB).toBeDefined();
		expect(await registry1.resolveModelHeaders(liveB!)).toHaveProperty("Authorization");

		const registry2 = await reloadFromCache(modelsPath);
		expect(registry2.find("my-provider", "gateway/model-a")).toBeDefined();
		// B has no local header source: it must stay excluded rather than survive
		// with its auth/account-routing header missing.
		expect(registry2.find("my-provider", "gateway/model-b")).toBeUndefined();
		expect(registry2.getProviderDiscoveryState("my-provider")?.stale).toBe(true);
	});

	test("rebuilds alias-keyed override headers on cached discovery rows", async () => {
		const modelsPath = await writeModelsYaml(
			[
				"    modelOverrides:",
				"      gateway/model-a-thinking:",
				"        headers:",
				"          X-Account: acc-1",
			].join("\n"),
		);
		// Cache creation stands in for a previous run whose discovery collapsed a
		// `gateway/model-a`/`-thinking` pair: the persisted row keeps the effort
		// routing naming the retired member id. It is written directly so this
		// process never runs a collapse and starts the reload with cold aliases,
		// like a real restart.
		const cachedModel = buildModel({
			id: "gateway/model-a",
			name: "Gateway Model A",
			api: "openai-completions",
			provider: "my-provider",
			baseUrl,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
			thinking: {
				mode: "effort",
				efforts: [Effort.High],
				defaultLevel: Effort.High,
				effortRouting: { high: "gateway/model-a-thinking" },
			},
		});
		writeModelCache(
			"my-provider:openai-models-list-context-v3",
			Date.now(),
			[{ ...cachedModel, headers: { Authorization: "Bearer test-api-key" } }],
			true,
			"",
			path.join(tempDir, "models.db"),
		);

		const registry = await reloadFromCache(modelsPath);
		const cached = registry.find("my-provider", "gateway/model-a");
		expect(cached).toBeDefined();
		expect(await registry.resolveModelHeaders(cached!)).toMatchObject({ "X-Account": "acc-1" });
		expect(resolveSessionModelSelector(registry, "my-provider/gateway/model-a")).toBeDefined();
	});

	test("does not restore rows whose header declarations are empty", async () => {
		const modelsPath = await writeModelsYaml(
			[
				"    headers: {}",
				"    modelOverrides:",
				"      gateway/model-a:",
				"        headers:",
				'          X-Account: ""',
			].join("\n"),
		);
		const registry1 = await newRegistry(modelsPath, mockDiscovery(["gateway/model-a"]));
		await registry1.refreshDiscoverableProviders(["my-provider"], "online");
		expect(registry1.find("my-provider", "gateway/model-a")).toBeDefined();

		// Empty header declarations resolve to no request headers, so they are not
		// a restoration source: the row must stay excluded instead of being
		// published with its auth/account-routing header missing.
		const registry2 = await reloadFromCache(modelsPath);
		expect(registry2.find("my-provider", "gateway/model-a")).toBeUndefined();
		expect(registry2.getProviderDiscoveryState("my-provider")?.stale).toBe(true);
	});
});
