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
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
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

	async function writeModelsYaml(headerBlock: string, provider = "my-provider"): Promise<string> {
		const modelsPath = path.join(tempDir, "models.yml");
		await Bun.write(
			modelsPath,
			[
				"providers:",
				`  ${provider}:`,
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

	// Writes cache rows the way a previous run's discovery collapse would: the
	// persisted row keeps the effort routing naming its retired member id and
	// carries request headers, so the rows land in `header_omitted_model_ids`.
	// Direct writes keep this process free of live collapses, so reloads start
	// with cold variant aliases like a real restart.
	function seedCachedRows(
		rows: ReadonlyArray<{ id: string; alias?: string; requestModelId?: string; plain?: boolean }>,
		provider = "my-provider",
	): void {
		writeModelCache(
			`${provider}:openai-models-list-context-v3`,
			Date.now(),
			rows.map(row => ({
				...buildModel({
					id: row.id,
					name: row.id,
					api: "openai-completions",
					provider,
					baseUrl,
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 4096,
					maxTokens: 1024,
					requestModelId: row.requestModelId,
					...(row.alias
						? {
								thinking: {
									mode: "effort",
									efforts: [Effort.High],
									defaultLevel: Effort.High,
									effortRouting: { high: row.alias },
								},
							}
						: {}),
				}),
				...(row.plain ? {} : { headers: { Authorization: "Bearer test-api-key" } }),
			})),
			true,
			"",
			path.join(tempDir, "models.db"),
		);
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
		seedCachedRows([{ id: "gateway/model-a", alias: "gateway/model-a-thinking" }]);

		const registry = await reloadFromCache(modelsPath);
		const cached = registry.find("my-provider", "gateway/model-a");
		expect(cached).toBeDefined();
		expect(await registry.resolveModelHeaders(cached!)).toMatchObject({ "X-Account": "acc-1" });
		expect(resolveSessionModelSelector(registry, "my-provider/gateway/model-a")).toBeDefined();
	});

	test("does not rebind alias-keyed headers owned by a live custom model", async () => {
		const modelsPath = await writeModelsYaml(
			[
				"    models:",
				"      - id: gateway/model-a-thinking",
				"        name: Gateway Thinking",
				"    modelOverrides:",
				"      gateway/model-a-thinking:",
				"        headers:",
				"          X-Account: acc-1",
			].join("\n"),
		);
		seedCachedRows([{ id: "gateway/model-a", alias: "gateway/model-a-thinking" }]);

		const registry = await reloadFromCache(modelsPath);
		// The alias id is a live custom model: its override headers belong to that
		// model and must not be rebound onto the cached logical row, which has no
		// restoration source of its own and stays excluded.
		expect(registry.find("my-provider", "gateway/model-a")).toBeUndefined();
		const owner = registry.find("my-provider", "gateway/model-a-thinking");
		expect(owner).toBeDefined();
		expect(await registry.resolveModelHeaders(owner!)).toMatchObject({ "X-Account": "acc-1" });
	});

	test("does not rebind request-model headers owned by a live custom model", async () => {
		const modelsPath = await writeModelsYaml(
			[
				"    models:",
				"      - id: gateway/upstream-raw",
				"        name: Gateway Upstream",
				"    modelOverrides:",
				"      gateway/upstream-raw:",
				"        headers:",
				"          X-Account: acc-3",
			].join("\n"),
		);
		seedCachedRows([{ id: "gateway/model-a", requestModelId: "gateway/upstream-raw" }]);

		const registry = await reloadFromCache(modelsPath);
		// The request-model id is a live custom model: its override headers belong
		// to that model, so the request-model fallback must not rebind them onto
		// the cached row, which stays excluded without a restoration source.
		expect(registry.find("my-provider", "gateway/model-a")).toBeUndefined();
		const owner = registry.find("my-provider", "gateway/upstream-raw");
		expect(owner).toBeDefined();
		expect(await registry.resolveModelHeaders(owner!)).toMatchObject({ "X-Account": "acc-3" });
	});

	test("does not rebind alias-keyed headers owned by a bundled model", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      gpt-4o:", "        headers:", "          X-Account: acc-4"].join("\n"),
			"openai",
		);
		seedCachedRows([{ id: "openai/gpt-4o-old", alias: "gpt-4o" }], "openai");

		const registry = await reloadFromCache(modelsPath);
		// The alias id is a live bundled model: its override headers belong to that
		// model and must not be rebound onto the cached logical row.
		expect(registry.find("openai", "openai/gpt-4o-old")).toBeUndefined();
		expect(registry.find("openai", "gpt-4o")).toBeDefined();
	});

	test("restores remapped aliases from the cohort the manager reads", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      gateway/model-shared:", "        headers:", "          X-Account: acc-5"].join(
				"\n",
			),
		);
		// The stale cohort's row is not header-omitted, so no restore pass adopts
		// its alias mapping; only the newer cohort (written mid-fetch) must claim
		// `gateway/model-shared` — for its own logical model.
		seedCachedRows([{ id: "gateway/model-a", alias: "gateway/model-shared", plain: true }]);
		const registry = await newRegistry(modelsPath, async () => {
			seedCachedRows([{ id: "gateway/model-b", alias: "gateway/model-shared" }]);
			return new Response("not found", { status: 404 });
		});
		await registry.refreshDiscoverableProviders(["my-provider"], "online");

		const restarted = await reloadFromCache(modelsPath);
		const cached = restarted.find("my-provider", "gateway/model-b");
		expect(cached).toBeDefined();
		expect(await restarted.resolveModelHeaders(cached!)).toMatchObject({ "X-Account": "acc-5" });
	});

	test("rebuilds request-model override headers on cached discovery rows", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      gateway/upstream-raw:", "        headers:", "          X-Account: acc-6"].join(
				"\n",
			),
		);
		seedCachedRows([{ id: "gateway/model-a", requestModelId: "gateway/upstream-raw" }]);

		const registry = await reloadFromCache(modelsPath);
		const cached = registry.find("my-provider", "gateway/model-a");
		expect(cached).toBeDefined();
		expect(await registry.resolveModelHeaders(cached!)).toMatchObject({ "X-Account": "acc-6" });
		expect(resolveSessionModelSelector(registry, "my-provider/gateway/model-a")).toBeDefined();
	});

	test("keeps bundled transport headers alongside local override headers", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      claude-haiku-4.5:", "        headers:", "          X-Local: loc-1"].join("\n"),
			"github-copilot",
		);
		seedCachedRows([{ id: "claude-haiku-4.5" }], "github-copilot");

		const registry = await reloadFromCache(modelsPath);
		const cached = registry.find("github-copilot", "claude-haiku-4.5");
		expect(cached).toBeDefined();
		// The bundled row's required transport headers must survive restoration
		// next to the locally configured ones.
		expect(await registry.resolveModelHeaders(cached!)).toMatchObject({
			"Copilot-Integration-Id": "copilot-developer-cli",
			"X-Local": "loc-1",
		});
	});

	test("reserves collapsed aliases owned by live models", async () => {
		const modelsPath = await writeModelsYaml(
			[
				"    modelOverrides:",
				"      claude-4-sonnet-thinking:",
				"        headers:",
				"          X-Account: live-1",
			].join("\n"),
			"cursor",
		);
		seedCachedRows([{ id: "cursor/cached-row", alias: "claude-4-sonnet-thinking" }], "cursor");

		const registry = await reloadFromCache(modelsPath);
		// The raw-id override and alias belong to the live collapsed model: the
		// cached row that merely records the same member id gets neither.
		expect(registry.find("cursor", "cursor/cached-row")).toBeUndefined();
		expect(resolveSessionModelSelector(registry, "cursor/claude-4-sonnet-thinking")?.model).toMatchObject({
			id: "claude-4-sonnet",
			provider: "cursor",
		});
	});

	test("rejects stale reverse aliases when the routing alias moves", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      shared:", "        headers:", "          X-Account: b-1"].join("\n"),
		);
		// First generation registers shared -> gateway/model-a through its
		// omitted-header restore; the global alias index keeps that mapping.
		seedCachedRows([{ id: "gateway/model-a", alias: "shared" }]);
		const first = await reloadFromCache(modelsPath);
		expect(await first.resolveModelHeaders(first.find("my-provider", "gateway/model-a")!)).toMatchObject({
			"X-Account": "b-1",
		});

		// Second generation keeps A but moves the persisted routing alias to B:
		// A must be rejected instead of rebinding B's header through the stale
		// reverse alias.
		seedCachedRows([{ id: "gateway/model-a" }, { id: "gateway/model-b", alias: "shared" }]);
		const second = await reloadFromCache(modelsPath);
		expect(second.find("my-provider", "gateway/model-a")).toBeUndefined();
		const b = second.find("my-provider", "gateway/model-b");
		expect(b).toBeDefined();
		expect(await second.resolveModelHeaders(b!)).toMatchObject({ "X-Account": "b-1" });
	});

	test("does not treat bundled headers alone as a restore source", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      claude-fable-5:", "        headers:", "          X-Other: o-1"].join("\n"),
			"github-copilot",
		);
		seedCachedRows([{ id: "claude-haiku-4.5" }], "github-copilot");

		const registry = await reloadFromCache(modelsPath);
		// The bundled constants cannot account for the omitted headers (a removed
		// per-model account header would stay missing), so without a config source
		// for this row the bundled fallback must win over the cached row.
		const bundled = (getBundledModels("github-copilot") as ReadonlyArray<{ id: string; api: string }>).find(
			model => model.id === "claude-haiku-4.5",
		);
		expect(registry.find("github-copilot", "claude-haiku-4.5")).toMatchObject({ api: bundled!.api });
	});

	test("permits aliases owned by the row being restored", async () => {
		const modelsPath = await writeModelsYaml(
			[
				"    modelOverrides:",
				"      claude-4-sonnet-thinking:",
				"        headers:",
				"          X-Account: live-1",
			].join("\n"),
			"cursor",
		);
		// The cached discovery row IS the live collapsed model, so the raw alias
		// is its own and must rebind for it.
		seedCachedRows([{ id: "claude-4-sonnet", alias: "claude-4-sonnet-thinking" }], "cursor");

		const registry = await reloadFromCache(modelsPath);
		const restored = registry.find("cursor", "claude-4-sonnet");
		expect(restored).toBeDefined();
		// The discovered row is restored with its own metadata instead of being
		// discarded for the bundled fallback with the header rebound on it.
		expect(restored!.api).toBe("openai-completions");
		expect(await registry.resolveModelHeaders(restored!)).toMatchObject({ "X-Account": "live-1" });
	});

	test("keeps stale cohort aliases out of later projections", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      shared:", "        headers:", "          X-Account: b-1"].join("\n"),
		);
		// First generation registers shared -> gateway/model-a through its
		// omitted-header restore.
		seedCachedRows([{ id: "gateway/model-a", alias: "shared" }]);
		const first = await reloadFromCache(modelsPath);
		expect(await first.resolveModelHeaders(first.find("my-provider", "gateway/model-a")!)).toMatchObject({
			"X-Account": "b-1",
		});

		// Second generation keeps A as a plain row and moves the alias to omitted
		// row B: A never runs the restore hook, so the projection must not hand it
		// B's header through the stale reverse alias either.
		seedCachedRows([
			{ id: "gateway/model-a", plain: true },
			{ id: "gateway/model-b", alias: "shared" },
		]);
		const second = await reloadFromCache(modelsPath);
		const a = second.find("my-provider", "gateway/model-a");
		expect(a).toBeDefined();
		expect(await second.resolveModelHeaders(a!)).toBeUndefined();
		const b = second.find("my-provider", "gateway/model-b");
		expect(b).toBeDefined();
		expect(await second.resolveModelHeaders(b!)).toMatchObject({ "X-Account": "b-1" });
	});
});
