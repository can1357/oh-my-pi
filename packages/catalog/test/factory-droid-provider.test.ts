import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "../src/build";
import { quotaTierFor } from "../src/compat/behavior";
import {
	type FactoryDroidModelPolicy,
	type FactoryDroidRegistryModel,
	factoryDroidRegistry,
	resolveFactoryDroidPolicy,
	resolveFactoryDroidRotation,
} from "../src/compat/factory-droid";
import { resolveModelPolicy } from "../src/compat/resolve";
import rules from "../src/compat/rules.json";
import { serverSideFallbackModels } from "../src/compat/server-side-fallback";
import {
	buildFactoryDroidModel,
	type FactoryDroidModelDiscoveryOptions,
	fetchFactoryDroidModels,
} from "../src/discovery/factory-droid";
import { Effort } from "../src/effort";
import { resolveProviderModels } from "../src/model-manager";
import { getBundledModel } from "../src/models";
import { resolveModelCacheProviderId } from "../src/provider-models/cache-provider-id";
import { factoryDroidModelManagerOptions } from "../src/provider-models/special";
import type { FetchImpl, ModelSpec } from "../src/types";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const ALL_FLAGS_ON = Object.fromEntries(
	factoryDroidRegistry().flatMap(({ policy }) =>
		policy.entitlement.featureFlag ? [[policy.entitlement.featureFlag, true]] : [],
	),
);

/** A registry model from `rules/providers/factory-droid.kdl`. */
function registryModel(id: string): FactoryDroidRegistryModel {
	const found = factoryDroidRegistry().find(model => model.spec.id === id);
	if (!found) throw new Error(`no registry model ${id}`);
	return found;
}

/** Subject ids chosen by registry predicate, so bumps keep the branches covered. */
function firstModel(predicate: (gates: FactoryDroidModelPolicy["entitlement"]) => boolean): string {
	const found = factoryDroidRegistry().find(model => predicate(model.policy.entitlement));
	if (!found) throw new Error("no registry model matches the predicate");
	return found.spec.id;
}
const PLAIN = firstModel(m => !m.featureFlag && !m.requiresExplicitOptIn && !m.deprecationFlag && !m.baseVariant);
const FLAGGED = firstModel(m => !!m.featureFlag && !m.requiresExplicitOptIn && !m.deprecationFlag && !m.baseVariant);
const OPT_IN = firstModel(m => !!m.requiresExplicitOptIn && !m.featureFlag);
const DEPRECATED = firstModel(m => !!m.deprecationFlag);
const DEPRECATION_FLAG = registryModel(DEPRECATED).policy.entitlement.deprecationFlag!;

interface FactoryEndpoints {
	flags?: Record<string, boolean>;
	modelPolicy?: Record<string, unknown>;
	routing?: Record<string, unknown>;
	responseHeaders?: Record<string, string>;
	onRequest?: (url: string, init: RequestInit | undefined) => void;
}

/** Fake of Factory's two discovery endpoints: feature flags (+ live routing) and managed settings. */
function factoryEndpoints(endpoints: FactoryEndpoints = {}): FetchImpl {
	return async (url, init) => {
		endpoints.onRequest?.(String(url), init);
		const body = String(url).includes("feature-flags")
			? {
					flags: endpoints.flags ?? ALL_FLAGS_ON,
					...(endpoints.routing ? { configs: { provider_routing: endpoints.routing } } : {}),
				}
			: { settings: endpoints.modelPolicy ? { modelPolicy: endpoints.modelPolicy } : {} };
		return Response.json(body, { headers: endpoints.responseHeaders });
	};
}

function discover(endpoints: FactoryEndpoints = {}, scope: FactoryDroidModelDiscoveryOptions = {}) {
	return fetchFactoryDroidModels({ apiKey: "token", ...scope, fetch: factoryEndpoints(endpoints) });
}

