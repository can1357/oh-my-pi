import { afterEach, describe, expect, test } from "bun:test";
import { AuthStorage, type StoredAuthCredential } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createSerializedRebuilder,
	gatewayRoutableModels,
	indexModelsByRequestId,
	refreshAuthGatewayModelIndex,
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
		expect(await clientAuthStorage.keys.get("anthropic")).toBe("gateway-token");

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
		expect(await gatewayAuthStorage.keys.get("anthropic")).not.toBe("gateway-token");
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

	test("serves judge-kind models alongside chat and keeps unrouted kinds out", async () => {
		using tempDir = TempDir.createSync("@omp-auth-gateway-catalog-");
		const registry = new ModelRegistry(await createAuthStorage(), tempDir.join("models.yml"));
		const routable = gatewayRoutableModels(registry);
		// `getAll()` alone is chat-only, which is what left `/v1/systemone` with
		// "Unknown model: jev-latest" for a credentialed TypeSafe account.
		expect(registry.getAll().some(model => model.provider === "typesafe")).toBe(false);

		const index = indexModelsByRequestId(routable, new Set(["typesafe", "local"]));

		expect(index.get("typesafe/jev-latest")?.api).toBe("typesafe");
		expect(index.get("jev-latest")?.provider).toBe("typesafe");
		// Tiny on-device models have no gateway route and are not advertised.
		expect([...index.values()].some(model => modelKind(model) === "tiny")).toBe(false);
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
});

test("catalog refresh includes newly credentialed providers and removes revoked providers", async () => {
	const model = getBundledModels("anthropic")[0]!;
	let credentials: StoredAuthCredential[] = [];
	let afterDiscovery: StoredAuthCredential[] = [];
	const storage: Pick<AuthStorage, "listStoredCredentials" | "reload"> = {
		listStoredCredentials: () => credentials,
		reload: async () => {
			credentials = afterDiscovery;
		},
	};
	const registry: Pick<ModelRegistry, "refresh" | "getAll"> = { refresh: async () => {}, getAll: () => [model] };
	expect((await refreshAuthGatewayModelIndex(registry, storage)).has(`${model.provider}/${model.id}`)).toBe(false);
	afterDiscovery = [
		{ id: 1, provider: model.provider, disabledCause: null, credential: { type: "api_key", key: "new-key" } },
	];
	expect((await refreshAuthGatewayModelIndex(registry, storage)).get(`${model.provider}/${model.id}`)).toEqual(model);
	afterDiscovery = [];
	expect((await refreshAuthGatewayModelIndex(registry, storage)).has(`${model.provider}/${model.id}`)).toBe(false);
});
