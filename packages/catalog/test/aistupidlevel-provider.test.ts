import { describe, expect, test } from "bun:test";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import { aistupidlevelModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";
import { TempDir } from "@oh-my-pi/pi-utils";

const ROUTER_EFFORTS = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];

/** `GET /v1/models` as the router serves it (2026-10-23): ids and owners only, no capability data. */
function rosterFetch(rows: Record<string, string>, requests: Array<{ url: string; auth: string | null }>): FetchImpl {
	return async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
		return Response.json({
			object: "list",
			data: Object.entries(rows).map(([id, owner]) => ({ id, object: "model", created: 0, owned_by: owner })),
		});
	};
}

async function resolveRoster(rows: Record<string, string>): Promise<{
	byId: Map<string, Model>;
	requests: Array<{ url: string; auth: string | null }>;
}> {
	await using temp = await TempDir.create("@aistupidlevel-roster-");
	const requests: Array<{ url: string; auth: string | null }> = [];
	const result = await resolveProviderModels(
		{
			...aistupidlevelModelManagerOptions({ apiKey: "aism_test", fetch: rosterFetch(rows, requests) }),
			staticModels: seedModels("aistupidlevel"),
			cacheDbPath: temp.join("models.db"),
		},
		"online",
	);
	return { byId: new Map(result.models.map(model => [model.id, model as Model])), requests };
}

describe("AI Stupid Level provider", () => {
	test("lists the live roster with the router key and drops a routing mode the router stopped listing", async () => {
		// `auto-split` is seeded but absent here, so the authoritative roster prunes it.
		const { byId, requests } = await resolveRoster({
			auto: "aistupidlevel",
			"auto-coding": "aistupidlevel",
			"claude-opus-5-5": "anthropic",
		});

		expect(requests).toEqual([{ url: "https://aistupidlevel.info/v1/models", auth: "Bearer aism_test" }]);
		expect([...byId.keys()].sort()).toEqual(["auto", "auto-coding", "claude-opus-5-5"]);
		// The router publishes no names, so routing modes keep their seeded ones.
		expect(byId.get("auto-coding")?.name).toBe("Auto Coding");
	});

	test("keeps routing modes named after reasoning separate from their base mode", async () => {
		const { byId } = await resolveRoster({
			auto: "aistupidlevel",
			"auto-reasoning": "aistupidlevel",
			"auto-value": "aistupidlevel",
			"auto-value-reasoning": "aistupidlevel",
		});

		// Without the pair-token exemption, `auto-reasoning` folds into `auto` and
		// every thinking level of `auto` is sent as `model: "auto-reasoning"`.
		expect([...byId.keys()].sort()).toEqual(["auto", "auto-reasoning", "auto-value", "auto-value-reasoning"]);
		for (const model of byId.values()) {
			expect(model.thinking?.effortRouting).toBeUndefined();
			expect(model.thinking?.requiresEffort).toBeUndefined();
		}
	});

	test("gives pinned model ids the router's text-only contract instead of their vendor's", async () => {
		const { byId } = await resolveRoster({
			"auto-coding": "aistupidlevel",
			"claude-opus-5-5": "anthropic",
			"gemini-3.8-flash": "google",
		});

		for (const id of ["auto-coding", "claude-opus-5-5", "gemini-3.8-flash"]) {
			expect(byId.get(id)).toMatchObject({
				api: "openai-completions",
				baseUrl: "https://aistupidlevel.info/v1",
				// Both vendors take images on their own APIs; the router answers them with a 400.
				input: ["text"],
				contextWindow: 262144,
				maxTokens: 64000,
				thinking: { mode: "effort", efforts: ROUTER_EFFORTS },
				compat: {
					reasoningDisableMode: "none-effort",
					maxTokensField: "max_completion_tokens",
					supportsStore: false,
				},
			});
		}
		// A routing mode's price follows the model it picks; a pinned id is billed by its vendor.
		expect(getModelPricingStatus(byId.get("auto-coding")!)).toBe("variable");
		expect(getModelPricingStatus(byId.get("claude-opus-5-5")!)).toBe("unknown");
	});
});
