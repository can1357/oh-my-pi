import { afterEach, describe, expect, test, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { normalizeCharmHyperBaseUrl } from "@oh-my-pi/pi-catalog/wire/charm-hyper";
import { isCatalogDescriptor, resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { charmHyperModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

/**
 * Rows mirror live `https://hyper.charm.land/v1/models` payloads: the display
 * name in `display_name`, limits in `context_window`/`max_output_tokens`,
 * modalities behind `capabilities.vision`, the accepted `reasoning_effort`
 * vocabulary in `reasoning.effort_levels`, and per-million USD in `pricing`.
 */
const HYPER_ROWS: Record<string, unknown>[] = [
	{
		// Advertises the thinking-off tier alongside a full ladder.
		id: "qwen3.8-flash",
		object: "model",
		display_name: "Qwen3.8-Flash",
		context_window: 1_000_000,
		max_output_tokens: 128_000,
		capabilities: { vision: true },
		reasoning: {
			effort_levels: [
				{ value: "none", display: "None" },
				{ value: "minimal", display: "Minimal" },
				{ value: "low", display: "Low" },
				{ value: "medium", display: "Medium" },
				{ value: "high", display: "High" },
			],
			default_effort_level: "medium",
		},
		pricing: { input: 0.15, output: 0.47, cache_create: 0, cache_hit: 0.016 },
	},
	{
		// Reasons, but exposes no off tier — the ladder starts at `high`.
		id: "deepseek-v4-flash",
		object: "model",
		display_name: "DeepSeek V4 Flash",
		context_window: 1_000_000,
		max_output_tokens: 384_000,
		capabilities: { vision: false },
		reasoning: {
			effort_levels: [
				{ value: "high", display: "High" },
				{ value: "xhigh", display: "X-High" },
			],
			default_effort_level: "high",
		},
		pricing: { input: 0.2, output: 0.4, cache_create: 0, cache_hit: 0.04 },
	},
	{
		// No `reasoning` block at all, and the gateway serves it non-thinking.
		id: "kimi-k2.5",
		object: "model",
		display_name: "Kimi K2.5",
		context_window: 262_144,
		max_output_tokens: 26_214,
		capabilities: { vision: false },
		pricing: { input: 0.5584, output: 2.935, cache_create: 0, cache_hit: 0.2792 },
	},
	{
		// Blockless like Kimi K2.5, but verified to reason; KDL restores it.
		id: "glm-5.1",
		object: "model",
		display_name: "GLM-5.1",
		context_window: 202_750,
		max_output_tokens: 3276,
		capabilities: { vision: false },
		pricing: { input: 1.326, output: 4.22, cache_create: 0, cache_hit: 0.663 },
	},
	{
		// Family `m2` carries a class-wide ladder; a family selector must not
		// upgrade this blockless row into a reasoning model.
		id: "minimax-m2.7",
		object: "model",
		display_name: "MiniMax M2.7",
		context_window: 262_100,
		max_output_tokens: 6553,
		capabilities: { vision: false },
		pricing: { input: 0.404, output: 1.496, cache_create: 0, cache_hit: 0.202 },
	},
	{
		// Arrives with the leaked 512K/512K pricing-tier boundary.
		id: "minimax-m3",
		object: "model",
		display_name: "MiniMax M3",
		context_window: 512_000,
		max_output_tokens: 512_000,
		capabilities: { vision: true },
		pricing: { input: 0.32664, output: 1.30656, cache_create: 0, cache_hit: 0.0642392 },
	},
];

function hyperModelsFetch(): { calls: string[]; authorizations: (string | null)[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(JSON.stringify({ object: "list", data: HYPER_ROWS }), {
			headers: { "content-type": "application/json" },
		});
	};
	return { calls, authorizations, fetch };
}

async function discover(fetch: FetchImpl, baseUrl?: string) {
	const options = charmHyperModelManagerOptions({ apiKey: "sk-hyper-test", fetch, baseUrl });
	const specs = (await options.fetchDynamicModels?.()) ?? [];
	return specs.map(spec => buildModel(spec as ModelSpec<"openai-completions">));
}

const originalPrimaryKey = Bun.env.CHARM_HYPER_API_KEY;
const originalFallbackKey = Bun.env.HYPER_API_KEY;

afterEach(() => {
	if (originalPrimaryKey === undefined) delete Bun.env.CHARM_HYPER_API_KEY;
	else Bun.env.CHARM_HYPER_API_KEY = originalPrimaryKey;
	if (originalFallbackKey === undefined) delete Bun.env.HYPER_API_KEY;
	else Bun.env.HYPER_API_KEY = originalFallbackKey;
	vi.restoreAllMocks();
});

describe("Charm Hyper provider support", () => {
	test("maps the gateway row's limits, modalities and per-million tariff", async () => {
		const { calls, fetch } = hyperModelsFetch();
		const models = await discover(fetch);

		expect(calls).toEqual(["https://hyper.charm.land/v1/models"]);
		expect(models.find(model => model.id === "qwen3.8-flash")).toMatchObject({
			name: "Qwen3.8-Flash",
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			input: ["text", "image"],
			// Per-million USD passes through unscaled, and a zero cache-write
			// rate survives: it is a real price, not a missing field.
			cost: { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0 },
		});
		expect(models.find(model => model.id === "deepseek-v4-flash")?.input).toEqual(["text"]);
	});

	test("keeps `none` as the off switch instead of collapsing it into the lowest rung", async () => {
		const { fetch } = hyperModelsFetch();
		const models = await discover(fetch);

		// The crux: `reasoning_effort: "none"` suppresses reasoning outright
		// while `minimal` still thinks, so `none` must drive the disable mode
		// and leave every advertised rung — `minimal` included — selectable.
		const withOff = models.find(model => model.id === "qwen3.8-flash");
		expect(withOff?.thinking).toMatchObject({
			mode: "effort",
			efforts: ["minimal", "low", "medium", "high"],
			defaultLevel: "medium",
		});
		expect(withOff?.compat.reasoningDisableMode).toBe("none-effort");

		// A model that never advertises `none` must not inherit that wire
		// value, or disabling thinking would send an effort it does not accept.
		const withoutOff = models.find(model => model.id === "deepseek-v4-flash");
		expect(withoutOff?.thinking).toMatchObject({ efforts: ["high", "xhigh"], defaultLevel: "high" });
		expect(withoutOff?.compat.reasoningDisableMode).not.toBe("none-effort");
	});

	test("never fabricates an effort ladder for a row the gateway leaves blockless", async () => {
		const { fetch } = hyperModelsFetch();
		const models = await discover(fetch);

		// Kimi K2.5 is served non-thinking here even though its upstream home
		// lists it as a reasoning model. GLM-5.1 is the opposite: blockless but
		// verified to emit reasoning tokens. Neither may grow a ladder — the
		// gateway answers 200 to efforts it never advertised and ignores them,
		// so any synthesized rung is a silent no-op, and `ThinkingConfig`
		// forbids the empty-list shape that would otherwise express "reasons,
		// no dial".
		// minimax-m2.7 is family `m2`, which carries a class-wide
		// `thinking-efforts` ladder — asserting only the boolean would miss a
		// ladder arriving through that family selector.
		for (const id of ["kimi-k2.5", "glm-5.1", "minimax-m2.7"]) {
			const model = models.find(item => item.id === id);
			expect(model?.thinking, id).toBeUndefined();
			expect(model?.reasoning, id).toBe(false);
		}
	});

	test("corrects an output cap the gateway misreports", async () => {
		const { fetch } = hyperModelsFetch();
		const models = await discover(fetch);

		// Both rows publish a fraction of their window rather than a real
		// ceiling, and both were measured producing more than they advertise.
		// Each correction adopts a same-window peer's published value.
		// GLM-5.1 publishes 3276 (1.6%) but produced 14066; sibling glm-5
		// publishes 20275.
		expect(models.find(model => model.id === "glm-5.1")?.maxTokens).toBe(20_275);
		// MiniMax M2.7 publishes 6553 (2.5%) but produced 8418; the three
		// other ~262K rows all publish 26214.
		expect(models.find(model => model.id === "minimax-m2.7")?.maxTokens).toBe(26_214);

		// MiniMax-M3 arrives with the 512K/512K pricing-tier boundary that
		// `classes/minimax.kdl` already documents; charm-hyper joins that
		// rule's host list. Exact selectors are case-sensitive and Hyper
		// publishes the id lowercase, so this pins the spelling too — the
		// correction spans a shared class file and fails silently otherwise.
		expect(models.find(model => model.id === "minimax-m3")).toMatchObject({
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		});
	});

	test("normalizes a host-only base URL onto the /v1 surface", async () => {
		const { calls, authorizations, fetch } = hyperModelsFetch();
		await discover(fetch, "https://gateway.example.com/");

		expect(calls).toEqual(["https://gateway.example.com/v1/models"]);
		expect(authorizations).toEqual(["Bearer sk-hyper-test"]);
	});

	test("treats a blank configured base URL as absent across every consumer", async () => {
		// A whitespace-only override used to diverge: the model manager read it as
		// absent and used the canonical host, while the usage probe and the cache
		// resolver each produced a bare `/v1`. Inference, balance checks and the
		// cache namespace then pointed at three different endpoints.
		const { calls, fetch } = hyperModelsFetch();
		await discover(fetch, "   ");

		expect(calls).toEqual(["https://hyper.charm.land/v1/models"]);
		expect(normalizeCharmHyperBaseUrl("   ")).toBe("https://hyper.charm.land/v1");
		expect(resolveModelCacheProviderId("charm-hyper", { baseUrl: "   " })).toBe(
			resolveModelCacheProviderId("charm-hyper", {}),
		);
	});

	test("registers discovery and defaults without enrolling in catalog generation", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "charm-hyper");
		expect(descriptor).toMatchObject({
			defaultModel: "glm-5.3",
			allowUnauthenticated: true,
			dynamicModelsAuthoritative: true,
			skipCrossProviderReferenceFills: true,
		});
		// The absence of `catalogDiscovery` is the contract, not an oversight: that
		// field is what enrolls a provider in generate-models.ts. This gateway's
		// catalog is live deployment truth, and discovery here needs no
		// credentials, so enrolling it would freeze one hyper.charm.land snapshot
		// into models.json on every regen — contradicting the runtime-only set
		// that compat-conformance.test.ts pins for this provider.
		expect(isCatalogDescriptor(descriptor!)).toBe(false);
		expect(DEFAULT_MODEL_PER_PROVIDER["charm-hyper"]).toBe("glm-5.3");

		delete Bun.env.CHARM_HYPER_API_KEY;
		Bun.env.HYPER_API_KEY = "fallback-key";
		expect(getEnvApiKey("charm-hyper")).toBe("fallback-key");
		Bun.env.CHARM_HYPER_API_KEY = "primary-key";
		expect(getEnvApiKey("charm-hyper")).toBe("primary-key");
	});

	test("validates a pasted key against the credits endpoint and strips a Bearer prefix", async () => {
		expect(getOAuthProviders().find(item => item.id === "charm-hyper")?.name).toBe("Charm Hyper");
		const login = getProviderDefinition("charm-hyper")?.login;
		expect(login).toBeDefined();

		const probed: string[] = [];
		const probeFetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			probed.push(`${new Headers(init?.headers).get("authorization")} ${String(input)}`);
			return Response.json({ balance: 100 });
		};
		const onAuth = vi.fn();
		await expect(
			login?.({ onAuth, onPrompt: async () => "  Bearer sk-hyper-test  ", fetch: probeFetch }),
		).resolves.toBe("sk-hyper-test");
		expect(onAuth).toHaveBeenCalledWith({
			url: "https://hyper.charm.land/",
			instructions: "Create or copy an API key from the Charm Hyper dashboard",
		});
		// The probe must hit `/v1/credits`, not `/v1/models`: the models
		// endpoint is public, so probing it would accept any string as a key.
		expect(probed).toEqual(["Bearer sk-hyper-test https://hyper.charm.land/v1/credits"]);
	});

	test("rejects a key the credits endpoint refuses", async () => {
		const login = getProviderDefinition("charm-hyper")?.login;
		const unauthorizedFetch: FetchImpl = async () =>
			Response.json({ error: "authentication failed" }, { status: 401 });

		await expect(
			login?.({ onAuth: vi.fn(), onPrompt: async () => "sk-hyper-bogus", fetch: unauthorizedFetch }),
		).rejects.toThrow();
	});

	test("scopes the model cache to the configured endpoint across both call paths", () => {
		// `ModelRegistry` resolves this namespace from the raw configured value
		// while `charmHyperModelManagerOptions` resolves it from a `/v1`-suffixed
		// one. They must agree, or the authoritative cache discovery writes is
		// never read back.
		const canonical = resolveModelCacheProviderId("charm-hyper", {});
		// Keyed on the discovery side, keyless on the registry side: that asymmetry
		// is the real production shape, so this goes red if a credential ever
		// re-enters the namespace on one path only.
		const viaManager = charmHyperModelManagerOptions({
			baseUrl: "https://proxy.example",
			apiKey: "sk-hyper-test",
		}).cacheProviderId;

		expect(viaManager).toBe(resolveModelCacheProviderId("charm-hyper", { baseUrl: "https://proxy.example" }));
		expect(viaManager).toBe(resolveModelCacheProviderId("charm-hyper", { baseUrl: "https://proxy.example/v1/" }));
		// A self-hosted proxy publishes its own roster, capabilities and tariffs,
		// so it must not read the canonical host's cache.
		expect(viaManager).not.toBe(canonical);
		// An unconfigured manager still shares the default endpoint's namespace.
		expect(charmHyperModelManagerOptions().cacheProviderId).toBe(canonical);
	});

	test("keeps the cache namespace independent of the credential", () => {
		// charm-hyper is absent from CREDENTIAL_SCOPED_MODEL_CACHE_PROVIDERS, so
		// `ModelRegistry` resolves this namespace with no credential while a
		// configured manager may hold one. Folding a key into the scope would split
		// the two apart and permanently miss the cache discovery writes. Asserted
		// on the resolver itself: the manager forwards no key, so routing through
		// it could not observe a regression here.
		const base = { baseUrl: "https://hyper.charm.land/v1" } as const;
		const withKey = resolveModelCacheProviderId("charm-hyper", { ...base, apiKey: "sk-hyper-a" });

		expect(withKey).toBe(resolveModelCacheProviderId("charm-hyper", { ...base, apiKey: "sk-hyper-b" }));
		expect(withKey).toBe(resolveModelCacheProviderId("charm-hyper", base));
	});
});