async function discoverIds(endpoints: FactoryEndpoints): Promise<string[]> {
	return (await discover(endpoints))?.map(model => model.id) ?? [];
}

function factoryToken(org: string, user: string, exp: number, jti: string): string {
	const payload = Buffer.from(JSON.stringify({ external_org_id: org, sub: user, exp, jti })).toString("base64url");
	return `header.${payload}.signature`;
}

/** A registry-shaped model for builder branches, independent of the live roster. */
function syntheticModel(policy: Partial<FactoryDroidModelPolicy>): FactoryDroidRegistryModel {
	const spec: ModelSpec<"factory-droid-agent"> = {
		id: "test-model",
		name: "Test model",
		api: "factory-droid-agent",
		provider: "factory-droid",
		baseUrl: "https://api.factory.ai",
		reasoning: true,
		input: ["text", "image"],
		cost: zeroCost,
		contextWindow: 100_000,
		maxTokens: 10_000,
	};
	return {
		spec,
		policy: {
			wire: "openai-completions",
			rotation: ["baseten"],
			regionUpstreams: { global: ["baseten"], us: ["baseten"], eu: [] },
			limits: { contextWindow: 100_000, maxTokens: 10_000 },
			euLimits: {},
			routingFamily: "factory",
			policyAliases: [],
			entitlement: { requiresExplicitOptIn: false },
			defaultReasoningOff: false,
			...policy,
		},
	};
}

describe("Factory Droid model builder", () => {
	it.each([
		{
			label: "strips the off rung while preserving a selectable default",
			id: "kimi-k3",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.High, Effort.Max],
				requiresEffort: false,
				defaultLevel: Effort.High,
			},
			modalities: ["text", "image"],
		},
		{
			label: "forces effort when off is unsupported and marks text-only models",
			id: "qwen3.8-max",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.XHigh],
				requiresEffort: true,
				defaultLevel: Effort.XHigh,
			},
			modalities: ["text"],
		},
		{
			label: "leaves an off-by-default model without a selectable default",
			id: "claude-haiku-4-5-20251001",
			thinking: {
				mode: "budget",
				efforts: [Effort.Low, Effort.Medium, Effort.High],
				supportsDisplay: false,
				requiresEffort: false,
			},
			modalities: ["text", "image"],
		},
	])("$label", ({ id, thinking, modalities }) => {
		const model = buildFactoryDroidModel(registryModel(id));
		expect(model.thinking).toEqual(thinking);
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual([...modalities]);
	});

	it("omits thinking for models without a reviewed effort ladder", () => {
		const model = buildFactoryDroidModel(syntheticModel({}));
		expect(model.thinking).toBeUndefined();
		expect(model.reasoning).toBe(false);
	});

	it("prices from the referenced catalog entry and carries the base credit rate", () => {
		const ref = { provider: "anthropic", modelId: "claude-opus-5" } as const;
		const referenced = buildFactoryDroidModel(
			syntheticModel({ listPriceFrom: ref, creditRates: { input: 1.6, output: 5 } }),
		);
		expect(referenced.cost).toEqual(getBundledModel(ref.provider, ref.modelId).cost);
		expect(referenced.factoryDroidCredits).toBe(1.6);

		// Factory-only SKUs have no list price; a zero credit rate survives.
		const unreferenced = buildFactoryDroidModel(syntheticModel({ creditRates: { input: 0 } }));
		expect(unreferenced.cost).toEqual(zeroCost);
		expect(unreferenced.factoryDroidCredits).toBe(0);
		expect(buildFactoryDroidModel(syntheticModel({})).factoryDroidCredits).toBeUndefined();
		// A reference to a provider without bundled rows keeps the zero cost.
		const unknown = buildFactoryDroidModel(syntheticModel({ listPriceFrom: { provider: "nope", modelId: "x" } }));
		expect(unknown.cost).toEqual(zeroCost);
	});

	it("builds Haiku 5.5 with an Off rung and Anthropic's list price on the Standard pool", () => {
		const model = buildFactoryDroidModel(registryModel("claude-haiku-5-5"));
		expect(model.thinking).toMatchObject({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			requiresEffort: false,
			defaultLevel: Effort.Medium,
		});
		expect(model.cost).toEqual(getBundledModel("anthropic", "claude-haiku-5-5").cost);
		expect(quotaTierFor("factory-droid", "claude-haiku-5-5")).toBe("standard");
	});

	it("builds Mistral Large 4 on the Core pool without borrowing the lower Mistral list price", () => {
		const model = buildFactoryDroidModel(registryModel("mistral-large-4"));
		expect(model.thinking).toMatchObject({ efforts: [Effort.High], requiresEffort: false });
		expect(model.cost).toEqual(zeroCost);
		expect(quotaTierFor("factory-droid", "mistral-large-4")).toBe("core");
	});
});

