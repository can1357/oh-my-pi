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
import { computeHeaderConfigFingerprint } from "../src/config/custom-models";
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
		options?: { headerConfigFingerprint?: string },
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
			[],
			undefined,
			options?.headerConfigFingerprint,
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

	test("reserves reviewed extra aliases for their live owners", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      grok-4.5:", "        headers:", "          X-Account: live-1"].join("\n"),
			"cursor",
		);
		// The stale cache row records the reviewed extra alias of the bundled
		// cursor-grok-4.5 family; the override belongs to that bundled owner.
		seedCachedRows([{ id: "stale-row", alias: "grok-4.5" }], "cursor");

		const registry = await reloadFromCache(modelsPath);
		expect(registry.find("cursor", "stale-row")).toBeUndefined();
		const owner = registry.find("cursor", "cursor-grok-4.5");
		expect(owner).toBeDefined();
		expect(await registry.resolveModelHeaders(owner!)).toMatchObject({ "X-Account": "live-1" });
	});

	test("scopes alias owners by provider", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      gemini-3.5-flash-low:", "        headers:", "          X-Account: a-1"].join(
				"\n",
			),
			"google-antigravity",
		);

		// gemini-3-flash and gemini-3.5-flash both record the raw member id
		// gemini-3.5-flash-low: both are current owners and must rebind the
		// alias-keyed headers instead of the catalog-ordered first claimant
		// suppressing the other. Providers reusing a raw id must not collide
		// either, which the provider-scoped owner map enforces.
		const registry = await reloadFromCache(modelsPath);
		const first = registry.find("google-antigravity", "gemini-3-flash");
		expect(first).toBeDefined();
		expect(await registry.resolveModelHeaders(first!)).toMatchObject({ "X-Account": "a-1" });
		const second = registry.find("google-antigravity", "gemini-3.5-flash");
		expect(second).toBeDefined();
		expect(await registry.resolveModelHeaders(second!)).toMatchObject({ "X-Account": "a-1" });
	});

	test("drops cached rows whose header config changed since the write", async () => {
		const modelsPath = await writeModelsYaml(["    headers:", "      X-Provider: p-1"].join("\n"), "github-copilot");
		// The cache was written when more local sources composed the omitted
		// headers; with the stored fingerprint no longer matching the current
		// config the complete source set cannot be proven, so the bundled
		// fallback must win over a partially rebuilt row.
		seedCachedRows([{ id: "claude-haiku-4.5" }], "github-copilot", { headerConfigFingerprint: "stale" });
		const stale = await reloadFromCache(modelsPath);
		// The bundled fallback wins: its constant transport headers serve the
		// model without the configured layer that cannot be proven complete.
		const staleRow = stale.find("github-copilot", "claude-haiku-4.5");
		expect(staleRow).toBeDefined();
		// The bundled fallback serves the model: only its metadata is published.
		const bundled = (getBundledModels("github-copilot") as ReadonlyArray<{ id: string; name: string }>).find(
			model => model.id === "claude-haiku-4.5",
		);
		expect(staleRow!.name).toBe(bundled!.name);

		// A matching fingerprint proves the current sources compose the omitted
		// set, so the row restores with its configured headers.
		seedCachedRows([{ id: "claude-haiku-4.5" }], "github-copilot", {
			headerConfigFingerprint: computeHeaderConfigFingerprint(
				{ headers: { "X-Provider": "p-1" }, apiKey: "present" },
				new Map(),
			),
		});
		const matched = await reloadFromCache(modelsPath);
		const restored = matched.find("github-copilot", "claude-haiku-4.5");
		// The cached row itself is published with its configured headers.
		expect(restored!.name).toBe("claude-haiku-4.5");
		expect(await matched.resolveModelHeaders(restored!)).toMatchObject({ "X-Provider": "p-1" });
	});

	test("keeps rejected cache aliases out of the selector index", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      gateway/model-b:", "        headers:", "          X-Account: b-1"].join("\n"),
		);
		// First generation: a stale omitted row records the alias but has no
		// current header source and is rejected on read.
		seedCachedRows([{ id: "gateway/model-a", alias: "shared" }]);
		await reloadFromCache(modelsPath);
		// Second generation (refetch): A is a plain row and B owns the alias. The
		// rejected row's mapping must not survive in the global selector index,
		// or `my-provider/shared` selects the wrong live model.
		seedCachedRows([
			{ id: "gateway/model-a", plain: true },
			{ id: "gateway/model-b", alias: "shared" },
		]);
		const registry = await reloadFromCache(modelsPath);
		expect(registry.find("my-provider", "gateway/model-a")).toBeDefined();
		expect(resolveSessionModelSelector(registry, "my-provider/shared")?.model).toMatchObject({
			id: "gateway/model-b",
		});
	});

	test("lets rows sharing a member id each restore it", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      shared-raw:", "        headers:", "          X-Account: s-1"].join("\n"),
		);
		seedCachedRows([
			{ id: "gateway/one", alias: "shared-raw" },
			{ id: "gateway/two", alias: "shared-raw" },
		]);
		const registry = await reloadFromCache(modelsPath);
		for (const id of ["gateway/one", "gateway/two"]) {
			const row = registry.find("my-provider", id);
			expect(row).toBeDefined();
			expect(await registry.resolveModelHeaders(row!)).toMatchObject({ "X-Account": "s-1" });
		}
	});

	test("keeps raw header values out of the persisted fingerprint", () => {
		const digest = computeHeaderConfigFingerprint(
			{ headers: { Authorization: "Bearer top-secret-value" }, apiKey: "present" },
			new Map([["model-a", { headers: { "X-Account": "acct-secret-9" } }]]),
		);
		expect(digest).not.toContain("secret");
		expect(digest.length).toBe(64);
	});

	test("persists the fingerprint on configured discovery refreshes", async () => {
		const configA = await writeModelsYaml(
			["    modelOverrides:", "      claude-haiku-4.5:", "        headers:", "          X-Local: loc-1"].join("\n"),
			"github-copilot",
		);
		const online = await newRegistry(configA, mockDiscovery(["claude-haiku-4.5"]));
		await online.refreshDiscoverableProviders(["github-copilot"], "online");
		const onlineRow = online.find("github-copilot", "claude-haiku-4.5");
		expect(onlineRow).toBeDefined();

		// The model-level source is removed from the config after the write; the
		// refreshed cache carries a fingerprint, so the offline read must drop the
		// discovered row instead of keeping it with partial headers.
		const configB = await writeModelsYaml(["    headers:", "      X-Provider: p-1"].join("\n"), "github-copilot");
		const offline = await reloadFromCache(configB);
		const bundled = (getBundledModels("github-copilot") as ReadonlyArray<{ id: string; api: string }>).find(
			model => model.id === "claude-haiku-4.5",
		)!;
		expect(offline.find("github-copilot", "claude-haiku-4.5")!.api).toBe(bundled.api);
		expect(onlineRow!.api).not.toBe(bundled.api);
	});

	test("preserves live alias owners during cache replay", async () => {
		const modelsPath = await writeModelsYaml("", "cursor");
		seedCachedRows([{ id: "stale-row", alias: "claude-4-sonnet-thinking", plain: true }], "cursor");

		const registry = await reloadFromCache(modelsPath);
		expect(registry.find("cursor", "stale-row")).toBeDefined();
		expect(resolveSessionModelSelector(registry, "cursor/claude-4-sonnet-thinking")?.model).toMatchObject({
			id: "claude-4-sonnet",
		});
	});

	test("normalizes alias casing when ownership moves", async () => {
		const modelsPath = await writeModelsYaml(
			[
				"    modelOverrides:",
				"      Shared:",
				"        headers:",
				"          X-Account: a-1",
				"      gateway/model-b:",
				"        headers:",
				"          X-B: b-1",
			].join("\n"),
		);
		// First generation registers Shared -> gateway/model-a.
		seedCachedRows([{ id: "gateway/model-a", alias: "Shared" }]);
		const first = await reloadFromCache(modelsPath);
		expect(await first.resolveModelHeaders(first.find("my-provider", "gateway/model-a")!)).toMatchObject({
			"X-Account": "a-1",
		});

		// Second generation moves the alias to B under different casing: A keeps
		// neither the alias nor its old override binding even though B itself
		// restores through its direct source.
		seedCachedRows([
			{ id: "gateway/model-a", plain: true },
			{ id: "gateway/model-b", alias: "shared" },
		]);
		const second = await reloadFromCache(modelsPath);
		expect(await second.resolveModelHeaders(second.find("my-provider", "gateway/model-b")!)).toMatchObject({
			"X-B": "b-1",
		});
		expect(await second.resolveModelHeaders(second.find("my-provider", "gateway/model-a")!)).toBeUndefined();
	});

	test("canonicalizes header ordering in the fingerprint", () => {
		const first = computeHeaderConfigFingerprint(
			{ headers: { "X-One": "1", "X-Two": "2" } },
			new Map([["m", { headers: { "X-A": "a", "X-B": "b" } }]]),
		);
		const reordered = computeHeaderConfigFingerprint(
			{ headers: { "X-Two": "2", "X-One": "1" } },
			new Map([["m", { headers: { "X-B": "b", "X-A": "a" } }]]),
		);
		expect(first).toBe(reordered);
	});

	test("keeps first-owner semantics within a cache replay batch", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      t27-raw:", "        headers:", "          X-Account: s-1"].join("\n"),
		);
		seedCachedRows([
			{ id: "gateway/first", alias: "t27-raw" },
			{ id: "gateway/second", alias: "t27-raw" },
		]);
		const registry = await reloadFromCache(modelsPath);
		expect(registry.find("my-provider", "gateway/first")).toBeDefined();
		expect(resolveSessionModelSelector(registry, "my-provider/t27-raw")?.model).toMatchObject({
			id: "gateway/first",
		});
	});

	test("rejects stale aliases with no current owner", async () => {
		const modelsPath = await writeModelsYaml(
			["    modelOverrides:", "      shared:", "        headers:", "          X-Account: a-1"].join("\n"),
		);
		// First generation registers shared -> gateway/model-a.
		seedCachedRows([{ id: "gateway/model-a", alias: "shared" }]);
		await reloadFromCache(modelsPath);

		// Second generation drops the routing alias entirely: no current row owns
		// it, so the stale reverse entry must not rebind the old override.
		seedCachedRows([{ id: "gateway/model-a", plain: true }]);
		const second = await reloadFromCache(modelsPath);
		expect(await second.resolveModelHeaders(second.find("my-provider", "gateway/model-a")!)).toBeUndefined();
	});

	test("restores cached headers on the unauthenticated path", async () => {
		// No resolvable credential: the configured-discovery refresh takes the
		// unauthenticated branch, which must still run the cached cohort through
		// the fingerprint-aware restorer instead of republishing raw rows.
		const modelsPath = path.join(tempDir, "models.yml");
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  no-key:",
				`    baseUrl: ${baseUrl}`,
				"    api: openai-completions",
				"    discovery:",
				"      type: openai-models-list",
				"    modelOverrides:",
				"      row:",
				"        headers:",
				"          X-Account: a-1",
			].join("\n"),
		);
		const findWithFingerprint = async (fingerprint: string) => {
			seedCachedRows([{ id: "row" }], "no-key", { headerConfigFingerprint: fingerprint });
			const registry = await newRegistry(modelsPath, mockDiscovery(["row"]));
			await registry.refreshDiscoverableProviders(["no-key"], "online");
			return { registry, row: registry.find("no-key", "row") };
		};

		// Mismatched provenance: the row cannot be proven complete and must not
		// be selectable with its account/routing header missing.
		const stale = await findWithFingerprint("stale");
		expect(stale.row).toBeUndefined();

		// Matching provenance: the cohort restores with its configured headers.
		const matched = await findWithFingerprint(
			computeHeaderConfigFingerprint(undefined, new Map([["row", { headers: { "X-Account": "a-1" } }]])),
		);
		expect(matched.row).toBeDefined();
		expect(await matched.registry.resolveModelHeaders(matched.row!)).toMatchObject({ "X-Account": "a-1" });
	});
});
