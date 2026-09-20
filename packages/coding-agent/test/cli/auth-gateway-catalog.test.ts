import { afterEach, describe, expect, test } from "bun:test";
import { type Api, AuthStorage, type Model } from "@oh-my-pi/pi-ai";
import { RetryableModelResolutionError } from "@oh-my-pi/pi-ai/auth-gateway";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createGenerationSynchronizedModelResolver,
	createSerializedRebuilder,
	indexModelsByRequestId,
	initializeGatewayModelCatalog,
} from "../../src/cli/auth-gateway-cli";
import { ModelRegistry } from "../../src/config/model-registry";

const authStores: AuthStorage[] = [];

async function createAuthStorage(): Promise<AuthStorage> {
	const storage = await AuthStorage.create(":memory:");
	authStores.push(storage);
	return storage;
}

afterEach(() => {
	for (const storage of authStores.splice(0)) storage.close();
});

describe("indexModelsByRequestId (auth-gateway catalog)", () => {
	test("resolves a discovery-only model absent from the bundled catalog", async () => {
		using tempDir = TempDir.createSync("@omp-auth-gateway-catalog-");
		const registry = new ModelRegistry(await createAuthStorage(), tempDir.join("models.yml"));
		// Simulate a model reached via provider discovery but not compiled into
		// the bundle (e.g. a post-release id). registerProvider merges it into
		// getAll() exactly as runtime discovery does.
		registry.registerProvider("anthropic", {
			baseUrl: "https://api.anthropic.com",
			api: "anthropic-messages",
			apiKey: "test-key",
			models: [
				{
					id: "claude-opus-5-repro",
					name: "Claude Opus 5 (repro)",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200000,
					maxTokens: 8192,
				},
			],
		});
		expect(getBundledModels("anthropic").map(m => m.id)).not.toContain("claude-opus-5-repro");

		const index = indexModelsByRequestId(registry.getAll(), new Set(["anthropic"]));

		// The gateway can now resolve it by qualified id and bare id — was
		// "Unknown model" when the index was built from getBundledModels only.
		expect(index.get("anthropic/claude-opus-5-repro")?.id).toBe("claude-opus-5-repro");
		expect(index.get("claude-opus-5-repro")?.id).toBe("claude-opus-5-repro");
	});

	test("gateway registry ignores local models.yml credential and routing overrides", async () => {
		using tempDir = TempDir.createSync("@omp-auth-gateway-catalog-");
		const modelsPath = tempDir.join("models.yml");
		// anthropic: a plain credential/baseUrl override (no transport) — the
		// reviewer's leak. openai: a pi-native gateway route — the self-routing loop.
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  anthropic:",
				"    baseUrl: http://127.0.0.1:18899",
				"    apiKey: gateway-token",
				"  openai:",
				"    baseUrl: http://127.0.0.1:18899",
				"    apiKey: gateway-token",
				"    transport: pi-native",
				"",
			].join("\n"),
		);

		// A normal client registry applies the local overrides and installs the
		// config API keys into AuthStorage.
		const clientAuthStorage = await createAuthStorage();
		const clientRegistry = new ModelRegistry(clientAuthStorage, modelsPath);
		expect(clientRegistry.find("anthropic", "claude-sonnet-4-5")?.baseUrl).toBe("http://127.0.0.1:18899");
		expect(clientRegistry.getAll().find(model => model.provider === "openai")?.transport).toBe("pi-native");
		expect(await clientAuthStorage.getApiKey("anthropic")).toBe("gateway-token");

		// The gateway registry ignores models.yml entirely: bundled routing wins,
		// no config key reaches AuthStorage, and no pi-native self-route survives.
		const gatewayAuthStorage = await createAuthStorage();
		const gatewayRegistry = new ModelRegistry(gatewayAuthStorage, modelsPath, {
			ignoreLocalModelConfig: true,
		});
		const gatewayModel = gatewayRegistry.find("anthropic", "claude-sonnet-4-5");
		const bundledModel = getBundledModels("anthropic").find(model => model.id === "claude-sonnet-4-5");
		if (!gatewayModel || !bundledModel) throw new Error("expected bundled Anthropic model");

		expect(gatewayModel.baseUrl).toBe(bundledModel.baseUrl);
		expect(gatewayModel.transport).toBeUndefined();
		expect(await gatewayAuthStorage.getApiKey("anthropic")).not.toBe("gateway-token");
		expect(gatewayRegistry.getAll().find(model => model.provider === "openai")?.transport).toBeUndefined();
		expect(indexModelsByRequestId(gatewayRegistry.getAll(), new Set(["anthropic"])).get(gatewayModel.id)).toBe(
			gatewayModel,
		);
	});

	test("scopes the catalog to providers with credentials", async () => {
		using tempDir = TempDir.createSync("@omp-auth-gateway-catalog-");
		const registry = new ModelRegistry(await createAuthStorage(), tempDir.join("models.yml"));
		const all = registry.getAll();
		const anthropicModel = all.find(m => m.provider === "anthropic");
		const foreignModel = all.find(m => m.provider !== "anthropic");
		if (!anthropicModel || !foreignModel) throw new Error("expected mixed-provider bundled catalog");

		const index = indexModelsByRequestId(all, new Set(["anthropic"]));

		expect(index.get(`anthropic/${anthropicModel.id}`)).toBeDefined();
		expect(index.get(`${foreignModel.provider}/${foreignModel.id}`)).toBeUndefined();
	});

	test("resolves unique native aliases only as qualified, case-insensitive request ids", () => {
		const model = buildModel({
			id: "grok-4.6-fast",
			aliases: [" LaTeSt "],
			name: "Grok 4.6 Fast",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		});

		const index = indexModelsByRequestId([model], new Set(["grokbot"]));

		expect(index.get("grokbot/latest")).toBe(model);
		expect(index.get("latest")).toBeUndefined();
	});

	test("rejects a bare canonical id shared by eligible providers", () => {
		const first = buildModel({
			id: "GroK-4.6-Fast",
			name: "Grok 4.6 Fast",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		const second = { ...first, provider: "other" };
		const index = indexModelsByRequestId([first, second], new Set(["grokbot", "other"]));

		expect(index.get("grok-4.6-fast")).toBeUndefined();
		expect(index.get("grokbot/grok-4.6-fast")).toBe(first);
		expect(index.get("other/grok-4.6-fast")).toBe(second);
	});

	test("omits colliding qualified aliases but keeps a canonical id ahead of an alias", () => {
		const model = (id: string, aliases: readonly string[] = []): Model<Api> =>
			buildModel({
				id,
				aliases,
				name: id,
				api: "grokbot-sand",
				provider: "grokbot",
				baseUrl: "https://api2.cursor.sh",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 64_000,
			});
		const first = model("grok-4.6", ["latest"]);
		const second = model("grok-4.6-fast", ["LATEST"]);
		const canonical = model("stable");
		const alias = model("grok-4.6-pro", ["STABLE"]);

		const index = indexModelsByRequestId([first, second, canonical, alias], new Set(["grokbot"]));

		expect(index.get("grokbot/latest")).toBeUndefined();
		expect(index.get("grokbot/stable")).toBe(canonical);
	});
});