describe("Factory Droid route policy scoping", () => {
	it("gives every registry completions route a reasoning dialect", () => {
		const bare = factoryDroidRegistry()
			.filter(({ policy }) => policy.wire === "openai-completions")
			.flatMap(model =>
				model.policy.rotation.flatMap(upstream => {
					const spec = { ...buildFactoryDroidModel(model), api: "openai-completions" as const };
					const mode = resolveModelPolicy(spec, { upstream }).request.completionsReasoningMode;
					return mode === "none" ? [`${model.spec.id}@${upstream}`] : [];
				}),
			);
		expect(bare).toEqual([]);
	});

	it("keeps Factory route contracts off missing upstreams, direct hosts and session-level settings", () => {
		const completions = (id: string, provider = "factory-droid") => ({
			...buildFactoryDroidModel(registryModel(id)),
			api: "openai-completions" as const,
			provider,
		});
		expect(resolveModelPolicy(completions("kimi-k3")).request.completionsReasoningMode).toBe("none");
		expect(
			resolveModelPolicy(completions("minimax-m3", "fireworks"), { upstream: "fireworks" }).request
				.completionsReasoningMode,
		).toBeUndefined();
		expect(
			resolveModelPolicy(completions("glm-5.2", "mistral"), { upstream: "mistral" }).request
				.completionsReasoningMode,
		).toBeUndefined();

		const fable = buildFactoryDroidModel(registryModel("claude-fable-5.1"));
		const messages = { ...fable, api: "anthropic-messages" as const };
		// Refusal fallbacks ride only the first-party Anthropic upstream, never the user-facing setting.
		expect(
			resolveModelPolicy(messages, { upstream: "bedrock_anthropic" }).catalog.serverSideFallbackModels,
		).toBeUndefined();
		expect(serverSideFallbackModels(buildModel(fable))).toEqual([]);
		// Direct Anthropic keeps its own thinking contract.
		const direct = resolveModelPolicy({ ...messages, provider: "anthropic" }, { upstream: "snowflake" }).compat;
		expect(direct?.stripThinkingHistory).toBeUndefined();
		expect(direct?.disabledThinking).toBeUndefined();
		expect(direct?.effortBeta).toBeUndefined();
	});
});

describe("Factory Droid offline seed", () => {
	it("hides feature-gated and consent-gated models until live flags load", () => {
		const ids = (factoryDroidModelManagerOptions().staticModels ?? []).map(model => model.id);
		for (const gated of factoryDroidRegistry().filter(
			({ policy }) => policy.entitlement.featureFlag || policy.entitlement.requiresExplicitOptIn,
		)) {
			expect(ids).not.toContain(gated.spec.id);
		}
		expect(ids).toContain(PLAIN);
	});

	it("keeps offline EU models on the EU host with EU rotations", () => {
		const models = factoryDroidModelManagerOptions({ region: "eu" }).staticModels ?? [];
		expect(models.some(model => model.id === "kimi-k3")).toBe(false);
		const opus = models.find(model => model.id === "claude-opus-5");
		expect(opus?.baseUrl).toBe("https://api.eu.factory.ai/api/llm/a");
		expect(opus?.factoryDroidApiProviders).toEqual(["vertex_anthropic", "bedrock_anthropic"]);
	});
});

