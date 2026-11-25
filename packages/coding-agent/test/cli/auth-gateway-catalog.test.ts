import { afterEach, describe, expect, test } from "bun:test";
import { type Api, AuthStorage, type Model } from "@oh-my-pi/pi-ai";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createSerializedRebuilder,
	gatewayRoutableModels,
	gatewayRoutableProviders,
	indexModelsByRequestId,
	resolveGatewayModel,
} from "../../src/cli/auth-gateway-cli";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { expandOnlineTinyModelFallbacks } from "../../src/tiny/online-candidates";

const authStores: AuthStorage[] = [];

async function createAuthStorage(): Promise<AuthStorage> {
	const storage = await AuthStorage.create(":memory:");
	authStores.push(storage);
	return storage;
}

afterEach(() => {
	for (const storage of authStores.splice(0)) storage.close();
});

test.each([
	["openrouter", "https://openrouter.ai/api/v1"],
	["relay", "https://relay.example/v1"],
	["relay", "https://ai-gateway.vercel.sh/v1"],
])("Decisions sends each upstream pin in order through %s at %s", async (provider, baseUrl) => {
	const bundled = getBundledModel("openrouter", "~typesafe/jev-latest");
	const model = buildModel<Api>({
		...bundled,
		provider,
		baseUrl,
		// Decisions never sends this chat routing field, even on a Vercel host.
		compat: { vercelGatewayRouting: { only: ["first"] } },
	});
	const selector = `${model.provider}/${model.id}`;
	const settings = Settings.isolated({
		"retry.fallbackChains": { [selector]: [`${selector}@first`, `${selector}@second`] },
	});
	const storage = await createAuthStorage();
	storage.keys.setRuntime(provider, "test-key");
	const providers: unknown[] = [];
	const router = createAuthGatewayRouter({
		storage,
		resolveModel: id => (id === selector ? model : undefined),
		fallbackModels: requested => expandOnlineTinyModelFallbacks(requested, settings, [model]).slice(1),
		fetch: async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as { provider?: { only: string[] } };
			providers.push(body.provider);
			return Response.json({
				model: model.id,
				// A missing answer gives the gateway a 502 until the second pin responds.
				answers: body.provider?.only[0] === "second" ? { ok: { type: "noul", noul: 1 } } : {},
				usage: { input_tokens: 1, output_tokens: 1 },
			});
		},
	});
	try {
		const body = JSON.stringify({
			model: selector,
			state: "hello",
			questions: { ok: { type: "noul", instructions: "Is this a greeting?" } },
		});
		const response = await router.route(
			new Request("http://gateway.test/alpha/decisions", {
				method: "POST",
				headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
				body,
			}),
			"test",
		);
		expect(providers).toEqual([undefined, { only: ["first"] }, { only: ["second"] }]);
		expect(response.status).toBe(200);
	} finally {
		router.close();
	}
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
		expect(resolveGatewayModel("anthropic/claude-opus-5-repro", index)?.id).toBe("claude-opus-5-repro");
		expect(resolveGatewayModel("claude-opus-5-repro", index)?.id).toBe("claude-opus-5-repro");
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
		const gatewayIndex = indexModelsByRequestId(gatewayRegistry.getAll(), new Set(["anthropic"]));
		expect(resolveGatewayModel(gatewayModel.id, gatewayIndex)).toBe(gatewayModel);
	});

	test("a pi-native provider override lists models only through the gateway", async () => {
		using tempDir = TempDir.createSync("@omp-pi-native-discovery-");
		const modelsPath = tempDir.join("models.yml");
		await Bun.write(
			modelsPath,
			[
				"providers:",
				"  google:",
				"    baseUrl: http://127.0.0.1:18899",
				"    apiKey: gateway-token",
				"    transport: pi-native",
				"",
			].join("\n"),
		);
		const requests: string[] = [];
		const registry = new ModelRegistry(await createAuthStorage(), modelsPath, {
			fetch: async input => {
				requests.push(String(input));
				return new Response("{}", { status: 404 });
			},
		});

		await registry.refreshProvider("google", "online");

		// The roster comes from the gateway's own catalog route; a provider-shaped
		// models listing would carry the gateway token to an endpoint that is
		// not the gateway's. A gateway without the route keeps the bundled roster.
		expect(requests).toEqual(["http://127.0.0.1:18899/v1/pi/models"]);
		expect(registry.find("google", "gemini-2.5-flash")?.transport).toBe("pi-native");
	});

	test("scopes the catalog to providers with credentials", async () => {
		using tempDir = TempDir.createSync("@omp-auth-gateway-catalog-");
		const registry = new ModelRegistry(await createAuthStorage(), tempDir.join("models.yml"));
		const all = registry.getAll();
		const anthropicModel = all.find(m => m.provider === "anthropic");
		const foreignModel = all.find(m => m.provider !== "anthropic");
		if (!anthropicModel || !foreignModel) throw new Error("expected mixed-provider bundled catalog");

		const index = indexModelsByRequestId(all, new Set(["anthropic"]));

		expect(resolveGatewayModel(`anthropic/${anthropicModel.id}`, index)).toBeDefined();
		expect(resolveGatewayModel(`${foreignModel.provider}/${foreignModel.id}`, index)).toBeUndefined();
	});

	test("drops providers disabled in settings from the served catalog", async () => {
		const storage = await createAuthStorage();
		await storage.credentials.set("anthropic", { type: "api_key", key: "sk-test-anthropic" });
		await storage.credentials.set("openrouter", { type: "api_key", key: "sk-test-openrouter" });
		const settings = Settings.isolated({ disabledProviders: ["openrouter"] });
		const registry = new ModelRegistry(storage, undefined, { ignoreLocalModelConfig: true, settings });

		const routable = gatewayRoutableProviders(storage, settings);
		const index = indexModelsByRequestId(gatewayRoutableModels(registry), routable);

		expect([...routable].sort()).toEqual(["anthropic"]);
		expect(index.models.some(model => model.provider === "openrouter")).toBe(false);
		expect(index.models.some(model => model.provider === "anthropic")).toBe(true);
	});

	test("serves judge-kind models alongside chat and keeps unrouted kinds out", async () => {
		using tempDir = TempDir.createSync("@omp-auth-gateway-catalog-");
		const registry = new ModelRegistry(await createAuthStorage(), tempDir.join("models.yml"));
		const routable = gatewayRoutableModels(registry);
		// `getAll()` alone is chat-only, which is what left `/v1/systemone` with
		// "Unknown model: jev-latest" for a credentialed TypeSafe account.
		expect(registry.getAll().some(model => model.provider === "typesafe")).toBe(false);

		const index = indexModelsByRequestId(routable, new Set(["typesafe", "local"]));

		expect(resolveGatewayModel("typesafe/jev-latest", index)?.api).toBe("typesafe");
		expect(resolveGatewayModel("jev-latest", index)?.provider).toBe("typesafe");
		// Tiny on-device models have no gateway route and are not advertised.
		expect(index.models.some(model => modelKind(model) === "tiny")).toBe(false);
	});
});