describe("createGenerationSynchronizedModelResolver", () => {
	test("does not rebuild until the AuthStorage generation changes", async () => {
		let storageGeneration = 7;
		let catalogGeneration = 7;
		const calls: boolean[] = [];
		const resolveModel = createGenerationSynchronizedModelResolver(
			() => storageGeneration,
			() => catalogGeneration,
			async force => {
				calls.push(force ?? false);
				catalogGeneration = storageGeneration;
			},
			() => undefined,
		);

		await resolveModel("grok-4.6");
		expect(calls).toEqual([]);

		storageGeneration = 8;
		await resolveModel("grok-4.6");
		expect(calls).toEqual([true]);
	});

	test("does not accept a catalog generation superseded during a rebuild", async () => {
		let storageGeneration = 2;
		let catalogGeneration = 1;
		const calls: boolean[] = [];
		const firstRebuild = Promise.withResolvers<void>();
		const resolveModel = createGenerationSynchronizedModelResolver(
			() => storageGeneration,
			() => catalogGeneration,
			async force => {
				calls.push(force ?? false);
				if (calls.length === 1) {
					await firstRebuild.promise;
					catalogGeneration = 2;
					return;
				}
				catalogGeneration = storageGeneration;
			},
			() => undefined,
		);

		const resolving = resolveModel("grok-4.6");
		storageGeneration = 3;
		firstRebuild.resolve();

		await resolving;
		expect(calls).toEqual([true, true]);
	});

	test("rejects repeated catalog supersession with a retryable error", async () => {
		let storageGeneration = 1;
		let catalogGeneration = 0;
		let rebuilds = 0;
		const resolveModel = createGenerationSynchronizedModelResolver(
			() => storageGeneration,
			() => catalogGeneration,
			async () => {
				rebuilds++;
				catalogGeneration = storageGeneration;
				storageGeneration++;
			},
			() => undefined,
		);

		const error = await resolveModel("grok-4.6").catch(error => error);
		expect(error).toBeInstanceOf(RetryableModelResolutionError);
		expect(error).toMatchObject({ status: 503, retryable: true });
		expect(rebuilds).toBe(3);
	});
});