describe("Factory Droid registry consistency", () => {
	// A roster id is authored in three KDL places: the seed row, its per-model
	// registry block, and the api-routes/quota-tiers behavior rules. A drifted
	// id silently rides chat completions or bills from an unknown pool.
	const seedIds = factoryDroidRegistry().map(({ spec }) => spec.id);
	const routes = rules.behavior.apiRoutes
		.filter(rule => rule.provider === "factory-droid")
		.flatMap(rule => rule.routes);
	const tiers = rules.behavior.quotaTiers
		.filter(rule => rule.provider === "factory-droid")
		.flatMap(rule => rule.tiers);
	const registryBlocks = rules.cascade.rules.filter(
		rule => rule.providers?.includes("factory-droid") && rule.catalog?.upstreamRotation !== undefined,
	);
	const exactIds = (selectors: readonly { kind: string; value: string }[] | undefined) =>
		(selectors ?? []).flatMap(selector => (selector.kind === "exact" ? [selector.value] : []));

	it("routes, bills and registers every roster model exactly once", () => {
		for (const id of seedIds) {
			const routed = routes.filter(route => route.match.exact?.includes(id));
			expect({ id, routes: routed.length }).toEqual({ id, routes: 1 });
			const wire: string | undefined = resolveFactoryDroidPolicy({ id })?.wire;
			expect({ id, wire }).toEqual({ id, wire: routed[0].api });
			expect({ id, pools: tiers.filter(tier => tier.models.includes(id)).length }).toEqual({ id, pools: 1 });
			expect({ id, pool: quotaTierFor("factory-droid", id) }).toEqual({
				id,
				pool: expect.stringMatching(/^(core|standard)$/),
			});
			const blocks = registryBlocks.filter(rule => exactIds(rule.models).includes(id));
			expect({ id, blocks: blocks.length }).toEqual({ id, blocks: 1 });
		}
	});

	it("keeps no routing, billing or registry rule for ids outside the roster", () => {
		const routed = routes.flatMap(route => route.match.exact ?? []);
		const pooled = tiers.flatMap(tier => tier.models);
		const registered = registryBlocks.flatMap(rule => exactIds(rule.models));
		expect(routed.filter(id => !seedIds.includes(id))).toEqual([]);
		expect(pooled.filter(id => !seedIds.includes(id))).toEqual([]);
		expect(registered.filter(id => !seedIds.includes(id))).toEqual([]);
		// Only exact ids: a prefix, glob or fallback would claim unknown models.
		expect(routes.every(route => Object.keys(route.match).every(kind => kind === "exact"))).toBe(true);
		expect(rules.behavior.quotaTiers.find(rule => rule.provider === "factory-droid")?.fallbacks).toEqual([]);
		expect(registryBlocks.every(rule => rule.models?.every(selector => selector.kind === "exact"))).toBe(true);
	});
});