describe("resolveGatewayModel", () => {
	test("routes an OpenRouter variant selector the catalog does not list to its base model", async () => {
		const storage = await createAuthStorage();
		await storage.credentials.set("openrouter", { type: "api_key", key: "sk-test-openrouter" });
		await storage.credentials.set("anthropic", { type: "api_key", key: "sk-test-anthropic" });
		const settings = Settings.isolated({});
		const registry = new ModelRegistry(storage, undefined, { ignoreLocalModelConfig: true, settings });
		const index = indexModelsByRequestId(
			gatewayRoutableModels(registry),
			gatewayRoutableProviders(storage, settings),
		);
		const base = index.models.find(model => model.provider === "openrouter" && !model.id.includes(":"));
		const anthropic = index.models.find(model => model.provider === "anthropic");
		if (!base || !anthropic) throw new Error("expected bundled openrouter and anthropic models");

		// Previously "Unknown model: openrouter/<id>:floor" — the suffix must survive to the wire id.
		const floor = resolveGatewayModel(`openrouter/${base.id}:floor`, index);
		expect(floor?.provider).toBe("openrouter");
		expect(floor?.id).toBe(`${base.id}:floor`);
		expect(floor?.api).toBe(base.api);
		// Route suffixes are an OpenRouter concept; other providers stay exact-match.
		expect(resolveGatewayModel(`anthropic/${anthropic.id}:floor`, index)).toBeUndefined();
		expect(resolveGatewayModel("openrouter/no-such-vendor/no-such-model:floor", index)).toBeUndefined();
	});

	/** A served chat model, built through the catalog rules like discovery output. */
	function servedModel(provider: string, id: string, api: Api): Model<Api> {
		return buildModel({
			id,
			name: id,
			api,
			provider,
			baseUrl: "https://example.test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8192,
		});
	}

	// `cursor`, `snowflake` and `venice` are unranked by the built-in provider order; `anthropic` is native.
	const anthropic = servedModel("anthropic", "claude-x", "anthropic-messages");
	const cursor = servedModel("cursor", "claude-x", "cursor-agent");
	const snowflake = servedModel("snowflake", "claude-x", "anthropic-messages");
	const venice = servedModel("venice", "claude-x", "openai-completions");
	const catalog = [cursor, venice, snowflake, anthropic];
	const credentialed = new Set(catalog.map(model => model.provider));

	test("a bare id resolves to the highest-priority provider whatever order the catalog lists it in", () => {
		// A discovery refresh re-appends a provider's models at the catalog's end; a bare id
		// used to follow that order and land on whichever mirror stayed in front.
		for (const order of [catalog, [...catalog].reverse()]) {
			const index = indexModelsByRequestId(order, credentialed);
			expect(resolveGatewayModel("claude-x", index)).toBe(anthropic);
			// The route's wire never outranks provider priority.
			expect(resolveGatewayModel("claude-x", index, { api: "openai-completions" })).toBe(anthropic);
		}
	});

	test("the configured provider order outranks the built-in one", () => {
		const index = indexModelsByRequestId(catalog, credentialed, ["venice"]);
		expect(resolveGatewayModel("claude-x", index)).toBe(venice);
	});

	test("among equally ranked providers a bare id prefers the route's wire, then provider id", () => {
		const index = indexModelsByRequestId(catalog, credentialed);
		const unranked = { accepts: (model: Model<Api>) => model !== anthropic };
		expect(resolveGatewayModel("claude-x", index, unranked)).toBe(cursor);
		expect(resolveGatewayModel("claude-x", index, { ...unranked, api: "anthropic-messages" })).toBe(snowflake);
		expect(resolveGatewayModel("claude-x", index, { ...unranked, api: "openai-completions" })).toBe(venice);
	});

	test("a refused provider/id never resolves to another provider's bare id spelled the same way", () => {
		const aggregated = servedModel("openrouter", "anthropic/claude-x", "openai-completions");
		const index = indexModelsByRequestId([anthropic, aggregated], new Set(["anthropic", "openrouter"]));
		expect(resolveGatewayModel("anthropic/claude-x", index)).toBe(anthropic);
		expect(
			resolveGatewayModel("anthropic/claude-x", index, { accepts: model => model !== anthropic }),
		).toBeUndefined();
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