describe("initializeGatewayModelCatalog", () => {
	test("hydrates an exact credential-scoped cache before the initial cache-aware refresh", async () => {
		const cachedModel = buildModel({
			id: "expired-grok-cache-model",
			name: "Expired Grok cache model",
			api: "grokbot-sand",
			provider: "grokbot",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
		const events: string[] = [];
		let models: Model<Api>[] = [];
		let networkFetches = 0;
		const storage = {
			getGeneration: () => 1,
			exportSnapshot: () => ({ credentials: [{ provider: "grokbot" }] }),
		} as unknown as Pick<AuthStorage, "exportSnapshot" | "getGeneration">;
		const registry = {
			hydrateCredentialScopedModelCaches: async () => {
				events.push("hydrate");
				models = [cachedModel];
			},
			refresh: async (strategy: string) => {
				events.push(`refresh:${strategy}`);
				if (strategy === "online-if-uncached" && !models.includes(cachedModel)) networkFetches++;
			},
			getAll: () => models,
		} as unknown as Pick<ModelRegistry, "getAll" | "hydrateCredentialScopedModelCaches" | "refresh">;

		const catalog = await initializeGatewayModelCatalog(storage, registry);

		expect(events).toEqual(["hydrate", "refresh:online-if-uncached"]);
		expect(networkFetches).toBe(0);
		expect(await catalog.resolveModel("grokbot/expired-grok-cache-model")).toBe(cachedModel);
	});
});

describe("createSerializedRebuilder", () => {
	// Deferred `run` gate so tests drive completion without wall-clock timers.
	function makeRun() {
		const calls: boolean[] = [];
		const gates: PromiseWithResolvers<void>[] = [];
		const run = (force: boolean): Promise<void> => {
			calls.push(force);
			const gate = Promise.withResolvers<void>();
			gates.push(gate);
			return gate.promise;
		};
		return { calls, gates, run };
	}
	// Flush queued microtasks so a resolved gate lets the serialized loop advance.
	async function flush(): Promise<void> {
		for (let i = 0; i < 8; i++) await Promise.resolve();
	}

	test("runs a forced pass when a forced rebuild is requested mid-flight", async () => {
		const { calls, gates, run } = makeRun();
		const rebuild = createSerializedRebuilder(run);

		const first = rebuild(false);
		expect(calls).toEqual([false]);

		// A credential-triggered forced rebuild arrives while the cached pass runs.
		rebuild(true);
		expect(calls).toEqual([false]); // coalesced, not started yet

		gates[0].resolve();
		await flush();
		// The forced follow-up pass must run so the account change is not missed.
		expect(calls).toEqual([false, true]);

		gates[1].resolve();
		await first;
		expect(calls).toEqual([false, true]);
	});

	test("runs a queued forced rebuild after a cached rebuild fails", async () => {
		const { calls, gates, run } = makeRun();
		const rebuild = createSerializedRebuilder(run);

		const initial = rebuild(false);
		const initialFailure = initial.catch(error => error);
		const forced = rebuild(true);
		gates[0].reject(new Error("cached rebuild failed"));
		await flush();
		expect(calls).toEqual([false, true]);

		gates[1].resolve();
		expect(await initialFailure).toBeInstanceOf(Error);
		await forced;
	});

	test("coalesces a non-forced rebuild without an extra pass", async () => {
		const { calls, gates, run } = makeRun();
		const rebuild = createSerializedRebuilder(run);

		const first = rebuild(false);
		rebuild(false); // coalesces onto the in-flight pass
		expect(calls).toEqual([false]);

		gates[0].resolve();
		await first;
		expect(calls).toEqual([false]); // no redundant follow-up
	});

	test("runs and settles a forced pass queued during finalization", async () => {
		const { calls, gates, run } = makeRun();
		const rebuild = createSerializedRebuilder(run);
		const initial = rebuild(false);
		let forced: Promise<void> | undefined;
		let forcedSettled = false;

		gates[0].resolve();
		// The queued microtask runs after the inner loop completes but before
		// its `.finally()` clears `inFlight`.
		queueMicrotask(() => {
			forced = rebuild(true);
			void forced.then(() => {
				forcedSettled = true;
			});
		});
		await flush();
		expect(calls).toEqual([false, true]);

		gates[1].resolve();
		await initial;
		await flush();
		expect(forcedSettled).toBe(true);
	});
});