describe("Factory Droid discovery gates", () => {
	it.each([
		{
			label: "a live feature gate is required even when the org allowlists the model",
			endpoints: { flags: {}, modelPolicy: { allowAllFactoryModels: false, allowedModelIds: [FLAGGED] } },
			show: [],
			hide: [FLAGGED],
		},
		{
			label: "org-denied models stay hidden when the allowlist is absent",
			endpoints: { modelPolicy: { allowAllFactoryModels: false } },
			show: [],
			hide: [PLAIN, FLAGGED],
		},
		{
			label: "a populated allowlist is restrictive even when allow-all is true",
			endpoints: { modelPolicy: { allowAllFactoryModels: true, allowedModelIds: [FLAGGED] } },
			show: [FLAGGED],
			hide: [PLAIN],
		},
		{
			label: "opt-in models need policy before they appear",
			endpoints: {},
			show: [PLAIN],
			hide: [OPT_IN],
		},
		{
			label: "opt-in models stay hidden while policy still requires consent",
			endpoints: { modelPolicy: { allowAllFactoryModels: true, requireExplicitOptInModelIds: [OPT_IN] } },
			show: [PLAIN],
			hide: [OPT_IN],
		},
		{
			label: "opt-in models appear once policy approves them",
			endpoints: { modelPolicy: { allowAllFactoryModels: true } },
			show: [OPT_IN],
			hide: [],
		},
		{
			label: "a deprecated model stays visible until its deprecation flag turns on",
			endpoints: { modelPolicy: { allowAllFactoryModels: true } },
			show: [DEPRECATED],
			hide: [],
		},
		{
			label: "a hard deprecation flag hides the model",
			endpoints: {
				flags: { ...ALL_FLAGS_ON, [DEPRECATION_FLAG]: true },
				modelPolicy: { allowAllFactoryModels: true },
			},
			show: [PLAIN],
			hide: [DEPRECATED],
		},
	])("$label", async ({ endpoints, show, hide }) => {
		const ids = await discoverIds(endpoints);
		for (const id of show) expect(ids).toContain(id);
		for (const id of hide) expect(ids).not.toContain(id);
	});

	it("withdraws fast tiers only when the org explicitly disallows them", async () => {
		const fastIds = factoryDroidRegistry()
			.filter(({ policy }) => policy.entitlement.baseVariant !== undefined)
			.map(({ spec }) => spec.id);
		expect(fastIds.length).toBeGreaterThan(0);
		// Allow-all is the CLI's default kind, and older servers omit the field entirely.
		const allowed = await discoverIds({ modelPolicy: { allowAllFactoryModels: true, isFastModelsAllowed: true } });
		const silent = await discoverIds({ modelPolicy: { allowAllFactoryModels: true } });
		for (const id of fastIds) {
			expect(allowed).toContain(id);
			expect(silent).toContain(id);
		}
		// Only an explicit false hides them, and it hides nothing else.
		const denied = await discoverIds({ modelPolicy: { allowAllFactoryModels: true, isFastModelsAllowed: false } });
		expect(denied).toEqual(allowed.filter(id => !fastIds.includes(id)));
	});

	it.each([
		{ label: "without a credential", apiKey: undefined },
		{ label: "when the flags fetch fails", apiKey: "token" },
	])("returns null $label so the offline snapshot stays", async ({ apiKey }) => {
		let calls = 0;
		const fetchImpl: FetchImpl = async () => {
			calls++;
			throw new Error("network down");
		};
		expect(await fetchFactoryDroidModels({ apiKey, fetch: fetchImpl })).toBeNull();
		// A missing credential never reaches the network.
		expect(calls > 0).toBe(apiKey !== undefined);
	});

	it("applies the live provider_routing config to the model spec", async () => {
		const models = await discover({
			flags: {},
			routing: { version: 1, models: { "kimi-k3": ["baseten", "fireworks"] } },
		});
		const kimi = models?.find(model => model.id === "kimi-k3");
		expect(kimi?.factoryDroidApiProviders).toEqual(["baseten", "fireworks"]);
		// Native reports live routing as `configured_order`; registry order is the default.
		expect(kimi?.factoryDroidRoutingSource).toBe("configured_order");
		// Explicit global restrictions apply even without a live routing entry.
		const glm = models?.find(model => model.id === "glm-5.2");
		expect(glm?.factoryDroidApiProviders).toEqual(["baseten"]);
		expect(glm?.factoryDroidRoutingSource).toBeUndefined();
	});

	it("keeps live gpt-6.1-sol routing through Bedrock and Databricks", async () => {
		const models = await discover({
			routing: { version: 1, models: { "gpt-6.1-sol": ["bedrock_openai", "databricks", "openai"] } },
		});
		const sol = models?.find(model => model.id === "gpt-6.1-sol");
		expect(sol?.factoryDroidApiProviders).toEqual(["bedrock_openai", "databricks", "openai"]);
	});

	it("lists GPT-6 Luna and DeepSeek V4.1 Flash without their retired flags", async () => {
		const ids = await discoverIds({ flags: { gpt_6_luna: false, deepseek_v4_1_flash: false } });
		expect(ids).toContain("gpt-6-luna");
		expect(ids).toContain("deepseek-v4.1-flash");
	});

	it("keeps global overrides restrictive without removing the EU Mistral route", async () => {
		const endpoints = {
			flags: {},
			routing: { models: { "glm-5.3": ["mistral", "baseten"], "glm-5.2": ["mistral"] } },
			modelPolicy: { allowAllFactoryModels: true },
		};
		const global = await discover(endpoints);
		const eu = await discover(endpoints, { region: "eu" });
		expect(global?.find(model => model.id === "glm-5.3")?.factoryDroidApiProviders).toEqual(["baseten"]);
		expect(global?.find(model => model.id === "glm-5.2")).toBeUndefined();
		expect(eu?.find(model => model.id === "glm-5.3")?.factoryDroidApiProviders).toEqual(["mistral"]);
		expect(eu?.find(model => model.id === "glm-5.2")?.factoryDroidApiProviders).toEqual(["mistral"]);
		expect(
			factoryDroidModelManagerOptions().staticModels?.find(model => model.id === "glm-5.2")
				?.factoryDroidApiProviders,
		).toEqual(["baseten"]);
	});
});

