import { afterEach, describe, expect, test, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { baiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { BAI_API_BASE_URL, normalizeBaiBaseUrl } from "@oh-my-pi/pi-catalog/wire/bai";

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Fixture mirrors the live `GET /v1/models` shape: rows carry only
 * `supported_endpoint_types`, no limits, tariffs, or reasoning metadata.
 */
function baiModelsFetch(): { calls: string[]; authorizations: (string | null)[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const row = (id: string, types: string[]) => ({
		id,
		object: "model",
		created: 1626777600,
		owned_by: "bai",
		supported_endpoint_types: types,
	});
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(
			JSON.stringify({
				data: [
					row("glm-5.3-flash", ["openai", "anthropic"]),
					row("claude-only", ["anthropic"]),
					row("jev-latest", ["decisions"]),
					row("gpt-image-2", ["image-generation", "openai", "anthropic"]),
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	return { calls, authorizations, fetch };
}

describe("B.AI gateway support", () => {
	test("routes each roster row by its advertised endpoint types", async () => {
		const { calls, authorizations, fetch } = baiModelsFetch();
		const pending = baiModelManagerOptions({ apiKey: "sk-bai-test", fetch }).fetchDynamicModels?.();
		const models = pending ? await pending : pending;

		expect(calls).toEqual(["https://api.b.ai/v1/models"]);
		expect(authorizations).toEqual(["Bearer sk-bai-test"]);
		// Chat wire: served by chat completions.
		expect(models?.find(model => model.id === "glm-5.3-flash")).toMatchObject({
			provider: "bai",
			api: "openai-completions",
			baseUrl: "https://api.b.ai/v1",
		});
		// Decisions-only rows answer System One judgments, never chat.
		expect(models?.find(model => model.id === "jev-latest")).toMatchObject({
			api: "openrouter-decisions",
			kind: "judge",
			baseUrl: "https://api.b.ai/v1",
		});
		// No chat transport exists for these rows, so they must not be offered.
		expect(models?.some(model => model.id === "claude-only")).toBe(false);
		expect(models?.some(model => model.id === "gpt-image-2")).toBe(false);
		// `/v1/models` rejects keyless requests: an unauthenticated manager must not probe.
		expect(baiModelManagerOptions({}).fetchDynamicModels).toBeUndefined();
	});

	test("recovers capabilities from the canonical reference without borrowing prices", async () => {
		const { fetch } = baiModelsFetch();
		const models = await baiModelManagerOptions({ apiKey: "sk-bai-test", fetch }).fetchDynamicModels?.();
		const model = models?.find(item => item.id === "glm-5.3-flash");

		// The gateway publishes none of this; without the reference fill every row
		// would be non-reasoning with unknown limits, so no effort is ever sent.
		expect(model?.reasoning).toBe(true);
		expect(model?.contextWindow).toBeGreaterThan(0);
		expect(buildModel(model!).thinking).toMatchObject({ mode: "effort" });
		// Another provider's tariff does not apply to B.AI billing.
		expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("does not inherit another host's thinking surface from a colliding reference", async () => {
		// Cursor's bundled `claude-4.5-sonnet` reference routes every non-off effort
		// to `claude-4.5-sonnet-thinking`, an id B.AI never advertises; Anthropic
		// hosts publish `budget` mode, which an openai-completions row cannot send.
		const fetch: FetchImpl = async () =>
			Response.json({
				data: ["claude-4.5-sonnet", "claude-haiku-4.5"].map(id => ({ id, supported_endpoint_types: ["openai"] })),
			});
		const rows = await baiModelManagerOptions({ apiKey: "sk-bai-test", fetch }).fetchDynamicModels?.();

		expect(rows?.map(row => row.id)).toEqual(["claude-4.5-sonnet", "claude-haiku-4.5"]);
		for (const row of rows ?? []) {
			const built = buildModel(row);
			expect(built.thinking?.mode, row.id).toBe("effort");
			expect(built.thinking, row.id).not.toHaveProperty("effortRouting");
		}
	});

	test("keeps decision rows out of chat when rebuilt without a discovery kind", () => {
		const spec: ModelSpec<"openrouter-decisions"> = {
			id: "jev-latest",
			name: "jev-latest",
			api: "openrouter-decisions",
			provider: "bai",
			baseUrl: BAI_API_BASE_URL,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		};
		expect(buildModel(spec).kind).toBe("judge");
	});

	test("pastes a key through the login selector after models-endpoint validation", async () => {
		const provider = getOAuthProviders().find(item => item.id === "bai");
		expect(provider?.name).toBe("B.AI");
		const login = getProviderDefinition("bai")?.login;
		expect(login).toBeDefined();

		const { calls, authorizations, fetch } = baiModelsFetch();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign((input: string | URL | Request, init?: RequestInit) => fetch(input, init), {
				preconnect: globalThis.fetch.preconnect,
			}),
		);
		const credential = await login?.({
			onAuth() {},
			onPrompt: async () => "Bearer sk-bai-pasted",
		});
		expect(credential).toBe("sk-bai-pasted");
		expect(calls).toEqual(["https://api.b.ai/v1/models"]);
		expect(authorizations).toEqual(["Bearer sk-bai-pasted"]);
	});

	test("rejects a key the models endpoint refuses", async () => {
		const login = getProviderDefinition("bai")?.login;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async () => Response.json({ error: { message: "Invalid token", type: "api_error" } }, { status: 401 }),
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		await expect(login?.({ onAuth() {}, onPrompt: async () => "sk-bai-bad" })).rejects.toThrow(/401/);
	});

	test("scopes the roster cache to the key and the normalized endpoint", () => {
		const keyed = { apiKey: "sk-bai-a", baseUrl: "https://api.b.ai/v1" };
		expect(baiModelManagerOptions(keyed).cacheProviderId).toBe(resolveModelCacheProviderId("bai", keyed));
		// Switching key re-runs discovery instead of serving the previous roster.
		expect(resolveModelCacheProviderId("bai", keyed)).not.toBe(
			resolveModelCacheProviderId("bai", { apiKey: "sk-bai-b", baseUrl: keyed.baseUrl }),
		);
		// A missing `/v1` and a blank override share the canonical namespace.
		expect(resolveModelCacheProviderId("bai", { apiKey: "sk-bai-a", baseUrl: "https://api.b.ai" })).toBe(
			resolveModelCacheProviderId("bai", keyed),
		);
		expect(resolveModelCacheProviderId("bai", { apiKey: "sk-bai-a", baseUrl: "  " })).toBe(
			resolveModelCacheProviderId("bai", keyed),
		);
		expect(normalizeBaiBaseUrl("https://proxy.example/")).toBe("https://proxy.example/v1");
	});
});