describe("Factory Droid model cache scope", () => {
	it("keeps refreshed WorkOS tokens in one account cache without crossing org, user or residency", () => {
		const original = factoryToken("org-A", "user-A", 1_000, "first");
		const refreshed = factoryToken("org-A", "user-A", 2_000, "second");
		const account = resolveModelCacheProviderId("factory-droid", { apiKey: original, region: "global" });
		expect(account).toBe(resolveModelCacheProviderId("factory-droid", { apiKey: refreshed, region: "global" }));
		expect(account).not.toBe(
			resolveModelCacheProviderId("factory-droid", { apiKey: factoryToken("org-B", "user-A", 1_000, "first") }),
		);
		expect(account).not.toBe(
			resolveModelCacheProviderId("factory-droid", { apiKey: factoryToken("org-A", "user-B", 1_000, "first") }),
		);
		expect(account).not.toBe(resolveModelCacheProviderId("factory-droid", { apiKey: refreshed, region: "eu" }));
		expect(account).not.toBe(
			resolveModelCacheProviderId("factory-droid", { apiKey: refreshed, inferenceRegion: "us" }),
		);
		expect(account).not.toBe(
			resolveModelCacheProviderId("factory-droid", { apiKey: refreshed, orgId: "canonical-other" }),
		);
		expect(account).not.toContain(original);
		expect(account).not.toContain("org-A");
		expect(factoryDroidModelManagerOptions({ apiKey: refreshed }).cacheProviderId).toBe(account);
		const opaque = resolveModelCacheProviderId("factory-droid", { apiKey: "secret-A" });
		expect(opaque).not.toBe(resolveModelCacheProviderId("factory-droid", { apiKey: "secret-B" }));
		expect(opaque).not.toContain("secret-A");
	});

	it("restores the account's authoritative roster after WorkOS refresh", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-account-cache-"));
		const cacheDbPath = path.join(dir, "models.db");
		const original = factoryToken("org-A", "user-A", 1_000, "first");
		const refreshed = factoryToken("org-A", "user-A", 2_000, "second");
		try {
			await resolveProviderModels(
				{
					...factoryDroidModelManagerOptions({ apiKey: original }),
					cacheDbPath,
					fetchDynamicModels: async () => [buildFactoryDroidModel(registryModel("glm-5.3"))],
				},
				"online",
			);
			const restored = await resolveProviderModels(
				{ ...factoryDroidModelManagerOptions({ apiKey: refreshed }), cacheDbPath },
				"offline",
			);
			expect(restored.source).toBe("cache");
			expect(restored.models.map(model => model.id)).toEqual(["glm-5.3"]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("Factory Droid EU region", () => {
	it("queries the EU host and hides models with no EU-serving upstream", async () => {
		const urls: string[] = [];
		const models = await discover({ onRequest: url => urls.push(url) }, { region: "eu" });
		expect(models).not.toBeNull();
		const ids = models!.map(model => model.id);

		// Discovery endpoints follow the region.
		expect(urls[0]).toBe("https://api.eu.factory.ai/api/feature-flags");
		expect(urls[1]).toBe("https://api.eu.factory.ai/api/organization/managed-settings");

		// Hidden for EU: Droid Core (fireworks/baseten-only), Gemini Pro (google
		// outside the EU table, no override) and grok (xai-only).
		expect(ids).not.toContain("kimi-k3");
		expect(ids).not.toContain("gemini-3.1-pro-preview");
		expect(ids).not.toContain("grok-4.5");
		// Available with region-resolved rotations and EU wire URLs; per-model
		// overrides may name upstreams the EU table omits.
		const opus5 = models!.find(model => model.id === "claude-opus-5")!;
		expect(opus5.factoryDroidApiProviders).toEqual(["vertex_anthropic", "bedrock_anthropic"]);
		// Once policy approves the opt-in Fable, the EU serves it on Vertex.
		const approved = await discover({ modelPolicy: { allowAllFactoryModels: true } }, { region: "eu" });
		expect(approved?.find(model => model.id === "claude-fable-5")?.factoryDroidApiProviders).toEqual([
			"vertex_anthropic",
		]);
		const flash = models!.find(model => model.id === "gemini-3.8-flash")!;
		expect(flash.factoryDroidApiProviders).toEqual(["google"]);
		expect(opus5.baseUrl).toBe("https://api.eu.factory.ai/api/llm/a");
		const sonnet = models!.find(model => model.id === "claude-sonnet-4-5-20250929")!;
		expect(sonnet.factoryDroidApiProviders).toEqual(["vertex_anthropic", "bedrock_anthropic"]);
		const gpt54 = models!.find(model => model.id === "gpt-5.4")!;
		expect(gpt54.factoryDroidApiProviders).toEqual(["openai"]);
		expect(gpt54.baseUrl).toBe("https://api.eu.factory.ai/api/llm/o/v1");
		const glmPolicy = registryModel("glm-5.2").policy;
		const glm = models!.find(model => model.id === "glm-5.2")!;
		expect(glm.factoryDroidApiProviders).toEqual(["mistral"]);
		expect(glm.contextWindow).toBe(glmPolicy.euLimits.contextWindow!);
		expect(glm.maxTokens).toBe(glmPolicy.euLimits.maxTokens!);
		expect(glm.contextWindow).toBeLessThan(glmPolicy.limits.contextWindow!);
	});

	it("intersects live provider_routing with the EU rotation instead of resurrecting global upstreams", async () => {
		const models = await discover(
			{
				routing: {
					version: 1,
					models: {
						// No eligible upstream survives: hide rather than widen the live restriction.
						"claude-opus-5": ["anthropic"],
						// Mixed entry narrows to the EU-serving subset.
						"claude-sonnet-4-5-20250929": ["anthropic", "bedrock_anthropic"],
					},
				},
			},
			{ region: "eu" },
		);
		expect(models!.find(model => model.id === "claude-opus-5")).toBeUndefined();
		expect(models!.find(model => model.id === "claude-sonnet-4-5-20250929")?.factoryDroidApiProviders).toEqual([
			"bedrock_anthropic",
		]);
	});

	it("uses global residency with registry-constrained rotations by default", async () => {
		const urls: string[] = [];
		const models = await discover({ onRequest: url => urls.push(url) });
		expect(urls[0]).toBe("https://api.factory.ai/api/feature-flags");
		const opus5 = models!.find(model => model.id === "claude-opus-5")!;
		expect(opus5.factoryDroidApiProviders).toEqual([
			...resolveFactoryDroidRotation(registryModel("claude-opus-5").policy, "global"),
		]);
		expect(opus5.baseUrl).toBe("https://api.factory.ai/api/llm/a");
		expect(models!.find(model => model.id === "kimi-k3")).toBeDefined();
		const glmLimits = registryModel("glm-5.2").policy.limits;
		const glm = models!.find(model => model.id === "glm-5.2")!;
		expect(glm.contextWindow).toBe(glmLimits.contextWindow);
		expect(glm.maxTokens).toBe(glmLimits.maxTokens);
	});
});

describe("Factory Droid organization inference policy", () => {
	const allowAll = { allowAllFactoryModels: true };

	it("keeps global hosts for US inference and does not infer policy from an EU network edge", async () => {
		const endpoints: FactoryEndpoints = {
			modelPolicy: allowAll,
			responseHeaders: { "x-vercel-id": "cdg1::iad1::request" },
			onRequest: (url, init) => {
				expect(new URL(url).host).toBe("api.factory.ai");
				expect(new Headers(init?.headers).get("x-factory-org-id")).toBe("selected-org");
			},
		};
		const models = await discover(endpoints, { region: "global", inferenceRegion: "us", orgId: "selected-org" });
		const sonnet = models?.find(model => model.id === "claude-sonnet-4-5-20250929");
		expect(sonnet?.baseUrl).toBe("https://api.factory.ai/api/llm/a");
		expect(sonnet?.factoryDroidApiProviders).toContain("vertex_anthropic");
		expect(sonnet?.factoryDroidApiProviders).not.toContain("anthropic");
		expect(sonnet?.factoryDroidApiProviders).not.toContain("azure_anthropic");
		const global = await discover(endpoints, { orgId: "selected-org" });
		expect(global?.find(model => model.id === "kimi-k3")).toBeDefined();
	});

	it("normalizes policy aliases for blocks and allowlists without inheriting baseVariant policy", async () => {
		const blocked = await discover({ modelPolicy: { blockedModelIds: ["gpt-5.6-fast"] } });
		expect(blocked?.find(model => model.id === "gpt-5.6-sol-fast")).toBeUndefined();
		const allowed = await discover({ modelPolicy: { allowedModelIds: ["gpt-5.6-fast"] } });
		expect(allowed?.map(model => model.id)).toEqual(["gpt-5.6-sol-fast"]);
		const baseBlocked = await discover({ modelPolicy: { blockedModelIds: ["gpt-5.6-sol"] } });
		expect(baseBlocked?.find(model => model.id === "gpt-5.6-sol-fast")).toBeDefined();
	});

	it("intersects family defaults and model blocks with registry providers, including no-provider results", async () => {
		const models = await discover({
			modelPolicy: allowAll,
			routing: {
				defaults: { anthropic: ["unknown", "bedrock_anthropic", "anthropic"] },
				models: { "gpt-5.4": ["openai"], "kimi-k3": [] },
				blockedProviders: { "gpt-5.4": ["openai"], "claude-sonnet-4-5-20250929": ["anthropic"] },
			},
		});
		expect(models?.find(model => model.id === "gpt-5.4")).toBeUndefined();
		expect(models?.find(model => model.id === "kimi-k3")).toBeUndefined();
		expect(models?.find(model => model.id === "claude-sonnet-4-5-20250929")?.factoryDroidApiProviders).toEqual([
			"bedrock_anthropic",
		]);
	});
});
